import * as assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { afterAll, test } from "vite-plus/test";
import { createFixture } from "../test/fixture";
import { readClaudeSessions } from "./claude";

const fx = createFixture(process.pid);
afterAll(() => rmSync(fx.root, { recursive: true, force: true }));

test("reads sessions from transcripts and live files", async () => {
  const sessions = new Map((await readClaudeSessions(fx.claudeDir)).map((s) => [s.id, s]));

  assert.deepEqual([...sessions.keys()].sort(), ["alpha-live", "alpha-past", "beta-big", "beta-new", "beta-old", "notes-1"]);
  assert.deepEqual(
    { ...sessions.get("alpha-live"), updatedAt: undefined },
    {
      id: "alpha-live",
      name: "Live in worktree",
      cwd: fx.worktree,
      startCwd: fx.worktree,
      branch: "feature",
      status: "idle",
      pid: process.pid,
      entrypoint: "cli",
      updatedAt: undefined,
      lastMessage: "On it",
    },
  );
  assert.equal(sessions.get("alpha-past")?.name, "Renamed alpha session");
  assert.equal(sessions.get("beta-new")?.name, "Beta AI title");
  assert.equal(sessions.get("beta-new")?.status, "ended");
  assert.equal(sessions.get("beta-old")?.name, "/review fix the beta bug");
  assert.match(sessions.get("beta-big")?.name ?? "", /^pasted pasted .{100,}…$/);
  assert.equal(sessions.get("beta-big")?.lastMessage, "Summary after the tools");
});

