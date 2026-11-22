import { existsSync } from "node:fs";
import { ClaudeSession, Session } from "../model";
import { readClaudeSessions } from "./claude";
import { resolveRepo } from "./git";
import { loadPrs } from "./github";

export { transcriptPath, watchClaudeSessions } from "./claude";
export { resolveRepo } from "./git";

const withRepo = async (s: ClaudeSession): Promise<Session> => {
  const info = await resolveRepo(s.cwd);
  // A deleted worktree outside the repo (e.g. a sibling folder): the session started in the repo it belongs to.
  if (!info.repo && s.startCwd !== s.cwd && !existsSync(s.cwd)) {
    const { repo } = await resolveRepo(s.startCwd);
    if (repo) return { ...s, repo, worktree: true };
  }
  return { ...s, ...info };
};

export const loadSessions = async (): Promise<Session[]> => Promise.all((await readClaudeSessions()).map(withRepo));

// Separate from loadSessions: `gh` takes ~1s per repo cold, so the tree renders first and PRs fill in after.
export const withPrs = async (sessions: Session[]): Promise<Session[]> => {
  const paths = [...new Set(sessions.flatMap((s) => (s.repo ? [s.repo.path] : [])))];
  const prs = new Map(await Promise.all(paths.map(async (path) => [path, await loadPrs(path)] as const)));
  return sessions.map((s) => ({ ...s, pr: s.repo && s.branch ? prs.get(s.repo.path)?.get(s.branch) : undefined }));
};
