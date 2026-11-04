/**
 * The DNS agent's safety: GoDaddy is faked, and every request it receives is recorded so the tests can
 * show exactly what was and was not sent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-dns-"));
process.env.GODADDY_DOMAINS = "example.test,other.test";

const { GoDaddyClient, blockers, mintDnsGrant, requestDigest, requestFor, listSnapshots, DnsError } = await import("../src/dns.js");
const { DnsGate, parseDnsCommand, dnsServer } = await import("../src/dns-gate.js");
const { Store } = await import("../src/store.js");
const { Orchestrator } = await import("../src/orchestrator.js");
const { JobRunner } = await import("../src/jobs.js");
const { Scheduler } = await import("../src/scheduler.js");

const PAUL = "tg:99887766";
const KEY = "key_abcdef123456";
const SECRET = "secret_zyxwvu987654";

interface Call {
  method: string;
  path: string;
  body?: any;
  auth?: string;
}

/** A fake GoDaddy with one zone, which applies PATCH and PUT the way v1 does. */
function world(zone: Array<{ type: string; name: string; data: string; ttl: number }> = [], opts: { failWriteAt?: number; status?: number } = {}) {
  const calls: Call[] = [];
  let writes = 0;
  const records = [...zone];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, body, auth: (init?.headers as Record<string, string>)?.Authorization });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
    if (opts.status) return json({ code: "ACCESS_DENIED", message: `Authenticated user is not allowed access ${KEY}` }, opts.status);
    if (method === "GET" && url.pathname === "/v1/domains") return json([{ domain: "example.test" }, { domain: "stranger.test" }]);
    if (method === "GET" && url.pathname.endsWith("/records")) return json(records);
    if (method === "PATCH" || method === "PUT") {
      if (++writes === opts.failWriteAt) return json({ code: "INVALID_BODY", message: "nope" }, 422);
      if (method === "PATCH") records.push(...body);
      else {
        const [, , , , , type, name] = url.pathname.split("/");
        const at = records.findIndex((r) => r.type === type && r.name === name);
        records[at] = { type, name, ...body[0] };
      }
      return new Response("", { status: 200 });
    }
    return json({ message: "unexpected" }, 500);
  }) as typeof fetch;
  const client = new GoDaddyClient(f, { key: KEY, secret: SECRET, base: "https://api.test" });
  return { calls, records, client, writes: () => calls.filter((c) => c.method !== "GET") };
}

const ZONE = [
  { type: "A", name: "@", data: "76.76.21.21", ttl: 600 },
  { type: "CNAME", name: "app", data: "clear-exchange.fly.dev", ttl: 3600 },
  { type: "MX", name: "@", data: "mail.example.test", ttl: 3600 },
  { type: "TXT", name: "@", data: "v=spf1 include:_spf.example.test ~all", ttl: 3600 },
];
const add = (name: string, data: string, type = "CNAME", extra = {}) => ({ action: "add" as const, type: type as any, name, data, ...extra });

function setup(zone = ZONE, opts = {}) {
  const w = world(zone, opts);
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-dns-store-")));
  const sent: Array<{ to: string; text: string }> = [];
  const gate = new DnsGate(store, w.client, { send: async (to: string, text: string) => void sent.push({ to, text }) } as never);
  return { ...w, store, gate, sent };
}
const origin = { jobId: "j1", replyTo: PAUL };

test("a new CNAME is shown with before and after, changes nothing, and applies only on Paul's id", async () => {
  const s = setup();
  const a = await s.gate.prepare("example.test", [add("publisher", "clear-exchange.fly.dev")], "Publisher platform", origin);
  assert.equal(s.writes().length, 0, "preparing changes nothing");
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0].text, /Before: \(nothing at this name and type\)/);
  assert.match(s.sent[0].text, /After: CNAME publisher -> clear-exchange.fly.dev \(TTL 3600\)/);
  assert.match(s.sent[0].text, new RegExp(`dns apply ${a.id}`));
  const out = await s.gate.approve(a.id, PAUL);
  assert.match(out, /Done on example.test/);
  assert.match(out, /records are there/);
  assert.deepEqual(s.writes().map((c) => [c.method, c.path]), [["PATCH", "/v1/domains/example.test/records"]]);
  assert.deepEqual(s.writes()[0].body, [{ type: "CNAME", name: "publisher", data: "clear-exchange.fly.dev", ttl: 3600 }]);
  assert.equal(s.store.getDns(a.id)?.status, "executed");
  assert.equal(s.store.getDns(a.id)?.approvedBy, PAUL, "the audit record names the approver");
  assert.match(await s.gate.approve(a.id, PAUL), /already executed/, "approval is single use");
  assert.equal(s.writes().length, 1);
});

test("a snapshot of the whole zone is saved before the first write, owner-only, and the change is logged", async () => {
  const s = setup();
  const a = await s.gate.prepare("example.test", [add("docs", "clear-exchange.fly.dev")], undefined, origin);
  await s.gate.approve(a.id, PAUL);
  const file = s.store.getDns(a.id)!.snapshot!;
  assert.ok(file && fs.existsSync(file));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const snap = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(snap.records.length, ZONE.length, "the snapshot is the zone as it was before the change");
  assert.ok(listSnapshots("example.test").some((f) => file.endsWith(f)));
  const log = fs.readFileSync(path.join(process.env.DATA_DIR!, "dns", "changes.log"), "utf8");
  assert.match(log, new RegExp(a.id));
  assert.ok(!log.includes(SECRET) && !log.includes(KEY));
  const methods = s.calls.map((c) => c.method);
  assert.equal(methods[methods.indexOf("PATCH") - 1], "GET", "the zone is read (and saved) immediately before the first write");
});

test("the hard blocks are refused at prepare time and nothing is sent", async () => {
  const s = setup();
  const refused: Array<[string, any[]]> = [
    ["deleting", [{ action: "delete", type: "CNAME", name: "app", data: "x.example.net" }]],
    ["NS", [add("sub", "ns1.example.net", "NS")]],
    ["MX", [add("@", "mail.example.net", "MX")]],
    ["SPF", [add("@", "v=spf1 include:evil.example ~all", "TXT")]],
    ["SPF at a subdomain", [add("mail", "v=spf1 -all", "TXT")]],
    ["DMARC name", [add("_dmarc", "anything", "TXT")]],
    ["DMARC value", [add("x", "v=DMARC1; p=none", "TXT")]],
    ["DKIM name", [add("s1._domainkey", "k.example.net", "CNAME")]],
    ["DKIM TXT", [add("s1._domainkey", "v=DKIM1; k=rsa; p=AAAA", "TXT")]],
    ["apex A", [add("@", "1.2.3.4", "A")]],
    ["apex A by full name", [add("example.test", "1.2.3.4", "A")]],
    ["apex AAAA", [add("@", "2001:db8::1", "AAAA")]],
    ["wildcard", [add("*", "clear-exchange.fly.dev")]],
    ["TXT replace", [{ action: "replace", type: "TXT", name: "@", data: "hello" }]],
    ["six records", Array.from({ length: 6 }, (_, i) => add(`h${i}`, "clear-exchange.fly.dev"))],
    ["CNAME on a name with records", [add("@", "clear-exchange.fly.dev")]],
    ["private A", [add("lan", "10.0.0.5", "A")]],
    ["secret in TXT", [add("t", "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "TXT")]],
    ["duplicate", [add("app", "clear-exchange.fly.dev")]],
  ];
  for (const [what, changes] of refused) {
    await assert.rejects(s.gate.prepare("example.test", changes as never, undefined, origin), DnsError, what);
  }
  assert.equal(s.sent.length, 0, "Paul is never shown a refused change");
  assert.equal(s.writes().length, 0);
  assert.equal(s.store.listDns().length, 0);
});

test("exactly five records is fine, and a domain off the allowlist is refused before any request", async () => {
  const s = setup();
  const five = Array.from({ length: 5 }, (_, i) => add(`h${i}`, "clear-exchange.fly.dev"));
  const a = await s.gate.prepare("example.test", five, undefined, origin);
  assert.equal(a.changes.length, 5);
  const before = s.calls.length;
  await assert.rejects(s.gate.prepare("stranger.test", [add("x", "clear-exchange.fly.dev")], undefined, origin), /not on the list/);
  await assert.rejects(s.client.records("stranger.test"), /not on the list/);
  assert.equal(s.calls.length, before, "no request is made for a domain off the list");
});

test("a replace swaps one A or CNAME, and shows both versions", async () => {
  const s = setup();
  const a = await s.gate.prepare("example.test", [{ action: "replace", type: "CNAME", name: "app", data: "other.fly.dev" }], undefined, origin);
  assert.match(s.sent[0].text, /Before: CNAME app -> clear-exchange.fly.dev/);
  assert.match(s.sent[0].text, /After: CNAME app -> other.fly.dev/);
  await s.gate.approve(a.id, PAUL);
  assert.deepEqual(s.writes().map((c) => [c.method, c.path]), [["PUT", "/v1/domains/example.test/records/CNAME/app"]]);
  assert.deepEqual(s.writes()[0].body, [{ data: "other.fly.dev", ttl: 3600 }]);
  assert.equal(s.records.find((r) => r.name === "app")?.data, "other.fly.dev");
});

test("only an allowlisted chat account approves, approvals expire, and a changed zone needs a new look", async () => {
  const s = setup();
  const a = await s.gate.prepare("example.test", [add("agent", "clear-exchange.fly.dev")], undefined, origin);
  await assert.rejects(s.gate.approve(a.id, "tg:12345"), /only Paul's own chat account/);
  assert.equal(s.gate.cancel(a.id, "tg:12345"), "", "a stranger cannot cancel either");
  assert.equal(s.writes().length, 0);
  // The zone changes under it: nothing is applied.
  s.records.push({ type: "TXT", name: "agent", data: "something", ttl: 600 });
  assert.match(await s.gate.approve(a.id, PAUL), /changed since you saw this/);
  assert.equal(s.writes().length, 0);
  assert.equal(s.store.getDns(a.id)?.status, "changed");
  // Expiry
  let now = new Date("2026-11-04T10:00:00Z");
  const e = new DnsGate(s.store, s.client, undefined, { now: () => now, ttlMs: 3_600_000 });
  const b = await e.prepare("example.test", [add("agent2", "clear-exchange.fly.dev")], undefined, origin);
  now = new Date("2026-11-04T11:00:01Z");
  assert.match(await e.approve(b.id, PAUL), /expired/);
  assert.equal(s.writes().length, 0);
  // Cancel
  const c = await s.gate.prepare("example.test", [add("agent3", "clear-exchange.fly.dev")], undefined, origin);
  assert.match(s.gate.cancel(c.id, PAUL), /Cancelled/);
  assert.match(await s.gate.approve(c.id, PAUL), /already cancelled/);
  assert.equal(s.writes().length, 0);
});

test("approving one change never authorises another, and the client refuses a write without its own grant", async () => {
  const s = setup();
  const a = await s.gate.prepare("example.test", [add("a1", "clear-exchange.fly.dev")], undefined, origin);
  const b = await s.gate.prepare("example.test", [add("b1", "clear-exchange.fly.dev")], undefined, origin);
  await s.gate.approve(a.id, PAUL);
  assert.equal(s.writes().length, 1);
  assert.equal(s.store.getDns(b.id)?.status, "pending");
  const r = requestFor("example.test", add("evil", "evil.example.net") as never);
  await assert.rejects(s.client.write({ actionId: "x", digest: requestDigest(r.method, r.path, r.body) }, r.method, r.path, r.body), /fresh approval/, "a forged grant is refused");
  const g = mintDnsGrant("x", requestDigest(r.method, r.path, r.body));
  await assert.rejects(s.client.write(g, r.method, r.path, [{ type: "CNAME", name: "other", data: "x.example.net", ttl: 600 }]), /does not match/, "a grant is bound to its exact request");
  await assert.rejects(s.client.write(g, "PATCH", "/v1/domains/stranger.test/records", r.body), /does not match|not a DNS record change/);
  assert.equal(s.writes().length, 1);
});

test("the client has no route to delete, transfer, renew, contacts or anything registrar-side", async () => {
  const s = setup();
  for (const [m, p] of [["DELETE", "/v1/domains/example.test/records/CNAME/app"], ["POST", "/v1/domains/example.test/renew"], ["POST", "/v1/domains/example.test/transfer"], ["PATCH", "/v1/domains/example.test"], ["PUT", "/v1/domains/example.test/contacts"], ["PUT", "/v1/domains/example.test/records"], ["PUT", "/v1/domains/example.test/records/MX/@"]] as const) {
    const g = mintDnsGrant("x", requestDigest(m as never, p, []));
    await assert.rejects(s.client.write(g, m as never, p, []), DnsError, `${m} ${p}`);
  }
  assert.equal(s.writes().length, 0);
});

test("the key and secret go only in the Authorization header and are scrubbed from errors", async () => {
  const s = setup(ZONE, { status: 403 });
  await assert.rejects(s.client.records("example.test"), (e: Error) => {
    assert.ok(!e.message.includes(KEY) && !e.message.includes(SECRET), "errors never contain the credentials");
    assert.match(e.message, /GoDaddy said 403 ACCESS_DENIED/);
    assert.match(e.message, /Discount Domain Club/);
    return true;
  });
  assert.equal(s.calls[0].auth, `sso-key ${KEY}:${SECRET}`);
  const none = new GoDaddyClient(fetch, { key: "", secret: "", base: "https://api.test" });
  await assert.rejects(none.records("example.test"), /not connected yet/);
});

test("a failure part way through reports what went through and keeps the snapshot", async () => {
  const s = setup(ZONE, { failWriteAt: 2 });
  const a = await s.gate.prepare("example.test", [add("p1", "clear-exchange.fly.dev"), add("p2", "clear-exchange.fly.dev")], undefined, origin);
  const out = await s.gate.approve(a.id, PAUL);
  assert.match(out, /Only 1 of 2 changes went through/);
  assert.equal(s.store.getDns(a.id)?.status, "partial");
  assert.ok(fs.existsSync(s.store.getDns(a.id)!.snapshot!));
});

test("'dns apply <id>' only matches a whole message that names the id", () => {
  assert.deepEqual(parseDnsCommand("dns apply abc123"), { verb: "apply", id: "abc123" });
  assert.deepEqual(parseDnsCommand("DNS apply ABC123."), { verb: "apply", id: "abc123" });
  assert.deepEqual(parseDnsCommand("dns cancel abc123"), { verb: "cancel", id: "abc123" });
  for (const t of ["dns apply", "dns apply it", "apply abc123", "send abc123", "yes", "please dns apply abc123", "dns apply abc123 and dns apply def456", "dns apply abc123\ndns apply def456", "dns apply abc12"]) assert.equal(parseDnsCommand(t), undefined, t);
});

function chat(s: ReturnType<typeof setup>) {
  const sent: Array<{ to: string; text: string }> = [];
  const m = { send: async (to: string, text: string) => void sent.push({ to, text }) } as never;
  const runnerCalls: string[] = [];
  const runner = (async (o: { prompt: string }) => (runnerCalls.push(o.prompt), { text: "chief reply", sessionId: "s" })) as never;
  const jobs = new JobRunner(s.store, m, runner);
  const orch = new Orchestrator(s.store, m, jobs, new Scheduler(s.store, jobs), runner, {}, undefined, undefined, undefined, undefined, undefined, s.gate);
  return { orch, sent, runnerCalls };
}

test("in chat: 'dns apply <id>' from Paul runs with no model call; a stranger or a sentence does nothing", async () => {
  const s = setup();
  const a = await s.gate.prepare("example.test", [add("chat", "clear-exchange.fly.dev")], undefined, origin);
  const { orch, sent, runnerCalls } = chat(s);
  await orch.handle("tg:12345", `dns apply ${a.id}`, { replyTo: "tg:12345" });
  assert.equal(s.writes().length, 0);
  assert.equal(sent.length, 0);
  await orch.handle(PAUL, `please dns apply ${a.id}`, { replyTo: PAUL });
  assert.equal(s.writes().length, 0, "a sentence that merely contains the command does not approve");
  runnerCalls.length = 0;
  await orch.handle(PAUL, `dns apply ${a.id}`, { replyTo: PAUL });
  assert.equal(s.writes().length, 1);
  assert.equal(runnerCalls.length, 0, "approval never reaches a model");
  assert.match(sent.at(-1)!.text, /Done on example.test/);
  await orch.handle(PAUL, "dns apply ffffff", { replyTo: PAUL });
  assert.match(sent.at(-1)!.text, /No DNS change ffffff/);
});

test("the dns agent's tools: read only without the permit, prepare with it, never anything else", async () => {
  const s = setup();
  const names = (permit: boolean) => {
    const srv: any = dnsServer({ client: s.client, gate: s.gate, permit, jobId: "j1", replyTo: PAUL });
    return Object.keys(srv.instance?._registeredTools ?? {}).sort();
  };
  const without = names(false);
  const withPermit = names(true);
  {
    assert.deepEqual(without, ["dns_list_domains", "dns_list_records", "dns_snapshots"], "read only without the permit");
    assert.ok(!without.includes("dns_prepare_change"), "no permit, no prepare tool");
    assert.ok(withPermit.includes("dns_prepare_change"));
    assert.ok(!withPermit.some((n) => /apply|approve|delete|send/.test(n)), "no tool applies or approves");
  }
});

test("blockers() reads the live zone: a name's existing records decide what may be added", () => {
  assert.deepEqual(blockers("example.test", [add("new", "clear-exchange.fly.dev")] as never, ZONE as never), []);
  assert.deepEqual(blockers("example.test", [add("_acme-challenge.docs", "tokenvalue", "TXT")] as never, ZONE as never), [], "certificate challenge records are fine");
  assert.ok(blockers("example.test", [add("app", "other.fly.dev")] as never, ZONE as never).length, "a name that is already a CNAME");
});

// ---- Personal Access Token (Bearer, Domains v3) ----
const TOKEN = "pat_0123456789abcdef";

/** A fake GoDaddy v3: records have ids, a POST adds one, a PUT by id replaces it. */
function worldV3(zone: Array<{ type: string; name: string; data: string; ttl: number }> = ZONE, opts: { status?: number } = {}) {
  const calls: Call[] = [];
  const records = zone.map((r, i) => ({ ...r, recordId: `rec${i + 1}` }));
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, body, auth: (init?.headers as Record<string, string>)?.Authorization });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
    if (opts.status) return json({ code: opts.status === 401 ? "UNAUTHORIZED" : "ACCESS_DENIED", message: `refused ${TOKEN}` }, opts.status);
    if (method === "GET" && url.pathname === "/v3/domains/domain-names") return json({ items: [{ domain: "example.test" }, { domain: "stranger.test" }], links: [] });
    if (method === "GET" && url.pathname === "/v3/domains/zones/example.test/dns-records") return json({ items: records, links: [] });
    if (method === "POST" && url.pathname === "/v3/domains/zones/example.test/dns-records") {
      records.push({ ...body, recordId: `rec${records.length + 1}` });
      return json(records[records.length - 1], 201);
    }
    if (method === "PUT" && url.pathname.startsWith("/v3/domains/zones/example.test/dns-records/")) {
      const id = url.pathname.split("/").pop();
      const at = records.findIndex((r) => r.recordId === id);
      if (at < 0) return json({ code: "NOT_FOUND" }, 404);
      records[at] = { ...body, recordId: id };
      return json(records[at]);
    }
    return json({ message: "unexpected" }, 500);
  }) as typeof fetch;
  const client = new GoDaddyClient(f, { token: TOKEN, key: "", secret: "", base: "https://api.test" });
  return { calls, records, client, writes: () => calls.filter((c) => c.method !== "GET") };
}

function setupV3(zone = ZONE, opts = {}) {
  const w = worldV3(zone, opts);
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-dns-store-")));
  const sent: Array<{ to: string; text: string }> = [];
  const gate = new DnsGate(store, w.client, { send: async (to: string, text: string) => void sent.push({ to, text }) } as never);
  return { ...w, store, gate, sent };
}

test("with GODADDY_API_TOKEN the client sends Authorization: Bearer on v3 and never sso-key", async () => {
  const s = setupV3();
  assert.equal(s.client.mode(), "token");
  assert.deepEqual(await s.client.domains(), ["example.test"], "narrowed to the allowlist");
  const recs = await s.client.records("example.test");
  assert.equal(recs.length, ZONE.length);
  assert.ok(s.calls.length >= 2);
  for (const c of s.calls) {
    assert.equal(c.auth, `Bearer ${TOKEN}`);
    assert.match(c.path, /^\/v3\//);
  }
});

test("the token wins over key and secret; without it the v1 sso-key path is unchanged", async () => {
  const both = new GoDaddyClient((async (_u: unknown, init?: RequestInit) => {
    seen.push((init?.headers as Record<string, string>).Authorization);
    return new Response(JSON.stringify({ items: [] }), { status: 200 });
  }) as typeof fetch, { token: TOKEN, key: KEY, secret: SECRET, base: "https://api.test" });
  const seen: string[] = [];
  await both.records("example.test");
  assert.deepEqual(seen, [`Bearer ${TOKEN}`]);
  const v1 = setup();
  assert.equal(v1.client.mode(), "key");
  await v1.client.records("example.test");
  assert.equal(v1.calls[0].auth, `sso-key ${KEY}:${SECRET}`);
  assert.match(v1.calls[0].path, /^\/v1\//);
});

test("token mode: an approved add is a v3 POST and a replace is a v3 PUT by record id, all behind the gate", async () => {
  const s = setupV3();
  const a = await s.gate.prepare("example.test", [add("publisher", "clear-exchange.fly.dev")], undefined, origin);
  assert.equal(s.writes().length, 0, "preparing changes nothing");
  await s.gate.approve(a.id, PAUL);
  assert.deepEqual(s.writes().map((c) => [c.method, c.path, c.auth]), [["POST", "/v3/domains/zones/example.test/dns-records", `Bearer ${TOKEN}`]]);
  assert.deepEqual(s.writes()[0].body, { type: "CNAME", name: "publisher", data: "clear-exchange.fly.dev", ttl: 3600 });
  assert.ok(fs.existsSync(s.store.getDns(a.id)!.snapshot!), "snapshot taken");
  const b = await s.gate.prepare("example.test", [{ action: "replace" as const, type: "CNAME" as any, name: "app", data: "new.fly.dev" }], undefined, origin);
  await s.gate.approve(b.id, PAUL);
  const put = s.writes()[1];
  assert.deepEqual([put.method, put.path], ["PUT", "/v3/domains/zones/example.test/dns-records/rec2"]);
  assert.deepEqual(put.body, { type: "CNAME", name: "app", data: "new.fly.dev", ttl: 3600 });
});

test("token mode keeps every hard block, the allowlist and the grant requirement", async () => {
  const s = setupV3();
  await assert.rejects(s.gate.prepare("example.test", [add("x", "mail.example.net", "MX")] as never, undefined, origin));
  await assert.rejects(s.gate.prepare("stranger.test", [add("x", "a.example.net")], undefined, origin));
  const p = "/v3/domains/zones/example.test/dns-records";
  const body = { type: "CNAME", name: "evil", data: "evil.example.net", ttl: 3600 };
  await assert.rejects(s.client.write({ actionId: "x", digest: requestDigest("POST", p, body) }, "POST", p, body), /fresh approval/, "a forged grant is refused");
  for (const [m, path] of [["DELETE", `${p}/rec1`], ["POST", "/v3/domains/example.test/renew"], ["PUT", "/v3/domains/zones/stranger.test/dns-records/rec1"], ["POST", "/v3/domains/zones/stranger.test/dns-records"]] as const) {
    const g = mintDnsGrant("x", requestDigest(m as never, path, body));
    await assert.rejects(s.client.write(g, m as never, path, body), DnsError, `${m} ${path}`);
  }
  assert.equal(s.writes().length, 0);
});

test("token mode: replace without a usable record id is refused rather than guessed", () => {
  assert.throws(() => requestFor("example.test", { action: "replace", type: "CNAME", name: "app", data: "x.fly.dev" } as never, "token", [{ type: "CNAME", name: "app", data: "y", ttl: 600 }]), /no usable id/);
});

test("the token is scrubbed from errors, hints name the token, and nothing else carries it", async () => {
  for (const status of [401, 403]) {
    const s = setupV3(ZONE, { status });
    await assert.rejects(s.client.records("example.test"), (e: Error) => {
      assert.ok(!e.message.includes(TOKEN), "errors never contain the token");
      assert.match(e.message, status === 401 ? /token was refused/ : /scopes domains\.domain:read and domains\.dns:update/);
      return true;
    });
  }
  const none = new GoDaddyClient(fetch, { token: "", key: "", secret: "", base: "https://api.test" });
  assert.equal(none.configured(), false);
  await assert.rejects(none.records("example.test"), /GODADDY_API_TOKEN/);
  const { redact } = await import("../src/repos.js");
  process.env.GODADDY_API_TOKEN = TOKEN;
  try {
    const out = redact(`failed: ${TOKEN} and Authorization: Bearer abcdef123456 and sso-key k12345:s12345`, "");
    assert.ok(!out.includes(TOKEN) && !out.includes("abcdef123456") && !out.includes("k12345:s12345"));
  } finally {
    delete process.env.GODADDY_API_TOKEN;
  }
});
