/**
 * Whether the service is healthy right now, for the top of the jobs board.
 *
 * Two halves, both of them read-only and neither of them able to touch a job.
 *
 * The live half is counted from what the service already knows: how long this process has been up,
 * how many workers are really running (the queue's own count, so a job waiting for a deploy or for a
 * working copy is not called running), how deep the queues are, whether the queues are held after a
 * credit or key failure, and whether the runner says a running job's worker is alive. The threshold
 * for "stalled" is the runner's own (`JobRunner.liveness`), so this file repeats none of it.
 *
 * The outside half is probed lightly on a timer, never while a page is being rendered: one small
 * read-only request each to the model provider, to each search provider whose key is set, to GitHub
 * and, when Paul's Workspace is connected, to Google. Every request carries its credential in a
 * header, never in the URL, and no reply body is kept: only a short state and a phrase this file
 * wrote itself, so a key, an address or anything else personal can never reach a log or the page. A
 * probe that fails changes nothing about any job; it is a line on a page.
 *
 * The page stays readable when everything is broken: the figures come from the store and the queue,
 * and a failing check is one more line saying so.
 */
import { config } from "./config.js";
import { OPENROUTER_BASE_URL, provider } from "./llm.js";
import { UPTIME_NOTE, type UptimeReport } from "./uptime.js";
import type { Store } from "./store.js";

/** How often the dependencies are probed. Light enough to be free, often enough to be current. */
export const PROBE_INTERVAL_MS = 5 * 60_000;
/** How long one probe may take before it is called unanswered. */
export const PROBE_TIMEOUT_MS = 5_000;

export type ProbeState = "ok" | "fail" | "off" | "waiting";

/** What one probe found. `detail` is written by this file, never taken from a reply. */
export interface ProbeOutcome {
  state: "ok" | "fail" | "off";
  detail: string;
}

/** One thing the workforce depends on, and the smallest request that shows it is answering. */
export interface HealthProbe {
  /** What Paul calls it on the page. */
  name: string;
  check: () => Promise<ProbeOutcome>;
}

/** The last result of one probe, as the page shows it. */
export interface ProbeResult {
  name: string;
  state: ProbeState;
  detail: string;
  /** When this was last checked, ISO. */
  checkedAt?: string;
}

export interface ProbesOptions {
  intervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

/**
 * The probes, run on a timer and kept in memory only. Nothing about them is written to the store or
 * to a log, and `snapshot` is a plain read, so the board can render in the middle of a failing pass
 * without waiting for anything.
 */
export class HealthProbes {
  private readonly results = new Map<string, ProbeResult>();
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private passing = false;

  constructor(
    private readonly probes: readonly HealthProbe[],
    options: ProbesOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? PROBE_INTERVAL_MS;
    this.timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    for (const p of probes) this.results.set(p.name, { name: p.name, state: "waiting", detail: "not checked yet" });
  }

  /** One pass over every probe, each one bounded, no probe able to throw or to hang a pass. */
  async tick(): Promise<void> {
    if (this.passing) return;
    this.passing = true;
    try {
      for (const probe of this.probes) {
        const outcome = await bounded(probe.check(), this.timeoutMs);
        this.results.set(probe.name, { name: probe.name, state: outcome.state, detail: outcome.detail, checkedAt: new Date(this.now()).toISOString() });
      }
    } finally {
      this.passing = false;
    }
  }

  /** The last result of every probe, in the order the probes were given. */
  snapshot(): ProbeResult[] {
    return [...this.results.values()];
  }

  /**
   * Probes now, then every interval. The timer is unref'd, so it never holds the process open on its
   * own; the returned function clears it, which is what a test and a shutdown call.
   */
  start(): () => void {
    void this.tick();
    const timer = setInterval(() => void this.tick(), this.intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }
}

/**
 * A probe's answer, or the honest one when it threw or did not answer in time.
 *
 * This timer is deliberately NOT unref'd: it is the only thing still pending while a probe that never
 * answers is being awaited, so an unref'd one would leave the event loop with nothing to do and the
 * wait would end as "the event loop has already resolved" rather than as the honest line. It is
 * cleared in the `finally` below, so it never outlives this call; only the long-lived interval in
 * `start()` is unref'd, because that one is meant to sit there for the life of the process.
 */
async function bounded(check: Promise<ProbeOutcome>, timeoutMs: number): Promise<ProbeOutcome> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<ProbeOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ state: "fail", detail: `did not answer within ${Math.round(timeoutMs / 1000)} seconds` }), timeoutMs);
  });
  try {
    return await Promise.race([check.catch(() => ({ state: "fail" as const, detail: "did not answer" })), late]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** One read-only request, measured by whether it answered and with what. A reply body is never read. */
async function httpCheck(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  what: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<ProbeOutcome> {
  try {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) return { state: "ok", detail: "answered" };
    if (res.status === 401 || res.status === 403 || res.status === 422) return { state: "fail", detail: `refused the ${what} (${res.status})` };
    return { state: "fail", detail: `did not answer properly (${res.status})` };
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return { state: "fail", detail: timedOut ? `did not answer within ${Math.round(timeoutMs / 1000)} seconds` : "did not answer" };
  }
}

/** What the probes need that they cannot read for themselves. Injected so tests never touch the network. */
export interface ProbeDeps {
  fetch?: typeof fetch;
  /** The keys in force, so a test can probe without the environment. */
  keys?: { openrouter?: string; anthropic?: string; brave?: string; exa?: string };
  /** The GitHub credential, the same one the workers are given. Absent means there is none. */
  githubToken?: () => Promise<string | undefined>;
  /** Paul's Google Workspace, when the service has it to hand. Absent means this process cannot say. */
  google?: GoogleProbeDeps;
  timeoutMs?: number;
}

/**
 * The Google half, injected: whether Paul's Workspace is connected, and the smallest authenticated
 * read that proves the stored credential still works. `profile` is `GoogleApi`'s "who is connected"
 * call (`gmail GET profile`, the first row of `ALLOWED_ENDPOINTS`), so the probe adds no scope and no
 * new operation; a Google refresh token that has been revoked is exactly the sort of silent breakage
 * the board should show.
 */
export interface GoogleProbeDeps {
  /** Whether a connection exists at all. */
  connected: () => boolean;
  /** One authenticated read. Resolves when Google answered, throws when it did not. */
  profile: () => Promise<unknown>;
}

/** The provider key the models run on. Both providers' endpoint is a small read that needs the key. */
function modelProbe(fetchImpl: typeof fetch, key: string, name: string, timeoutMs: number): HealthProbe {
  if (!key) return { name: "model provider", check: async () => ({ state: "off", detail: "no model key is set" }) };
  if (name === "openrouter") {
    // The key endpoint (src/spend.ts reads the same one): it answers only to a live inference key.
    return { name: "model provider", check: () => httpCheck(fetchImpl, `${OPENROUTER_BASE_URL}/v1/key`, { headers: { Authorization: `Bearer ${key}` } }, "key", timeoutMs) };
  }
  return {
    name: "model provider",
    check: () =>
      httpCheck(
        fetchImpl,
        "https://api.anthropic.com/v1/models?limit=1",
        { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } },
        "key",
        timeoutMs,
      ),
  };
}

/**
 * Everything the workforce depends on outside this machine, each behind the smallest request that
 * shows it is answering. Only what is configured is probed; anything without a key is reported as
 * off rather than failed, because an unused tool is not a fault.
 */
export function defaultProbes(deps: ProbeDeps = {}): HealthProbe[] {
  const fetchImpl = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;
  const keys = deps.keys ?? { openrouter: config.openrouter.apiKey, anthropic: process.env.ANTHROPIC_API_KEY ?? "", brave: config.search.braveKey, exa: config.search.exaKey };
  const probes: HealthProbe[] = [modelProbe(fetchImpl, provider() === "openrouter" ? keys.openrouter ?? "" : keys.anthropic ?? "", provider(), timeoutMs)];
  probes.push(
    keys.brave
      ? {
          name: "Brave search",
          check: () =>
            httpCheck(
              fetchImpl,
              "https://api.search.brave.com/res/v1/web/search?q=health&count=1",
              { headers: { Accept: "application/json", "X-Subscription-Token": keys.brave! } },
              "key",
              timeoutMs,
            ),
        }
      : { name: "Brave search", check: async () => ({ state: "off", detail: "no Brave key, so web_search is off" }) },
  );
  probes.push(
    keys.exa
      ? {
          name: "Exa search",
          check: () =>
            httpCheck(
              fetchImpl,
              "https://api.exa.ai/search",
              { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": keys.exa! }, body: JSON.stringify({ query: "health", numResults: 1 }) },
              "key",
              timeoutMs,
            ),
        }
      : { name: "Exa search", check: async () => ({ state: "off", detail: "no Exa key, so exa_search is off" }) },
  );
  probes.push({
    name: "GitHub",
    check: async () => {
      // A refusal is reported only when there is really a credential to refuse. With none readable, or
      // one that came back empty, the page says that plainly instead of crying wolf about a broken
      // token: an environment with the App key and GH_TOKEN stripped out (a worker's) must read as
      // "not configured here", not as a fault of the board's own making.
      const token = ((await deps.githubToken?.().catch(() => undefined)) ?? "").trim();
      if (!token) return { state: "off", detail: "no GitHub token is configured" };
      // The rate limit endpoint accepts any live token and is the cheapest authenticated read.
      return httpCheck(fetchImpl, "https://api.github.com/rate_limit", { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "clear-ops" } }, "token", timeoutMs);
    },
  });
  probes.push(googleProbe(deps.google));
  return probes;
}

/** The Google Workspace check: off until Paul connects, and one authenticated read once he has. */
function googleProbe(google: GoogleProbeDeps | undefined): HealthProbe {
  return {
    name: "Google Workspace",
    check: async () => {
      if (!google) return { state: "off", detail: "Google is not set up here" };
      if (!google.connected()) return { state: "off", detail: "Paul's Google account is not connected" };
      try {
        await google.profile();
        return { state: "ok", detail: "answered" };
      } catch (err) {
        // Google's own words are never printed: an error body can carry an address. Only the status
        // number, read off the message, is taken, and the phrase around it is written here.
        const status = /\b([45]\d\d)\b/.exec(err instanceof Error ? err.message : "")?.[1];
        if (!status) return { state: "fail", detail: "did not answer" };
        return status === "401" || status === "403"
          ? { state: "fail", detail: `refused the stored credential (${status})` }
          : { state: "fail", detail: `did not answer properly (${status})` };
      }
    },
  };
}

/* ---------- What the page shows ---------- */

export interface BoardCheck {
  name: string;
  state: ProbeState;
  detail: string;
  /** When this was last checked, ISO. */
  checkedAt?: string;
}

/** The heartbeat side of the health block, already in plain words (src/uptime.ts does the arithmetic). */
export interface BoardUptime {
  headline: string;
  /** One cell per half hour for the last 24 hours. */
  strip: Array<"up" | "down" | "unknown">;
  stripNote: string;
  gapsLine: string;
  restartLine: string;
  note: string;
  /** No heartbeat history at all yet, so nothing here is a figure. */
  empty: boolean;
}

export interface BoardHealth {
  /** "warn" when something needs Paul's attention, "ok" when nothing does. */
  level: "ok" | "warn";
  headline: string;
  /** The live counts, in one plain line. */
  live: string;
  checks: BoardCheck[];
  /** When the checks were last taken. */
  checksLine: string;
  uptime: BoardUptime;
}

export interface HealthSource {
  store: Store;
  /** The heartbeats this process records (src/uptime.ts). Absent means no uptime is known here. */
  uptime?: { report: () => UptimeReport };
  /** The last pass over the dependencies. Read here, never taken here. */
  probes?: { snapshot: () => ProbeResult[] };
  /** How many workers are really running, from the queue itself. */
  activeWorkers?: () => number;
  /** The runner's own view of a running job: absent means this process cannot say. */
  liveness?: (id: string) => { alive: boolean } | undefined;
  now?: number;
}

const MINUTE = 60_000;

/** The London calendar day a moment falls in, so "today" is decided in Paul's own time. */
function londonDay(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date(ms));
}

/** "07:12" in London time, with the weekday when it was not today. */
function clock(ms: number, now: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    ...(londonDay(ms) === londonDay(now) ? {} : { weekday: "short" as const }),
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms));
}

/** "4 min", "1 h 10 min", "2 d": a length in plain words. */
function length(ms: number): string {
  const mins = Math.max(1, Math.round(ms / MINUTE));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  if (h < 24) {
    const m = mins % 60;
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d} d ${rh} h` : `${d} d`;
}

/** The uptime half, in words, from the heartbeat report. */
export function boardUptime(report: UptimeReport, now: number): BoardUptime {
  const stripNote = "Each cell is half an hour: green where the service was recording, red across a gap, grey before the records begin.";
  if (report.empty) {
    return {
      headline: "No heartbeat history yet, so there is no uptime figure.",
      strip: report.strip,
      stripNote,
      gapsLine: "No gap has been recorded yet.",
      restartLine: report.lastRestart ? `The service last started ${report.lastRestartWords}.` : "The service has just started.",
      note: UPTIME_NOTE,
      empty: true,
    };
  }
  const day = report.uptimePct24h !== undefined ? `Uptime ${report.uptimePct24h}% ${report.covers24h ? "of the last 24 hours" : `since records begin (${report.sinceWords})`}` : "Uptime for the last 24 hours is not known yet";
  const week = report.uptimePct7d !== undefined && report.covers7d ? `, ${report.uptimePct7d}% of the last 7 days` : "";
  const down = report.downtimeMinutes24h > 0 ? `; downtime ${length(report.downtimeMinutes24h * MINUTE)} in the last 24 hours` : "; no downtime in the last 24 hours";
  const recent = report.gaps.map((g) => `${clock(g.to, now)} (${length(g.ms)})`).join(", ");
  const dayGaps = report.gaps24h;
  const gapsLine = recent
    ? `${dayGaps === 1 ? "1 gap" : `${dayGaps} gaps`} in the last 24 hours, ${report.gaps7d === dayGaps ? "the same in the last 7 days" : `${report.gaps7d} in the last 7 days`}. Most recent, newest first: ${recent}.`
    : `No gap in the last 24 hours; ${report.gaps7d === 1 ? "1 in the last 7 days" : `${report.gaps7d} in the last 7 days`}.`;
  return {
    headline: `${day}${week}${down}.`,
    strip: report.strip,
    stripNote,
    gapsLine,
    restartLine: `The service last started ${report.lastRestartWords ?? "a moment ago"}, and has started ${report.restarts24h === 1 ? "once" : `${report.restarts24h} times`} in the last 24 hours.`,
    note: UPTIME_NOTE,
    empty: false,
  };
}

/**
 * The whole health block: the verdict, the live counts, the dependency checks and the uptime half.
 * Everything is read from the store, the queue and the last probe pass; nothing here waits for
 * anything, and nothing here can change a job.
 */
export function boardHealth(source: HealthSource): BoardHealth {
  const now = source.now ?? Date.now();
  const jobs = source.store.allJobs();
  const running = jobs.filter((j) => j.status === "running");
  const queued = jobs.filter((j) => j.status === "queued");
  const active = source.activeWorkers?.();
  const stalled = source.liveness ? running.filter((j) => source.liveness?.(j.id)?.alive === false) : [];
  const hold = source.store.queueHold();
  const checks: BoardCheck[] = (source.probes?.snapshot() ?? []).map((p) => ({
    name: p.name,
    state: p.state,
    detail: p.detail,
    ...(p.checkedAt ? { checkedAt: p.checkedAt } : {}),
  }));
  const failed = checks.filter((c) => c.state === "fail");
  const waiting = checks.filter((c) => c.state === "waiting");

  const live: string[] = [];
  if (source.uptime) {
    const report = source.uptime.report();
    live.push(report.lastRestartWords ? `Up ${report.lastRestartWords.replace(/ ago$/, "")} since the last restart` : "Up since it started");
  }
  live.push(
    active !== undefined
      ? `${active === 0 ? "no workers running" : active === 1 ? "1 worker running" : `${active} workers running`}`
      : `${running.length === 0 ? "nothing marked running" : `${running.length} marked running`}`,
  );
  live.push(queued.length === 0 ? "nothing queued" : queued.length === 1 ? "1 job queued" : `${queued.length} jobs queued`);
  if (source.liveness) live.push(stalled.length === 0 ? "nothing stalled" : stalled.length === 1 ? "1 job stalled" : `${stalled.length} jobs stalled`);
  live.push(hold ? "the engineering queue is held until /resume" : "the queue is not held");

  const problems: string[] = [];
  for (const c of failed) problems.push(`${c.name} ${c.detail}`);
  if (hold) problems.push(`the engineering queue is held after a ${hold.kind === "credit" ? "credit" : "key"} failure`);
  if (stalled.length) problems.push(`${stalled.length === 1 ? "a job has" : `${stalled.length} jobs have`} shown no activity for too long`);

  const headline = problems.length
    ? `Something needs a look: ${problems.join("; ")}.`
    : waiting.length
      ? "Everything looks healthy, and the outside checks are running now."
      : "Everything looks healthy: the service is up, nothing is stalled or held, and everything it depends on answered.";

  const newest = checks.map((c) => c.checkedAt).filter((t): t is string => !!t).sort().pop();
  const checksLine = !checks.length
    ? "The outside checks are not running in this process."
    : !newest
      ? "The outside checks have not run yet."
      : `Last checked ${length(Math.max(0, now - Date.parse(newest)))} ago; a failing check changes nothing about a job.`;

  return {
    level: problems.length ? "warn" : "ok",
    headline,
    live: `${live.join(", ")}.`,
    checks,
    checksLine,
    uptime: source.uptime ? boardUptime(source.uptime.report(), now) : boardUptime(emptyReport(), now),
  };
}

/** What the health block shows when this process keeps no heartbeats at all. */
function emptyReport(): UptimeReport {
  return { samples: 0, covers24h: false, covers7d: false, downtimeMinutes24h: 0, strip: Array.from({ length: 48 }, () => "unknown" as const), gaps: [], gaps24h: 0, gaps7d: 0, restarts24h: 0, empty: true };
}
