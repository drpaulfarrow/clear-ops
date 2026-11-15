/**
 * Read-only DM history on the Instinct bridge: only the owner's DM, bearer token, no model, text masked and capped.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import type { AddressInfo } from "node:net";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-dm-"));
const { instinctRouter, INSTINCT_PATH } = await import("../src/instinct-bridge.js");
const { BridgeChat } = await import("../src/instinct-chat.js");
const { readOwnerDm, soleDiscordOwner } = await import("../src/discord.js");
const { Collection } = await import("discord.js");

const TOKEN = "dm-test-token";

async function serve(dmHistory?: (limit: number, before?: string) => Promise<never>) {
  const store = { allJobs: () => [], getJob: () => undefined, readOutput: () => undefined, queueHold: () => undefined };
  const chat = new BridgeChat({ ask: async () => "x", logFile: path.join(os.tmpdir(), `dm-${Math.random()}.jsonl`) });
  const app = express();
  app.use(INSTINCT_PATH, instinctRouter({ store: store as never, token: TOKEN, chat, chatEnabled: false, ...(dmHistory ? { dmHistory } : {}) }) as never);
  const server = await new Promise<import("node:http").Server>((r) => { const s = app.listen(0, () => r(s)); });
  const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}${INSTINCT_PATH}/dm-history`;
  const get = (q = "", token: string | null = TOKEN) => fetch(root + q, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { get, close: () => { server.close(); server.closeAllConnections(); } };
}

test("dm-history: 404 with no gateway wired, 401 without the token", async () => {
  const none = await serve();
  assert.equal((await none.get()).status, 404);
  none.close();
  const s = await serve(async () => ({ messages: [] }) as never);
  assert.equal((await s.get("", null)).status, 401);
  assert.equal((await s.get("", "wrong")).status, 401);
  s.close();
});

test("dm-history: limit and before are validated, text is masked and cut, a throw is a 502, no gateway is a 404", async () => {
  const seen: Array<[number, string | undefined]> = [];
  const long = "word ".repeat(500);
  const s = await serve(async (limit, before) => {
    seen.push([limit, before]);
    return { messages: [{ id: "1", from: "Paul", text: "key sk-abcdefghijklmnop1234 please" }, { id: "2", from: "Clear Ops", text: long }], nextBefore: "1" } as never;
  });
  assert.equal((await s.get("?limit=0")).status, 400);
  assert.equal((await s.get("?limit=101")).status, 400);
  assert.equal((await s.get("?limit=abc")).status, 400);
  assert.equal((await s.get("?before=12")).status, 400);
  assert.equal(seen.length, 0, "a bad request never reaches Discord");
  const ok = await (await s.get("?limit=20&before=123456789012345678")).json() as { messages: Array<{ text: string; truncated?: boolean }>; nextBefore: string };
  assert.deepEqual(seen[0], [20, "123456789012345678"]);
  assert.ok(!ok.messages[0]!.text.includes("sk-abcdefghijklmnop1234"));
  assert.equal(ok.messages[1]!.text.length, 2000);
  assert.equal(ok.messages[1]!.truncated, true);
  assert.equal(ok.nextBefore, "1");
  s.close();
  const bad = await serve(async () => { throw new Error("boom: secret detail"); });
  const r = await bad.get();
  assert.equal(r.status, 502);
  assert.ok(!(await r.text()).includes("boom"));
  bad.close();
  const nogw = await serve(async () => undefined as never);
  assert.equal((await nogw.get()).status, 404);
  nogw.close();
});

test("readOwnerDm: reads only the owner's DM on a real discord.js Collection, oldest first, labels the sides", async () => {
  const fetchedUsers: string[] = [];
  const asked: Array<{ limit: number; before?: string }> = [];
  const msgs = new Collection<string, { id: string; createdTimestamp: number; content: string; author: { id: string; bot: boolean }; attachments: { size: number } }>();
  msgs.set("m2", { id: "m2", createdTimestamp: 2000, content: "done", author: { id: "bot", bot: true }, attachments: { size: 1 } });
  msgs.set("m1", { id: "m1", createdTimestamp: 1000, content: "please look at X", author: { id: "42", bot: false }, attachments: { size: 0 } });
  const client = { users: { fetch: async (id: string) => { fetchedUsers.push(id); return { createDM: async () => ({ messages: { fetch: async (o: { limit: number; before?: string }) => { asked.push(o); return msgs; } } }) }; } } };
  const r = await readOwnerDm(client as never, "42", 2, "999999999999999999");
  assert.deepEqual(fetchedUsers, ["42"], "only the owner is looked up");
  assert.deepEqual(asked, [{ limit: 2, before: "999999999999999999" }]);
  assert.deepEqual(r.messages.map((m) => [m.id, m.from, m.text, m.attachments]), [["m1", "Paul", "please look at X", 0], ["m2", "Clear Ops", "done", 1]]);
  assert.equal(r.nextBefore, "m1", "a full page offers the next older page");
  const short = await readOwnerDm(client as never, "42", 5);
  assert.equal(short.nextBefore, undefined, "a short page is the end");
});

test("dm-history stays read-only: the new code has no send, write or model call", () => {
  const src = fs.readFileSync(new URL("../src/discord.ts", import.meta.url), "utf8");
  const part = src.slice(src.indexOf("export interface DmView"));
  assert.ok(!/\.send\(|writeFile|\.post\(|askAs|fetch\(\s*["'`]http/.test(part.replace(/\/\*[\s\S]*?\*\//g, "")));
});

test("the DM read targets one owner only: several dc:u entries, none or a malformed id mean no target", () => {
  assert.equal(soleDiscordOwner(["dc:u:1564629778697551972"]), "1564629778697551972");
  assert.equal(soleDiscordOwner(["tg:1", "dc:u:1564629778697551972", "dc:u:1564629778697551972"]), "1564629778697551972", "the same id twice is still one owner");
  assert.equal(soleDiscordOwner(["dc:u:1564629778697551972", "dc:u:1564629778697551973"]), undefined, "two owners: refuse, do not pick the first");
  assert.equal(soleDiscordOwner([]), undefined);
  assert.equal(soleDiscordOwner(["tg:1"]), undefined);
  assert.equal(soleDiscordOwner(["dc:u:abc"]), undefined);
});
