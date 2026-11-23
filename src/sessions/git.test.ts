import * as assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "vite-plus/test";
import { createFixture } from "../test/fixture";
import { loadPrs, ownsFolder, resolveRepo } from "./git";

const fx = createFixture(process.pid);
afterAll(() => rmSync(fx.root, { recursive: true, force: true }));

test("resolves repos, worktrees and deleted worktrees", async () => {
  const main = await resolveRepo(fx.alpha);
  assert.equal(main.worktree, false);
  assert.deepEqual(
    { ...main.repo, branches: [...(main.repo?.branches ?? [])].sort() },
    {
      name: "alpha",
      path: fx.alpha,
      language: "ts",
      currentBranch: "main",
      branches: ["feature", "main"],
    },
  );
  assert.deepEqual(await resolveRepo(fx.worktree).then((r) => [r.repo?.path, r.worktree]), [fx.alpha, true]);
  assert.deepEqual(
    await resolveRepo(join(fx.alpha, ".claude/worktrees/gone")).then((r) => [r.repo?.path, r.worktree]),
    [fx.alpha, true],
  );
  assert.deepEqual(await resolveRepo(fx.notes), { worktree: false });
});

test("owns nested folders only within the same checkout", () => {
  assert.equal(ownsFolder(fx.alpha, join(fx.alpha, "src/app")), true);
  assert.equal(ownsFolder(fx.notes, join(fx.notes, "drafts")), true);
  assert.equal(ownsFolder(fx.root, fx.alpha), false);
  assert.equal(ownsFolder(fx.root, join(fx.alpha, "src")), false);
  assert.equal(ownsFolder(fx.alpha, fx.worktree), false);
  assert.equal(ownsFolder(fx.alpha, `${fx.alpha}-other`), false);
});

test("maps gh output to one PR per branch", async () => {
  const path = process.env.PATH;
  process.env.PATH = `${fx.bin}:${path}`;
  const withPrs = mkdtempSync(join(tmpdir(), "cms-gh-"));
  const pr = (number: number, headRefName: string, state: string, isDraft = false) => ({
    number,
    title: `PR ${number}`,
    state,
    isDraft,
    url: `u/${number}`,
    headRefName,
  });
  writeFileSync(
    join(withPrs, "prs.json"),
    JSON.stringify([
      pr(1, "feature", "CLOSED"),
      pr(2, "feature", "OPEN", true),
      pr(3, "main", "MERGED"),
      pr(5, "main", "MERGED"),
      pr(4, "fix", "OPEN"),
    ]),
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
