/**
 * The eval set: about thirty representative tasks, what a correct answer must contain, and how that
 * is judged, plus the runner that executes them through the real harness and writes down the cost and
 * the pass rate.
 *
 * Why it exists. This is slice 1 of the efficiency programme: it is the measurement every later slice
 * (tiered models, prompt caching, tool discipline, retrieval as a harness decision) is judged by. Each
 * slice runs the same tasks and compares cost per task and pass rate with the run before it. It is
 * deliberately small and cheap: it is a comparison, not a benchmark.
 *
 * What it records. Task id, category, pass or fail, the names of the checks that failed (never the
 * answer), the tokens used and the Agent SDK's own price for the run. That price is an ESTIMATE from
 * the rounded-up table in src/llm.ts, kept internal and labelled as such in the file: on OpenRouter
 * the provider reports one figure for the whole key, so there is no per-task amount to read. Nothing
 * else is written: no prompt, no answer, no brief, and nothing derived from Paul's mail, calendar or
 * uploads, which is why no eval task may touch them.
 *
 * Judging is deterministic and costs nothing: a task says which strings or patterns a correct answer
 * must contain, whether it must cite a source, whether the right answer is that the thing was not
 * found, and how long it may be. No model judges another model's answer.
 */
import fs from "node:fs";
import path from "node:path";
import { emptyTotals, addTotals, cacheHitRate, type UsageTotals } from "./telemetry.js";

/** One check set: what a correct answer must contain, and what it must not. */
export interface EvalJudge {
  /** Every one of these strings must appear (case-insensitive). */
  all?: string[];
  /** At least one of these must appear. */
  any?: string[];
  /** Each group must have at least one of its strings in the answer. */
  anyGroups?: string[][];
  /** Every one of these patterns must match. */
  regex?: string[];
  /** None of these may appear: a task where inventing one is the failure. */
  forbid?: string[];
  /** The answer must cite at least one http(s) link. */
  cite?: boolean;
  /** The right answer is that the thing could not be found; the answer must say so and invent nothing. */
  notFound?: boolean;
  minWords?: number;
  maxWords?: number;
}

export interface EvalTask {
  id: string;
  category: EvalCategory;
  /** What is asked, in the workforce's own style. `{{name}}` is replaced from the runner's vars. */
  prompt: string;
  judge: EvalJudge;
}

/** The kinds of task the set covers, so a report can show where a slice lost accuracy. */
export const EVAL_CATEGORIES = ["current-fact", "own-repo", "job-status", "drafting", "retrieval-cited", "not-found", "own-behaviour"] as const;
export type EvalCategory = (typeof EVAL_CATEGORIES)[number];

export interface EvalSet {
  version: string;
  /** One line on what this version is, so a later slice can see what changed. */
  note?: string;
  tasks: EvalTask[];
}

/** Where the versioned task file lives, and where its results are written. Both overridable by env. */
export function tasksPath(): string {
  return process.env.EVAL_TASKS ?? path.resolve(process.cwd(), "eval", "tasks.v1.json");
}

/** The plain words an answer uses when it is honestly reporting that it could not find something. */
export const NOT_FOUND_PHRASES = [
  "not found",
  "could not find",
  "couldn't find",
  "cannot find",
  "can't find",
  "unable to find",
  "no record",
  "no public",
  "no evidence",
  "no information",
  "not available",
  "does not exist",
  "doesn't exist",
  "no such",
  "not something i",
  "do not have",
  "don't have",
  "unknown",
  "not aware of",
];

/** Loads and checks the task file. Throws with a plain reason rather than running a broken set. */
export function loadEvalSet(file = tasksPath()): EvalSet {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as EvalSet;
  if (!raw || !Array.isArray(raw.tasks) || !raw.tasks.length) throw new Error(`${file} has no tasks.`);
  const seen = new Set<string>();
  for (const t of raw.tasks) {
    if (!t.id || seen.has(t.id)) throw new Error(`${file}: every task needs a unique id (${t.id || "missing"}).`);
    seen.add(t.id);
    if (!t.prompt) throw new Error(`${file}: task ${t.id} has no prompt.`);
    if (!EVAL_CATEGORIES.includes(t.category)) throw new Error(`${file}: task ${t.id} has category "${t.category}", which is not one of ${EVAL_CATEGORIES.join(", ")}.`);
  }
  return { version: raw.version ?? "unversioned", ...(raw.note ? { note: raw.note } : {}), tasks: raw.tasks };
}

/** Replaces `{{name}}` from the runner's vars, so a task can name a job the runner seeded. */
export function fillVars(text: string, vars: Record<string, string> = {}): string {
  return text.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => vars[key] ?? whole);
}

function words(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

/**
 * Judges one answer against one task. Returns whether it passes and the names of the checks that
 * failed; never the answer itself, so a results file can say why a task failed without carrying a
 * word of what the model wrote.
 */
export function judgeAnswer(task: EvalTask, answer: string, vars: Record<string, string> = {}): { pass: boolean; failed: string[] } {
  const failed: string[] = [];
  const text = answer ?? "";
  const lower = text.toLowerCase();
  const j = task.judge;
  const fill = (s: string) => fillVars(s, vars);
  for (const s of j.all ?? []) if (!lower.includes(fill(s).toLowerCase())) failed.push(`missing "${fill(s)}"`);
  if (j.any?.length) {
    const hits = j.any.filter((s) => lower.includes(fill(s).toLowerCase()));
    if (!hits.length) failed.push(`none of: ${j.any.map(fill).join(" / ")}`);
  }
  for (const group of j.anyGroups ?? []) {
    if (!group.some((s) => lower.includes(fill(s).toLowerCase()))) failed.push(`none of: ${group.map(fill).join(" / ")}`);
  }
  for (const p of j.regex ?? []) {
    try {
      if (!new RegExp(p, "i").test(text)) failed.push(`no match for /${p}/`);
    } catch {
      failed.push(`bad pattern /${p}/`);
    }
  }
  for (const s of j.forbid ?? []) if (lower.includes(fill(s).toLowerCase())) failed.push(`must not say "${fill(s)}"`);
  if (j.cite && !/https?:\/\/\S+/.test(text)) failed.push("no link cited");
  if (j.notFound && !NOT_FOUND_PHRASES.some((p) => lower.includes(p))) failed.push("did not say it was not found");
  const n = words(text);
  if (j.minWords !== undefined && n < j.minWords) failed.push(`too short (${n} words)`);
  if (j.maxWords !== undefined && n > j.maxWords) failed.push(`too long (${n} words)`);
  return { pass: failed.length === 0, failed };
}

/** What one task's run produced: the answer, and what it cost. */
export interface EvalRunResult {
  text: string;
  /** The Agent SDK's own price for the run. Internal only: an estimate, never a bill. */
  estimateUsd?: number;
  tokens?: UsageTotals;
  /** The model the harness answered with, where the runner knows it. */
  model?: string;
}

export type EvalRunner = (task: EvalTask, prompt: string) => Promise<EvalRunResult>;

/** One task's outcome as it is written down: the numbers and the verdict, never the answer. */
export interface EvalTaskResult {
  id: string;
  category: EvalCategory;
  pass: boolean;
  /** The checks that failed, named. Empty when it passed. */
  failed: string[];
  skipped?: boolean;
  tokens: UsageTotals;
  estimateUsd?: number;
  ms: number;
  model?: string;
}

export interface EvalRun {
  version: string;
  /** What this run is, e.g. "baseline" or a branch name. */
  label: string;
  startedAt: string;
  finishedAt: string;
  budgetUsd: number;
  /** The SDK's own price for the whole run, which is an internal estimate (see the module comment). */
  estimateUsd: number;
  totals: UsageTotals;
  cacheHitRate: number | null;
  passed: number;
  failed: number;
  skipped: number;
  /** Pass rate over the tasks that ran (skipped tasks are not counted). */
  passRate: number;
  tasks: EvalTaskResult[];
}

export interface EvalOptions {
  tasks: EvalTask[];
  run: EvalRunner;
  /** Stops the run once this much of the internal estimate has been spent. Default 2 dollars. */
  budgetUsd?: number;
  label?: string;
  /** Values for `{{name}}` in a task's prompt, such as a job id the runner seeded. */
  vars?: Record<string, string>;
  now?: () => number;
  version?: string;
  /** Told after each task, so a hand run shows progress. */
  onTask?: (result: EvalTaskResult, task: EvalTask) => void;
}

/**
 * Runs every task through the harness, one at a time, and stops early if the internal estimate passes
 * the budget. A task that throws is a failed task, not a failed run: the point is the score.
 */
export async function runEvalSet(o: EvalOptions): Promise<EvalRun> {
  const now = o.now ?? Date.now;
  const budget = o.budgetUsd ?? 2;
  const started = now();
  const results: EvalTaskResult[] = [];
  let spent = 0;
  const totals = emptyTotals();
  for (const task of o.tasks) {
    const t0 = now();
    if (spent >= budget) {
      results.push({ id: task.id, category: task.category, pass: false, failed: ["not run: the eval budget was spent"], skipped: true, tokens: emptyTotals(), ms: 0 });
      o.onTask?.(results[results.length - 1], task);
      continue;
    }
    const prompt = fillVars(task.prompt, o.vars);
    let outcome: EvalRunResult;
    try {
      outcome = await o.run(task, prompt);
    } catch (err) {
      outcome = { text: "", ...(undefined as unknown as { estimateUsd?: number }) };
      const failed = [`the run threw: ${err instanceof Error ? err.message : String(err)}`];
      const result: EvalTaskResult = { id: task.id, category: task.category, pass: false, failed, tokens: emptyTotals(), ms: now() - t0 };
      results.push(result);
      o.onTask?.(result, task);
      continue;
    }
    const verdict = judgeAnswer(task, outcome.text, o.vars);
    // Rounded to a millionth of a dollar: the SDK reports dollars and cents well past that, and a
    // results file should read the same on two machines.
    const estimate = Number.isFinite(outcome.estimateUsd) ? Math.round((outcome.estimateUsd ?? 0) * 1e6) / 1e6 : 0;
    spent += estimate;
    if (outcome.tokens) addTotals(totals, outcome.tokens);
    const result: EvalTaskResult = {
      id: task.id,
      category: task.category,
      pass: verdict.pass,
      failed: verdict.failed,
      tokens: outcome.tokens ?? emptyTotals(),
      ms: now() - t0,
      ...(outcome.model ? { model: outcome.model } : {}),
      ...(estimate ? { estimateUsd: estimate } : {}),
    };
    results.push(result);
    o.onTask?.(result, task);
  }
  const ran = results.filter((r) => !r.skipped);
  const passed = ran.filter((r) => r.pass).length;
  return {
    version: o.version ?? "unversioned",
    label: o.label ?? "eval",
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(now()).toISOString(),
    budgetUsd: budget,
    estimateUsd: Math.round(spent * 1e6) / 1e6,
    totals,
    cacheHitRate: cacheHitRate(totals) ?? null,
    passed,
    failed: ran.length - passed,
    skipped: results.length - ran.length,
    passRate: ran.length ? passed / ran.length : 0,
    tasks: results,
  };
}

/** The one-line summary of a run, for a terminal or a report. */
export function evalSummaryLine(run: EvalRun): string {
  const rate = `${Math.round(run.passRate * 100)}%`;
  const cache = run.cacheHitRate === null ? "no input tokens counted" : `${Math.round(run.cacheHitRate * 100)}% cached`;
  return `${run.label} (set v${run.version}): ${run.passed}/${run.passed + run.failed} passed (${rate}), ${run.skipped} skipped, ${run.totals.calls} model calls, ${run.totals.promptTokens + run.totals.cachedTokens} input tokens, ${run.totals.completionTokens} output tokens, ${cache}. Cost: $${run.estimateUsd.toFixed(4)} (the Agent SDK's own price, an internal estimate for comparing runs, not a bill).`;
}

/**
 * A run that failed a task, or skipped one because its budget ran out, never reports success: the
 * script's exit code comes from here, so a failing run cannot exit 0 again (18 Nov 2026: two runs
 * that scored 0/30 both exited 0, and nothing downstream noticed).
 */
export function evalExitCode(run: EvalRun): number {
  return run.failed > 0 || run.skipped > 0 ? 1 : 0;
}

/** Where results land: a folder on the data volume, outside every checkout, owner-only. */
export function evalResultsDir(dataDir: string): string {
  return path.join(dataDir, "eval");
}

/** Writes one run's results as JSON, owner-only, and returns the path. Never overwrites a file. */
export function writeEvalResult(dir: string, run: EvalRun, at = new Date()): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = at.toISOString().replace(/[:.]/g, "-");
  let file = path.join(dir, `${stamp}-${run.label.replace(/[^a-zA-Z0-9._-]/g, "-")}.json`);
  let n = 1;
  while (fs.existsSync(file)) file = path.join(dir, `${stamp}-${run.label.replace(/[^a-zA-Z0-9._-]/g, "-")}-${n++}.json`);
  fs.writeFileSync(file, `${JSON.stringify(run, null, 2)}\n`, { mode: 0o600 });
  return file;
}

/** The failures grouped by category, so a slice can see which kind of task it broke. */
export function failuresByCategory(run: EvalRun): Array<{ category: EvalCategory; failed: number; ran: number }> {
  return EVAL_CATEGORIES.map((category) => {
    const ran = run.tasks.filter((t) => t.category === category && !t.skipped);
    return { category, ran: ran.length, failed: ran.filter((t) => !t.pass).length };
  }).filter((c) => c.ran > 0);
}
