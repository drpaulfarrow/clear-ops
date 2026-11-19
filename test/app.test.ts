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
const { WebChat, routeWeb, webRefusal, WEB_SENDER, WEB_CONVERSATION, WEB_APPROVAL_REFUSAL, WEB_CODE_REFUSAL, WEB_CODE_PLACEHOLDER, WEB_KEEP, WEB_TEXT_MAX } = await import("../src/web-chat.js");
const { isAllowed } = await import("../src/config.js");
const { mintAppApproval, spendAppApproval, APP_APPROVER, APP_GRANT_MS } = await import("../src/app-approver.js");
const { DnsGate } = await import("../src/dns-gate.js");
const { OutboundGate } = await import("../src/outbound.js");
const { SignupGate } = await import("../src/signup-gate.js");
const { seenHash } = await import("../src/app-data.js");
const { PrStates, PR_STATE_CONCURRENCY } = await import("../src/pr-state.js");
const { AppPulls, PullError, PULL_FILES_MAX, PULL_PATCH_MAX, PULL_PATCHES_MAX } = await import("../src/app-pulls.js");
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
const runner: AgentRunner = async (o) => {
  if (chiefSays === undefined) throw new Error("the web app must not run any worker");
  chiefAsked.push(o.prompt);
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
};
function resetPull() {
  pull.calls.length = 0;
  pull.pr = { number: 12, title: "Add the thing", body: "Why.\r\n\r\nWhat changed.", state: "open", merged: false, draft: false, mergeable: true, commits: 2, additions: 5, deletions: 1, changed_files: 2, user: { login: "clear-ops-bot" }, head: { sha: HEAD, ref: "clear/thing" }, base: { ref: "main" } };
  pull.checks = [{ name: "test", status: "completed", conclusion: "success" }, { name: "deploy", status: "completed", conclusion: "skipped" }];
  pull.files = [{ filename: "src/thing.ts", status: "modified", additions: 5, deletions: 1, patch: "@@ -1 +1,5 @@\n-old\n+new" }, { filename: "docs/pic.png", status: "added", additions: 0, deletions: 0 }];
  pull.mergeAnswer = undefined;
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
  if (u.includes("/check-runs")) return json({ check_runs: pull.checks });
  if (u.includes("/files")) return json(pull.files);
  return json(pull.pr);
}) as typeof fetch;
const newPulls = () => new AppPulls({ slugOf: (job) => (job.target === "self" ? "drpaulfarrow/clear-ops" : job.target === "product" ? "Owner/Product" : undefined), token: (slug) => (slug.toLowerCase() === "owner/product" ? undefined : PULL_TOKEN), selfSlug: "drpaulfarrow/clear-ops", fetch: pullFetch });
const SELF_PR = "https://github.com/drpaulfarrow/clear-ops/pull/12";

function listen(a: InstanceType<typeof AppAuth>, s: InstanceType<typeof Store>, c: InstanceType<typeof WebChat> = new WebChat()) {
  const messenger = { send: async (to: string, text: string) => void elsewhere.push({ to, text }) };
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
  assert.deepEqual(board.spend, { usd: 12.5, note: "OpenRouter's own figure", capReached: false, capLifted: false });
  assert.deepEqual(board.jobs.map((j) => [j.title, j.status]), [["Running job", "running"], ["Queued job", "queued"], ["Estimate only", "done"], ["Real cost", "done"]]);
  assert.equal(board.hasOlder, true, "the job from three days ago is history, not the board");
  assert.equal(board.jobs.find((j) => j.id === real.id)!.costUsd, 3.184);
  assert.equal(board.jobs.find((j) => j.id === guess.id)!.costUsd, undefined);
  assert.equal(board.jobs.find((j) => j.id === running.id)!.costUsd, undefined);
  for (const estimate of ["7.77", "41.41", "9.99", "8.88"]) assert.ok(!raw.includes(estimate), `the estimate ${estimate} is nowhere in the answer`);
  assert.equal(board.jobs.find((j) => j.title === "Queued job")!.held, true);
  assert.deepEqual(board.waiting.map((w) => [w.what, w.id, w.command]), [["purchase", "p7k2", "buy p7k2"]], "a live approval is named; an expired one is not");
  assert.ok(!raw.includes("A shop name") && !raw.includes("a private item") && !raw.includes("£12.00"), "what waits is named, never described");

  const unread = appBoard({ store: s, queue: { ...quietQueue, spendState: () => ({ usd: 55.5, source: "estimate" as const, note: "OpenRouter could not be read" }) }, now });
  assert.equal(unread.spend.usd, undefined);
  assert.match(unread.spend.note, /No spend figure: OpenRouter could not be read/);
  assert.ok(!JSON.stringify(unread).includes("55.5"));

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

test("five things under /app are not a GET, and the data module never writes", () => {
  const index = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const appRoutes = index.slice(index.indexOf("const appAuthz ="), index.indexOf("return { app, orchestrator"));
  assert.deepEqual([...appRoutes.matchAll(/app\.(post|put|patch|delete)\(([^,]+),/g)].map((m) => `${m[1]} ${m[2]}`), ["post APP_SIGN_OUT_PATH", "post `${APP_PATH}/api/chat`", "post `${APP_PATH}/api/approvals`", "post `${APP_PATH}/api/jobs/:id/action`", "post `${APP_PATH}/api/jobs/:id/merge`"]);
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
  // Without the route's own flag, or in any other conversation, or with a file, it is an unlisted sender.
  await orchestrator.handle(WEB_SENDER, "hello", { replyTo: WEB_CONVERSATION });
  await orchestrator.handle(WEB_SENDER, "hello", { replyTo: "web:other", web: true });
  await orchestrator.handle(WEB_SENDER, "hello", { web: true });
  await orchestrator.handle("web:someone", "hello", { replyTo: WEB_CONVERSATION, web: true });
  await orchestrator.handle(WEB_SENDER, "hello", { replyTo: WEB_CONVERSATION, web: true, attachments: [{ name: "a.txt" } as never] });
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

/* ---------- A job's pull request: review and merge ---------- */

const prJob = (s: InstanceType<typeof Store>, pr: string | undefined, target = "self") =>
  s.updateJob(s.createJob("engineer", "Add the thing.", PAUL, target as never, PAUL, { title: "Add the thing" } as never).id, { status: "done", finishedAt: iso(5), ...(pr ? { pr } : {}) } as never);

test("a pull request is shown as GitHub holds it: read-only, cut to size, with nothing secret in it", async () => {
  resetPull();
  const s = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-app-pull-")));
  const pulls = newPulls();
  pull.pr = { ...pull.pr, title: "Add the thing ghp_abcdefghijklmnopqrstuvwxyz0123456789", body: `Line one.\r\n\r\n${"x".repeat(7000)}` };
  pull.files = [
    { filename: "src/thing.ts", status: "modified", additions: 5, deletions: 1, patch: `@@ -1 +1 @@\n+const key = "sk-live-abcdefghijklmnopqrstuvwxyz";\n${"+y\n".repeat(10_000)}` },
    ...Array.from({ length: 120 }, (_, i) => ({ filename: `src/f${i}.ts`, status: "added", additions: 1, deletions: 0, patch: `+${"z".repeat(5000)}` })),
  ];
  const v = await pulls.view(prJob(s, SELF_PR));
  assert.deepEqual({ url: v.url, repository: v.repository, number: v.number, author: v.author, state: v.state, draft: v.draft, head: v.head, branch: v.branch, base: v.base, commits: v.commits, redeploys: v.redeploys, blocked: v.blocked }, { url: SELF_PR, repository: "drpaulfarrow/clear-ops", number: 12, author: "clear-ops-bot", state: "open", draft: false, head: HEAD, branch: "clear/thing", base: "main", commits: 2, redeploys: true, blocked: undefined });
  assert.deepEqual(v.checks, [{ name: "test", state: "passed" }, { name: "deploy", state: "skipped" }]);
  assert.ok(!JSON.stringify(v).includes("ghp_") && !JSON.stringify(v).includes("sk-live-"), "tokens in a title or a diff are redacted");
  assert.ok(v.body!.startsWith("Line one.\n\nxxx") && v.body!.length <= 6001, "the description keeps its line breaks and is cut");
  assert.equal(v.files.length, PULL_FILES_MAX);
  assert.ok(v.files[0]!.patch!.length <= PULL_PATCH_MAX && v.files[0]!.cut === true);
  assert.ok(v.files.reduce((n, f) => n + (f.patch?.length ?? 0), 0) <= PULL_PATCHES_MAX, "all the changes together are capped");
  // Three reads, all GETs to GitHub's own API for that repository, with the credential in a header.
  assert.deepEqual(pull.calls.map((c) => `${c.method} ${c.url}`).sort(), [
    `GET https://api.github.com/repos/drpaulfarrow/clear-ops/commits/${HEAD}/check-runs?per_page=100`,
    "GET https://api.github.com/repos/drpaulfarrow/clear-ops/pulls/12",
    `GET https://api.github.com/repos/drpaulfarrow/clear-ops/pulls/12/files?per_page=${PULL_FILES_MAX}`,
  ]);
  assert.ok(pull.calls.every((c) => c.auth === `Bearer ${PULL_TOKEN}` && !c.url.includes(PULL_TOKEN)));
  assert.ok(!JSON.stringify(v).includes(PULL_TOKEN));
});

test("only a job's own pull request in the job's own repository is ever asked about", async () => {
  resetPull();
  const s = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-app-pull-")));
  const pulls = newPulls();
  const refusedBefore = async (job: ReturnType<typeof prJob>, status: number) => {
    for (const run of [() => pulls.view(job), () => pulls.merge(job, HEAD)]) await assert.rejects(run, (e: unknown) => e instanceof PullError && e.status === status);
  };
  // A job's `pr` is often a model's words, read from its report: an address anywhere else goes nowhere.
  await refusedBefore(prJob(s, "https://github.com/someone/else/pull/3"), 404);
  await refusedBefore(prJob(s, SELF_PR, "site"), 404);
  await refusedBefore(prJob(s, "https://github.com/drpaulfarrow/clear-ops/pull/12/files"), 404);
  await refusedBefore(prJob(s, "https://evil.example/drpaulfarrow/clear-ops/pull/12"), 404);
  await refusedBefore(prJob(s, "#12"), 404);
  await refusedBefore(prJob(s, undefined), 404);
  // A repository the service holds no credential for is not asked either.
  await refusedBefore(prJob(s, "https://github.com/owner/product/pull/4", "product"), 503);
  assert.equal(pull.calls.length, 0, "GitHub was never asked");
});

test("a merge is the commit Paul was shown, with nothing blocking it, and nothing else", async () => {
  const s = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-app-pull-")));
  const job = prJob(s, SELF_PR);
  const puts = () => pull.calls.filter((c) => c.method !== "GET");
  const blocked = async (set: () => void, words: RegExp) => {
    resetPull();
    set();
    const pulls = newPulls();
    assert.match((await pulls.view(job)).blocked ?? "", words);
    await assert.rejects(() => pulls.merge(job, HEAD), (e: unknown) => e instanceof PullError && /^Not merged\. /.test(e.message) && words.test(e.message));
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
  await assert.rejects(() => pulls.merge(job, "b".repeat(40)), /New commits were pushed since you looked/);
  for (const bad of [undefined, "", "main", HEAD.slice(0, 7), HEAD.toUpperCase(), { sha: HEAD }, `${HEAD} `]) await assert.rejects(() => pulls.merge(job, bad), (e: unknown) => e instanceof PullError && e.status === 400);
  assert.equal(puts().length, 0);

  // The real thing: one PUT, naming that commit, as a merge commit. No branch is deleted, nothing else is written.
  const done = await pulls.merge(job, HEAD);
  assert.deepEqual(done, { text: "Merged pull request #12 on clear-ops from the app: Add the thing. The service redeploys once no job is running.", url: SELF_PR });
  assert.deepEqual(puts().map((c) => [c.method, c.url, c.body]), [["PUT", "https://api.github.com/repos/drpaulfarrow/clear-ops/pulls/12/merge", JSON.stringify({ sha: HEAD, merge_method: "merge" })]]);
  await assert.rejects(() => pulls.merge(job, HEAD), /already merged/);

  // GitHub's own refusal (branch protection, say) is passed on as said, and is not a merge.
  resetPull();
  pull.mergeAnswer = { status: 405, body: { message: "At least 1 approving review is required by reviewers with write access" } };
  await assert.rejects(() => newPulls().merge(job, HEAD), /Not merged\. GitHub refused: At least 1 approving review is required by reviewers with write access\.$/);
  resetPull();
  pull.mergeAnswer = { status: 200, body: { merged: false } };
  await assert.rejects(() => newPulls().merge(job, HEAD), /did not confirm/);

  // Two taps are one merge.
  resetPull();
  const twice = newPulls();
  const results = await Promise.allSettled([twice.merge(job, HEAD), twice.merge(job, HEAD)]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  assert.equal(puts().length, 1);
});

test("the app shows a pull request to Paul only, and merges on his own tap from this site's own script", async () => {
  resetPull();
  const cookie = await session();
  const job = prJob(store, SELF_PR);
  store.updateJob(job.id, { replyTo: PAUL });
  const detail = JSON.parse(await text(await get(`${APP_PATH}/api/jobs/${job.id}`, cookie))) as { actions: { review: boolean } };
  assert.equal(detail.actions.review, true);

  assert.equal((await get(`${APP_PATH}/api/jobs/${job.id}/pull`)).status, 401);
  assert.equal(pull.calls.length, 0);
  const shown = JSON.parse(await text(await get(`${APP_PATH}/api/jobs/${job.id}/pull`, cookie))) as { head: string; title: string; blocked?: string };
  assert.deepEqual([shown.head, shown.title, shown.blocked], [HEAD, "Add the thing", undefined]);
  assert.equal((await get(`${APP_PATH}/api/jobs/nope/pull`, cookie)).status, 404);
  assert.equal((await get(`${APP_PATH}/api/jobs/${prJob(store, "https://github.com/someone/else/pull/3").id}/pull`, cookie)).status, 404);

  // Not signed in, another site's page, a form, a wrong commit: none of them merges.
  const merges = () => pull.calls.filter((c) => c.method === "PUT").length;
  assert.equal((await postApi(`/jobs/${job.id}/merge`, { sha: HEAD })).status, 401);
  assert.equal((await postApi(`/jobs/${job.id}/merge`, { sha: HEAD }, cookie, { origin: "https://evil.example" })).status, 403);
  assert.equal((await postApi(`/jobs/${job.id}/merge`, { sha: HEAD }, cookie, { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await fetch(`${base}${APP_PATH}/api/jobs/${job.id}/merge`, { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: `sha=${HEAD}` })).status, 403);
  assert.equal((await postApi(`/jobs/${job.id}/merge`, {}, cookie)).status, 400);
  assert.equal((await postApi(`/jobs/${job.id}/merge`, { sha: "b".repeat(40) }, cookie)).status, 409);
  assert.equal((await postApi("/jobs/nope/merge", { sha: HEAD }, cookie)).status, 404);
  assert.equal(merges(), 0);

  // His tap: merged once, and said in the app's chat and where the job began.
  elsewhere.length = 0;
  const res = await postApi(`/jobs/${job.id}/merge`, { sha: HEAD }, cookie, { origin: "https://workforce.example", "sec-fetch-site": "same-origin" });
  const said = "Merged pull request #12 on clear-ops from the app: Add the thing. The service redeploys once no job is running.";
  assert.deepEqual([res.status, await res.json()], [200, { ok: true, text: said }]);
  assert.equal(merges(), 1);
  await settled();
  assert.ok((await chatView(cookie)).messages.some((m) => m.text === said || m.html?.includes("Merged pull request #12")));
  assert.deepEqual(elsewhere.filter((m) => m.text === said).map((m) => m.to), [PAUL]);
  assert.equal((await postApi(`/jobs/${job.id}/merge`, { sha: HEAD }, cookie)).status, 409, "a second tap finds it already merged");
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
