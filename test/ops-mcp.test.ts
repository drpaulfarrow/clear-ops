/**
 * The read-only MCP window for Claude (src/ops-mcp.ts). Off unless switched on; connected only by Paul's
 * own tap on a consent page behind the web app's GitHub sign-in; codes go only to Claude's own callback;
 * tokens are kept as hashes; every tool reads what the app already shows, and nothing reaches a model.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-ops-mcp-"));
process.env.PUBLIC_URL = "https://workforce.example";

const { Store } = await import("../src/store.js");
const { buildApp } = await import("../src/index.js");
const { AppAuth, APP_AUTH_START_PATH, APP_AUTH_CALLBACK_PATH, APP_SESSION_COOKIE, APP_STATE_COOKIE, APP_SIGN_IN_PATH } = await import("../src/app-auth.js");
const { PrStates } = await import("../src/pr-state.js");
const mcp = await import("../src/ops-mcp.js");
import type { AgentRunner } from "../src/agents.js";
import type { Scheduler } from "../src/scheduler.js";

const ORIGIN = "https://workforce.example";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
/** Nothing here may reach a model. */
const runner: AgentRunner = async () => {
  throw new Error("the MCP window must not run any model");
};
const fakeGithub = (async (url: string | URL) => (String(url).includes("access_token") ? new Response(JSON.stringify({ access_token: "gho_x" })) : new Response(JSON.stringify({ login: "drpaulfarrow", id: 4242 })))) as typeof fetch;

type Built = { server: import("node:http").Server; base: string; scheduler: Scheduler; store: InstanceType<typeof Store> };
async function listen(enabled: boolean): Promise<Built> {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-ops-mcp-store-")));
  const appAuth = new AppAuth({ clientId: "client-id", clientSecret: "secret", login: "drpaulfarrow", publicUrl: ORIGIN, fetch: fakeGithub });
  const messenger = { send: async () => undefined, recent: async () => [] as Array<{ author: string; text: string }> };
  const built = buildApp({ messenger, runner, store, appAuth, opsMcpEnabled: enabled, prStates: new PrStates({ token: () => undefined }) });
  return new Promise((resolve) => {
    const srv = built.app.listen(0, () => resolve({ server: srv, base: `http://127.0.0.1:${(srv.address() as import("node:net").AddressInfo).port}`, scheduler: built.scheduler, store }));
  });
}
const pair = (c: string | undefined) => (c ?? "").split(";")[0]!;
const named = (res: Response, name: string) => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));

let on: Built;
let session: string;
before(async () => {
  on = await listen(true);
  const started = await fetch(`${on.base}${APP_AUTH_START_PATH}`, { redirect: "manual" });
  const state = new URL(started.headers.get("location")!).searchParams.get("state")!;
  const back = await fetch(`${on.base}${APP_AUTH_CALLBACK_PATH}?code=abc&state=${state}`, { redirect: "manual", headers: { cookie: pair(named(started, APP_STATE_COOKIE)) } });
  session = pair(named(back, APP_SESSION_COOKIE));
  assert.ok(session.startsWith(APP_SESSION_COOKIE));
});
after(() => {
  on.scheduler.stopAll();
  on.server.close();
});

const json = (base: string, p: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const form = (base: string, p: string, body: Record<string, string>, headers: Record<string, string> = {}) => fetch(`${base}${p}`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(body).toString() });
const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

/** Registers, consents as Paul and exchanges the code: a live token pair. */
async function connect(): Promise<{ access_token: string; refresh_token: string; client_id: string }> {
  const reg = (await (await json(on.base, mcp.MCP_REGISTER_PATH, { redirect_uris: [CALLBACK], client_name: "Claude" })).json()) as { client_id: string };
  const { verifier, challenge } = pkce();
  const fields = { client_id: reg.client_id, redirect_uri: CALLBACK, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state: "st8" };
  const ok = await form(on.base, mcp.MCP_CONNECT_PATH, fields, { cookie: session, origin: ORIGIN });
  assert.equal(ok.status, 303);
  const code = new URL(ok.headers.get("location")!).searchParams.get("code")!;
  const tok = (await (await form(on.base, mcp.MCP_TOKEN_PATH, { grant_type: "authorization_code", code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: CALLBACK })).json()) as { access_token: string; refresh_token: string };
  return { ...tok, client_id: reg.client_id };
}
const rpc = (token: string, body: unknown) => json(on.base, mcp.MCP_PATH, body, { authorization: `Bearer ${token}` });

test("switched off, every route answers as if it did not exist", async () => {
  const off = await listen(false);
  try {
    for (const p of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource"]) assert.equal((await fetch(`${off.base}${p}`)).status, 404, p);
    assert.equal((await json(off.base, mcp.MCP_PATH, { jsonrpc: "2.0", id: 1, method: "initialize" })).status, 404);
    assert.equal((await json(off.base, mcp.MCP_REGISTER_PATH, { redirect_uris: [CALLBACK] })).status, 404);
  } finally {
    off.scheduler.stopAll();
    off.server.close();
  }
});

test("discovery points a client at the consent page behind the app's sign-in, PKCE only", async () => {
  const meta = (await (await fetch(`${on.base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
  assert.equal(meta.authorization_endpoint, `${ORIGIN}${mcp.MCP_CONNECT_PATH}`);
  assert.deepEqual(meta.code_challenge_methods_supported, ["S256"]);
  const res = await json(on.base, mcp.MCP_PATH, { jsonrpc: "2.0", id: 1, method: "initialize" });
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate") ?? "", /resource_metadata="https:\/\/workforce\.example\/\.well-known\/oauth-protected-resource"/);
});

test("a client may register only with Claude's own callback", async () => {
  for (const bad of [[], ["https://evil.example/cb"], [CALLBACK, "https://evil.example/cb"], ["http://claude.ai/api/mcp/auth_callback"]]) assert.equal((await json(on.base, mcp.MCP_REGISTER_PATH, { redirect_uris: bad })).status, 400, String(bad));
  assert.equal((await json(on.base, mcp.MCP_REGISTER_PATH, { redirect_uris: [CALLBACK] })).status, 201);
});

test("only Paul, signed in, on this page's own form, issues a code, and only to the registered callback", async () => {
  const reg = (await (await json(on.base, mcp.MCP_REGISTER_PATH, { redirect_uris: [CALLBACK] })).json()) as { client_id: string };
  const { challenge } = pkce();
  const fields = { client_id: reg.client_id, redirect_uri: CALLBACK, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state: "s" };
  const q = new URLSearchParams(fields).toString();
  // Signed out: to the sign-in, nothing issued.
  const out = await fetch(`${on.base}${mcp.MCP_CONNECT_PATH}?${q}`, { redirect: "manual" });
  assert.equal(out.status, 303);
  assert.equal(out.headers.get("location"), APP_SIGN_IN_PATH);
  assert.equal((await form(on.base, mcp.MCP_CONNECT_PATH, fields, { origin: ORIGIN })).status, 303);
  assert.equal((await form(on.base, mcp.MCP_CONNECT_PATH, fields, { origin: ORIGIN })).headers.get("location"), APP_SIGN_IN_PATH);
  // Signed in: the page says what it allows and asks.
  const page = await (await fetch(`${on.base}${mcp.MCP_CONNECT_PATH}?${q}`, { headers: { cookie: session } })).text();
  assert.match(page, /It can read only\. It cannot start, stop, merge, approve, send or change anything/);
  // Another return address, no PKCE, or an unknown client: refused on the page, never redirected.
  for (const change of [{ redirect_uri: "https://evil.example/cb" }, { code_challenge_method: "plain" }, { client_id: "c_nobody" }]) {
    const res = await form(on.base, mcp.MCP_CONNECT_PATH, { ...fields, ...change }, { cookie: session, origin: ORIGIN });
    assert.equal(res.status, 200, JSON.stringify(change));
    assert.equal(res.headers.get("location"), null);
  }
  // A post from another site (or none named) is refused.
  assert.equal((await form(on.base, mcp.MCP_CONNECT_PATH, fields, { cookie: session })).status, 403);
  assert.equal((await form(on.base, mcp.MCP_CONNECT_PATH, fields, { cookie: session, origin: "https://evil.example" })).status, 403);
  const ok = await form(on.base, mcp.MCP_CONNECT_PATH, fields, { cookie: session, origin: ORIGIN });
  const to = new URL(ok.headers.get("location")!);
  assert.equal(`${to.origin}${to.pathname}`, CALLBACK);
  assert.equal(to.searchParams.get("state"), "s");
});

test("a code is single use and needs its own verifier; tokens are kept only as hashes and refresh rotates", async () => {
  const reg = (await (await json(on.base, mcp.MCP_REGISTER_PATH, { redirect_uris: [CALLBACK] })).json()) as { client_id: string };
  const { verifier, challenge } = pkce();
  const fields = { client_id: reg.client_id, redirect_uri: CALLBACK, response_type: "code", code_challenge: challenge, code_challenge_method: "S256" };
  const code = new URL((await form(on.base, mcp.MCP_CONNECT_PATH, fields, { cookie: session, origin: ORIGIN })).headers.get("location")!).searchParams.get("code")!;
  const swap = (v: string) => form(on.base, mcp.MCP_TOKEN_PATH, { grant_type: "authorization_code", code, code_verifier: v, client_id: reg.client_id, redirect_uri: CALLBACK });
  assert.equal((await swap(pkce().verifier)).status, 400, "the wrong verifier spends the code");
  assert.equal((await swap(verifier)).status, 400, "and it cannot be used again");
  const pair2 = await connect();
  const kept = JSON.stringify(on.store.settings().opsMcp);
  assert.ok(!kept.includes(pair2.access_token) && !kept.includes(pair2.refresh_token), "no token is stored as itself");
  const again = await form(on.base, mcp.MCP_TOKEN_PATH, { grant_type: "refresh_token", refresh_token: pair2.refresh_token });
  assert.equal(again.status, 200);
  assert.equal((await form(on.base, mcp.MCP_TOKEN_PATH, { grant_type: "refresh_token", refresh_token: pair2.refresh_token })).status, 400, "a refresh token is used once");
  assert.equal((await rpc("x".repeat(43), { jsonrpc: "2.0", id: 1, method: "ping" })).status, 401);
});

test("connected, it lists only read-only tools and answers from what the app shows, with no model", async () => {
  const { access_token } = await connect();
  const init = (await (await rpc(access_token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).json()) as { result: { protocolVersion: string } };
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal((await rpc(access_token, { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  const list = (await (await rpc(access_token, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json()) as { result: { tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }> } };
  assert.deepEqual(list.result.tools.map((t) => t.name), ["board", "history", "job", "spend", "chat"]);
  assert.ok(list.result.tools.every((t) => t.annotations.readOnlyHint));
  const board = (await (await rpc(access_token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "board", arguments: {} } })).json()) as { result: { content: Array<{ text: string }> } };
  const parsed = JSON.parse(board.result.content[0]!.text) as { jobs: unknown[]; plans: unknown[] };
  assert.ok(Array.isArray(parsed.jobs) && Array.isArray(parsed.plans));
  const missing = (await (await rpc(access_token, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "job", arguments: { id: "ffffff" } } })).json()) as { result: { isError: boolean } };
  assert.equal(missing.result.isError, true);
  for (const name of ["start_job", "cancel_job", "merge", "send"]) {
    const res = (await (await rpc(access_token, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name, arguments: {} } })).json()) as { error?: { code: number } };
    assert.equal(res.error?.code, -32602, name);
  }
});

test("revoking forgets every client and token", async () => {
  const { access_token } = await connect();
  new mcp.OpsMcpAuth(on.store).revokeAll();
  assert.equal((await rpc(access_token, { jsonrpc: "2.0", id: 1, method: "ping" })).status, 401);
});

test("the window's own code imports nothing that runs a model, a gate or a job action", () => {
  const src = fs.readFileSync(new URL("../src/ops-mcp.ts", import.meta.url), "utf8");
  const imports = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["node:crypto", "express", "./store.js"]);
  // In the service the tools are the app's own read functions, and nothing else.
  const index = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const tools = index.slice(index.indexOf("const mcpTools = "), index.indexOf("app.use(opsMcpRouter("));
  const reads = [...tools.matchAll(/read: [^,]*?\b(app[A-Z]\w*)\(/g)].map((m) => m[1]);
  assert.deepEqual(reads, ["appBoard", "appHistory", "appJob", "appSpend", "appThread"]);
  assert.match(tools, /appChat\(appSource\(\), chat, where\)/);
  assert.doesNotMatch(tools, /jobs\.|orchestrator|runner|send\(|merge|approve/);
});
