/**
 * The sign-in that stands in front of the service's browser pages (the reports view and the jobs board).
 *
 * No network and no model: the pages read the store, so the fake runner fails the test if it is ever
 * called. The tests are about what the gate must never do as much as what it does: the password is
 * never stored or logged in the clear, a wrong one fails and a right one signs in, attempts are rate
 * limited with a short cool-off that never becomes a lock-out, a session cookie is refused when it is
 * tampered with, expired or minted before the password changed, an unsigned-in visit to either view
 * gets the sign-in page (never a 404 and never the content), and nothing in any response body or log
 * line ever holds the password.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-sign-in-"));
process.env.PUBLIC_URL = "https://workforce.example";

const { Store } = await import("../src/store.js");
const { buildApp } = await import("../src/index.js");
const { SignIn, SignInError, SIGN_IN_PATH, SIGN_OUT_PATH, PASSWORD_PATH, PASSWORD_LINK_MINUTES, SESSION_COOKIE, SESSION_DAYS, MIN_PASSWORD_LENGTH, SIGN_IN_MAX_FAILURES, SIGN_IN_COOL_OFF_MS, noPasswordPage } = await import("../src/sign-in.js");
const { BOARD_PATH, boardToken } = await import("../src/jobs-board.js");
import type { AgentRunner } from "../src/agents.js";
import type { Scheduler } from "../src/scheduler.js";

const PAUL = "tg:99887766";
const PASSWORD = "correct horse battery staple 42!";
const OTHER = "a different password entirely";

/** The gate only reads the store, so any worker run here is a bug. */
const runner: AgentRunner = async () => {
  throw new Error("the sign-in must not run any worker");
};

const sent: string[] = [];
const messenger = { send: async (_to: string, text: string) => void sent.push(text) } as any;

/** A clock the whole test can walk forward, so a cool-off and an expiry are checked without waiting. */
const BASE = Date.UTC(2026, 10, 14, 9, 0, 0);
let now = BASE;
/** Every delay the rate limiter asked for, so the growing pause is visible without slowing the test. */
const waits: number[] = [];
const fakeSleep = async (ms: number) => void waits.push(ms);

let store: InstanceType<typeof Store>;
let signIn: InstanceType<typeof SignIn>;
let scheduler: Scheduler;
let server: import("node:http").Server;
let base: string;
/** Every response body this file has seen, checked at the end for the password. */
const bodies: string[] = [];

const get = (p: string, cookie?: string) => fetch(`${base}${p}`, { redirect: "manual", headers: cookie ? { cookie } : {} });
const post = (p: string, body: Record<string, string>) =>
  fetch(`${base}${p}`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });
const text = async (res: Response) => {
  const body = await res.text();
  bodies.push(body);
  return body;
};
/** The session cookie out of a response, and the name=value pair to send back. */
const cookieOf = (res: Response) => res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? "";
const pair = (setCookie: string) => setCookie.split(";")[0];
/** A signed-in session cookie, minted through the real sign-in route. */
const signedCookie = async () => pair(cookieOf(await post(SIGN_IN_PATH, { password: PASSWORD })));

before(async () => {
  store = new Store(process.env.DATA_DIR!);
  signIn = new SignIn(() => now, fakeSleep);
  const built = buildApp({ messenger, runner, store, signIn });
  scheduler = built.scheduler;
  await new Promise<void>((r) => (server = built.app.listen(0, r)));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => {
  scheduler.stopAll();
  server.close();
});

/** The reports view's path and token, taken from the module that serves it, as src/index.ts's gate does. */
const { REPORTS_PATH, reportsToken } = await import("../src/reports.js");

/**
 * Every browser view the sign-in covers, with words that must never come back to a stranger. Both
 * views' own routes are covered in full, with a session, by test/jobs-board.test.ts and
 * test/reports.test.ts; this file is about the gate in front of them.
 */
const views = () => [
  { name: "the jobs board", url: `${BOARD_PATH}?t=${boardToken(store)}`, content: ["Workforce jobs", "Nothing running"] },
  { name: "the reports view", url: `${REPORTS_PATH}?t=not-a-real-token`, content: ["Saved reports", "<h1>Reports</h1>"] },
];

/* ---------- The password itself ---------- */

test("only a salted hash is kept: the password is never stored, and the link's own rules hold", () => {
  assert.ok(!signIn.hasPassword(store), "nothing is set until Paul sets it");
  assert.equal(signIn.sessionCookie(store), undefined, "and no session can be minted before then");
  assert.ok(!signIn.checkPassword(store, ""));

  assert.throws(() => signIn.setPassword(store, "short"), SignInError, "a password under the minimum is refused");
  const url = signIn.link(store, PAUL);
  assert.match(url, new RegExp(`^https://workforce\\.example${PASSWORD_PATH}\\?t=[A-Za-z0-9_-]{20,}$`), "a one-time link on the service's own public address");
  const token = new URL(url).searchParams.get("t")!;
  assert.ok(signIn.peek(token));

  assert.throws(() => signIn.setFromLink(store, token, PASSWORD, OTHER), /not the same/, "two different passwords are refused");
  assert.ok(signIn.peek(token), "and the link is not spent by a mistake");
  assert.ok(!signIn.hasPassword(store), "nothing was written");

  const r = signIn.setFromLink(store, token, PASSWORD, PASSWORD);
  assert.equal(r.replyTo, PAUL, "the confirmation goes back to the chat that asked");
  assert.ok(!signIn.peek(token), "the link works once");
  assert.throws(() => signIn.setFromLink(store, token, OTHER, OTHER), /expired or was already used/);

  assert.ok(signIn.checkPassword(store, PASSWORD));
  assert.ok(!signIn.checkPassword(store, OTHER));
  assert.ok(!signIn.checkPassword(store, `${PASSWORD} `), "it is compared exactly, in constant time");

  // What is on disk: a salt and a hash, and never the password itself, in any file of the store.
  const saved = store.settings().pagePassword!;
  assert.ok(saved.salt.length >= 16 && saved.hash.length >= 16, "a random salt and a scrypt hash");
  assert.notEqual(saved.hash, PASSWORD);
  assert.match(store.settings().pageSessionKey!, /^[A-Za-z0-9_-]{40,}$/, "the service's own signing key, kept so a restart does not sign him out");
  for (const f of fs.readdirSync(store.dir)) {
    const p = path.join(store.dir, f);
    if (!fs.statSync(p).isFile()) continue;
    assert.ok(!fs.readFileSync(p, "utf8").includes(PASSWORD), `${f} must not hold the password`);
  }

  // A fresh salt and hash on every change, so two settings of the same password do not look alike.
  const first = { ...saved };
  signIn.setPassword(store, PASSWORD);
  assert.notEqual(store.settings().pagePassword!.salt, first.salt);
  assert.ok(signIn.checkPassword(store, PASSWORD));
});

test("the sign-in page is one password field, POST only, in the house style, with no script", async () => {
  const res = await get(SIGN_IN_PATH);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  assert.match(res.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.equal(res.headers.get("content-security-policy"), "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
  const html = await text(res);
  assert.match(html, /name="viewport" content="width=device-width/, "laid out for a phone");
  assert.match(html, /<h1>Sign in<\/h1>/);
  assert.match(html, /Your saved reports and the jobs board are behind this password\./, "one plain sentence on what it unlocks");
  assert.match(html, /<form method="post" action="\/sign-in"/, "POST only, and the password never rides in the URL");
  assert.match(html, /max-width:26rem/, "the same narrow centred column as the vault's pages");
  assert.match(html, /type="password"/, "the password is masked");
  assert.equal((html.match(/name="password"/g) ?? []).length, 1, "one password field");
  assert.doesNotMatch(html, /<script/i, "no JavaScript");
  assert.doesNotMatch(html, /\ssrc=|<link /i, "nothing is loaded from anywhere");
  assert.ok(!html.includes(PASSWORD));
});

/* ---------- Set through the one-time link ---------- */

test("the password is set only through the one-time link: a wrong, used or expired one is refused", async () => {
  // Before a password exists there is no form at all: the page only says how to get one.
  const fresh = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-sign-in-fresh-")));
  assert.ok(!signIn.hasPassword(fresh), "nothing is set in a fresh install");
  const none = noPasswordPage();
  assert.match(none, /Send \/password in chat/);
  assert.doesNotMatch(none, /<form/i, "no form to guess at before a password exists");

  assert.equal((await get(PASSWORD_PATH)).status, 410, "no link, no page");
  const wrong = await get(`${PASSWORD_PATH}?t=not-the-token`);
  assert.equal(wrong.status, 410);
  const wrongHtml = await text(wrong);
  assert.match(wrongHtml, /Link expired/);
  assert.doesNotMatch(wrongHtml, /not-the-token/, "nothing about the token is echoed");
  assert.equal((await post(PASSWORD_PATH, { t: "not-the-token", password: PASSWORD, confirm: PASSWORD })).status, 410);

  const expired = new URL(signIn.link(store, PAUL)).searchParams.get("t")!;
  now += (PASSWORD_LINK_MINUTES + 1) * 60_000;
  assert.equal((await get(`${PASSWORD_PATH}?t=${expired}`)).status, 410, "an expired link is gone");
  now = BASE;

  const token = new URL(signIn.link(store, PAUL)).searchParams.get("t")!;
  const form = await get(`${PASSWORD_PATH}?t=${token}`);
  assert.equal(form.status, 200);
  const html = await text(form);
  assert.match(html, /<h1>Set a password<\/h1>/);
  assert.equal((html.match(/type="password"/g) ?? []).length, 2, "the password twice, and nothing else");
  assert.match(html, new RegExp(`At least ${MIN_PASSWORD_LENGTH} characters`));
  assert.match(html, new RegExp(`expires ${PASSWORD_LINK_MINUTES} minutes`), "the page says how long the link lasts");
  assert.match(html, /<input type="hidden" name="t" value=/, "the token rides in a hidden field, never in a URL that could be logged");
  assert.doesNotMatch(html, /<script/i);

  // Too short: the page says so, and the link still works.
  const before = sent.length;
  const short = await post(PASSWORD_PATH, { t: token, password: "short", confirm: "short" });
  assert.equal(short.status, 400);
  const shortHtml = await text(short);
  assert.match(shortHtml, new RegExp(`at least ${MIN_PASSWORD_LENGTH} characters`));
  assert.ok(!shortHtml.includes("short"), "nothing typed is echoed back raw");
  assert.equal(sent.length, before, "and nothing is said in chat");

  // The two do not match: also refused, and the link is still good.
  assert.equal((await post(PASSWORD_PATH, { t: token, password: PASSWORD, confirm: OTHER })).status, 400);
  assert.ok(signIn.peek(token));

  const ok = await post(PASSWORD_PATH, { t: token, password: PASSWORD, confirm: PASSWORD });
  assert.equal(ok.status, 200);
  const okHtml = await text(ok);
  assert.match(okHtml, /<h1>Password saved<\/h1>/);
  assert.match(okHtml, /Every device that was signed in with the old password is now signed out\./, "the page says what changed");
  assert.ok(!okHtml.includes(PASSWORD), "and never the password");
  assert.equal(sent.length, before + 1, "and Paul is told in chat");
  assert.match(sent[sent.length - 1], /every device that was signed in with the old password has been signed out/);
  assert.ok(!sent[sent.length - 1].includes(PASSWORD), "never in the chat message either");

  // The link is spent: the form and the POST both refuse it now, and the password did not change.
  assert.equal((await get(`${PASSWORD_PATH}?t=${token}`)).status, 410);
  assert.equal((await post(PASSWORD_PATH, { t: token, password: OTHER, confirm: OTHER })).status, 410);
  assert.ok(signIn.checkPassword(store, PASSWORD));
});

/* ---------- Signing in ---------- */

test("a wrong password fails and a right one signs in, on a cookie that is signed and scoped", async () => {
  waits.length = 0;
  const before = sent.length;
  const wrong = await post(SIGN_IN_PATH, { password: OTHER });
  assert.equal(wrong.status, 401);
  assert.equal(cookieOf(wrong), "", "a wrong password sets no cookie");
  const wrongHtml = await text(wrong);
  assert.match(wrongHtml, /That is not the password\./);
  assert.ok(!wrongHtml.includes(OTHER), "nothing typed is echoed back");
  assert.ok(!wrongHtml.includes(PASSWORD), "nor the stored one");
  assert.equal(waits.length, 1, "the answer was held back a little");
  assert.ok(waits[0] > 0 && waits[0] < SIGN_IN_COOL_OFF_MS, "a small delay, not a long one");
  assert.equal(sent.length, before, "nothing is said in chat about a failed attempt");

  const ok = await post(SIGN_IN_PATH, { password: PASSWORD });
  assert.equal(ok.status, 303, "a signed-in visit is sent on");
  const cookie = cookieOf(ok);
  assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_.-]+;`));
  assert.match(cookie, /HttpOnly/, "the page's own script could never read it");
  assert.match(cookie, /Secure/, "never sent over plain http");
  assert.match(cookie, /SameSite=Strict/, "never sent from another site");
  assert.match(cookie, /Path=\//);
  assert.match(cookie, new RegExp(`Max-Age=${SESSION_DAYS * 24 * 60 * 60}\\b`), "a long life, so his phone stays signed in");
  const value = pair(cookie).slice(`${SESSION_COOKIE}=`.length);
  assert.ok(!value.includes(PASSWORD) && !value.includes("paul"), "the cookie holds nothing personal and nothing readable");
  assert.equal(value.split(".").length, 3, "just when it was issued and a signature");

  // What it opens, and what is refused without it.
  const token = boardToken(store);
  const withCookie = await get(`${BOARD_PATH}?t=${token}`, pair(cookie));
  assert.equal(withCookie.status, 200);
  assert.match(await text(withCookie), /Workforce jobs/);
  assert.equal((await get(`${BOARD_PATH}?t=${token}`)).status, 303, "the token alone is not enough");
});

test("an unsigned-in visit to a view gets the sign-in page and none of the content", async () => {
  for (const view of views()) {
    const res = await get(view.url);
    assert.equal(res.status, 303, `${view.name} is not served to a stranger`);
    const location = res.headers.get("location") ?? "";
    assert.equal(location, `${SIGN_IN_PATH}?next=${encodeURIComponent(view.url)}`, "sent to the sign-in page, remembering the page he asked for");

    const followed = await get(location);
    assert.equal(followed.status, 200);
    const html = await text(followed);
    assert.match(html, /<h1>Sign in<\/h1>/, `${view.name}: the sign-in page, not a 404`);
    assert.ok(!html.includes("Not found"), "not a 404");
    assert.ok(!html.includes("That link is not valid"), "and not the refusal page either");
    for (const content of view.content) assert.ok(!html.includes(content), `no part of ${view.name} comes back: ${content}`);
  }
});

test("every gated path is under the same gate, index and one item alike", async () => {
  // Both views' routes are in main now (src/reports.ts and src/jobs-board.ts), each at its own path taken
  // from the module that serves it; the gate covers the index and one item with the same rule.
  for (const p of [`${REPORTS_PATH}?t=x`, `${REPORTS_PATH}/abc?t=x`, `${BOARD_PATH}?t=x`, `${BOARD_PATH}/anything`]) {
    const res = await get(p);
    assert.equal(res.status, 303, `${p} is not served to a stranger`);
    assert.equal(res.headers.get("location"), `${SIGN_IN_PATH}?next=${encodeURIComponent(p)}`);
  }
  // And what is not a browser view is not gated: the sign-in pages themselves, the one-time password
  // page, the health check and a path that merely starts with a gated one (`/jobshere` is not `/jobs`)
  // all answer a stranger rather than sending him round the sign-in.
  for (const p of ["/health", "/sign-in", "/password", "/jobshere", `${BOARD_PATH}x`]) {
    const res = await get(p);
    assert.ok(!(res.headers.get("location") ?? "").startsWith(`${SIGN_IN_PATH}?next=`), `${p} must not be behind the gate`);
  }
  // Signed in, the gate lets the request through and the route decides: a wrong token is the service's
  // own 404, not a redirect to the sign-in page.
  const signed = await signedCookie();
  assert.equal((await get(`${REPORTS_PATH}?t=x`, signed)).status, 404);
});

test("a gated path is gated whatever its case, because the routes answer any case", async () => {
  // Express matches route paths case-insensitively (`case sensitive routing` is off), so `GET /Jobs`
  // reaches the board's route. The gate has to match the same way or the token in a forwarded link is
  // enough on its own. This is the bypass the maintainer reproduced: `/Jobs?t=<token>` served the board.
  const token = boardToken(store);
  for (const p of [`/Jobs?t=${token}`, `/JOBS?t=${token}`, `/jObS?format=json&t=${token}`, `/Reports?t=x`, `/REPORTS`, `${REPORTS_PATH.toUpperCase()}/abc?t=x`]) {
    const res = await get(p);
    assert.equal(res.status, 303, `${p} is not served to a stranger`);
    assert.equal(res.headers.get("location"), `${SIGN_IN_PATH}?next=${encodeURIComponent(p)}`, `${p}: sent to the sign-in page`);
  }
  // Signed in, the same differently-cased path does serve the page (the route is case-insensitive), which
  // is exactly why the gate above must be too; the sign-in still has to run first for a stranger.
  const signed = await signedCookie();
  assert.equal((await get(`/Jobs?t=${token}`, signed)).status, 200, "signed in, the board answers /Jobs");
  assert.match(await text(await get(`/Jobs?t=${token}`, signed)), /Workforce jobs/);
  assert.equal((await get(`/JOBS?t=${token}`, signed)).status, 200, "and /JOBS");
  assert.equal((await get(`/reports?t=${reportsToken(store)}`, signed)).status, 200, "and the reports index");
});

test("signing in from a bookmarked link lands on the page he asked for, and the token still has to match", async () => {
  const token = boardToken(store);
  const next = `${BOARD_PATH}?t=${token}`;
  const res = await post(SIGN_IN_PATH, { password: PASSWORD, next });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), next, "straight to what he asked for");
  const signed = pair(cookieOf(res));
  assert.equal((await get(next, signed)).status, 200);
  assert.equal((await get(`${BOARD_PATH}?t=wrong`, signed)).status, 404, "signed in, a wrong token is still refused");

  // A next that leaves this service, or names a page that is not gated, is ignored.
  for (const bad of ["https://example.com/", "//example.com/", "/sign-out", "/health", "/jobs/../../state.json", "/jobs\n?x", "/jobs?t=x&y="]) {
    const r = await post(SIGN_IN_PATH, { password: PASSWORD, next: bad });
    assert.equal(r.status, 303);
    assert.match(r.headers.get("location") ?? "", new RegExp(`^${BOARD_PATH}\\?t=`), `${JSON.stringify(bad)} must not be followed`);
  }
  // A climb hidden in percent-encoding: a browser resolves `%2e%2e` as a dot segment, so `/jobs/%2e%2e/...`
  // would leave the page even though the literal `..` check passes. Each must land on the plain board, not
  // on the crafted path.
  const home = `${BOARD_PATH}?t=${token}`;
  for (const bad of ["/jobs/%2e%2e/%2e%2e/evil", "/jobs/%2E%2E/x", `${REPORTS_PATH}/%2e%2e/%2e%2e/evil`, "/jobs/%2e%2e%2f%2e%2e%2fevil", "/jobs/%5c..%5cx"]) {
    const r = await post(SIGN_IN_PATH, { password: PASSWORD, next: bad });
    assert.equal(r.status, 303);
    assert.equal(r.headers.get("location"), home, `${JSON.stringify(bad)} must not be followed`);
  }
  // A gated page, with the token in the query, is kept as it was, index and one item alike.
  const kept = `${BOARD_PATH}?t=${token}&format=json`;
  assert.equal((await post(SIGN_IN_PATH, { password: PASSWORD, next: kept })).headers.get("location"), kept);
  const oneReport = `${REPORTS_PATH}/abc123?t=${token}`;
  assert.equal((await post(SIGN_IN_PATH, { password: PASSWORD, next: oneReport })).headers.get("location"), oneReport);
});

test("an already signed-in visit to the sign-in page is sent on rather than asked again", async () => {
  const signed = await signedCookie();
  const plain = await get(SIGN_IN_PATH, signed);
  assert.equal(plain.status, 303);
  assert.match(plain.headers.get("location") ?? "", new RegExp(`^${BOARD_PATH}\\?t=`), "to the page he has bookmarked");
  const next = `${BOARD_PATH}?t=${boardToken(store)}`;
  assert.equal((await get(`${SIGN_IN_PATH}?next=${encodeURIComponent(next)}`, signed)).headers.get("location"), next);
  assert.equal((await get(SIGN_IN_PATH)).status, 200, "and a stranger still gets the form");
});

test("sign out clears the session, and only when the request carried one", async () => {
  const signed = await signedCookie();
  const out = await get(SIGN_OUT_PATH, signed);
  assert.equal(out.status, 303);
  assert.equal(out.headers.get("location"), SIGN_IN_PATH);
  const cleared = cookieOf(out);
  assert.match(cleared, /Max-Age=0/, "the cookie is expired");
  assert.match(cleared, /HttpOnly/);
  assert.match(cleared, new RegExp(`^${SESSION_COOKIE}=;`));
  // A request with no session (an image or a link on another site sends no cookie under SameSite=Strict)
  // clears nothing.
  const stranger = await get(SIGN_OUT_PATH);
  assert.equal(stranger.status, 303);
  assert.equal(cookieOf(stranger), "", "nothing to clear, nothing set");
});

/* ---------- The session cookie itself ---------- */

test("a session cookie is refused when it is tampered with, expired, or minted before the password changed", async () => {
  const view = `${BOARD_PATH}?t=${boardToken(store)}`;
  const good = await signedCookie();
  assert.equal((await get(view, good)).status, 200);

  // Tampered: a changed signature, a changed time, a wrong shape, another service's cookie.
  const value = good.slice(`${SESSION_COOKIE}=`.length);
  const [v, issued, sig] = value.split(".");
  // Flip the *first* character, which carries 6 significant bits, so the decoded signature is always
  // different. The last character of a 43-character base64url HMAC carries 4 significant bits and 2
  // bits of padding, so swapping it can leave the decoded bytes identical and the cookie genuinely
  // valid (the flake that reddened CI run 43554822933: roughly one HMAC in sixteen ends in "A").
  const flipped = `${sig[0] === "A" ? "B" : "A"}${sig.slice(1)}`;
  assert.notEqual(flipped, sig, "the flipped signature must differ from the real one");
  for (const bad of [
    `${SESSION_COOKIE}=${v}.${issued}.${flipped}`,
    `${SESSION_COOKIE}=${v}.${Number(issued) + 1}.${sig}`,
    `${SESSION_COOKIE}=${v}.${issued}`,
    `${SESSION_COOKIE}=v2.${issued}.${sig}`,
    `${SESSION_COOKIE}=`,
    `other=${value}`,
    `${SESSION_COOKIE}=${value}x`,
  ]) {
    assert.equal((await get(view, bad)).status, 303, `refused: ${bad.slice(0, 44)}`);
  }

  // Expired: a day past its life.
  now += (SESSION_DAYS + 1) * 24 * 60 * 60_000;
  assert.equal((await get(view, good)).status, 303, "an expired session is refused");
  now = BASE;
  assert.equal((await get(view, good)).status, 200, "and the same cookie is fine again, so nothing was written");

  // A new password ends every session on every device at once, with nothing swept.
  signIn.setPassword(store, OTHER);
  assert.equal((await get(view, good)).status, 303, "the old session is refused after a password change");
  const fresh = pair(cookieOf(await post(SIGN_IN_PATH, { password: OTHER })));
  assert.notEqual(fresh, good);
  assert.equal((await get(view, fresh)).status, 200, "and the new password signs in, on a new cookie");
  signIn.setPassword(store, PASSWORD);
});

/* ---------- Rate limiting ---------- */

test("wrong passwords are rate limited with a short cool-off, and Paul is never locked out for good", async () => {
  const view = `${BOARD_PATH}?t=${boardToken(store)}`;
  waits.length = 0;
  const delays: number[] = [];
  for (let i = 0; i < SIGN_IN_MAX_FAILURES; i++) {
    const res = await post(SIGN_IN_PATH, { password: `guess ${i}` });
    assert.equal(res.status, 401, "still checked, still refused");
    delays.push(waits[waits.length - 1]);
  }
  assert.deepEqual(delays, [...delays].sort((a, b) => a - b), "the pause grows with each wrong attempt");
  assert.ok(delays[delays.length - 1] > delays[0], "a guesser is slowed down");

  // Now the cool-off: even the right password is refused, with how long to wait.
  const cooled = await post(SIGN_IN_PATH, { password: PASSWORD });
  assert.equal(cooled.status, 429);
  assert.match(cooled.headers.get("retry-after") ?? "", /^\d+$/);
  const cooledHtml = await text(cooled);
  assert.match(cooledHtml, /Too many attempts\. Try again in \d+ seconds\./);
  assert.equal(cookieOf(cooled), "", "and no session is handed out");
  assert.ok(!cooledHtml.includes(PASSWORD));

  // After the cool-off he is in again: a short wait, never a lock-out, and no second factor anywhere.
  now += SIGN_IN_COOL_OFF_MS + 1_000;
  const res = await post(SIGN_IN_PATH, { password: PASSWORD });
  assert.equal(res.status, 303, "the right password works again once the cool-off has passed");
  assert.equal((await get(view, pair(cookieOf(res)))).status, 200);
  now = BASE;

  // A right password clears the record, so one slip later does not stack up against him.
  assert.equal((await post(SIGN_IN_PATH, { password: "one slip" })).status, 401);
  assert.equal((await post(SIGN_IN_PATH, { password: PASSWORD })).status, 303);
  assert.equal((await post(SIGN_IN_PATH, { password: "one slip" })).status, 401, "the count started again");
  assert.equal((await post(SIGN_IN_PATH, { password: PASSWORD })).status, 303);
});

/* ---------- Nothing anywhere holds the password ---------- */

test("no response body anywhere in this file holds the password, and no log line does either", async () => {
  const logged: string[] = [];
  const real = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...args: unknown[]) => void logged.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  console.log = capture as typeof console.log;
  console.warn = capture as typeof console.warn;
  console.error = capture as typeof console.error;
  try {
    await post(SIGN_IN_PATH, { password: PASSWORD });
    await text(await get(SIGN_IN_PATH));
    await text(await get(`${PASSWORD_PATH}?t=not-the-token`));
    await text(await post(PASSWORD_PATH, { t: "not-the-token", password: PASSWORD, confirm: PASSWORD }));
  } finally {
    console.log = real.log;
    console.warn = real.warn;
    console.error = real.error;
  }
  assert.ok(bodies.length > 10, "the responses were all collected");
  for (const body of [...bodies, ...sent, ...logged]) assert.ok(!body.includes(PASSWORD), `the password reached something: ${body.slice(0, 120)}`);
  for (const body of logged) assert.ok(!body.includes(OTHER), "and neither did the other password");
});
