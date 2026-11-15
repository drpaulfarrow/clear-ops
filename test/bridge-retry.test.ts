/**
 * Scoped retry on the Instinct bridge: inert unless the owner lists failed job ids, never more than the
 * listed ids, never past the daily spend cap, never a resume, and a bounded number a day.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import type { AddressInfo } from "node:net";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-retry-"));
const { instinctRouter, INSTINCT_PATH } = await import("../src/instinct-bridge.js");
const { BridgeChat } = await import("../src/instinct-chat.js");

const TOKEN = "retry-test-token";
const base = (id: string, status: string) => ({ id, kind: "engineer", title: id, brief: "b", status, createdAt: "2026-11-15T07:00:00Z" });

async function serve(opts: { allow?: string[]; blocked?: string; perDay?: number; withRetry?: boolean; statuses?: Record<string, string>; logFile?: string; guilds?: () => Promise<unknown> } = {}) {
  const calls: string[] = [];
  const statuses: Record<string, string> = opts.statuses ?? { aaa111: "failed", bbb222: "failed", ccc333: "done" };
  const store = {
    allJobs: () => [],
    getJob: (id: string) => (statuses[id] ? base(id, statuses[id]) : undefined),
    readOutput: () => undefined,
    queueHold: () => ({ kind: "auth", since: "2026-11-15T07:32:00Z", jobId: "aaa111" }),
  };
  const chat = new BridgeChat({ ask: async () => "x", logFile: path.join(os.tmpdir(), `rl-${Math.random()}.jsonl`) });
  const app = express();
  app.use(express.json());
  app.use(INSTINCT_PATH, instinctRouter({
    store: store as never, token: TOKEN, chat, chatEnabled: false,
    ...(opts.allow ? { retryAllow: opts.allow } : {}),
    ...(opts.withRetry === false ? {} : { retry: (id: string) => { calls.push(id); return { id, status: "queued" }; } }),
    retryBlocked: () => opts.blocked,
    ...(opts.perDay ? { retryPerDay: opts.perDay } : {}),
    ...(opts.logFile ? { retryLogFile: opts.logFile } : {}),
    ...(opts.guilds ? { guilds: opts.guilds } : {}),
  }) as never);
  const server = await new Promise<import("node:http").Server>((r) => { const s = app.listen(0, () => r(s)); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${INSTINCT_PATH}/retry`;
  const post = (id: unknown, token: string | null = TOKEN) =>
    fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ id }) });
  const guildsUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}${INSTINCT_PATH}/discord/guilds`;
  const getGuilds = () => fetch(guildsUrl, { headers: { authorization: `Bearer ${TOKEN}` } });
  return { post, getGuilds, calls, close: () => server.close() };
}

test("no allowlist: the retry route does not exist and nothing is rerun", async () => {
  const s = await serve({});
  assert.equal((await s.post("aaa111")).status, 404);
  const s2 = await serve({ allow: [] });
  assert.equal((await s2.post("aaa111")).status, 404);
  assert.deepEqual([...s.calls, ...s2.calls], []);
  s.close(); s2.close();
});

test("needs the bearer token", async () => {
  const s = await serve({ allow: ["aaa111"] });
  assert.equal((await s.post("aaa111", null)).status, 401);
  assert.equal((await s.post("aaa111", "wrong")).status, 401);
  assert.deepEqual(s.calls, []);
  s.close();
});

test("only an allowlisted failed job is rerun, exactly that one", async () => {
  const s = await serve({ allow: ["aaa111"] });
  const r = await s.post("aaa111");
  assert.equal(r.status, 202);
  assert.deepEqual(s.calls, ["aaa111"]);
  assert.equal((await s.post("bbb222")).status, 403, "failed but not listed");
  assert.equal((await s.post("zzz")).status, 403);
  assert.equal((await s.post(["aaa111", "bbb222"])).status, 403, "no lists");
  assert.deepEqual(s.calls, ["aaa111"]);
  s.close();
});

test("a job that is not failed is refused, and an unknown one is a 404", async () => {
  const s = await serve({ allow: ["ccc333", "ddd444"] });
  assert.equal((await s.post("ccc333")).status, 409);
  assert.equal((await s.post("ddd444")).status, 404);
  assert.deepEqual(s.calls, []);
  s.close();
});

test("the daily spend cap blocks the retry before anything runs", async () => {
  const s = await serve({ allow: ["aaa111"], blocked: "The daily spend cap is reached, so no retry runs from here." });
  const r = await s.post("aaa111");
  assert.equal(r.status, 423);
  assert.deepEqual(s.calls, []);
  s.close();
});

test("a day's retries are limited", async () => {
  const s = await serve({ allow: ["aaa111", "bbb222"], perDay: 1 });
  assert.equal((await s.post("aaa111")).status, 202);
  assert.equal((await s.post("bbb222")).status, 429);
  assert.deepEqual(s.calls, ["aaa111"]);
  s.close();
});

test("the bridge source never calls resume", async () => {
  const s = await serve({ allow: ["aaa111"] });
  s.close();
  const src = fs.readFileSync(new URL("../src/instinct-bridge.ts", import.meta.url), "utf8");
  assert.ok(!/resume\(/.test(src.replace(/\/\*[\s\S]*?\*\//g, "")), "the bridge never calls resume");
});

test("discord guild look: 404 without a gateway, read-only shape with one, never a token", async () => {
  const { inspectGuilds } = await import("../src/discord.js");
  const { PermissionFlagsBits, ChannelType } = await import("discord.js");
  const guild = {
    id: "g1", name: "Paul HQ", ownerId: "42",
    members: {
      me: { permissions: { has: (p: bigint) => p === PermissionFlagsBits.ManageChannels } },
      fetch: async (id: string) => { if (id !== "42") throw new Error("Unknown Member"); return { permissions: { has: (p: bigint) => p === PermissionFlagsBits.Administrator } }; },
    },
    channels: { cache: [{ id: "c1", name: "general", type: ChannelType.GuildText, parentId: "cat1" }, { id: "cat1", name: "Text", type: ChannelType.GuildCategory, parentId: null }] },
  };
  const r = await inspectGuilds({ guilds: { cache: [guild] } }, "42");
  assert.deepEqual(r.guilds[0], { id: "g1", name: "Paul HQ", ownerIsOwner: true, ownerIsAdministrator: true, botCanManageChannels: true, channels: [{ id: "c1", name: "general", kind: "text", parentId: "cat1" }, { id: "cat1", name: "Text", kind: "category", parentId: null }] });
  const other = await inspectGuilds({ guilds: { cache: [guild] } }, "7");
  assert.equal(other.guilds[0]!.ownerIsOwner, false);
  assert.equal(other.guilds[0]!.ownerIsAdministrator, null, "unknown member is unknown, not false");
  assert.ok(!JSON.stringify(r).toLowerCase().includes("token"));
});

test("discord guild look works on real discord.js Collections (Maps), not only arrays", async () => {
  const { inspectGuilds } = await import("../src/discord.js");
  const { Collection, PermissionFlagsBits, ChannelType } = await import("discord.js");
  const channels = new Collection<string, { id: string; name: string; type: number; parentId: string | null }>();
  channels.set("c1", { id: "c1", name: "general", type: ChannelType.GuildText, parentId: null });
  const guild = {
    id: "g1", name: "Paul HQ", ownerId: "42",
    members: { me: { permissions: { has: (p: bigint) => p === PermissionFlagsBits.ManageChannels } }, fetch: async () => ({ permissions: { has: () => false } }) },
    channels: { cache: channels },
  };
  const guilds = new Collection<string, typeof guild>();
  guilds.set("g1", guild);
  const r = await inspectGuilds({ guilds: { cache: guilds } }, "42");
  assert.equal(r.guilds.length, 1);
  assert.equal(r.guilds[0]!.name, "Paul HQ");
  assert.equal(r.guilds[0]!.botCanManageChannels, true);
  assert.deepEqual(r.guilds[0]!.channels, [{ id: "c1", name: "general", kind: "text", parentId: null }]);
});

test("the daily retry limit survives a restart (counted before the job is touched)", async () => {
  const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rl-")), "bridge-retries.json");
  const a = await serve({ allow: ["aaa111", "bbb222"], perDay: 1, logFile });
  assert.equal((await a.post("aaa111")).status, 202);
  a.close();
  assert.equal(JSON.parse(fs.readFileSync(logFile, "utf8")).length, 1);
  const b = await serve({ allow: ["aaa111", "bbb222"], perDay: 1, logFile }); // a fresh router, as after a restart
  assert.equal((await b.post("bbb222")).status, 429);
  assert.deepEqual(b.calls, []);
  b.close();
});

test("a missing retry log means none yet; a corrupt or wrongly shaped one closes the route", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rl-"));
  const fresh = await serve({ allow: ["aaa111"], logFile: path.join(dir, "none.json") });
  assert.equal((await fresh.post("aaa111")).status, 202);
  fresh.close();
  for (const [i, body] of ["not json", "{\"a\":1}", "[1,\"x\"]", ""].entries()) {
    const f = path.join(dir, `bad${i}.json`);
    fs.writeFileSync(f, body);
    const s = await serve({ allow: ["aaa111"], logFile: f });
    assert.equal((await s.post("aaa111")).status, 503, `corrupt log ${JSON.stringify(body)}`);
    assert.deepEqual(s.calls, []);
    s.close();
  }
});

test("a log that cannot be read for another reason (a directory) closes the route", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rl-"));
  const s = await serve({ allow: ["aaa111"], logFile: dir });
  assert.equal((await s.post("aaa111")).status, 503);
  assert.deepEqual(s.calls, []);
  s.close();
});

test("a log that cannot be written refuses the retry before the job is touched, and does not count it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rl-"));
  const f = path.join(dir, "missing-dir", "bridge-retries.json"); // the folder does not exist: read says ENOENT, write fails
  const s = await serve({ allow: ["aaa111"], logFile: f });
  assert.equal((await s.post("aaa111")).status, 503);
  assert.deepEqual(s.calls, []);
  fs.mkdirSync(path.dirname(f));
  assert.equal((await s.post("aaa111")).status, 202, "the failed attempt was not counted");
  s.close();
});

test("the log is written by rename, leaving no temporary file and a valid list", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rl-"));
  const f = path.join(dir, "bridge-retries.json");
  const s = await serve({ allow: ["aaa111"], logFile: f });
  assert.equal((await s.post("aaa111")).status, 202);
  assert.deepEqual(fs.readdirSync(dir), ["bridge-retries.json"]);
  assert.equal(JSON.parse(fs.readFileSync(f, "utf8")).length, 1);
  s.close();
});

test("the guild route: 404 without a gateway, 404 when none is connected, 502 when Discord fails, 200 with data", async () => {
  const none = await serve({});
  assert.equal((await none.getGuilds()).status, 404);
  const disconnected = await serve({ guilds: async () => undefined });
  assert.equal((await disconnected.getGuilds()).status, 404);
  const failing = await serve({ guilds: async () => { throw new Error("boom"); } });
  assert.equal((await failing.getGuilds()).status, 502);
  const ok = await serve({ guilds: async () => ({ guilds: [] }) });
  const r = await ok.getGuilds();
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { guilds: [] });
  for (const x of [none, disconnected, failing, ok]) x.close();
});
