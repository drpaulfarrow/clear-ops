import type { Job } from "./store.js";
import { realCost } from "./worker-stats.js";

/**
 * What a job of one kind usually costs on one model, so Paul can see roughly what is coming before a
 * job has a figure of its own, and which model would be cheaper for the same kind of work.
 *
 * It is an estimate and is always shown as one, never as a job's cost:
 *
 *  - It is worked out only from the provider's own figures for jobs that finished (`realCost`): the
 *    Agent SDK's estimate is never read, and a job with no real figure counts for nothing.
 *  - Only jobs that ran to the end on a known model are counted. A failed or stopped job says what a
 *    failure cost, not what the work costs, and a figure the provider gave as a lower bound (it priced
 *    only some of the calls) is left out, because it would pull the estimate down.
 *  - A job's model is the one it was pinned to, or the one more than half of its charges were for (a
 *    worker's small helper calls go to a cheaper model, and are part of what the job costs), or the
 *    only one its usage names. A job split evenly across models has no one price and is left out.
 *  - It is the middle of what those jobs cost (the median), with the range the middle half fell in, so
 *    one runaway job does not move it.
 *  - With fewer than ESTIMATE_MIN_JOBS such jobs there is no estimate at all. Nothing is guessed.
 *  - Only the newest ESTIMATE_RECENT jobs of a kind on a model count, so it follows prices and prompts
 *    as they change.
 */
export interface CostEstimate {
  /** The job kind, and for research whether it was asked to go deep ("research" or "research, deep"). */
  kind: string;
  model: string;
  /** The median of what the counted jobs cost. */
  usd: number;
  /** The range the middle half of them fell in. */
  lowUsd: number;
  highUsd: number;
  /** How many jobs it is worked out from. */
  jobs: number;
}

export const ESTIMATE_MIN_JOBS = 3;
export const ESTIMATE_RECENT = 30;

/** One model's name as estimates compare it: lower case, without a routing suffix such as ":nitro". */
export const estimateModel = (model: string): string => model.trim().toLowerCase().replace(/:[a-z0-9-]+$/, "");

/** A job's kind as estimates group it. Deep research is a different piece of work from ordinary research. */
export const estimateKind = (job: Pick<Job, "kind" | "depth">): string => (job.kind === "research" && job.depth === "deep" ? "research, deep" : job.kind);

/** The model a finished job ran on, when that can be said: see the rules at the top of this file. */
function ranOn(job: Job): string | undefined {
  if (job.model) return estimateModel(job.model);
  const charged = job.usage?.costByModel ?? [];
  if (charged.length) {
    const most = charged.reduce((a, b) => (b.usd > a.usd ? b : a));
    const all = charged.reduce((n, m) => n + m.usd, 0);
    return most.model && most.model !== "not reported" && all > 0 && most.usd > all / 2 ? estimateModel(most.model) : undefined;
  }
  const models = job.usage?.models ?? [];
  return models.length === 1 && models[0]!.model ? estimateModel(models[0]!.model) : undefined;
}

/** The value a fraction of the way through a sorted list, between neighbours where it falls between two. */
function at(sorted: readonly number[], fraction: number): number {
  const i = (sorted.length - 1) * fraction;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
}

/** Every estimate the store's finished jobs support, the most expensive first. */
export function costEstimates(jobs: readonly Job[]): CostEstimate[] {
  const groups = new Map<string, { kind: string; model: string; costs: Array<{ at: string; usd: number }> }>();
  for (const job of jobs) {
    if (job.status !== "done" || !job.finishedAt || job.usage?.partial) continue;
    const usd = realCost(job);
    // A lower bound (the provider priced only some of the calls) carries a note saying so.
    if (usd === undefined || usd <= 0 || job.usage?.costNote) continue;
    const model = ranOn(job);
    if (!model) continue;
    const kind = estimateKind(job);
    const key = `${kind}\n${model}`;
    const group = groups.get(key) ?? { kind, model, costs: [] };
    group.costs.push({ at: job.finishedAt, usd });
    groups.set(key, group);
  }
  const out: CostEstimate[] = [];
  for (const { kind, model, costs } of groups.values()) {
    if (costs.length < ESTIMATE_MIN_JOBS) continue;
    const recent = costs
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, ESTIMATE_RECENT)
      .map((c) => c.usd)
      .sort((a, b) => a - b);
    out.push({ kind, model, usd: at(recent, 0.5), lowUsd: at(recent, 0.25), highUsd: at(recent, 0.75), jobs: recent.length });
  }
  return out.sort((a, b) => b.usd - a.usd || a.kind.localeCompare(b.kind) || a.model.localeCompare(b.model));
}

/** The estimate for one kind of job on one model, if there is one. */
export function estimateFor(list: readonly CostEstimate[], job: Pick<Job, "kind" | "depth">, model: string | undefined): CostEstimate | undefined {
  if (!model) return undefined;
  const kind = estimateKind(job);
  const name = estimateModel(model);
  return list.find((e) => e.kind === kind && e.model === name);
}
