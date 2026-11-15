/**
 * One-use bridge commission: a brief pinned by hash starts exactly one engineer job that passes the queue hold for
 * itself only, is never reviewed or merged automatically, and cannot be used twice.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-commission-"));
process.env.ENGINEER_SLOTS = "1";
process.env.ALLOWED_TELEGRAM_IDS = "99887766";
const { instinctRouter, INSTINCT_PATH } = await import("../src/instinct-bridge.js");
const { BridgeChat } = await import("../src/instinct-chat.js");
const { Store } = await import("../src/store.js");
const { JobRunner } = await import("../src/jobs.js");
const { ConsoleMessenger } = await import("../src/whatsapp.js");
import type { AgentRunner } from "../src/agents.js";

const TOKEN = "commission-test-token";
const BRIEF = "Build the synthetic-only connector.";
const HASH = createHash("sha256").update(BRIEF).digest("hex");
const PR = "https://github.com/acme/clear-ops/pull/90";
const waitFor = async (pred: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

async function serve(o: { allow?: Record<string, string>; brief?: string | undefined; blocked?: string; start?: () => void; logFile?: string }) {
  const started: string[] = [];
  const store = { allJobs: () => [], getJob: () => undefined, readOutput: () => undefined, queueHold: () => undefined };
  const chat = new BridgeChat({ ask: async () => "x", logFile: path.join(os.tmpdir(), `cm-${Math.random()}.jsonl`) });
  const app = express();
  app.use(express.json());
  app.use(INSTINCT_PATH, instinctRouter({
    store: store as never, token: TOKEN, chat, chatEnabled: false,
    commissionAllow: o.allow ?? { "hsbc-ais": HASH }, commissionBrief: () => ("brief" in o ? o.brief : BRIEF),
    commission: (id) => { o.start?.(); started.push(id); return { id: "abc123", status: "running" }; },
    ...(o.blocked ? { commissionBlocked: () => o.blocked } : {}),
    commissionLogFile: o.logFile ?? path.join(os.tmpdir(), `cl-${Math.random()}.json`),
  }));
  const server = await new Promise<import("node:http").Server>((r) => { const s = app.listen(0, () => r(s)); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${INSTINCT_PATH}/commission`;
  const post = (body: unknown, token: string | null = TOKEN) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { post, started, close: () => { server.close(); server.closeAllConnections(); } };
}

test("commission route: 404 without an allowlist, 401/404 without the token, 403 for an unlisted brief", async () => {
  const none = await serve({ allow: {} });
  assert.equal((await none.post({ briefId: "hsbc-ais" })).status, 404);
  none.close();
  const s = await serve({});
  assert.notEqual((await s.post({ briefId: "hsbc-ais" }, null)).status, 202);
  assert.equal((await s.post({ briefId: "other-brief" })).status, 403);
  assert.equal((await s.post({ briefId: "../etc" })).status, 403);
  assert.equal(s.started.length, 0);
  s.close();
});

test("commission route: the retained brief must match its pinned hash, and a missing brief starts nothing", async () => {
  const bad = await serve({ brief: BRIEF + " changed" });
  assert.equal((await bad.post({ briefId: "hsbc-ais" })).status, 409);
  assert.equal(bad.started.length, 0);
  bad.close();
  const missing = await serve({ brief: undefined });
  assert.equal((await missing.post({ briefId: "hsbc-ais" })).status, 404);
  assert.equal(missing.started.length, 0);
  missing.close();
});

test("commission route: starts once, is idempotent after, survives a restart, and a blocked state starts nothing", async () => {
  const logFile = path.join(os.tmpdir(), `cl-fixed-${Math.random()}.json`);
  const blocked = await serve({ blocked: "The daily spend cap is reached", logFile });
  assert.equal((await blocked.post({ briefId: "hsbc-ais" })).status, 423);
  assert.equal(blocked.started.length, 0);
  blocked.close();
  const a = await serve({ logFile });
  const first = await a.post({ briefId: "hsbc-ais" });
  assert.equal(first.status, 202);
  assert.equal(((await first.json()) as { id: string }).id, "abc123");
  assert.equal((await a.post({ briefId: "hsbc-ais" })).status, 409);
  assert.equal(a.started.length, 1);
  a.close();
  const b = await serve({ logFile });
  assert.equal((await b.post({ briefId: "hsbc-ais" })).status, 409, "the log outlives the process");
  assert.equal(b.started.length, 0);
  b.close();
});

test("commission route: a crash between the two log writes closes the commission, and an unreadable log closes the route", async () => {
  const pending = path.join(os.tmpdir(), `cl-pending-${Math.random()}.json`);
  fs.writeFileSync(pending, JSON.stringify({ "hsbc-ais": "pending" }));
  const a = await serve({ logFile: pending });
  assert.equal((await a.post({ briefId: "hsbc-ais" })).status, 409);
  assert.equal(a.started.length, 0);
  a.close();
  const broken = path.join(os.tmpdir(), `cl-broken-${Math.random()}.json`);
  fs.writeFileSync(broken, "{not json");
  const b = await serve({ logFile: broken });
  assert.equal((await b.post({ briefId: "hsbc-ais" })).status, 503);
  assert.equal(b.started.length, 0);
  b.close();
});

test("commissioned job: passes the queue hold for itself only, leaves the hold set, is not reviewed or merged, and others stay queued", async () => {
  const runs: string[][] = [];
  const runner: AgentRunner = async (o) => { runs.push((o.disallowedTools as string[] | undefined) ?? []); return { text: `Opened ${PR}. Tests green.` }; };
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-cstore-")));
  const jobs = new JobRunner(store, new ConsoleMessenger(), runner);
  store.setQueueHold({ kind: "auth", since: new Date().toISOString(), jobId: "aaaaaa" });
  const other = jobs.start("engineer", "An unrelated change", "tg:99887766", "self");
  const c = jobs.startCommission("hsbc-ais", BRIEF, "tg:99887766", "Commission hsbc-ais");
  await waitFor(() => store.getJob(c.id)!.status === "done");
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(store.queueHold(), "the global hold is still set");
  assert.equal(store.getJob(other.id)!.status, "queued", "an ordinary job still waits behind the hold");
  assert.equal(store.allJobs().filter((j) => j.kind === "maintain").length, 0, "no automatic review or merge");
  assert.equal(store.getJob(c.id)!.commission, "hsbc-ais");
  assert.equal(store.getJob(c.id)!.pr, PR);
  assert.equal(store.getJob(c.id)!.target, "self");
  assert.equal(store.getJob(c.id)!.permits, undefined);
  assert.ok(runs.some((d) => d.includes("Task")), "the commissioned engineer cannot start nested workers");
});
