export type SessionStatus = "busy" | "idle" | "ended";

export type Entrypoint = "cli" | "vscode" | "desktop";

export type PrState = "draft" | "open" | "merged" | "closed";

export type Pr = { number: number; title: string; state: PrState; url: string };

export type Repo = {
  name: string;
  path: string;
  language?: string;
  // Branch checked out in the main checkout.
  currentBranch?: string;
  // Local and remote branch names.
  branches?: Set<string>;
};

export type Session = {
  id: string;
  name: string;
  repo?: Repo;
  cwd: string;
  // Where the session started; its transcript is filed under this folder.
  startCwd: string;
  branch?: string;
  pr?: Pr;
  worktree: boolean;
  status: SessionStatus;
  // Process of a live session.
  pid?: number;
  entrypoint: Entrypoint;
  updatedAt: Date;
  lastMessage: string;
};

// What Claude Code's own files tell us; git and GitHub fill in the rest.
export type ClaudeSession = Omit<Session, "repo" | "pr" | "worktree">;

export const isLive = (s: Session) => s.status !== "ended";

// Ran in the main checkout, which is now on another branch that still exists.
export const needsWorktree = (s: Session) =>
  !s.worktree &&
  !!s.branch &&
  !!s.repo?.currentBranch &&
  s.branch !== s.repo.currentBranch &&
  (s.repo.branches?.has(s.branch) ?? true);
