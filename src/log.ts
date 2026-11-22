import * as vscode from "vscode";

// Output → "Multi-Repo Sessions": the click/handoff steps, for debugging what happened in which window.
export const log = vscode.window.createOutputChannel("Multi-Repo Sessions", { log: true });
