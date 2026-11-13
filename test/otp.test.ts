/**
 * One-time codes: the service reads the code from the site's email or asks Paul in chat, types it into the
 * page itself, and the code never reaches a model, a log, an output or the store. No network: the mailbox
 * and the messages are fakes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-otp-"));
process.env.VAULT_KEY = "test-vault-key-that-is-long-enough";

const { OtpRelay, OtpError, parseCodeCommand, siteLabel, codeTtlMs } = await import("../src/otp.js");
const { extractCode, senderDomain, GmailCodeReader } = await import("../src/mail-code.js");

const PAUL = "tg:99887766";
const logFile = () => path.join(process.env.DATA_DIR!, "otp", "actions.log");
const log = () => (fs.existsSync(logFile()) ? fs.readFileSync(logFile(), "utf8") : "");

/** Waits until the relay has sent something, and returns the first message. */
async function sentOne(sent: string[]): Promise<string> {
  for (let i = 0; i < 200 && !sent.length; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(sent[0], "expected a message to Paul");
  return sent[0]!;
}

function relay(opts: { mailbox?: { codeFrom: (i: { domain: string; since: number; timeoutMs: number }) => Promise<string | undefined> }; ttlMs?: number; maxPerJob?: number } = {}) {
  const sent: string[] = [];
  const gate = new OtpRelay({
    messenger: { send: async (_to: string, t: string) => void sent.push(t) },
    ...(opts.mailbox ? { mailbox: opts.mailbox } : {}),
    ttlMs: opts.ttlMs ?? 5_000,
    minGapMs: 0,
    ...(opts.maxPerJob ? { maxPerJob: opts.maxPerJob } : {}),
  });
  return { sent, gate, job: (id = "job1", scheduled = false) => gate.forJob({ id, replyTo: PAUL, scheduled }) };
}

/* ---------- pulling the code out of a message ---------- */

test("the code is read from the message, and a number that is not a code is not", () => {
  assert.equal(extractCode("Your Amazon verification code is 482913. Do not share it."), "482913");
  assert.equal(extractCode("123456 is your one-time code"), "123456");
  assert.equal(extractCode("Use passcode 9173 to sign in"), "9173");
  assert.equal(extractCode("Here is your code:\n\n839201\n"), "839201");
  // A year, a price or a longer number that merely mentions a code word is not a code.
  assert.equal(extractCode("Your 2026 security code has changed"), undefined);
  assert.equal(extractCode("Your order 12345678 is on its way"), undefined);
  assert.equal(extractCode("Thanks for your order. Order total £23.98"), undefined);
  assert.equal(senderDomain("Amazon.co.uk <no-reply@amazon.co.uk>"), "amazon.co.uk");
});

/* ---------- reading it from Paul's mailbox ---------- */

function fakeGmail(messages: Array<{ id: string; from: string; body: string; at: number }>) {
  const asked: string[] = [];
  return {
    asked,
    async request<T>(_api: string, _method: string, p: string): Promise<T> {
      asked.push(p);
      if (p === "messages") return { messages: messages.map((m) => ({ id: m.id })) } as unknown as T;
      const m = messages.find((x) => `messages/${x.id}` === p)!;
      return {
        id: m.id,
        internalDate: String(m.at),
        payload: { mimeType: "text/plain", headers: [{ name: "From", value: m.from }], body: { data: Buffer.from(m.body).toString("base64url") } },
      } as unknown as T;
    },
  };
}

test("the mailbox reader takes the code from that site's own mail, and only recent mail", async () => {
  const since = 1_000_000_000_000;
  const api = fakeGmail([
    { id: "a", from: "someone@elsewhere.com", body: "code 111111", at: since + 1000 },
    { id: "b", from: "Amazon.co.uk <no-reply@amazon.co.uk>", body: "Your one-time code is 222222", at: since - 600_000 },
    { id: "c", from: "no-reply@amazon.co.uk", body: "Your sign-in code is 333333", at: since + 2000 },
  ]);
  const reader = new GmailCodeReader(api as never, { now: () => since, sleep: async () => undefined });
  assert.equal(await reader.codeFrom({ domain: "amazon.co.uk", since, timeoutMs: 10 }), "333333");
  assert.ok(api.asked.includes("messages"), "it searches mail");
});

test("a mailbox that finds nothing returns nothing rather than throwing", async () => {
  const api = fakeGmail([{ id: "a", from: "no-reply@amazon.co.uk", body: "Your order has shipped", at: Date.now() }]);
  const reader = new GmailCodeReader(api as never, { now: () => Date.now(), sleep: async () => undefined });
  assert.equal(await reader.codeFrom({ domain: "amazon.co.uk", since: Date.now() - 10_000, timeoutMs: 1 }), undefined);
});

/* ---------- the relay: email first ---------- */

test("a code the site sent by email is used without bothering Paul", async () => {
  const before = log().length;
  const { sent, gate, job } = relay({ mailbox: { codeFrom: async () => "482913" } });
  assert.equal(await job().code({ domain: "amazon.co.uk", emailOffered: true }), "482913");
  assert.equal(sent.length, 0, "Paul was not asked when the site's email carried the code");
  assert.ok(!log().slice(before).includes("482913"), "the code is not in the log");
});

test("with no email, Paul is asked in chat and his own reply carries the code in", async () => {
  const before = log().length;
  const { sent, gate, job } = relay({ mailbox: { codeFrom: async () => undefined } });
  const waiting = job().code({ domain: "amazon.co.uk", emailOffered: true });
  const ask = await sentOne(sent);
  assert.match(ask, /Amazon UK asked for a code to sign in/);
  const id = ask.match(/code ([a-f0-9]{6})/)?.[1];
  assert.ok(id, `the ask names an id: ${ask}`);
  assert.equal(gate.pending().length, 1);
  const decided = gate.redeem({ id: id!, code: "918273", by: PAUL });
  assert.equal(decided.accepted, true);
  assert.ok(!decided.text.includes("918273"), "the code is never repeated back");
  assert.equal(await waiting, "918273");
  // Single use: the same code a second time settles nothing.
  assert.equal(gate.redeem({ id: id!, code: "918273", by: PAUL }).accepted, false);
  assert.equal(gate.pending().length, 0);
  const written = log().slice(before);
  assert.ok(written.includes(id!), "the log records the request");
  assert.ok(!written.includes("918273") && !sent.join(" ").includes("918273"), "no code in the log or the messages");
});

test("a code that never comes expires, and the sign-in stops instead of guessing", async () => {
  const { sent, gate, job } = relay({ ttlMs: 40 });
  assert.equal(await job().code({ domain: "example.com" }), undefined);
  assert.match(sent[1] ?? "", /No code came for Example/);
  assert.equal(gate.pending().length, 0);
  assert.match(log(), /"event":"expired"/);
});

test("a code for one waiting sign-in is refused for another", async () => {
  const { sent, gate, job } = relay();
  const first = job("jobA").code({ domain: "amazon.co.uk" });
  const second = job("jobB").code({ domain: "example.com" });
  const ask = await sentOne(sent);
  assert.equal(sent.length, 2, "each sign-in asks on its own");
  const idA = ask.match(/code ([a-f0-9]{6})/)?.[1];
  const idB = sent[1]!.match(/code ([a-f0-9]{6})/)?.[1];
  assert.ok(idA && idB && idA !== idB);
  // Bare code with two requests waiting: refused, and neither sign-in is settled.
  const bare = gate.redeem({ code: "123456", by: PAUL });
  assert.equal(bare.accepted, false);
  assert.match(bare.text, /Two sites are waiting/);
  assert.equal(gate.pending().length, 2);
  // The id decides which one it is: the other keeps waiting.
  assert.equal(gate.redeem({ id: idB!, code: "555444", by: PAUL }).accepted, true);
  assert.equal(await second, "555444");
  assert.equal(gate.pending().length, 1);
  gate.dropJob("jobA");
  assert.equal(await first, undefined, "a dropped job's wait ends");
  assert.equal(gate.pending().length, 0);
});

test("a bare code is taken when exactly one sign-in is waiting", async () => {
  const { sent, gate, job } = relay();
  const waiting = job().code({ domain: "amazon.co.uk" });
  await sentOne(sent);
  assert.equal(gate.redeem({ code: "777888", by: PAUL }).accepted, true);
  assert.equal(await waiting, "777888");
});

test("only an allowlisted account can settle a code", async () => {
  const { sent, gate, job } = relay();
  const waiting = job().code({ domain: "amazon.co.uk" });
  const ask = await sentOne(sent);
  const id = ask.match(/code ([a-f0-9]{6})/)![1];
  assert.equal(gate.redeem({ id, code: "123456", by: "tg:10000000" }).accepted, false);
  assert.equal(gate.pending().length, 1);
  assert.equal(gate.redeem({ id, code: "123456", by: PAUL }).accepted, true);
  assert.equal(await waiting, "123456");
});

test("a code request is rate limited per job", async () => {
  const { sent, gate, job } = relay({ maxPerJob: 1 });
  const one = job().code({ domain: "amazon.co.uk" });
  await sentOne(sent);
  const id = gate.pending()[0]?.id;
  assert.ok(id, "one request is waiting");
  gate.redeem({ id: id!, code: "123456", by: PAUL });
  assert.equal(await one, "123456");
  assert.equal(await job().code({ domain: "amazon.co.uk" }), undefined, "the second request is refused");
  assert.match(log(), /"reason":"rate limited"/);
});

/* ---------- a run the system started never takes a code ---------- */

test("a scheduled run is refused a code outright and never asks Paul", async () => {
  const { sent, gate } = relay({ mailbox: { codeFrom: async () => "482913" } });
  await assert.rejects(() => gate.forJob({ id: "jobS", replyTo: PAUL, scheduled: true }).code({ domain: "amazon.co.uk", emailOffered: true }), OtpError);
  assert.equal(sent.length, 0, "nothing was asked of Paul");
  assert.equal(gate.pending().length, 0);
  assert.match(log(), /"reason":"scheduled run"/);
  assert.ok(!log().includes("482913"), "not even the mailbox code was used");
});

test("a site the workforce may never act on is refused a code", async () => {
  const { gate } = relay();
  await assert.rejects(() => gate.forJob({ id: "job1", replyTo: PAUL }).code({ domain: "mail.google.com" }), OtpError);
});

/* ---------- the pieces around it ---------- */

test("Paul's reply is recognised in the forms he is likely to send", () => {
  assert.deepEqual(parseCodeCommand("code 16d5d3 123456"), { id: "16d5d3", code: "123456" });
  assert.deepEqual(parseCodeCommand("Code 16D5D3 123456"), { id: "16d5d3", code: "123456" });
  assert.deepEqual(parseCodeCommand("the code is 123456"), { code: "123456" });
  assert.deepEqual(parseCodeCommand("code 4829"), { code: "4829" });
  assert.deepEqual(parseCodeCommand("837291"), { code: "837291" });
  // The id on its own is read as a code-shaped token; the relay then says it is the id, not the code.
  assert.deepEqual(parseCodeCommand("code 16d5d3"), { code: "16d5d3" });
  assert.equal(parseCodeCommand("start a research job"), undefined);
  assert.equal(parseCodeCommand("code 12"), undefined);
});

test("the site, and how long the page's own code lasts, are read from what Paul sees", () => {
  assert.equal(siteLabel("www.amazon.co.uk"), "Amazon UK");
  assert.equal(siteLabel("en.wikipedia.org"), "Wikipedia");
  assert.equal(siteLabel("github.com"), "Github");
  assert.equal(codeTtlMs("This code expires in 5 minutes."), 5 * 60_000);
  assert.equal(codeTtlMs("Enter the code we sent you"), undefined);
});
