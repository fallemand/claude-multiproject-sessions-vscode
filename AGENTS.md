# Multi-Repo Sessions for Claude Code (VS Code extension)

Sidebar listing Claude Code sessions grouped by repo; clicking one opens its worktree/branch and resumes the session.

UI principle: the default view stays minimal (repo icon, then name + time); everything else lives in the tooltip, context menu or the "Detailed" layout.

## Run

`pnpm install`, then F5 in VS Code (Extension Development Host); ⌘R in the dev host reloads after changes (`watch` task rebundles), ⇧⌘F5 for `package.json`/launch changes. `pnpm check` (format, lint, types) and `pnpm test` before committing.
Tooling is Vite+ (`vite.config.ts`): `vp pack` bundles `src/extension.ts` into `dist/extension.js` (the only code in the `.vsix`), `vp check` runs Oxfmt + Oxlint + type-check, `vp test` runs Vitest.

## PRs and releases

PR titles are Conventional Commits without a ticket (`feat: Group sessions by status`); the squash merge uses them. `feat:` → minor, `fix:` → patch, other types don't release. Release Please keeps a release PR with the next version and CHANGELOG (don't edit those by hand); merging it publishes to Open VSX, and to the VS Marketplace once a `VSCE_PAT` secret exists.

## Tests

- `src/test/fixture.ts` builds a temp fake `~/.claude` + git repos (alpha with a worktree and a live session, beta, a non-git folder) and stub `gh`/`claude` scripts. Shared by both suites.
- `vp test`: Vitest on the `*.test.ts` next to the code in `src/sessions/` (transcripts, git, gh). No VS Code, no build.
- `pnpm test:integration`: `src/test/extension.test.ts` via `@vscode/test-cli` (mocha, tdd) in a downloaded VS Code, against the bundled extension (test files compiled with `tsc` to `out/`); `.vscode-test.mjs` creates the fixture, points `CLAUDE_CONFIG_DIR`/`TMPDIR`/`PATH`/user data at it and opens alpha. `activate` returns `{ tree }` only in test mode.
- Not covered: cross-window handoff/focus, modals (live-elsewhere warning, worktree prompt), the Claude tab. Test those manually with the packaged extension.

Cross-window flows (click → other window → resume) only work with the extension installed: windows opened from the dev host don't load the dev extension. `pnpm package && code --install-extension claude-multirepo-sessions-*.vsix --force`, then reload the windows. Logs: Output → "Multi-Repo Sessions" (per window, also under `~/Library/Application Support/Code/logs/*/window*/exthost/fallemand.claude-multirepo-sessions/`).

## Structure

- `src/extension.ts` entry point: activation, refresh (watcher + poll), badge, handoff on focus
- `src/view.ts` the tree: grouping, "N past" / "N more projects" / "Load N more" rows, filter, row layouts, tooltip
- `src/log.ts` Output channel "Multi-Repo Sessions"
- `src/sessions/` where the data comes from: `model.ts` (`Session`/`Repo`/`ClaudeSession` types, `isLive`, `needsWorktree`), `claude.ts` (session files, transcripts, watcher), `git.ts` (repo/worktree/branch/language, PRs via `gh`, attaches both to sessions)
- `src/actions/` what the user can do: `commands.ts` (toolbar and row actions), `open.ts` (click flow: reveal live sessions where they run, worktree prompt, live-elsewhere warning, window switch + handoff, resume in terminal/Claude tab), `windows.ts` (shared folder, window registry, process ancestors)
- `src/test/` integration test and the fixture both suites share
- `media/` logo (`logo.svg` source, `logo.png` 256px for the Marketplace), view icon `icon.svg`

## Claude Code data (private formats, verified against 2.1.3xx)

Not public APIs: keep all parsing in `src/sessions/claude.ts` so format changes stay contained. `CLAUDE_CONFIG_DIR` overrides `~/.claude`.

- Live sessions: `~/.claude/sessions/<pid>.json` (`pid`, `sessionId`, `cwd`, `name`, `nameSource`, `status` busy/idle, `entrypoint`, `updatedAt`). Ended once the pid stops running.
- Transcripts: `~/.claude/projects/<cwd with non-alphanumerics as ->/<sessionId>.jsonl`. Lines carry `cwd`, `gitBranch`, `timestamp`; title order: live `name` (unless `nameSource: "derived"`), `custom-title`, last `ai-title`, `agent-name`, first typed prompt. `relocated` lines change the cwd. Excluded: SDK-only runs, no typed prompt, subagent transcripts.
- Only the first 16 KB and last 64 KB of a transcript are read, each growing ×8 (max 8 MB) while empty; cached by mtime + size.
- Claude tab: `claude-vscode.primaryEditor.open(sessionId)`; fallback `claude --resume <id>` in a terminal.
