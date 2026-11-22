import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { log } from "../log";
import { isRunning } from "../sessions/claude";

// Shared by every window of this user, across profiles (unlike the extension's global storage, which is per profile).
export const sharedDir = join(tmpdir(), `claude-multiproject-sessions-${userInfo().uid}`);
const windowsDir = join(sharedDir, "windows");

// `pid` is the window's extension host: Claude tabs run as its children, terminal shells are listed in `terminals`.
export type WindowInfo = { pid: number; app: string; folders: string[]; workspaceFile?: string; terminals: number[] };

const run = promisify(execFile);
const windowFile = (pid: number) => join(windowsDir, `${pid}.json`);

export const thisWindow = async (): Promise<WindowInfo> => ({
  pid: process.pid,
  app: vscode.env.appName,
  folders: (vscode.workspace.workspaceFolders ?? []).map(({ uri }) => uri.fsPath),
  workspaceFile: vscode.workspace.workspaceFile?.scheme === "file" ? vscode.workspace.workspaceFile.fsPath : undefined,
  terminals: (await Promise.all(vscode.window.terminals.map((t) => t.processId))).filter((pid): pid is number => !!pid),
});

export const registerWindow = (): vscode.Disposable => {
  const write = async () => {
    try {
      const info = await thisWindow();
      mkdirSync(windowsDir, { recursive: true });
      writeFileSync(windowFile(info.pid), JSON.stringify(info));
    } catch (e) {
      log.error(`Could not register this window: ${String(e)}`);
    }
  };
  void write();
  const subscriptions = [
    vscode.window.onDidOpenTerminal(write),
    vscode.window.onDidCloseTerminal(write),
    vscode.workspace.onDidChangeWorkspaceFolders(write),
  ];
  return new vscode.Disposable(() => {
    subscriptions.forEach((s) => s.dispose());
    rmSync(windowFile(process.pid), { force: true });
  });
};

// Other windows of the same app (Cursor can't focus a VS Code window); entries of crashed windows are removed.
export const otherWindows = (): WindowInfo[] => {
  const files = (() => {
    try {
      return readdirSync(windowsDir);
    } catch {
      return [];
    }
  })();
  return files.flatMap((f) => {
    try {
      const w: WindowInfo = JSON.parse(readFileSync(join(windowsDir, f), "utf8"));
      if (!isRunning(w.pid)) {
        rmSync(join(windowsDir, f), { force: true });
        return [];
      }
      return w.pid !== process.pid && w.app === vscode.env.appName ? [w] : [];
    } catch {
      return [];
    }
  });
};

// Processes above `pid`, nearest first, so wrappers (npx, scripts) between a shell and claude don't hide the shell.
// Windows has no `ps`: an empty chain makes callers fall back to the plain behavior.
export const ancestors = async (pid: number): Promise<number[]> => {
  if (process.platform === "win32") return [];
  try {
    const { stdout } = await run("ps", ["-A", "-o", "pid=,ppid="]);
    const parent = new Map(stdout.trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number) as [number, number]));
    const chain: number[] = [];
    for (let p = parent.get(pid); p && p > 1 && chain.length < 10; p = parent.get(p)) chain.push(p);
    return chain;
  } catch {
    return [];
  }
};
