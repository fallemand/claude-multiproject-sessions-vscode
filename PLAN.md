# Plan

Problem: the Claude Code extension only shows the current project's sessions. With parallel sessions across projects you juggle many windows and terminals, and each session works on its own branch/worktree, so reviewing its changes in VS Code means going to a terminal, checking out the worktree and opening another window.

Name: "Multi-Project Sessions for Claude Code" (the "for Claude Code" pattern keeps it findable without reading as an official Anthropic product). Explorer section title stays "Claude Sessions"; extension id `fallemand.claude-multiproject-sessions`, repo `fallemand/claude-multiproject-sessions-vscode` (suffix only on GitHub, where it says what the repo is). Logo: three lines (projects/worktrees) converging into one target on a terracotta tile in Claude colours (`#E08A6B`→`#C15F3C`, cream `#F0EEE6`); no Anthropic spark. `media/logo.svg` is the source, `logo.png` (256px, transparent corners) is rendered with AppKit since Quick Look fills corners white: `swift scripts/render-svg.swift media/logo.svg media/logo.png 256`. `media/icon.svg` is the single-colour 24px version.

Goal: a sidebar listing Claude Code sessions grouped by project. Clicking a session opens the folder/worktree it ran in (on its branch) and resumes the session live in the editor. Claude only for now; other model CLIs later behind a `SessionSource` interface.

## Approach
1. **UI phase (current)**: real extension with mock data, iterate on the UI until it's settled.
2. **Build phase**: replace the mock with real sources and the open flow.

Decided: native `TreeView` (not a webview) unless we hit something it can't show. Plain `tsc`, no bundler; add Vite+/tsdown + Vitest only when packaging a `.vsix` with runtime deps.

## Data sources (verified locally, Nov 2026, Claude Code 2.1.3xx)
None of these are public APIs; keep all parsing in `src/sources/` so format changes stay contained.

- **Live sessions**: `~/.claude/sessions/<pid>.json`
  - `pid`, `sessionId`, `cwd`, `name`, `status` (`busy` | `idle`), `entrypoint` (e.g. `claude-desktop`), `kind`, `startedAt`, `updatedAt`, `version`
  - Session is ended when the pid is no longer running.
- **History**: `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`
  - `<encoded-cwd>` = cwd with every non-alphanumeric char replaced by `-`
  - Lines carry `cwd`, `gitBranch`, `sessionId`, `timestamp`, `version`, `type` (`user`, `file-history-snapshot`, ...)
  - Title, in order: live `name` (unless `nameSource: "derived"`, a `<folder>-<n>` placeholder), jsonl `custom-title`, last `ai-title`, `agent-name`, first typed prompt.
  - Entrypoints seen: `cli`, `claude-vscode`, `claude-desktop`, `sdk-cli`, `sdk-ts`. `relocated` lines (desktop app) change the cwd; `gitBranch: HEAD` is ignored. `pr-link` lines (`prNumber`, `prUrl`) exist and could replace `gh` for PR numbers.
  - Excluded: SDK-only runs, sessions without a typed prompt, subagent transcripts (`<id>/subagents/`).
  - Never parsed whole: only the first 16 KB (first prompt, start cwd) and last 64 KB (latest cwd, branch, time, title, reply), each growing ×8 (max 8 MB) only while it holds nothing useful (a huge pasted prompt, a tail of tool calls). Cached by path + mtime + size; appends re-read only the tail. Real data (833 files, 1.6 GB, largest 97 MB): ~100 ms / ~80 MB cold vs ~600 ms / ~320 MB for a full parse, identical output on all 803 sessions; ~6 ms warm. No message count (it needs the whole file).
- **Open VS Code windows**: `~/.claude/ide/<port>.lock` → `workspaceFolders`, `ideName`, `pid`. Use it to focus a window that already has the folder.
- **Pull requests**: one `gh pr list --state all --author @me --json number,title,state,isDraft,url,headRefName` per repo, matched to sessions by branch, cached a few minutes. No `gh` or not authenticated → no PR info.
- **Repo language** (for the group icon): first marker in the repo root wins: `tsconfig.json` → ts, `package.json` → js, `pyproject.toml`/`requirements.txt` → py, `go.mod` → go, `Cargo.toml` → rs, `build.gradle*`/`pom.xml` → java; else none.
- **Current branch of the main checkout** (`Repo.currentBranch`, drives "needs worktree"): `git -C <repo> branch --show-current`.
- **Repo grouping**: `git rev-parse --git-common-dir` so worktrees group under their main repo. Non-git folders (e.g. `~/Downloads`) go to "Non-git folders".

## Opening a session in the Claude Code extension (`anthropic.claude-code`)
- URI: `vscode://anthropic.claude-code/open?session=<id>&prompt=<optional>` → runs `claude-vscode.primaryEditor.open(sessionId, prompt)`
- Command: `claude-vscode.editor.open(sessionId, initialPrompt?, viewColumn?)` opens the session in a Claude tab.
- Fallback: `claude --resume <id>` in an integrated terminal at the session's cwd.

## Click flow (build phase)
0. Session live inside VS Code: find where. Its process ancestors (`ps -A -o pid=,ppid=`, up to 10 levels so wrappers like npx don't hide the shell) are matched against the window registry: a terminal's shell pid → focus that window and show that terminal; the window's extension host pid → it's a Claude tab, reveal it there. No second copy is started. Not found (tmux, another app like Superset or the desktop app, Windows, remote): continue with the "live elsewhere" warning (step 6).
1. Target folder = session `cwd` (already the worktree path when it ran in one).
2. If `cwd` is the main checkout and `gitBranch` ≠ current branch (and the branch still exists): never auto-checkout. Offer "Create worktree for `<branch>`", or checkout only if the tree is clean.
3. Resume target from `claudeSessions.openIn` (default `terminal`): `claude --resume <id>` in a terminal at the folder, or a Claude tab (falls back to the terminal when the Claude Code extension is missing).
4. Folder open in this window → resume here. Open in another window (registry; for a terminal also a window whose folder contains it) → focus that window (its `.code-workspace` file for multi-root) and hand off to it by pid. Otherwise open a new window and hand off by folder.
5. Handoff: `handoff.json` in the shared folder (see below), consumed on activation or focus by the window it targets (by pid, else by folder), within 2 min.
6. Session live in another process that isn't a VS Code window we know: warn first, resuming it in parallel means two writers. Offer "just open the folder".

**Shared folder**: `$TMPDIR/claude-multiproject-sessions-<uid>/` holds `handoff.json` and `windows/<extension host pid>.json` (`{ pid, app, folders, workspaceFile, terminals: shell pids }`, rewritten on terminal/folder changes, removed on deactivate, dead pids pruned on read). Not the extension's global storage: that is per profile, so windows on different profiles wouldn't see each other. Only windows of the same app are used (Cursor can't focus a VS Code window).

**Window reload**: changing the root folder of the same window reloads it (extension host restarts, integrated terminals die, including a Claude TUI running there). Default: focus existing window or open a new one; "reuse window" as an opt-in setting. v2 idea: multi-root workspace with a fixed folder 0 and only swap folder 1 (VS Code restarts only when folder 0 changes) for switching without reload.

## UI phase: what exists
Principle: the default view stays minimal (repo icon, then name + time); everything else lives in the tooltip, context menu or the "Detailed" layout.

- Lives in the Explorer (next to Open Editors, Outline, Timeline), not its own activity bar container: no extra icon, visible while browsing files. Users can drag it elsewhere; the spark icon is the view icon then. The view badge shows on the Explorer icon.
- Tree Repo → Session (or grouped by status: Working / Waiting for you / Ended). Live first, then most recent. Only the current project (the one open in this window) is expanded and listed first; all others are collapsed, showing "N live" when they have live sessions. Build phase: "current" = same `git --git-common-dir` as a workspace folder, so worktrees count. The dev host opens this repo (`.vscode/launch.json`), so it is the current project there.
- Max 2 levels (repo → session). A repo with live sessions shows a grey `N past ▾` toggle row after them (`▴` when open; reads as a count, lighter than a `Past` heading; font size can't be changed by extensions); clicking it shows/hides the past sessions as siblings at the same level, not nested. Same toggle at the root: projects beyond `claudeSessions.maxProjects` (default 5) fold into `N more projects ▾`; the current project and projects with live sessions are never folded. Past session lists (inside `N past`, past-only repos, the Ended status group) show `claudeSessions.maxPastSessions` (default 10), then a paged `Load N more` row that reveals one more batch per click. Toggle state is in-memory. A repo with only past sessions lists them directly. Indent width itself is the user's `workbench.tree.indent` setting (global, not per view). The toggle label is grey via a `FileDecorationProvider` color on a `claude-more:` `resourceUri` + `ThemeIcon.Folder`: themes without folder icons (Seti) draw no icon, so no gap; themes with folder icons (e.g. Material) would show a folder. An empty label + description is offset by the description margin, so not that.
- Icons only on repo rows: the user's file icon theme icon for the repo language (fake `claude-repo:/<name>.<ext>` resource + `ThemeIcon.File`), fallback `$(repo)`; non-git = `$(folder-library)`. No icons on session, Past or status-group rows. Tried and dropped there: status dots (left, then right badge, then emoji), PR state icons/emoji. Reasons: too noisy, an icon column indents rows, badges/labels/descriptions can't render codicons, decoration colors tint the whole label. View icon: `media/icon.svg` (converging lines).
- Row: name + time. Status, PR (state + linked title), branch, worktree, cwd, last message live in the tooltip; the Detailed layout adds PR number, branch, worktree and where it runs. Layouts via `… → Row Layout…`: compact (default), detailed, branch first.
- No decorations either (dropped `W`/`!` badges, label colors and dimming). The tooltip also carries the "main checkout is on another branch" warning.
- View badge = sessions waiting for you; view description = "N live".
- Toolbar: live-only filter, group by repo/status, refresh. `… → Toggle Simulated Activity` flips live statuses every 3s.
- Setting `claudeSessions.openIn`: `terminal` (default for now, `claude --resume` in an integrated terminal) or `editor` (Claude Code tab) decides where a click resumes.
- Row actions: only "Open in New Window" inline (on hover). Context menu: open, open in new window, resume in the other place than the setting (terminal or Claude tab), open PR, create worktree (when the checkout is on another branch), copy ID (real), reveal transcript. All except copy ID show a `Mock:` notification.
- Mocks: ~30 sessions across 7 repos, most of them past, a few live, some with PRs/worktrees.
- View state (filter, groupBy, layout) persisted in `globalState`, exposed as `claudeSessions.*` context keys for `when` clauses.

## Build phase
UI settled (see above). All code is in place and type-checks; it has not been exercised end to end in VS Code yet. Public repo: https://github.com/fallemand/claude-multiproject-sessions-vscode (MIT).

### Done
1. `src/sources/claude.ts`: live + history sessions from `~/.claude` (head/tail reads, see "Data sources"), throttled watcher.
2. `src/sources/git.ts` (repo, worktree, current branch + existing branches, language) and `src/sources/github.ts` (PRs via `gh`, 5 min cache).
3. `src/open.ts`: click flow (worktree prompt, live-elsewhere warning, focus/open window, file handoff, resume in Claude tab or terminal). Steps are logged to Output → "Claude Sessions".
4. Integration in `src/sources/index.ts` + `src/extension.ts`: PRs in a second pass (~3 s cold); refresh on watcher events (≤ 1/s) + every 30 s (dead pids leave no file event); one refresh at a time; render skipped when nothing visible changed; hidden views do no work and refresh when shown; `onStartupFinished` activation so handoffs work in any window. Mocks removed.
5. Independent review, all fixes applied: deleted sibling worktrees resolve their repo from `startCwd`; "needs worktree" only when the branch still exists (593 → 64 sessions); stale worktrees pruned before reuse; current project resolved through git so worktree windows count; failed repo lookups retried after 60 s; checkout offered with untracked files.
6. Limits: `claudeSessions.maxProjects` (5) folds older projects into `N more projects ▾`; `claudeSessions.maxPastSessions` (10) pages past sessions with `Load N more`.
7. Branding: name, ids, logo, view icon, README (badges, Options, image slots), CI workflow (`.github/workflows/ci.yml`, `pnpm type-check`), `packageManager` pinned.

### Next (manual testing with F5, then ⌘R in the dev host after each change)
- Is the current project expanded on start? Last screenshot showed `claude-sessions-vscode` first but collapsed (maybe a remembered collapse, maybe detection; the folder has since been renamed to `claude-multiproject-sessions-vscode`).
- Window registry + live reveal: clicking a session live in a VS Code terminal of another window focuses that window and shows the terminal; in this window, shows it. Verified process chains: VS Code terminal `claude → zsh → Code Helper → Code`; Superset `claude → zsh → Superset` (not found → warning). Claude tabs assumed to be children of the extension host: verify with a live Claude tab session.
- Handoff to an already-open window (focus on macOS) and to a newly opened one. First test: clicking a compass session opened its worktree but did not resume. The log showed why: windows opened from the Extension Development Host are normal windows without the dev extension, so no one consumed the handoff. Cross-window flows can only be tested with the extension installed (`pnpm package`, `code --install-extension <vsix> --force`). Also switched the handoff from globalState to a file.
- Resuming when `cwd` ≠ `startCwd` (82 sessions) or from a new worktree/repo root. Evidence so far (Claude Code 2.1.3xx): the session that built this was resumed after renaming the repo folder, with its transcript still under the old project dir, so resume by id works across folders. Still confirm via the Claude tab (`claude-vscode.primaryEditor.open`).
- `claudeSessions.openIn = terminal`: `claude --resume` starts in the right folder.
- `git`/`gh` on PATH when VS Code starts from the Dock.
- README media: `media/demo.gif` done (from a 39 s screen recording: `ffmpeg` at 1.5× speed, 10 fps, 960 px, 128-colour palette → 2.4 MB). It shows work session names (GYG repos, a Slack channel id); re-record with neutral projects before the repo goes public. Relative README images are served from GitHub by vsce, so the GIF stays out of the `.vsix`.

### Open decisions
- Repo topics (`claude-code`, `claude`, `vscode-extension`, `git-worktree`, `ai-agents`): adding them hit a GitHub API 403 on 2026-11-22; retry with `gh repo edit fallemand/claude-multiproject-sessions-vscode --add-topic ...`.
- Publishing to the Marketplace (publisher `fallemand` needs an Azure DevOps PAT for `vsce publish`) and Open VSX (`ovsx publish`).

### Known limits
- A crashed Claude process whose pid gets reused shows its session as live (live json has `procStart`, but its format/timezone differs from `ps -o lstart`).
- Deleted worktrees a session started in, with no other trace of the repo, land in "Non-git folders".
- Custom titles set in the middle of a long session can be missed (only the first 16 KB and last 64 KB are read); none were missed on current data.

### Later
Filters (last N days, hide non-git), packaging as `.vsix`, publishing (Marketplace + Open VSX).
