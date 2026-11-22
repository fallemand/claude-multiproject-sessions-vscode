import * as assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import type { SessionsView } from "../view";
import type { Fixture } from "./fixture";
import { sharedDir } from "../actions/windows";

const fx: Fixture = JSON.parse(process.env.FIXTURE!);
const extension = vscode.extensions.getExtension<{ tree: SessionsView }>("fallemand.claude-multiproject-sessions")!;

const until = async <T>(get: () => T | undefined, what: string, timeout = 10_000) => {
  for (const start = Date.now(); Date.now() - start < timeout; await new Promise((r) => setTimeout(r, 100))) {
    const value = get();
    if (value) return value;
  }
  throw new Error(`Timed out waiting for ${what}`);
};

const setting = (key: string, value: unknown) =>
  vscode.workspace.getConfiguration().update(key, value, vscode.ConfigurationTarget.Global);

suite("extension", () => {
  let tree: SessionsView;
  const labels = (node?: unknown) => tree.getChildren(node as never).map((n) => tree.getTreeItem(n).label as string);
  const group = (label: string) => tree.getChildren().find((n) => tree.getTreeItem(n).label === label);

  suiteSetup(async () => {
    tree = (await extension.activate()).tree;
    await vscode.commands.executeCommand("claudeSessions.list.focus");
    await until(
      () =>
        tree.sessions.length &&
        tree.getChildren()[0] &&
        tree.getTreeItem(tree.getChildren()[0]).collapsibleState === vscode.TreeItemCollapsibleState.Expanded,
      "sessions",
    );
  });

  test("lists the fixture sessions by repo and folds them per settings", async () => {
    const contributed: { command: string }[] = extension.packageJSON.contributes.commands;
    const registered = await vscode.commands.getCommands(true);
    assert.deepEqual(
      contributed.filter(({ command }) => !registered.includes(command)),
      [],
    );

    // Current project (the workspace folder) first and expanded; the live session first, past ones behind a toggle.
    assert.deepEqual(labels(), ["alpha", "beta", "Non-git folders"]);
    assert.deepEqual(labels(group("alpha")), ["Live in worktree", "1 past"]);
    const toggle = tree.getChildren(group("alpha") as never)[1];
    await vscode.commands.executeCommand("claudeSessions.toggleMore", toggle);
    assert.deepEqual(labels(group("alpha")), ["Live in worktree", "1 past", "Renamed alpha session"]);
    assert.equal(tree.getTreeItem(group("beta")!).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
    assert.match(labels(group("beta"))[2], /^pasted pasted /);

    await setting("claudeSessions.maxProjects", 1);
    await setting("claudeSessions.maxPastSessions", 2);
    try {
      assert.deepEqual(labels(), ["alpha", "2 more projects"]);
      assert.deepEqual(labels(group("alpha")), ["Live in worktree", "1 past", "Renamed alpha session"]);
      await vscode.commands.executeCommand("claudeSessions.toggleMore", tree.getChildren()[1]);
      assert.deepEqual(labels(group("beta")), ["Beta AI title", "/review fix the beta bug", "Load 1 more"]);
    } finally {
      await setting("claudeSessions.maxProjects", undefined);
      await setting("claudeSessions.maxPastSessions", undefined);
    }
  });

  test("resumes a past session of this window's folder in a terminal here", async () => {
    // Terminals run /bin/sh with the stub `claude` first on PATH (see .vscode-test.mjs).
    const session = tree.sessions.find((s) => s.id === "alpha-past");
    await vscode.commands.executeCommand("claudeSessions.resumeInTerminal", session);

    const terminal = vscode.window.terminals.find((t) => t.name === "Renamed alpha session");
    assert.equal((terminal?.creationOptions as vscode.TerminalOptions | undefined)?.cwd, fx.alpha);
    const args = join(fx.root, "claude-args");
    assert.equal(
      await until(() => existsSync(args) && readFileSync(args, "utf8").trim(), "claude to run"),
      "--resume alpha-past",
    );
    // Resumed here, so nothing was handed off to another window.
    assert.equal(existsSync(join(sharedDir, "handoff.json")), false);
  });
});
