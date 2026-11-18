import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-telemetry-"));

const { Store } = await import("../src/store.js");
const { JobRunner } = await import("../src/jobs.js");
const { ConsoleMessenger } = await import("../src/whatsapp.js");
const T = await import("../src/telemetry.js");
import type { AgentRunner, RunResult } from "../src/agents.js";


const FOUNDER = "tg:99887766";

const waitFor = async (pred: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

const assistantUsage = {
  input_tokens: 100,
  output_tokens: 40,
  cache_read_input_tokens: 900,
  cache_creation_input_tokens: 50,
  output_tokens_details: { thinking_tokens: 12 },
};

test("a call record is the numbers only, and a private kind keeps no tool names", () => {
  const call = T.callFromAssistant({
    at: 1000,
    role: "worker",
    model: "deepseek/deepseek-v4.1-flash",
    provider: "openrouter",
    usage: assistantUsage,
    tools: ["WebSearch", "Read"],
    latencyMs: 1234.6,
  });
  assert.equal(call.promptTokens, 100);
  assert.equal(call.cachedTokens, 900);
  assert.equal(call.cacheWriteTokens, 50);
  assert.equal(call.completionTokens, 40);
  assert.equal(call.reasoningTokens, 12);
  assert.equal(call.toolCalls, 2);
  assert.deepEqual(call.tools, ["WebSearch", "Read"]);
  assert.equal(call.latencyMs, 1235);
  // No provider reports a per-call price, so a call carries no cost and says which figure that is.
  assert.equal(call.costSource, "unavailable");
  assert.equal((call as Record<string, unknown>).costUsd, undefined);

  // An assistant job works over Paul's mail and calendar: the count is kept, the names are not.
  const privateCall = T.callFromAssistant({
    at: 1000,
    role: "assistant",
    model: "claude-sonnet-4-5",
    provider: "anthropic",
    usage: assistantUsage,
    tools: ["gmail_search", "calendar_agenda"],
    private: true,
  });
  assert.equal(privateCall.toolCalls, 2);
  assert.equal(privateCall.tools, undefined);
});

test("missing or nonsense token counts are zero, never a guess", () => {
  const call = T.callFromAssistant({
    at: 0,
    role: "worker",
    model: "m",
    provider: "openrouter",
    usage: { input_tokens: null, output_tokens: -5, cache_read_input_tokens: Number.NaN },
  });
  assert.deepEqual([call.promptTokens, call.cachedTokens, call.cacheWriteTokens, call.completionTokens], [0, 0, 0, 0]);
  assert.equal(call.reasoningTokens, undefined);
  assert.equal(call.latencyMs, undefined);
});

test("totals, the cache hit rate and the call cap", () => {
  const calls = [
    T.callFromAssistant({ at: 1, role: "worker", model: "m", provider: "openrouter", usage: { input_tokens: 100, cache_read_input_tokens: 300, output_tokens: 20 } }),
    T.callFromAssistant({ at: 2, role: "worker", model: "m", provider: "openrouter", usage: { input_tokens: 100, cache_read_input_tokens: 100, output_tokens: 30 } }),
  ];
  const totals = T.totalsOf(calls);
  assert.equal(totals.calls, 2);
  assert.equal(totals.promptTokens, 200);
  assert.equal(totals.cachedTokens, 400);
  assert.equal(totals.completionTokens, 50);
  assert.equal(T.cacheHitRate(totals), 400 / 600);
  assert.equal(T.percent(400 / 600), "67%");
  // No input tokens at all: no rate is invented.
  assert.equal(T.cacheHitRate(T.emptyTotals()), undefined);
  assert.match(T.tokenLine(totals), /cache hit rate 67%/);

  const many = Array.from({ length: 5 }, (_, i) => T.callFromAssistant({ at: i, role: "worker", model: "m", provider: "openrouter", usage: assistantUsage }));
  const capped = T.capCalls(many, 2);
  assert.equal(capped.calls.length, 2);
  assert.equal(capped.callsOmitted, 3);
});

test("a job's cost is named for the figure it is, and an estimate is never shown", () => {
  const base = { role: "worker" as const, calls: [], totals: T.emptyTotals() };

  // OpenRouter, nothing read: the cap meter priced none of the calls (no cap was counting, or the
  // provider had published nothing), so there is no figure and the note says so. The SDK's own price
  // is kept internally (it is what a later slice compares against) and never appears in a line.
  const or = T.jobUsageFromRun({ ...base, provider: "openrouter", estimateUsd: 0.4213 });
  assert.equal(or.costSource, "unavailable");
  assert.equal(or.costUsd, undefined);
  assert.equal(or.estimateUsd, 0.4213);
  assert.equal(or.costNote, T.NO_PER_JOB_FIGURE);
  const orLine = T.jobCostLine(or);
  assert.match(orLine, /no figure/);
  assert.doesNotMatch(orLine, /0\.4213/);
  assert.doesNotMatch(orLine, /\$0\.42/);
  // A meter that read nothing changes nothing: an unavailable reading is not a figure.
  const none = T.jobUsageFromRun(
    { ...base, provider: "openrouter" },
    { realCost: { usd: 0, calls: 3, read: 0, source: "unavailable", note: "OpenRouter has not priced this job's 3 calls yet" } },
  );
  assert.equal(none.costSource, "unavailable");
  assert.equal(none.costUsd, undefined);
  assert.equal(none.costNote, T.NO_PER_JOB_FIGURE);
  assert.match(T.jobCostLine(none), /no figure/);

  // OpenRouter, the cap meter read the provider's own per-call figures: that is the job's figure,
  // named as the provider's, and a lower bound is labelled as one rather than passed off as complete.
  const read = T.jobUsageFromRun(
    { ...base, provider: "openrouter", estimateUsd: 0.4213 },
    { realCost: { usd: 0.31, calls: 12, read: 11, source: "provider", note: "OpenRouter priced 11 of this job's 12 calls, so the figure is a lower bound" } },
  );
  assert.equal(read.costSource, "provider");
  assert.equal(read.costUsd, 0.31);
  assert.equal(read.estimateUsd, 0.4213);
  const readLine = T.jobCostLine(read);
  assert.match(readLine, /\$0\.3100 \(the provider's own figure/);
  assert.match(readLine, /lower bound/);
  assert.doesNotMatch(readLine, /0\.4213/);

  // Anthropic directly: the SDK's price is Anthropic's own list price, which is the bill there.
  const an = T.jobUsageFromRun({ ...base, provider: "anthropic", costUsd: 0.5, estimateUsd: 0.5 });
  assert.equal(an.costSource, "anthropic");
  assert.equal(an.costUsd, 0.5);
  assert.match(T.jobCostLine(an), /Anthropic's own list price/);

  const stopped = T.jobUsageFromRun({ ...base, provider: "openrouter" }, { partial: true });
  assert.equal(stopped.partial, true);
  assert.match(T.jobUsageLines({ id: "16d5d3", kind: "research", title: "TollBit research", usage: stopped }).join("\n"), /partial/);
});

test("the per-job view names the job, its role, its models and its tokens, and never a brief", () => {
  const usage = T.jobUsageFromRun({
    role: "engineer",
    provider: "openrouter",
    calls: [T.callFromAssistant({ at: 1, role: "engineer", model: "z-ai/glm-5.3", provider: "openrouter", usage: assistantUsage, tools: ["Bash"] })],
    totals: T.totalsOf([T.callFromAssistant({ at: 1, role: "engineer", model: "z-ai/glm-5.3", provider: "openrouter", usage: assistantUsage, tools: ["Bash"] })]),
    durationMs: 4321,
    numTurns: 7,
  });
  const lines = T.jobUsageLines({ id: "abc123", kind: "engineer", title: "Fly deploy", finishedAt: "2026-11-13T09:00:00.000Z", usage });
  const text = lines.join("\n");
  assert.match(text, /Job abc123 \(engineer\) "Fly deploy"/);
  assert.match(text, /Role: engineer. Provider: OpenRouter. Models: z-ai\/glm-5\.3./);
  assert.match(text, /1 model call, 100 prompt tokens \(900 from cache, 50 written to it\), 40 completion tokens \(12 reasoning\), 1 tool call/);
  assert.match(text, /Run time: 4321 ms, 7 turns/);
});

test("the day report says whose money figure it is, and says so when there is none", () => {
  const usage = T.jobUsageFromRun({
    role: "worker",
    provider: "openrouter",
    calls: [],
    totals: { ...T.emptyTotals(), calls: 3, promptTokens: 10, cachedTokens: 90, completionTokens: 5, toolCalls: 2 },
    estimateUsd: 0.9876,
  });
  const jobs = [
    { id: "aaa111", kind: "research" as const, title: "SPUR research", usage },
    { id: "bbb222", kind: "engineer" as const, title: "Fly deploy", usage },
  ];
  const read = T.usageLines({ ymd: "2026-11-13", label: "Today", spend: { usd: 3.5, source: "provider" }, jobs });
  const text = read.join("\n");
  assert.match(text, /Today \(2026-11-13\): \$3\.50 \(OpenRouter's own figure\)/);
  assert.match(text, /No cost per kind or top jobs by cost: a job's money figure is the provider's own only where its cap meter read one/);
  assert.match(text, /Tokens per kind: research 105, engineer 105\./);
  assert.match(text, /The chief's own chat turns are not recorded for that day/);
  // Nothing the SDK priced appears in anything Paul can read: the internal estimate is in the record,
  // and not one figure of it reaches a line.
  assert.doesNotMatch(text, /0\.9876|\$0\.99/);
  assert.doesNotMatch(text, /\$0\.00/);

  // The provider cannot be read: the line says so and shows no substitute.
  const unreadable = T.usageLines({ ymd: "2026-11-13", label: "Today", spend: { usd: 0, source: "estimate", note: "the usage endpoint could not be read" }, jobs });
  assert.match(unreadable[0], /no spend figure \(the usage endpoint could not be read\)/);
  assert.doesNotMatch(unreadable[0], /\$0\.00/);

  // Anthropic: the SDK's price is the bill, so a per-kind split and top jobs are real and shown.
  const priced = jobs.map((j) => ({ ...j, usage: { ...j.usage!, costSource: "anthropic" as const, costUsd: 1.25, provider: "anthropic" as const } }));
  const anthropic = T.usageLines({ ymd: "2026-11-13", label: "Today", spend: { usd: 2.5, source: "anthropic" }, jobs: priced });
  assert.match(anthropic.join("\n"), /Cost per kind \(Anthropic's own list price\): research \$1\.25, engineer \$1\.25\./);
  assert.match(anthropic.join("\n"), /Top jobs by cost: SPUR research \(aaa111\) \$1\.25/);
});

test("the JSON view names the source of every figure and carries no prompt, brief or answer", () => {
  const usage = T.jobUsageFromRun({
    role: "worker",
    provider: "openrouter",
    calls: [],
    totals: { ...T.emptyTotals(), calls: 1, promptTokens: 5, completionTokens: 2 },
    estimateUsd: 0.03,
  });
  const json = T.usageJson({ ymd: "2026-11-13", label: "Today", spend: { usd: 1, source: "provider" }, jobs: [{ id: "aaa111", kind: "research", title: "SPUR research", usage }] });
  const text = JSON.stringify(json);
  assert.equal((json.jobs as Array<{ costUsd: number | null }>)[0].costUsd, null);
  assert.equal((json.jobs as Array<{ costSource: string }>)[0].costSource, "unavailable");
  // The internal estimate is written down for a later slice to compare, and named as what it is.
  assert.equal((json.jobs as Array<{ estimateUsd: number | null }>)[0].estimateUsd, 0.03);
  assert.match(text, /estimateUsd/);
  for (const forbidden of ["brief", "prompt", "output", "answer"]) assert.doesNotMatch(text, new RegExp(`"${forbidden}"`, "i"));
});

test("the chief's own turns merge into today's record and start again tomorrow", () => {
  const one = T.jobUsageFromRun({ role: "chief", provider: "openrouter", calls: [], totals: { ...T.emptyTotals(), calls: 1, promptTokens: 10, completionTokens: 3 }, estimateUsd: 0.01 });
  const two = T.jobUsageFromRun({ role: "chief", provider: "openrouter", calls: [], totals: { ...T.emptyTotals(), calls: 2, promptTokens: 20, completionTokens: 4 }, estimateUsd: 0.02 });
  const day1 = T.mergeChatUsage(undefined, "2026-11-13", one);
  assert.equal(day1.usage.totals.calls, 1);
  const same = T.mergeChatUsage(day1, "2026-11-13", two);
  assert.equal(same.usage.totals.calls, 3);
  assert.equal(same.usage.totals.promptTokens, 30);
  assert.equal(same.usage.estimateUsd, 0.03);
  // A new London day replaces the record rather than growing without bound.
  const day2 = T.mergeChatUsage(same, "2026-11-14", one);
  assert.equal(day2.ymd, "2026-11-14");
  assert.equal(day2.usage.totals.calls, 1);
  assert.equal(day2.usage.estimateUsd, 0.01);
});

test("the recorder keeps what a run has used so far, and stops at its cap", () => {
  const r = new T.UsageRecorder(2);
  assert.equal(r.empty, true);
  for (let i = 0; i < 3; i++) r.add(T.callFromAssistant({ at: i, role: "worker", model: "m", provider: "openrouter", usage: assistantUsage }));
  const s = r.summary();
  assert.equal(r.empty, false);
  assert.equal(s.totals.calls, 3);
  assert.equal(s.calls.length, 2);
  assert.equal(s.callsOmitted, 1);
});

test("a finished job's usage is stored with it, survives a reload, and never holds a brief", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-telemetry-job-"));
  const store = new Store(dir);
  const messenger = new ConsoleMessenger();
  const call = T.callFromAssistant({ at: 1, role: "worker", model: "m", provider: "openrouter", usage: assistantUsage, tools: ["WebSearch"] });
  const runner: AgentRunner = async (o) => {
    o.onCall?.(T.callFromAssistant({ at: 1, role: "worker", model: "m", provider: "openrouter", usage: assistantUsage, tools: ["WebSearch"] }));
    const result: RunResult = {
      text: "VERDICT: done\n\n<message_to_paul>All good.</message_to_paul>",
      costUsd: 0.12,
      usage: { role: "worker", provider: "openrouter", calls: [call], totals: T.totalsOf([call]), durationMs: 10, estimateUsd: 0.12 },
    };
    return result;
  };
  const jobs = new JobRunner(store, messenger, runner);
  const job = jobs.start("research", "A brief that must never be recorded in the figures.", FOUNDER);
  await waitFor(() => store.getJob(job.id)!.status === "done");
  const stored = store.getJob(job.id)!;
  assert.ok(stored.usage, "the job keeps its usage record");
  assert.equal(stored.usage!.totals.calls, 1);
  assert.equal(stored.usage!.totals.cachedTokens, 900);
  assert.equal(stored.usage!.estimateUsd, 0.12);
  assert.equal(stored.usage!.costSource, "unavailable");

  // A restart reads the same record back from the store on disk.
  const reloaded = new Store(dir).getJob(job.id)!;
  assert.equal(reloaded.usage!.totals.calls, 1);
  assert.equal(reloaded.usage!.totals.promptTokens, 100);
  const text = JSON.stringify(reloaded.usage);
  assert.doesNotMatch(text, /must never be recorded/);
  assert.doesNotMatch(text, /All good/);
});

test("an executive-assistant job records counts and never a tool name", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-telemetry-ea-"));
  const store = new Store(dir);
  const messenger = new ConsoleMessenger();
  const runner: AgentRunner = async (o) => {
    const call = T.callFromAssistant({ at: 1, role: "assistant", model: "claude-sonnet-4-5", provider: "anthropic", usage: assistantUsage, tools: ["gmail_search", "calendar_agenda"], private: true });
    o.onCall?.(call);
    return { text: "VERDICT: done\n\n<message_to_paul>Drafted.</message_to_paul>", costUsd: 0.2, usage: { role: "assistant", provider: "anthropic", calls: [call], totals: T.totalsOf([call]), costUsd: 0.2, estimateUsd: 0.2 } };
  };
  const jobs = new JobRunner(store, messenger, runner);
  const job = jobs.start("ea", "Check Sam's email about the pilot contract.", FOUNDER);
  await waitFor(() => store.getJob(job.id)!.status === "done");
  const usage = store.getJob(job.id)!.usage!;
  assert.equal(usage.role, "assistant");
  assert.equal(usage.totals.toolCalls, 2);
  assert.equal(usage.calls[0].tools, undefined);
  const text = JSON.stringify(usage);
  assert.doesNotMatch(text, /gmail_search|calendar_agenda|Sam|pilot contract/);
  // Anthropic directly: the recorded cost is its own list price, which is the bill there.
  assert.equal(usage.costSource, "anthropic");
  assert.equal(usage.costUsd, 0.2);
});

test("a job that is stopped keeps what it had used, marked partial", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-telemetry-stop-"));
  const store = new Store(dir);
  const messenger = new ConsoleMessenger();
  // A worker that made one call and then went quiet: the watchdog stops it, and what it used is kept.
  const runner: AgentRunner = async (o) => {
    o.onCall?.(T.callFromAssistant({ at: 1, role: "worker", model: "m", provider: "openrouter", usage: assistantUsage }));
    return new Promise<RunResult>((resolve) => o.abortController?.signal.addEventListener("abort", () => resolve({ text: "" })));
  };
  const jobs = new JobRunner(store, messenger, runner, undefined, { liveness: { stallMs: 1 } });
  const job = jobs.start("research", "Stop me.", FOUNDER);
  await waitFor(() => store.getJob(job.id)!.status === "running");
  await new Promise((r) => setTimeout(r, 30));
  await jobs.checkLiveness();
  await waitFor(() => store.getJob(job.id)!.status === "failed");
  const usage = store.getJob(job.id)!.usage!;
  assert.equal(usage.partial, true);
  assert.equal(usage.totals.calls, 1);
});
