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
const { appBoard, appHistory, appJob, APP_HISTORY_PAGE } = await import("../src/app-data.js");
const { appAsset, APP_CSP } = await import("../src/app-pages.js");
const { workerGithubEnv } = await import("../src/github-auth.js");
const { tracesDir } = await import("../src/trace.js");
const { ConsoleMessenger } = await import("../src/whatsapp.js");
import type { AgentRunner } from "../src/agents.js";
import type { Scheduler } from "../src/scheduler.js";

const PAUL = "tg:99887766";
const CLIENT_SECRET = "client-secret-that-must-never-leave";
const GITHUB_TOKEN = "gho_tokenThatMustNeverBeKept123456";

const runner: AgentRunner = async () => {
  throw new Error("the web app must not run any worker");
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
const session = async () => pair(cookieNamed(await signInAs({ login: "drpaulfarrow", id: 4242 }), APP_SESSION_COOKIE));

function listen(a: InstanceType<typeof AppAuth>, s: InstanceType<typeof Store>) {
  const built = buildApp({ messenger: new ConsoleMessenger(), runner, store: s, appAuth: a });
  return new Promise<{ server: import("node:http").Server; base: string; scheduler: Scheduler }>((resolve) => {
    const srv = built.app.listen(0, () => resolve({ server: srv, base: `http://127.0.0.1:${(srv.address() as import("node:net").AddressInfo).port}`, scheduler: built.scheduler }));
  });
}

before(async () => {
  store = new Store(process.env.DATA_DIR!);
  auth = new AppAuth({ clientId: "client-id", clientSecret: CLIENT_SECRET, login: "drpaulfarrow", publicUrl: "https://workforce.example", fetch: fakeGithub, now: () => now });
  ({ server, base, scheduler } = await listen(auth, store));
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
  assert.equal((js.match(/innerHTML/g) ?? []).length, 1, "one place sets HTML: the report the service already rendered and escaped");
  assert.equal((js.match(/method: "post"/g) ?? []).length, 1, "the one form is sign-out");
  assert.doesNotMatch(js, /method:\s*"(POST|PUT|PATCH|DELETE)"/, "every request the script makes is a GET");
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

test("the app only reads: one POST under /app, and the data module never writes", () => {
  const index = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const appRoutes = index.slice(index.indexOf("const appAuthz ="), index.indexOf("return { app, orchestrator"));
  assert.deepEqual([...appRoutes.matchAll(/app\.(post|put|patch|delete)\(([^,]+),/g)].map((m) => `${m[1]} ${m[2]}`), ["post APP_SIGN_OUT_PATH"]);
  assert.match(appRoutes, /if \(!under\(req\.path, APP_PATH\) \|\| APP_OPEN\.some/, "one gate over everything under /app");
  const data = fs.readFileSync(new URL("../src/app-data.ts", import.meta.url), "utf8");
  assert.doesNotMatch(data, /\.(updateJob|createJob|importJob|setSetting|setCapDays|setQueueHold|writeOutput|put[A-Z]\w*|update[A-Z]\w*|create[A-Z]\w*|disableSchedule|addNote)\(/);
  assert.doesNotMatch(data, /job\.costUsd/, "the SDK's estimate is never read for display");
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
