import * as vscode from "vscode";
import { Session } from "../sessions/model";
import { openInWorktree, openPr, openSession } from "./open";
import { transcriptPath } from "../sessions/claude";
import { MoreToggle, SessionsView, ViewState } from "../view";

const layouts: { label: string; detail: string; value: ViewState["layout"] }[] = [
  { label: "Compact", detail: "Name · time", value: "compact" },
  { label: "Detailed", detail: "Name · PR · branch · worktree · where it runs · time", value: "detailed" },
  { label: "Branch first", detail: "Branch · name · time", value: "branchFirst" },
];

export const registerCommands = (
  tree: SessionsView,
  refresh: () => Promise<void>,
): vscode.Disposable[] => {
  const commands = {
    refresh,
    showLiveOnly: () => tree.setState({ filter: "live" }),
    showAll: () => tree.setState({ filter: "all" }),
    groupByStatus: () => tree.setState({ groupBy: "status" }),
    groupByRepo: () => tree.setState({ groupBy: "repo" }),
    pickLayout: async () => {
      const picked = await vscode.window.showQuickPick(
        layouts.map((l) => ({ ...l, description: l.value === tree.state.layout ? "current" : undefined })),
        { title: "Row layout" },
      );
      if (picked) tree.setState({ layout: picked.value });
    },
    toggleMore: (toggle: MoreToggle) => tree.toggleMore(toggle),
    open: (s: Session) => openSession(s, {}),
    openInNewWindow: (s: Session) => openSession(s, { newWindow: true }),
    resumeInEditor: (s: Session) => openSession(s, { target: "editor" }),
    resumeInTerminal: (s: Session) => openSession(s, { target: "terminal" }),
    openPr,
    createWorktree: openInWorktree,
    revealTranscript: (s: Session) =>
      vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(transcriptPath(s))),
    copyId: async (s: Session) => {
      await vscode.env.clipboard.writeText(s.id);
      vscode.window.setStatusBarMessage("Copied session ID", 2000);
    },
  };

  return Object.entries(commands).map(([name, run]) => vscode.commands.registerCommand(`claudeSessions.${name}`, run));
};
