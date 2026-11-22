import { watch } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ClaudeSession, Entrypoint } from "./model";

// Formats verified against Claude Code 2.1.3xx, see AGENTS.md "Claude Code data".

// Claude Code moves `~/.claude` to `CLAUDE_CONFIG_DIR` when set; tests point it at a fixture.
const defaultDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const headSize = 16 << 10;
const tailSize = 64 << 10;
const maxRead = 8 << 20;

type Live = {
  pid: number;
  sessionId: string;
  cwd: string;
  name?: string;
  nameSource?: string;
  status?: string;
  entrypoint?: string;
  updatedAt?: number;
};

type Transcript = {
  id: string;
  path: string;
  cwd?: string;
  startCwd?: string;
  branch?: string;
  updatedAt?: number;
  customTitle?: string;
  aiTitle?: string;
  agentName?: string;
  prompt?: string;
  entrypoint?: string;
  // Has a prompt typed by a person (not an SDK run, not only local commands).
  interactive: boolean;
  // Messages seen in the part that was read; only used to tell whether a tail had any.
  userCount: number;
  assistantCount: number;
  lastAssistantId?: string;
  lastMessage?: string;
};

type Cached = { mtimeMs: number; size: number; head: Transcript; t: Transcript };

const cache = new Map<string, Cached>();
const paths = new Map<string, string>();

const entrypoints: Record<string, Entrypoint> = { cli: "cli", "claude-vscode": "vscode", "claude-desktop": "desktop" };
const toEntrypoint = (e?: string): Entrypoint => entrypoints[e ?? ""] ?? "cli";

const oneLine = (s: string, max: number) => {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

// Typed prompt text, or undefined for tool results, command output, notifications, interruptions.
const promptText = (content: unknown) => {
  const raw =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((c) => c?.type === "text")
            .map((c) => c.text)
            .join(" ")
        : "";
  const s = raw.trim();
  if (!s || /^(<(local-command|task-notification|system-reminder|bash-)|\[Request interrupted)/.test(s)) return;
  const command = s.match(/<command-name>(.*?)<\/command-name>/s)?.[1];
  if (command) {
    const args = s.match(/<command-args>(.*?)<\/command-args>/s)?.[1].trim();
    return args ? oneLine(`${command} ${args}`, 120) : undefined;
  }
  return oneLine(s.replace(/<[^>]*>/g, " "), 120) || undefined;
};

const lastText = (content: unknown) =>
  Array.isArray(content)
    ? content
        .filter((c) => c?.type === "text" && c.text?.trim())
        .map((c) => c.text)
        .join(" ")
    : "";

const bytes = (s: string) => Buffer.from(s);
const typeFirst = bytes('{"type":"');
const toolResult = bytes('"tool_use_id"');
const textBlock = bytes('"type":"text"');

const parse = (line: Buffer) => {
  try {
    return JSON.parse(line.toString("utf8"));
  } catch {
    return undefined;
  }
};

// Message lines start with `{"parentUuid":…` and carry `"role"` within their first few hundred bytes.
const messageRole = (line: Buffer) => line.toString("latin1", 0, 600).match(/"role":"(user|assistant)"/)?.[1];

// Parses complete lines into `t` and returns the number of bytes consumed.
const parseLines = (buf: Buffer, t: Transcript) => {
  let last: Buffer | undefined;
  // cwd/branch/time/entrypoint come from the latest message line, parsed once.
  const flush = () => {
    const o = last && parse(last);
    last = undefined;
    if (!o) return;
    t.cwd = o.cwd ?? t.cwd;
    t.branch = o.gitBranch && o.gitBranch !== "HEAD" ? o.gitBranch : undefined;
    t.updatedAt = Date.parse(o.timestamp) || t.updatedAt;
    t.entrypoint = o.entrypoint ?? t.entrypoint;
  };
  let start = 0;
  for (let end = buf.indexOf(10); end !== -1; start = end + 1, end = buf.indexOf(10, start)) {
    const line = buf.subarray(start, end);
    if (line.subarray(0, typeFirst.length).equals(typeFirst)) {
      const type = line.toString("latin1", typeFirst.length, line.indexOf(34, typeFirst.length));
      if (!["custom-title", "ai-title", "agent-name", "relocated"].includes(type)) continue;
      const o = parse(line);
      if (type === "relocated") {
        flush();
        t.cwd = o?.relocatedCwd ?? t.cwd;
      }
      t.customTitle = o?.customTitle ?? t.customTitle;
      t.aiTitle = o?.aiTitle ?? t.aiTitle;
      t.agentName = o?.agentName ?? t.agentName;
      continue;
    }
    const role = messageRole(line);
    if (!role) continue;
    last = line;
    if (!t.startCwd) t.startCwd = parse(line)?.cwd;
    if (role === "assistant") {
      const id = line.toString("latin1", 0, 600).match(/"id":"(msg_[^"]+)"/)?.[1];
      if (!id || id !== t.lastAssistantId) t.assistantCount++;
      t.lastAssistantId = id;
      if (line.includes(textBlock)) {
        const text = lastText(parse(line)?.message?.content);
        if (text) t.lastMessage = oneLine(text, 200);
      }
    } else if (!line.includes(toolResult)) {
      const o = parse(line);
      const text = !o || o.isMeta || o.isCompactSummary || o.isSidechain ? undefined : promptText(o.message?.content);
      if (!text) continue;
      t.userCount++;
      t.prompt ??= text;
      if (!o.entrypoint?.startsWith("sdk")) t.interactive = true;
    }
  }
  flush();
  return start;
};

const readAt = async (path: string, from: number, to: number) => {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.allocUnsafe(to - from);
    const { bytesRead } = await fh.read(buf, 0, buf.length, from);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
};

// Never reads whole transcripts (some are ~100 MB). The head has the first prompt and start cwd; the tail has the latest
// cwd, branch, time, title and reply. Each grows only while it has nothing useful (a huge pasted prompt, a tail of tool calls).
const readTranscript = async (path: string, id: string) => {
  const { mtimeMs, size } = await stat(path);
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.t;
  // Transcripts are append-only: when a file only grew, its head is unchanged.
  let head = hit && size >= hit.size ? hit.head : undefined;
  let headEnd = Math.min(headSize, size);
  for (let len = headSize; !head; len *= 8) {
    headEnd = Math.min(len, size);
    const next: Transcript = { id, path, interactive: false, userCount: 0, assistantCount: 0 };
    parseLines(await readAt(path, 0, headEnd), next);
    if (next.userCount || headEnd === size || len >= maxRead) head = next;
  }
  let t = { ...head };
  for (let len = tailSize; size > headEnd; len *= 8) {
    const from = Math.max(headEnd, size - len);
    const buf = await readAt(path, from, size);
    t = { ...head, userCount: 0, assistantCount: 0 };
    parseLines(from === headEnd ? buf : buf.subarray(buf.indexOf(10) + 1), t);
    if ((t.lastMessage && t.lastMessage !== head.lastMessage) || from === headEnd || len >= maxRead) break;
  }
  t.updatedAt ??= mtimeMs;
  cache.set(path, { mtimeMs, size, head, t });
  return t;
};

const mapLimit = async <T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) => {
  const out: R[] = [];
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const j = i++;
      out[j] = await fn(items[j]);
    }
  };
  await Promise.all(Array.from({ length: limit }, worker));
  return out;
};

// Top-level `<encoded-cwd>/<sessionId>.jsonl` only; subagent transcripts live deeper (`<sessionId>/subagents/`).
const readTranscripts = async (claudeDir: string) => {
  const root = join(claudeDir, "projects");
  const dirs = await readdir(root, { withFileTypes: true }).catch(() => []);
  const files = (
    await Promise.all(
      dirs
        .filter((d) => d.isDirectory())
        .map(async (d) =>
          (await readdir(join(root, d.name)).catch(() => []))
            .filter((f) => f.endsWith(".jsonl"))
            .map((f) => ({ path: join(root, d.name, f), id: f.slice(0, -".jsonl".length) })),
        ),
    )
  ).flat();
  const present = new Set(files.map((f) => f.path));
  for (const path of cache.keys()) if (!present.has(path)) cache.delete(path);
  const all = await mapLimit(files, 8, ({ path, id }) => readTranscript(path, id).catch(() => undefined));
  // The same session can appear under two project dirs (e.g. after a cwd change); keep the latest.
  const byId = new Map<string, Transcript>();
  for (const t of all) if (t && (byId.get(t.id)?.updatedAt ?? -1) < (t.updatedAt ?? 0)) byId.set(t.id, t);
  return byId;
};

export const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

const readLive = async (claudeDir: string) => {
  const dir = join(claudeDir, "sessions");
  const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".json"));
  const live = await Promise.all(
    files.map(async (f): Promise<Live | undefined> => {
      try {
        const s: Live = JSON.parse(await readFile(join(dir, f), "utf8"));
        return s.sessionId && typeof s.pid === "number" && isRunning(s.pid) ? s : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  return live.filter((s): s is Live => !!s);
};

const toSession = (t: Transcript | undefined, live: Live | undefined): ClaudeSession | undefined => {
  if (!live && !t?.interactive) return;
  // Live names with nameSource "derived" are `<folder>-<n>` placeholders.
  const liveName = live?.nameSource === "derived" ? undefined : live?.name;
  return {
    id: (live?.sessionId ?? t?.id)!,
    name: oneLine(
      liveName || t?.customTitle || t?.aiTitle || t?.agentName || t?.prompt || live?.name || "Untitled",
      120,
    ),
    cwd: (live?.cwd ?? t?.cwd)!,
    startCwd: (t?.startCwd ?? live?.cwd ?? t?.cwd)!,
    branch: t?.branch,
    status: live ? (live.status === "busy" ? "busy" : "idle") : "ended",
    pid: live?.pid,
    entrypoint: toEntrypoint(live?.entrypoint ?? t?.entrypoint),
    updatedAt: new Date(live?.updatedAt ?? t?.updatedAt ?? 0),
    lastMessage: t?.lastMessage ?? "",
  };
};

export const readClaudeSessions = async (claudeDir = defaultDir): Promise<ClaudeSession[]> => {
  const [live, transcripts] = await Promise.all([readLive(claudeDir), readTranscripts(claudeDir)]);
  const liveById = new Map(live.map((l) => [l.sessionId, l]));
  paths.clear();
  for (const t of transcripts.values()) paths.set(t.id, t.path);
  return [...new Set([...transcripts.keys(), ...liveById.keys()])]
    .map((id) => toSession(transcripts.get(id), liveById.get(id)))
    .filter((s): s is ClaudeSession => !!s && !!s.cwd);
};

export const transcriptPath = (s: Pick<ClaudeSession, "id" | "cwd">, claudeDir = defaultDir) =>
  paths.get(s.id) ?? join(claudeDir, "projects", s.cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${s.id}.jsonl`);

// Coalesces bursts: fires at most once per `delay`, also while a busy session keeps writing.
export const watchClaudeSessions = (onChange: () => void, claudeDir = defaultDir, delay = 300) => {
  let timer: NodeJS.Timeout | undefined;
  const changed = () => {
    timer ??= setTimeout(() => {
      timer = undefined;
      onChange();
    }, delay);
  };
  const targets = [
    { dir: "sessions", recursive: false, relevant: (f: string) => f.endsWith(".json") },
    { dir: "projects", recursive: true, relevant: (f: string) => /^[^/\\]+[/\\][^/\\]+\.jsonl$/.test(f) },
  ];
  const watchers = targets.flatMap(({ dir, recursive, relevant }) => {
    try {
      const w = watch(
        join(claudeDir, dir),
        { recursive, persistent: false },
        (_, f) => (!f || relevant(f)) && changed(),
      );
      w.on("error", () => w.close());
      return [w];
    } catch {
      return [];
    }
  });
  return () => {
    clearTimeout(timer);
    watchers.forEach((w) => w.close());
  };
};
