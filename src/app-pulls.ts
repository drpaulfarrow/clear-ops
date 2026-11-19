/**
 * Reviewing and merging a job's pull request from the web app (docs/APP.md).
 *
 * Paul asked to review and merge from the app instead of leaving for GitHub. This is the one place
 * the service itself merges anything. It is not an agent and no model is involved: the app shows him
 * the pull request as GitHub holds it, and his own tap on Merge is carried here with the exact commit
 * he was looking at.
 *
 * What keeps it narrow:
 *  - Only a job's own `pr`, of exactly the shape `https://github.com/<owner>/<repo>/pull/<n>`, and only
 *    when it is in the managed repository that job works on. A job's `pr` is often read from its
 *    report, which is a model's words, so an address anywhere else is refused before GitHub is asked.
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
const BODY_MAX = 6_000;

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
  /** The managed repository a job works on, as "owner/name", or undefined when it has none. */
  slugOf: (job: Job) => string | undefined;
  /** The credential the service holds for a managed repository, or undefined when it has none. */
  token: (slug: string) => Promise<string | undefined> | string | undefined;
  /** The repository this service is deployed from, so the app can say a merge redeploys it. */
  selfSlug?: string;
  fetch?: typeof fetch;
}

interface Target {
  owner: string;
  repo: string;
  number: number;
  url: string;
  slug: string;
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
  user?: { login?: unknown };
  head?: { sha?: unknown; ref?: unknown };
  base?: { ref?: unknown };
}

const text = (v: unknown, max: number): string => (typeof v === "string" ? shortText(redact(v), max) : "");
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

export class AppPulls {
  private readonly o: AppPullsOptions;
  private readonly fetch: typeof fetch;
  /** Pull requests with a merge in flight, so two taps are one merge. */
  private merging = new Set<string>();

  constructor(o: AppPullsOptions) {
    this.o = o;
    this.fetch = o.fetch ?? fetch;
  }

  /** Whether a job has a pull request this could show at all. The repository is checked when it is asked for. */
  static has(job: Pick<Job, "pr">): boolean {
    return !!job.pr && PR_URL.test(job.pr);
  }

  /** The pull request as GitHub holds it now, with its checks and its changes. */
  async view(job: Job): Promise<PullView> {
    return this.load(job, true);
  }

  /** Merges the pull request Paul was shown, if it is still that commit and nothing blocks it. */
  async merge(job: Job, sha: unknown): Promise<{ text: string; url: string }> {
    if (typeof sha !== "string" || !SHA.test(sha)) throw new PullError("refused", 400);
    const t = this.target(job);
    if (this.merging.has(t.url)) throw new PullError("It is already being merged.");
    this.merging.add(t.url);
    try {
      const now = await this.load(job, false);
      if (now.blocked) throw new PullError(`Not merged. ${now.blocked}`);
      if (now.head !== sha) throw new PullError("Not merged. New commits were pushed since you looked. Look at it again first.");
      const res = await this.github(t, `/pulls/${t.number}/merge`, { method: "PUT", body: JSON.stringify({ sha, merge_method: "merge" }) });
      if (!res.ok) throw new PullError(`Not merged. GitHub refused: ${await this.said(res)}`);
      const merged = ((await res.json().catch(() => ({}))) as { merged?: unknown }).merged === true;
      if (!merged) throw new PullError("GitHub did not confirm the merge. Look at it again.");
      return { text: `Merged pull request #${t.number} on ${t.repo} from the app: ${now.title}.${now.redeploys ? " The service redeploys once no job is running." : ""}`, url: t.url };
    } finally {
      this.merging.delete(t.url);
    }
  }

  /** The job's pull request, only when it is in the job's own managed repository. */
  private target(job: Job): Target {
    const m = job.pr ? PR_URL.exec(job.pr) : null;
    if (!m) throw new PullError("This job has no pull request.", 404);
    const [, owner, repo, number] = m;
    const slug = `${owner}/${repo}`;
    const own = this.o.slugOf(job);
    if (!own || own.toLowerCase() !== slug.toLowerCase() || /^\.+$/.test(owner!) || /^\.+$/.test(repo!)) {
      throw new PullError("This job's pull request is not in the repository the job works on, so it is not shown or merged here.", 404);
    }
    return { owner: owner!, repo: repo!, number: Number(number), url: job.pr!, slug };
  }

  private async github(t: Target, path: string, init: { method?: string; body?: string } = {}): Promise<Response> {
    const token = await this.o.token(t.slug);
    if (!token) throw new PullError("The service holds no GitHub credential for that repository.", 503);
    try {
      return await this.fetch(`https://api.github.com/repos/${t.owner}/${t.repo}${path}`, {
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

  private async read<T>(t: Target, path: string): Promise<T> {
    const res = await this.github(t, path);
    if (res.status === 404) throw new PullError("GitHub cannot find that pull request with the service's credential.", 404);
    if (!res.ok) throw new PullError(`GitHub would not show it: ${await this.said(res)}`, 502);
    return (await res.json()) as T;
  }

  private async load(job: Job, withFiles: boolean): Promise<PullView> {
    const t = this.target(job);
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
      repository: t.slug,
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
      redeploys: !!this.o.selfSlug && this.o.selfSlug.toLowerCase() === t.slug.toLowerCase(),
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
