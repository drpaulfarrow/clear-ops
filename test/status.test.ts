import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-status-"));

const { describeToolUse, LiveStatus } = await import("../src/status.js");
const { RouterMessenger } = await import("../src/channels.js");
const { TelegramMessenger } = await import("../src/telegram.js");
const { Store } = await import("../src/store.js");
const { JobRunner } = await import("../src/jobs.js");
const { Orchestrator } = await import("../src/orchestrator.js");
const { Scheduler } = await import("../src/scheduler.js");
const { ConsoleMessenger } = await import("../src/whatsapp.js");
import type { AgentRunner } from "../src/agents.js";

const FOUNDER = "tg:99887766";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Records every channel call in order, standing in for Telegram or Discord. */
class EditableMessenger extends ConsoleMessenger {
  log: string[] = [];
  private n = 0;
  constructor(private readonly opts: { failEdits?: boolean; failTyping?: boolean } = {}) {
    super();
  }
  override async send(to: string, text: string) {
    this.log.push(`send ${text}`);
    await super.send(to, text);
  }
  async sendEditable(_to: string, text: string) {
    if (this.opts.failEdits) throw new Error("edit down");
    const h = `m${++this.n}`;
    this.log.push(`status ${h} ${text}`);
    return h;
  }
  async edit(_to: string, handle: string, text: string) {
    this.log.push(`edit ${handle} ${text}`);
  }
  async remove(_to: string, handle: string) {
    this.log.push(`remove ${handle}`);
  }
  async typing() {
    if (this.opts.failTyping) throw new Error("typing down");
    this.log.push("typing");
    return true;
  }
}

function chief(messenger: InstanceType<typeof ConsoleMessenger>, runner: AgentRunner, opts = { typingEveryMs: 15, nudgeAfterMs: 40 }) {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-st-")));
  const jobs = new JobRunner(store, messenger, runner);
  return new Orchestrator(store, messenger, jobs, new Scheduler(store, jobs), runner, opts);
}

/** A chief that calls tools, takes a little while, then replies. */
const busyChief: AgentRunner = async (o) => {
  o.onToolUse?.("mcp__ops__job_status", { id: "39abb7" });
  await sleep(30);
  o.onToolUse?.("mcp__ops__get_output", { id: "39abb7" });
  o.onToolUse?.("WebSearch", { query: "SPUR news" }); // lands before the previous edit is sent: only the latest shows
  await sleep(60);
  return { text: "Job 39abb7 is merged.", sessionId: "s1" };
};

test("tool calls become plain status lines", () => {
  assert.equal(describeToolUse("mcp__ops__job_status", {}), "Checking job status…");
  assert.equal(describeToolUse("mcp__ops__job_status", { id: "39abb7" }), "Checking job 39abb7…");
  assert.equal(describeToolUse("mcp__ops__get_output", { id: "39abb7" }), "Reading job 39abb7 output…");
  assert.equal(describeToolUse("mcp__ops__start_job", { kind: "engineer" }), "Starting an engineer job…");
  assert.equal(describeToolUse("mcp__ops__start_job", { kind: "research" }), "Starting a research job…");
  assert.equal(describeToolUse("mcp__ops__start_job", { kind: "design" }), "Starting a design job…");
  assert.equal(describeToolUse("mcp__ops__start_job", { kind: "design", loop: true }), "Starting the design loop…");
  assert.equal(describeToolUse("mcp__ops__start_job", { kind: "design", continueLoop: "a1b2c3" }), "Carrying on the design loop…");
  assert.equal(describeToolUse("mcp__ops__start_job", { kind: "engineer", target: "self" }), "Starting an engineer job on the workforce…");
  assert.equal(describeToolUse("mcp__ops__start_job", { kind: "create_agent" }), "Starting an agent-creator job…");
  assert.equal(describeToolUse("WebSearch", { query: "SPUR news" }), "Searching the web: SPUR news…");
  assert.equal(describeToolUse("WebFetch", { url: "https://www.iabtechlab.com/standards" }), "Reading iabtechlab.com…");
  assert.equal(describeToolUse("WebFetch", { url: "not a url" }), "Reading a web page…");
  assert.equal(describeToolUse("Read", { file_path: "/data/self/src/jobs.ts" }), "Reading jobs.ts…");
  assert.equal(describeToolUse("Grep", { pattern: "x" }), "Searching the code…");
  assert.equal(describeToolUse("mcp__ops__propose_action", {}), "Preparing an approval request…");
  assert.equal(describeToolUse("SomethingNew", {}), "Working…");
  const long = describeToolUse("WebSearch", { query: "x".repeat(200) });
  assert.ok(long.length <= 80 && long.endsWith("…"));
  for (const s of [long, describeToolUse("mcp__ops__remember")]) assert.ok(!s.includes("—"), "no em dashes");
});

test("the chief's status is one message edited in place, removed before the reply, with typing throughout", async () => {
  const m = new EditableMessenger();
  await chief(m, busyChief).handle(FOUNDER, "is 39abb7 merged?");
  const statuses = m.log.filter((l) => l.startsWith("status"));
  assert.deepEqual(statuses, ["status m1 Checking job 39abb7…"], "exactly one status message is sent");
  assert.ok(m.log.includes("edit m1 Searching the web: SPUR news…"), "later tool calls edit it in place");
  assert.ok(!m.log.includes("edit m1 Reading job 39abb7 output…"), "superseded updates are skipped, not queued");
  assert.ok(m.log.filter((l) => l === "typing").length >= 2, "typing is renewed while the chief works");
  const removedAt = m.log.indexOf("remove m1");
  const replyAt = m.log.indexOf("send Job 39abb7 is merged.");
  assert.ok(removedAt > -1 && replyAt > removedAt, "the status goes away when the reply arrives");
  assert.ok(!m.log.includes("send Working on it."), "no old-style nudge where live status works");
  const typingAfter = m.log.slice(replyAt).filter((l) => l === "typing").length;
  await sleep(50);
  assert.equal(m.log.slice(replyAt).filter((l) => l === "typing").length, typingAfter, "typing stops with the reply");
});

test("a quick answer with no tool calls shows typing only, and no status message", async () => {
  const m = new EditableMessenger();
  await chief(m, async () => ({ text: "Hello." })).handle(FOUNDER, "hi");
  assert.ok(m.log.includes("typing"));
  assert.ok(!m.log.some((l) => l.startsWith("status")));
  assert.equal(m.log.at(-1), "send Hello.");
});

test("channels with neither editing nor typing (WhatsApp) fall back to one delayed nudge", async () => {
  const m = new ConsoleMessenger();
  await chief(m, busyChief).handle(FOUNDER, "is 39abb7 merged?");
  assert.deepEqual(m.sent.map((s) => s.text), ["Working on it.", "Job 39abb7 is merged."]);
});

test("a broken status channel never breaks the reply", async () => {
  const m = new EditableMessenger({ failEdits: true, failTyping: true });
  await chief(m, busyChief).handle(FOUNDER, "is 39abb7 merged?");
  assert.equal(m.sent.at(-1)!.text, "Job 39abb7 is merged.");
  assert.ok(!m.sent.some((s) => s.text.startsWith("Something went wrong")));
});

test("a failed chief run still clears the status and typing", async () => {
  const m = new EditableMessenger();
  const failing: AgentRunner = async (o) => {
    o.onToolUse?.("mcp__ops__job_status", {});
    await sleep(20);
    throw new Error("model unavailable");
  };
  await chief(m, failing).handle(FOUNDER, "status?");
  assert.ok(m.log.includes("remove m1"));
  assert.match(m.sent.at(-1)!.text, /Something went wrong: model unavailable/);
});

test("the router only offers editing and typing where the conversation's channel has them", async () => {
  const tg = new EditableMessenger();
  const wa = new ConsoleMessenger();
  const r = new RouterMessenger([{ prefix: "tg:", messenger: tg }], wa);
  assert.equal(await r.sendEditable("tg:1", "Working…"), "m1");
  await r.edit("tg:1", "m1", "Still working…");
  await r.remove("tg:1", "m1");
  assert.equal(await r.typing("tg:1"), true);
  assert.equal(await r.sendEditable("447700900123", "Working…"), undefined, "WhatsApp cannot edit");
  assert.equal(await r.typing("447700900123"), false);
  assert.equal(wa.sent.length, 0, "nothing is sent to a channel that cannot edit");

  // LiveStatus over the router gives up editing for that conversation instead of sending new messages.
  const s = new LiveStatus(r, "447700900123", { nudgeAfterMs: 10_000 }).start();
  s.update("Checking job status…");
  s.update("Reading job output…");
  await sleep(10);
  await s.finish();
  assert.equal(wa.sent.length, 0);
});

test("Telegram status uses sendMessage, editMessageText, deleteMessage and sendChatAction", async () => {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    calls.push({ method: String(url).split("/").pop()!, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 77 } }), { status: 200 });
  }) as typeof fetch;
  try {
    const t = new TelegramMessenger();
    const h = await t.sendEditable("tg:42", "Checking job status…");
    assert.equal(h, "77");
    await t.edit("tg:42", h!, "Reading **job** output…");
    await t.remove("tg:42", h!);
    assert.equal(await t.typing("tg:42"), true);
    assert.deepEqual(calls.map((c) => c.method), ["sendMessage", "editMessageText", "deleteMessage", "sendChatAction"]);
    assert.equal(calls[1].body.message_id, 77);
    assert.equal(calls[1].body.text, "Reading job output…", "edits are plain text like every Telegram message");
    assert.equal(calls[3].body.action, "typing");
    assert.equal(calls[3].body.chat_id, "42");
  } finally {
    globalThis.fetch = realFetch;
  }
});
