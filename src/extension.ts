import * as vscode from "vscode";
import { registerCommands } from "./actions/commands";
import { consumeHandoff } from "./actions/open";
import { registerWindow } from "./actions/windows";
import { log } from "./log";
import { readClaudeSessions, watchClaudeSessions } from "./sessions/claude";
import { resolveRepo, withPrs, withRepos } from "./sessions/git";
import { isLive } from "./sessions/model";
import { SessionsView } from "./view";

// Catches sessions whose process died without touching its file.
const pollInterval = 30_000;
// Busy sessions write constantly; refresh at most this often.
const watchDelay = 1_000;

const currentRepos = async () => {
  const folders = (vscode.workspace.workspaceFolders ?? []).map(({ uri }) => uri.fsPath);
  const infos = await Promise.all(folders.map(resolveRepo));
  return new Set(infos.flatMap(({ repo }) => (repo ? [repo.path] : [])));
};

export const activate = (context: vscode.ExtensionContext) => {
  const tree = new SessionsView(context.globalState, []);
  const view = vscode.window.createTreeView("multirepoSessions.list", {
    treeDataProvider: tree,
    showCollapseAll: true,
  });
  view.message = "Loading sessions…";

  const updateBadge = () => {
    const waiting = tree.sessions.filter((s) => s.status === "idle").length;
    view.badge = waiting ? { value: waiting, tooltip: `${waiting} sessions waiting for you` } : undefined;
    view.description = `${tree.sessions.filter(isLive).length} live`;
  };

  // One refresh at a time; calls during one mark it dirty and it runs once more.
  // Hidden views (collapsed section, other windows' sidebars) only remember that they're stale.
  let running = false;
  let dirty = false;
  let stale = true;
  const refresh = async () => {
    if (!view.visible) return void (stale = true);
    stale = false;
    if (running) return void (dirty = true);
    running = true;
    try {
      do {
        dirty = false;
        const sessions = await withRepos(await readClaudeSessions());
        view.message = undefined;
        // Keep the previous PRs until fresh ones arrive, so rows don't flicker.
        const prs = new Map(tree.sessions.map((s) => [s.id, s.pr]));
        tree.setSessions(sessions.map((s) => ({ ...s, pr: prs.get(s.id) })));
        tree.setSessions(await withPrs(sessions));
      } while (dirty);
    } finally {
      running = false;
    }
  };
  const updateCurrentRepos = async () => tree.setCurrentRepos(await currentRepos());

  const poll = setInterval(() => void refresh(), pollInterval);
  void updateCurrentRepos().then(refresh);
  const showWhenVisible = view.onDidChangeVisibility(({ visible }) => visible && stale && void refresh());
  log.info(
    `Activated in ${vscode.workspace.workspaceFolders?.map(({ uri }) => uri.fsPath).join(", ") || "a window without folder"}`,
  );
  void consumeHandoff();

  context.subscriptions.push(
    view,
    log,
    registerWindow(),
    showWhenVisible,
    vscode.window.registerFileDecorationProvider(tree),
    tree.onDidChangeTreeData(updateBadge),
    new vscode.Disposable(watchClaudeSessions(() => void refresh(), undefined, watchDelay)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void updateCurrentRepos()),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration("multirepoSessions") && tree.rerender()),
    new vscode.Disposable(() => clearInterval(poll)),
    vscode.window.onDidChangeWindowState(({ focused }) => focused && void consumeHandoff()),
    ...registerCommands(tree, refresh),
  );
  // Integration tests read the tree directly.
  return context.extensionMode === vscode.ExtensionMode.Test ? { tree } : undefined;
};
