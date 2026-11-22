# Multi-Project Sessions for Claude Code (VS Code extension)

Sidebar listing Claude Code sessions grouped by repo; clicking one opens its worktree/branch and resumes the session.

Full plan, verified data sources and decisions: `PLAN.md`. Keep it updated when decisions change.

## Phase
Build phase: real data from `src/sources/` (Claude files, git, `gh`), click flow in `src/open.ts`. No mocks anymore.
Start here: `PLAN.md` → "Build phase" (Done / Next / Open decisions). Next step is manual testing in the Extension Development Host.

## Run
`pnpm install`, then F5 in VS Code (Extension Development Host); ⌘R in the dev host reloads after changes (`watch` task recompiles), ⇧⌘F5 for `package.json`/launch changes. `pnpm type-check` before committing.
Cross-window flows (click → other window → resume) only work with the extension installed: windows opened from the dev host don't load the dev extension. `pnpm package && code --install-extension claude-multiproject-sessions-0.0.1.vsix --force`, then reload the windows. Logs: Output → "Claude Sessions" (per window, also under `~/Library/Application Support/Code/logs/*/window*/exthost/fallemand.claude-multiproject-sessions/`).

## Structure
- `src/extension.ts` activation, refresh (watcher + poll), badge, handoff on focus
- `src/sources/` `claude.ts` (session files), `git.ts` (repo/worktree/branch/language), `github.ts` (PRs), `index.ts` (combines)
- `src/open.ts` click flow: reveal live sessions where they run, worktree prompt, live-elsewhere warning, window switch + handoff, resume in terminal/Claude tab
- `src/windows.ts` shared folder, window registry (folders + terminal shell pids per window), process ancestors
- `src/log.ts` Output channel "Claude Sessions"
- `src/tree.ts` grouping, "N past" / "N more projects" / "Load N more" rows, filter, row layouts, tooltip
- `src/commands.ts` toolbar and row actions
- `src/model.ts` `Session`/`Repo`/`ClaudeSession` types, `isLive`, `needsWorktree`
- `media/` logo (`logo.svg` source, `logo.png` via `scripts/render-svg.swift`), view icon `icon.svg`
