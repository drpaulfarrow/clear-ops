/**
 * The web app under /app (docs/APP.md): GitHub sign-in for one account, then a read-only board, the
 * job history and one job with its trace and cost.
 *
 * No network and no model: GitHub is a fake `fetch`, and the fake runner fails the test if it is ever
 * called. The tests are as much about what the app must never do as what it does: nothing under /app
 * opens without a session, only the one GitHub account gets one, the token GitHub returns and the
 * client secret never reach a page or a cookie, a figure is the provider's own or absent (never the
 * SDK's estimate), an assistant's output is not served, and nothing here writes.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-app-"));
process.env.PUBLIC_URL = "https://workforce.example";

const { Store } = await import("../src/store.js");
const { buildApp } = await import("../src/index.js");
const { AppAuth, APP_PATH, APP_SIGN_IN_PATH, APP_AUTH_START_PATH, APP_AUTH_CALLBACK_PATH, APP_SIGN_OUT_PATH, APP_SESSION_COOKIE, APP_STATE_COOKIE, APP_SESSION_DAYS, APP_SIGN_INS_PER_MINUTE } = await import("../src/app-auth.js");
const { appBoard, appChat, appHistory, appJob, APP_HISTORY_PAGE } = await import("../src/app-data.js");
const { webFiles, WebFilesError, WEB_FILES_MAX, WEB_FILES_BYTES } = await import("../src/web-chat.js");
const { WEB_COMMANDS, WEB_PICTURE_BYTES } = await import("../src/web-chat.js");
const { webOwnChat, WEB_NEW_CHAT, WEB_CHATS_MAX, WEB_CHAT_TITLE_MAX } = await import("../src/web-chat.js");
const { HELP } = await import("../src/orchestrator.js");
const { WebChat, routeWeb, webRefusal, webThread, webTopic, isWebConversation, WEB_SENDER, WEB_CONVERSATION, WEB_APPROVAL_REFUSAL, WEB_CODE_REFUSAL, WEB_CODE_PLACEHOLDER, WEB_KEEP, WEB_THREAD_KEEP, WEB_THREADS_MAX, WEB_TEXT_MAX } = await import("../src/web-chat.js");
const { isAllowed } = await import("../src/config.js");
const { mintAppApproval, spendAppApproval, APP_APPROVER, APP_GRANT_MS } = await import("../src/app-approver.js");
const { DnsGate } = await import("../src/dns-gate.js");
const { OutboundGate } = await import("../src/outbound.js");
const { SignupGate } = await import("../src/signup-gate.js");
const { seenHash } = await import("../src/app-data.js");
const { PrStates, PR_STATE_CONCURRENCY } = await import("../src/pr-state.js");
const { AppPulls, PullError, PULL_FILES_MAX, PULL_PATCH_MAX, PULL_PATCHES_MAX, PULL_LIST_MAX, PULL_LIST_FRESH_MS } = await import("../src/app-pulls.js");
const { applyLive, setLive, liveView, LiveSettingError, LIVE_CAP_MIN, LIVE_CAP_MAX } = await import("../src/live-settings.js");
const { config } = await import("../src/config.js");
const { appSpend } = await import("../src/app-data.js");
const { appAsset, APP_CSP } = await import("../src/app-pages.js");
const { workerGithubEnv } = await import("../src/github-auth.js");
const { tracesDir } = await import("../src/trace.js");
import type { AgentRunner } from "../src/agents.js";
import type { Scheduler } from "../src/scheduler.js";

const PAUL = "tg:99887766";
const CLIENT_SECRET = "client-secret-that-must-never-leave";
const GITHUB_TOKEN = "gho_tokenThatMustNeverBeKept123456";

/** What the fake chief says. Unset, any run is a bug: nothing but a chat message may reach a model. */
let chiefSays: string | undefined;
const chiefAsked: string[] = [];
/** The provider's ids for the calls the fake chief's next turns make, for the tests that price them. */
let chiefCalls: string[] = [];
const runner: AgentRunner = async (o) => {
  if (chiefSays === undefined) throw new Error("the web app must not run any worker");
  chiefAsked.push(o.prompt);
  for (const id of chiefCalls) o.costMeter?.note(id);
  return { text: chiefSays, sessionId: "chief-session" };
};

/** Who the fake GitHub says is signing in, and every request it was sent. */
let githubUser: { login: string; id: number } | "down" = { login: "drpaulfarrow", id: 4242 };
const githubCalls: Array<{ url: string; body?: string; auth?: string }> = [];
const fakeGithub = (async (url: string | URL, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  githubCalls.push({ url: String(url), body: typeof init?.body === "string" ? init.body : undefined, auth: headers.get("authorization") ?? undefined });
  if (githubUser === "down") return new Response("no", { status: 503 });
  if (String(url).includes("/login/oauth/access_token")) return new Response(JSON.stringify({ access_token: GITHUB_TOKEN }), { status: 200 });
  return new Response(JSON.stringify(githubUser), { status: 200 });
}) as typeof fetch;

let now = Date.UTC(2026, 10, 18, 18, 0, 0);
let store: InstanceType<typeof Store>;
let auth: InstanceType<typeof AppAuth>;
let scheduler: Scheduler;
let chat: InstanceType<typeof WebChat>;
let orchestrator: ReturnType<typeof buildApp>["orchestrator"];
/** Everything sent to a channel that is not the app's own chat. */
const elsewhere: Array<{ to: string; text: string }> = [];
let server: import("node:http").Server;
let base: string;
const bodies: string[] = [];
const cookies: string[] = [];

const get = async (p: string, cookie?: string) => {
  const res = await fetch(`${base}${p}`, { redirect: "manual", headers: cookie ? { cookie } : {} });
  cookies.push(...res.headers.getSetCookie());
  return res;
};
const text = async (res: Response) => {
  const body = await res.text();
  bodies.push(body);
  return body;
};
const pair = (setCookie: string | undefined) => (setCookie ?? "").split(";")[0];
const cookieNamed = (res: Response, name: string) => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));

/** Walks the real sign-in: start, then GitHub's redirect back with the state the browser was given. */
async function signInAs(user: typeof githubUser): Promise<Response> {
  githubUser = user;
  const started = await get(APP_AUTH_START_PATH);
  const state = new URL(started.headers.get("location")!).searchParams.get("state")!;
  return get(`${APP_AUTH_CALLBACK_PATH}?code=abc&state=${state}`, pair(cookieNamed(started, APP_STATE_COOKIE)));
}
/** One signed-in session for the whole file: the sign-in itself is limited per minute, and the clock here is pinned. */
let signedIn: string | undefined;
const session = async () => (signedIn ??= pair(cookieNamed(await signInAs({ login: "drpaulfarrow", id: 4242 }), APP_SESSION_COOKIE)));

/** The fake GitHub behind the app's pull request panel: one pull request whose state the tests set. */
const PULL_TOKEN = "ghs_pullTokenThatMustStayInAHeader12345";
const HEAD = "a".repeat(40);
const pull = {
  calls: [] as Array<{ method: string; url: string; auth: string | null; body?: string }>,
  pr: {} as Record<string, unknown>,
  checks: [] as Array<{ name: string; status: string; conclusion: string | null }>,
  files: [] as Array<Record<string, unknown>>,
  mergeAnswer: undefined as undefined | { status: number; body: unknown },
  list: [] as Array<Record<string, unknown>>,
  listAnswer: undefined as undefined | { status: number; body: unknown },
};
function resetPull() {
  pull.calls.length = 0;
  pull.pr = { number: 12, title: "Add the thing", body: "Why.\r\n\r\nWhat changed.", state: "open", merged: false, draft: false, mergeable: true, commits: 2, additions: 5, deletions: 1, changed_files: 2, user: { login: "clear-ops-bot" }, head: { sha: HEAD, ref: "clear/thing" }, base: { ref: "main" } };
  pull.checks = [{ name: "test", status: "completed", conclusion: "success" }, { name: "deploy", status: "completed", conclusion: "skipped" }];
  pull.files = [{ filename: "src/thing.ts", status: "modified", additions: 5, deletions: 1, patch: "@@ -1 +1,5 @@\n-old\n+new" }, { filename: "docs/pic.png", status: "added", additions: 0, deletions: 0 }];
  pull.mergeAnswer = undefined;
  pull.listAnswer = undefined;
  pull.list = [
    { number: 12, title: "Add the thing", draft: false, created_at: "2026-11-18T12:00:00Z", user: { login: "clear-ops-bot" }, head: { ref: "clear/thing" } },
    { number: 9, title: "An older one ghp_abcdefghijklmnopqrstuvwxyz0123456789", draft: true, created_at: "2026-11-17T09:00:00Z", user: { login: "someone" }, head: { ref: "old" } },
  ];
}
resetPull();
const pullFetch = (async (url: string | URL, init?: RequestInit) => {
  const u = String(url);
  const method = init?.method ?? "GET";
  pull.calls.push({ method, url: u, auth: new Headers(init?.headers).get("authorization"), body: typeof init?.body === "string" ? init.body : undefined });
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
  if (method === "PUT") {
    if (pull.mergeAnswer) return json(pull.mergeAnswer.body, pull.mergeAnswer.status);
    pull.pr = { ...pull.pr, state: "closed", merged: true };
    return json({ merged: true });
  }
  if (u.includes("/pulls?state=open")) return pull.listAnswer ? json(pull.listAnswer.body, pull.listAnswer.status) : json(u.includes("/site/") ? [] : pull.list);
  if (u.includes("/check-runs")) return json({ check_runs: pull.checks });
  if (u.includes("/files")) return json(pull.files);
  return json(pull.pr);
}) as typeof fetch;
const PULL_REPOS = [
  { alias: "self", slug: "drpaulfarrow/clear-ops", name: "workforce" },
  { alias: "product", slug: "Owner/Product", name: "Clear Exchange" },
  { alias: "site", slug: "drpaulfarrow/site", name: "site" },
];
const newPulls = (now: () => number = Date.now) =>
  new AppPulls({ repos: () => PULL_REPOS, repoOf: (job) => (PULL_REPOS.some((r) => r.alias === job.target) ? job.target : undefined), token: (repo) => (repo.alias === "product" ? undefined : PULL_TOKEN), selfAlias: "self", fetch: pullFetch, now });
const SELF_PR = "https://github.com/drpaulfarrow/clear-ops/pull/12";

function listen(a: InstanceType<typeof AppAuth>, s: InstanceType<typeof Store>, c: InstanceType<typeof WebChat> = new WebChat()) {
  // Like the service's own router (src/channels.ts), it can read a conversation back; the app's are read from its transcript.
  const messenger = { send: async (to: string, text: string) => void elsewhere.push({ to, text }), recent: async () => [] as Array<{ author: string; text: string }> };
  // No test here may reach the real GitHub: the app is given a pull-request reader with no credential.
  const built = buildApp({ messenger, runner, store: s, appAuth: a, webChat: c, prStates: new PrStates({ token: () => undefined }), pulls: newPulls() });
  return new Promise<{ server: import("node:http").Server; base: string; scheduler: Scheduler; orchestrator: typeof built.orchestrator }>((resolve) => {
    const srv = built.app.listen(0, () => resolve({ server: srv, base: `http://127.0.0.1:${(srv.address() as import("node:net").AddressInfo).port}`, scheduler: built.scheduler, orchestrator: built.orchestrator }));
  });
}

before(async () => {
  store = new Store(process.env.DATA_DIR!);
  auth = new AppAuth({ clientId: "client-id", clientSecret: CLIENT_SECRET, login: "drpaulfarrow", publicUrl: "https://workforce.example", fetch: fakeGithub, now: () => now });
  chat = new WebChat({ dir: process.env.DATA_DIR!, now: () => now });
  ({ server, base, scheduler, orchestrator } = await listen(auth, store, chat));
});

after(() => {
  scheduler.stopAll();
  server.close();
});

test("with no OAuth client set the app is closed and says so", async () => {
  const offStore = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-app-off-")));
  const off = await listen(new AppAuth({ clientId: "", clientSecret: "", login: "drpaulfarrow", fetch: fakeGithub }), offStore);
  try {
    const page = await fetch(`${off.base}${APP_PATH}`, { redirect: "manual" });
    assert.equal(page.status, 303);
    assert.equal(page.headers.get("location"), APP_SIGN_IN_PATH);
    assert.equal((await fetch(`${off.base}${APP_PATH}/api/board`)).status, 401);
    assert.match(await (await fetch(`${off.base}${APP_SIGN_IN_PATH}`)).text(), /not switched on yet/);
    const start = await fetch(`${off.base}${APP_AUTH_START_PATH}`, { redirect: "manual" });
    assert.equal(start.headers.get("location"), `${APP_SIGN_IN_PATH}?refused=off`);
    assert.equal(start.headers.getSetCookie().length, 0);
  } finally {
    off.scheduler.stopAll();
    off.server.close();
  }
});

test("nothing under /app opens without a session, however the path is written", async () => {
  for (const p of [APP_PATH, `${APP_PATH}/`, `${APP_PATH}/anything`, "/APP", "/App/Anything"]) {
    const res = await get(p);
    assert.equal(res.status, 303, p);
    assert.equal(res.headers.get("location"), APP_SIGN_IN_PATH, p);
  }
  for (const p of [`${APP_PATH}/api/board`, `${APP_PATH}/api/history`, `${APP_PATH}/api/jobs/abc123`, "/APP/API/board", `${APP_PATH}/api/later-route`]) {
    const res = await get(p);
    assert.equal(res.status, 401, p);
    assert.deepEqual(await res.json(), { error: "signed out" }, p);
  }
  const out = await fetch(`${base}${APP_SIGN_OUT_PATH}`, { method: "POST", redirect: "manual" });
  assert.equal(out.status, 303, "a sign-out with no session is only sent to the sign-in page");
  assert.equal(out.headers.getSetCookie().length, 0, "and clears nothing");
});

test("starting a sign-in asks GitHub for no scope and ties the answer to this browser", async () => {
  const res = await get(APP_AUTH_START_PATH);
  assert.equal(res.status, 303);
  const to = new URL(res.headers.get("location")!);
  assert.equal(`${to.origin}${to.pathname}`, "https://github.com/login/oauth/authorize");
  assert.equal(to.searchParams.get("client_id"), "client-id");
  assert.equal(to.searchParams.get("redirect_uri"), `https://workforce.example${APP_AUTH_CALLBACK_PATH}`);
  assert.equal(to.searchParams.get("scope"), null, "no scope: the token can read the public profile and nothing else");
  assert.ok((to.searchParams.get("state") ?? "").length >= 24);
  const state = cookieNamed(res, APP_STATE_COOKIE)!;
  assert.match(state, /HttpOnly/);
  assert.match(state, /Secure/);
  assert.match(state, /SameSite=Lax/);
  assert.ok(!res.headers.get("location")!.includes(CLIENT_SECRET));
});

test("a callback nobody here started is refused before GitHub is asked anything", async () => {
  const started = await get(APP_AUTH_START_PATH);
  const state = new URL(started.headers.get("location")!).searchParams.get("state")!;
  const stateCookie = pair(cookieNamed(started, APP_STATE_COOKIE));
  const before = githubCalls.length;
  for (const [query, cookie] of [
    [`code=abc&state=${state}`, undefined],
    [`code=abc&state=someone-elses-state`, stateCookie],
    [`state=${state}`, stateCookie],
    [`code=abc`, stateCookie],
  ] as const) {
    const res = await get(`${APP_AUTH_CALLBACK_PATH}?${query}`, cookie);
    assert.equal(res.headers.get("location"), `${APP_SIGN_IN_PATH}?refused=state`, query);
    assert.equal(cookieNamed(res, APP_SESSION_COOKIE), undefined, query);
  }
  assert.equal(githubCalls.length, before, "GitHub was never called");
});

test("the allowed account signs in; the token is used once and kept nowhere", async () => {
  const before = githubCalls.length;
  const res = await signInAs({ login: "DrPaulFarrow", id: 4242 });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), APP_PATH);
  const cookie = cookieNamed(res, APP_SESSION_COOKIE)!;
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, new RegExp(`Max-Age=${APP_SESSION_DAYS * 24 * 60 * 60}`));
  assert.ok(!cookie.includes(GITHUB_TOKEN) && !cookie.includes("drpaulfarrow"), "the cookie holds an issued time, an id and a signature");
  const calls = githubCalls.slice(before);
  assert.equal(calls.length, 2, "one exchange and one look at who it is");
  assert.match(calls[0]!.body ?? "", /client-secret-that-must-never-leave/, "the secret goes to GitHub's token endpoint and nowhere else");
  assert.equal(calls[1]!.url, "https://api.github.com/user");
  assert.equal(calls[1]!.auth, `Bearer ${GITHUB_TOKEN}`);
  assert.ok(!JSON.stringify(store.settings()).includes(GITHUB_TOKEN), "the token is not in the store");
  assert.deepEqual(store.settings().appGithubUser, { login: "drpaulfarrow", id: 4242 }, "GitHub's own id is pinned to the login");

  const page = await get(APP_PATH, pair(cookie));
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("content-security-policy"), APP_CSP);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.match(await text(page), /<script type="module" src="\/app\/assets\/app\.js"><\/script>/);
  const signedInVisit = await get(APP_SIGN_IN_PATH, pair(cookie));
  assert.equal(signedInVisit.headers.get("location"), APP_PATH, "already signed in: straight to the app");
});

test("any other account is refused, and so is the same login under another id", async () => {
  const other = await signInAs({ login: "someone-else", id: 7 });
  assert.equal(other.headers.get("location"), `${APP_SIGN_IN_PATH}?refused=account`);
  assert.equal(cookieNamed(other, APP_SESSION_COOKIE), undefined);
  const renamed = await signInAs({ login: "drpaulfarrow", id: 999 });
  assert.equal(renamed.headers.get("location"), `${APP_SIGN_IN_PATH}?refused=account`, "the login was re-registered by someone else");
  assert.equal(cookieNamed(renamed, APP_SESSION_COOKIE), undefined);
  const down = await signInAs("down");
  assert.equal(down.headers.get("location"), `${APP_SIGN_IN_PATH}?refused=github`);
  assert.match(await text(await get(`${APP_SIGN_IN_PATH}?refused=account`)), /not allowed in here/);
  assert.doesNotMatch(await text(await get(`${APP_SIGN_IN_PATH}?refused=%3Cscript%3E`)), /<script>/, "an unknown reason prints nothing");
  assert.deepEqual(store.settings().appGithubUser, { login: "drpaulfarrow", id: 4242 }, "a refused sign-in changes nothing");
});

test("GitHub is asked who someone is only so often, and the limit passes on its own", async () => {
  let clock = 1_000_000;
  const s = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-app-limit-")));
  let asked = 0;
  const counting = (async (url: string | URL) => {
    asked += 1;
    return String(url).includes("access_token") ? new Response(JSON.stringify({ access_token: GITHUB_TOKEN }), { status: 200 }) : new Response(JSON.stringify({ login: "drpaulfarrow", id: 1 }), { status: 200 });
  }) as typeof fetch;
  const a = new AppAuth({ clientId: "id", clientSecret: "s", login: "drpaulfarrow", fetch: counting, now: () => clock });
  const attempt = () => {
    const state = new URL(a.start()!.url).searchParams.get("state")!;
    return a.finish(s, { code: "c", state, cookieHeader: `${APP_STATE_COOKIE}=${state}` });
  };
  for (let i = 0; i < APP_SIGN_INS_PER_MINUTE; i++) assert.ok("cookie" in (await attempt()), `attempt ${i + 1}`);
  assert.deepEqual(await attempt(), { refused: "github" });
  assert.equal(asked, APP_SIGN_INS_PER_MINUTE * 2, "the refused attempt never reached GitHub");
  clock += 61_000;
  assert.ok("cookie" in (await attempt()), "a minute later it works again");
});

test("a tampered, foreign or expired session is refused, and sign-out ends one", async () => {
  const cookie = await session();
  assert.equal((await get(`${APP_PATH}/api/board`, cookie)).status, 200);
  const [name, value] = cookie.split("=");
  const parts = value!.split(".");
  const forged = [
    `${name}=${[parts[0], parts[1], "7", parts[3]].join(".")}`,
    `${name}=${[parts[0], String(Number(parts[1]) + 1), parts[2], parts[3]].join(".")}`,
    `${name}=${parts.slice(0, 3).join(".")}.${"A".repeat(parts[3]!.length)}`,
    `${name}=v1.${parts[1]}.${parts[2]}`,
    `clear_ops_session=${value}`,
  ];
  for (const f of forged) assert.equal((await get(`${APP_PATH}/api/board`, f)).status, 401, f);

  const out = await fetch(`${base}${APP_SIGN_OUT_PATH}`, { method: "POST", redirect: "manual", headers: { cookie } });
  assert.equal(out.status, 303);
  assert.match(cookieNamed(out, APP_SESSION_COOKIE)!, /Max-Age=0/);
  assert.equal((await get(APP_SIGN_OUT_PATH, cookie)).status, 404, "sign-out is a POST only, so a link cannot do it");

  now += (APP_SESSION_DAYS + 1) * 24 * 60 * 60_000;
  assert.equal((await get(`${APP_PATH}/api/board`, cookie)).status, 401, "past its life");
  now -= (APP_SESSION_DAYS + 1) * 24 * 60 * 60_000;
});

test("the files the app is made of are a fixed list and need no session", async () => {
  for (const name of ["app.css", "app.js", "inter.woff2", "space-grotesk.woff2", "jetbrains-mono.woff2"]) {
    const res = await get(`${APP_PATH}/assets/${name}`);
    assert.equal(res.status, 200, name);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    await res.arrayBuffer();
  }
  for (const name of ["index.ts", "..%2f..%2fpackage.json", "%2e%2e%2fapp.js", "constructor", "__proto__"]) assert.equal((await get(`${APP_PATH}/assets/${name}`)).status, 404, name);
  assert.equal(appAsset("../../package.json"), undefined);
  assert.equal(appAsset("toString"), undefined);
  const js = appAsset("app.js")!.body.toString("utf8");
  assert.doesNotMatch(js, /\beval\(|new Function\(|document\.write/);
  assert.equal((js.match(/innerHTML/g) ?? []).length, 1, "one place sets HTML: text the service already rendered and escaped");
  assert.equal((js.match(/method: "post"/g) ?? []).length, 1, "the one form is sign-out");
  assert.deepEqual(js.match(/fetch\(`\$\{API\}[^`]*`, \{ method: "[A-Z]+"/g), ['fetch(`${API}${path}`, { method: "POST"', 'fetch(`${API}/chat`, { method: "POST"'], "two places post: Paul's message, and the helper his buttons use");
  assert.doesNotMatch(js, /method:\s*"(PUT|PATCH|DELETE)"/);
});

/* ---------- The data ---------- */

const iso = (minsAgo: number) => new Date(now - minsAgo * 60_000).toISOString();
const quietQueue = {
  isHeld: () => false,
  queuePosition: () => undefined,
  latestStep: (id: string) => (id === "live" ? "Editing spend.ts" : undefined),
  liveness: () => undefined,
  spendState: () => ({ usd: 12.5, source: "provider" as const, asOf: now }),
  capReached: () => false,
};

test("the board shows the provider's own figures or none, never the SDK's estimate", () => {
  const s = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-app-data-")));
  const mk = (kind: string, title: string, patch: Record<string, unknown>) => s.updateJob(s.createJob(kind as never, `Brief for ${title}`, PAUL, "self", PAUL, { title } as never).id, patch as never);
  const running = mk("engineer", "Running job", { status: "running", startedAt: iso(10), costUsd: 7.77 });
  mk("research", "Queued job", { status: "queued", capBlocked: true });
  const real = mk("engineer", "Real cost", { status: "done", startedAt: iso(60), finishedAt: iso(50), costUsd: 41.41, usage: { costUsd: 3.184, costSource: "provider" } });
  const guess = mk("write", "Estimate only", { status: "done", startedAt: iso(40), finishedAt: iso(30), costUsd: 9.99, usage: { costUsd: 8.88, costSource: "estimate" } });
  mk("design", "Old job", { status: "done", startedAt: iso(60 * 80), finishedAt: iso(60 * 79) });
  s.putPurchase({ id: "p7k2", status: "pending", createdAt: iso(3), expiresAt: iso(-17), shop: "A shop name", items: ["a private item"], total: "£12.00" } as never);
  s.putPurchase({ id: "gone", status: "pending", createdAt: iso(90), expiresAt: iso(60) } as never);

  const board = appBoard({ store: s, queue: quietQueue, now });
  const raw = JSON.stringify(board);
  // For "this figure is nowhere in the answer": the answer without its timestamps. A job's own times come
  // from the real clock, and 18:35:55.512 holds "55.5" as surely as an estimate of $55.50 would (it failed
  // CI that way on 19 Nov 2026, at exactly that second).
  const figures = (answer: unknown) => JSON.stringify(answer).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "");
  assert.ok(!figures({ at: "2026-11-19T18:35:55.512Z" }).includes("55.5") && figures({ usd: 55.5 }).includes("55.5"), "a time is set aside, a figure is not");
  assert.deepEqual(board.spend, { usd: 12.5, note: "OpenRouter's own figure", capReached: false, capLifted: false });
  assert.deepEqual(board.jobs.map((j) => [j.title, j.status]), [["Running job", "running"], ["Queued job", "queued"], ["Estimate only", "done"], ["Real cost", "done"]]);
  assert.equal(board.hasOlder, true, "the job from three days ago is history, not the board");
  assert.equal(board.jobs.find((j) => j.id === real.id)!.costUsd, 3.184);
  assert.equal(board.jobs.find((j) => j.id === guess.id)!.costUsd, undefined);
  assert.equal(board.jobs.find((j) => j.id === running.id)!.costUsd, undefined);
  for (const estimate of ["7.77", "41.41", "9.99", "8.88"]) assert.ok(!figures(board).includes(estimate), `the estimate ${estimate} is nowhere in the answer`);
  assert.equal(board.jobs.find((j) => j.title === "Queued job")!.held, true);
  assert.deepEqual(board.waiting.map((w) => [w.what, w.id, w.command]), [["purchase", "p7k2", "buy p7k2"]], "a live approval is named; an expired one is not");
  assert.ok(!raw.includes("A shop name") && !raw.includes("a private item") && !raw.includes("£12.00"), "what waits is named, never described");

  const unread = appBoard({ store: s, queue: { ...quietQueue, spendState: () => ({ usd: 55.5, source: "estimate" as const, note: "OpenRouter could not be read" }) }, now });
  assert.equal(unread.spend.usd, undefined);
  assert.match(unread.spend.note, /No spend figure: OpenRouter could not be read/);
  assert.ok(!figures(unread).includes("55.5"));

  const page = appHistory({ store: s, queue: quietQueue, now }, board.jobs[board.jobs.length - 1]!.finishedAt);
  assert.deepEqual(page.jobs.map((j) => j.title), ["Old job"]);
  assert.equal(page.next, undefined);
});

test("a run that ended is not a wish that was met: only the service's own evidence earns a tick", () => {
  const s = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-app-outcome-")));
  const done = (kind: string, title: string, patch: Record<string, unknown> = {}) =>
    s.updateJob(s.createJob(kind as never, `Brief for ${title}`, PAUL, "product", PAUL, { title } as never).id, { status: "done", startedAt: iso(20), finishedAt: iso(10), ...patch } as never);
  const purchase = (jobId: string, status: string) => s.putPurchase({ id: `p${jobId}`, status, jobId, host: "shop.example", total: "£23.98", createdAt: iso(15), expiresAt: iso(-5), replyTo: PAUL } as never);

  const never = done("research", "Order nothing", { permits: ["purchase"], summary: "I could not get past the sign-in, so nothing was ordered." });
  const expired = done("research", "Order expired", { permits: ["purchase"] });
  purchase(expired.id, "expired");
  const bought = done("research", "Order bought", { permits: ["purchase"] });
  purchase(bought.id, "executed");
  const asking = done("research", "Order asking", { permits: ["purchase"] });
  purchase(asking.id, "pending");
  const plain = done("research", "Plain research", { summary: "Here is what I found." });
  const merged = done("engineer", "Merged work", { pr: "https://github.com/o/r/pull/1" });
  const mergedReview = done("maintain", "Review: Merged work", { reviewOf: merged.id });
  s.writeOutput(mergedReview.id, "Looks right.\n\nREVIEW https://github.com/o/r/pull/1: merged");
  const left = done("engineer", "Left for Paul", { pr: "https://github.com/o/r/pull/2" });
  s.writeOutput(done("maintain", "Review: Left for Paul", { reviewOf: left.id }).id, "REVIEW https://github.com/o/r/pull/2: needs Paul: merge it yourself");
  const sentBack = done("engineer", "Sent back", { pr: "https://github.com/o/r/pull/3" });
  s.writeOutput(done("maintain", "Review: Sent back", { reviewOf: sentBack.id }).id, "REVIEW https://github.com/o/r/pull/3: changes requested: the test is missing");
  const unreviewed = done("engineer", "No review yet", { pr: "https://github.com/o/r/pull/4" });
  const assistant = done("ea", "Morning brief", { summary: "A private line about someone's email." });
  const failed = s.updateJob(s.createJob("design", "Brief", PAUL, "site", PAUL, { title: "Fell over" } as never).id, { status: "failed", finishedAt: iso(5), failure: "stalled" });

  const board = appBoard({ store: s, queue: quietQueue, now });
  const of = (id: string) => board.jobs.find((j) => j.id === id)!;
  assert.deepEqual(of(never.id).outcome, { state: "not_met", text: "Nothing was bought: no purchase was put to you.", by: "service" });
  assert.equal(of(never.id).said, "I could not get past the sign-in, so nothing was ordered.");
  assert.deepEqual(of(expired.id).outcome, { state: "not_met", text: "Nothing was bought: it expired before you approved it.", by: "service" });
  assert.deepEqual(of(bought.id).outcome, { state: "met", text: "Bought: £23.98 on shop.example.", by: "service" });
  assert.equal(of(asking.id).outcome!.state, "waiting");
  assert.equal(of(plain.id).outcome!.state, "unconfirmed", "a worker saying it went well is not evidence");
  assert.deepEqual(of(merged.id).outcome, { state: "met", text: "Reviewed and merged.", by: "service" });
  assert.deepEqual(of(left.id).outcome, { state: "waiting", text: "Reviewed and left for you: merge it yourself", by: "service" });
  assert.deepEqual(of(sentBack.id).outcome, { state: "not_met", text: "The review asked for changes.", by: "service" });
  assert.equal(of(unreviewed.id).outcome!.state, "unconfirmed");
  assert.equal(of(failed.id).outcome!.state, "not_met");
  assert.equal(of(assistant.id).said, undefined, "what the assistant told him is not put on a card");
  assert.ok(!JSON.stringify(board).includes("someone's email"));
  const ticks = board.jobs.filter((j) => j.outcome?.state === "met").map((j) => j.title).sort();
  assert.deepEqual(ticks, ["Merged work", "Order bought", "Review: Left for Paul", "Review: Merged work", "Review: Sent back"], "what is ticked is what the service can confirm: a purchase, a merge, and a review that gave its verdict");
  assert.deepEqual(of(mergedReview.id).outcome, { state: "met", text: "Reviewed: merged.", by: "service" });
});

test("Paul's own answer comes first, then the service's records, then what the worker says of itself", async () => {
  const { parseOutcome, splitReport, plainMessage, REPORT_RULE, MESSAGE_OPEN, MESSAGE_CLOSE } = await import("../src/messages.js");
  // The worker is told to say how it turned out, and what "met" means.
  assert.match(REPORT_RULE, /"GOAL: met", or "GOAL: not met: <the one reason>", or "GOAL: needs Paul: <the one thing he must do>"/);
  assert.match(REPORT_RULE, /It is met only if the thing Paul asked for now exists or has happened\./);
  assert.deepEqual(parseOutcome("All good.\n\nGOAL: met"), { state: "met" });
  assert.deepEqual(parseOutcome("**GOAL: not met: the checkout asked for a code I could not get**"), { state: "not_met", detail: "the checkout asked for a code I could not get" });
  assert.deepEqual(parseOutcome("- GOAL: needs Paul: approve the purchase"), { state: "needs_paul", detail: "approve the purchase" });
  assert.deepEqual(parseOutcome("GOAL: met\nlater\nGOAL: not met: second thoughts"), { state: "not_met", detail: "second thoughts" }, "the last line counts");
  assert.equal(parseOutcome("The goal: met expectations."), undefined, "a sentence is not the line");
  assert.equal(parseOutcome("GOAL: metric collected"), undefined);
  // The line belongs to the report and never reaches chat.
  const split = splitReport(`The basket is full.\n\nGOAL: not met: no code\n${MESSAGE_OPEN}I filled the basket but could not check out.${MESSAGE_CLOSE}`);
  assert.match(split.report, /GOAL: not met: no code/);
  assert.equal(split.message, "I filled the basket but could not check out.");
  assert.doesNotMatch(plainMessage("I tried.\nGOAL: not met: no code"), /GOAL/);

  const s = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-app-claims-")));
  const done = (kind: string, title: string, patch: Record<string, unknown> = {}) =>
    s.updateJob(s.createJob(kind as never, `Brief for ${title}`, PAUL, "product", PAUL, { title } as never).id, { status: "done", startedAt: iso(20), finishedAt: iso(10), ...patch } as never);
  const saysMet = done("research", "Says met", { claimed: { state: "met" } });
  const saysNot = done("research", "Says not", { claimed: { state: "not_met", detail: "the site was down" } });
  const saysNeeds = done("write", "Says needs", { claimed: { state: "needs_paul", detail: "pick a title" } });
  const silent = done("research", "Says nothing");
  const privateNot = done("ea", "Private not", { claimed: { state: "not_met", detail: "a private reason about someone" } });
  const boughtButSaysNot = done("research", "Bought anyway", { permits: ["purchase"], claimed: { state: "not_met", detail: "I am not sure" } });
  s.putPurchase({ id: "pbought", status: "executed", jobId: boughtButSaysNot.id, host: "shop.example", total: "£5.00", createdAt: iso(15), expiresAt: iso(-5), replyTo: PAUL } as never);
  const saysMetButDidNot = done("research", "Claims a purchase", { permits: ["purchase"], claimed: { state: "met" } });
  const overruled = done("research", "Overruled", { claimed: { state: "met" }, verdict: { met: false, at: iso(1) } });
  const blessed = done("research", "Blessed", { verdict: { met: true, at: iso(1) } });

  const board = appBoard({ store: s, queue: quietQueue, now });
  const of = (id: string) => board.jobs.find((j) => j.id === id)!.outcome!;
  assert.deepEqual(of(saysMet.id), { state: "unconfirmed", text: "It says it did what you asked. Nothing here confirms that.", by: "worker" }, "a worker saying met earns no tick");
  assert.deepEqual(of(saysNot.id), { state: "not_met", text: "It says it did not get there: the site was down", by: "worker" });
  assert.deepEqual(of(saysNeeds.id), { state: "waiting", text: "It says it needs you: pick a title", by: "worker" });
  assert.equal(of(silent.id).by, "nobody");
  assert.deepEqual(of(privateNot.id), { state: "not_met", text: "It says it did not get there.", by: "worker" }, "the assistant's reason is not put on a card");
  assert.deepEqual(of(boughtButSaysNot.id), { state: "met", text: "Bought: £5.00 on shop.example.", by: "service" }, "the service's own record outranks the worker");
  assert.deepEqual(of(saysMetButDidNot.id), { state: "not_met", text: "Nothing was bought: no purchase was put to you.", by: "service" }, "and a claim of met does not survive the record");
  assert.deepEqual(of(overruled.id), { state: "not_met", text: "You marked this as not done.", by: "you" });
  assert.deepEqual(of(blessed.id), { state: "met", text: "You marked this as done.", by: "you" });
  assert.ok(!JSON.stringify(board).includes("a private reason"));
});

test("GitHub is asked what became of a pull request: in the background, read-only, and only as often as it should be", async () => {
  let clock = 1_000_000;
  const asked: Array<{ url: string; method: string; auth: string | null }> = [];
  let flying = 0;
  let most = 0;
  let answer: (url: string) => Response = () => new Response("{}", { status: 404 });
  const fake = (async (url: string | URL, init?: RequestInit) => {
    asked.push({ url: String(url), method: init?.method ?? "GET", auth: new Headers(init?.headers).get("authorization") });
    flying += 1;
    most = Math.max(most, flying);
    await new Promise((r) => setTimeout(r, 2));
    flying -= 1;
    return answer(String(url));
  }) as typeof fetch;
  const body = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
  const prs = new PrStates({ token: (slug) => (slug === "o/secret" ? undefined : "tok-123"), fetch: fake, now: () => clock });
  const pr = (n: number, repo = "o/r") => `https://github.com/${repo}/pull/${n}`;

  answer = (url) => (url.endsWith("/1") ? body({ state: "closed", merged: true, created_at: "2026-11-18T09:00:00Z" }) : url.endsWith("/2") ? body({ state: "closed", merged: false }) : url.endsWith("/3") ? body({ state: "open", merged: false }) : new Response("no", { status: 500 }));
  assert.equal(prs.get(pr(1)), undefined, "the first look never waits: it answers that it does not know yet");
  for (const n of [2, 3, 4]) prs.get(pr(n));
  prs.get(pr(1));
  await prs.settled();
  assert.deepEqual([prs.get(pr(1)), prs.get(pr(2)), prs.get(pr(3)), prs.get(pr(4))], ["merged", "closed", "open", undefined]);
  assert.deepEqual(prs.info(pr(1)), { state: "merged", openedAt: "2026-11-18T09:00:00Z" }, "with when GitHub says it was opened");
  assert.deepEqual(prs.info(pr(2)), { state: "closed" });
  assert.deepEqual(asked.map((a) => a.url).sort(), [1, 2, 3, 4].map((n) => `https://api.github.com/repos/o/r/pulls/${n}`), "one request each, to GitHub's own API");
  assert.ok(asked.every((a) => a.method === "GET" && a.auth === "Bearer tok-123" && !a.url.includes("tok-123")), "read-only, the credential in a header");

  // Not asked again until it should be: merged never, open after a few minutes, closed after an hour, a failure after ten minutes.
  asked.length = 0;
  for (const n of [1, 2, 3, 4]) prs.get(pr(n));
  await prs.settled();
  assert.equal(asked.length, 0);
  clock += 4 * 60_000;
  answer = () => body({ state: "closed", merged: true });
  for (const n of [1, 2, 3, 4]) prs.get(pr(n));
  await prs.settled();
  assert.deepEqual(asked.map((a) => a.url), ["https://api.github.com/repos/o/r/pulls/3"], "only the open one, now merged");
  assert.equal(prs.get(pr(3)), "merged");
  clock += 7 * 60_000;
  answer = () => new Response("no", { status: 503 });
  asked.length = 0;
  for (const n of [1, 2, 3, 4]) prs.get(pr(n));
  await prs.settled();
  assert.deepEqual(asked.map((a) => a.url), ["https://api.github.com/repos/o/r/pulls/4"]);
  clock += 61 * 60_000;
  prs.get(pr(2));
  await prs.settled();
  assert.equal(prs.get(pr(2)), "closed", "a failed look keeps what was known");

  // Nothing but a pull request's own address is ever asked about, and nothing is asked without a credential.
  asked.length = 0;
  for (const bad of ["https://github.com/o/r/pull/5/files", "https://evil.example/o/r/pull/5", "https://github.com/o/r/issues/5", "#12", "https://github.com/o/r/pull/5?x=1", "https://github.com/o/../pull/5"]) assert.equal(prs.get(bad), undefined, bad);
  prs.get(pr(9, "o/secret"));
  await prs.settled();
  assert.equal(asked.length, 0);

  // GitHub's own "not found" is an answer, not a failure: the address names nothing the service can see.
  answer = () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
  prs.get(pr(77));
  await prs.settled();
  assert.deepEqual(prs.info(pr(77)), { state: "missing" });

  // A page full of jobs does not become a flood.
  answer = () => body({ state: "open" });
  for (let n = 100; n < 140; n++) prs.get(pr(n));
  await prs.settled();
  assert.ok(most <= PR_STATE_CONCURRENCY, `at most ${PR_STATE_CONCURRENCY} at once (saw ${most})`);
});

test("a pull request Paul merged himself counts as done, and one he closed does not", () => {
  const s = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-app-prs-")));
  const done = (kind: string, title: string, patch: Record<string, unknown> = {}) =>
    s.updateJob(s.createJob(kind as never, `Brief for ${title}`, PAUL, "self", PAUL, { title } as never).id, { status: "done", createdAt: iso(30), startedAt: iso(20), finishedAt: iso(10), ...patch } as never);
  const url = (n: number) => `https://github.com/o/r/pull/${n}`;
  // Opened while the job ran, so the job's own; `before` is a pull request that was there already.
  const during = iso(15);
  const before = iso(600);
  const merged = done("engineer", "Merged by Paul", { pr: url(1), reviewOnly: true });
  const closed = done("engineer", "Closed", { pr: url(2), reviewOnly: true });
  const open = done("engineer", "Still open", { pr: url(3), reviewOnly: true });
  const unknown = done("engineer", "Not asked yet", { pr: url(4), reviewOnly: true });
  const sentBackThenMerged = done("engineer", "Sent back then merged", { pr: url(5) });
  s.writeOutput(done("maintain", "Review: Sent back then merged", { reviewOf: sentBackThenMerged.id }).id, `REVIEW ${url(5)}: changes requested: a test is missing`);
  // Jobs that only diagnosed, reviewed or pushed to a pull request someone else opened.
  const diagnosed = done("engineer", "Diagnosed a merged one", { pr: url(6), reviewOnly: true });
  const diagnosedClosed = done("engineer", "Diagnosed a closed one", { pr: url(7), reviewOnly: true });
  const diagnosedOpen = done("engineer", "Diagnosed an open one", { pr: url(8), reviewOnly: true });
  const noDate = done("engineer", "GitHub gave no date", { pr: url(9), reviewOnly: true });
  const fixRound = done("engineer", "Fix round 1", { pr: url(6), fixRound: 1 });
  const pushedAndReviewed = done("engineer", "Pushed to it, reviewed, merged", { pr: url(6) });
  s.writeOutput(done("maintain", "Review: Pushed to it", { reviewOf: pushedAndReviewed.id }).id, `REVIEW ${url(6)}: merged`);
  const leftForPaul = done("engineer", "Pushed to it, left for Paul, since merged", { pr: url(6) });
  s.writeOutput(done("maintain", "Review: left for Paul", { reviewOf: leftForPaul.id }).id, `REVIEW ${url(6)}: needs Paul: he merges here`);
  const states: Record<string, { state: "merged" | "closed" | "open"; openedAt?: string }> = {
    [url(1)]: { state: "merged", openedAt: during }, [url(2)]: { state: "closed", openedAt: during }, [url(3)]: { state: "open", openedAt: during }, [url(5)]: { state: "merged", openedAt: during },
    [url(6)]: { state: "merged", openedAt: before }, [url(7)]: { state: "closed", openedAt: before }, [url(8)]: { state: "open", openedAt: before }, [url(9)]: { state: "merged" },
  };
  const board = appBoard({ store: s, queue: quietQueue, now, prState: (u) => states[u] });
  const of = (id: string) => board.jobs.find((j) => j.id === id)!.outcome!;
  assert.deepEqual(of(merged.id), { state: "met", text: "Its pull request was merged.", by: "service" });
  assert.deepEqual(of(closed.id), { state: "not_met", text: "Its pull request was closed without being merged.", by: "service" });
  assert.deepEqual(of(open.id), { state: "waiting", text: "Its pull request is open for you to review.", by: "service" });
  assert.equal(of(unknown.id).state, "waiting", "until GitHub has answered, it reads as it did before");
  assert.equal(of(sentBackThenMerged.id).state, "met", "what GitHub says now outranks an earlier review");

  // A merge is the tick only for the job whose pull request it was (18 Nov 2026: four jobs that diagnosed
  // and reviewed #108 all read as done once it merged, one of them reporting that it had changed nothing).
  assert.deepEqual(of(diagnosed.id), { state: "unconfirmed", text: "The pull request it worked on was merged. Nothing here confirms this job's own part.", by: "nobody" });
  assert.deepEqual(of(diagnosedClosed.id), { state: "unconfirmed", text: "The pull request it worked on was closed without being merged. Nothing here confirms this job's own part.", by: "nobody" });
  assert.equal(of(diagnosedOpen.id).state, "waiting", "an open pull request reads as it did before");
  assert.equal(of(noDate.id).state, "unconfirmed", "without GitHub's own date nothing says the job opened it");
  assert.deepEqual(of(fixRound.id), { state: "met", text: "Its pull request was merged.", by: "service" }, "a fix round was handed its pull request by the service");
  assert.deepEqual(of(pushedAndReviewed.id), { state: "met", text: "Reviewed and merged.", by: "service" }, "the service's own review still counts");
  assert.equal(of(leftForPaul.id).state, "unconfirmed", "and a settled pull request is never still waiting on Paul");
});

test("only Paul's button sets his answer, on a finished job, and it changes nothing else", async () => {
  const cookie = await session();
  const job = store.updateJob(store.createJob("research", "Look into it.", PAUL, "product", PAUL, { title: "Judged" } as never).id, { status: "done", startedAt: iso(9), finishedAt: iso(8), summary: "Found it." });
  const running = store.updateJob(store.createJob("research", "Still going.", PAUL, "product", PAUL, { title: "Not yet" } as never).id, { status: "queued", capBlocked: true });
  const mark = (id: string, met: unknown, c: string | undefined = cookie, headers: Record<string, string> = {}) => postApi(`/jobs/${id}/action`, { action: "verdict", met }, c, headers);
  assert.equal((await mark(job.id, true, "")).status, 401);
  assert.equal((await mark(job.id, true, cookie, { origin: "https://elsewhere.example" })).status, 403);
  assert.equal((await mark(job.id, "yes")).status, 400);
  assert.equal((await mark(running.id, true)).status, 409, "a job that has not finished cannot be judged");
  assert.equal(store.getJob(job.id)!.verdict, undefined);

  const before = { chat: chat.view().messages.length, elsewhere: elsewhere.length };
  assert.equal((await mark(job.id, false)).status, 200);
  assert.equal(store.getJob(job.id)!.verdict!.met, false);
  const detail = JSON.parse(await text(await get(`${APP_PATH}/api/jobs/${job.id}`, cookie))) as { job: { outcome: { state: string; by: string } }; actions: { verdict: boolean; yourVerdict?: boolean } };
  assert.deepEqual([detail.job.outcome.state, detail.job.outcome.by, detail.actions.verdict, detail.actions.yourVerdict], ["not_met", "you", true, false]);
  assert.equal((await mark(job.id, true)).status, 200);
  assert.equal(store.getJob(job.id)!.verdict!.met, true);
  assert.equal((await mark(job.id, null)).status, 200);
  assert.equal(store.getJob(job.id)!.verdict, undefined, "cleared");
  assert.deepEqual([store.getJob(job.id)!.status, store.getJob(job.id)!.summary], ["done", "Found it."], "nothing else about the job changed");
  assert.deepEqual({ chat: chat.view().messages.length, elsewhere: elsewhere.length }, before, "and it is not announced anywhere");
});

test("the history pages through every finished job", () => {
  const s = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-app-history-")));
  const total = APP_HISTORY_PAGE * 2 + 7;
  for (let i = 0; i < total; i++) s.updateJob(s.createJob("research", `Job ${i}`, PAUL, "product", PAUL).id, { status: "done", startedAt: iso(1000 + i * 10), finishedAt: iso(999 + i * 10) });
  const seen = new Set<string>();
  let before: string | undefined;
  for (let pages = 0; pages < 5; pages++) {
    const page = appHistory({ store: s, queue: quietQueue, now }, before);
    for (const j of page.jobs) seen.add(j.id);
    assert.ok(page.jobs.length <= APP_HISTORY_PAGE);
    if (!page.next) break;
    before = page.next;
  }
  assert.equal(seen.size, total);
});

test("one job comes with its trace as stored, and an output only where the reports view would serve it", async () => {
  const cookie = await session();
  const job = store.updateJob(store.createJob("research", "Map who licenses the models for search answers.", PAUL, "product", PAUL, { title: "Licensing map" }).id, { status: "done", startedAt: iso(30), finishedAt: iso(20) });
  store.writeOutput(job.id, "# Licensing map\n\nThree licensors matter. <script>alert(1)</script>\n");
  fs.mkdirSync(tracesDir(), { recursive: true });
  fs.writeFileSync(
    path.join(tracesDir(), `${job.id}.jsonl`),
    [
      { t: iso(30), ev: "start", text: "research on product" },
      { t: iso(29), ev: "tool", name: "WebFetch", text: "https://example.org/terms" },
      { t: iso(29), ev: "result", name: "WebFetch", error: true, text: "404" },
      { t: iso(21), ev: "end", text: "done", turns: 4 },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n") + "\n",
  );
  const assistant = store.updateJob(store.createJob("ea", "Check the inbox.", PAUL, "product", PAUL, { title: "Morning brief" }).id, { status: "done", startedAt: iso(15), finishedAt: iso(14) });
  store.writeOutput(assistant.id, "Private: a message from someone about something.");

  const res = await get(`${APP_PATH}/api/jobs/${job.id}`, cookie);
  assert.equal(res.status, 200);
  const detail = JSON.parse(await text(res));
  assert.equal(detail.job.title, "Licensing map");
  assert.equal(detail.limits.maxTurns, 60);
  assert.deepEqual(detail.trace.lines.map((l: { ev: string }) => l.ev), ["start", "tool", "result", "end"]);
  assert.deepEqual(detail.trace.figures, { steps: 1, errors: 1, minutes: 9, repeats: [] });
  assert.match(detail.outputHtml, /Three licensors matter/);
  assert.doesNotMatch(detail.outputHtml, /<script>/, "the report is escaped by the service before the app ever sees it");

  const private_ = JSON.parse(await text(await get(`${APP_PATH}/api/jobs/${assistant.id}`, cookie)));
  assert.equal(private_.outputHtml, undefined, "an assistant's output is not served here either");
  assert.ok(!JSON.stringify(private_).includes("a message from someone"));

  assert.equal((await get(`${APP_PATH}/api/jobs/nope`, cookie)).status, 404);
  assert.equal((await get(`${APP_PATH}/api/jobs/..%2f..%2fstate`, cookie)).status, 404);
  assert.equal(appJob({ store, queue: quietQueue, now }, "../state"), undefined);

  const board = JSON.parse(await text(await get(`${APP_PATH}/api/board`, cookie)));
  assert.ok(board.jobs.some((j: { id: string }) => j.id === job.id));
  assert.equal(typeof board.health.headline, "string");
});

test("six things under /app are not a GET, and the data module never writes", () => {
  const index = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const appRoutes = index.slice(index.indexOf("const appAuthz ="), index.indexOf("return { app, orchestrator"));
  assert.deepEqual([...appRoutes.matchAll(/app\.(post|put|patch|delete)\(([^,]+),/g)].map((m) => `${m[1]} ${m[2]}`), ["post APP_SIGN_OUT_PATH", "post `${APP_PATH}/api/chat`", "post `${APP_PATH}/api/approvals`", "post `${APP_PATH}/api/jobs/:id/action`", "post `${APP_PATH}/api/pulls/:repo/:number/merge`", "post `${APP_PATH}/api/settings`"]);
  assert.match(appRoutes, /if \(!under\(req\.path, APP_PATH\) \|\| APP_OPEN\.some/, "one gate over everything under /app");
  const data = fs.readFileSync(new URL("../src/app-data.ts", import.meta.url), "utf8");
  assert.doesNotMatch(data, /\.(updateJob|createJob|importJob|setSetting|setCapDays|setQueueHold|writeOutput|put[A-Z]\w*|update[A-Z]\w*|create[A-Z]\w*|disableSchedule|addNote)\(/);
  assert.doesNotMatch(data, /job\.costUsd/, "the SDK's estimate is never read for display");
});

/* ---------- Chat ---------- */

const postChat = (body: unknown, cookie?: string, headers: Record<string, string> = {}) =>
  fetch(`${base}${APP_PATH}/api/chat`, { method: "POST", redirect: "manual", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const chatView = async (cookie: string) => JSON.parse(await text(await get(`${APP_PATH}/api/chat`, cookie))) as { messages: Array<{ from: string; text?: string; html?: string; live?: boolean }>; typing: boolean; jobs: Array<{ id: string }> };
/** Waits for the orchestrator's queue for the app's conversation to drain. */
const settled = async () => {
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 10));
    if (chat.view().messages.at(-1)?.from === "clearops") return;
  }
};

test("a message is taken only from this site's own signed-in script", async () => {
  const cookie = await session();
  const before = chat.view().messages.length;
  assert.equal((await postChat({ text: "hello" })).status, 401, "no session");
  assert.equal((await postChat({ text: "hello" }, cookie, { origin: "https://elsewhere.example" })).status, 403, "another site's page");
  assert.equal((await postChat({ text: "hello" }, cookie, { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await fetch(`${base}${APP_PATH}/api/chat`, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: "text=hello" })).status, 403, "a form cannot post it");
  assert.equal((await postChat({ text: "   " }, cookie)).status, 400);
  assert.equal((await postChat({ nope: true }, cookie)).status, 400);
  assert.equal((await postChat({ text: "x".repeat(WEB_TEXT_MAX + 1) }, cookie)).status, 413);
  assert.equal(chat.view().messages.length, before, "nothing refused was kept");
  assert.equal(chiefAsked.length, 0);
});

test("Paul's message reaches the chief, and the reply comes back escaped", async () => {
  const cookie = await session();
  chiefSays = "Two jobs are running. <img src=x onerror=alert(1)> Nothing needs you.";
  try {
    const res = await postChat({ text: "What is running? <b>now</b>" }, cookie, { origin: "https://workforce.example", "sec-fetch-site": "same-origin" });
    assert.equal(res.status, 202);
    await settled();
    assert.equal(chiefAsked.length, 1);
    assert.match(chiefAsked[0]!, /What is running\?/);
    const view = await chatView(cookie);
    const [mine, reply] = view.messages.slice(-2);
    assert.deepEqual([mine!.from, mine!.text, mine!.html], ["paul", "What is running? <b>now</b>", undefined], "his own words travel as text, never as markup");
    assert.equal(reply!.from, "clearops");
    assert.match(reply!.html!, /Two jobs are running/);
    assert.doesNotMatch(reply!.html!, /<img/, "what the service says is escaped before the app sees it");
    assert.equal(elsewhere.length, 0, "nothing for the app's conversation went to another channel");
    assert.equal(store.getSession(WEB_CONVERSATION), "chief-session", "the app has its own conversation with the chief");
  } finally {
    chiefSays = undefined;
  }
});

test("no approval word works from the app, and a one-time code is never written down", async () => {
  const cookie = await session();
  const words = ["buy abc123", "buy cancel abc123", "send abc123", "send it", "cancel abc123", "dns apply abc123", "signup apply abc123", "act as me on github.com", "yes abc123", "approve abc123", "/password", "/pair ABCD-1234", "/unpair", "docs consent"];
  for (const word of words) {
    assert.equal(webRefusal(word), WEB_APPROVAL_REFUSAL, word);
    assert.equal((await postChat({ text: word }, cookie)).status, 202, word);
    assert.match(chat.view().messages.at(-1)!.text, /Typed approvals do not work in the app/, word);
  }
  assert.equal(store.settings().actAsMe, undefined, "nothing was unlocked");
  assert.equal(webRefusal("What is the code review status?"), undefined, "ordinary words still reach the chief");
  assert.equal(webRefusal("/resume"), undefined);

  for (const code of ["code 482913", "482913", "the code is 77 1234".replace(" 1234", "1234")]) {
    assert.equal(webRefusal(code), WEB_CODE_REFUSAL, code);
    assert.equal((await postChat({ text: code }, cookie)).status, 202);
    const [mine, reply] = chat.view().messages.slice(-2);
    assert.equal(mine!.text, WEB_CODE_PLACEHOLDER);
    assert.equal(reply!.text, WEB_CODE_REFUSAL);
  }
  const saved = fs.readFileSync(path.join(process.env.DATA_DIR!, "app", "chat.json"), "utf8");
  assert.ok(!saved.includes("482913") && !saved.includes("771234"), "no code is in the transcript");
  assert.ok(!JSON.stringify(await chatView(cookie)).includes("482913"));
  assert.equal(chiefAsked.length, 1, "none of it reached a model");
});

test("the app's sender is nobody anywhere else, and is refused approval words by the orchestrator too", async () => {
  assert.equal(isAllowed(WEB_SENDER), false, "it is on no allowlist, so every approval gate refuses it for itself");
  const before = chat.view().messages.length;
  // Without the route's own flag, or in any other conversation, it is an unlisted sender. (Until
  // 19 Nov 2026 a file made it one too; the app's route now carries files, checked in its own test.)
  await orchestrator.handle(WEB_SENDER, "hello", { replyTo: WEB_CONVERSATION });
  await orchestrator.handle(WEB_SENDER, "hello", { replyTo: "web:other", web: true });
  await orchestrator.handle(WEB_SENDER, "hello", { web: true });
  await orchestrator.handle("web:someone", "hello", { replyTo: WEB_CONVERSATION, web: true });
  await orchestrator.handle(WEB_SENDER, "hello", { replyTo: "web:other", web: true, attachments: [{ name: "a.txt" } as never] });
  await orchestrator.handle(WEB_SENDER, "hello", { replyTo: WEB_CONVERSATION, attachments: [{ name: "a.txt" } as never] });
  assert.equal(chat.view().messages.length, before, "ignored: no reply, no model");
  assert.equal(elsewhere.length, 0);
  // With the flag, an approval word is still refused before any command is parsed.
  await orchestrator.handle(WEB_SENDER, "act as me on github.com", { replyTo: WEB_CONVERSATION, web: true });
  assert.equal(chat.view().messages.at(-1)!.text, WEB_APPROVAL_REFUSAL);
  assert.equal(store.settings().actAsMe, undefined);
  assert.equal(chiefAsked.length, 1);
});

test("the transcript is owner-only, capped, and never keeps the status line", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-app-chat-"));
  const c = new WebChat({ dir });
  c.inbound("first");
  const handle = await c.sendEditable(WEB_CONVERSATION, "Searching the web");
  assert.equal(await c.typing(WEB_CONVERSATION), true);
  assert.deepEqual(c.view().messages.map((m) => [m.from, m.text, m.live ?? false]), [["paul", "first", false], ["clearops", "Searching the web", true]]);
  await c.edit(WEB_CONVERSATION, handle!, "Reading a page");
  assert.equal(c.view().messages[1]!.text, "Reading a page");
  await c.send(WEB_CONVERSATION, "A reply with a token ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  await c.remove(WEB_CONVERSATION, handle!);
  assert.equal(c.view().typing, false, "a reply ends the typing signal");
  const file = path.join(dir, "app", "chat.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const saved = fs.readFileSync(file, "utf8");
  assert.ok(!saved.includes("Searching the web") && !saved.includes("Reading a page"), "the status line is of the moment");
  assert.ok(!saved.includes("ghp_abcdefghijklmnopqrstuvwxyz0123456789"), "a token is redacted before it is kept");
  for (let i = 0; i < WEB_KEEP + 20; i++) await c.send(WEB_CONVERSATION, `m${i}`);
  const again = new WebChat({ dir });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).messages.length, WEB_KEEP);
  assert.equal(again.view().messages.at(-1)!.text, `m${WEB_KEEP + 19}`, "it survives a restart");
});

test("only web addresses are delivered to the app; every other channel is untouched", async () => {
  const sent: string[] = [];
  const plain = { send: async (to: string, t: string) => void sent.push(`${to}|${t}`) };
  const c = new WebChat();
  const routed = routeWeb(plain, c);
  await routed.send("tg:1", "to telegram");
  await routed.send(WEB_CONVERSATION, "to the app");
  assert.deepEqual(sent, ["tg:1|to telegram"]);
  assert.deepEqual(c.view().messages.map((m) => m.text), ["to the app"]);
  assert.equal((routed as { sendEditable?: unknown }).sendEditable, undefined, "a method the channel lacks stays absent");
});

test("the chat carries the jobs started from it, so each can be shown as a card", () => {
  const s = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-app-chatjobs-")));
  const mine = s.createJob("research", "Look into it.", WEB_SENDER, "product", WEB_CONVERSATION, { title: "From the app" } as never);
  s.createJob("research", "Look into it.", PAUL, "product", PAUL, { title: "From Telegram" } as never);
  const c = new WebChat();
  c.inbound("Look into it");
  const view = appChat({ store: s, queue: quietQueue, now }, c);
  assert.deepEqual(view.jobs.map((j) => j.id), [mine.id]);
  assert.deepEqual(view.messages.map((m) => [m.from, m.text]), [["paul", "Look into it"]]);
});

/* ---------- Approving and acting from the app ---------- */

const postApi = (p: string, body: unknown, cookie?: string, headers: Record<string, string> = {}) =>
  fetch(`${base}${APP_PATH}/api${p}`, { method: "POST", redirect: "manual", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers }, body: JSON.stringify(body) });

test("a grant is a single use of something only the app's route can mint", () => {
  const grant = mintAppApproval(1_000);
  assert.match(grant, /^app-grant:[a-f0-9]{48}$/);
  assert.equal(spendAppApproval("app-grant:" + "0".repeat(48), 1_000), false, "a made-up grant is nothing");
  assert.equal(spendAppApproval(APP_APPROVER, 1_000), false, "the name it is recorded under is not a grant");
  assert.equal(spendAppApproval(WEB_SENDER, 1_000), false);
  assert.equal(spendAppApproval(grant, 1_000), true);
  assert.equal(spendAppApproval(grant, 1_000), false, "spent once, gone");
  assert.equal(spendAppApproval(mintAppApproval(1_000), 1_000 + APP_GRANT_MS + 1), false, "and it does not keep");
  assert.equal(isAllowed(grant), false);
});

test("a gate takes a decision from a chat account or a spent grant, and from nothing else", async () => {
  const s = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-app-gates-")));
  const soon = new Date(Date.now() + 3_600_000).toISOString();
  const at = new Date().toISOString();
  const outbound = new OutboundGate(s, {} as never);
  const dns = new DnsGate(s, {} as never);
  const signup = new SignupGate(s, {} as never, {} as never, { mayAct: () => false });
  s.putOutbound({ id: "aaaaaa", kind: "send_email", status: "pending", createdAt: at, expiresAt: soon, replyTo: PAUL } as never);
  s.putDns({ id: "bbbbbb", status: "pending", createdAt: at, expiresAt: soon, replyTo: PAUL, domain: "example.org", changes: [] } as never);
  s.putSignup({ id: "cccccc", status: "pending", createdAt: at, expiresAt: soon, replyTo: PAUL, domain: "example.org" } as never);

  for (const forged of ["app-grant:" + "1".repeat(48), APP_APPROVER, WEB_SENDER, "web:main", ""]) {
    assert.equal(outbound.cancel("aaaaaa", forged), "", forged);
    assert.equal(dns.cancel("bbbbbb", forged), "", forged);
    assert.equal(signup.cancel("cccccc", forged), "", forged);
    await assert.rejects(outbound.approve("aaaaaa", forged), /only Paul's own chat account can approve/);
    await assert.rejects(dns.approve("bbbbbb", forged), /only Paul's own chat account can approve/);
    await assert.rejects(signup.approve("cccccc", forged), /only Paul's own chat account can approve/);
  }
  assert.equal(s.getOutbound("aaaaaa")!.status, "pending", "nothing a forged name did changed anything");

  // A real grant is accepted once, and the record says where the decision came from.
  const grant = mintAppApproval();
  assert.match(outbound.cancel("aaaaaa", grant), /^Cancelled aaaaaa/);
  assert.equal(s.getOutbound("aaaaaa")!.note, `cancelled by ${APP_APPROVER}`);
  assert.equal(dns.cancel("bbbbbb", grant), "", "the same grant decides nothing a second time");
  assert.match(dns.cancel("bbbbbb", mintAppApproval()), /^Cancelled DNS change bbbbbb/);
  assert.match(signup.cancel("cccccc", mintAppApproval()), /^Cancelled sign-up cccccc/);
  // Approving goes through the same door: a grant gets past the check to the gate's own answer.
  assert.equal(await outbound.approve("nope00", mintAppApproval()), "No pending send or invitation nope00.");
  assert.equal(await dns.approve("nope00", mintAppApproval()), "No DNS change nope00.");
  assert.equal(await signup.approve("nope00", mintAppApproval()), "No sign-up nope00.");
  // And a chat account still decides exactly as before.
  s.putDns({ id: "dddddd", status: "pending", createdAt: at, expiresAt: soon, replyTo: PAUL, domain: "example.org", changes: [] } as never);
  assert.match(dns.cancel("dddddd", PAUL), /^Cancelled DNS change dddddd/);
  assert.equal(s.getDns("dddddd")!.note, `cancelled by ${PAUL}`);
});

test("a tap decides only the item that is waiting, as it was shown, from this site's own script", async () => {
  const cookie = await session();
  const soon = new Date(Date.now() + 60 * 60_000).toISOString();
  store.putDns({ id: "abc123", status: "pending", createdAt: new Date().toISOString(), expiresAt: soon, replyTo: PAUL, domain: "example.org", reason: "The site check asked for it.", before: [], changes: [{ action: "add", type: "TXT", name: "_check", data: "hello" }] } as never);
  // A purchase whose job no longer holds the basket is not waiting, so the app does not offer it.
  store.putPurchase({ id: "def456", status: "pending", createdAt: new Date().toISOString(), expiresAt: soon, replyTo: PAUL, host: "shop.example", total: "£23.98" } as never);
  type Waiting = { waiting: Array<{ what: string; id: string; preview?: string; seen?: string }> };
  const board = JSON.parse(await text(await get(`${APP_PATH}/api/board`, cookie))) as Waiting;
  assert.equal(board.waiting.find((w) => w.id === "def456"), undefined);
  const item = board.waiting.find((w) => w.id === "abc123")!;
  assert.match(item.preview!, /Domain: example\.org\.[\s\S]*Add TXT _check/, "the app shows the item as its gate words it");
  assert.equal(item.seen, seenHash("dns", "abc123", item.preview!));
  const decision = { what: "dns", id: "abc123", verb: "decline", seen: item.seen };

  assert.equal((await postApi("/approvals", decision)).status, 401, "no session");
  assert.equal((await postApi("/approvals", decision, cookie, { origin: "https://elsewhere.example" })).status, 403);
  assert.equal((await fetch(`${base}${APP_PATH}/api/approvals`, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: "what=dns&id=abc123&verb=approve" })).status, 403, "a form cannot decide");
  assert.equal((await postApi("/approvals", { ...decision, id: "zzz999" }, cookie)).status, 404);
  assert.equal((await postApi("/approvals", { ...decision, what: "purchase" }, cookie)).status, 404, "an id is only good for its own kind");
  assert.equal((await postApi("/approvals", { ...decision, what: "purchase", id: "def456" }, cookie)).status, 404, "what is not waiting cannot be decided");
  assert.equal((await postApi("/approvals", { ...decision, verb: "maybe" }, cookie)).status, 404);
  assert.equal((await postApi("/approvals", { ...decision, seen: "0".repeat(64) }, cookie)).status, 409, "not what was shown");
  assert.equal((await postApi("/approvals", { ...decision, seen: undefined }, cookie)).status, 409);
  assert.equal(store.getDns("abc123")!.status, "pending", "none of that decided anything");

  // What is shown changes: the old fingerprint decides nothing.
  store.updateDns("abc123", { reason: "A different reason." } as never);
  assert.equal((await postApi("/approvals", decision, cookie)).status, 409);
  assert.equal(store.getDns("abc123")!.status, "pending");
  const fresh = (JSON.parse(await text(await get(`${APP_PATH}/api/board`, cookie))) as Waiting).waiting.find((w) => w.id === "abc123")!;
  assert.notEqual(fresh.seen, item.seen);

  // The current fingerprint reaches the DNS gate itself, which answers exactly as it does in chat.
  const before = elsewhere.length;
  const res = await postApi("/approvals", { ...decision, seen: fresh.seen }, cookie, { origin: "https://workforce.example", "sec-fetch-site": "same-origin" });
  assert.equal(res.status, 200);
  const said = ((await res.json()) as { text: string }).text;
  assert.equal(said, "Cancelled DNS change abc123. Nothing was changed.");
  assert.equal(store.getDns("abc123")!.status, "cancelled");
  assert.equal(store.getDns("abc123")!.note, `cancelled by ${APP_APPROVER}`, "the record says where the decision came from");
  assert.equal(chat.view().messages.at(-1)!.text, said, "what happened is said in the app");
  assert.deepEqual(elsewhere.slice(before), [{ to: PAUL, text: said }], "and where the item was first put to him");
  assert.equal((await postApi("/approvals", { ...decision, seen: fresh.seen }, cookie)).status, 404, "decided once: it is no longer waiting");
  assert.equal(chiefAsked.length, 1, "no model was asked anything");
});

test("a job can be stopped or run again from the app, and nothing it was permitted is carried over", async () => {
  const cookie = await session();
  const original = store.updateJob(store.createJob("research", "Find where it is in stock.", PAUL, "product", PAUL, { title: "Stock check", permits: ["purchase"] } as never).id, { status: "failed", finishedAt: iso(5), failure: "stalled" });
  const review = store.updateJob(store.createJob("maintain", "Review it.", PAUL, "self", PAUL, { title: "Review: thing", reviewOf: original.id } as never).id, { status: "done", finishedAt: iso(5) });
  const assistant = store.updateJob(store.createJob("ea", "Check mail.", PAUL, "product", PAUL, { title: "Brief" } as never).id, { status: "done", finishedAt: iso(5) });
  const queued = store.createJob("research", "Wait here.", PAUL, "product", PAUL, { title: "Waiting job" } as never);

  const detail = JSON.parse(await text(await get(`${APP_PATH}/api/jobs/${original.id}`, cookie))) as { actions: { cancel: boolean; retry: boolean; rerunModels: string[] } };
  assert.deepEqual(detail.actions, { verdict: true, cancel: false, front: false, retry: true, rerunModels: ["z-ai/glm-5.3", "moonshotai/kimi-k3.1-pro", "anthropic/claude-opus-5.5"], review: false });

  assert.equal((await postApi(`/jobs/${original.id}/action`, { action: "rerun", model: "z-ai/glm-5.3" })).status, 401);
  assert.equal((await postApi(`/jobs/${original.id}/action`, { action: "rerun", model: "z-ai/glm-5.3" }, cookie, { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await postApi(`/jobs/nope/action`, { action: "cancel" }, cookie)).status, 404);
  assert.equal((await postApi(`/jobs/${original.id}/action`, { action: "delete" }, cookie)).status, 400);
  assert.equal((await postApi(`/jobs/${original.id}/action`, { action: "rerun", model: "opus" }, cookie)).status, 409, "only a model a job may be pinned to");
  assert.equal((await postApi(`/jobs/${review.id}/action`, { action: "rerun", model: "z-ai/glm-5.3" }, cookie)).status, 409, "a review belongs to its loop");
  assert.equal((await postApi(`/jobs/${assistant.id}/action`, { action: "rerun", model: "z-ai/glm-5.3" }, cookie)).status, 409, "the assistant stays on Claude");
  assert.equal((await postApi(`/jobs/${original.id}/action`, { action: "cancel" }, cookie)).status, 409, "a finished job cannot be stopped");
  assert.equal((await postApi(`/jobs/${queued.id}/action`, { action: "front" }, cookie)).status, 409, "it is not waiting behind anything");

  const stopped = await postApi(`/jobs/${queued.id}/action`, { action: "cancel" }, cookie);
  assert.equal(stopped.status, 200);
  assert.equal(store.getJob(queued.id)!.status, "failed");
  assert.equal(store.getJob(queued.id)!.failure, "cancelled");

  chiefSays = "Three pharmacies have it.";
  try {
    const res = await postApi(`/jobs/${original.id}/action`, { action: "rerun", model: "z-ai/glm-5.3" }, cookie);
    assert.equal(res.status, 200);
    const { jobId } = (await res.json()) as { jobId: string };
    const again = store.getJob(jobId)!;
    assert.deepEqual([again.kind, again.brief, again.title, again.model, again.requestedBy, again.replyTo], ["research", "Find where it is in stock.", "Stock check", "z-ai/glm-5.3", WEB_SENDER, WEB_CONVERSATION]);
    assert.equal(again.permits, undefined, "the permit the first job had is not carried over");
    for (let i = 0; i < 200 && store.getJob(jobId)!.status !== "done" && store.getJob(jobId)!.status !== "failed"; i++) await new Promise((r) => setTimeout(r, 10));
  } finally {
    chiefSays = undefined;
  }
});

test("the chief's own replies are priced after they are sent, by model, for the day", async () => {
  const { RealCostMeter } = await import("../src/realcost.js");
  const { chatPricingSettled } = await import("../src/orchestrator.js");
  const cookie = await session();
  const asked: string[] = [];
  const provider = (async (input: string | URL) => {
    const id = decodeURIComponent(new URL(String(input)).searchParams.get("id") ?? "");
    asked.push(id);
    return new Response(JSON.stringify({ data: { id, total_cost: id === "c1" ? 0.04 : 0.01, model: id === "c1" ? "z-ai/glm-5.3" : "deepseek/deepseek-v4.1-flash" } }), { status: 200 });
  }) as typeof fetch;
  const was = orchestrator.chiefMeter;
  orchestrator.chiefMeter = () => new RealCostMeter({ apiKey: "test-key", fetch: provider, gapMs: 0, settleMs: 500, settlePassMs: 5, timeoutMs: 500, warn: () => undefined });
  chiefSays = "Nothing is running.";
  chiefCalls = ["c1", "c2"];
  try {
    assert.equal((await postChat({ text: "What is running?" }, cookie)).status, 202);
    await settled();
    await chatPricingSettled();
    assert.deepEqual([...asked].sort(), ["c1", "c2"]);
    const held = store.chatCost()!;
    assert.deepEqual(held.models.map((m) => [m.model, m.usd, m.calls]), [["z-ai/glm-5.3", 0.04, 1], ["deepseek/deepseek-v4.1-flash", 0.01, 1]]);
    // It is on the Spend page as the chief's own line, which is how a dear model on the chief shows up.
    const page = JSON.parse(await text(await get(`${APP_PATH}/api/spend`, cookie))) as { byAgentModel: Array<{ who: string; model: string; usd: number }> };
    const today = held.ymd === new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date(now));
    if (today) assert.deepEqual(page.byAgentModel.filter((r) => r.who === "The chief").map((r) => [r.model, r.usd]), [["z-ai/glm-5.3", 0.04], ["deepseek/deepseek-v4.1-flash", 0.01]]);
  } finally {
    chiefSays = undefined;
    chiefCalls = [];
    orchestrator.chiefMeter = was;
  }
});

/* ---------- Files with a message ---------- */

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");

test("the files on a message are all read and checked, or the message is refused whole", async () => {
  assert.deepEqual(webFiles(undefined), []);
  assert.deepEqual(webFiles([]), []);
  const got = webFiles([{ name: " notes.txt ", type: "text/plain", data: b64("hello") }, { name: "blob.bin", data: b64(Buffer.from([0, 1, 2])) }]);
  assert.deepEqual(got.map((f) => [f.name, f.mimeType, f.size]), [["notes.txt", "text/plain", 5], ["blob.bin", undefined, 3]]);
  assert.equal((await got[0]!.download(10)).toString(), "hello");
  const ok = { name: "a.txt", data: b64("a") };
  for (const [bad, why] of [
    ["files", /could not be read/], [{ 0: ok }, /could not be read/], [[null], /could not be read/], [[{ data: b64("a") }], /could not be read/], [[{ name: "", data: b64("a") }], /could not be read/],
    [[{ name: "x".repeat(201), data: b64("a") }], /could not be read/], [[{ name: "a.txt", data: 5 }], /could not be read/], [[{ name: "a.txt", type: 7, data: b64("a") }], /could not be read/],
    [[{ name: "a.txt", data: "not base64!" }], /could not be read/], [[{ name: "a.txt", data: "YQ" }], /could not be read/], [[{ name: "a.txt", data: "data:text/plain;base64,YQ==" }], /could not be read/],
    [[{ name: "a.txt", data: "" }], /a\.txt is empty/], [Array(WEB_FILES_MAX + 1).fill(ok), /At most 5 files/],
    [[ok, { name: "big.bin", data: b64(Buffer.alloc(WEB_FILES_BYTES)) }], /too large/],
  ] as Array<[unknown, RegExp]>) assert.throws(() => webFiles(bad), (e: unknown) => e instanceof WebFilesError && why.test(e.message), JSON.stringify(bad).slice(0, 60));
});

test("a file sent from the app is saved like any channel's upload, and only from Paul's own signed-in browser", async () => {
  const cookie = await session();
  const dir = path.join(process.env.DATA_DIR!, "uploads");
  const saved = () => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);
  const files = [{ name: "../../etc/Stock list.csv", type: "text/csv", data: b64("name,price\nEpimax,6.49\n") }];
  const before = saved().length;

  // Not signed in: a large body is never even read, and nothing is saved from a small one either.
  const big = await postChat({ text: "x", files: [{ name: "big.bin", data: b64(Buffer.alloc(400_000)) }] });
  assert.ok([401, 413].includes(big.status), `unsigned large body: ${big.status}`);
  assert.equal((await postChat({ text: "here", files })).status, 401);
  assert.equal((await postChat({ text: "here", files }, cookie, { origin: "https://evil.example" })).status, 403);
  // Signed in, but the files are not what the app sends, or the caption is an approval word.
  assert.equal((await postChat({ text: "here", files: [{ name: "a.txt", data: "not base64!" }] }, cookie)).status, 400);
  assert.equal((await postChat({ text: "", files: [] }, cookie)).status, 400);
  assert.equal((await postChat({ text: "send 9b80e7", files }, cookie)).status, 202);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(saved().length, before, "none of those saved anything");
  assert.equal(chat.view().messages.at(-1)!.text, WEB_APPROVAL_REFUSAL);

  chiefSays = "It lists Epimax at 6.49.";
  chiefAsked.length = 0;
  try {
    // A body far over the app-wide 100 KB limit is read for a signed-in browser.
    const pad = { name: "padding.txt", type: "text/plain", data: b64("p".repeat(300_000)) };
    assert.equal((await postChat({ text: "What does this say?", files: [...files, pad] }, cookie, { origin: "https://workforce.example", "sec-fetch-site": "same-origin" })).status, 202);
    for (let i = 0; i < 200 && chiefAsked.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    await settled();
    // Saved in the private uploads directory under a sanitised name, owner-only: the name cannot climb out of it.
    const now = saved();
    assert.equal(now.length, before + 2);
    const csv = now.find((n) => n.endsWith(".csv"))!;
    assert.match(csv, /^\d{4}-\d{2}-\d{2}-[\w .-]*Stock[\w .-]*\.csv$/);
    assert.ok(!csv.includes("/") && !csv.includes(".."));
    assert.equal(fs.readFileSync(path.join(dir, csv), "utf8"), "name,price\nEpimax,6.49\n");
    assert.equal(fs.statSync(path.join(dir, csv)).mode & 0o777, 0o600);
    // The chief is told what arrived the way it is for any channel, with Paul's words as the caption.
    assert.equal(chiefAsked.length, 1);
    assert.match(chiefAsked[0]!, /Paul sent 2 file\(s\) with this message\. They are saved privately under /);
    assert.match(chiefAsked[0]!, /Paul's message: What does this say\?$/);
    // The transcript keeps his words and the files' names, never their contents.
    const view = await chatView(cookie);
    const mine = (view.messages as Array<{ from: string; text?: string; files?: string[] }>).filter((m) => m.from === "paul").at(-1)!;
    assert.deepEqual([mine.text, mine.files], ["What does this say?", ["../../etc/Stock list.csv", "padding.txt"]]);
    assert.ok(!JSON.stringify(view).includes("Epimax,6.49"));
    assert.match(view.messages.at(-1)!.html!, /It lists Epimax at 6\.49/);

    // Files with no words, and files in a job's thread.
    const job = store.updateJob(store.createJob("research", "Check stock.", PAUL, "product", PAUL, { title: "Stock" } as never).id, { status: "done", finishedAt: iso(5) });
    chiefAsked.length = 0;
    assert.equal((await postChat({ text: "", files: [{ name: "shot.txt", data: b64("a screenshot, say") }], thread: `job:${job.id}` }, cookie)).status, 202);
    for (let i = 0; i < 200 && chat.view(`web:job:${job.id}`).messages.at(-1)?.from !== "clearops"; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(saved().length, before + 3);
    assert.match(chiefAsked.at(-1)!, /^This message is in the thread of job /);
    assert.deepEqual(chat.view(`web:job:${job.id}`).messages[0]!.files, ["shot.txt"]);
  } finally {
    chiefSays = undefined;
    for (const n of saved().slice(before)) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
  }
});

/* ---------- Spend: where it went, and the settings Paul may change ---------- */

test("the Spend page adds up only the provider's own figures, on the day a job finished", () => {
  const s = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-app-spend-")));
  const done = (kind: string, title: string, target: string, minsAgo: number, usage?: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    s.updateJob(s.createJob(kind as never, `Brief for ${title}`, PAUL, target as never, PAUL, { title } as never).id, { status: "done", startedAt: iso(minsAgo + 10), finishedAt: iso(minsAgo), ...(usage ? { usage } : {}), ...extra } as never);
  const totals = (calls: number) => ({ calls, promptTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, completionTokens: 0, reasoningTokens: 0, toolCalls: 0 });
  // Priced call by call, so the record says which model each charge was for.
  const a = done("engineer", "Dear one", "self", 30, { role: "engineer", costUsd: 3.5, costSource: "provider", totals: totals(40), costByModel: [{ model: "z-ai/glm-5.3", usd: 3.2, calls: 30 }, { model: "deepseek/deepseek-v4.1-flash", usd: 0.3, calls: 10 }] });
  done("engineer", "Cheap one", "product", 60, { role: "engineer", costUsd: 0.5, costSource: "provider", totals: totals(8), costByModel: [{ model: "z-ai/glm-5.3", usd: 0.5, calls: 8 }] });
  // A total only: under its one model when it ran on one, otherwise "not recorded".
  done("maintain", "Review: Dear one", "self", 20, { role: "maintainer", costUsd: 1, costSource: "provider", totals: totals(12), models: [{ model: "moonshotai/kimi-k3.1-pro" }] });
  s.setChatCost({ ymd: "2026-11-18", models: [{ model: "deepseek/deepseek-v4.1-flash", usd: 0.25, calls: 50 }] });
  // No figure of its own, the SDK's estimate, and yesterday's job: none of them is counted.
  done("research", "No figure", "product", 40);
  done("research", "Estimate only", "product", 45, { costUsd: 9, costSource: "estimate" }, { costUsd: 12 });
  done("engineer", "Yesterday", "self", 60 * 30, { costUsd: 7, costSource: "provider" });
  const queue = { ...quietQueue, spendState: () => ({ usd: 6.25, source: "provider" as const, asOf: now }) };
  const page = appSpend({ store: s, queue, now });
  assert.deepEqual(page.jobs.map((j) => [j.title, j.costUsd]), [["Dear one", 3.5], ["Review: Dear one", 1], ["Cheap one", 0.5]]);
  assert.equal(page.jobs[0]!.id, a.id);
  // "Which agent used which model for what": the chief's own replies are a line of their own.
  assert.deepEqual(page.byAgentModel.map((r) => [r.who, r.model, Number(r.usd.toFixed(2)), r.calls]), [
    ["Engineers", "z-ai/glm-5.3", 3.7, 38],
    ["The maintainer", "moonshotai/kimi-k3.1-pro", 1, 12],
    ["Engineers", "deepseek/deepseek-v4.1-flash", 0.3, 10],
    ["The chief", "deepseek/deepseek-v4.1-flash", 0.25, 50],
  ]);
  assert.deepEqual(page.byProject, [{ name: "workforce", usd: 4.5, jobs: 2 }, { name: "Clear Exchange", usd: 0.5, jobs: 1 }]);
  assert.deepEqual([page.attributedUsd, page.unattributedUsd, page.withoutFigure], [5.25, 1, 2]);
  // Yesterday's record of the chief's replies is not today's.
  s.setChatCost({ ymd: "2026-11-17", models: [{ model: "deepseek/deepseek-v4.1-flash", usd: 9, calls: 1 }] });
  assert.equal(appSpend({ store: s, queue, now }).byAgentModel.some((r) => r.who === "The chief"), false);
  s.setChatCost({ ymd: "2026-11-18", models: [{ model: "deepseek/deepseek-v4.1-flash", usd: 0.25, calls: 50 }] });
  assert.ok(!page.jobs.some((j) => ["Estimate only", "No figure", "Yesterday"].includes(j.title)), "a job with only the SDK's estimate, with nothing, or from another day is not on the page");
  // With no provider reading for the day the estimate is not shown and nothing is subtracted from it;
  // and when the jobs' own figures come to more than the day's reading, no remainder is claimed.
  const blind = appSpend({ store: s, queue: { ...quietQueue, spendState: () => ({ usd: 40, source: "estimate" as const, note: "OpenRouter could not be read" }) }, now });
  assert.deepEqual([blind.spend.usd, blind.unattributedUsd, blind.attributedUsd], [undefined, undefined, 5.25]);
  assert.equal(appSpend({ store: s, queue: { ...quietQueue, spendState: () => ({ usd: 2, source: "provider" as const, asOf: now }) }, now }).unattributedUsd, undefined);
});

test("a cap or a role's model changed from the app is laid over the deploy's own, within fixed bounds, and can be put back", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-app-live-"));
  const s = new Store(dir);
  const before = { daily: config.dailyBudgetUsd, engineer: config.engineerBudgetUsd, job: config.jobBudgetUsd, models: { ...config.models } };
  try {
    // Nothing set: nothing in the service's settings is touched.
    applyLive(s);
    assert.deepEqual([config.dailyBudgetUsd, config.engineerBudgetUsd, config.jobBudgetUsd, { ...config.models }], [before.daily, before.engineer, before.job, before.models]);
    assert.ok(liveView(s).caps.every((c) => !c.changed) && liveView(s).roles.every((r) => !r.changed));

    assert.equal(setLive(s, "dailyBudgetUsd", 12.345), "The daily cap is now $12.35. Changed from the app.");
    assert.equal(config.dailyBudgetUsd, 12.35);
    assert.match(setLive(s, "model:engineer", "haiku"), /^Engineers now run on haiku/);
    assert.equal(config.models.engineer, "haiku");
    assert.deepEqual(liveView(s).caps.find((c) => c.key === "dailyBudgetUsd"), { key: "dailyBudgetUsd", name: "The daily cap", usd: 12.35, changed: true, min: LIVE_CAP_MIN, max: LIVE_CAP_MAX });
    assert.equal(liveView(s).roles.find((r) => r.key === "model:engineer")!.changed, true);

    // It is kept: a restart finds it in the store and lays it over the deploy's own again.
    config.dailyBudgetUsd = before.daily;
    config.models.engineer = before.models.engineer;
    applyLive(new Store(dir));
    assert.deepEqual([config.dailyBudgetUsd, config.models.engineer], [12.35, "haiku"]);

    // Anything else is refused and changes nothing: an amount out of bounds or not an amount, a model
    // that is not one of the deploy's aliases, a setting that is not one of the seven.
    const held = JSON.stringify(s.settings().live);
    for (const [key, value] of [
      ["dailyBudgetUsd", 0], ["dailyBudgetUsd", -5], ["dailyBudgetUsd", LIVE_CAP_MAX + 0.01], ["dailyBudgetUsd", "20"], ["dailyBudgetUsd", Number.NaN], ["dailyBudgetUsd", Infinity], ["dailyBudgetUsd", undefined], ["dailyBudgetUsd", {}],
      ["model:engineer", "anthropic/claude-opus-5.5"], ["model:engineer", "gpt"], ["model:engineer", 3], ["model:ea", "haiku"], ["model:design", "haiku"], ["model:", "haiku"],
      ["sdkRunawayBudgetUsd", 5], ["deepResearchBudgetUsd", 5], ["selfMerge", "maintainer"], ["models", { chief: "opus" }], ["__proto__", 1], ["constructor", 1], [undefined, 1], [{}, 1],
    ] as Array<[unknown, unknown]>) assert.throws(() => setLive(s, key, value), LiveSettingError, `${String(key)} = ${String(value)}`);
    assert.equal(JSON.stringify(s.settings().live), held);
    assert.deepEqual([config.dailyBudgetUsd, config.models.engineer, config.models.ea, config.sdkRunawayBudgetUsd > 0, config.selfMerge], [12.35, "haiku", before.models.ea, true, "paul"]);

    // Put back: the deploy's own value returns, and the store no longer holds the setting.
    assert.match(setLive(s, "dailyBudgetUsd", null), /^The daily cap is back to the deploy's own setting: /);
    assert.match(setLive(s, "model:engineer", null), /^Engineers are back on the deploy's own model: /);
    assert.deepEqual([config.dailyBudgetUsd, config.models.engineer, s.settings().live], [before.daily, before.models.engineer, {}]);
  } finally {
    s.setSetting("live", {});
    applyLive(s);
    config.dailyBudgetUsd = before.daily;
    config.engineerBudgetUsd = before.engineer;
    config.jobBudgetUsd = before.job;
    Object.assign(config.models, before.models);
  }
});

test("only Paul's own tap in the app changes a setting, and it is said in the chat", async () => {
  const cookie = await session();
  const before = { daily: config.dailyBudgetUsd, chief: config.models.chief };
  try {
    assert.equal((await get(`${APP_PATH}/api/spend`)).status, 401);
    const page = JSON.parse(await text(await get(`${APP_PATH}/api/spend`, cookie))) as { settings: { caps: Array<{ key: string }>; roles: Array<{ key: string }>; choices: unknown[] }; byAgent: unknown[] };
    assert.deepEqual([page.settings.caps.map((c) => c.key), page.settings.roles.map((r) => r.key)], [["dailyBudgetUsd", "engineerBudgetUsd", "jobBudgetUsd"], ["model:chief", "model:worker", "model:engineer", "model:maintainer"]]);
    assert.equal((await postApi("/settings", { key: "dailyBudgetUsd", value: 15 })).status, 401);
    assert.equal((await postApi("/settings", { key: "dailyBudgetUsd", value: 15 }, cookie, { origin: "https://evil.example" })).status, 403);
    assert.equal((await postApi("/settings", { key: "dailyBudgetUsd", value: 15 }, cookie, { "sec-fetch-site": "cross-site" })).status, 403);
    assert.equal((await fetch(`${base}${APP_PATH}/api/settings`, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: "key=dailyBudgetUsd&value=15" })).status, 403);
    assert.equal((await postApi("/settings", { key: "dailyBudgetUsd", value: 99999 }, cookie)).status, 400);
    assert.equal((await postApi("/settings", { key: "selfMerge", value: "maintainer" }, cookie)).status, 400);
    assert.equal(config.dailyBudgetUsd, before.daily, "none of those changed anything");

    const res = await postApi("/settings", { key: "dailyBudgetUsd", value: 15 }, cookie, { origin: "https://workforce.example", "sec-fetch-site": "same-origin" });
    assert.deepEqual([res.status, await res.json()], [200, { ok: true, text: "The daily cap is now $15.00. Changed from the app." }]);
    assert.equal(config.dailyBudgetUsd, 15);
    await settled();
    assert.ok(chat.view().messages.some((m) => m.text === "The daily cap is now $15.00. Changed from the app."));
    const board = JSON.parse(await text(await get(`${APP_PATH}/api/board`, cookie))) as { spend: { capUsd?: number } };
    assert.equal(board.spend.capUsd, 15, "the header shows the new cap");
    assert.equal((await postApi("/settings", { key: "dailyBudgetUsd", value: null }, cookie)).status, 200);
    assert.equal(config.dailyBudgetUsd, before.daily);
  } finally {
    store.setSetting("live", {});
    applyLive(store);
    config.dailyBudgetUsd = before.daily;
    config.models.chief = before.chief;
  }
});

/* ---------- Threads: talking to the chief about one job or one pull request ---------- */

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("not really a picture, but it starts like one")]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("the same, for a JPEG")]);

test("a picture the service sends is kept for the signed-in app alone, told from its bytes, and shown only while its message is", async () => {
  const cookie = await session();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-pictures-"));
  const file = (name: string, bytes: Buffer | string) => {
    fs.writeFileSync(path.join(work, name), bytes);
    return path.join(work, name);
  };
  const kept = path.join(process.env.DATA_DIR!, "app", "pictures");
  const last = () => chat.view().messages.at(-1)!;

  // A design job's PNG: a copy is kept owner-only under the message's own number, with the caption as its words.
  await chat.sendImage(WEB_CONVERSATION, file("header.png", PNG), "The new header");
  const shown = last();
  assert.equal(shown.text, "The new header");
  assert.equal(shown.picture, `${shown.id}.png`);
  assert.deepEqual(fs.readFileSync(path.join(kept, shown.picture!)), PNG);
  assert.equal(fs.statSync(path.join(kept, shown.picture!)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(kept).mode & 0o777, 0o700);
  // What it is comes from its bytes, never its name: a JPEG called .png is kept as a JPEG.
  await chat.sendImage(WEB_CONVERSATION, file("really-a-jpeg.png", JPEG), "");
  assert.equal(last().picture, `${last().id}.jpg`);
  assert.equal(last().text, "");
  const jpeg = last().picture!;

  // The app is told the picture's name and its caption, and reads it from its own route.
  const view = (await chatView(cookie)) as unknown as { messages: Array<{ picture?: string; caption?: string; html?: string }> };
  assert.deepEqual([view.messages.at(-2)!.picture, view.messages.at(-2)!.caption], [shown.picture, "The new header"]);
  assert.match(view.messages.at(-2)!.html!, /The new header/);
  const res = await get(`${APP_PATH}/api/chat/picture/${shown.picture}`, cookie);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("cache-control"), "private, max-age=86400");
  assert.match(res.headers.get("content-security-policy")!, /default-src 'none'; sandbox/);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
  assert.equal((await get(`${APP_PATH}/api/chat/picture/${jpeg}`, cookie)).headers.get("content-type"), "image/jpeg");
  // Not signed in: nothing.
  assert.equal((await get(`${APP_PATH}/api/chat/picture/${shown.picture}`)).status, 401);

  // Not a picture, too large, or gone: no picture is kept, and the caption still is. With neither, nothing is said.
  const count = () => chat.view().messages.length;
  const before = count();
  await chat.sendImage(WEB_CONVERSATION, file("page.png", "<svg onload=alert(1)>"), "Only words");
  assert.deepEqual([last().text, last().picture], ["Only words", undefined]);
  await chat.sendImage(WEB_CONVERSATION, file("huge.png", Buffer.concat([PNG, Buffer.alloc(WEB_PICTURE_BYTES)])), "Too big to keep");
  assert.deepEqual([last().text, last().picture], ["Too big to keep", undefined]);
  await chat.sendImage(WEB_CONVERSATION, path.join(work, "missing.png"), "");
  await chat.sendImage(WEB_CONVERSATION, file("words.jpg", "plain text"), "");
  assert.equal(count(), before + 2);

  // Only a name of the transcript's own shape, and only one a kept message shows. A file that merely sits
  // in the folder, the transcript beside it and anything outside are not pictures.
  fs.writeFileSync(path.join(kept, "999999.png"), PNG);
  fs.writeFileSync(path.join(kept, "notes.svg"), "<svg/>");
  for (const name of ["999999.png", "notes.svg", "..%2Fchat.json", "%2e%2e%2f%2e%2e%2fstate.json", `${shown.picture}%00.svg`, `0${shown.picture}`, shown.picture!.replace(".png", ".jpg"), "x"]) {
    assert.equal((await get(`${APP_PATH}/api/chat/picture/${name}`, cookie)).status, 404, name);
  }
  assert.equal(chat.picture("../chat.json"), undefined);

  // A thread's picture belongs to that thread.
  const thread = webThread({ job: "abc123" })!;
  await chat.sendImage(thread, file("thread.png", PNG), "In the thread");
  assert.equal(chat.view(thread).messages.at(-1)!.picture, `${chat.view(thread).messages.at(-1)!.id}.png`);
  assert.ok(!chat.view().messages.some((m) => m.text === "In the thread"));
  // What the chief is given as the conversation so far names a picture rather than leaving a blank.
  assert.ok((await chat.recent(WEB_CONVERSATION, 50)).some((m) => m.text === "(a picture)"));
});

test("a kept picture goes when its message does, and the folder is tidied at start only when the transcript was read", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-pictures-kept-"));
  const kept = path.join(dir, "app", "pictures");
  const png = path.join(dir, "shot.png");
  fs.writeFileSync(png, PNG);
  const own = new WebChat({ dir });
  await own.sendImage(WEB_CONVERSATION, png, "First");
  const first = own.view().messages.at(-1)!.picture!;
  await own.sendImage(WEB_CONVERSATION, png, "Second");
  assert.deepEqual(fs.readdirSync(kept).sort(), [first, own.view().messages.at(-1)!.picture!].sort());
  // The transcript keeps its newest messages; a picture is dropped with the message it came with.
  for (let i = 0; i < WEB_KEEP - 1; i++) await own.send(WEB_CONVERSATION, `Later ${i}`);
  assert.equal(own.picture(first), undefined);
  assert.ok(!fs.existsSync(path.join(kept, first)));
  const second = fs.readdirSync(kept);
  assert.equal(second.length, 1);
  assert.ok(own.picture(second[0]!));

  // At start: what no kept message shows is removed, and what one shows stays.
  fs.writeFileSync(path.join(kept, "stray.png"), PNG);
  const again = new WebChat({ dir });
  assert.deepEqual(fs.readdirSync(kept), second);
  assert.deepEqual(again.picture(second[0]!)?.bytes, PNG);
  // An unreadable transcript says nothing about what is shown, so nothing is removed on its account.
  fs.writeFileSync(path.join(dir, "app", "chat.json"), "{ not json");
  new WebChat({ dir });
  assert.deepEqual(fs.readdirSync(kept), second);

  // With no data directory the picture is held in memory and read the same way.
  const loose = new WebChat();
  await loose.sendImage(WEB_CONVERSATION, png, "Held");
  assert.deepEqual(loose.picture(loose.view().messages.at(-1)!.picture!)?.type, "image/png");
});

test("the command menu offers what the chief understands, and nothing the app would refuse", async () => {
  const cookie = await session();
  assert.equal((await get(`${APP_PATH}/api/commands`)).status, 401);
  const served = JSON.parse(await text(await get(`${APP_PATH}/api/commands`, cookie))) as { commands: Array<{ command: string; needs?: string; takes?: string; about: string }> };
  assert.deepEqual(served.commands, WEB_COMMANDS);

  const offered = new Set(WEB_COMMANDS.map((c) => c.command));
  assert.equal(offered.size, WEB_COMMANDS.length, "no command is offered twice");
  for (const c of WEB_COMMANDS) {
    assert.match(c.command, /^\/[a-z]+(?: [a-z]+)?$/, c.command);
    assert.ok(c.about.length > 8 && c.about.length < 90, `${c.command} is described in a line`);
    assert.ok(!(c.needs && c.takes), `${c.command} either needs something typed after it or does not`);
    // Offered means it works when typed here: nothing on the menu is turned away by the app's own refusal.
    assert.equal(webRefusal(c.command), undefined, c.command);
    assert.equal(webRefusal(`${c.command} abc123`), undefined, c.command);
    // And it is a command the chief has: /help is the list itself.
    assert.ok(c.command === "/help" || new RegExp(`^${c.command.replace("/", "\\/")}\\b`, "m").test(HELP), `${c.command} is in /help`);
  }
  // The other way round: every slash command /help lists is on the menu, or is one of the owner-only
  // ones the app refuses when typed. A command added to the chief shows up here until it is placed.
  const NOT_IN_THE_APP: Record<string, string> = { "/password": "/password", "/whoami": "/whoami", "/pair": "/pair 123456", "/unpair": "/unpair" };
  const listed = new Set([...HELP.matchAll(/(?:^|[\s;(])(\/[a-z]+)\b/gm)].map((m) => m[1]!));
  assert.ok(listed.size >= 15, "the commands were read out of /help");
  const first = new Set(WEB_COMMANDS.map((c) => c.command.split(" ")[0]));
  for (const command of listed) assert.ok(first.has(command) || command in NOT_IN_THE_APP, `${command} is in /help but neither on the app's menu nor named as left off it`);
  for (const [command, typed] of Object.entries(NOT_IN_THE_APP)) {
    assert.ok(!first.has(command), `${command} is not offered`);
    assert.equal(webRefusal(typed), WEB_APPROVAL_REFUSAL, `${typed} is refused in the app`);
  }
  assert.equal(webRefusal("/google disconnect"), WEB_APPROVAL_REFUSAL);
  assert.ok(!offered.has("/google disconnect"));

  // The menu lives in the page and only fills the box: it posts nothing and sends nothing itself.
  const script = appAsset("app.js")!.body.toString();
  const menu = script.slice(script.indexOf("function commandMenu(textarea) {"), script.indexOf("const fileSize = "));
  assert.ok(menu.length > 500);
  assert.doesNotMatch(menu, /fetch\(|postJson|postMessage|\bsend\(|sendThread|\.submit\(|requestSubmit/);
  assert.match(menu, /textarea\.value = filled\(c\);/);
});

test("a finished job's message carries its report, so the app links to it where other channels name a command", async () => {
  const { finishedText } = await import("../src/jobs.js");
  const { reportPointer, REPORT_POINTER } = await import("../src/messages.js");
  const cookie = await session();
  const finished = (title: string, summary: string, output?: string) => {
    const j = store.createJob("analyse", "Do a deep review of the repository.", WEB_SENDER, "product", WEB_CONVERSATION, { title });
    if (output !== undefined) store.writeOutput(j.id, output);
    return store.updateJob(j.id, { status: "done", finishedAt: new Date().toISOString(), summary })!;
  };
  const job = finished("Deep review", "The queue is sound. Billing can double charge.", "# Deep review\n\nThe queue is sound.");
  // What the service sends is the same on every channel: the worker's words, then a command to type.
  const sent = finishedText(job, "The queue is sound. Billing can double charge.");
  assert.ok(sent.endsWith(reportPointer(job.id)) && REPORT_POINTER.test(sent));
  await chat.send(WEB_CONVERSATION, sent);
  await chat.send(WEB_CONVERSATION, `Finished: something else.\nDone. ${reportPointer("nosuch")}`);
  await chat.send(WEB_CONVERSATION, `I said "${reportPointer(job.id)}" in the middle, not at the end, here.`);
  const messages = ((await chatView(cookie)) as unknown as { messages: Array<{ html?: string; report?: { job: string; title: string } }> }).messages.slice(-3);
  // In the app that last sentence becomes the job itself: a link to the report, and no command to type.
  assert.deepEqual(messages[0]!.report, { job: job.id, title: "Deep review" });
  assert.match(messages[0]!.html!, /The queue is sound\. Billing can double charge\./);
  assert.ok(!messages[0]!.html!.includes("show job") && !messages[0]!.html!.includes("Full report"));
  // A job the store does not hold, or the sentence anywhere but the end, leaves the words as they were.
  assert.equal(messages[1]!.report, undefined);
  assert.match(messages[1]!.html!, /Full report: show job nosuch\./);
  assert.equal(messages[2]!.report, undefined);
  // The transcript itself is unchanged, so what the chief reads back is what every channel was sent.
  assert.ok(chat.view().messages.some((m) => m.text === sent));

  // A link is a promise that there is something to read. A job recorded as done whose whole output is
  // the line saying the run was stopped (one that ran out of turns before 20 Nov 2026) wrote no report:
  // the app says that, in plain words, and points at the job so it can be run again.
  const STOP = "The agent stopped early (error_max_turns).";
  const empty = finished("Feature ideas", STOP, STOP);
  await chat.send(WEB_CONVERSATION, finishedText(empty, STOP));
  // And a job with nothing saved at all keeps the sentence as it was sent: no link, and no claim either way.
  const bare = finished("Nothing saved", "Done.");
  await chat.send(WEB_CONVERSATION, finishedText(bare, "Done."));
  const later = ((await chatView(cookie)) as unknown as { messages: Array<{ html?: string; report?: { job: string; title: string; missing?: boolean } }>; jobs: Array<{ id: string; said?: string; outcome?: { state: string; text: string } }> });
  const [none, kept] = later.messages.slice(-2);
  assert.deepEqual(none!.report, { job: empty.id, title: "Feature ideas", missing: true });
  assert.match(none!.html!, /It ran out of turns before writing a report\./);
  assert.ok(!none!.html!.includes("error_max_turns") && !none!.html!.includes("stopped early"), "no SDK jargon reaches him");
  assert.equal(kept!.report, undefined);
  assert.match(kept!.html!, new RegExp(`Full report: show job ${bare.id}\\.`));
  // Its card says it did not do what was asked, and does not repeat the stop line as the worker's words.
  const card = later.jobs.find((j) => j.id === empty.id)!;
  assert.deepEqual([card.outcome!.state, card.said], ["not_met", undefined]);
  assert.match(card.outcome!.text, /^It ran out of turns before writing a report\. There is nothing to read; run it again to get one\.$/);
  assert.equal(later.jobs.find((j) => j.id === job.id)!.outcome!.state, "unconfirmed", "a job with a real report is judged as before");
  // Its page has no report to show, and says why, where the report would be.
  const emptyPage = JSON.parse(await text(await get(`${APP_PATH}/api/jobs/${empty.id}`, cookie))) as { outputHtml?: string; noReport?: string };
  assert.equal(emptyPage.outputHtml, undefined);
  assert.match(emptyPage.noReport!, /^It ran out of turns before writing a report\. There is nothing to read\. Run it again to get one/);
  const real = JSON.parse(await text(await get(`${APP_PATH}/api/jobs/${job.id}`, cookie))) as { outputHtml?: string; noReport?: string };
  assert.ok(real.outputHtml!.includes("The queue is sound") && real.noReport === undefined);
  // A failed job, and a running one, are never "done with nothing": the rule reads only a done job's stop line.
  const { stoppedEarly, plainStop } = await import("../src/messages.js");
  assert.equal(stoppedEarly(STOP), "error_max_turns");
  for (const not of [undefined, "", "Done.", `${STOP} And more.`, `It said: ${STOP}`]) assert.equal(stoppedEarly(not), undefined, String(not));
  assert.equal(plainStop(`Finished: x.\n${STOP}`), "Finished: x.\nIt ran out of turns before writing a report.");

  // The page follows that link to the job with its report opened in full, and shows the report first.
  const script = appAsset("app.js")!.body.toString();
  assert.match(script, /href: `#\/job\/\$\{m\.report\.job\}\/report`/);
  assert.match(script, /m\.report\?\.missing\s*\? h\("a", \{ class: "report-link none", href: `#\/job\/\$\{m\.report\.job\}` \}/, "no link to a report that does not exist");
  assert.match(script, /const m = \/\^#\\\/job\\\/\(\[A-Za-z0-9_-\]\{1,64\}\)\(\\\/report\)\?\$\/\.exec\(location\.hash\);/);
  const page = script.slice(script.indexOf("    detail.pull ? pullPane(detail.pull) : null,"), script.indexOf("/* ---------- Chat ---------- */"));
  assert.ok(page.indexOf("output,") > 0 && page.indexOf("output,") < page.indexOf("threadPane(),") && page.indexOf("threadPane(),") < page.indexOf("about, trace"), "the report comes before the thread and the trace");
});

test("the app never hands replaceChildren something that is not an element", () => {
  // replaceChildren writes whatever is not a node as text, so a closed list passed as null showed the
  // word "null" under the chat bar (19 Nov 2026). Every call either builds its children with h(), which
  // drops nothing-values, spreads a list, or passes one element.
  const script = appAsset("app.js")!.body.toString();
  const calls = [...script.matchAll(/\.replaceChildren\(([^\n]*)\n?/g)].map((m) => m[1]!.trim());
  assert.ok(calls.length >= 12);
  for (const first of calls) assert.match(first, /^(\.\.\.|$|icon\(|shellEl\)|homeEl\)|header\(|spendPage\(|boardPage\(|r\.name === "job" \? jobPage\(\) : pullPage\(r\)\))/, `replaceChildren(${first}`);
  assert.match(script, /chatBarEl\.replaceChildren\(\n\s*\.\.\.\[[\s\S]*?\]\.filter\(Boolean\),\n\s*\);/);
});

test("a thread's address names a job or a pull request, and nothing else is a conversation of the app's", () => {
  assert.equal(webThread({ job: "ab12cd" }), "web:job:ab12cd");
  assert.equal(webThread({ pull: { repo: "self", number: 111 } }), "web:pull:self:111");
  assert.deepEqual(webTopic("web:job:ab12cd"), { job: "ab12cd" });
  assert.deepEqual(webTopic("web:pull:school-timetable:11"), { pull: { repo: "school-timetable", number: 11 } });
  for (const bad of [{ job: "" }, { job: "a b" }, { job: "a:b" }, { job: "x".repeat(65) }, { pull: { repo: "a/b", number: 1 } }, { pull: { repo: "self", number: 0 } }, { pull: { repo: "self", number: 1.5 } }, { pull: { repo: "", number: 1 } }]) assert.equal(webThread(bad as never), undefined, JSON.stringify(bad));
  for (const ok of [WEB_CONVERSATION, "web:job:ab12cd", "web:pull:self:111"]) assert.equal(isWebConversation(ok), true, ok);
  for (const bad of [WEB_SENDER, "web:", "web:job:", "web:job:a b", "web:pull:self", "web:pull:self:0", "web:pull:self:1:2", "web:main:x", "web:job:ab12cd\n", "tg:99887766", "discord:1", "WEB:MAIN", " web:main"]) {
    assert.equal(isWebConversation(bad), false, JSON.stringify(bad));
    assert.equal(webTopic(bad), undefined, JSON.stringify(bad));
  }
});

test("each thread keeps its own transcript, apart from the main conversation and from each other", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-app-threads-"));
  let clock = Date.UTC(2026, 10, 19, 9, 0, 0);
  const c = new WebChat({ dir, now: () => (clock += 1000) });
  const A = "web:job:aaa111";
  const B = "web:pull:self:111";
  c.inbound("general question");
  c.inbound("about job A", A);
  await c.send(A, "answer about A");
  await c.send(B, "the conflicts are resolved");
  await c.send(WEB_CONVERSATION, "general answer");
  // An address of the app's that is no thread (the sender itself, a malformed one) is the main conversation.
  await c.send(WEB_SENDER, "to the sender");
  await c.send("web:job:not a job", "malformed");
  assert.deepEqual(c.view().messages.map((m) => m.text), ["general question", "general answer", "to the sender", "malformed"]);
  assert.deepEqual(c.view(A).messages.map((m) => [m.from, m.text]), [["paul", "about job A"], ["clearops", "answer about A"]]);
  assert.deepEqual(c.view(B).messages.map((m) => m.text), ["the conflicts are resolved"]);
  assert.deepEqual((await c.recent(A, 10)).map((m) => `${m.author}: ${m.text}`), ["Paul: about job A", "ClearOps: answer about A"], "what the chief is shown of a thread is that thread");
  assert.deepEqual((await c.recent(WEB_CONVERSATION, 2)).map((m) => m.text), ["to the sender", "malformed"]);
  // The live status line and the typing signal belong to the conversation they were sent to.
  await c.typing(A);
  const handle = await c.sendEditable(A, "Reading the trace");
  assert.deepEqual([c.view(A).typing, c.view().typing, c.view(B).typing], [true, false, false]);
  assert.deepEqual([c.view(A).messages.at(-1)!.live, c.view().messages.some((m) => m.live)], [true, false]);
  await c.remove(A, handle!);
  // Which threads have anything in them, for the cards: the status line never counts.
  assert.deepEqual([...c.threads()].map(([t, n]) => [t, n.count]), [[A, 2], [B, 1]]);
  // It is all kept across a restart, in the one owner-only file.
  const again = new WebChat({ dir });
  assert.deepEqual(again.view(A).messages.map((m) => m.text), ["about job A", "answer about A"]);
  assert.equal(again.view().messages.length, 4);
  assert.equal(fs.statSync(path.join(dir, "app", "chat.json")).mode & 0o777, 0o600);

  // A busy thread cannot push the main conversation out, nor the other way round, and old threads go first.
  const big = new WebChat();
  for (let i = 0; i < WEB_THREAD_KEEP + 30; i++) big.inbound(`t${i}`, A);
  for (let i = 0; i < 20; i++) big.inbound(`m${i}`);
  assert.equal(big.view(A).messages.length + 0, Math.min(WEB_THREAD_KEEP, 200));
  assert.equal(big.view().messages.length, 20);
  for (let i = 0; i < WEB_KEEP + 10; i++) big.inbound(`more${i}`);
  assert.equal((await big.recent(WEB_CONVERSATION, 10_000)).length, WEB_KEEP);
  assert.equal((await big.recent(A, 10_000)).length, WEB_THREAD_KEEP, "the thread is untouched by the main conversation filling up");
  for (let i = 0; i < WEB_THREADS_MAX + 5; i++) big.inbound("hello", `web:job:j${i}`);
  assert.equal(big.threads().size, WEB_THREADS_MAX);
  assert.equal(big.threads().has(A), false, "the thread quiet for longest is the one let go");
  assert.equal(big.threads().has(`web:job:j${WEB_THREADS_MAX + 4}`), true);
});

test("a chat of Paul's own is addressed by an id the service made, and is about nothing in particular", () => {
  assert.equal(webOwnChat("1a2b3c4d"), "web:chat:1a2b3c4d");
  for (const bad of ["", "new", "1a2b3c4", "1a2b3c4d5", "1A2B3C4D", "1a2b3c4g", "../../etc", "1a2b3c4d\n", "1a2b 3c4"]) assert.equal(webOwnChat(bad), undefined, JSON.stringify(bad));
  assert.equal(isWebConversation("web:chat:1a2b3c4d"), true);
  // It is not a job's or a pull request's thread, so no job's context is ever attached to it by its address.
  assert.equal(webTopic("web:chat:1a2b3c4d"), undefined);
  for (const bad of ["web:chat:", "web:chat:new", "web:chat:1a2b3c4", "web:chat:1A2B3C4D", "web:chat:1a2b3c4d:x", "web:chat:1a2b3c4d\n", "web:chats:1a2b3c4d"]) assert.equal(isWebConversation(bad), false, JSON.stringify(bad));
});

test("Paul's own chats are kept apart, named from their first words, and limited in number", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-own-chats-"));
  let t = Date.UTC(2026, 10, 19, 9, 0, 0);
  const own = new WebChat({ dir, now: () => (t += 1000) });
  // Named by the service from the first line of what it starts with: tidied, cut short, never empty.
  const offsite = own.open("  Plan the   Prebid offsite\nin January, somewhere warm ");
  assert.match(offsite.id, /^[a-f0-9]{8}$/);
  assert.equal(offsite.title, "Plan the Prebid offsite");
  const long = own.open("x".repeat(200));
  assert.equal(long.title.length, WEB_CHAT_TITLE_MAX);
  assert.ok(long.title.endsWith("…"));
  assert.equal(own.open("").title, "New chat");
  assert.equal(own.open("\n\n").title, "New chat");
  assert.notEqual(offsite.id, long.id);
  assert.deepEqual(own.chat(offsite.id), offsite);
  assert.equal(own.chat("00000000"), undefined);

  // Each is a conversation of its own: nothing said in one is in another, or in the main one.
  const A = webOwnChat(offsite.id)!;
  const B = webOwnChat(long.id)!;
  own.inbound("Where should it be?", A);
  await own.send(A, "Lisbon is warm enough in January.");
  own.inbound("Something else", B);
  own.inbound("In the main conversation");
  assert.deepEqual(own.view(A).messages.map((m) => m.text), ["Where should it be?", "Lisbon is warm enough in January."]);
  assert.deepEqual(own.view(B).messages.map((m) => m.text), ["Something else"]);
  assert.deepEqual(own.view().messages.map((m) => m.text), ["In the main conversation"]);
  assert.deepEqual((await own.recent(A, 10)).map((m) => m.text), ["Where should it be?", "Lisbon is warm enough in January."]);
  // The list is the one spoken in most recently first, with how much is in each.
  assert.deepEqual(own.ownChats().slice(0, 2).map((c) => [c.title, c.count]), [[long.title, 1], ["Plan the Prebid offsite", 2]]);

  // Kept across a restart, with its messages.
  const again = new WebChat({ dir, now: () => (t += 1000) });
  assert.deepEqual(again.chat(offsite.id), offsite);
  assert.deepEqual(again.view(A).messages.map((m) => m.text), ["Where should it be?", "Lisbon is warm enough in January."]);

  // A chat keeps as much as the main conversation, and is not one of the job threads that are counted and dropped.
  for (let i = 0; i < WEB_THREAD_KEEP + 5; i++) again.inbound(`line ${i}`, A);
  assert.equal((await again.recent(A, WEB_KEEP)).length, WEB_THREAD_KEEP + 7, "more than a job's thread keeps");
  for (let i = 0; i < WEB_THREADS_MAX + 3; i++) again.inbound("in a job's thread", `web:job:j${i}`);
  assert.ok(again.chat(offsite.id) && again.view(A).messages.length > 0, "job threads coming and going never drop a chat of his own");

  // Past the limit the chat quiet for longest goes, with its messages and its pictures; the rest stay.
  const png = path.join(dir, "shot.png");
  fs.writeFileSync(png, PNG);
  const quiet = again.open("The quiet one");
  await again.sendImage(webOwnChat(quiet.id)!, png, "A picture in it");
  const picture = again.view(webOwnChat(quiet.id)!).messages.at(-1)!.picture!;
  assert.ok(again.picture(picture));
  const B2 = webOwnChat(long.id)!;
  for (const c of again.ownChats()) if (c.id !== quiet.id) again.inbound("still in use", webOwnChat(c.id)!);
  while (again.ownChats().length < WEB_CHATS_MAX) again.inbound("first words", webOwnChat(again.open("another").id)!);
  assert.ok(again.chat(quiet.id), "at the limit nothing has gone yet");
  again.open("one more than the limit");
  assert.equal(again.ownChats().length, WEB_CHATS_MAX);
  assert.equal(again.chat(quiet.id), undefined);
  assert.equal(again.picture(picture), undefined);
  assert.ok(!fs.existsSync(path.join(dir, "app", "pictures", picture)));
  assert.ok(again.chat(offsite.id) && again.chat(long.id) && again.view(B2).messages.length > 0);
  // What is meant for a chat that is no longer kept (a job finishing later) lands in the main conversation, not nowhere.
  await again.send(webOwnChat(quiet.id)!, "Finished: the job you started there");
  assert.equal(again.view().messages.at(-1)!.text, "Finished: the job you started there");
});

test("a new chat is opened by its first message from Paul's signed-in browser, and is its own conversation with the chief", async () => {
  const cookie = await session();
  const view = async (thread?: string) => {
    const res = await get(`${APP_PATH}/api/chat${thread ? `?thread=${encodeURIComponent(thread)}` : ""}`, cookie);
    return { status: res.status, body: res.status === 200 ? (JSON.parse(await text(res)) as { messages: Array<{ from: string; text?: string; html?: string }>; chats: Array<{ id: string; title: string; count: number }>; jobs: unknown[] }) : undefined };
  };
  const chatsBefore = (await view()).body!.chats.length;
  const mainBefore = (await view()).body!.messages.length;

  // Not signed in, or not this site's own script: nothing is opened.
  assert.equal((await postChat({ text: "Plan the offsite", thread: WEB_NEW_CHAT })).status, 401);
  assert.equal((await postChat({ text: "Plan the offsite", thread: WEB_NEW_CHAT }, cookie, { origin: "https://evil.example" })).status, 403);
  assert.equal((await postChat({ text: "", thread: WEB_NEW_CHAT }, cookie)).status, 400);
  assert.equal((await postChat({ text: "x".repeat(WEB_TEXT_MAX + 1), thread: WEB_NEW_CHAT }, cookie)).status, 413);
  // Reading never opens one, and an id the transcript does not keep names nothing, whatever its shape.
  assert.equal((await view(WEB_NEW_CHAT)).status, 404);
  assert.equal((await view("chat:00000000")).status, 404);
  assert.equal((await postChat({ text: "hello", thread: "chat:00000000" }, cookie)).status, 404);
  assert.equal((await postChat({ text: "hello", thread: "chat:../main" }, cookie)).status, 404);
  assert.equal((await view()).body!.chats.length, chatsBefore, "none of that opened a chat");

  chiefSays = "Lisbon is warm enough in January.";
  chiefAsked.length = 0;
  try {
    const res = await postChat({ text: "Plan the Prebid offsite\nsomewhere warm", thread: WEB_NEW_CHAT }, cookie);
    assert.equal(res.status, 202);
    const said = (await res.json()) as { ok: boolean; thread?: string };
    assert.match(said.thread!, /^chat:[a-f0-9]{8}$/);
    const address = `web:${said.thread}`;
    for (let i = 0; i < 100 && chat.view(address).messages.at(-1)?.from !== "clearops"; i++) await new Promise((r) => setTimeout(r, 10));
    // The service named it from his first line, and it is in the list every conversation carries.
    const mine = await view(said.thread);
    assert.deepEqual(mine.body!.chats.find((c) => `chat:${c.id}` === said.thread), { id: said.thread!.slice(5), title: "Plan the Prebid offsite", count: 2, lastAt: mine.body!.chats.find((c) => `chat:${c.id}` === said.thread)!.lastAt } as never);
    assert.deepEqual(mine.body!.messages.map((m) => m.from), ["paul", "clearops"]);
    assert.match(mine.body!.messages[1]!.html!, /Lisbon is warm enough/);
    // The chief gets his words and nothing attached: a chat of his own is about no job.
    assert.equal(chiefAsked.length, 1);
    assert.equal(chiefAsked[0], "Plan the Prebid offsite\nsomewhere warm");
    // Its own conversation with the chief, and none of it in the main one or anywhere else.
    assert.equal(store.getSession(address), "chief-session");
    assert.equal((await view()).body!.messages.length, mainBefore);
    assert.equal(elsewhere.filter((m) => m.text.includes("Lisbon")).length, 0);

    // A second message goes to the same chat by its id, and opens nothing new.
    assert.equal(((await (await postChat({ text: "And where to stay?", thread: said.thread }, cookie)).json()) as { thread?: string }).thread, undefined);
    for (let i = 0; i < 100 && chat.view(address).messages.filter((m) => m.from === "clearops").length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal((await view(said.thread)).body!.messages.length, 4);
    assert.equal((await view()).body!.chats.length, chatsBefore + 1);

    // No approval word works in a chat of his own either, and a one-time code never becomes its name.
    chiefAsked.length = 0;
    const word = (await (await postChat({ text: "send 9b80e7", thread: said.thread }, cookie)).json()) as { ok: boolean };
    assert.equal(word.ok, true);
    assert.equal(chat.view(address).messages.at(-1)!.text, WEB_APPROVAL_REFUSAL);
    const coded = (await (await postChat({ text: "code 9b80e7 481516", thread: WEB_NEW_CHAT }, cookie)).json()) as { thread?: string };
    const codedView = (await view(coded.thread)).body!;
    assert.equal(codedView.chats.find((c) => `chat:${c.id}` === coded.thread)!.title, WEB_CODE_PLACEHOLDER);
    assert.ok(!JSON.stringify(codedView).includes("481516"));
    assert.equal(chiefAsked.length, 0, "neither reached the chief");
  } finally {
    chiefSays = undefined;
  }
});

test("a message in a job's thread reaches the chief with that job attached, and stays in that thread", async () => {
  const cookie = await session();
  const job = store.updateJob(store.createJob("research", "Find where Epimax is in stock and what it costs.", PAUL, "product", PAUL, { title: "Epimax stock check" } as never).id, { status: "done", finishedAt: iso(5) });
  const before = (await chatView(cookie)).messages.length;
  const thread = `job:${job.id}`;
  const address = `web:job:${job.id}`;
  const threadView = async () => JSON.parse(await text(await get(`${APP_PATH}/api/chat?thread=${encodeURIComponent(thread)}`, cookie))) as { messages: Array<{ from: string; text?: string; html?: string }>; jobs: unknown[] };
  assert.deepEqual((await threadView()).messages, []);
  chiefSays = "Medino has it for the least.";
  chiefAsked.length = 0;
  try {
    assert.equal((await postChat({ text: "Which was cheapest?", thread })).status, 401);
    assert.equal((await postChat({ text: "Which was cheapest?", thread }, cookie, { origin: "https://evil.example" })).status, 403);
    assert.equal((await postChat({ text: "Which was cheapest?", thread }, cookie)).status, 202);
    for (let i = 0; i < 100 && chat.view(address).messages.at(-1)?.from !== "clearops"; i++) await new Promise((r) => setTimeout(r, 10));
    // The chief is told which job this is by the service, so Paul does not have to say.
    assert.equal(chiefAsked.length, 1);
    assert.match(chiefAsked[0]!, new RegExp(`^This message is in the thread of job ${job.id}\\. Job context \\(from the store, not from Paul\\):\\nTitle: Epimax stock check\\nBrief: Find where Epimax is in stock`));
    assert.match(chiefAsked[0]!, /Paul: Which was cheapest\?[\s\S]*\n\nWhich was cheapest\?$/);
    const view = await threadView();
    assert.deepEqual(view.messages.map((m) => m.from), ["paul", "clearops"]);
    assert.match(view.messages[1]!.html!, /Medino has it for the least/);
    assert.equal((await chatView(cookie)).messages.length, before, "nothing of it is in the main conversation");
    assert.equal(store.getSession(address), "chief-session", "the thread is its own conversation with the chief");
    assert.equal(elsewhere.filter((m) => m.text.includes("Medino")).length, 0);
    // The job's card says its thread has something in it.
    const detail = JSON.parse(await text(await get(`${APP_PATH}/api/jobs/${job.id}`, cookie))) as { job: { thread?: { count: number } } };
    assert.equal(detail.job.thread?.count, 2);

    // No approval word works in a thread either, and a one-time code is not written down there.
    chiefAsked.length = 0;
    assert.equal((await postChat({ text: "send 9b80e7", thread }, cookie)).status, 202);
    assert.equal((await postChat({ text: "code 123456", thread }, cookie)).status, 202);
    await new Promise((r) => setTimeout(r, 50));
    const after = chat.view(address).messages.slice(-4).map((m) => m.text);
    assert.deepEqual(after, ["send 9b80e7", WEB_APPROVAL_REFUSAL, WEB_CODE_PLACEHOLDER, WEB_CODE_REFUSAL]);
    assert.equal(chiefAsked.length, 0, "neither reached the orchestrator");
  } finally {
    chiefSays = undefined;
  }

  // Only a job that exists and a pull request in a managed repository has a thread.
  for (const bad of ["job:nope", "job:", "pull:nowhere:3", "pull:self:0", "pull:self", "main", "web:main", `web:job:${job.id}`, "tg:99887766", `job:${job.id}/x`]) {
    assert.equal((await get(`${APP_PATH}/api/chat?thread=${encodeURIComponent(bad)}`, cookie)).status, 404, bad);
    assert.equal((await postChat({ text: "hello", thread: bad }, cookie)).status, 404, bad);
  }
  assert.equal((await postChat({ text: "hello", thread: { job: job.id } }, cookie)).status, 404);
});

test("a message in a pull request's thread tells the chief which pull request, in which repository", async () => {
  const cookie = await session();
  chiefSays = "On it.";
  chiefAsked.length = 0;
  try {
    assert.equal((await postChat({ text: "Please resolve the conflicts.", thread: "pull:self:101" }, cookie)).status, 202);
    for (let i = 0; i < 100 && chat.view("web:pull:self:101").messages.at(-1)?.from !== "clearops"; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(chiefAsked.length, 1);
    assert.match(chiefAsked[0]!, /^This message is in the app's thread for pull request #101 in the self repository \(drpaulfarrow\/clear-ops\): https:\/\/github\.com\/drpaulfarrow\/clear-ops\/pull\/101\. That is from the service, not from Paul\.\nA job about it works in that repository, on that same pull request and its branch: it opens no new pull request and merges nothing\.\n\nPlease resolve the conflicts\.$/);
    assert.deepEqual(chat.view("web:pull:self:101").messages.map((m) => m.from), ["paul", "clearops"]);
  } finally {
    chiefSays = undefined;
  }
});

test("a pull request that conflicts says so, so the app can offer to have it resolved", async () => {
  resetPull();
  assert.equal((await newPulls().view("self", 12)).conflicts, false);
  pull.pr = { ...pull.pr, mergeable: false };
  const v = await newPulls().view("self", 12);
  assert.deepEqual([v.conflicts, v.blocked], [true, "It conflicts with the base branch."]);
  pull.pr = { ...pull.pr, mergeable: false, state: "closed" };
  assert.equal((await newPulls().view("self", 12)).conflicts, false, "only an open one");
});

/* ---------- Pull requests: the list from GitHub, review and merge ---------- */

const prJob = (s: InstanceType<typeof Store>, pr: string | undefined, target = "self", patch: Record<string, unknown> = {}) =>
  s.updateJob(s.createJob("engineer", "Add the thing.", PAUL, target as never, PAUL, { title: "Add the thing" } as never).id, { status: "done", finishedAt: iso(5), ...(pr ? { pr } : {}), ...patch } as never);

test("the open pull requests come from GitHub itself, for the managed repositories only, and never hold up a page", async () => {
  resetPull();
  let clock = 5_000_000;
  const pulls = newPulls(() => clock);
  // The first look answers at once with nothing yet, and reads in the background.
  assert.deepEqual(pulls.open(), { pulls: [], unread: [], loading: true });
  await pulls.settled();
  const got = pulls.open();
  assert.deepEqual(got.pulls.map((p) => [p.repo, p.repository, p.number, p.author, p.branch, p.draft, p.openedAt]), [
    ["self", "workforce", 12, "clear-ops-bot", "clear/thing", false, "2026-11-18T12:00:00Z"],
    ["self", "workforce", 9, "someone", "old", true, "2026-11-17T09:00:00Z"],
  ]);
  assert.ok(!JSON.stringify(got).includes("ghp_"), "a token in a title is redacted");
  // A repository the service cannot read is named, so "none open" is not claimed for it.
  assert.deepEqual([got.unread, got.loading], [["Clear Exchange"], false]);
  // One read per repository it holds a credential for, to GitHub's own API, credential in a header.
  assert.deepEqual(pull.calls.map((c) => `${c.method} ${c.url}`).sort(), ["drpaulfarrow/clear-ops", "drpaulfarrow/site"].map((r) => `GET https://api.github.com/repos/${r}/pulls?state=open&sort=created&direction=desc&per_page=${PULL_LIST_MAX}`));
  assert.ok(pull.calls.every((c) => c.auth === `Bearer ${PULL_TOKEN}` && !c.url.includes(PULL_TOKEN)));

  // Within the minute nothing is read again; after it, each repository once more.
  pull.calls.length = 0;
  clock += PULL_LIST_FRESH_MS - 1;
  pulls.open();
  await pulls.settled();
  assert.equal(pull.calls.length, 0);
  clock += 2;
  pull.list = pull.list.slice(0, 1);
  assert.equal(pulls.open().pulls.length, 2, "the last reading is shown while the next is fetched");
  await pulls.settled();
  assert.deepEqual(pulls.open().pulls.map((p) => p.number), [12]);
  // A read that fails keeps the last list and says which repository it could not read.
  clock += PULL_LIST_FRESH_MS + 1;
  pull.listAnswer = { status: 500, body: { message: "boom" } };
  pulls.open();
  await pulls.settled();
  const after = pulls.open();
  assert.deepEqual([after.pulls.map((p) => p.number), after.unread.sort()], [[12], ["Clear Exchange", "site", "workforce"]]);

  // The board carries the list as it is.
  const s = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-app-pull-")));
  const board = appBoard({ store: s, queue: quietQueue, now, openPulls: () => ({ pulls: got.pulls, unread: got.unread, loading: false }) });
  assert.deepEqual([board.pulls.map((p) => p.number), board.pullsUnread, board.pullsLoading], [[12, 9], ["Clear Exchange"], false]);
  assert.deepEqual([appBoard({ store: s, queue: quietQueue, now }).pulls, appBoard({ store: s, queue: quietQueue, now }).pullsLoading], [[], false]);
});

test("a pull request is shown as GitHub holds it: read-only, cut to size, with nothing secret in it", async () => {
  resetPull();
  const pulls = newPulls();
  pull.pr = { ...pull.pr, title: "Add the thing ghp_abcdefghijklmnopqrstuvwxyz0123456789", body: `Line one.\r\n\r\n${"x".repeat(7000)}` };
  pull.files = [
    { filename: "src/thing.ts", status: "modified", additions: 5, deletions: 1, patch: `@@ -1 +1 @@\n+const key = "sk-live-abcdefghijklmnopqrstuvwxyz";\n${"+y\n".repeat(10_000)}` },
    ...Array.from({ length: 120 }, (_, i) => ({ filename: `src/f${i}.ts`, status: "added", additions: 1, deletions: 0, patch: `+${"z".repeat(5000)}` })),
  ];
  const v = await pulls.view("self", "12");
  assert.deepEqual({ url: v.url, repo: v.repo, repository: v.repository, number: v.number, author: v.author, state: v.state, draft: v.draft, head: v.head, branch: v.branch, base: v.base, commits: v.commits, redeploys: v.redeploys, blocked: v.blocked }, { url: SELF_PR, repo: "self", repository: "drpaulfarrow/clear-ops", number: 12, author: "clear-ops-bot", state: "open", draft: false, head: HEAD, branch: "clear/thing", base: "main", commits: 2, redeploys: true, blocked: undefined });
  assert.equal((await pulls.view("site", 3)).redeploys, false);
  assert.deepEqual(v.checks, [{ name: "test", state: "passed" }, { name: "deploy", state: "skipped" }]);
  assert.ok(!JSON.stringify(v).includes("ghp_") && !JSON.stringify(v).includes("sk-live-"), "tokens in a title or a diff are redacted");
  assert.ok(v.body!.startsWith("Line one.\n\nxxx") && v.body!.length <= 6001, "the description keeps its line breaks and is cut");
  assert.equal(v.files.length, PULL_FILES_MAX);
  assert.ok(v.files[0]!.patch!.length <= PULL_PATCH_MAX && v.files[0]!.cut === true);
  assert.ok(v.files.reduce((n, f) => n + (f.patch?.length ?? 0), 0) <= PULL_PATCHES_MAX, "all the changes together are capped");
  // Three reads for it, all GETs to GitHub's own API for that repository, with the credential in a header.
  assert.deepEqual(pull.calls.filter((c) => c.url.includes("/clear-ops/")).map((c) => `${c.method} ${c.url}`).sort(), [
    `GET https://api.github.com/repos/drpaulfarrow/clear-ops/commits/${HEAD}/check-runs?per_page=100`,
    "GET https://api.github.com/repos/drpaulfarrow/clear-ops/pulls/12",
    `GET https://api.github.com/repos/drpaulfarrow/clear-ops/pulls/12/files?per_page=${PULL_FILES_MAX}`,
  ]);
  assert.ok(pull.calls.every((c) => c.auth === `Bearer ${PULL_TOKEN}` && !c.url.includes(PULL_TOKEN)));
  assert.ok(!JSON.stringify(v).includes(PULL_TOKEN));
});

test("a pull request is named only by a managed repository's alias and its own number", async () => {
  resetPull();
  const pulls = newPulls();
  const refused = async (alias: unknown, number: unknown, status: number) => {
    for (const run of [() => pulls.view(alias, number), () => pulls.merge(alias, number, HEAD)]) await assert.rejects(run, (e: unknown) => e instanceof PullError && e.status === status, `${String(alias)} ${String(number)}`);
  };
  // Not an alias ClearOps has: an owner/name, an address, another spelling, nothing at all.
  for (const alias of ["drpaulfarrow/clear-ops", "https://github.com/drpaulfarrow/clear-ops", "Self", "self ", "someone/else", "..", "", undefined, 7, {}]) await refused(alias, 12, 404);
  // Not a pull request's number.
  for (const number of ["0", "-1", "1.5", "12/files", "12?x=1", "1e3", " 12", "", undefined, 0, -3, 1.5, Number.NaN, {}]) await refused("self", number, 404);
  // A managed repository the service holds no credential for is not asked either.
  await refused("product", 4, 503);
  assert.equal(pull.calls.length, 0, "GitHub was never asked");
});

test("a job is tied to a pull request only inside its own repository, whatever owner its report wrote", () => {
  const s = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-app-pull-")));
  const pulls = newPulls();
  const of = (pr: string | undefined, target = "self") => pulls.forJob(prJob(s, pr, target));
  assert.deepEqual(of(SELF_PR), { repo: "self", number: 12, url: SELF_PR });
  assert.deepEqual(of("https://github.com/DrPaulFarrow/Clear-Ops/pull/12"), { repo: "self", number: 12, url: SELF_PR }, "case is not a difference");
  // 19 Nov 2026: a worker wrote dpaulfarrow for drpaulfarrow. Same repository name, so the owner is a slip.
  assert.deepEqual(of("https://github.com/dpaulfarrow/clear-ops/pull/108"), { repo: "self", number: 108, url: "https://github.com/drpaulfarrow/clear-ops/pull/108", wrote: "dpaulfarrow/clear-ops" });
  // Another repository's pull request is not the job's, wherever it is.
  for (const pr of ["https://github.com/drpaulfarrow/site/pull/3", "https://github.com/someone/else/pull/3", "https://github.com/drpaulfarrow/clear-ops/pull/12/files", "https://evil.example/drpaulfarrow/clear-ops/pull/12", "https://github.com/drpaulfarrow/clear-ops/pull/0", "#12", undefined]) assert.equal(of(pr), undefined, String(pr));
  assert.equal(of(SELF_PR, "site"), undefined, "a job on another repository");
  assert.equal(of(SELF_PR, "nowhere"), undefined, "a job on no managed repository");
  assert.equal(pull.calls.filter((c) => c.method !== "GET").length, 0);
});

test("a job reads from its own repository's pull request, and never waits on one GitHub does not have", () => {
  const s = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-app-pull-")));
  const pulls = newPulls();
  const real = "https://github.com/drpaulfarrow/clear-ops/pull/108";
  const slip = prJob(s, "https://github.com/dpaulfarrow/clear-ops/pull/108", "self", { reviewOnly: true, createdAt: iso(30) });
  const gone = prJob(s, "https://github.com/someone/else/pull/3", "self", { reviewOnly: true });
  const unasked = prJob(s, "https://github.com/someone/else/pull/4", "self", { reviewOnly: true });
  const asked: string[] = [];
  const source = {
    store: s,
    queue: quietQueue,
    now,
    jobPull: (job: Parameters<typeof pulls.forJob>[0]) => pulls.forJob(job),
    prState: (url: string) => (asked.push(url), url === real ? ({ state: "merged", openedAt: iso(600) } as const) : url.endsWith("/3") ? ({ state: "missing" } as const) : undefined),
  };
  const board = appBoard(source);
  const of = (id: string) => board.jobs.find((j) => j.id === id)!;
  // The mistyped owner: GitHub is asked about the real one, the card links to it, and it no longer waits on Paul.
  assert.ok(asked.includes(real) && !asked.some((u) => u.includes("dpaulfarrow")));
  assert.equal(of(slip.id).pr, real);
  assert.deepEqual(of(slip.id).outcome, { state: "unconfirmed", text: "The pull request it worked on was merged. Nothing here confirms this job's own part.", by: "nobody" });
  const detail = appJob(source, slip.id)!;
  assert.deepEqual([detail.pull, detail.actions.review, detail.links], [{ repo: "self", number: 108, wrote: "dpaulfarrow/clear-ops" }, true, [{ what: "pull request", url: real }]]);
  // An address GitHub does not have is not "open for you to review".
  assert.deepEqual(of(gone.id).outcome, { state: "unconfirmed", text: "GitHub does not show the pull request this job names, so nothing here can check it.", by: "nobody" });
  assert.equal(of(unasked.id).outcome!.state, "waiting", "until GitHub has answered it reads as before");
  const other = appJob(source, gone.id)!;
  assert.deepEqual([other.pull, other.actions.review], [undefined, false], "and there is no panel for a pull request outside the job's repository");
});

test("a merge is the commit Paul was shown, with nothing blocking it, and nothing else", async () => {
  const puts = () => pull.calls.filter((c) => c.method !== "GET");
  const blocked = async (set: () => void, words: RegExp) => {
    resetPull();
    set();
    const pulls = newPulls();
    assert.match((await pulls.view("self", 12)).blocked ?? "", words);
    await assert.rejects(() => pulls.merge("self", 12, HEAD), (e: unknown) => e instanceof PullError && /^Not merged\. /.test(e.message) && words.test(e.message));
    assert.equal(puts().length, 0, "nothing was sent to GitHub but reads");
  };
  await blocked(() => void (pull.pr = { ...pull.pr, state: "closed", merged: true }), /already merged/);
  await blocked(() => void (pull.pr = { ...pull.pr, state: "closed" }), /closed without being merged/);
  await blocked(() => void (pull.pr = { ...pull.pr, draft: true }), /draft/);
  await blocked(() => void (pull.pr = { ...pull.pr, mergeable: false }), /conflicts/);
  await blocked(() => void (pull.pr = { ...pull.pr, mergeable: null }), /still working out/);
  await blocked(() => void pull.checks.push({ name: "lint", status: "completed", conclusion: "failure" }), /A check failed: lint\./);
  await blocked(() => void pull.checks.push({ name: "slow", status: "in_progress", conclusion: null }), /still running/);

  // A commit he was not shown, or anything that is not a commit, is refused before GitHub is asked to merge.
  resetPull();
  const pulls = newPulls();
  await assert.rejects(() => pulls.merge("self", 12, "b".repeat(40)), /New commits were pushed since you looked/);
  for (const bad of [undefined, "", "main", HEAD.slice(0, 7), HEAD.toUpperCase(), { sha: HEAD }, `${HEAD} `]) await assert.rejects(() => pulls.merge("self", 12, bad), (e: unknown) => e instanceof PullError && e.status === 400);
  assert.equal(puts().length, 0);

  // The real thing: one PUT, naming that commit, as a merge commit. No branch is deleted, nothing else is written.
  pulls.open();
  await pulls.settled();
  assert.deepEqual(pulls.open().pulls.map((p) => p.number), [12, 9]);
  const done = await pulls.merge("self", "12", HEAD);
  assert.deepEqual(done, { text: "Merged pull request #12 on workforce from the app: Add the thing. The service redeploys once no job is running.", url: SELF_PR });
  assert.deepEqual(puts().map((c) => [c.method, c.url, c.body]), [["PUT", "https://api.github.com/repos/drpaulfarrow/clear-ops/pulls/12/merge", JSON.stringify({ sha: HEAD, merge_method: "merge" })]]);
  await assert.rejects(() => pulls.merge("self", 12, HEAD), /already merged/);
  // The list is read afresh after a merge, so the merged one leaves it.
  pull.list = pull.list.filter((p) => p.number !== 12);
  pulls.open();
  await pulls.settled();
  assert.deepEqual(pulls.open().pulls.map((p) => p.number), [9]);

  // GitHub's own refusal (branch protection, say) is passed on as said, and is not a merge.
  resetPull();
  pull.mergeAnswer = { status: 405, body: { message: "At least 1 approving review is required by reviewers with write access" } };
  await assert.rejects(() => newPulls().merge("self", 12, HEAD), /Not merged\. GitHub refused: At least 1 approving review is required by reviewers with write access\.$/);
  resetPull();
  pull.mergeAnswer = { status: 200, body: { merged: false } };
  await assert.rejects(() => newPulls().merge("self", 12, HEAD), /did not confirm/);

  // Two taps are one merge.
  resetPull();
  const twice = newPulls();
  const results = await Promise.allSettled([twice.merge("self", 12, HEAD), twice.merge("self", 12, HEAD)]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(puts().length, 1);
});

test("the app shows pull requests to Paul only, and merges on his own tap from this site's own script", async () => {
  resetPull();
  const cookie = await session();
  // The board lists what GitHub lists, once it has been read.
  await get(`${APP_PATH}/api/board`, cookie);
  await new Promise((r) => setTimeout(r, 60));
  const board = JSON.parse(await text(await get(`${APP_PATH}/api/board`, cookie))) as { pulls: Array<{ repo: string; number: number }>; pullsUnread: string[] };
  assert.deepEqual([board.pulls.map((p) => `${p.repo}#${p.number}`), board.pullsUnread], [["self#12", "self#9"], ["Clear Exchange"]]);
  const job = prJob(store, "https://github.com/dpaulfarrow/clear-ops/pull/12");
  const detail = JSON.parse(await text(await get(`${APP_PATH}/api/jobs/${job.id}`, cookie))) as { actions: { review: boolean }; pull?: unknown };
  assert.deepEqual([detail.actions.review, detail.pull], [true, { repo: "self", number: 12, wrote: "dpaulfarrow/clear-ops" }]);

  pull.calls.length = 0;
  assert.equal((await get(`${APP_PATH}/api/pulls/self/12`)).status, 401);
  assert.equal(pull.calls.length, 0);
  const shown = JSON.parse(await text(await get(`${APP_PATH}/api/pulls/self/12`, cookie))) as { head: string; title: string; blocked?: string };
  assert.deepEqual([shown.head, shown.title, shown.blocked], [HEAD, "Add the thing", undefined]);
  for (const p of ["/pulls/nowhere/12", "/pulls/self/0", "/pulls/self/abc", "/pulls/drpaulfarrow%2Fclear-ops/12", "/pulls/Self/12"]) assert.equal((await get(`${APP_PATH}/api${p}`, cookie)).status, 404, p);

  // Not signed in, another site's page, a form, a wrong commit: none of them merges.
  const merges = () => pull.calls.filter((c) => c.method === "PUT").length;
  assert.equal((await postApi("/pulls/self/12/merge", { sha: HEAD })).status, 401);
  assert.equal((await postApi("/pulls/self/12/merge", { sha: HEAD }, cookie, { origin: "https://evil.example" })).status, 403);
  assert.equal((await postApi("/pulls/self/12/merge", { sha: HEAD }, cookie, { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await fetch(`${base}${APP_PATH}/api/pulls/self/12/merge`, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: `sha=${HEAD}` })).status, 403);
  assert.equal((await postApi("/pulls/self/12/merge", {}, cookie)).status, 400);
  assert.equal((await postApi("/pulls/self/12/merge", { sha: "b".repeat(40) }, cookie)).status, 409);
  assert.equal((await postApi("/pulls/nowhere/12/merge", { sha: HEAD }, cookie)).status, 404);
  assert.equal((await postApi("/pulls/self/12/merge", { sha: HEAD, repo: "site", url: "https://github.com/someone/else/pull/1" }, cookie, { origin: "https://evil.example" })).status, 403);
  assert.equal(merges(), 0);

  // His tap: merged once, and said in the app's chat.
  const res = await postApi("/pulls/self/12/merge", { sha: HEAD }, cookie, { origin: "https://workforce.example", "sec-fetch-site": "same-origin" });
  const said = "Merged pull request #12 on workforce from the app: Add the thing. The service redeploys once no job is running.";
  assert.deepEqual([res.status, await res.json()], [200, { ok: true, text: said }]);
  assert.equal(merges(), 1);
  assert.deepEqual(pull.calls.filter((c) => c.method === "PUT").map((c) => c.url), ["https://api.github.com/repos/drpaulfarrow/clear-ops/pulls/12/merge"]);
  await settled();
  assert.ok((await chatView(cookie)).messages.some((m) => m.text === said || m.html?.includes("Merged pull request #12")));
  assert.equal((await postApi("/pulls/self/12/merge", { sha: HEAD }, cookie)).status, 409, "a second tap finds it already merged");
  assert.equal(merges(), 1);
});

test("the OAuth client never reaches a worker, a page or a cookie", async () => {
  const env = await workerGithubEnv({ UI_GITHUB_CLIENT_ID: "client-id", UI_GITHUB_CLIENT_SECRET: CLIENT_SECRET, PATH: "/usr/bin" });
  assert.equal(env.UI_GITHUB_CLIENT_SECRET, undefined);
  assert.equal(env.UI_GITHUB_CLIENT_ID, undefined);
  for (const body of bodies) {
    assert.ok(!body.includes(CLIENT_SECRET), "no response body holds the client secret");
    assert.ok(!body.includes(GITHUB_TOKEN), "no response body holds GitHub's token");
  }
  for (const c of cookies) assert.ok(!c.includes(CLIENT_SECRET) && !c.includes(GITHUB_TOKEN), "no cookie holds either");
});
