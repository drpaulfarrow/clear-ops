/**
 * The Instinct bridge: off without a token, bearer-only, read-only status with no briefs or outputs,
 * and a note that only ever goes to Paul's own chat, labelled, and starts nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import express from "express";
import type { AddressInfo } from "node:net";

const { instinctRouter, statusData, cleanNote, NOTE_MAX_CHARS, INSTINCT_PATH } = await import("../src/instinct-bridge.js");

const SECRET_BRIEF = "SECRET-BRIEF-TEXT sk-or-v1-abcdef";
const jobs = [
  { id: "aaa111", kind: "engineer", title: "Fly deploy", brief: SECRET_BRIEF, status: "failed", failure: "auth", createdAt: "2026-11-15T07:00:00Z", finishedAt: "2026-11-15T07:32:00Z", output: "SECRET-OUTPUT", requestedBy: "x" },
  { id: "bbb222", kind: "research", title: "Tollbit", brief: SECRET_BRIEF, status: "done", createdAt: "2026-11-15T06:00:00Z", finishedAt: "2026-11-15T06:10:00Z", pr: "#7", requestedBy: "x" },
] as never[];
const store = { allJobs: () => [...jobs], queueHold: () => ({ kind: "auth", jobId: "aaa111", since: "2026-11-15T07:32:00Z" }) } as never;

async function serve(token: string | undefined, clock = () => Date.now()) {
  const sent: string[] = [];
  const app = express();
  app.use(express.json());
  app.use(INSTINCT_PATH, instinctRouter({ store, token, notifyPaul: (t) => sent.push(t), now: clock }));
  const server = await new Promise<import("node:http").Server>((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}${INSTINCT_PATH}`;
  return { base, sent, close: () => server.close() };
}
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

test("no token configured: every route is a 404", async () => {
  const s = await serve(undefined);
  assert.equal((await fetch(`${s.base}/status`)).status, 404);
  assert.equal((await fetch(`${s.base}/note`, { method: "POST" })).status, 404);
  s.close();
});

test("wrong or missing token is refused, and repeated misses are slowed", async () => {
  const s = await serve("right-token");
  assert.equal((await fetch(`${s.base}/status`)).status, 401);
  assert.equal((await fetch(`${s.base}/status`, { headers: auth("wrong") })).status, 401);
  for (let i = 0; i < 4; i++) await fetch(`${s.base}/status`, { headers: auth("wrong") });
  assert.equal((await fetch(`${s.base}/status`, { headers: auth("right-token") })).status, 429);
  assert.equal(s.sent.length, 0);
  s.close();
});

test("status shows ids, titles, outcomes and the hold, and never a brief or an output", async () => {
  const s = await serve("right-token");
  const res = await fetch(`${s.base}/status`, { headers: auth("right-token") });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes("SECRET-BRIEF") && !text.includes("SECRET-OUTPUT") && !text.includes("sk-or"));
  const body = JSON.parse(text);
  assert.equal(body.queueHeld.kind, "auth");
  assert.equal(body.jobs[0].id, "aaa111");
  assert.equal(body.jobs[0].failure, "auth");
  assert.equal(body.jobs[1].pr, "#7");
  s.close();
});

test("a note reaches Paul's chat only, labelled, and nothing else is exposed to change", async () => {
  const s = await serve("right-token");
  const post = (b: unknown) => fetch(`${s.base}/note`, { method: "POST", headers: { ...auth("right-token"), "content-type": "application/json" }, body: JSON.stringify(b) });
  assert.equal((await post({})).status, 400);
  assert.equal((await post({ text: "retry aaa111" })).status, 200);
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0], /^Note from your assistant \(Instinct\)\. You did not type this/);
  assert.match(s.sent[0], /retry aaa111/);
  // No other routes or methods exist: nothing can resume, retry or approve.
  for (const p of ["/resume", "/retry", "/approve", "/jobs"]) assert.equal((await fetch(`${s.base}${p}`, { method: "POST", headers: auth("right-token") })).status, 404);
  s.close();
});

test("notes are rate limited per hour and cleaned", async () => {
  let t = 1_000_000;
  const s = await serve("right-token", () => t);
  for (let i = 0; i < 12; i++) {
    const r = await fetch(`${s.base}/note`, { method: "POST", headers: { ...auth("right-token"), "content-type": "application/json" }, body: JSON.stringify({ text: `n${i}` }) });
    assert.equal(r.status, 200);
  }
  const over = await fetch(`${s.base}/note`, { method: "POST", headers: { ...auth("right-token"), "content-type": "application/json" }, body: JSON.stringify({ text: "x" }) });
  assert.equal(over.status, 429);
  t += 61 * 60_000;
  const again = await fetch(`${s.base}/note`, { method: "POST", headers: { ...auth("right-token"), "content-type": "application/json" }, body: JSON.stringify({ text: "x" }) });
  assert.equal(again.status, 200);
  assert.equal(cleanNote("a\u0000b\u001bc  d"), "abc d");
  assert.equal(cleanNote(42), undefined);
  assert.equal(cleanNote("x".repeat(NOTE_MAX_CHARS + 50))?.length, NOTE_MAX_CHARS);
  assert.equal(statusData(store).jobs.length, 2);
  s.close();
});

test("the bridge is wired to the chat and nothing else: no orchestrator, runner or approval gate", () => {
  const src = fs.readFileSync(new URL("../src/instinct-bridge.ts", import.meta.url), "utf8");
  assert.ok(!/orchestrator|JobRunner|OutboundGate|DnsGate|PurchaseGate|vault|process\.env/i.test(src.replace(/\/\*[\s\S]*?\*\//g, "")), "the bridge must not import or touch any gate, runner or secret");
});
