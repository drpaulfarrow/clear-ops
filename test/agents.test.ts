/**
 * One agent's page in the web app (`appAgent` in src/app-data.ts): who it is, what it may use, and how
 * it has been doing. It is read-only and says nothing the records do not: outcomes are counted apart
 * (finished is not the same as done), money is the provider's own figure or absent, and an agent's
 * prompt is never part of it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-agents-"));

const { Store } = await import("../src/store.js");
const { appAgent, APP_AGENT_JOBS } = await import("../src/app-data.js");
const { workerSpec, runLimits } = await import("../src/agents.js");
const { AGENT_NAMES } = await import("../src/messages.js");

const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const at = (minsAgo: number) => new Date(NOW - minsAgo * 60_000).toISOString();
const PAUL = "tg:99887766";
const queue = { isHeld: () => false, queuePosition: () => undefined, latestStep: () => undefined, liveness: () => undefined, spendState: () => ({ usd: 0, source: "provider" as const, asOf: NOW }), capReached: () => false };
const DAY = 24 * 60;

function world() {
  const s = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-agents-store-")));
  const mk = (kind: string, title: string, patch: Record<string, unknown>, target = "product") => s.updateJob(s.createJob(kind as never, `Brief for ${title}`, PAUL, target as never, PAUL, { title } as never).id, patch as never);
  const agent = (kind: string) => appAgent({ store: s, queue, now: NOW }, kind);
  return { s, mk, agent };
}

test("an agent's page says who it is, what it may use and how far one job may run", () => {
  const { agent } = world();
  const fitz = agent("engineer")!;
  assert.deepEqual([fitz.kind, fitz.name, fitz.role, fitz.does], ["engineer", AGENT_NAMES.engineer, "engineer", "writes the change on a branch and opens a pull request"]);
  assert.deepEqual(fitz.now, { state: "idle", line: "Idle" });
  assert.deepEqual(fitz.tools, ["Read files", "Edit and write files", "Search files", "Run commands", "Search the web", "Read web pages"]);
  assert.equal(fitz.refused, workerSpec("engineer").disallowedTools!.length);
  assert.equal(fitz.limits!.maxTurns, runLimits("engineer").maxTurns);
  assert.match(fitz.modelNote, /The engineers' model, which you can change on the Spend page\./);
  // A worker held to a few commands, and ones with tools of their own, in plain words.
  assert.deepEqual(agent("analyse")!.tools, ["Read files", "Search files", "Run python3 only", "Run node only"]);
  assert.ok(agent("design")!.tools.includes("Take screenshots of a site"));
  assert.ok(agent("dns")!.tools.includes("Your GoDaddy DNS: read, and prepare changes for you to approve"));
  // The assistant's model is not one the app changes.
  const ea = agent("ea")!;
  assert.match(ea.model!, /^anthropic\//);
  assert.match(ea.modelNote, /Always Claude, on Anthropic's API directly\. It is not changed from the app\./);
  assert.ok(ea.tools.includes("Your Gmail and Calendar, within its permits"));
  // A kind with no name of its own is still an agent.
  assert.deepEqual([agent("write")!.name, agent("write")!.role], [undefined, "writer"]);
  // The chief runs no jobs: no limits, no record, no jobs.
  const chief = agent("chief")!;
  assert.deepEqual([chief.name, chief.role, chief.limits, chief.windows, chief.jobs, chief.now], [AGENT_NAMES.chief, "chief", undefined, [], [], { state: "here", line: "With you" }]);
  // Anything else is no agent at all.
  for (const bad of ["", "nobody", "Engineer", "engineer/", "../engineer", "engineer ", "x".repeat(40), "__proto__", "constructor"]) assert.equal(agent(bad), undefined, JSON.stringify(bad));
  // The page never carries an agent's prompt, a path on disk or a key.
  const sent = JSON.stringify([fitz, ea, chief, agent("maintain")]);
  assert.doesNotMatch(sent, /clean room|comp-exchange|REPORT|\/data\/|\/repos\/|cwd|prompt|apiKey/i);
});

test("an agent's record counts outcomes apart, and its money is the provider's own or absent", () => {
  const { s, mk, agent } = world();
  const usage = (usd: number) => ({ costUsd: usd, costSource: "provider", costByModel: [{ model: "z-ai/glm-5.3", usd, calls: 4 }] });
  // Today: one marked done by Paul, one that says it needs him, one failed, one with nothing confirming it.
  mk("research", "Confirmed", { status: "done", startedAt: at(100), finishedAt: at(90), verdict: { met: true, at: at(80) }, usage: usage(0.5) });
  mk("research", "Needs him", { status: "done", startedAt: at(70), finishedAt: at(60), claimed: { state: "needs_paul", detail: "which account" }, usage: usage(0.25) });
  mk("research", "Failed", { status: "failed", startedAt: at(50), finishedAt: at(45), failure: "stalled" });
  mk("research", "Unconfirmed", { status: "done", startedAt: at(40), finishedAt: at(30), costUsd: 9.99, usage: { costUsd: 8.88, costSource: "estimate" } });
  // Three days ago: in the week, not in the day.
  mk("research", "Earlier", { status: "done", startedAt: at(3 * DAY + 20), finishedAt: at(3 * DAY), verdict: { met: false, at: at(3 * DAY - 5) }, usage: usage(1) });
  // Too old for either, another kind, and one still running.
  mk("research", "Long ago", { status: "done", startedAt: at(20 * DAY + 20), finishedAt: at(20 * DAY), usage: usage(50) });
  mk("write", "Someone else's", { status: "done", startedAt: at(20), finishedAt: at(10), usage: usage(7) });
  const live = mk("research", "Running now", { status: "running", startedAt: at(5) });

  const scout = agent("research")!;
  const [day, week] = scout.windows;
  assert.deepEqual([day!.label, day!.finished, day!.met, day!.waiting, day!.notMet, day!.unconfirmed], ["last 24 hours", 4, 1, 1, 1, 1]);
  assert.deepEqual([week!.label, week!.finished, week!.met, week!.waiting, week!.notMet, week!.unconfirmed], ["last 7 days", 5, 1, 1, 2, 1]);
  assert.equal(day!.met + day!.waiting + day!.notMet + day!.unconfirmed, day!.finished, "every finished job is counted once");
  // Money: only the provider's own figures are added, and it says how many jobs that covers. The SDK's estimate is not among them.
  assert.deepEqual([day!.costUsd, day!.costedJobs], [0.75, 2]);
  assert.deepEqual([week!.costUsd, week!.costedJobs], [1.75, 3]);
  assert.match(day!.why!, /stalled/i);
  assert.match(day!.run!, /^run time: /);
  assert.ok(!JSON.stringify(scout).includes("9.99") && !JSON.stringify(scout).includes("8.88"));
  // What it is doing now is the roster's own line, and its newest jobs come first.
  assert.deepEqual(scout.now, { state: "working", line: "Working on Running now", jobId: live.id });
  assert.deepEqual(scout.jobs.map((j) => j.title).slice(0, 3), ["Running now", "Unconfirmed", "Failed"]);
  assert.ok(scout.jobs.every((j) => j.kind === "research"));
  for (let i = 0; i < APP_AGENT_JOBS + 5; i++) mk("research", `More ${i}`, { status: "done", startedAt: at(10 * DAY + i), finishedAt: at(10 * DAY + i - 1) });
  assert.equal(agent("research")!.jobs.length, APP_AGENT_JOBS);
  // An agent with nothing finished says so with zeros, not with a rate.
  assert.deepEqual(agent("design")!.windows.map((w) => [w.finished, w.costUsd, w.costedJobs]), [[0, undefined, 0], [0, undefined, 0]]);
  assert.ok(!("rate" in day!) && !JSON.stringify(scout).includes("%"), "no single success rate is made of the outcomes");

  // The chief's page carries what its own replies cost today, and only today.
  s.setChatCost({ ymd: "2026-11-20", models: [{ model: "deepseek/deepseek-v4.1-flash", usd: 0.38, calls: 141 }] });
  assert.deepEqual(agent("chief")!.repliesToday, [{ model: "deepseek/deepseek-v4.1-flash", usd: 0.38, calls: 141 }]);
  s.setChatCost({ ymd: "2026-11-19", models: [{ model: "deepseek/deepseek-v4.1-flash", usd: 9, calls: 1 }] });
  assert.equal(agent("chief")!.repliesToday, undefined);
});

test("the agent page is read-only, behind the gate, and drawn as text", () => {
  const index = fs.readFileSync("src/index.ts", "utf8");
  assert.match(index, /app\.get\(`\$\{APP_PATH\}\/api\/agents\/:kind`, \(req, res\) => \{\s*appHeaders\(res\);\s*const agent = appAgent\(appSource\(\), String\(req\.params\.kind \?\? ""\)\);\s*if \(!agent\) return void res\.status\(404\)/);
  const data = fs.readFileSync("src/app-data.ts", "utf8");
  const fn = data.slice(data.indexOf("export function appAgent("), data.indexOf("const JOB_ID ="));
  assert.doesNotMatch(fn, /spec\.prompt|spec\.cwd|\.description|job\.costUsd|estimateUsd/, "no prompt, no path and no estimate leaves it");
  assert.match(fn, /if \(!AGENT_KIND\.test\(kind\)\) return undefined;/);
  const js = fs.readFileSync("public/app/app.js", "utf8");
  const page = js.slice(js.indexOf("/* ---------- One agent ---------- */"), js.indexOf("/* ---------- Search ---------- */"));
  assert.doesNotMatch(page, /innerHTML|rendered\(|postJson|method:/, "it only reads, and shows what it read as text");
  // Everyone on the roster opens their own page.
  assert.match(js, /return h\("a", \{ class: "rail-person", href: `#\/agent\/\$\{r\.kind\}` \}, kids\);/);
});
