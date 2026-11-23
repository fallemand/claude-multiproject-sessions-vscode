import { basename } from "node:path";
import * as vscode from "vscode";
import { Entrypoint, isLive, needsWorktree, PrState, Repo, Session, SessionStatus } from "./sessions/model";

export type ViewState = {
  filter: "all" | "live";
  groupBy: "repo" | "status";
  layout: "compact" | "detailed" | "branchFirst";
};

type Icon = Pick<vscode.TreeItem, "iconPath" | "resourceUri">;
type Group = Icon & {
  kind: "group";
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  expanded: boolean;
  sessions: Session[];
};
// A grey "N past ▾" / "N more projects ▾" row; expanding it shows the hidden rows as siblings, not nested.
// Paged rows ("N older ▾") reveal one more page per click instead.
export type MoreToggle = { kind: "more"; key: string; label: string; what: string; paged?: boolean };
type Node = Group | MoreToggle | Session;

const defaultState: ViewState = { filter: "all", groupBy: "repo", layout: "compact" };
const repoScheme = "claude-repo";
const moreScheme = "claude-more";

const setting = <T>(key: string, fallback: T) =>
  vscode.workspace.getConfiguration("multirepoSessions").get<T>(key, fallback);

export const where: Record<Entrypoint, string> = { cli: "terminal", vscode: "VS Code", desktop: "desktop app" };

const statusLabel: Record<SessionStatus, string> = { busy: "Working", idle: "Waiting for you", ended: "Ended" };

const prIcon: Record<PrState, string> = {
  draft: "git-pull-request-draft",
  open: "git-pull-request",
  merged: "git-merge",
  closed: "git-pull-request-closed",
};

const join = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(" · ");

const ago = (date: Date) => {
  const minutes = Math.round((Date.now() - date.getTime()) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
};

const byRecent = (a: Session, b: Session) =>
  Number(isLive(b)) - Number(isLive(a)) || b.updatedAt.getTime() - a.updatedAt.getTime();

// Borrows the file icon theme's language icon through a fake `<repo>.<ext>` resource.
const repoIcon = (repo?: Repo): Icon =>
  repo?.language
    ? {
        iconPath: vscode.ThemeIcon.File,
        resourceUri: vscode.Uri.from({ scheme: repoScheme, path: `/${repo.name}.${repo.language}` }),
      }
    : { iconPath: new vscode.ThemeIcon(repo ? "repo" : "folder") };

// Sessions outside git group by the folder they run in.
const projectPath = (s: Session) => s.repo?.path ?? s.cwd;
const projectName = (s: Session) => s.repo?.name ?? basename(s.cwd);

// Only the current project (the one open in this window, worktrees included) is expanded.
const groupByRepo = (sessions: Session[], currentRepos: Set<string>): Group[] => {
  const byPath = new Map<string, Session[]>();
  for (const s of [...sessions].sort(byRecent)) {
    const path = projectPath(s);
    const list = byPath.get(path);
    if (list) list.push(s);
    else byPath.set(path, [s]);
  }
  return (
    [...byPath]
      .map(([path, list]): Group => {
        const live = list.filter(isLive).length;
        return {
          kind: "group",
          id: `repo:${path}`,
          label: projectName(list[0]),
          tooltip: list[0].repo ? undefined : path,
          description: live ? `${live} live` : undefined,
          expanded: currentRepos.has(path),
          ...repoIcon(list[0].repo),
          sessions: list,
        };
      })
      // Current project first.
      .sort((a, b) => Number(b.expanded) - Number(a.expanded) || byRecent(a.sessions[0], b.sessions[0]))
  );
};

const groupByStatus = (sessions: Session[]): Group[] =>
  (["busy", "idle", "ended"] as const)
    .map((status): Group => {
      const list = sessions.filter((s) => s.status === status).sort(byRecent);
      return {
        kind: "group",
        id: `status:${status}`,
        label: statusLabel[status],
        description: `${list.length}`,
        expanded: status !== "ended",
        sessions: list,
      };
    })
    .filter((g) => g.sessions.length);

const row = (s: Session, { layout, groupBy }: ViewState) => {
  const repo = groupBy === "status" && projectName(s);
  const branch = s.branch ?? "no git";
  const pr = s.pr && (s.pr.state === "open" ? `#${s.pr.number}` : `#${s.pr.number} ${s.pr.state}`);
  switch (layout) {
    case "compact":
      return { label: s.name, description: join(repo, ago(s.updatedAt)) };
    case "detailed":
      return {
        label: s.name,
        description: join(repo, pr, branch, s.worktree && "worktree", where[s.entrypoint], ago(s.updatedAt)),
      };
    case "branchFirst":
      return { label: branch, description: join(repo, s.name, ago(s.updatedAt)) };
  }
};

const tooltip = (s: Session) =>
  new vscode.MarkdownString(
    [
      `**${s.name}**`,
      `$(git-branch) ${join(s.branch ?? "no git", s.worktree && "worktree")}`,
      s.pr && `$(${prIcon[s.pr.state]}) [#${s.pr.number} ${s.pr.title}](${s.pr.url}) · ${s.pr.state}`,
      needsWorktree(s) && "$(warning) The main checkout is on another branch",
      `$(folder) ${s.cwd}`,
      `$(pulse) ${join(statusLabel[s.status], `in ${where[s.entrypoint]}`, `${ago(s.updatedAt)} ago`)}`,
      "---",
      `> ${s.lastMessage}`,
      "---",
      `\`${s.id}\``,
    ]
      .filter(Boolean)
      .join("\n\n"),
    true,
  );

const groupItem = ({ id, label, description, tooltip, expanded, iconPath, resourceUri }: Group) =>
  Object.assign(new vscode.TreeItem(label, vscode.TreeItemCollapsibleState[expanded ? "Expanded" : "Collapsed"]), {
    id,
    description,
    tooltip,
    iconPath,
    resourceUri,
  });

const moreItem = (toggle: MoreToggle, expanded: boolean) =>
  Object.assign(new vscode.TreeItem(toggle.label), {
    id: `more:${toggle.key}`,
    description: expanded ? "▴" : "▾",
    tooltip: `${expanded ? "Hide" : "Show"} ${toggle.what}`,
    // A resourceUri is the only way to color a label. Folder kind: themes without folder icons (Seti) draw none.
    resourceUri: vscode.Uri.from({ scheme: moreScheme, path: `/${encodeURIComponent(toggle.key)}` }),
    iconPath: vscode.ThemeIcon.Folder,
    command: { command: "multirepoSessions.toggleMore", title: "Show More", arguments: [toggle] },
  });

// What the rows show; minute resolution so relative times still age.
const signature = (sessions: Session[]) =>
  JSON.stringify([
    Math.floor(Date.now() / 60_000),
    sessions.map((s) => [
      s.id,
      s.name,
      s.status,
      Math.floor(s.updatedAt.getTime() / 60_000),
      s.worktree,
      s.pr?.state,
      s.repo?.currentBranch,
    ]),
  ]);

const sessionItem = (s: Session, state: ViewState) => {
  const { label, description } = row(s, state);
  return Object.assign(new vscode.TreeItem(label), {
    id: s.id,
    description,
    tooltip: tooltip(s),
    contextValue: ["session", needsWorktree(s) && "needsWorktree", s.pr && "hasPr"].filter(Boolean).join("."),
    command: { command: "multirepoSessions.open", title: "Open Session", arguments: [s] },
  });
};

export class SessionsView implements vscode.TreeDataProvider<Node>, vscode.FileDecorationProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly expandedMore = new Set<string>();
  private readonly pages = new Map<string, number>();
  private currentRepos = new Set<string>();
  private rendered = "";
  state: ViewState;

  constructor(
    private readonly memento: vscode.Memento,
    public sessions: Session[],
  ) {
    this.state = { ...defaultState, ...memento.get<Partial<ViewState>>("viewState") };
    this.syncContext();
  }

  setSessions(sessions: Session[]) {
    this.sessions = sessions;
    const next = signature(sessions);
    if (next === this.rendered) return;
    this.rendered = next;
    this.changed.fire();
  }

  setCurrentRepos(paths: Set<string>) {
    this.currentRepos = paths;
    this.changed.fire();
  }

  setState(patch: Partial<ViewState>) {
    this.state = { ...this.state, ...patch };
    void this.memento.update("viewState", this.state);
    this.syncContext();
    this.changed.fire();
  }

  toggleMore({ key, paged }: MoreToggle) {
    if (paged) this.pages.set(key, (this.pages.get(key) ?? 1) + 1);
    else if (!this.expandedMore.delete(key)) this.expandedMore.add(key);
    this.changed.fire();
  }

  rerender() {
    this.changed.fire();
  }

  getChildren(node?: Node): Node[] {
    if (!node) return this.roots();
    return "kind" in node && node.kind === "group" ? this.childrenOf(node) : [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (!("kind" in node)) return sessionItem(node, this.state);
    return node.kind === "group" ? groupItem(node) : moreItem(node, !node.paged && this.expandedMore.has(node.key));
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme === moreScheme) return { color: new vscode.ThemeColor("descriptionForeground") };
  }

  // The current project and projects with live sessions always show; the rest beyond `maxProjects` fold.
  private roots(): Node[] {
    const visible = this.state.filter === "live" ? this.sessions.filter(isLive) : this.sessions;
    if (this.state.groupBy === "status") return groupByStatus(visible);
    const groups = groupByRepo(visible, this.currentRepos);
    const max = setting("maxProjects", 5);
    const shown = groups.filter((g, i) => i < max || g.expanded || g.sessions.some(isLive));
    const hidden = groups.filter((g) => !shown.includes(g));
    return this.withMore("projects", `${hidden.length} more projects`, "older projects", shown, hidden);
  }

  // Past sessions fold only when there are live ones to show first, and page in batches. Status groups never mix both.
  private childrenOf(group: Group): Node[] {
    const live = group.sessions.filter(isLive);
    const past = group.sessions.filter((s) => !isLive(s));
    const pastRows = this.paged(`${group.id}:older`, past);
    if (!live.length) return pastRows;
    return this.withMore(group.id, `${past.length} past`, "past sessions", live, pastRows);
  }

  private paged(key: string, sessions: Session[]): Node[] {
    const limit = setting("maxPastSessions", 10) * (this.pages.get(key) ?? 1);
    if (sessions.length <= limit) return sessions;
    const step = Math.min(setting("maxPastSessions", 10), sessions.length - limit);
    const more: MoreToggle = { kind: "more", key, label: `Load ${step} more`, what: "older sessions", paged: true };
    return [...sessions.slice(0, limit), more];
  }

  private withMore(key: string, label: string, what: string, shown: Node[], hidden: Node[]): Node[] {
    if (!hidden.length) return shown;
    const toggle: MoreToggle = { kind: "more", key, label, what };
    return [...shown, toggle, ...(this.expandedMore.has(key) ? hidden : [])];
  }

  private syncContext() {
    for (const [key, value] of Object.entries(this.state))
      void vscode.commands.executeCommand("setContext", `multirepoSessions.${key}`, value);
  }
}
