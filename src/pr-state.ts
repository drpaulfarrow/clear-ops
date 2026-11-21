/**
 * Whether a pull request was merged, closed or is still open, asked of GitHub itself (docs/APP.md).
 *
 * The web app shows what came of a job from evidence the service holds. For an engineering job the
 * strongest evidence is the pull request's own state, and the service never recorded it: on this
 * repository Paul merges himself, on GitHub, and nothing told the store. So jobs he had long since
 * merged sat under "Waiting on me" (36 of them on 18 Nov 2026). This asks GitHub.
 *
 * It is read-only and small on purpose:
 *  - One request per pull request, `GET /repos/{owner}/{repo}/pulls/{number}` on api.github.com, with
 *    the credential the service already uses for that repository. Nothing is written anywhere.
 *  - `get` never waits. It answers from what is already known and, when that is missing or old, asks
 *    in the background, a few at a time, so a page is never held up by GitHub.
 *  - A merged pull request stays merged, so it is asked once. An open one is asked again after a few
 *    minutes, a closed one after an hour, and a failed request or one GitHub cannot find is left
 *    alone for ten minutes.
 *  - It also keeps when the pull request was opened, so the app can tell the job that opened it from
 *    jobs that only diagnosed, reviewed or pushed to it (src/app-data.ts).
 *  - Only an address of exactly the shape `https://github.com/<owner>/<repo>/pull/<n>` is ever asked
 *    about, and the token goes in a header to api.github.com and nowhere else.
 */
/** `missing` is GitHub's own "not found": the address names nothing the service can see. */
export type PrState = "open" | "merged" | "closed" | "missing";

/** What GitHub says of a pull request: its state, and when it was opened. */
export interface PrInfo {
  state: PrState;
  /** When the pull request was opened, as GitHub gives it. Tells a job that opened it from one that only worked on it. */
  openedAt?: string;
}

const PR_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/;

/** The owner, repository and number in a pull request's own address, or undefined for anything else. */
function parsePr(url: string): { owner: string; repo: string; number: string } | undefined {
  const m = PR_URL.exec(url);
  if (!m) return undefined;
  const [, owner, repo, number] = m;
  // A dot segment is not a name: it would climb out of the path being asked for.
  if (/^\.+$/.test(owner!) || /^\.+$/.test(repo!)) return undefined;
  return { owner: owner!, repo: repo!, number: number! };
}
const OPEN_FRESH_MS = 3 * 60_000;
const CLOSED_FRESH_MS = 60 * 60_000;
const FAILED_WAIT_MS = 10 * 60_000;
const TIMEOUT_MS = 8_000;
/** How many requests to GitHub may be in flight at once. */
export const PR_STATE_CONCURRENCY = 4;
/** The most pull requests remembered; the oldest are forgotten past it. */
const KEEP = 2_000;

export interface PrStatesOptions {
  /** The credential for a repository ("owner/name"), or undefined when the service has none. */
  token: (slug: string) => Promise<string | undefined> | string | undefined;
  fetch?: typeof fetch;
  now?: () => number;
}

export class PrStates {
  private known = new Map<string, { state?: PrState; openedAt?: string; at: number }>();
  private queued: string[] = [];
  private flying = new Set<string>();
  private readonly token: PrStatesOptions["token"];
  private readonly fetch: typeof fetch;
  private readonly now: () => number;

  constructor(o: PrStatesOptions) {
    this.token = o.token;
    this.fetch = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
  }

  /** The state of a pull request, as far as it is known right now. Never waits. */
  get(url: string): PrState | undefined {
    return this.info(url)?.state;
  }

  /** What is known of a pull request right now. Never waits; asks GitHub in the background when it should. */
  info(url: string): PrInfo | undefined {
    if (!parsePr(url)) return undefined;
    const seen = this.known.get(url);
    if (this.stale(seen) && !this.flying.has(url) && !this.queued.includes(url)) {
      this.queued.push(url);
      this.pump();
    }
    return seen?.state ? { state: seen.state, ...(seen.openedAt ? { openedAt: seen.openedAt } : {}) } : undefined;
  }

  /**
   * The state of a pull request as GitHub gives it now, asked for and waited on. For a decision that
   * must not rest on what was known a few minutes ago: whether to start work on a pull request that may
   * have been merged meanwhile (src/jobs.ts). Undefined when it could not be asked or GitHub did not
   * answer, and then the caller carries on as if it had not asked.
   */
  async fresh(url: string): Promise<PrState | undefined> {
    const info = await this.ask(url).catch(() => undefined);
    if (info) this.known.set(url, { state: info.state, ...(info.openedAt ? { openedAt: info.openedAt } : {}), at: this.now() });
    return info?.state;
  }

  private stale(seen: { state?: PrState; at: number } | undefined): boolean {
    if (!seen) return true;
    if (seen.state === "merged") return false;
    const age = this.now() - seen.at;
    return age > (seen.state === "open" ? OPEN_FRESH_MS : seen.state === "closed" ? CLOSED_FRESH_MS : FAILED_WAIT_MS);
  }

  private pump(): void {
    while (this.flying.size < PR_STATE_CONCURRENCY && this.queued.length) {
      const url = this.queued.shift()!;
      this.flying.add(url);
      void this.ask(url)
        .catch(() => undefined)
        .then((info) => {
          // A failed request keeps what was known before and is simply not asked again for a while.
          const before = this.known.get(url);
          this.known.set(url, { state: info?.state ?? before?.state, openedAt: info?.openedAt ?? before?.openedAt, at: this.now() });
          if (this.known.size > KEEP) this.known.delete(this.known.keys().next().value!);
          this.flying.delete(url);
          this.pump();
        });
    }
  }

  /** Asks GitHub once. Resolves undefined for anything but a clear answer. */
  private async ask(url: string): Promise<PrInfo | undefined> {
    const pr = parsePr(url);
    if (!pr) return undefined;
    const { owner, repo, number } = pr;
    const token = await this.token(`${owner}/${repo}`);
    if (!token) return undefined;
    const res = await this.fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}`, {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "clear-ops" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 404) return { state: "missing" };
    if (!res.ok) return undefined;
    const body = (await res.json()) as { state?: unknown; merged?: unknown; created_at?: unknown };
    const state: PrState | undefined = body.merged === true ? "merged" : body.state === "open" ? "open" : body.state === "closed" ? "closed" : undefined;
    if (!state) return undefined;
    const openedAt = typeof body.created_at === "string" && Number.isFinite(Date.parse(body.created_at)) ? body.created_at : undefined;
    return { state, ...(openedAt ? { openedAt } : {}) };
  }

  /** Drops what is known of a pull request, so the next look asks GitHub again. For when the service itself just changed it. */
  forget(url: string): void {
    this.known.delete(url);
  }

  /** Resolves once nothing is queued or in flight. For the tests. */
  async settled(): Promise<void> {
    while (this.flying.size || this.queued.length) await new Promise((r) => setTimeout(r, 5));
  }
}
