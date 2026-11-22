import * as vscode from "vscode";

// Output → "Claude Sessions": the click/handoff steps, for debugging what happened in which window.
export const log = vscode.window.createOutputChannel("Claude Sessions", { log: true });
