import * as assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { readClaudeSessions } from "../../sources/claude";
import { resolveRepo } from "../../sources/git";
import { loadPrs } from "../../sources/github";
import { createFixture } from "../fixture";

const fx = createFixture(process.pid);
after(() => rmSync(fx.root, { recursive: true, force: true }));

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

test("resolves repos, worktrees and deleted worktrees", async () => {
  const main = await resolveRepo(fx.alpha);
  assert.equal(main.worktree, false);
  assert.deepEqual({ ...main.repo, branches: [...(main.repo?.branches ?? [])].sort() }, {
    name: "alpha",
    path: fx.alpha,
    language: "ts",
    currentBranch: "main",
    branches: ["feature", "main"],
  });
  assert.deepEqual(await resolveRepo(fx.worktree).then((r) => [r.repo?.path, r.worktree]), [fx.alpha, true]);
  assert.deepEqual(await resolveRepo(join(fx.alpha, ".claude/worktrees/gone")).then((r) => [r.repo?.path, r.worktree]), [fx.alpha, true]);
  assert.deepEqual(await resolveRepo(fx.notes), { worktree: false });
});

test("maps gh output to one PR per branch", async () => {
  const path = process.env.PATH;
  process.env.PATH = `${fx.bin}:${path}`;
  const withPrs = mkdtempSync(join(tmpdir(), "cms-gh-"));
  const pr = (number: number, headRefName: string, state: string, isDraft = false) => ({ number, title: `PR ${number}`, state, isDraft, url: `u/${number}`, headRefName });
  writeFileSync(
    join(withPrs, "prs.json"),
    JSON.stringify([pr(1, "feature", "CLOSED"), pr(2, "feature", "OPEN", true), pr(3, "main", "MERGED"), pr(5, "main", "MERGED"), pr(4, "fix", "OPEN")]),
  );
  try {
    const prs = await loadPrs(withPrs);
    assert.deepEqual(Object.fromEntries([...prs].map(([branch, p]) => [branch, `#${p.number} ${p.state}`])), {
      feature: "#2 draft",
      main: "#5 merged",
      fix: "#4 open",
    });
    assert.deepEqual(prs.get("fix"), { number: 4, title: "PR 4", state: "open", url: "u/4" });
    // gh failing (no prs.json here) means no PRs.
    assert.equal((await loadPrs(fx.notes)).size, 0);
  } finally {
    process.env.PATH = path;
    rmSync(withPrs, { recursive: true, force: true });
  }
});
