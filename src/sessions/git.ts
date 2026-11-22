import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { ClaudeSession, Pr, PrState, Repo, Session } from "./model";

type RepoInfo = { repo?: Repo; worktree: boolean };

type Identity = { path?: string; worktree: boolean };

const branchTtl = 10_000;
// Folders that aren't (or no longer resolve to) a repo are retried after this, e.g. after a git timeout.
const retryTtl = 60_000;

const run = (cmd: string, args: string[], cwd?: string, timeout = 5_000) =>
  new Promise<string | undefined>((resolve) =>
    execFile(cmd, args, { cwd, timeout, windowsHide: true }, (error, stdout) =>
      resolve(error ? undefined : stdout.trim()),
    ),
  );

const markers: [string | RegExp, string][] = [
  ["tsconfig.json", "ts"],
  ["package.json", "js"],
  ["pyproject.toml", "py"],
  ["requirements.txt", "py"],
  ["go.mod", "go"],
  ["Cargo.toml", "rs"],
  [/^build\.gradle/, "java"],
  ["pom.xml", "java"],
];

const detectLanguage = async (path: string) => {
  const files = await readdir(path).catch(() => [] as string[]);
  return markers.find(([marker]) =>
    files.some((f) => (typeof marker === "string" ? f === marker : marker.test(f))),
  )?.[1];
};

const gitIdentity = async (dir: string): Promise<Identity | undefined> => {
  const out = await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"], dir);
  const [commonDir, toplevel] = out?.split("\n") ?? [];
  if (!commonDir || !toplevel) return undefined;
  // Submodules and bare repos keep their git dir elsewhere: fall back to the toplevel.
  const path = basename(commonDir) === ".git" ? dirname(commonDir) : toplevel;
  return { path, worktree: toplevel !== path };
};

const looksLikeWorktree = (path: string) => /\/worktrees?\//.test(path);

// Deleted worktree: resolve the nearest existing ancestor. Outside the repo (`~/.superset/worktrees/<repo>/<slug>`
// or `<repo>-<slug>`), borrow the repo from a sibling worktree of the same repo that still exists.
const missingIdentity = async (cwd: string): Promise<Identity> => {
  let dir = dirname(cwd);
  while (!existsSync(dir) && dir !== dirname(dir)) dir = dirname(dir);
  const worktree = looksLikeWorktree(cwd);
  const own = await gitIdentity(dir);
  if (own) return { path: own.path, worktree: worktree || own.worktree };
  if (!worktree || !looksLikeWorktree(`${dir}/`)) return { worktree: false };
  const slug = cwd.slice(dir.length + 1).split("/")[0];
  const siblings = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const s of siblings.filter((e) => e.isDirectory())) {
    const sibling = await gitIdentity(join(dir, s.name));
    const name = sibling?.worktree && sibling.path && basename(sibling.path);
    if (name && (basename(dir) === name || slug.startsWith(`${name}-`))) return { path: sibling.path, worktree: true };
  }
  return { worktree: false };
};

const resolveIdentity = async (cwd: string): Promise<Identity> =>
  existsSync(cwd) ? ((await gitIdentity(cwd)) ?? { worktree: false }) : missingIdentity(cwd);

const identities = new Map<string, { at: number; identity: Promise<Identity> }>();
const languages = new Map<string, Promise<string | undefined>>();
type Branches = { current?: string; all?: Set<string> };
const branches = new Map<string, { at: number; state: Promise<Branches> }>();

const memo = <T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>) => {
  const hit = cache.get(key);
  if (hit) return hit;
  const promise = load();
  cache.set(key, promise);
  return promise;
};

const identityOf = async (cwd: string) => {
  const hit = identities.get(cwd);
  if (hit && ((await hit.identity).path || Date.now() - hit.at < retryTtl)) return hit.identity;
  const identity = resolveIdentity(cwd);
  identities.set(cwd, { at: Date.now(), identity });
  return identity;
};

const loadBranches = async (path: string): Promise<Branches> => {
  const [current, refs] = await Promise.all([
    run("git", ["-C", path, "branch", "--show-current"]),
    run("git", ["-C", path, "for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"]),
  ]);
  const names = refs?.split("\n").map((ref) => ref.replace(/^refs\/(heads|remotes\/[^/]+)\//, ""));
  return { current: current || undefined, all: names && new Set(names) };
};

const branchState = (path: string) => {
  const hit = branches.get(path);
  if (hit && Date.now() - hit.at < branchTtl) return hit.state;
  const state = loadBranches(path);
  branches.set(path, { at: Date.now(), state });
  return state;
};

export const resolveRepo = async (cwd: string): Promise<RepoInfo> => {
  try {
    const { path, worktree } = await identityOf(cwd);
    if (!path) return { worktree };
    const [language, { current, all }] = await Promise.all([
      memo(languages, path, () => detectLanguage(path)),
      branchState(path),
    ]);
    return { repo: { name: basename(path), path, language, currentBranch: current, branches: all }, worktree };
  } catch {
    return { worktree: false };
  }
};

type GhPr = {
  number: number;
  title: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  url: string;
  headRefName: string;
};

const prTtl = 5 * 60_000;
const prFields = "number,title,state,isDraft,url,headRefName";

const toState = ({ state, isDraft }: GhPr): PrState =>
  state === "OPEN" ? (isDraft ? "draft" : "open") : state === "MERGED" ? "merged" : "closed";

const isOpen = (pr: Pr) => pr.state === "open" || pr.state === "draft";

// Several PRs on one branch: open/draft wins, else the most recent.
const better = (a: Pr, b: Pr) => (isOpen(a) !== isOpen(b) ? isOpen(a) : a.number > b.number);

const parsePrs = (out?: string) => {
  const prs = new Map<string, Pr>();
  try {
    for (const gh of JSON.parse(out ?? "[]") as GhPr[]) {
      const pr: Pr = { number: gh.number, title: gh.title, state: toState(gh), url: gh.url };
      const current = prs.get(gh.headRefName);
      if (!current || better(pr, current)) prs.set(gh.headRefName, pr);
    }
  } catch {}
  return prs;
};

const prCache = new Map<string, { at: number; prs: Promise<Map<string, Pr>> }>();

// Failures (no gh, not authenticated, no GitHub remote) yield an empty map, cached like a success.
export const loadPrs = (repoPath: string): Promise<Map<string, Pr>> => {
  const hit = prCache.get(repoPath);
  if (hit && Date.now() - hit.at < prTtl) return hit.prs;
  const prs = run(
    "gh",
    ["pr", "list", "--state", "all", "--author", "@me", "--json", prFields, "--limit", "100"],
    repoPath,
    20_000,
  ).then(parsePrs);
  prCache.set(repoPath, { at: Date.now(), prs });
  return prs;
};

const withRepo = async (s: ClaudeSession): Promise<Session> => {
  const info = await resolveRepo(s.cwd);
  // A deleted worktree outside the repo (e.g. a sibling folder): the session started in the repo it belongs to.
  if (!info.repo && s.startCwd !== s.cwd && !existsSync(s.cwd)) {
    const { repo } = await resolveRepo(s.startCwd);
    if (repo) return { ...s, repo, worktree: true };
  }
  return { ...s, ...info };
};

export const withRepos = (sessions: ClaudeSession[]): Promise<Session[]> => Promise.all(sessions.map(withRepo));

// Separate from withRepos: `gh` takes ~1s per repo cold, so the tree renders first and PRs fill in after.
export const withPrs = async (sessions: Session[]): Promise<Session[]> => {
  const paths = [...new Set(sessions.flatMap((s) => (s.repo ? [s.repo.path] : [])))];
  const prs = new Map(await Promise.all(paths.map(async (path) => [path, await loadPrs(path)] as const)));
  return sessions.map((s) => ({ ...s, pr: s.repo && s.branch ? prs.get(s.repo.path)?.get(s.branch) : undefined }));
};
