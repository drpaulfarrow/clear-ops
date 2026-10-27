import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ALLOWED_NUMBERS = "447700900123";
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
  if (o.systemPrompt.includes("chief of staff")) {
    const ops = o.mcpServers?.ops as { instance?: unknown } | undefined;
    assert.ok(ops, "chief gets the ops tool server");
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
  assert.deepEqual(last.allowedTools, ["WebSearch", "WebFetch", "mcp__ops__*"]);
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
  assert.deepEqual(workerCall.allowedTools, ["WebSearch", "WebFetch"]);
  assert.ok(workerCall.systemPrompt.includes("Clean room rule"));
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
