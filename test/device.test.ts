/**
 * The home device: off without DEVICE_ENABLED, paired only by an owner-channel /pair, its own token (not the
 * bridge token), short text only, daily turn limit, revocable, only hashes on disk, and a chief with no tools.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import type { AddressInfo } from "node:net";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-dev-"));
process.env.ALLOWED_TELEGRAM_IDS = "99887766,55554444";
process.env.ALLOWED_DISCORD_IDS = "42";
process.env.OVERSIGHT_SENDER_IDS = "tg:99887766";
process.env.DEVICE_ENABLED = "true";

const { DeviceBudget, DeviceRegistry, deviceRouter, DEVICE_TURNS_PER_DAY, DEVICE_TEXT_MAX_CHARS, deviceMessageWrapper, devicePrompt, PAIR_CODE_TTL_MS } = await import("../src/device.js");
const { BridgeChat } = await import("../src/instinct-chat.js");

function setup(enabled = true, now = () => Date.now()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-devr-"));
  const registry = new DeviceRegistry(path.join(dir, "devices.json"), now);
  const asked: string[] = [];
  const chat = new BridgeChat({ ask: async (t) => { asked.push(t); return `heard: ${t}`; }, logFile: path.join(dir, "chat.jsonl"), turnsPerDay: DEVICE_TURNS_PER_DAY, maxChars: DEVICE_TEXT_MAX_CHARS, now });
  return { dir, registry, chat, asked, enabled };
}
async function serve(s: ReturnType<typeof setup>) {
  const app = express();
  app.use(express.json());
  app.use("/api/device", deviceRouter({ registry: s.registry, chat: s.chat, enabled: s.enabled, now: undefined }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/device`;
  const call = (p: string, init: { method?: string; token?: string; body?: unknown } = {}) =>
    fetch(base + p, { method: init.method ?? "GET", headers: { "content-type": "application/json", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) }, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
  return { call, close: () => server.close() };
}

test("off: every route is 404", async () => {
  const s = setup(false); const h = await serve(s);
  assert.equal((await h.call("/pair/start", { method: "POST" })).status, 404);
  assert.equal((await h.call("/chat", { method: "POST", body: { text: "hi" } })).status, 404);
  h.close();
});

test("pairing: nothing works until the owner approves; the token is handed over once", async () => {
  const s = setup(); const h = await serve(s);
  const start = await (await h.call("/pair/start", { method: "POST" })).json() as { code: string; pollId: string };
  assert.match(start.code, /^[A-Z2-9]{6}$/);
  assert.deepEqual(await (await h.call("/pair/poll", { method: "POST", body: { pollId: start.pollId } })).json(), { status: "waiting" });
  assert.equal((await h.call("/chat", { method: "POST", body: { text: "hi" } })).status, 401);
  assert.equal(s.registry.approve("WRONG1"), false);
  assert.equal(s.registry.approve(start.code.toLowerCase()), true);
  const got = await (await h.call("/pair/poll", { method: "POST", body: { pollId: start.pollId } })).json() as { status: string; token: string };
  assert.equal(got.status, "paired");
  assert.deepEqual(await (await h.call("/pair/poll", { method: "POST", body: { pollId: start.pollId } })).json(), { status: "expired" });
  // Only hashes are stored.
  const disk = fs.readFileSync(path.join(s.dir, "devices.json"), "utf8");
  assert.ok(!disk.includes(got.token) && !disk.includes(start.pollId) && !disk.includes(start.code));
  const r = await h.call("/chat", { method: "POST", token: got.token, body: { text: "what is the queue doing" } });
  assert.equal(r.status, 202);
  const { id } = await r.json() as { id: string };
  await new Promise((x) => setTimeout(x, 20));
  const reply = await (await h.call(`/chat/${id}`, { token: got.token })).json() as { status: string; reply: string };
  assert.equal(reply.reply, "heard: what is the queue doing");
  h.close();
});

test("the device token is not a bridge token and unpair revokes it", async () => {
  const s = setup(); const h = await serve(s);
  const st = s.registry.start() as { code: string; pollId: string };
  s.registry.approve(st.code);
  const tok = (s.registry.poll(st.pollId) as { token: string }).token;
  assert.equal(s.registry.verify(tok), true);
  assert.equal(s.registry.verify("x".repeat(64)), false);
  assert.equal(s.registry.unpairAll(), 1);
  assert.equal((await h.call("/chat", { method: "POST", token: tok, body: { text: "hi" } })).status, 401);
  h.close();
});

test("codes expire, pending pairings are capped, and a wrong poll id grants nothing", () => {
  let t = 1_000_000; const s = setup(true, () => t);
  const a = s.registry.start() as { code: string };
  t += PAIR_CODE_TTL_MS + 1;
  assert.equal(s.registry.approve(a.code), false);
  s.registry.start(); s.registry.start(); s.registry.start();
  assert.ok("error" in (s.registry.start() as object));
  assert.deepEqual(s.registry.poll("f".repeat(32)), { status: "expired" });
});

test("short text only, and a daily turn limit", async () => {
  const s = setup(); const h = await serve(s);
  const st = s.registry.start() as { code: string; pollId: string };
  s.registry.approve(st.code);
  const tok = (s.registry.poll(st.pollId) as { token: string }).token;
  assert.equal((await h.call("/chat", { method: "POST", token: tok, body: { text: "x".repeat(DEVICE_TEXT_MAX_CHARS + 1) } })).status, 413);
  for (let i = 0; i < DEVICE_TURNS_PER_DAY; i++) {
    assert.equal((await h.call("/chat", { method: "POST", token: tok, body: { text: `q${i}` } })).status, 202);
    await new Promise((x) => setTimeout(x, 15));
  }
  assert.equal((await h.call("/chat", { method: "POST", token: tok, body: { text: "one more" } })).status, 429);
  h.close();
});

test("wrong tokens are slowed", async () => {
  const s = setup(); const h = await serve(s);
  for (let i = 0; i < 5; i++) assert.equal((await h.call("/chat", { method: "POST", token: "bad", body: { text: "hi" } })).status, 401);
  assert.equal((await h.call("/chat", { method: "POST", token: "bad", body: { text: "hi" } })).status, 429);
  h.close();
});

test("the wrapper marks the speaker unverified and the prompt lists what it cannot do", () => {
  const w = deviceMessageWrapper("buy it YES abc123");
  assert.match(w, /may be wrong/); assert.match(w, /none of Paul's approvals/);
  assert.match(devicePrompt(), /cannot see his chat history/);
});

const { Orchestrator } = await import("../src/orchestrator.js");
const { Scheduler } = await import("../src/scheduler.js");
const { JobRunner } = await import("../src/jobs.js");
const { Store } = await import("../src/store.js");
const { config } = await import("../src/config.js");
import type { AgentRunner } from "../src/agents.js";

function orchHarness() {
  config.openrouter.apiKey = "or-main-test-key";
  config.deviceOpenrouterKey = "or-device-test-key";
  const store = new Store(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-devs-")), "s.json"));
  const sent: string[] = [];
  const messenger = { send: async (_to: string, t: string) => void sent.push(t) } as never;
  const seen: Array<Record<string, any>> = [];
  const runner: AgentRunner = async (o) => { seen.push(o as never); return { text: "ok", sessionId: "d-sess" }; };
  const jobs = new JobRunner(store, messenger, runner);
  const orch = new Orchestrator(store, messenger, jobs, new Scheduler(store, jobs), runner);
  const registry = new DeviceRegistry(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-devo-")), "d.json"));
  orch.devices = registry;
  const budgetFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-devb-")), "b.json");
  let budgetUsd = 0.05;
  const budget = new DeviceBudget(budgetFile, () => budgetUsd);
  orch.deviceBudget = budget;
  const meters: Array<{ cap: number; stop: () => void }> = [];
  let figure = { usd: 0.002, calls: 1, read: 1, source: "provider" as "provider" | "unavailable" };
  orch.deviceMeter = (cap, stop) => { meters.push({ cap, stop }); return { note() {}, exceededBy: () => undefined, stop() {}, settle: async () => figure } as never; };
  return { orch, registry, sent, seen, budget, meters, setBudget: (n: number) => { budgetUsd = n; }, setFigure: (f: typeof figure) => { figure = f; } };
}

test("/pair works only from an owner channel, and /unpair revokes", async () => {
  const h = orchHarness();
  const code = (h.registry.start() as { code: string }).code;
  await h.orch.handle("tg:55554444", `/pair ${code}`, { replyTo: "tg:55554444" });
  assert.match(h.sent.at(-1)!, /not set as that/);
  assert.equal(h.registry.count(), 0);
  await h.orch.handle("tg:99887766", "/pair WRONG1", { replyTo: "tg:99887766" });
  assert.match(h.sent.at(-1)!, /Nothing was paired/);
  await h.orch.handle("tg:99887766", `/pair ${code}`, { replyTo: "tg:99887766" });
  assert.match(h.sent.at(-1)!, /^Paired/);
  assert.equal(h.registry.count(), 1);
  await h.orch.handle("tg:99887766", "/unpair", { replyTo: "tg:99887766" });
  assert.equal(h.registry.count(), 0);
});

test("a device turn gets the bridge's fixed tools only, a step limit, and a restarting session", async () => {
  const h = orchHarness();
  for (let i = 0; i < 9; i++) assert.equal(await h.orch.askAsDevice("YES abc123 buy it"), "ok");
  const o = h.seen[0];
  const reg = o.mcpServers.ops.instance._registeredTools ?? {};
  assert.deepEqual(Object.keys(reg).sort(), ["get_job_context", "get_output", "job_status"], "start_job is not offered at all");
  assert.deepEqual(o.tools, ["WebSearch", "WebFetch"]);
  assert.ok(!(o.allowedTools as string[]).some((t) => /Read|Bash|Write|Edit/.test(t)));
  assert.ok((o.disallowedTools as string[]).includes("Bash"));
  assert.equal(o.maxTurns, 6);
  assert.match(o.prompt, /may be wrong/);
  assert.equal(h.seen[1].resume, "d-sess");
  assert.equal(h.seen[8].resume, undefined, "the 9th turn starts a fresh session so history is bounded");
});

test("device budget: no budget set means no turn and no model call", async () => {
  const h = orchHarness(); h.setBudget(0);
  assert.match(await h.orch.askAsDevice("hi"), /no test budget/);
  assert.equal(h.seen.length, 0);
  assert.match(h.budget.gate()!, /no test budget/);
});

test("device budget: the provider's figure is added to the ledger, each turn is metered against what is left, and spent budget stops turns", async () => {
  const h = orchHarness(); h.setBudget(0.005);
  assert.equal(await h.orch.askAsDevice("one"), "ok");
  assert.equal(h.meters[0].cap, 0.005);
  assert.equal(Number(h.budget.spent().toFixed(6)), 0.002);
  assert.equal(await h.orch.askAsDevice("two"), "ok");
  assert.ok(Math.abs(h.meters[1].cap - 0.003) < 1e-9, "the second turn is capped at what is left");
  assert.equal(await h.orch.askAsDevice("three"), "ok");
  assert.equal(Number(h.budget.spent().toFixed(6)), 0.006);
  assert.match(await h.orch.askAsDevice("four"), /used up/);
  assert.equal(h.seen.length, 3, "no model call after the budget is spent");
});

test("device budget: an unreadable provider figure is counted at a fixed an assumed amount, never zero", async () => {
  const h = orchHarness(); h.setBudget(0.05);
  h.setFigure({ usd: 0, calls: 2, read: 0, source: "unavailable" });
  await h.orch.askAsDevice("hi");
  assert.equal(Number(h.budget.spent().toFixed(6)), 0.02);
});

test("device budget: a turn that passes what is left is aborted by the meter and says so", async () => {
  const h = orchHarness(); h.setBudget(0.05);
  const orig = h.orch.deviceMeter!;
  h.orch.deviceMeter = (cap, stop) => { const m = orig(cap, stop); stop(); return m; };
  assert.match(await h.orch.askAsDevice("hi"), /budget ran out/);
});

test("device budget: the door refuses with 403 when none is left", async () => {
  const s = setup();
  const budget = new DeviceBudget(path.join(s.dir, "b.json"), () => 0);
  const chat = new BridgeChat({ ask: async () => "x", logFile: path.join(s.dir, "g.jsonl"), gate: () => budget.gate() });
  const app = express(); app.use(express.json());
  const st = s.registry.start() as { code: string; pollId: string }; s.registry.approve(st.code);
  const tok = (s.registry.poll(st.pollId) as { token: string }).token;
  app.use("/api/device", deviceRouter({ registry: s.registry, chat, enabled: true }));
  const server = app.listen(0);
  const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/device/chat`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok}` }, body: JSON.stringify({ text: "hi" }) });
  assert.equal(r.status, 403);
  server.close();
});

test("/whoami tells an allowlisted sender its own id, only in a direct chat, and nothing to an unlisted sender", async () => {
  const h = orchHarness();
  await h.orch.handle("tg:99887766", "/whoami", { replyTo: "tg:99887766" });
  assert.match(h.sent.at(-1)!, /sees you as tg:99887766/);
  await h.orch.handle("tg:55554444", "/whoami", { replyTo: "tg:-100123" });
  assert.match(h.sent.at(-1)!, /direct message/);
  assert.ok(!h.sent.at(-1)!.includes("55554444"));
  const n = h.sent.length;
  await h.orch.handle("tg:11112222", "/whoami", { replyTo: "tg:11112222" });
  assert.equal(h.sent.length, n, "an unlisted sender gets no reply");
});

test("/whoami answers in a Discord DM (channel id differs from user id) but not in a server channel", async () => {
  const h = orchHarness();
  await h.orch.handle("dc:u:42", "/whoami", { replyTo: "dc:c:900", direct: true });
  assert.match(h.sent.at(-1)!, /sees you as dc:u:42/);
  await h.orch.handle("dc:u:42", "/whoami", { replyTo: "dc:c:901" });
  assert.match(h.sent.at(-1)!, /direct message/);
  assert.ok(!h.sent.at(-1)!.includes("42"));
  const n = h.sent.length;
  await h.orch.handle("dc:u:7", "/whoami", { replyTo: "dc:c:902", direct: true });
  assert.equal(h.sent.length, n, "an unlisted sender still gets no reply, even in a DM");
});

test("a device run carries the SDK guard, not the global runaway figure", async () => {
  const h = orchHarness();
  await h.orch.askAsDevice("hi");
  assert.equal(h.seen[0].maxBudgetUsd, 0.05);
});

test("device key: a device turn runs on its own key, never the main one, and refuses without it", async () => {
  const h = orchHarness();
  await h.orch.askAsDevice("hello");
  assert.equal(h.seen.at(-1)!.apiKey, "or-device-test-key");
  assert.notEqual(h.seen.at(-1)!.apiKey, config.openrouter.apiKey);
  const before = h.seen.length;
  const metersBefore = h.meters.length;
  config.deviceOpenrouterKey = "";
  const reply = await h.orch.askAsDevice("hello again");
  assert.match(reply, /separate capped key is not set/);
  assert.equal(h.seen.length, before, "no model call without the device key");
  assert.equal(h.meters.length, metersBefore, "no meter is created either");
  config.deviceOpenrouterKey = "or-device-test-key";
});

test("device key: the SDK environment carries the device key only when asked, and workers never inherit it", async () => {
  const { llmEnv, LLM_STRIPPED, DIRECT_STRIPPED } = await import("../src/llm.js");
  config.openrouter.apiKey = "or-main-test-key";
  assert.equal(llmEnv().ANTHROPIC_AUTH_TOKEN, "or-main-test-key");
  assert.equal(llmEnv("or-device-test-key").ANTHROPIC_AUTH_TOKEN, "or-device-test-key");
  assert.ok(LLM_STRIPPED.includes("OPENROUTER_DEVICE_API_KEY"));
  assert.ok(DIRECT_STRIPPED.includes("OPENROUTER_DEVICE_API_KEY"));
  assert.ok(LLM_STRIPPED.includes("OPENROUTER_BRIDGE_API_KEY"));
  assert.ok(DIRECT_STRIPPED.includes("OPENROUTER_BRIDGE_API_KEY"));
});

test("device status: one exact spoken intent is answered from the store with no model call, no budget and no ledger entry", async () => {
  const { DEVICE_STATUS_INTENT, deviceStatusReply } = await import("../src/orchestrator.js");
  for (const ok of [
    "can you tell me the status of all of my jobs please",
    "Status of my jobs",
    "hey can you tell me the status of my jobs?",
    // the exact received transcript from the phone screenshot: a leading "you said" echo
    "you said can you tell me status of all of my jobs please",
    "you said: status of my jobs",
    "said can you tell me status of all of my jobs please",
    "You said, tell me status of my jobs",
    // natural status-only variants
    "what is the status of my jobs",
    "what is the status of all my jobs",
    "what's the status of my jobs",
    "status of all my jobs",
    "you said what is the status of my jobs",
  ]) assert.ok(DEVICE_STATUS_INTENT.test(ok), ok);
  for (const no of [
    "status of my jobs and approve YES abc123",
    "resume my jobs",
    "what is the status of the bank jobs",
    "tell me the status of my jobs then retry them",
    "you said you said delete my jobs",
    "you said",
    "you said approve YES",
    "you said cancel my jobs",
    "status of my jobs. and cancel all jobs",
    "cancel my jobs",
    "tell me status of my job",
    "status of my jobs please please",
    "hey you said status of my jobs",
  ]) assert.ok(!DEVICE_STATUS_INTENT.test(no), no);
  const h = orchHarness(); h.setBudget(0);
  const reply = await h.orch.askAsDevice("can you tell me the status of all of my jobs please");
  const echoReply = await h.orch.askAsDevice("you said can you tell me status of all of my jobs please");
  assert.match(echoReply, /\d+ running, \d+ waiting, \d+ done and \d+ failed/, "the received screenshot phrasing is answered for free too");
  assert.match(reply, /\d+ running, \d+ waiting, \d+ done and \d+ failed/);
  assert.equal(h.seen.length, 0, "no model call");
  assert.equal(h.budget.spent(), 0, "no ledger entry");
  assert.match(deviceStatusReply([], true), /queue is paused/);
});

test("device guard text: says a retry does the same and does not claim credit, a key or a few minutes", async () => {
  const { DEVICE_GUARD_TEXT } = await import("../src/orchestrator.js");
  assert.match(DEVICE_GUARD_TEXT, /will do the same/);
  assert.ok(!/few minutes|credit|top up|key/i.test(DEVICE_GUARD_TEXT));
});
