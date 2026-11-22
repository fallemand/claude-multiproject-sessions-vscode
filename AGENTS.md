# Multi-Project Sessions for Claude Code (VS Code extension)

Sidebar listing Claude Code sessions grouped by repo; clicking one opens its worktree/branch and resumes the session.

Full plan, verified data sources and decisions: `PLAN.md`. Keep it updated when decisions change.

## Phase
Build phase: real data from `src/sessions/` (Claude files, git, `gh`), click flow in `src/actions/open.ts`. No mocks anymore.
Start here: `PLAN.md` → "Build phase" (Done / Next / Open decisions). Next step is manual testing in the Extension Development Host.

## Run
`pnpm install`, then F5 in VS Code (Extension Development Host); ⌘R in the dev host reloads after changes (`watch` task recompiles), ⇧⌘F5 for `package.json`/launch changes. `pnpm type-check` and `pnpm test` before committing.

## Tests
- `src/test/fixture.ts` builds a temp fake `~/.claude` + git repos (alpha with a worktree and a live session, beta, a non-git folder) and stub `gh`/`claude` scripts. Shared by both suites.
- `pnpm test:unit`: `node:test` on the `*.test.ts` next to the code in `src/sessions/` (transcripts, git, gh). No VS Code.
- `pnpm test:integration`: `src/test/extension.test.ts` via `@vscode/test-cli` (mocha, tdd) in a downloaded VS Code; `.vscode-test.mjs` creates the fixture, points `CLAUDE_CONFIG_DIR`/`TMPDIR`/`PATH`/user data at it and opens alpha. `activate` returns `{ tree }` only in test mode.
- Not covered: cross-window handoff/focus, modals (live-elsewhere warning, worktree prompt), the Claude tab. Test those manually with the packaged extension.
Cross-window flows (click → other window → resume) only work with the extension installed: windows opened from the dev host don't load the dev extension. `pnpm package && code --install-extension claude-multiproject-sessions-0.0.1.vsix --force`, then reload the windows. Logs: Output → "Claude Sessions" (per window, also under `~/Library/Application Support/Code/logs/*/window*/exthost/fallemand.claude-multiproject-sessions/`).

## Structure
- `src/extension.ts` entry point: activation, refresh (watcher + poll), badge, handoff on focus
- `src/view.ts` the tree: grouping, "N past" / "N more projects" / "Load N more" rows, filter, row layouts, tooltip
- `src/log.ts` Output channel "Claude Sessions"
- `src/sessions/` where the data comes from: `model.ts` (`Session`/`Repo`/`ClaudeSession` types, `isLive`, `needsWorktree`), `claude.ts` (session files, transcripts, watcher), `git.ts` (repo/worktree/branch/language, PRs via `gh`, attaches both to sessions)
- `src/actions/` what the user can do: `commands.ts` (toolbar and row actions), `open.ts` (click flow: reveal live sessions where they run, worktree prompt, live-elsewhere warning, window switch + handoff, resume in terminal/Claude tab), `windows.ts` (shared folder, window registry, process ancestors)
- `src/test/` integration test and the fixture both suites share
- `media/` logo (`logo.svg` source, `logo.png` via `scripts/render-svg.swift`), view icon `icon.svg`
