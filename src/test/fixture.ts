import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A fake `~/.claude` plus the git repos its sessions ran in, built in a temp dir:
// alpha (main checkout on main + worktree on feature, one live session), beta (three past sessions), notes (not git).
export type Fixture = ReturnType<typeof createFixture>;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });

const repo = (path: string) => {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-q", "-b", "main");
  git(path, "commit", "-q", "--allow-empty", "-m", "init");
};

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

type Line = Record<string, unknown>;
const meta = (cwd: string, minutesAgo: number, extra: Line = {}) => ({
  cwd,
  gitBranch: "main",
  timestamp: at(minutesAgo),
  entrypoint: "cli",
  ...extra,
});
const user = (text: string, cwd: string, minutesAgo: number, extra?: Line) => ({
  parentUuid: null,
  type: "user",
  message: { role: "user", content: text },
  ...meta(cwd, minutesAgo, extra),
});
let msg = 0;
const assistant = (content: unknown[], cwd: string, minutesAgo: number, extra?: Line) => ({
  parentUuid: "p",
  type: "assistant",
  message: { id: `msg_${++msg}`, role: "assistant", content },
  ...meta(cwd, minutesAgo, extra),
});
const reply = (text: string, cwd: string, minutesAgo: number, extra?: Line) =>
  assistant([{ type: "text", text }], cwd, minutesAgo, extra);

// `base` defaults to the OS temp dir; integration tests pass a short one since it also becomes VS Code's TMPDIR.
export const createFixture = (livePid: number, base = tmpdir()) => {
  const root = realpathSync(mkdtempSync(join(base, "cms-")));
  const claudeDir = join(root, "claude");
  const alpha = join(root, "alpha");
  const worktree = join(alpha, ".claude", "worktrees", "feature");
  const beta = join(root, "beta");
  const notes = join(root, "notes");
  repo(alpha);
  repo(beta);
  writeFileSync(join(alpha, "tsconfig.json"), "{}");
  git(alpha, "worktree", "add", "-q", "-b", "feature", worktree);
  mkdirSync(notes);

  const transcript = (cwd: string, id: string, lines: Line[]) => {
    const dir = join(claudeDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.jsonl`), lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
    return dir;
  };

  const big = "pasted ".repeat(4_000);
  const tools = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      i % 2
        ? user("", beta, 300, {
            message: {
              role: "user",
              content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "x".repeat(200) }],
            },
          })
        : assistant([{ type: "tool_use", id: `t${i}`, name: "Bash", input: {} }], beta, 300),
    );
  transcript(worktree, "alpha-live", [
    user("work on the feature", worktree, 5, { gitBranch: "feature" }),
    reply("On it", worktree, 4, { gitBranch: "feature" }),
  ]);
  transcript(alpha, "alpha-past", [
    user("first prompt", alpha, 60),
    { type: "ai-title", aiTitle: "AI title" },
    { type: "custom-title", customTitle: "Renamed alpha session" },
    reply("Done with alpha", alpha, 59),
  ]);
  const betaDir = transcript(beta, "beta-new", [
    user("add tests", beta, 120),
    { type: "ai-title", aiTitle: "Beta AI title" },
    reply("Added", beta, 119),
  ]);
  transcript(beta, "beta-old", [
    user("<command-name>/review</command-name><command-args>fix the beta bug</command-args>", beta, 200),
    reply("Fixed", beta, 199),
  ]);
  // Head grows past 16 KB to reach the end of the prompt; tail grows past 64 KB of tool calls to find the last reply.
  transcript(beta, "beta-big", [
    user(big, beta, 302),
    ...tools(500),
    reply("Summary after the tools", beta, 301),
    ...tools(250),
  ]);
  transcript(notes, "notes-1", [user("jot down notes", notes, 400), reply("Noted", notes, 399)]);
  transcript(beta, "sdk-run", [user("from the SDK", beta, 10, { entrypoint: "sdk-ts" })]);
  transcript(beta, "no-prompt", [user("<local-command-stdout>ok</local-command-stdout>", beta, 10)]);
  mkdirSync(join(betaDir, "beta-new", "subagents"), { recursive: true });
  writeFileSync(
    join(betaDir, "beta-new", "subagents", "agent-1.jsonl"),
    `${JSON.stringify(user("subagent prompt", beta, 1))}\n`,
  );

  mkdirSync(join(claudeDir, "sessions"));
  writeFileSync(
    join(claudeDir, "sessions", `${livePid}.json`),
    JSON.stringify({
      pid: livePid,
      sessionId: "alpha-live",
      cwd: worktree,
      name: "Live in worktree",
      status: "idle",
      entrypoint: "cli",
      updatedAt: Date.now(),
    }),
  );
  // Ended: its pid is not running.
  writeFileSync(
    join(claudeDir, "sessions", "999999.json"),
    JSON.stringify({ pid: 999_999, sessionId: "beta-new", cwd: beta, name: "Stale", status: "busy" }),
  );

  // Stand-ins for `gh` and `claude` on PATH: `gh` prints `prs.json` from the repo it runs in, `claude` records its args.
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), '#!/bin/sh\ncat "$PWD/prs.json"\n');
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "$@" > "${join(root, "claude-args")}"\n`);
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "claude"), 0o755);

  return { root, claudeDir, alpha, worktree, notes, bin };
};
