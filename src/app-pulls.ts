/**
 * The open pull requests of the repositories ClearOps manages, shown in the web app and merged on
 * Paul's own tap (docs/APP.md).
 *
 * Paul asked to review and merge from the app instead of leaving for GitHub. This is the one place
 * the service itself merges anything. It is not an agent and no model is involved: the app shows him
 * a pull request as GitHub holds it, and his own tap on Merge is carried here with the exact commit
 * he was looking at.
 *
 * It works from the repositories, not from jobs. The first version went through a job's `pr`, which
 * is the address a worker typed in its report: workers mistype it (`dpaulfarrow` for `drpaulfarrow`,
 * 19 Nov 2026) or name another pull request first, so Paul could not find the two that were open.
 * The list here is GitHub's own.
 *
 * What keeps it narrow:
 *  - Only a repository ClearOps manages, named by its alias and matched exactly, and a pull request
 *    named by its number. No address, owner or repository name is ever taken from a request.
 *  - A job is tied to a pull request only inside the repository the job itself works on. When the
 *    address in its report names that repository under another owner, the owner is taken to be a
 *    slip and the app says so; any other repository is left alone.
 *  - A merge names the head commit Paul was shown. If the pull request has moved on, the service
 *    refuses, and GitHub is given the same commit so it refuses too.
 *  - Nothing is merged that is closed, a draft, in conflict, or has a check that failed or is still
 *    running. Branch protection on GitHub stays the backstop and its refusals are passed on as said.
 *  - It only ever merges (a merge commit, as Paul's own merges are). It never pushes, rebases,
 *    force-pushes, closes, approves, comments or deletes a branch.
 *  - Everything read from GitHub is another party's text. It is cut to size, has secrets redacted, and
 *    is sent to the app as plain text, never as HTML.
 *  - The credential is the one the service already holds for that repository. It goes in a header to
 *    api.github.com and nowhere else.
 *  - The list never holds up a page: it answers from what it last read and reads again in the
 *    background, at most once a minute for each repository.
 */
import { shortText } from "./messages.js";
import { redact } from "./repos.js";
import type { Job } from "./store.js";

const PR_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/;
const SHA = /^[0-9a-f]{40}$/;
const TIMEOUT_MS = 12_000;
/** How many changed files are shown; GitHub's own page has the rest. */
export const PULL_FILES_MAX = 100;
/** The most of one file's changes, and of all of them together, sent to the app. */
export const PULL_PATCH_MAX = 20_000;
export const PULL_PATCHES_MAX = 300_000;
/** How many open pull requests of one repository are listed. */
export const PULL_LIST_MAX = 30;
/** How long a repository's list is good for before it is read again. */
export const PULL_LIST_FRESH_MS = 60_000;
const BODY_MAX = 6_000;

/** A repository ClearOps manages, as this module needs it. */
export interface PullRepo {
  /** The alias jobs and the app name it by ("self", "product", ...). */
  alias: string;
  /** "owner/name" on GitHub. */
  slug: string;
  /** What Paul calls it. */
  name: string;
}

/** The pull request a job is tied to, inside the repository the job works on. */
export interface JobPull {
  repo: string;
  number: number;
  url: string;
  /** The repository as the worker wrote it, when its owner was not the real one. */
  wrote?: string;
}

/** One open pull request in the list. */
export interface PullSummary {
  repo: string;
  repository: string;
  number: number;
  title: string;
  author: string;
  branch: string;
  draft: boolean;
  openedAt: string;
}

export interface PullCheck {
  name: string;
  state: "passed" | "failed" | "running" | "skipped";
}

export interface PullFile {
  name: string;
  /** added, modified, removed or renamed, as GitHub says. */
  status: string;
  additions: number;
  deletions: number;
  /** The changes as a unified diff. Absent for a binary file, or one left out for size. */
  patch?: string;
  /** True when the changes shown are not all of them. */
  cut?: boolean;
}

export interface PullView {
  url: string;
  repo: string;
  repository: string;
  number: number;
  title: string;
  author: string;
  body?: string;
  state: "open" | "merged" | "closed";
  draft: boolean;
  /** The head commit this view shows. A merge must name it. */
  head: string;
  branch: string;
  base: string;
  commits: number;
  additions: number;
  deletions: number;
  changedFiles: number;
  checks: PullCheck[];
  files: PullFile[];
  /** Why it cannot be merged from here right now. Absent when it can. */
  blocked?: string;
  /** It is open and its branch conflicts with the base, so someone has to resolve that before it can merge. */
  conflicts: boolean;
  /** True when merging it redeploys this service. */
  redeploys: boolean;
}

/** A refusal with words for Paul and the status the route answers with. */
export class PullError extends Error {
  constructor(message: string, readonly status = 409) {
    super(message);
  }
}

export interface AppPullsOptions {
  /** The repositories ClearOps manages that are on GitHub. */
  repos: () => PullRepo[];
  /** The alias of the repository a job works on. */
  repoOf: (job: Job) => string | undefined;
  /** The credential the service holds for a managed repository, or undefined when it has none. */
  token: (repo: PullRepo) => Promise<string | undefined> | string | undefined;
  /** The alias of the repository this service is deployed from, so the app can say a merge redeploys it. */
  selfAlias?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

interface Target {
  repo: PullRepo;
  owner: string;
  name: string;
  number: number;
  url: string;
}

interface RawPull {
  state?: unknown;
  merged?: unknown;
  draft?: unknown;
  mergeable?: unknown;
  title?: unknown;
  body?: unknown;
  number?: unknown;
  commits?: unknown;
  additions?: unknown;
  deletions?: unknown;
  changed_files?: unknown;
  created_at?: unknown;
  user?: { login?: unknown };
  head?: { sha?: unknown; ref?: unknown };
  base?: { ref?: unknown };
}

const text = (v: unknown, max: number): string => (typeof v === "string" ? shortText(redact(v), max) : "");
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const SLUG = /^([\w.-]+)\/([\w.-]+)$/;
const dots = (s: string) => /^\.+$/.test(s);

export class AppPulls {
  private readonly o: AppPullsOptions;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  /** Pull requests with a merge in flight, so two taps are one merge. */
  private merging = new Set<string>();
  /** Each repository's open pull requests as last read, by alias. */
  private lists = new Map<string, { at: number; pulls?: PullSummary[]; failed?: boolean }>();
  private reading = new Set<string>();

  constructor(o: AppPullsOptions) {
    this.o = o;
    this.fetch = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
  }

  /**
   * The pull request a job is tied to, or undefined. No network: it reads the address in the job's
   * `pr` and keeps it only inside the repository the job works on, whatever owner the worker wrote.
   */
  forJob(job: Job): JobPull | undefined {
    const m = job.pr ? PR_URL.exec(job.pr) : null;
    if (!m) return undefined;
    const [, owner, name, number] = m;
    const alias = this.o.repoOf(job);
    const repo = alias ? this.managed(alias) : undefined;
    const real = repo ? SLUG.exec(repo.slug) : null;
    if (!repo || !real || real[2]!.toLowerCase() !== name!.toLowerCase()) return undefined;
    const n = Number(number);
    if (!Number.isSafeInteger(n) || n < 1) return undefined;
    const sameOwner = real[1]!.toLowerCase() === owner!.toLowerCase();
    return { repo: repo.alias, number: n, url: `https://github.com/${repo.slug}/pull/${n}`, ...(sameOwner ? {} : { wrote: `${owner}/${name}` }) };
  }

  /**
   * Every open pull request in the managed repositories, newest first, as last read. Never waits:
   * a repository not read in the last minute is read again in the background. `unread` names the
   * repositories GitHub would not show, so an empty list is never mistaken for "none open".
   */
  open(): { pulls: PullSummary[]; unread: string[]; loading: boolean } {
    const pulls: PullSummary[] = [];
    const unread: string[] = [];
    let loading = false;
    for (const repo of this.o.repos()) {
      if (!this.managed(repo.alias)) continue;
      const seen = this.lists.get(repo.alias);
      if ((!seen || this.now() - seen.at > PULL_LIST_FRESH_MS) && !this.reading.has(repo.alias)) {
        this.reading.add(repo.alias);
        void this.list(repo)
          .then((got) => void this.lists.set(repo.alias, { at: this.now(), pulls: got }))
          // A failed read keeps the last list and is marked, and is tried again after the same minute.
          .catch(() => void this.lists.set(repo.alias, { at: this.now(), pulls: this.lists.get(repo.alias)?.pulls, failed: true }))
          .then(() => void this.reading.delete(repo.alias));
      }
      if (!seen) loading = true;
      else if (seen.failed) unread.push(repo.name);
      if (seen?.pulls) pulls.push(...seen.pulls);
    }
    return { pulls: pulls.sort((a, b) => b.openedAt.localeCompare(a.openedAt)), unread, loading };
  }

  /** Resolves once no list is being read. For the tests. */
  async settled(): Promise<void> {
    while (this.reading.size) await new Promise((r) => setTimeout(r, 5));
  }

  /** The pull request as GitHub holds it now, with its checks and its changes. */
  async view(alias: unknown, number: unknown): Promise<PullView> {
    return this.load(this.target(alias, number), true);
  }

  /** Merges the pull request Paul was shown, if it is still that commit and nothing blocks it. */
  async merge(alias: unknown, number: unknown, sha: unknown): Promise<{ text: string; url: string }> {
    if (typeof sha !== "string" || !SHA.test(sha)) throw new PullError("refused", 400);
    const t = this.target(alias, number);
    if (this.merging.has(t.url)) throw new PullError("It is already being merged.");
    this.merging.add(t.url);
    try {
      const now = await this.load(t, false);
      if (now.blocked) throw new PullError(`Not merged. ${now.blocked}`);
      if (now.head !== sha) throw new PullError("Not merged. New commits were pushed since you looked. Look at it again first.");
      const res = await this.github(t, `/pulls/${t.number}/merge`, { method: "PUT", body: JSON.stringify({ sha, merge_method: "merge" }) });
      if (!res.ok) throw new PullError(`Not merged. GitHub refused: ${await this.said(res)}`);
      const merged = ((await res.json().catch(() => ({}))) as { merged?: unknown }).merged === true;
      if (!merged) throw new PullError("GitHub did not confirm the merge. Look at it again.");
      // The list is read again at the next look, so the merged one leaves it.
      this.lists.delete(t.repo.alias);
      return { text: `Merged pull request #${t.number} on ${t.repo.name} from the app: ${now.title}.${now.redeploys ? " The service redeploys once no job is running." : ""}`, url: t.url };
    } finally {
      this.merging.delete(t.url);
    }
  }

  /** A managed repository by its exact alias. Nothing else names one. */
  private managed(alias: string): PullRepo | undefined {
    const repo = this.o.repos().find((r) => r.alias === alias);
    const m = repo ? SLUG.exec(repo.slug) : null;
    return repo && m && !dots(m[1]!) && !dots(m[2]!) ? repo : undefined;
  }

  /** A pull request by a managed repository's alias and its own number, and by nothing else. */
  private target(alias: unknown, number: unknown): Target {
    const n = typeof number === "number" ? number : typeof number === "string" && /^[1-9]\d{0,8}$/.test(number) ? Number(number) : NaN;
    const repo = typeof alias === "string" ? this.managed(alias) : undefined;
    if (!repo || !Number.isSafeInteger(n) || n < 1) throw new PullError("There is no such pull request in a repository ClearOps manages.", 404);
    const [, owner, name] = SLUG.exec(repo.slug)!;
    return { repo, owner: owner!, name: name!, number: n, url: `https://github.com/${repo.slug}/pull/${n}` };
  }

  private async github(t: { repo: PullRepo; owner: string; name: string }, path: string, init: { method?: string; body?: string } = {}): Promise<Response> {
    const token = await this.o.token(t.repo);
    if (!token) throw new PullError("The service holds no GitHub credential for that repository.", 503);
    try {
      return await this.fetch(`https://api.github.com/repos/${t.owner}/${t.name}${path}`, {
        method: init.method ?? "GET",
        headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "clear-ops", ...(init.body ? { "content-type": "application/json" } : {}) },
        ...(init.body ? { body: init.body } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new PullError("GitHub could not be reached just now.", 502);
    }
  }

  /** GitHub's own words for a refusal, cut short, with nothing secret in them. */
  private async said(res: Response): Promise<string> {
    const body = (await res.json().catch(() => ({}))) as { message?: unknown };
    const message = typeof body.message === "string" && body.message.trim() ? body.message.trim() : `status ${res.status}`;
    return shortText(redact(message), 200).replace(/[.\s]*$/, ".");
  }

  private async read<T>(t: { repo: PullRepo; owner: string; name: string }, path: string): Promise<T> {
    const res = await this.github(t, path);
    if (res.status === 404) throw new PullError("GitHub cannot find that pull request with the service's credential.", 404);
    if (!res.ok) throw new PullError(`GitHub would not show it: ${await this.said(res)}`, 502);
    return (await res.json()) as T;
  }

  /** One repository's open pull requests, newest first. */
  private async list(repo: PullRepo): Promise<PullSummary[]> {
    const [, owner, name] = SLUG.exec(repo.slug)!;
    const raw = await this.read<RawPull[]>({ repo, owner: owner!, name: name! }, `/pulls?state=open&sort=created&direction=desc&per_page=${PULL_LIST_MAX}`);
    return (Array.isArray(raw) ? raw : []).slice(0, PULL_LIST_MAX).flatMap((pr) => {
      const number = count(pr.number);
      const openedAt = typeof pr.created_at === "string" && Number.isFinite(Date.parse(pr.created_at)) ? pr.created_at : "";
      if (!number || !openedAt) return [];
      return [{ repo: repo.alias, repository: repo.name, number, title: text(pr.title, 200) || `Pull request #${number}`, author: text(pr.user?.login, 60) || "unknown", branch: text(pr.head?.ref, 120), draft: pr.draft === true, openedAt }];
    });
  }

  private async load(t: Target, withFiles: boolean): Promise<PullView> {
    const pr = await this.read<RawPull>(t, `/pulls/${t.number}`);
    const head = typeof pr.head?.sha === "string" && SHA.test(pr.head.sha) ? pr.head.sha : "";
    if (!head) throw new PullError("GitHub's answer had no head commit.", 502);
    const [runs, files] = await Promise.all([
      this.read<{ check_runs?: Array<{ name?: unknown; status?: unknown; conclusion?: unknown }> }>(t, `/commits/${head}/check-runs?per_page=100`),
      withFiles ? this.read<Array<{ filename?: unknown; status?: unknown; additions?: unknown; deletions?: unknown; patch?: unknown }>>(t, `/pulls/${t.number}/files?per_page=${PULL_FILES_MAX}`) : Promise.resolve([]),
    ]);
    const checks: PullCheck[] = (Array.isArray(runs.check_runs) ? runs.check_runs : []).map((c) => ({
      name: text(c.name, 80) || "check",
      state: c.status !== "completed" ? "running" : c.conclusion === "success" ? "passed" : c.conclusion === "skipped" || c.conclusion === "neutral" ? "skipped" : "failed",
    }));
    let room = PULL_PATCHES_MAX;
    const shown: PullFile[] = (Array.isArray(files) ? files : []).slice(0, PULL_FILES_MAX).map((f) => {
      const whole = typeof f.patch === "string" ? redact(f.patch) : undefined;
      const patch = whole === undefined ? undefined : whole.slice(0, Math.max(0, Math.min(PULL_PATCH_MAX, room)));
      if (patch) room -= patch.length;
      const cut = whole !== undefined && patch !== undefined && patch.length < whole.length;
      return { name: text(f.filename, 300), status: text(f.status, 20) || "modified", additions: count(f.additions), deletions: count(f.deletions), ...(patch ? { patch } : {}), ...(cut ? { cut } : {}) };
    });
    const state: PullView["state"] = pr.merged === true ? "merged" : pr.state === "open" ? "open" : "closed";
    // The description keeps its line breaks; it is shown as plain text.
    const whole = typeof pr.body === "string" ? redact(pr.body).replace(/\r\n?/g, "\n").trim() : "";
    const body = whole.length > BODY_MAX ? `${whole.slice(0, BODY_MAX).trimEnd()}…` : whole;
    const view: PullView = {
      url: t.url,
      repo: t.repo.alias,
      repository: t.repo.slug,
      number: t.number,
      title: text(pr.title, 200) || `Pull request #${t.number}`,
      author: text(pr.user?.login, 60) || "unknown",
      ...(body ? { body } : {}),
      state,
      draft: pr.draft === true,
      head,
      branch: text(pr.head?.ref, 120),
      base: text(pr.base?.ref, 120),
      commits: count(pr.commits),
      additions: count(pr.additions),
      deletions: count(pr.deletions),
      changedFiles: count(pr.changed_files),
      checks,
      files: shown,
      redeploys: !!this.o.selfAlias && this.o.selfAlias === t.repo.alias,
      conflicts: state === "open" && pr.mergeable === false,
    };
    const blocked = blockedBy(view, pr.mergeable);
    return blocked ? { ...view, blocked } : view;
  }
}

/** Why a pull request cannot be merged from the app right now, in words for Paul. */
function blockedBy(v: PullView, mergeable: unknown): string | undefined {
  if (v.state === "merged") return "It is already merged.";
  if (v.state === "closed") return "It was closed without being merged.";
  if (v.draft) return "It is still a draft.";
  if (mergeable === false) return "It conflicts with the base branch.";
  const failed = v.checks.filter((c) => c.state === "failed");
  if (failed.length) return `${failed.length === 1 ? "A check" : `${failed.length} checks`} failed: ${failed.slice(0, 4).map((c) => c.name).join(", ")}.`;
  if (v.checks.some((c) => c.state === "running")) return "Its checks are still running.";
  if (mergeable !== true) return "GitHub is still working out whether it can be merged. Look again in a moment.";
  return undefined;
}
