import { Pr, PrState } from "../model";
import { run } from "./git";

type GhPr = { number: number; title: string; state: "OPEN" | "MERGED" | "CLOSED"; isDraft: boolean; url: string; headRefName: string };

const ttl = 5 * 60_000;
const fields = "number,title,state,isDraft,url,headRefName";

const toState = ({ state, isDraft }: GhPr): PrState =>
  state === "OPEN" ? (isDraft ? "draft" : "open") : state === "MERGED" ? "merged" : "closed";

const isOpen = (pr: Pr) => pr.state === "open" || pr.state === "draft";

// Several PRs on one branch: open/draft wins, else the most recent.
const better = (a: Pr, b: Pr) => (isOpen(a) !== isOpen(b) ? isOpen(a) : a.number > b.number);

const parse = (out?: string) => {
  const prs = new Map<string, Pr>();
  try {
    for (const gh of JSON.parse(out ?? "[]") as GhPr[]) {
      const pr: Pr = { number: gh.number, title: gh.title, state: toState(gh), url: gh.url };
      const current = prs.get(gh.headRefName);
      if (!current || better(pr, current)) prs.set(gh.headRefName, pr);
    }
  } catch {}
  return prs;
};

const cache = new Map<string, { at: number; prs: Promise<Map<string, Pr>> }>();

// Failures (no gh, not authenticated, no GitHub remote) yield an empty map, cached like a success.
export const loadPrs = (repoPath: string): Promise<Map<string, Pr>> => {
  const hit = cache.get(repoPath);
  if (hit && Date.now() - hit.at < ttl) return hit.prs;
  const prs = run("gh", ["pr", "list", "--state", "all", "--author", "@me", "--json", fields, "--limit", "100"], repoPath, 20_000).then(parse);
  cache.set(repoPath, { at: Date.now(), prs });
  return prs;
};
