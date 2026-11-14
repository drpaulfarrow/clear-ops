/**
 * How quickly and efficiently the workers are getting through their jobs, from the job records.
 *
 * Everything here is read from the store's own job records over a window (the last 24 hours and the
 * last 7 days), per kind of worker: how many finished, how many were stopped or failed and why, how
 * long a job waited in the queue before its worker started, and how long the worker ran. The two
 * "typical" figures are medians, because one job stuck behind a long review drags a mean and tells
 * Paul nothing.
 *
 * Money is deliberately narrow. A cost per job is shown only where the store holds a real figure: a
 * job's own `usage.costUsd` recorded with `costSource` "provider" or "anthropic" (the two cases where
 * it is what the provider charged or what Anthropic bills). The Agent SDK's rounded-up estimate
 * (`job.costUsd`, and a `costSource` of "estimate") is never used and never shown, because on
 * OpenRouter it is nothing like the bill. Where there is no real figure the page says so in one
 * plain line rather than putting a number there. The cache figure is the share of prompt tokens the
 * provider reported as cache reads, and it is shown only when the records carry token counts.
 *
 * Nothing here reads a brief, an output or a transcript: kind, status, timings and the numbers above.
 */
import { failureLabel } from "./failures.js";
import { duration } from "./jobs.js";
import { kindName } from "./job-descriptions.js";
import type { Job } from "./store.js";

/** One window of the figures: 24 hours and 7 days. */
export interface StatsWindow {
  hours: number;
  /** "last 24 hours", "last 7 days". */
  label: string;
}

export const STATS_WINDOWS: readonly StatsWindow[] = [
  { hours: 24, label: "last 24 hours" },
  { hours: 24 * 7, label: "last 7 days" },
];

/** One kind of worker over one window, in the words the page prints. */
export interface KindStats {
  /** The raw kind, for tests and for the JSON. */
  kind: string;
  /** What Paul calls it ("engineer", "maintainer"). */
  label: string;
  /** Jobs of this kind that finished in the window (done or failed). */
  finished: number;
  /** How many of those did not finish done. */
  stoppedOrFailed: number;
  /** Why, in plain words with counts, only when there is anything to say. */
  why?: string;
  /** Jobs finished done, for the line that says what succeeded. */
  done: number;
  /** "2 min typical, 14 min worst": the wait in the queue before the worker started. */
  wait?: string;
  /** "18 min typical, 55 min worst": how long the worker ran. */
  run?: string;
  /** A real cost per job, when the store holds one: "$0.42 typical, the provider's own figure". */
  cost?: string;
  /** "68% of prompt tokens were cache hits", when the records carry token counts. */
  cache?: string;
}

export interface BoardEfficiency {
  windows: Array<{ label: string; note: string; kinds: KindStats[] }>;
  /** The one line about money, printed once under the heading, whatever the records hold. */
  costNote: string;
}

export interface StatsSource {
  jobs: readonly Job[];
  windows?: readonly StatsWindow[];
  now?: number;
  /** How long the job records go back, in words, for the note. Absent means unknown. */
  historyWords?: string;
}

const MINUTE = 60_000;
/** The second half of every money line: there is one figure, and the estimate is never called a bill. */
export const NEVER_THE_ESTIMATE =
  "The Agent SDK's own estimate is not the bill and is never shown as a cost.";
/** No real figure exists in the store today, and this says so rather than printing an estimate as one. */
export const NO_REAL_COST = `Cost per job: no real figure is stored for these jobs, so none is shown. ${NEVER_THE_ESTIMATE}`;

/** "2 min": a length in words, never "0 min" for something that happened. */
function shortLength(ms: number): string {
  const mins = Math.round(Math.max(0, ms) / MINUTE);
  return mins < 1 ? "under a minute" : duration(ms);
}

/** The median of a list of numbers: the middle one, or the middle of the two. Undefined for an empty list. */
export function median(values: readonly number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  // Not rounded: these are milliseconds and dollars, and rounding a cost to a whole number loses it.
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The usage record the cost work (src/telemetry.ts) puts on a job, read loosely so this works either way. */
interface UsageLike {
  costUsd?: number;
  costSource?: string;
  totals?: { promptTokens?: number; cachedTokens?: number };
}

function usageOf(job: Job): UsageLike | undefined {
  const usage = (job as { usage?: UsageLike }).usage;
  return usage && typeof usage === "object" ? usage : undefined;
}

/**
 * A job's real cost, or undefined. Only the provider's own figure and Anthropic's list price (which
 * is the bill there) count; the SDK's estimate is not a bill and is never returned as one.
 */
function realCost(job: Job): number | undefined {
  const usage = usageOf(job);
  if (!usage) return undefined;
  if (usage.costSource !== "provider" && usage.costSource !== "anthropic") return undefined;
  return typeof usage.costUsd === "number" && Number.isFinite(usage.costUsd) ? usage.costUsd : undefined;
}

/** Which real figure the cost line came from, in plain words. */
function costSourceWords(jobs: readonly Job[]): string {
  const sources = new Set(jobs.map((j) => usageOf(j)?.costSource));
  if (sources.size === 1 && sources.has("anthropic")) return "Anthropic's own list price, which is the bill there";
  if (sources.size === 1 && sources.has("provider")) return "the provider's own figure";
  return "what the store holds";
}

/** The share of prompt tokens that were cache reads, across the jobs that reported tokens. */
function cacheShare(jobs: readonly Job[]): number | undefined {
  let prompt = 0;
  let cached = 0;
  for (const job of jobs) {
    const totals = usageOf(job)?.totals;
    if (!totals) continue;
    prompt += totals.promptTokens ?? 0;
    cached += totals.cachedTokens ?? 0;
  }
  return prompt > 0 ? Math.round((cached / prompt) * 1000) / 10 : undefined;
}

/** Why the jobs that did not finish done did not: "stalled, stopped (2), key rejected (1)", capped. */
function whyLine(jobs: readonly Job[]): string | undefined {
  const counts = new Map<string, number>();
  for (const job of jobs) {
    const what = job.failure ? failureLabel(job.failure) : "failed";
    counts.set(what, (counts.get(what) ?? 0) + 1);
  }
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([what, n]) => `${what}${n > 1 ? ` (${n})` : ""}`);
  return parts.length ? parts.join(", ") : undefined;
}

/** One kind's figures for one window, or undefined when it has nothing in it. */
function kindStats(kind: string, jobs: readonly Job[]): KindStats | undefined {
  if (!jobs.length) return undefined;
  const waits: number[] = [];
  const runs: number[] = [];
  for (const job of jobs) {
    const started = job.startedAt ? Date.parse(job.startedAt) : Number.NaN;
    const created = Date.parse(job.createdAt);
    const finished = job.finishedAt ? Date.parse(job.finishedAt) : Number.NaN;
    if (!Number.isNaN(started) && !Number.isNaN(created)) waits.push(Math.max(0, started - created));
    if (!Number.isNaN(started) && !Number.isNaN(finished) && finished >= started) runs.push(finished - started);
  }
  const failed = jobs.filter((j) => j.status === "failed");
  const costs = jobs.map(realCost).filter((c): c is number => c !== undefined);
  const waitMedian = median(waits);
  const waitWorst = waits.length ? Math.max(...waits) : undefined;
  const runMedian = median(runs);
  const runWorst = runs.length ? Math.max(...runs) : undefined;
  const cache = cacheShare(jobs);
  const costTypical = median(costs);
  return {
    kind,
    label: kindName(kind),
    finished: jobs.length,
    done: jobs.length - failed.length,
    stoppedOrFailed: failed.length,
    ...(whyLine(failed) ? { why: whyLine(failed) } : {}),
    ...(waitMedian !== undefined && waitWorst !== undefined
      ? { wait: `queue wait before starting: ${shortLength(waitMedian)} typical, ${shortLength(waitWorst)} worst` }
      : {}),
    ...(runMedian !== undefined && runWorst !== undefined ? { run: `run time: ${shortLength(runMedian)} typical, ${shortLength(runWorst)} worst` } : {}),
    ...(costTypical !== undefined ? { cost: `cost per job: $${costTypical.toFixed(4)} typical, ${costSourceWords(jobs)}, from ${costs.length} of ${jobs.length} jobs` } : {}),
    ...(cache !== undefined ? { cache: `${cache}% of prompt tokens were cache hits` } : {}),
  };
}

/**
 * The one line about money for the whole section, printed once under the heading rather than beside
 * every kind. It says which kinds the store holds a real figure for and which it does not, and it
 * says plainly which is which; there is no case in which an estimate is put where a bill belongs.
 */
function moneyNote(all: readonly Job[], kindsShown: readonly string[]): string {
  const withCost = new Set<string>(all.filter((j) => realCost(j) !== undefined).map((j) => j.kind));
  if (!withCost.size) return NO_REAL_COST;
  const missing = kindsShown.filter((k) => !withCost.has(k));
  const source = costSourceWords(all.filter((j) => realCost(j) !== undefined));
  const have = `Cost per job is shown where the store holds a real figure (${source}); there it is what the job really cost, not an estimate.`;
  if (!missing.length) return `${have} ${NEVER_THE_ESTIMATE}`;
  const named = missing.map(kindName).join(", ");
  return `${have} ${missing.length === 1 ? "One kind has" : "Some kinds have"} no real figure stored, so no cost is shown for ${named}. ${NEVER_THE_ESTIMATE}`;
}

/**
 * The whole efficiency picture: per kind, over each window, in the order the windows were given. A
 * kind appears only in a window where it finished something, so a quiet week does not print thirteen
 * empty lines.
 */
export function boardEfficiency(source: StatsSource): BoardEfficiency {
  const now = source.now ?? Date.now();
  const windows = source.windows ?? STATS_WINDOWS;
  const finished = source.jobs.filter((j) => (j.status === "done" || j.status === "failed") && j.finishedAt && !Number.isNaN(Date.parse(j.finishedAt)));
  const built = windows.map((w) => {
    const from = now - w.hours * 60 * MINUTE;
    const inWindow = finished.filter((j) => Date.parse(j.finishedAt!) >= from);
    const byKind = new Map<string, Job[]>();
    for (const job of inWindow) byKind.set(job.kind, [...(byKind.get(job.kind) ?? []), job]);
    const kinds = [...byKind.entries()]
      .map(([kind, jobs]) => kindStats(kind, jobs))
      .filter((s): s is KindStats => s !== undefined)
      .sort((a, b) => b.finished - a.finished || a.label.localeCompare(b.label));
    return { label: w.label, note: `Jobs that finished in the ${w.label}. Typical means the middle one of the bunch, so one slow job does not skew it.`, kinds };
  });
  return { windows: built, costNote: moneyNote(finished, [...new Set(built.flatMap((w) => w.kinds.map((k) => k.kind)))]) };
}
