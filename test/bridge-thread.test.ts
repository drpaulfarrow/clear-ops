/**
 * Read-only job-thread history on the Instinct bridge: one thread of the configured guild and parent channel,
 * Paul's and the bot's own messages only, other authors counted never read, fail closed on anything unbound.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import type { AddressInfo } from "node:net";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-thread-"));
const { instinctRouter, INSTINCT_PATH } = await import("../src/instinct-bridge.js");
const { BridgeChat } = await import("../src/instinct-chat.js");
const { readJobThread } = await import("../src/discord.js");

const TOKEN = "thread-test-token";
const OWNER = "1564629778697551972", BOT = "1564629778697551999", OTHER = "1564629778697551555";
const GUILD = "1564630331498176512", PARENT = "1564630331968196661", THREAD = "1571427543397961001";
const bind = { ownerUserId: OWNER, botUserId: BOT, guildId: GUILD, parentId: PARENT };

function client(ch: Record<string, unknown> | null, msgs: Array<{ id: string; t: number; c: string; a: string }> = [], throwOnMessages = false) {
  return {
    channels: { fetch: async () => ch && { id: THREAD, guildId: GUILD, parentId: PARENT, isThread: () => true, ...ch, messages: { fetch: async () => { if (throwOnMessages) throw new Error("Missing Access"); return { values: () => msgs.map((m) => ({ id: m.id, createdTimestamp: m.t, content: m.c, author: { id: m.a }, attachments: { size: 0 } })) }; } } } },
  } as never;
}
const MSGS = [
  { id: "1571427543397961011", t: 1000, c: "do the thing", a: OWNER },
  { id: "1571427543397961012", t: 2000, c: "ok", a: BOT },
  { id: "1571427543397961013", t: 3000, c: "SECRET-FROM-SOMEONE-ELSE", a: OTHER },
  { id: "1571427543397961014", t: 4000, c: "another bot", a: "1571427543397960000" },
];

test("thread read: owner and this bot's own id get text, every other author (humans, other bots) is only counted", async () => {
  const r = await readJobThread(client({}, MSGS), bind, THREAD, 50);
  assert.ok(r && r.readable);
  assert.deepEqual(r.messages.map((m) => [m.from, m.text]), [["Paul", "do the thing"], ["Clear Ops", "ok"]]);
  assert.equal(r.otherAuthorMessages, 2);
  assert.ok(!JSON.stringify(r).includes("SECRET-FROM-SOMEONE-ELSE"), "other authors' words never leave");
});

test("thread read: fails closed on anything not bound (wrong guild, wrong parent, not a thread, id mismatch, missing identity or binding)", async () => {
  assert.equal(await readJobThread(client({ guildId: "1564630331498176999" }), bind, THREAD, 50), undefined);
  assert.equal(await readJobThread(client({ parentId: "1564630331968196999" }), bind, THREAD, 50), undefined);
  assert.equal(await readJobThread(client({ isThread: () => false }), bind, THREAD, 50), undefined);
  assert.equal(await readJobThread(client({ id: "1571427543397961999" }), bind, THREAD, 50), undefined);
  assert.equal(await readJobThread(client(null), bind, THREAD, 50), undefined);
  assert.equal(await readJobThread(client({}), { ...bind, guildId: "" }, THREAD, 50), undefined, "no configured guild");
  assert.equal(await readJobThread(client({}), { ...bind, parentId: "" }, THREAD, 50), undefined, "no configured parent");
  assert.equal(await readJobThread(client({}), { ...bind, botUserId: "" }, THREAD, 50), undefined, "no bot identity");
  assert.equal(await readJobThread(client({}), { ...bind, ownerUserId: "" }, THREAD, 50), undefined, "no owner identity");
  assert.equal(await readJobThread(client({}), bind, "abc", 50), undefined);
});

test("thread read: an archived or hidden thread is reported unreadable, nothing is worked around", async () => {
  const r = await readJobThread(client({}, [], true), bind, THREAD, 50);
  assert.ok(r && !r.readable && /archived|hidden/.test(r.reason));
});

test("thread read: a full page returns nextBefore for paging", async () => {
  const r = await readJobThread(client({}, MSGS.slice(0, 2)), bind, THREAD, 2);
  assert.ok(r && r.readable && r.nextBefore === "1571427543397961011");
});

async function serve(job: unknown, threadHistory?: (t: string, limit: number, before?: string) => Promise<never>) {
  const store = { allJobs: () => [], getJob: (id: string) => (id === "j1" ? job : undefined), readOutput: () => undefined, queueHold: () => undefined };
  const chat = new BridgeChat({ ask: async () => "x", logFile: path.join(os.tmpdir(), `th-${Math.random()}.jsonl`) });
  const app = express();
  app.use(INSTINCT_PATH, instinctRouter({ store: store as never, token: TOKEN, chat, chatEnabled: false, isAllowed: (s: string) => s === `dc:u:${OWNER}`, ...(threadHistory ? { threadHistory } : {}) }) as never);
  const server = await new Promise<import("node:http").Server>((r) => { const s = app.listen(0, () => r(s)); });
  const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}${INSTINCT_PATH}/context`;
  const get = (p: string, token: string | null = TOKEN) => fetch(root + p, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { get, close: () => { server.close(); server.closeAllConnections(); } };
}
const pauls = { id: "j1", origin: "chat", requestedBy: `dc:u:${OWNER}`, replyTo: `dc:c:${THREAD}`, brief: "b", kind: "research", status: "done", createdAt: "x" };

test("thread route: token required, 404 unless wired, 404 for a non-Paul job or one with no thread address; the thread id is never taken from the request", async () => {
  const seen: string[] = [];
  const fn = async (t: string) => { seen.push(t); return { readable: true, messages: [{ id: "1", from: "Paul", text: "key sk-abcdefghijklmnop1234 ok" }] } as never; };
  const none = await serve(pauls);
  assert.equal((await none.get("/j1/thread")).status, 404, "not wired");
  none.close();
  const s = await serve(pauls, fn);
  assert.equal((await s.get("/j1/thread", null)).status, 401);
  assert.equal((await s.get("/nope/thread")).status, 404);
  const ok = await (await s.get(`/j1/thread?thread=1111111111111111111&channel=1111111111111111111`)).json() as { messages: Array<{ text: string }> };
  assert.deepEqual(seen, [THREAD], "the id comes from the job record only");
  assert.ok(!ok.messages[0]!.text.includes("sk-abcdefghijklmnop1234"), "masked");
  assert.equal((await s.get("/j1/thread?limit=0")).status, 400);
  assert.equal((await s.get("/j1/thread?before=12")).status, 400);
  s.close();
  const bridgeJob = await serve({ ...pauls, origin: "instinct" }, fn);
  assert.equal((await bridgeJob.get("/j1/thread")).status, 404);
  bridgeJob.close();
  const stranger = await serve({ ...pauls, requestedBy: "dc:u:1564629778697551555" }, fn);
  assert.equal((await stranger.get("/j1/thread")).status, 404);
  stranger.close();
  const dmJob = await serve({ ...pauls, replyTo: OWNER }, fn);
  assert.equal((await dmJob.get("/j1/thread")).status, 404, "a job with no dc:c: address has no mapping");
  dmJob.close();
});

test("thread route: Discord error is a generic 502 with no detail; unbound read is a 404", async () => {
  const bad = await serve(pauls, async () => { throw new Error("boom secret detail"); });
  const r = await bad.get("/j1/thread");
  assert.equal(r.status, 502);
  assert.ok(!(await r.text()).includes("boom"));
  bad.close();
  const unbound = await serve(pauls, async () => undefined as never);
  assert.equal((await unbound.get("/j1/thread")).status, 404);
  unbound.close();
});
