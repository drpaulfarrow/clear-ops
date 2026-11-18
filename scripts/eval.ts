/**
 * The efficiency baseline (slice 1 of the programme, 13 Nov 2026): the versioned thirty-task set
 * (eval/tasks.v1.json) run through the scoring harness (src/eval.ts), with the pass rate, the tokens
 * and the cost per run written down so a later slice can compare itself with the one before it.
 *
 * Two ways to run it, and the safe one is the default:
 *
 *   npm run eval                       recorded mode: every task is answered from the fixture file of
 *                                      recorded answers (eval/recorded.v1.json), so the run needs no
 *                                      model key, makes no network call and spends nothing. It proves
 *                                      the set, the judge and the accounting, and reports the pass
 *                                      rate and cost of the recorded answers. Those numbers describe
 *                                      the recording, not the live chief: only --live measures the
 *                                      harness itself.
 *   npm run eval -- --live             live mode: each task goes through the real chief exactly as
 *                                      Paul's chat does (the same system prompt and tools via
 *                                      sdkRunner, the configured chief model, config.models.chief, the
 *                                      cheapest tier by default), stopped once the internal estimate
 *                                      passes EVAL_BUDGET_USD. Real money; a hand-run tool.
 *   npm run eval -- --label caching-1  name this run so a later slice compares like with like
 *   EVAL_TASKS=eval/tasks.v2.json npm run eval     a different versioned set
 *
 * Results land in <DATA_DIR>/eval/<time>-<label>.json, owner-only: the pass rate, the names of the
 * checks that failed, the tokens, and the Agent SDK's own price for the run, which is an internal
 * ESTIMATE for comparing runs, never a bill (the chief's chat turns carry no cap meter, so it is the
 * only per-task figure there is). No answer text is written down anywhere. The tasks themselves are
 * public or about our own repositories: none touches Paul's mail, calendar or uploads. See
 * docs/EVALS.md.
 */
import fs from "node:fs";
import { config } from "../src/config.js";
import { buildApp } from "../src/index.js";
import { Store } from "../src/store.js";
import { ConsoleMessenger } from "../src/whatsapp.js";
import { sdkRunner } from "../src/agents.js";
import { evalExitCode, evalResultsDir, evalSummaryLine, failuresByCategory, loadEvalSet, runEvalSet, writeEvalResult, type EvalRunResult, type EvalTask } from "../src/eval.js";
import { emptyTotals, type UsageTotals } from "../src/telemetry.js";

const label = argValue("--label") ?? process.env.EVAL_LABEL ?? (isLive() ? "manual" : "recorded");
const budgetUsd = Number(process.env.EVAL_BUDGET_USD ?? "2");

/** One recorded answer: what a run of the task produced, numbers included, so nothing is invented live. */
interface RecordedAnswer {
  text: string;
  tokens: Partial<UsageTotals>;
  /** The Agent SDK's own price that run reported. Internal only, never a bill. */
  estimateUsd?: number;
}

const set = loadEvalSet();
console.log(`Running eval set v${set.version} (${set.tasks.length} tasks), label "${label}", ${isLive() ? `LIVE: real chief, real spend, budget $${budgetUsd.toFixed(2)} of internal estimate` : "recorded mode: answers from the fixture file, no model called, nothing spent"}.`);

const run = isLive() ? await liveRunner() : recordedRunner();

const result = await runEvalSet({
  tasks: set.tasks,
  version: set.version,
  label,
  budgetUsd,
  onTask: (r, task) => console.log(`${r.skipped ? "skip" : r.pass ? "pass" : "FAIL"} ${task.id}${r.failed.length ? ` (${r.failed.join("; ")})` : ""} ${r.ms}ms`),
  run,
});

const file = writeEvalResult(evalResultsDir(config.dataDir), result);
console.log(`\n${evalSummaryLine(result)}`);
if (!isLive()) console.log("Recorded mode: these numbers describe the fixture file, not the live chief; run with --live for a real baseline.");
for (const c of failuresByCategory(result)) if (c.failed) console.log(`  ${c.category}: ${c.failed}/${c.ran} failed`);
console.log(`Results: ${file}`);
// A failing run never reports success: the exit code says what the score says (src/eval.ts).
process.exit(evalExitCode(result));

function isLive(): boolean {
  return process.argv.includes("--live") || process.env.EVAL_LIVE === "1";
}

/** The recorded answers, read once; a task with no recording fails the run rather than being skipped. */
function recordedRunner() {
  const file = process.env.EVAL_RECORDED ?? new URL("../eval/recorded.v1.json", import.meta.url).pathname;
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { answers?: Record<string, RecordedAnswer> };
  const recorded = parsed.answers;
  if (!recorded) throw new Error(`${file} has no "answers" object; a recording is a map from task id to recorded answer`);
  return async (task: EvalTask): Promise<EvalRunResult> => {
    const answer = recorded[task.id];
    if (!answer) throw new Error(`no recorded answer for task ${task.id} in ${file}`);
    const tokens = { ...emptyTotals(), ...answer.tokens };
    return { text: answer.text, tokens, ...(answer.estimateUsd !== undefined ? { estimateUsd: answer.estimateUsd } : {}), model: "recorded" };
  };
}

/**
 * The live runner: the tasks are asked through the real orchestrator, as Paul's chat asks them, with
 * one instruction added (answer here, do not start a job) so there is an answer to judge. What each
 * task used is read from the chat usage the service records (src/telemetry.ts): the tokens, and the
 * Agent SDK's internal estimate, which is all there is per task on OpenRouter.
 */
async function liveRunner() {
  const store = new Store(config.dataDir);
  const messenger = new ConsoleMessenger(false);
  const { orchestrator } = buildApp({ messenger, runner: sdkRunner, store });
  const sender = config.allowedNumbers[0] ?? config.allowedTelegramIds[0] ?? config.allowedDiscordIds[0] ?? "eval";
  if (!config.allowedNumbers.includes(sender)) config.allowedNumbers.push(sender);
  // A finished job for the job-status tasks to read, so they measure the harness rather than an empty store.
  const seed = store.createJob("research", "Eval seed job. It exists only so the eval's job-status tasks have a finished job to read.", sender, "product", undefined, { title: "Eval seed" });
  store.updateJob(seed.id, { status: "done", finishedAt: new Date().toISOString(), summary: "Eval seed job, finished. Nothing was run." });
  const chatTotals = (): UsageTotals => store.chatUsage()?.usage.totals ?? emptyTotals();
  const chatEstimate = (): number => store.chatUsage()?.usage.estimateUsd ?? 0;
  const delta = (before: UsageTotals, after: UsageTotals): UsageTotals => {
    const out = emptyTotals();
    for (const k of Object.keys(out) as Array<keyof UsageTotals>) out[k] = Math.max(0, after[k] - before[k]);
    return out;
  };
  return async (_task: EvalTask, prompt: string): Promise<EvalRunResult> => {
    const before = chatTotals();
    const beforeEstimate = chatEstimate();
    const mark = messenger.sent.length;
    await orchestrator.handle(sender, `${prompt}\n\n(Answer this yourself in one short reply, from your own knowledge, the repositories and search. Do not start a job.)`);
    const replies = messenger.sent.slice(mark).filter((m) => m.to === sender);
    const text = replies.length ? replies[replies.length - 1]!.text : "";
    return { text, tokens: delta(before, chatTotals()), estimateUsd: Math.max(0, chatEstimate() - beforeEstimate), model: config.models.chief };
  };
}

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
