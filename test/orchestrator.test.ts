import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ALLOWED_NUMBERS = "447700900123";
process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.WHATSAPP_VERIFY_TOKEN = "verify-me";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-"));

const { buildApp } = await import("../src/index.js");
const { Store } = await import("../src/store.js");
const { ConsoleMessenger, chunk, parseInbound, verifySignature } = await import("../src/whatsapp.js");
const { createHmac } = await import("node:crypto");
import type { AgentRunner, RunOptions } from "../src/agents.js";

const calls: RunOptions[] = [];
/** Fake runner: records the call, exercises the chief's tools when asked, returns canned text. */
const fakeRunner: AgentRunner = async (o) => {
  calls.push(o);
  const ops = o.mcpServers?.ops as { instance?: unknown } | undefined;
  if (ops) {
    assert.ok(o.systemPrompt.includes("chief of staff"), "only the chief gets the ops tool server");
    if (o.prompt.startsWith("delegate:")) {
      // Simulate the chief calling start_job through the MCP instance's registered handler.
      const server = (ops as any).instance;
      const handler = server?._registeredTools?.start_job?.callback ?? server?._registeredTools?.start_job?.handler;
      if (handler) {
        const r = await handler({ kind: "research", brief: o.prompt.slice(9).trim() }, {});
        return { text: `Delegated. ${r.content[0].text}`, sessionId: "sess-1" };
      }
      return { text: "Delegated (handler not found)", sessionId: "sess-1" };
    }
    if (o.prompt.startsWith("design loop:")) {
      const server = (ops as any).instance;
      const handler = server?._registeredTools?.start_job?.callback ?? server?._registeredTools?.start_job?.handler;
      const r = await handler({ kind: "design", brief: o.prompt.slice(12).trim(), target: "self", loop: true }, {});
      return { text: `Delegated. ${r.content[0].text}`, sessionId: "sess-1" };
    }
    if (o.prompt.startsWith("new agent:")) {
      // Simulate the chief starting the agent-creator, wrongly asking for the product repo.
      const server = (ops as any).instance;
      const handler = server?._registeredTools?.start_job?.callback ?? server?._registeredTools?.start_job?.handler;
      const r = await handler({ kind: "create_agent", brief: o.prompt.slice(10).trim(), target: "product" }, {});
      return { text: `Delegated. ${r.content[0].text}`, sessionId: "sess-1" };
    }
    return { text: `chief says: ${o.prompt}`, sessionId: "sess-1" };
  }
  return { text: `worker(${o.model}) did: ${o.prompt.slice(0, 40)}`, costUsd: 0.01 };
};

const messenger = new ConsoleMessenger();
let server: import("node:http").Server;
let base: string;
let store: InstanceType<typeof Store>;

before(async () => {
  store = new Store(process.env.DATA_DIR!);
  const { app } = buildApp({ messenger, runner: fakeRunner, store });
  await new Promise<void>((r) => (server = app.listen(0, r)));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});
after(() => server.close());

const inbound = (from: string, text: string) => ({
  entry: [{ changes: [{ value: { messages: [{ type: "text", from, id: "wamid.1", text: { body: text } }] } }] }],
});
const post = (body: unknown) =>
  fetch(`${base}/webhook`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const waitFor = async (pred: () => boolean, ms = 2000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

test("webhook verification handshake", async () => {
  const ok = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345`);
  assert.equal(await ok.text(), "12345");
  const bad = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`);
  assert.equal(bad.status, 403);
});

test("a plain message goes to the chief and the reply comes back, session is stored", async () => {
  const res = await post(inbound("447700900123", "what should I do today?"));
  assert.equal(res.status, 200);
  await waitFor(() => messenger.sent.some((m) => m.text.startsWith("chief says:")));
  assert.equal(store.getSession("447700900123"), "sess-1");
  const last = calls.at(-1)!;
  assert.equal(last.model, "opus");
  assert.deepEqual(last.allowedTools, ["WebSearch", "WebFetch", "Read", "Glob", "Grep", "mcp__ops__*"]);
});

test("a second message resumes the stored session", async () => {
  await post(inbound("447700900123", "and tomorrow?"));
  await waitFor(() => messenger.sent.filter((m) => m.text.startsWith("chief says:")).length >= 2);
  assert.equal(calls.at(-1)!.resume, "sess-1");
});

test("unlisted numbers are ignored", async () => {
  const before = messenger.sent.length;
  await post(inbound("15555550100", "hello"));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(messenger.sent.length, before);
});

test("delegation starts a job and the worker reports back", async () => {
  await post(inbound("447700900123", "delegate: find out what SPUR announced this week"));
  await waitFor(() => messenger.sent.some((m) => /finished/.test(m.text)));
  const job = store.listJobs(1)[0];
  assert.equal(job.kind, "research");
  assert.equal(job.status, "done");
  assert.ok(store.readOutput(job.id)?.startsWith("worker(sonnet)"));
  const workerCall = calls.find((c) => c.systemPrompt.includes("research analyst"))!;
  assert.deepEqual(workerCall.allowedTools, ["WebSearch", "WebFetch", "Read", "Glob", "Grep"]);
  assert.ok(workerCall.systemPrompt.includes("Clean room rule"));
});

test("an engineer job targeted at the workforce itself runs in SELF_REPO_DIR with the self-improvement brief", async () => {
  const { JobRunner } = await import("../src/jobs.js");
  const { config } = await import("../src/config.js");
  const runner = new JobRunner(store, messenger, fakeRunner);
  const job = runner.start("engineer", "Add a /version command", "447700900123", "self");
  await waitFor(() => store.getJob(job.id)?.status === "done");
  const call = calls.find((c) => c.prompt.startsWith("Add a /version command"))!;
  assert.equal(call.cwd, config.selfRepoDir);
  assert.match(call.systemPrompt, /This task is on the workforce itself/);
  assert.match(call.systemPrompt, /senior engineer/);
  assert.ok(messenger.sent.some((m) => m.text.startsWith(`Job ${job.id} (engineer, workforce) finished`)));
});

test("every engineer job is followed by a maintainer job on the same target, and only the maintainer may merge", async () => {
  const { JobRunner } = await import("../src/jobs.js");
  const { workerSpec } = await import("../src/agents.js");
  const runner = new JobRunner(store, messenger, fakeRunner);
  const job = runner.start("engineer", "Add a /health detail", "447700900123", "self");
  await waitFor(() => store.listJobs(20).some((j) => j.kind === "maintain" && j.brief.includes("Add a /health detail")));
  const maint = store.listJobs(20).find((j) => j.kind === "maintain" && j.brief.includes("Add a /health detail"))!;
  assert.equal(maint.target, "self");
  await waitFor(() => store.getJob(maint.id)?.status === "done");
  const eng = workerSpec("engineer");
  for (const rule of ['"Bash(gh pr merge*)"', "Bash(git merge*)"]) assert.ok(eng.disallowedTools!.some((r) => r.includes(rule.replace(/"/g, ""))), `engineer must not ${rule}`);
  const m = workerSpec("maintain");
  assert.ok(!m.disallowedTools!.some((r) => r.includes("gh pr merge")), "maintainer may merge");
  assert.ok(m.disallowedTools!.includes("Edit") && m.disallowedTools!.includes("Write"), "maintainer does not write code");
  assert.ok(messenger.sent.some((t) => t.text.includes(`Job ${job.id} (engineer, workforce) finished`) && t.text.includes("Maintainer job")));
});

test("approval flow: unknown id, reject, and executor failure are all reported", async () => {
  await post(inbound("447700900123", "YES abc123"));
  await waitFor(() => messenger.sent.some((m) => m.text === "No pending action abc123."));

  const a = store.createAction("run_command", "Deploy", { command: "echo deploy" }, "447700900123");
  await post(inbound("447700900123", `no ${a.id}`));
  await waitFor(() => messenger.sent.some((m) => m.text === `Rejected ${a.id}.`));
  assert.equal(store.getAction(a.id)!.status, "rejected");

  const b = store.createAction("run_command", "Bad", { command: "" }, "447700900123");
  await post(inbound("447700900123", `YES ${b.id}`));
  await waitFor(() => messenger.sent.some((m) => m.text.startsWith(`Action ${b.id} failed`)));
  assert.equal(store.getAction(b.id)!.status, "failed");
});

test("/reset clears the session and /jobs lists jobs", async () => {
  await post(inbound("447700900123", "/reset"));
  await waitFor(() => messenger.sent.some((m) => m.text.startsWith("Started a fresh conversation")));
  assert.equal(store.getSession("447700900123"), undefined);
  await post(inbound("447700900123", "/jobs"));
  await waitFor(() => messenger.sent.some((m) => /research done/.test(m.text)));
});

test("Telegram: private text messages are parsed, allowlisted ids reach the chief, others get the id hint once", async () => {
  const { parseUpdates, TelegramPoller, tgId } = await import("../src/telegram.js");
  const { isAllowed } = await import("../src/config.js");
  const updates = [
    { update_id: 1, message: { message_id: 1, text: "hello", chat: { id: 99887766, type: "private" } } },
    { update_id: 2, message: { message_id: 2, text: "group noise", chat: { id: -100, type: "supergroup" } } },
    { update_id: 3, message: { message_id: 3, chat: { id: 99887766, type: "private" } } },
  ];
  assert.deepEqual(parseUpdates(updates as any), [{ from: "tg:99887766", text: "hello" }]);
  assert.equal(isAllowed(tgId(99887766)), true);
  assert.equal(isAllowed(tgId(1)), false);

  const handled: string[] = [];
  const tgMessenger = new ConsoleMessenger();
  const poller = new TelegramPoller(async (from, text) => void handled.push(`${from}:${text}`), tgMessenger, isAllowed);
  assert.ok(poller, "poller constructs without touching the network");
  const { Orchestrator } = await import("../src/orchestrator.js");
  const { JobRunner } = await import("../src/jobs.js");
  const { Scheduler } = await import("../src/scheduler.js");
  const jobs = new JobRunner(store, tgMessenger, fakeRunner);
  const orch = new Orchestrator(store, tgMessenger, jobs, new Scheduler(store, jobs), fakeRunner);
  await orch.handle("tg:99887766", "/start");
  assert.ok(tgMessenger.sent.some((m) => m.to === "tg:99887766" && m.text.startsWith("Talk to me normally")));
  await orch.handle("tg:1", "hello");
  assert.ok(!tgMessenger.sent.some((m) => m.to === "tg:1"), "unlisted Telegram ids are ignored by the orchestrator");
});

test("chunk splits long text on paragraph boundaries within the limit", () => {
  const para = "x".repeat(1500);
  const text = [para, para, para, para].join("\n\n");
  const parts = chunk(text, 3900);
  assert.ok(parts.length >= 2);
  for (const p of parts) assert.ok(p.length <= 3900);
  assert.equal(parts.join("\n\n").replace(/\s+/g, ""), text.replace(/\s+/g, ""));
});

test("parseInbound ignores statuses and non-text messages", () => {
  const body = {
    entry: [{ changes: [{ value: { statuses: [{ id: "x" }], messages: [{ type: "image", from: "1" }, { type: "text", from: "2", text: { body: "hi" } }] } }] }],
  };
  assert.deepEqual(parseInbound(body), [{ from: "2", text: "hi", messageId: "" }]);
});

test("verifySignature accepts a correct HMAC and rejects a wrong one", () => {
  const raw = Buffer.from('{"a":1}');
  const sig = "sha256=" + createHmac("sha256", "secret").update(raw).digest("hex");
  assert.equal(verifySignature(raw, sig, "secret"), true);
  assert.equal(verifySignature(raw, "sha256=" + "0".repeat(64), "secret"), false);
  assert.equal(verifySignature(raw, undefined, ""), true, "no secret configured means skip");
});

test("the chief starts the agent-creator on the workforce repo, and its pull request goes to the maintainer", async () => {
  const { config } = await import("../src/config.js");
  await post(inbound("447700900123", "new agent: an agent that drafts publisher outreach"));
  await waitFor(() => messenger.sent.some((m) => m.text.includes("(create_agent, on the workforce itself)")));
  const job = store.listJobs(50).find((j) => j.kind === "create_agent" && j.brief.includes("drafts publisher outreach"))!;
  assert.equal(job.target, "self", "create_agent is forced onto the workforce repo");
  await waitFor(() => store.listJobs(50).some((j) => j.kind === "maintain" && j.brief.includes("drafts publisher outreach")));
  const maint = store.listJobs(50).find((j) => j.kind === "maintain" && j.brief.includes("drafts publisher outreach"))!;
  assert.equal(maint.target, "self");
  assert.match(maint.brief, /clean-room rule/);
  const call = calls.find((c) => c.prompt.startsWith("an agent that drafts publisher outreach"))!;
  assert.equal(call.cwd, config.selfRepoDir);
  assert.match(call.systemPrompt, /agent-creator/);
  assert.match(call.systemPrompt, /This task is on the workforce itself/);
  assert.match(call.systemPrompt, /Clean room rule/);
  assert.ok(call.disallowedTools!.includes("Bash(gh pr merge*)"));
  assert.equal(call.maxBudgetUsd, config.engineerBudgetUsd);
  await waitFor(() => messenger.sent.some((m) => m.text.startsWith(`Job ${job.id} (create_agent, workforce) finished`) && m.text.includes("Maintainer job")));
});

test("an agent-creator schedule verdict writes no code and starts no maintainer", async () => {
  const { JobRunner, isScheduleVerdict } = await import("../src/jobs.js");
  const verdict = "VERDICT: schedule\nKind: research\nCron: 0 7 * * 1\nBrief: Check IAB Tech Lab announcements from the past week.\nWhy: the researcher already does this.";
  const runner = new JobRunner(store, messenger, async (o) => {
    calls.push(o);
    return { text: o.systemPrompt.includes("agent-creator") ? verdict : "reviewed", costUsd: 0.01 };
  });
  const job = runner.start("create_agent", "Monitor IAB Tech Lab announcements weekly", "447700900123");
  await waitFor(() => store.getJob(job.id)?.status === "done");
  await waitFor(() => messenger.sent.some((m) => m.text.startsWith(`Job ${job.id} (create_agent`)));
  const msg = messenger.sent.find((m) => m.text.startsWith(`Job ${job.id} (create_agent`))!;
  assert.match(msg.text, /set it up/);
  assert.match(msg.text, /Cron: 0 7 \* \* 1/);
  assert.ok(!msg.text.includes("Maintainer job"));
  assert.ok(!store.listJobs(50).some((j) => j.kind === "maintain" && j.brief.includes("Monitor IAB Tech Lab")));
  assert.equal(isScheduleVerdict("  verdict: schedule\nKind: write"), true);
  assert.equal(isScheduleVerdict("VERDICT: new worker\nhttps://github.com/o/r/pull/1"), false);
  assert.equal(isScheduleVerdict("I opened a PR. VERDICT: schedule"), false, "only a leading verdict skips review");
});

test("the chief knows the design worker and can start the design loop with start_job", async () => {
  await post(inbound("447700900123", "design loop: make the site something I can show customers"));
  await waitFor(() => messenger.sent.some((m) => /Design loop [a-f0-9]{6} started: job [a-f0-9]{6} \(design\)/.test(m.text)));
  const job = store.listJobs(50).find((j) => j.kind === "design" && j.designGoal === "make the site something I can show customers")!;
  assert.equal(job.target, "product", "design always looks at the product, whatever target was asked for");
  assert.equal(job.designLoop, job.id);
  assert.equal(job.designRound, 1);
  const chief = calls.find((c) => c.prompt.startsWith("design loop:"))!;
  assert.match(chief.systemPrompt, /design is the brand and design director/);
  assert.match(chief.systemPrompt, /continueLoop/);
  const call = await (async () => {
    await waitFor(() => calls.some((c) => c.systemPrompt.startsWith("You are the brand and design director")));
    return calls.find((c) => c.systemPrompt.startsWith("You are the brand and design director"))!;
  })();
  assert.match(call.prompt, /^Design loop, round 1 of 3\./);
  assert.ok(call.systemPrompt.includes("Clean room rule"));
  // The fake designer gives no verdict, so the loop pauses and says so rather than stalling silently.
  await waitFor(() => messenger.sent.some((m) => m.text.startsWith(`Design loop ${job.id} is paused`)));
});
