import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-spend-"));
process.env.DAILY_BUDGET_USD = "10";
// No provider: this suite is about the chat text on Anthropic (where the SDK's list-price cost is
// the bill), and an OpenRouter key in the developer's shell would otherwise turn the meter on and
// make a live call.
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

test("/spend shows today's one figure, the cap, what is left and the split, without calling the model", async () => {
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
  // bill, so it is named as that and the per-job figures under it are real ones.
  assert.match(out, /\$10\.00 spent today \(Anthropic's own list price\), cap \$10\.00, \$0\.00 left, cap is blocking new jobs/);
  assert.match(out, /By kind: engineer \$6\.00, research \$4\.00/);
  assert.match(out, new RegExp(`Top: Big build \\(${big.id}\\) \\$6\\.00, Research one`));
  assert.ok(!out.includes("Research three"), "only the top three");
  assert.match(out, /chat replies are not recorded/);
  assert.ok(!/estimat/i.test(out), "the SDK's estimate is never shown");
  assert.ok(!out.includes("\u2014"), "no em dashes");
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
  assert.match(dayOut, new RegExp(`${day}\\): \\$3\\.25 on jobs \\(Anthropic's own list price\\), cap \\$10\\.00 a day\\.`));
  assert.match(dayOut, /By kind: research \$3\.25/);
  assert.ok(!/estimat/i.test(dayOut), "a past day is a real figure here, never an estimate");
  await orch.handle(FOUNDER, "/spend yesterday", { replyTo: FOUNDER });
  assert.match(sent.pop()!, new RegExp(`Yesterday \\(${addDays(londonYmd(now), -1)}\\): \\$0\\.00`));
  await orch.handle(FOUNDER, "/spend 2026-02-31", { replyTo: FOUNDER });
  assert.match(sent.pop()!, /not a date/);
});

test("/spend never prints the SDK's estimate, only a figure that is the bill", async () => {
  const { orch, sent, add } = setup();
  const now = new Date();
  add("engineer", "Costly build", 25, now); // far past the cap, so the cap blocks
  await orch.handle(FOUNDER, "/spend", { replyTo: FOUNDER });
  const out = sent.join("\n");
  // The only figure is 25, and it is named as Anthropic's own list price, which is the bill there.
  assert.match(out, /\$25\.00 spent today \(Anthropic's own list price\)/);
  assert.ok(!/estimat/i.test(out), "no estimate wording, under any label");
  assert.ok(!/price table/i.test(out), "the SDK's price table is internal only");
});

test("spentToday and /spend share one sum", () => {
  const { jobs, add } = setup();
  add("research", "A", 1.5, new Date());
  add("research", "B", 2, new Date());
  assert.equal(jobs.spentToday(), 3.5);
  assert.equal(jobs.spendOn(londonYmd(new Date())).total, 3.5);
});
