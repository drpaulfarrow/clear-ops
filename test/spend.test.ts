import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-spend-"));
process.env.DAILY_BUDGET_USD = "10";
// No provider: this suite is about the estimate and the chat text, and an OpenRouter key in the
// developer's shell would otherwise turn the meter on and make a live call.
process.env.OPENROUTER_API_KEY = "";

const { Store } = await import("../src/store.js");
const { JobRunner } = await import("../src/jobs.js");
const { Orchestrator } = await import("../src/orchestrator.js");
const { Scheduler } = await import("../src/scheduler.js");
const { ConsoleMessenger } = await import("../src/whatsapp.js");
const { londonYmd, addDays } = await import("../src/london.js");
import type { AgentRunner } from "../src/agents.js";

const FOUNDER = "tg:99887766";

function setup() {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-spend-")));
  const messenger = new ConsoleMessenger();
  const sent: string[] = [];
  messenger.send = async (_to: string, text: string) => {
    sent.push(text);
  };
  let modelCalls = 0;
  const runner: AgentRunner = async () => {
    modelCalls++;
    return { text: "done" };
  };
  const jobs = new JobRunner(store, messenger, runner);
  const orch = new Orchestrator(store, messenger, jobs, new Scheduler(store, jobs), runner);
  const add = (kind: "research" | "engineer", title: string, cost: number, at: Date) => {
    const j = store.createJob(kind, title, FOUNDER, "product", undefined, { title });
    store.updateJob(j.id, { status: "done", costUsd: cost, finishedAt: at.toISOString() });
    return j;
  };
  return { store, jobs, orch, sent, add, calls: () => modelCalls };
}

test("/spend shows today's total, cap, what is left, breakdown and top 3, without calling the model", async () => {
  const { orch, sent, add, calls } = setup();
  const now = new Date();
  const big = add("engineer", "Big build", 6, now);
  add("research", "Research one", 2.5, now);
  add("research", "Research two", 1, now);
  add("research", "Research three", 0.5, now);
  add("engineer", "Yesterday build", 4, new Date(now.getTime() - 36 * 3_600_000));
  await orch.handle(FOUNDER, "/spend", { replyTo: FOUNDER });
  const out = sent.join("\n");
  assert.equal(calls(), 0, "no model call");
  // With no OpenRouter key the workforce runs on Anthropic, where the SDK's list-price cost is the
  // bill, so it is named as that rather than as an estimate.
  assert.match(out, /\$10\.00 spent today \(Anthropic's own list price\), cap \$10\.00, \$0\.00 left, cap is blocking new jobs/);
  assert.match(out, /By kind \(estimated\): engineer \$6\.00, research \$4\.00/);
  assert.match(out, new RegExp(`Top: Big build \\(${big.id}\\) \\$6\\.00 estimated, Research one`));
  assert.ok(!out.includes("Research three"), "only the top three");
  assert.match(out, /Known gaps: .*chat/);
  assert.ok(!out.includes("—"), "no em dashes");
});

test("/spend yesterday and /spend YYYY-MM-DD use that London day; bad dates are refused", async () => {
  const { orch, sent, add } = setup();
  const now = new Date();
  const ago = new Date(now.getTime() - 24 * 3_600_000 * 3);
  add("research", "Old research", 3.25, ago);
  add("research", "Today research", 1, now);
  const day = londonYmd(ago);
  await orch.handle(FOUNDER, `/spend ${day}`, { replyTo: FOUNDER });
  const dayOut = sent.pop()!;
  assert.match(dayOut, new RegExp(`${day}\\): \\$3\\.25 on jobs, daily cap \\$10\\.00\\.`));
  assert.match(dayOut, /By kind \(estimated\): research \$3\.25/);
  assert.match(dayOut, /OpenRouter's usage is read for today only/, "a past day says the figure is an estimate");
  await orch.handle(FOUNDER, "/spend yesterday", { replyTo: FOUNDER });
  assert.match(sent.pop()!, new RegExp(`Yesterday \\(${addDays(londonYmd(now), -1)}\\): \\$0\\.00`));
  await orch.handle(FOUNDER, "/spend 2026-02-31", { replyTo: FOUNDER });
  assert.match(sent.pop()!, /not a date/);
});

test("/spend names where each job's own figure came from, so an estimate is never shown as the bill", async () => {
  const { orch, sent, add, store } = setup();
  const now = new Date();
  const charged = add("research", "Charged job", 3, now);
  add("research", "Estimated job", 2, now);
  store.updateJob(charged.id, { costSource: "provider" });
  await orch.handle(FOUNDER, "/spend", { replyTo: FOUNDER });
  const out = sent.join("\n");
  assert.match(out, new RegExp(`Charged job \\(${charged.id}\\) \\$3\\.00 charged`));
  assert.match(out, /Estimated job \(\w+\) \$2\.00 estimated/);
});

test("spentToday and /spend share one sum", () => {
  const { jobs, add } = setup();
  add("research", "A", 1.5, new Date());
  add("research", "B", 2, new Date());
  assert.equal(jobs.spentToday(), 3.5);
  assert.equal(jobs.spendOn(londonYmd(new Date())).total, 3.5);
});
