import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-spend-"));
process.env.DAILY_BUDGET_USD = "10";

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
  await orch.handle(FOUNDER.replace("tg:", ""), "/spend", { replyTo: FOUNDER });
  const out = sent.join("\n");
  assert.equal(calls(), 0, "no model call");
  assert.match(out, /\$10\.00 on jobs, cap \$10\.00, \$0\.00 left, cap is blocking new jobs/);
  assert.match(out, /By kind: engineer \$6\.00, research \$4\.00/);
  assert.match(out, new RegExp(`Top: Big build \\(${big.id}\\) \\$6\\.00, Research one`));
  assert.ok(!out.includes("Research three"), "only the top three");
  assert.match(out, /Known gap: .*chat/);
  assert.ok(!out.includes("—"), "no em dashes");
});

test("/spend yesterday and /spend YYYY-MM-DD use that London day; bad dates are refused", async () => {
  const { orch, sent, add } = setup();
  const now = new Date();
  const ago = new Date(now.getTime() - 24 * 3_600_000 * 3);
  add("research", "Old research", 3.25, ago);
  add("research", "Today research", 1, now);
  const day = londonYmd(ago);
  await orch.handle("99887766", `/spend ${day}`, { replyTo: FOUNDER });
  assert.match(sent.pop()!, new RegExp(`${day}\\): \\$3\\.25 on jobs, daily cap \\$10\\.00\\.\\nBy kind: research \\$3\\.25`));
  await orch.handle("99887766", "/spend yesterday", { replyTo: FOUNDER });
  assert.match(sent.pop()!, new RegExp(`Yesterday \\(${addDays(londonYmd(now), -1)}\\): \\$0\\.00`));
  await orch.handle("99887766", "/spend 2026-02-31", { replyTo: FOUNDER });
  assert.match(sent.pop()!, /not a date/);
});

test("spentToday and /spend share one sum", () => {
  const { jobs, add } = setup();
  add("research", "A", 1.5, new Date());
  add("research", "B", 2, new Date());
  assert.equal(jobs.spentToday(), 3.5);
  assert.equal(jobs.spendOn(londonYmd(new Date())).total, 3.5);
});
