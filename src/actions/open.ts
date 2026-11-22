import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { log } from "../log";
import { isLive, needsWorktree, Session } from "../sessions/model";
import { where } from "../view";
import { ancestors, otherWindows, sharedDir, thisWindow, WindowInfo } from "./windows";

type Target = "editor" | "terminal";
// `window` targets one window by pid (else any window with `folder`); `shellPid` shows that existing terminal.
type Handoff = {
  sessionId: string;
  name: string;
  folder: string;
  target: Target;
  createdAt: number;
  window?: number;
  shellPid?: number;
};

const handoffTtl = 2 * 60_000;

// A file, not globalState: globalState reaches other windows only after VS Code flushes it, often too late.
const handoffFile = join(sharedDir, "handoff.json");

const writeHandoff = (handoff: Omit<Handoff, "createdAt">) => {
  mkdirSync(sharedDir, { recursive: true });
  writeFileSync(handoffFile, JSON.stringify({ ...handoff, createdAt: Date.now() }));
};

const readHandoff = (): Handoff | undefined => {
  try {
    return JSON.parse(readFileSync(handoffFile, "utf8"));
  } catch {
    return undefined;
  }
};

const clearHandoff = () => rmSync(handoffFile, { force: true });

const run = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await run("git", ["-C", cwd, ...args])).stdout.trim();

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const tildify = (path: string) => path.replace(homedir(), "~");
const errorText = (e: unknown) => (e as { stderr?: string }).stderr?.trim() || (e instanceof Error ? e.message : String(e));

const defaultTarget = (): Target =>
  vscode.workspace.getConfiguration("claudeSessions").get("openIn") === "editor" ? "editor" : "terminal";

const ask = (message: string, detail: string | undefined, ...items: (string | false | undefined)[]) =>
  vscode.window.showWarningMessage(message, { modal: true, detail }, ...items.filter((i): i is string => !!i));

const workspacePaths = () => (vscode.workspace.workspaceFolders ?? []).map(({ uri }) => uri.fsPath);

// A Claude tab runs in the workspace folder, so it needs an exact match; a terminal can start anywhere inside one.
const isHere = (folder: string, target: Target) =>
  workspacePaths().some((path) => path === folder || (target === "terminal" && folder.startsWith(path + sep)));

const worktreeFor = async (repo: string, branch: string) =>
  (await git(repo, "worktree", "list", "--porcelain"))
    .split("\n\n")
    .find((block) => block.split("\n").includes(`branch refs/heads/${branch}`))
    ?.match(/^worktree (.+)$/m)?.[1];

export const createWorktree = async (s: Session): Promise<string | undefined> => {
  const repo = s.repo?.path;
  const branch = s.branch;
  if (!repo || !branch) return;
  try {
    return await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Creating worktree for ${branch}…` },
      async () => {
        // Drops worktrees whose folder was deleted without `git worktree remove`.
        await git(repo, "worktree", "prune").catch(() => undefined);
        const existing = await worktreeFor(repo, branch);
        if (existing) return existing;
        const path = `${repo}/.claude/worktrees/${branch.replace(/[^\w.-]+/g, "-")}`;
        // A branch only on the remote: fetch it, then `worktree add` creates a local tracking branch.
        await git(repo, "worktree", "add", path, branch).catch(async () => {
          await git(repo, "fetch", "origin", branch);
          await git(repo, "worktree", "add", path, branch);
        });
        return path;
      },
    );
  } catch (e) {
    vscode.window.showErrorMessage(`Could not create a worktree for ${branch}: ${errorText(e)}`);
  }
};

const missingFolder = async (s: Session) => {
  const recreate = s.repo && s.branch && `Recreate worktree for ${s.branch}`;
  const root = s.repo && existsSync(s.repo.path) && "Open repository root";
  const picked = await ask(`${tildify(s.cwd)} no longer exists.`, undefined, recreate, root);
  if (picked && picked === recreate) return createWorktree(s);
  if (picked && picked === root) return s.repo?.path;
};

const branchElsewhere = async (s: Session, repo: string, branch: string) => {
  const clean = !(await git(repo, "status", "--porcelain", "--untracked-files=no").catch(() => "unknown"));
  const create = `Create worktree for ${branch}`;
  const checkout = `Checkout ${branch}`;
  const anyway = "Open anyway";
  const picked = await ask(
    `${s.repo?.name} is on ${s.repo?.currentBranch}, but this session ran on ${branch}.`,
    clean ? undefined : "Checkout is not offered: the checkout has uncommitted changes.",
    create,
    clean && checkout,
    anyway,
  );
  if (picked === create) return createWorktree(s);
  if (picked === anyway) return s.cwd;
  if (picked !== checkout) return;
  try {
    await git(repo, "checkout", branch);
    return s.cwd;
  } catch (e) {
    vscode.window.showErrorMessage(`Could not check out ${branch}: ${errorText(e)}`);
  }
};

const pickFolder = (s: Session) => {
  if (!existsSync(s.cwd)) return missingFolder(s);
  if (needsWorktree(s) && s.repo && s.branch) return branchElsewhere(s, s.repo.path, s.branch);
  return Promise.resolve(s.cwd);
};

export const resumeHere = async (
  s: Pick<Session, "id" | "name" | "cwd">,
  target: Target = defaultTarget(),
  folder = s.cwd,
): Promise<void> => {
  if (target === "editor" && vscode.extensions.getExtension("anthropic.claude-code")) {
    log.info(`Resuming ${s.id} in a Claude tab`);
    try {
      await vscode.commands.executeCommand("claude-vscode.primaryEditor.open", s.id);
      return;
    } catch (e) {
      log.error(`Claude tab failed, falling back to a terminal: ${errorText(e)}`);
    }
  }
  log.info(`Resuming ${s.id} in a terminal at ${folder}`);
  const terminal = vscode.window.createTerminal({ name: s.name, cwd: folder, iconPath: new vscode.ThemeIcon("sparkle") });
  terminal.show();
  terminal.sendText(`claude --resume ${s.id}`);
};

const showTerminal = async (shellPids: number[]) => {
  for (const terminal of vscode.window.terminals) {
    if (!shellPids.includes((await terminal.processId) ?? -1)) continue;
    terminal.show();
    return true;
  }
  return false;
};

// Opening a window's folder (or workspace file) focuses it; never replaces this window's folder.
const openWindow = (path: string) =>
  vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(path), { forceNewWindow: true });

const focusWindow = async (w: WindowInfo) => {
  const path = w.workspaceFile ?? w.folders[0];
  if (path) await openWindow(path);
  return !!path;
};

// Where a live session runs inside VS Code: a window's terminal, or a Claude tab (a child of that window's extension host).
// Needs `ps` (not on Windows) and claude started under the terminal's shell (not tmux); otherwise nothing is found.
const findOwner = async (pid: number) => {
  const chain = await ancestors(pid);
  for (const w of [await thisWindow(), ...otherWindows()]) {
    const shellPid = w.terminals.find((t) => chain.includes(t));
    if (shellPid || chain.includes(w.pid)) return { window: w, shellPid };
  }
};

// Already running in a VS Code window: show its terminal or Claude tab there instead of resuming a second copy.
const revealLive = async (s: Session) => {
  const owner = s.pid && (await findOwner(s.pid));
  if (!owner) return false;
  const target: Target = owner.shellPid ? "terminal" : "editor";
  log.info(`${s.id} runs in window ${owner.window.pid} (${owner.shellPid ? `terminal ${owner.shellPid}` : "Claude tab"})`);
  if (owner.window.pid === process.pid) {
    if (owner.shellPid) return showTerminal([owner.shellPid]);
    await resumeHere(s, "editor");
    return true;
  }
  writeHandoff({ sessionId: s.id, name: s.name, folder: s.cwd, target, window: owner.window.pid, shellPid: owner.shellPid });
  return focusWindow(owner.window);
};

// VS Code can't open a second window on a folder that is already open, so stay here when it is this window's folder.
const goTo = async (s: Session, folder: string, target: Target, resume: boolean, newWindow: boolean) => {
  if (isHere(folder, target) && (!newWindow || workspacePaths().includes(folder))) {
    log.info(`${folder} is open in this window`);
    if (resume) await resumeHere(s, target, folder);
    return;
  }
  // Another window with this folder (or, for a terminal, a folder containing it): focus it and resume there.
  const owner = otherWindows().find(
    (w) => w.folders.includes(folder) || (target === "terminal" && w.folders.some((f) => folder.startsWith(f + sep))),
  );
  if (resume) writeHandoff({ sessionId: s.id, name: s.name, folder, target, window: owner?.pid });
  log.info(`Opening ${folder} in ${owner ? `window ${owner.pid}` : "a new window"}${resume ? `, handing off ${s.id} (${target})` : ""}`);
  if (!owner || !(await focusWindow(owner))) await openWindow(folder);
};

export const openSession = async (s: Session, opts: { newWindow?: boolean; target?: Target }): Promise<void> => {
  if (isLive(s) && (await revealLive(s))) return;
  const target = opts.target ?? defaultTarget();
  let resume = true;
  if (isLive(s)) {
    const resumeAnyway = "Resume anyway";
    const justOpen = "Just open the folder";
    const picked = await ask(
      `"${s.name}" is still running in the ${where[s.entrypoint]}.`,
      "Resuming it here too means two processes writing the same session.",
      resumeAnyway,
      justOpen,
    );
    if (!picked) return;
    resume = picked === resumeAnyway;
  }

  const folder = await pickFolder(s);
  if (folder) await goTo(s, folder, target, resume, !!opts.newWindow);
};

export const openInWorktree = async (s: Session): Promise<void> => {
  const folder = await createWorktree(s);
  if (folder) await goTo(s, folder, defaultTarget(), true, false);
};

let consuming = false;

// Retries cover a focus event that fires before the other window finished writing the handoff.
export const consumeHandoff = async (): Promise<void> => {
  if (consuming) return;
  consuming = true;
  try {
    for (const wait of [0, 300, 1000]) {
      await delay(wait);
      const handoff = readHandoff();
      if (!handoff) continue;
      if (Date.now() - handoff.createdAt > handoffTtl) {
        log.info(`Dropping expired handoff for ${handoff.sessionId}`);
        return clearHandoff();
      }
      const mine = handoff.window ? handoff.window === process.pid : isHere(handoff.folder, handoff.target);
      if (!mine) {
        log.info(`Handoff for ${handoff.folder} is not for this window (${workspacePaths().join(", ") || "no folder"})`);
        return;
      }
      clearHandoff();
      log.info(`Picked up handoff for ${handoff.sessionId}`);
      // The session is live in that terminal: showing it is the whole job, resuming would start a second copy.
      if (handoff.shellPid) {
        if (!(await showTerminal([handoff.shellPid]))) log.info(`Terminal ${handoff.shellPid} is gone`);
        return;
      }
      return resumeHere({ id: handoff.sessionId, name: handoff.name, cwd: handoff.folder }, handoff.target);
    }
  } finally {
    consuming = false;
  }
};

export const openPr = async (s: Session): Promise<void> => {
  if (s.pr) await vscode.env.openExternal(vscode.Uri.parse(s.pr.url));
};
