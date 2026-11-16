/**
 * The bank page over HTTP: the gate in front of it, the forms on it, the headers it carries, and
 * everything it must never say.
 *
 * A real Express app from buildApp, a fake provider (no network, no bank, synthetic data only) and a
 * temporary store per test. The owner signs in for real through the sign-in route, so the session
 * cookie the gate checks is a real one.
 *
 * What is checked here, in the commission's own terms: an unauthenticated visit, a wrong session and a
 * link alone (a board token, a reports token, the bridge's bearer token) are all refused; the callback
 * is reachable without a session and can only park a code; every changing route is a POST with the
 * session's CSRF token and no GET changes anything; every page is no-store, framed by nothing, with a
 * restrictive CSP and no referrer; every page fetches nothing and loads nothing from anywhere; every
 * word that came from the provider is escaped; no account or session identifier is ever in a URL; and
 * every state, including the truthful failures, renders.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-bank-page-"));
process.env.PUBLIC_URL = "https://workforce.example";
process.env.INSTINCT_BRIDGE_TOKEN = "the-instinct-bridge-token-for-this-test";

const { Store } = await import("../src/store.js");
const { buildApp } = await import("../src/index.js");
const { SignIn, SIGN_IN_PATH, SESSION_COOKIE } = await import("../src/sign-in.js");
const { BankStore, bankSettings, BANK_PATH, BANK_CALLBACK_PATH, BANK_CONNECT_PATH, BANK_START_PATH, BANK_COMPLETE_PATH, BANK_CANCEL_PATH, BANK_ACCOUNTS_PATH, BANK_BALANCES_PATH, BANK_TRANSACTIONS_PATH, BANK_DISCONNECT_PATH, BANK_REFRESH_PATH } = await import("../src/bank.js");
const { BankApiError } = await import("../src/bank-api.js");
const { boardToken } = await import("../src/jobs-board.js");
const { reportsToken } = await import("../src/reports.js");
import type { AgentRunner } from "../src/agents.js";

const PASSWORD = "correct horse battery staple 42!";
const CONNECTION_KEY = "a connection key long enough to be one";
const APP_ID = "11111111-2222-3333-4444-555555555555";
const NOW = Date.UTC(2026, 10, 15, 9, 0, 0);

const runner: AgentRunner = async () => {
  throw new Error("the bank page must not run any worker");
};

const HSBC = { uid: "acc-current", name: "Everyday Current Account", iban: "GB33BUKB20201555555555" };
const SAVINGS = { uid: "acc-savings", name: "Online Bonus Saver", iban: "GB33BUKB20201555666666" };

/** Every body this file ever saw, checked at the end for a secret. */
const bodies: string[] = [];

/** The provider, faked: nothing leaves the machine, and every call is recorded. */
function fakeApi(over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  return {
    calls,
    listAspsps: async () => {
      calls.push("listAspsps");
      return [
        { name: "HSBC UK Business", country: "GB" },
        { name: "HSBC UK", country: "GB", psuTypes: ["personal", "business"] },
      ];
    },
    startAuthorisation: async (o: { state: string; redirectUrl: string; validUntil: string }) => {
      calls.push(`startAuthorisation ${o.redirectUrl} ${o.validUntil}`);
      return `https://api.enablebanking.com/auth?state=${o.state}&redirect_uri=${encodeURIComponent(o.redirectUrl)}`;
    },
    createSession: async (code: string) => {
      calls.push(`createSession ${code}`);
      return { sessionId: "sess-1", accounts: [HSBC, SAVINGS], aspsp: { name: "HSBC UK", country: "GB" }, scope: ["read"], accessValidUntil: "2027-02-13T00:00:00Z" };
    },
    readSession: async () => {
      calls.push("readSession");
      return { sessionId: "sess-1", accounts: [HSBC, SAVINGS], aspsp: { name: "HSBC UK", country: "GB" }, scope: ["read"] };
    },
    deleteSession: async (id: string) => void calls.push(`deleteSession ${id}`),
    balances: async (uid: string) => {
      calls.push(`balances ${uid}`);
      if (over.balanceFails) throw over.balanceFails;
      return [{ type: "interimBooked", name: "<Booked>", amount: "1234.56", currency: "GBP" }];
    },
    transactions: async (uid: string, q: { from: string; to: string }) => {
      calls.push(`transactions ${uid} ${q.from}..${q.to}`);
      if (over.truncates) return { lines: [{ bookingDate: "2026-11-14", description: `<script>alert(1)</script> "quoted" & done`, amount: "-4.20", currency: "GBP" }], continuationKey: "more" };
      return { lines: [{ bookingDate: "2026-11-14", description: "COFFEE SHOP", amount: "-4.20", currency: "GBP" }] };
    },
  };
}

/** A fresh app, store and provider for one test. */
async function setup(over: { settings?: ReturnType<typeof bankSettings>; api?: Record<string, unknown> } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-bank-page-"));
  let now = NOW;
  const store = new Store(dir);
  const signIn = new SignIn(() => now, async () => {});
  signIn.setPassword(store, PASSWORD);
  const bankStore = new BankStore(path.join(dir, "bank"));
  const api = fakeApi(over.api);
  const settings =
    over.settings ??
    bankSettings({
      BANK_ENABLED: "true",
      BANK_APPLICATION_ID: APP_ID,
      BANK_JWT_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nnot a real key\n-----END PRIVATE KEY-----",
      BANK_CONNECTION_KEY: CONNECTION_KEY,
      BANK_REDIRECT_URL: "https://workforce.example/bank/callback",
    });
  const built = buildApp({
    messenger: { send: async () => {} } as never,
    runner,
    store,
    signIn,
    bank: { settings, api: api as never, store: bankStore, now: () => now },
  });
  const srv = await new Promise<import("node:http").Server>((r) => {
    const s = built.app.listen(0, () => r(s));
  });
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;

  const get = async (p: string, cookie?: string, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${p}`, { redirect: "manual", headers: { ...(cookie ? { cookie } : {}), ...headers } });
    bodies.push(await res.clone().text());
    return res;
  };
  const post = async (p: string, body: Record<string, string | string[]>, cookie?: string) => {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) for (const one of Array.isArray(v) ? v : [v]) form.append(k, one);
    const res = await fetch(`${base}${p}`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: form.toString() });
    bodies.push(await res.clone().text());
    return res;
  };
  const signInNow = async () => {
    const res = await post(SIGN_IN_PATH, { password: PASSWORD });
    const set = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    assert.ok(set, "the sign-in handed back a session cookie");
    return set.split(";")[0];
  };
  return {
    dir,
    store,
    bankStore,
    api,
    base,
    get,
    post,
    signInNow,
    text: async (res: Response) => res.text(),
    bodyOf: async (res: Response) => res.text(),
    advance: (ms: number) => (now += ms),
    // `closeAllConnections` first: a keep-alive socket from the fetch client would otherwise hold the
    // server open and the test file would sit waiting for it.
    close: () =>
      new Promise<void>((r) => {
        srv.closeAllConnections();
        srv.close(() => r());
      }),
    scheduler: built.scheduler,
  };
}


/** The CSRF token, and the connect action, out of a page. Both are hidden fields of the form that uses them. */
const hiddenValue = (html: string, name: string): string => {
  const m = new RegExp(`<input type="hidden" name="${name}" value="([^"]*)"`).exec(html);
  return m ? m[1] : "";
};

/** A page's own escaping, undone: the bank's address is drawn escaped, as everything else is. */
const unescapeHtml = (s: string): string => s.replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)));

/** The bank's own address, out of the link the waiting page offers it by. */
const bankLink = (html: string): URL => {
  const href = /<a class="go" href="([^"]+)"/.exec(html)?.[1];
  assert.ok(href, "the waiting page offers the bank's own address as a link");
  return new URL(unescapeHtml(href));
};

/** Connect fully, so a test can start from a connected page: start, callback, finish, choose. */
async function connect(h: Awaited<ReturnType<typeof setup>>, cookie: string, choose = true) {
  const confirm = await h.text(await h.post(BANK_CONNECT_PATH, { csrf: hiddenValue(await h.text(await h.get(BANK_PATH, cookie)), "csrf") }, cookie));
  const csrf = hiddenValue(confirm, "csrf");
  const started = await h.post(BANK_START_PATH, { csrf, action: hiddenValue(confirm, "action") }, cookie);
  assert.equal(started.status, 200, "the start press answers with a page, never a redirect to the bank");
  const state = bankLink(await h.text(started)).searchParams.get("state")!;
  const back = await h.get(`${BANK_CALLBACK_PATH}?state=${encodeURIComponent(state)}&code=one-time-code-abc`);
  assert.equal(back.status, 200);
  const finished = await h.post(BANK_COMPLETE_PATH, { csrf }, cookie);
  assert.equal(finished.status, 200);
  if (!choose) return { csrf };
  const page = await h.text(finished);
  const handle = new RegExp(`name="account" value="([^"]+)"`).exec(page)?.[1] ?? "";
  await h.post(BANK_ACCOUNTS_PATH, { csrf, account: [handle] }, cookie);
  return { csrf, handle };
}

/* ---------- Who may see any of it ---------- */

test("without the owner's session the bank page is not there at all", async () => {
  const h = await setup();
  try {
    const res = await h.get(BANK_PATH);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), `${SIGN_IN_PATH}?next=%2Fbank`);
    assert.equal((await h.text(res)).includes("Connect to HSBC UK"), false, "and no part of the page is sent with the redirect");
  } finally {
    h.scheduler.stopAll();
    await h.close();
  }
});

test("a wrong session, a board link, a reports link and the bridge's own token are not proof of the owner", async () => {
  const h = await setup();
  try {
    const stale = `${SESSION_COOKIE}=v1.1.not-a-real-signature`;
    const board = boardToken(h.store);
    const reports = reportsToken(h.store);
    for (const [what, res] of [
      ["a made-up session cookie", await h.get(BANK_PATH, stale)],
      ["the jobs board's token", await h.get(`${BANK_PATH}?t=${encodeURIComponent(board)}`)],
      ["the reports view's token", await h.get(`${BANK_PATH}?t=${encodeURIComponent(reports)}`)],
      ["both tokens at once", await h.get(`${BANK_PATH}?t=${encodeURIComponent(board)}&t=${encodeURIComponent(reports)}`, stale)],
      ["the bridge's bearer token as a header", await h.get(BANK_PATH, undefined, { authorization: `Bearer ${process.env.INSTINCT_BRIDGE_TOKEN!}` })],
      ["a bearer token that looks like a session", await h.get(BANK_PATH, undefined, { authorization: `Bearer ${SESSION_COOKIE}=${stale}` })],
    ] as Array<[string, Response]>) {
      assert.equal(res.status, 303, `${what} must not open the page`);
      const location = res.headers.get("location") ?? "";
      assert.ok(location.startsWith(`${SIGN_IN_PATH}?next=%2Fbank`), `${what}: and is sent to sign in, carrying what he asked for (${location})`);
      assert.equal(location.includes("Bearer"), false, "the token he sent is not echoed into the redirect");
    }
    assert.equal(h.api.calls.length, 0, "and none of them made the provider talk");
  } finally {
    h.scheduler.stopAll();
    await h.close();
  }
});

test("every route that changes anything refuses an unsigned-in request, and no GET changes anything", async () => {
  const h = await setup();
  try {
    const changing: Array<[string, Record<string, string>]> = [
      [BANK_CONNECT_PATH, {}],
      [BANK_START_PATH, { action: "one" }],
      [BANK_COMPLETE_PATH, {}],
      [BANK_CANCEL_PATH, {}],
      [BANK_ACCOUNTS_PATH, { account: "one" }],
      [BANK_REFRESH_PATH, {}],
      [BANK_BALANCES_PATH, { account: "one" }],
      [BANK_TRANSACTIONS_PATH, { account: "one", from: "2026-11-01", to: "2026-11-15" }],
      [BANK_DISCONNECT_PATH, {}],
    ];
    for (const [p, body] of changing) {
      const res = await h.post(p, body);
      assert.equal(res.status, 303, `${p} must not be usable without a session`);
      assert.equal(res.headers.get("location"), `${SIGN_IN_PATH}?next=${encodeURIComponent(p)}`);
      const bare = await h.get(p);
      assert.notEqual(bare.status, 200, `${p} must not answer a GET with a page`);
    }
    assert.equal(h.api.calls.length, 0, "nothing was done and nothing was read");
    assert.equal(h.bankStore.state(CONNECTION_KEY).kind, "none", "and nothing was stored");
  } finally {
    h.scheduler.stopAll();
    await h.close();
  }
});

test("a signed-in POST without this session's CSRF token is refused, and changes nothing", async () => {
  const h = await setup();
  try {
    const cookie = await h.signInNow();
    for (const p of [BANK_CONNECT_PATH, BANK_START_PATH, BANK_ACCOUNTS_PATH, BANK_BALANCES_PATH, BANK_TRANSACTIONS_PATH, BANK_REFRESH_PATH, BANK_DISCONNECT_PATH, BANK_COMPLETE_PATH, BANK_CANCEL_PATH]) {
      const res = await h.post(p, { csrf: "made-up" }, cookie);
      assert.equal(res.status, 400, `${p} without the token`);
      assert.match(await h.text(res), /not one this session was given/);
    }
    // The same token from a different session is not this session's.
    const other = await setup();
    try {
      const otherCookie = await other.signInNow();
      const token = hiddenValue(await h.text(await other.get(BANK_PATH, otherCookie)), "csrf");
      assert.ok(token, "the other session does have a token of its own");
      assert.equal((await h.post(BANK_CONNECT_PATH, { csrf: token }, cookie)).status, 400, "but it is not mine");
    } finally {
      other.scheduler.stopAll();
      await other.close();
    }
    assert.equal(h.api.calls.length + other.api.calls.length, 0);
  } finally {
    h.scheduler.stopAll();
    await h.close();
  }
});

/* ---------- The bank's own redirect back ---------- */

test("the callback is reachable without a session, and only ever parks a code or refuses", async () => {
  const h = await setup();
  try {
    const noState = await h.get(BANK_CALLBACK_PATH);
    assert.equal(noState.status, 400, "no state at all");
    assert.match(await h.text(noState), /Nothing was connected/);
    assert.match(await h.text(await h.get(`${BANK_CALLBACK_PATH}?state=not-ours&code=x`)), /expired or was not started here/);
    // The bank declining is only ever said about a flow this service actually started, so not here.
    assert.match(await h.text(await h.get(`${BANK_CALLBACK_PATH}?state=not-ours&error=access_denied`)), /Nothing was connected/);
    assert.equal(h.bankStore.state(CONNECTION_KEY).kind, "none", "nothing was stored by any of it");
    assert.equal(h.api.calls.includes("createSession one-time-code-abc"), false, "and nothing was exchanged");

    // With a flow parked properly, the callback parks the code and says so, without a session.
    const cookie = await h.signInNow();
    const confirm = await h.text(await h.post(BANK_CONNECT_PATH, { csrf: hiddenValue(await h.text(await h.get(BANK_PATH, cookie)), "csrf") }, cookie));
    const started = await h.post(BANK_START_PATH, { csrf: hiddenValue(confirm, "csrf"), action: hiddenValue(confirm, "action") }, cookie);
    const state = bankLink(await h.text(started)).searchParams.get("state")!;
    const parked = await h.get(`${BANK_CALLBACK_PATH}?state=${encodeURIComponent(state)}&code=one-time-code-abc`);
    assert.equal(parked.status, 200);
    const html = await h.text(parked);
    assert.match(html, /Back from the bank/);
    assert.match(html, /held in memory, useable once/);
    assert.match(html, /not signed in/, "and it says the page itself is not a signed-in one");
    assert.equal(h.bankStore.state(CONNECTION_KEY).kind, "none", "still nothing stored: the owner has not finished");
    // The query string is never echoed back.
    assert.equal(html.includes("one-time-code-abc"), false, "the code is not in the page");
    assert.equal(html.includes(state), false, "nor is the state");
  } finally {
    h.scheduler.stopAll();
    await h.close();
  }
});

/* ---------- The flow, on the page ---------- */

test("the whole flow runs from the page: connect, go to the bank, come back, finish, choose", async () => {
  const h = await setup();
  try {
    const cookie = await h.signInNow();
    const start = await h.get(BANK_PATH, cookie);
    assert.equal(start.status, 200);
    let html = await h.text(start);
    assert.match(html, /Connect to HSBC UK/);
    assert.match(html, /read-only/);
    assert.match(html, /never pay, transfer or change anything/);
    const csrf = hiddenValue(html, "csrf");
    assert.ok(csrf.length > 20, "the form carries a session token");

    // The confirm page names the bank, the consent's length and the address the bank comes back to.
    const confirm = await h.post(BANK_CONNECT_PATH, { csrf }, cookie);
    html = await h.text(confirm);
    assert.match(html, /Go to HSBC to authorise/);
    assert.match(html, /read-only, asked for 90 days/);
    assert.match(html, /https:\/\/workforce\.example\/bank\/callback/);
    assert.equal(html.includes("acc-current"), false, "no account identifier anywhere: none has been read yet");

    // Starting answers with the page that offers the bank's own address as a link, over https, and
    // never with a redirect: `form-action 'self'` is applied by browsers to a form submission's
    // redirects too, so a 303 to the bank would be refused by the browser and never followed.
    const started = await h.post(BANK_START_PATH, { csrf, action: hiddenValue(html, "action") }, cookie);
    assert.equal(started.status, 200);
    assert.equal(started.headers.get("location"), null, "the bank's address is never a redirect here");
    const startedHtml = await h.text(started);
    const url = bankLink(startedHtml);
    assert.equal(url.protocol, "https:");
    assert.equal(url.host, "api.enablebanking.com");
    assert.equal(url.searchParams.get("redirect_uri"), "https://workforce.example/bank/callback");
    assert.match(startedHtml, /Continue to HSBC UK/, "the link says where it goes");
    assert.match(startedHtml, /Nothing has been read yet/);
    assert.ok(h.api.calls.some((c) => c.startsWith("startAuthorisation https://workforce.example/bank/callback")));

    // The page carries it while the bank has the browser, and still offers a cancel.
    html = await h.text(await h.get(BANK_PATH, cookie));
    assert.match(html, /Go to your bank/);
    assert.equal(bankLink(html).href, url.href, "the same address, so a reload does not lose it");
    assert.match(html, /Cancel this connection/);

    // Back from the bank: a one-time code is parked, and the page offers to finish.
    await h.get(`${BANK_CALLBACK_PATH}?state=${encodeURIComponent(url.searchParams.get("state")!)}&code=one-time-code-abc`);
    html = await h.text(await h.get(BANK_PATH, cookie));
    assert.match(html, /Finish connecting/);
    assert.equal(h.api.calls.some((c) => c.startsWith("createSession")), false, "and nothing has been exchanged yet");

    const finished = await h.text(await h.post(BANK_COMPLETE_PATH, { csrf }, cookie));
    assert.match(finished, /Connected/);
    assert.match(finished, /you have not chosen an account/, "a connection with nothing chosen is said plainly, not as a success");
    assert.match(finished, /Nothing is readable yet/);
    assert.ok(h.api.calls.some((c) => c === "createSession one-time-code-abc"), "the code was exchanged once, in the owner's own session");

    // Choose one account: the page says what became readable, and the other is still not.
    const handle = new RegExp(`name="account" value="([^"]+)"`).exec(finished)?.[1] ?? "";
    assert.ok(handle, "the chooser carries a handle");
    const saved = await h.text(await h.post(BANK_ACCOUNTS_PATH, { csrf, account: [handle] }, cookie));
    assert.match(saved, /Saved: 1 account readable/);
    assert.match(saved, /Everyday Current Account · ••5555/, "the label is masked");
    assert.equal(saved.includes("GB33BUKB20201555555555"), false, "and the full identifier is never on the page");
    assert.equal(saved.includes("acc-current"), false, "nor the provider's own id");
  } finally {
    h.scheduler.stopAll();
    await h.close();
  }
});

test("a read over the page shows what the provider said, and is stored nowhere", async () => {
  const h = await setup();
  try {
    const cookie = await h.signInNow();
    const { csrf, handle } = await connect(h, cookie);

    const balances = await h.post(BANK_BALANCES_PATH, { csrf, account: handle }, cookie);
    const html = await h.text(balances);
    assert.equal(balances.status, 200);
    assert.match(html, /Balances/);
    assert.match(html, /1234\.56 GBP/);
    assert.match(html, /stored nowhere/);
    assert.match(html, /Read from the provider at .*London time/);
    assert.ok(h.api.calls.some((c) => c === "balances acc-current"), "the provider's own id is used for the call only");

    const txns = await h.post(BANK_TRANSACTIONS_PATH, { csrf, account: handle, from: "2026-11-01", to: "2026-11-15" }, cookie);
    const ledger = await h.text(txns);
    assert.match(ledger, /COFFEE SHOP/);
    assert.match(ledger, /-4\.20 GBP/);
    assert.match(ledger, /Read 1 transaction over 1 page, showing 1\./);
    assert.match(ledger, /for 2026-11-01 to 2026-11-15/);
    assert.ok(h.api.calls.some((c) => c === "transactions acc-current 2026-11-01..2026-11-15"));

    // Nothing of it is on disk anywhere.
    for (const file of [path.join(h.dir, "state.json"), ...fs.readdirSync(path.join(h.dir, "bank")).map((f) => path.join(h.dir, "bank", f))]) {
      const text = fs.readFileSync(file, "utf8");
      for (const secret of ["1234.56", "COFFEE", "acc-current", "GB33BUKB"]) assert.ok(!text.includes(secret), `${secret} is not kept in ${path.basename(file)}`);
    }
  } finally {
    h.scheduler.stopAll();
    await h.close();
  }
});

test("a bound that stopped a long read early is shown, not smoothed over", async () => {
  const h = await setup({ api: { truncates: true } });
  try {
    const cookie = await h.signInNow();
    const { csrf, handle } = await connect(h, cookie);
    const html = await h.text(await h.post(BANK_TRANSACTIONS_PATH, { csrf, account: handle, from: "2026-11-01", to: "2026-11-15" }, cookie));
    assert.match(html, /safety bound/, "truncation is shown");
    assert.match(html, /narrow the dates to see it/);
  } finally {
    h.scheduler.stopAll();
    await h.close();
  }
});

test("everything the provider said is escaped, once, and never trusted as markup", async () => {
  // The provider's own words here are a script tag, a quote and an ampersand, in a balance's name and a
  // transaction's description.
  const h = await setup({ api: { truncates: true } });
  try {
    const cookie = await h.signInNow();
    const { csrf, handle } = await connect(h, cookie);
    const balances = await h.text(await h.post(BANK_BALANCES_PATH, { csrf, account: handle }, cookie));
    assert.equal(balances.includes("<Booked>"), false, "the provider's own words are escaped");
    assert.match(balances, /(?:&#60;|&lt;)Booked(?:&#62;|&gt;)/);
    const txns = await h.text(await h.post(BANK_TRANSACTIONS_PATH, { csrf, account: handle, from: "2026-11-01", to: "2026-11-15" }, cookie));
    assert.equal(txns.includes("<script>"), false);
    assert.match(txns, /(?:&#60;|&lt;)script(?:&#62;|&gt;)alert\(1\)/);
    assert.match(txns, /(?:&quot;|&#34;)quoted(?:&quot;|&#34;)/);
    assert.match(txns, /(?:&amp;|&#38;) done/);
  } finally {
    h.scheduler.stopAll();
    await h.close();
  }
});

test("a provider failure is one plain sentence on the page, never a stack or a status alone", async () => {
  const h = await setup({ api: { balanceFails: new BankApiError("rate-limit", "The provider is rate limiting this service. Nothing was read; try again shortly.") } });
  try {
    const cookie = await h.signInNow();
    const { csrf, handle } = await connect(h, cookie);
    const res = await h.post(BANK_BALANCES_PATH, { csrf, account: handle }, cookie);
    const html = await h.text(res);
    assert.equal(res.status, 200, "the page still renders: a provider failure is a state, not a crash");
    assert.match(html, /rate limiting this service/);
    assert.equal(html.includes("at BankApi"), false, "no stack");
    assert.equal(html.includes("Error:"), false);
  } finally {
    h.scheduler.stopAll();
    await h.close();
  }
});

test("a foreign or unchosen account is refused on the page, whatever the form is made to carry", async () => {
  const h = await setup();
  try {
    const cookie = await h.signInNow();
    const { csrf, handle } = await connect(h, cookie);
    for (const body of [{ account: "not-a-handle" }, { account: h.store.settings().jobsBoardToken ?? "x" }, { account: "" }, { account: ["", "  "] }]) {
      const html = await h.text(await h.post(BANK_BALANCES_PATH, { csrf, ...body }, cookie));
      assert.match(html, /not one you chose for this connection|Choose at least one account/);
      assert.equal(html.includes("1234.56"), false, "and nothing was read");
    }
    // Even a second account the provider's session can see is refused while it is not chosen.
    const other = (await h.text(await h.get(BANK_PATH, cookie)));
    const second = [...other.matchAll(/name="account" value="([^"]+)"/g)].map((m) => m[1]).find((v) => v !== handle);
    assert.ok(second, "the chooser lists the second account");
    const refused = await h.text(await h.post(BANK_BALANCES_PATH, { csrf, account: second! }, cookie));
    assert.match(refused, /not one you chose for this connection/);
    assert.equal(h.api.calls.some((c) => c === "balances acc-savings"), false, "the provider was never asked about it");
  } finally {
    h.scheduler.stopAll();
    await h.close();
  }
});

test("a date range the connector will not read is refused in plain words before anything is asked", async () => {
  const h = await setup();
  try {
    const cookie = await h.signInNow();
    const { csrf, handle } = await connect(h, cookie);
    const before = h.api.calls.filter((c) => c.startsWith("transactions")).length;
    for (const [from, to, pattern] of [
      ["2026-11-15", "2026-11-01", /first date is after/],
      ["2020-01-01", "2026-11-15", /reads at most 366 at a time/],
      ["2026-11-01", "2030-01-01", /ends in the future/],
      ["nonsense", "2026-11-15", /Give both dates as YYYY-MM-DD/],
    ] as Array<[string, string, RegExp]>) {
      const html = await h.text(await h.post(BANK_TRANSACTIONS_PATH, { csrf, account: handle, from, to }, cookie));
      assert.match(html, pattern, `${from}..${to}`);
    }
    assert.equal(h.api.calls.filter((c) => c.startsWith("transactions")).length, before, "and the provider was never asked");
  } finally {
    h.scheduler.stopAll();
    await h.close();
  }
});

test("disconnecting says the three things separately, and never claims the bank's consent is revoked", async () => {
  const h = await setup();
  try {
    const cookie = await h.signInNow();
    const { csrf } = await connect(h, cookie);
    const html = await h.text(await h.post(BANK_DISCONNECT_PATH, { csrf }, cookie));
    assert.match(html, /Local reads are off from now on/);
    assert.match(html, /record of the session was deleted/);
    assert.match(html, /cannot revoke it from here/);
    assert.match(html, /revoke the ClearOps access in the HSBC UK app or in online banking/);
    assert.match(html, /destroyed with the record/);
    assert.ok(h.api.calls.includes("deleteSession sess-1"));
    assert.equal(h.bankStore.state(CONNECTION_KEY).kind, "none", "the local record is destroyed");
    const after = await h.text(await h.get(BANK_PATH, cookie));
    assert.match(after, /Connect to HSBC UK/, "and the page is back to offering a fresh connection");
    assert.equal(after.includes("Everyday Current Account"), false, "with nothing of the old one on it");
  } finally {
    h.scheduler.stopAll();
    await h.close();
  }
});

test("cancelling an attempt changes nothing and leaves nothing", async () => {
  const h = await setup();
  try {
    const cookie = await h.signInNow();
    const confirm = await h.text(await h.post(BANK_CONNECT_PATH, { csrf: hiddenValue(await h.text(await h.get(BANK_PATH, cookie)), "csrf") }, cookie));
    const csrf = hiddenValue(confirm, "csrf");
    await h.post(BANK_START_PATH, { csrf, action: hiddenValue(confirm, "action") }, cookie);
    const html = await h.text(await h.post(BANK_CANCEL_PATH, { csrf }, cookie));
    assert.match(html, /cancelled. Nothing was exchanged and nothing was stored/);
    assert.match(html, /Connect to HSBC UK/);
    assert.equal(h.bankStore.state(CONNECTION_KEY).kind, "none");
  } finally {
    h.scheduler.stopAll();
    await h.close();
  }
});

/* ---------- The other states ---------- */

test("switched off, the page says exactly that and offers nothing", async () => {
  const h = await setup({ settings: bankSettings({}) });
  try {
    const cookie = await h.signInNow();
    const html = await h.text(await h.get(BANK_PATH, cookie));
    assert.match(html, /switched off here \(BANK_ENABLED is not set\)/);
    assert.equal(html.includes("<form"), false, "no button to press");
    assert.equal((await h.post(BANK_CONNECT_PATH, { csrf: hiddenValue(html, "csrf") }, cookie)).status, 400, "and no form to carry a token");
    assert.equal(h.api.calls.length, 0);
  } finally {
    h.scheduler.stopAll();
    await h.close();
  }
});

test("a record that cannot be read stops the connector and says so, and is left alone", async () => {
  const h = await setup();
  try {
    const cookie = await h.signInNow();
    await connect(h, cookie);
    // The file is altered under the connector: the same answer as a changed key.
    const file = h.bankStore.file();
    fs.writeFileSync(file, `${fs.readFileSync(file, "utf8").slice(0, -4)}AAAA`, { mode: 0o600 });
    const html = await h.text(await h.get(BANK_PATH, cookie));
    assert.match(html, /connection unreadable/);
    assert.match(html, /its key changed, or the file was altered/);
    assert.match(html, /left exactly as it is/);
    assert.equal(html.includes("<form"), false, "and nothing can be done from here until a fresh connection is made");
  } finally {
    h.scheduler.stopAll();
    await h.close();
  }
});

test("a connection whose key is missing stops the connector rather than reading anything", async () => {
  const h = await setup({ settings: bankSettings({ BANK_ENABLED: "true", BANK_APPLICATION_ID: APP_ID, BANK_JWT_PRIVATE_KEY: "key", BANK_CONNECTION_KEY: "", BANK_REDIRECT_URL: "https://workforce.example/bank/callback" }) });
  try {
    const cookie = await h.signInNow();
    const html = await h.text(await h.get(BANK_PATH, cookie));
    assert.match(html, /no connection key \(BANK_CONNECTION_KEY\)/);
    assert.equal(html.includes("<form"), false);
    assert.equal(h.bankStore.state("").kind, "off");
  } finally {
    h.scheduler.stopAll();
    await h.close();
  }
});

/* ---------- Headers, and what the pages load ---------- */

test("every bank page is no-store, unframed, no-referrer and loads nothing from anywhere", async () => {
  const h = await setup();
  try {
    const cookie = await h.signInNow();
    await connect(h, cookie);
    for (const [what, res] of [
      ["the page", await h.get(BANK_PATH, cookie)],
      ["the callback's refusal", await h.get(`${BANK_CALLBACK_PATH}?state=not-ours`)],
    ] as Array<[string, Response]>) {
      assert.equal(res.headers.get("cache-control"), "no-store, no-cache, must-revalidate, private", what);
      assert.equal(res.headers.get("pragma"), "no-cache");
      assert.equal(res.headers.get("referrer-policy"), "no-referrer");
      assert.equal(res.headers.get("x-frame-options"), "DENY");
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      const csp = res.headers.get("content-security-policy") ?? "";
      assert.match(csp, /default-src 'none'/);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.match(csp, /form-action 'self'/);
      assert.match(csp, /img-src 'none'/);
      assert.match(csp, /base-uri 'none'/);
      const html = await h.text(res);
      assert.equal(html.includes("<script"), false, "no script");
      assert.equal(/<iframe|<object|<embed/.test(html), false, "nothing embedded");
      // Nothing is fetched: no external address at all, and no attribute that would load one.
      assert.equal(/(src|href)="https?:\/\//.test(html.replace(/https:\/\/workforce\.example\/bank\/callback/g, "")), false, "no third-party anything");
      assert.equal(html.includes("http://"), false, "and no plain http anywhere");
      assert.equal(/@import|url\(/.test(html), false, "no stylesheet or font is loaded");
    }
  } finally {
    h.scheduler.stopAll();
    await h.close();
  }
});

test("no page or form address ever carries a session or account identifier", async () => {
  const h = await setup();
  try {
    const cookie = await h.signInNow();
    const { csrf, handle } = await connect(h, cookie);
    const pages = [
      await h.text(await h.get(BANK_PATH, cookie)),
      await h.text(await h.post(BANK_BALANCES_PATH, { csrf, account: handle }, cookie)),
      await h.text(await h.post(BANK_TRANSACTIONS_PATH, { csrf, account: handle, from: "2026-11-01", to: "2026-11-15" }, cookie)),
    ];
    for (const html of pages) {
      const actions = [...html.matchAll(/<form method="post" action="([^"]+)"/g)].map((m) => m[1]);
      assert.ok(actions.length >= 1, "there are forms");
      for (const action of actions) {
        assert.match(action, /^\/bank(\/[a-z]+)?$/, `a form address is one of ours: ${action}`);
        assert.equal(action.includes("?"), false, "no query string on a form's address");
      }
      assert.equal(html.includes("sess-1"), false, "no provider session id");
      // An account handle travels in a hidden field of a form this page must post, and nowhere else:
      // never in an address, a link, an id or a class.
      assert.equal(new RegExp(`(?:action|href)="[^"]*${handle}`).test(html), false, "no handle in any address");
      assert.equal(html.includes(`id="${handle}"`), false, "nor as an element id");
      const occurrences = html.split(handle).length - 1;
      const inFields = html.split(`value="${handle}"`).length - 1;
      assert.equal(occurrences, inFields, "every occurrence is a hidden field's value and nothing else");
    }
    // And no page is reachable by a GET that carries an identifier it would act on.
    const readBack = await h.get(`${BANK_PATH}?account=${handle}&from=2026-11-01&to=2026-11-15`, cookie);
    const html = await h.text(readBack);
    assert.equal(readBack.status, 200);
    assert.equal(html.includes("1234.56"), false, "a GET with an account in it reads nothing");
    assert.equal(html.includes("COFFEE SHOP"), false);
  } finally {
    h.scheduler.stopAll();
    await h.close();
  }
});

test("the bridge's own routes carry nothing of the bank", async () => {
  const h = await setup();
  try {
    const cookie = await h.signInNow();
    await connect(h, cookie);
    const token = process.env.INSTINCT_BRIDGE_TOKEN!;
    const status = await h.get("/api/instinct/status", undefined, { authorization: `Bearer ${token}` });
    const context = await h.get("/api/instinct/context", undefined, { authorization: `Bearer ${token}` });
    assert.equal(status.status, 200);
    assert.equal(context.status, 200);
    for (const body of [await h.text(status), await h.text(context)]) {
      for (const secret of ["sess-1", "acc-current", "GB33BUKB", "Everyday Current Account", "1234.56", "connection.enc", CONNECTION_KEY, APP_ID]) {
        assert.equal(body.includes(secret), false, `the bridge must carry nothing of the bank: ${secret}`);
      }
    }
  } finally {
    h.scheduler.stopAll();
    await h.close();
  }
});

test("no bank secret, key or session id ever reaches a page or a log line", async () => {
  const fourOhFour = bodies.join("\n");
  for (const secret of [CONNECTION_KEY, APP_ID, "BEGIN PRIVATE KEY", "one-time-code-abc"]) {
    assert.equal(fourOhFour.includes(secret), false, `no body carries ${secret}`);
  }
  assert.ok(bodies.length > 20, "and there were bodies to check");
});
