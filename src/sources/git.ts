import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Repo } from "../model";

export type RepoInfo = { repo?: Repo; worktree: boolean };

type Identity = { path?: string; worktree: boolean };

const branchTtl = 10_000;
// Folders that aren't (or no longer resolve to) a repo are retried after this, e.g. after a git timeout.
const retryTtl = 60_000;

export const run = (cmd: string, args: string[], cwd?: string, timeout = 5_000) =>
  new Promise<string | undefined>((resolve) =>
    execFile(cmd, args, { cwd, timeout, windowsHide: true }, (error, stdout) => resolve(error ? undefined : stdout.trim())),
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
  return markers.find(([marker]) => files.some((f) => (typeof marker === "string" ? f === marker : marker.test(f))))?.[1];
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
    const [language, { current, all }] = await Promise.all([memo(languages, path, () => detectLanguage(path)), branchState(path)]);
    return { repo: { name: basename(path), path, language, currentBranch: current, branches: all }, worktree };
  } catch {
    return { worktree: false };
  }
};
