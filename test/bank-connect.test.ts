/**
 * The connect gate: the whole way from a button to a bank read, driven directly (no HTTP here, no
 * network, no model: the provider is a fake object that answers in the shapes the provider's public
 * documentation describes, and every test uses synthetic data only).
 *
 * The tests are mostly about refusals, because that is what this file exists for: an action belongs to
 * the session that asked and to nobody else, a callback parks a code or refuses, a code is exchanged
 * once, an account that was not chosen is not readable even though the session can see it, choosing
 * nothing is not a connection, a bound stops a long read and says so, and disconnecting blocks local
 * reads first and never claims the bank's consent has been revoked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bankTestBoundary } from "./bank-synthetic.js";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-bank-connect-"));
process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.PUBLIC_URL = "https://workforce.example";
// The synthetic-only boundary: no BANK_ variable of the host's reaches this process, and a call that
// would leave for the provider fails loudly rather than going (test/bank-synthetic.ts).
bankTestBoundary();

const { Store } = await import("../src/store.js");
const { SignIn, SESSION_COOKIE } = await import("../src/sign-in.js");
const { BankStore, bankReady, bankSettings, uidHash, connectionKey, BANK_ACTION_TTL_MS, BANK_WINDOW_DAYS_MAX } = await import("../src/bank.js");
const { BankGate, sessionFingerprint, windowCheck, BANK_CONSENT_DAYS } = await import("../src/bank-gate.js");
const { BankApiError } = await import("../src/bank-api.js");
import type { BankApi } from "../src/bank-api.js";

const NOW = Date.UTC(2026, 10, 15, 9, 0, 0);
const CONNECTION_KEY = "a connection key long enough to be one";
const REDIRECT = "https://workforce.example/bank/callback";

const settings = bankSettings({
  BANK_ENABLED: "true",
  BANK_APPLICATION_ID: "11111111-2222-3333-4444-555555555555",
  BANK_JWT_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nnot really a key\n-----END PRIVATE KEY-----",
  BANK_CONNECTION_KEY: CONNECTION_KEY,
  BANK_REDIRECT_URL: REDIRECT,
  BANK_WINDOW_DAYS: "30",
});

const HSBC = { uid: "acc-current", name: "Everyday Current Account", iban: "GB33BUKB20201555555555" };
const SAVINGS = { uid: "acc-savings", name: "Online Bonus Saver", iban: "GB33BUKB20201555666666" };
const SECRET = { uid: "acc-mortgage", name: "Mortgage", iban: "GB33BUKB20201555777777" };

/** A fake provider: nothing leaves the machine, and every call is recorded. */
function fakeApi(over: Partial<Record<string, unknown>> = {}) {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const accounts = [HSBC, SAVINGS, SECRET];
  const api = {
    calls,
    listAspsps: async (...args: unknown[]) => {
      calls.push({ op: "listAspsps", args });
      return (over.aspsps as unknown[]) ?? [
        { name: "HSBC UK Business", country: "GB" },
        { name: "HSBC UK", country: "GB", psuTypes: ["personal", "business"] },
        { name: "Monzo", country: "GB" },
      ];
    },
    startAuthorisation: async (...args: unknown[]) => {
      calls.push({ op: "startAuthorisation", args });
      if (over.startFails) throw new BankApiError("provider", "The provider answered 500 to starting an authorisation (it answered 500).");
      return (over.authUrl as string) ?? "https://api.enablebanking.com/auth?state=minted-by-the-provider";
    },
    createSession: async (...args: unknown[]) => {
      calls.push({ op: "createSession", args });
      if (over.createFails) throw new BankApiError("credential", "The provider refused the one-time code.");
      return {
        sessionId: "sess-1",
        accounts: (over.sessionAccounts as unknown[]) ?? [...accounts],
        aspsp: { name: "HSBC UK", country: "GB" },
        scope: ["read"],
        accessValidUntil: "2027-02-13T00:00:00Z",
      };
    },
    readSession: async (...args: unknown[]) => {
      calls.push({ op: "readSession", args });
      if (over.readFails) throw over.readFails;
      return { sessionId: "sess-1", accounts: (over.listed as unknown[]) ?? [...accounts], aspsp: { name: "HSBC UK", country: "GB" }, scope: ["read"] };
    },
    deleteSession: async (...args: unknown[]) => {
      calls.push({ op: "deleteSession", args });
      if (over.deleteFails) throw new BankApiError("network", "The provider could not be reached, so nothing was deleted.");
    },
    balances: async (...args: unknown[]) => {
      calls.push({ op: "balances", args });
      if (over.balanceFails) throw over.balanceFails;
      return [
        { type: "ITBD", amount: "1234.56", currency: "GBP" },
        { type: "ITAV", amount: "-12.34", currency: "GBP", asOf: "2026-11-15" },
      ];
    },
    transactions: async (...args: unknown[]) => {
      calls.push({ op: "transactions", args });
      if (over.transactionFails) throw over.transactionFails;
      const page = (over.pages as unknown[])?.[calls.filter((c) => c.op === "transactions").length - 1];
      return page ?? { lines: [{ bookingDate: "2026-11-14", description: "COFFEE SHOP", amount: "-4.20", currency: "GBP" }] };
    },
  };
  return api as unknown as BankApi & typeof api;
}

/** A gate over a throwaway store, with a password set so the CSRF token the forms carry exists. */
function makeGate(over: { api?: Partial<Record<string, unknown>>; settings?: ReturnType<typeof bankSettings>; bankStore?: InstanceType<typeof BankStore> } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-bank-gate-"));
  let now = NOW;
  const store = new Store(dir);
  const signIn = new SignIn(() => now, async () => {});
  signIn.setPassword(store, "a page password long enough to be one");
  const bankStore = over.bankStore ?? new BankStore(path.join(dir, "bank"));
  const api = fakeApi(over.api);
  const gate = new BankGate({ store, settings: over.settings ?? settings, api, bankStore, now: () => now });
  return { gate, store, bankStore, api, dir, signIn, advance: (ms: number) => (now += ms) };
}

const FP1 = sessionFingerprint(`${SESSION_COOKIE}=v1.1.first-session-signature`);
const FP2 = sessionFingerprint(`${SESSION_COOKIE}=v1.2.second-session-signature`);

/**
 * The state of the one flow this session has parked. The tests minted it, so reading it back is fair:
 * in the real service it is the provider's own redirect that carries it, and it is never logged.
 */
function stateOf(h: ReturnType<typeof makeGate>): string {
  const flows = (h.gate as unknown as { flows: Map<string, { fingerprint: string }> }).flows;
  for (const [state, flow] of flows) if (flow.fingerprint === FP1) return state;
  throw new Error("no flow was parked for this session");
}

/** Connect: start, park a code against the state, and finish in this session. */
async function complete(h: ReturnType<typeof makeGate>) {
  await h.gate.start(h.gate.newAction(FP1).token, FP1);
  assert.equal(h.gate.acceptCallback({ state: stateOf(h), code: "one-time-code-abc" }).kind, "parked");
  return h.gate.complete(FP1);
}

/* ---------- Off ---------- */

test("with nothing configured the connector says why and starts nothing", async () => {
  const off = bankSettings({ BANK_ENABLED: "true" });
  const h = makeGate({ settings: off });
  assert.match(h.gate.off() ?? "", /no provider application id/);
  await assert.rejects(() => h.gate.complete(FP1), /no provider application id/);
  await assert.rejects(() => h.gate.start("any-token", FP1), /no provider application id/);
  assert.equal(h.gate.state().kind, "off");
  const disabled = makeGate({ settings: bankSettings({}) });
  assert.match(disabled.gate.off() ?? "", /switched off here \(BANK_ENABLED is not set\)/);
  assert.equal(disabled.api.calls.length, 0, "and nothing was asked of the provider");
});

test("a stored connection is dead the moment the connector is switched off: zero provider calls, record untouched", async () => {
  // Connect and choose while it is on, over a store of this test's own.
  const live = makeGate();
  await complete(live);
  await live.gate.choose([live.gate.handle(HSBC.uid)]);
  assert.equal(live.bankStore.state(CONNECTION_KEY).kind, "connection");

  // The same store, the same key, every credential present — but BANK_ENABLED unset. The stored
  // record is still there, still readable, and every path that could reach the provider refuses
  // before anything is asked: this is the disabled-flag gap the review found (the start/callback/page
  // paths had the check; the stored-record paths did not).
  const offSettings = bankSettings({
    BANK_APPLICATION_ID: "11111111-2222-3333-4444-555555555555",
    BANK_JWT_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nnot really a key\n-----END PRIVATE KEY-----",
    BANK_CONNECTION_KEY: CONNECTION_KEY,
    BANK_REDIRECT_URL: REDIRECT,
  });
  assert.equal(offSettings.enabled, false);
  const off = makeGate({ settings: offSettings, bankStore: live.bankStore });
  assert.equal(off.bankStore.state(CONNECTION_KEY).kind, "connection", "the record is exactly as it was");

  await assert.rejects(() => off.gate.accounts(), /switched off here \(BANK_ENABLED is not set\)/);
  await assert.rejects(() => off.gate.accounts(true), /switched off here/);
  await assert.rejects(() => off.gate.choose([off.gate.handle(HSBC.uid)]), /switched off here/);
  await assert.rejects(() => off.gate.balances(off.gate.handle(HSBC.uid)), /switched off here/);
  await assert.rejects(() => off.gate.transactions(off.gate.handle(HSBC.uid), "2026-11-01", "2026-11-15"), /switched off here/);
  // Even disconnect — the one provider write a stale POST could reach — refuses before the provider.
  await assert.rejects(() => off.gate.disconnect(), /switched off here/);
  // And the connect paths refuse too, stale action or not.
  await assert.rejects(() => off.gate.start(off.gate.newAction(FP1).token, FP1), /switched off here/);
  await assert.rejects(() => off.gate.complete(FP1), /switched off here/);

  assert.equal(off.api.calls.length, 0, "the disabled gate made no provider call at all, on any path");
  assert.equal(live.bankStore.state(CONNECTION_KEY).kind, "connection", "and the stored record was neither read from nor destroyed");
  assert.equal((live.bankStore.state(CONNECTION_KEY) as { connection: { disconnectedAt?: string } }).connection.disconnectedAt, undefined, "least of all marked disconnected");
});

/* ---------- The connect action ---------- */

test("a connect action belongs to the session that asked for it, and is usable once", async () => {
  const h = makeGate();
  const action = h.gate.newAction(FP1);
  assert.ok(action.token.length >= 30, "a high-entropy token");
  assert.equal(h.gate.actionValid(action.token, FP1), true);
  assert.equal(h.gate.actionValid(action.token, FP2), false, "another session's action is not valid");
  assert.equal(h.gate.actionValid("made-up", FP1), false);

  await assert.rejects(() => h.gate.start(action.token, FP2), /expired or was already used/);
  assert.equal(h.api.calls.length, 0, "and no other session can make the provider talk");
  assert.equal(h.gate.actionValid(action.token, FP1), true, "a refused attempt does not use the action up");

  await h.gate.start(action.token, FP1);
  assert.equal(h.gate.actionValid(action.token, FP1), false, "used up");
  await assert.rejects(() => h.gate.start(action.token, FP1), /expired or was already used/);
  assert.equal(h.api.calls.filter((c) => c.op === "startAuthorisation").length, 1);
});

test("an action that goes stale is refused", async () => {
  const h = makeGate();
  const action = h.gate.newAction(FP1);
  h.advance(BANK_ACTION_TTL_MS + 1);
  assert.equal(h.gate.actionValid(action.token, FP1), false);
  await assert.rejects(() => h.gate.start(action.token, FP1), /expired or was already used/);
});

test("the bank is taken from the provider's own list, and the redirect and the consent's end date are ours", async () => {
  const h = makeGate();
  const started = await h.gate.start(h.gate.newAction(FP1).token, FP1);
  assert.equal(started.aspsp.name, "HSBC UK", "the HSBC UK personal entry out of the list, never a name guess");
  const call = h.api.calls.find((c) => c.op === "startAuthorisation")!;
  const args = call.args[0] as { aspsp: { name: string }; state: string; redirectUrl: string; validUntil: string };
  assert.equal(args.redirectUrl, REDIRECT, "exactly the registered address");
  assert.equal(args.validUntil, "2027-02-13T00:00:00Z", `${BANK_CONSENT_DAYS} days from the London day`);
  assert.ok(args.state.length >= 32, "a high-entropy state, not a counter");
  assert.ok(!args.state.includes(started.aspsp.name), "and nothing of ours in it");
  assert.equal(new URL(started.url).protocol, "https:");

  // The bank's own address is carried with the waiting flow, so the page can offer it as a link, and it
  // is dropped the moment a code is parked: there is nothing left to visit by then.
  assert.equal(h.gate.waiting(FP1)?.url, started.url, "the waiting page is given the bank's own address");
  assert.equal(h.gate.waiting(FP2)?.url, undefined, "and only this session's");
  const state = stateOf(h);
  h.gate.acceptCallback({ state, code: "one-time-code-abc" });
  assert.equal(h.gate.waiting(FP1)?.url, undefined, "once the bank has sent him back, there is nowhere to go");
});


test("a flow this service did not make, or whose start failed, leaves nothing behind", async () => {
  const h = makeGate({ api: { startFails: true } });
  await assert.rejects(() => h.gate.start(h.gate.newAction(FP1).token, FP1), /answered 500/);
  assert.equal(h.gate.waiting(FP1), undefined, "no flow is left parked");
  const flows = (h.gate as unknown as { flows: Map<string, unknown> }).flows;
  assert.equal(flows.size, 0, "and nothing of the failed attempt is kept");
});

/* ---------- The callback ---------- */

test("the callback parks the provider's code, and refuses anything it does not recognise", async () => {
  const h = makeGate();
  const action = h.gate.newAction(FP1);
  await h.gate.start(action.token, FP1);
  const state = stateOf(h);

  assert.equal(h.gate.acceptCallback({}).kind, "refused", "no state at all");
  assert.equal(h.gate.acceptCallback({ state: "not-ours", code: "x" }).kind, "refused", "a state this service never made");
  assert.equal(h.gate.acceptCallback({ state: "a".repeat(300), code: "x" }).kind, "refused", "an absurdly long state");
  assert.equal(h.gate.acceptCallback({ state, code: "" }).kind, "refused", "no code");
  assert.equal(h.gate.acceptCallback({ state, code: "c".repeat(5_000) }).kind, "refused", "an absurdly long code");
  assert.equal(h.gate.waiting(FP1)?.parked, false, "and none of those parked anything");
  assert.equal(h.gate.waiting(FP2), undefined, "another session sees nothing of this flow");

  const parked = h.gate.acceptCallback({ state, code: "one-time-code-abc" });
  assert.equal(parked.kind, "parked");
  assert.equal(h.gate.waiting(FP1)?.parked, true);
  assert.equal(h.gate.waiting(FP1)?.aspsp.name, "HSBC UK");

  // A second arrival for the same state changes nothing and keeps the first code.
  const again = h.gate.acceptCallback({ state, code: "a-different-code" });
  assert.equal(again.kind, "refused");
  assert.match((again as { reason: string }).reason, /already been received/);
  const connection = await h.gate.complete(FP1);
  assert.equal(connection.sessionId, "sess-1");
  assert.equal(h.api.calls.find((c) => c.op === "createSession")?.args[0], "one-time-code-abc", "the first code is the one exchanged");
});

test("the bank declining, and a flow that expired before the callback arrived, both fail closed", async () => {
  const a = makeGate();
  await a.gate.start(a.gate.newAction(FP1).token, FP1);
  const stateA = stateOf(a);
  const declined = a.gate.acceptCallback({ state: stateA, error: "access_denied" });
  assert.equal(declined.kind, "declined");
  assert.match((declined as { reason: string }).reason, /did not complete the authorisation \(it said: access_denied\)/);
  assert.equal(a.gate.waiting(FP1), undefined, "the flow is dropped");
  await assert.rejects(() => a.gate.complete(FP1), /no finished authorisation waiting/);
  assert.equal(a.api.calls.some((c) => c.op === "createSession"), false, "nothing was exchanged");

  const b = makeGate();
  await b.gate.start(b.gate.newAction(FP1).token, FP1);
  const stateB = stateOf(b);
  b.advance(BANK_ACTION_TTL_MS * 2);
  assert.equal(b.gate.acceptCallback({ state: stateB, code: "late" }).kind, "refused", "a stale state");
  assert.equal(b.gate.waiting(FP1), undefined);

  // A provider's error that is not ours to show whole: it is scrubbed and clipped.
  const c = makeGate();
  await c.gate.start(c.gate.newAction(FP1).token, FP1);
  const long = `bad ${"Z".repeat(300)} thing\nwith newlines`;
  const outcome = c.gate.acceptCallback({ state: stateOf(c), error: long });
  assert.equal(outcome.kind, "declined");
  assert.ok(!(outcome as { reason: string }).reason.includes("ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ"));
  assert.ok(!(outcome as { reason: string }).reason.includes("\n"));
});

test("a code can only be finished in the session that started the flow", async () => {
  const h = makeGate();
  await h.gate.start(h.gate.newAction(FP1).token, FP1);
  const state = stateOf(h);
  h.gate.acceptCallback({ state, code: "one-time-code-abc" });
  await assert.rejects(() => h.gate.complete(FP2), /no finished authorisation waiting in this session/);
  assert.equal(h.api.calls.some((c) => c.op === "createSession"), false, "so no session was made for it");
  await assert.rejects(() => h.gate.complete(sessionFingerprint(undefined)), /no finished authorisation waiting/);
  const connection = await h.gate.complete(FP1);
  assert.equal(connection.sessionId, "sess-1");
});

test("cancelling forgets the attempt and the code with it", async () => {
  const h = makeGate();
  await h.gate.start(h.gate.newAction(FP1).token, FP1);
  const state = stateOf(h);
  h.gate.acceptCallback({ state, code: "one-time-code-abc" });
  assert.equal(h.gate.cancel(FP1), true);
  assert.equal(h.gate.cancel(FP1), false, "nothing left to cancel");
  assert.equal(h.gate.waiting(FP1), undefined);
  await assert.rejects(() => h.gate.complete(FP1), /no finished authorisation waiting/);
  assert.equal(h.gate.acceptCallback({ state, code: "one-time-code-abc" }).kind, "refused", "and the dropped state is dead");
});

/* ---------- Completing ---------- */

test("a session with no accounts in it is not a connection, and is deleted again", async () => {
  const h = makeGate({ api: { sessionAccounts: [] } });
  await h.gate.start(h.gate.newAction(FP1).token, FP1);
  h.gate.acceptCallback({ state: stateOf(h), code: "one-time-code-abc" });
  await assert.rejects(() => h.gate.complete(FP1), /no accounts in it, which is not a connection/);
  assert.equal(h.api.calls.find((c) => c.op === "deleteSession")?.args[0], "sess-1", "the session it just made is deleted again");
  assert.equal(h.gate.state().kind, "none", "and nothing was stored");
});

test("what is kept is the connection and nothing else: no balance, no transaction, no credential", async () => {
  const h = makeGate();
  const connection = await complete(h);
  assert.deepEqual(Object.keys(connection).sort(), ["accessValidUntil", "accounts", "aspsp", "connectedAt", "scope", "sessionId"]);
  assert.deepEqual(connection.accounts, [], "nothing is readable until the owner chooses");
  assert.equal(connection.scope.join(","), "read");
  const raw = fs.readFileSync(h.bankStore.file(), "utf8");
  for (const secret of ["1234.56", "COFFEE", "one-time-code", "GB33BUKB"]) {
    assert.ok(!raw.includes(secret), `${secret} is not in the stored record`);
  }
  const jobStore = fs.readFileSync(path.join(h.dir, "state.json"), "utf8");
  for (const secret of ["sess-1", "one-time-code", "HSBC", "GB33BUKB", "BANK_APPLICATION_ID", "BANK_JWT_PRIVATE_KEY"]) {
    assert.ok(!jobStore.includes(secret), `nothing of the bank is in the job store: ${secret}`);
  }
});

test("a flow that took too long to finish is refused", async () => {
  const h = makeGate();
  await h.gate.start(h.gate.newAction(FP1).token, FP1);
  h.gate.acceptCallback({ state: stateOf(h), code: "one-time-code-abc" });
  h.advance(BANK_ACTION_TTL_MS * 3);
  await assert.rejects(() => h.gate.complete(FP1), /took too long to finish/);
  assert.equal(h.api.calls.some((c) => c.op === "createSession"), false);
});

/* ---------- Choosing, and reading ---------- */

test("nothing is readable until an account is chosen, and a foreign handle is refused", async () => {
  const h = makeGate();
  await complete(h);
  const listed = await h.gate.accounts();
  assert.equal(listed.accounts.length, 3);
  await assert.rejects(() => h.gate.choose([]), /Choose at least one account/);
  await assert.rejects(() => h.gate.choose(["", "   "]), /Choose at least one account/);
  await assert.rejects(() => h.gate.choose([uidHash("acc-someone-elses", connectionKey(CONNECTION_KEY))]), /not one the provider's session can see/);
  await assert.rejects(() => h.gate.choose(["acc-current"]), /not one the provider's session can see/, "a raw provider id is not a handle");
  const after = await h.gate.state();
  assert.equal(after.kind, "connection");
  assert.deepEqual(after.kind === "connection" ? after.connection.accounts : ["not a connection"], [], "and none of those changed anything");

  const saved = await h.gate.choose([h.gate.handle(HSBC.uid), h.gate.handle(SAVINGS.uid)]);
  assert.equal(saved.accounts.length, 2);
  assert.equal(saved.accounts[0].label, "Everyday Current Account · ••5555");
  assert.ok(!JSON.stringify(saved.accounts).includes("GB33BUKB"), "the full identifier is never written");
  assert.ok(!JSON.stringify(saved.accounts).includes("acc-current"), "nor the provider's own id");
});

test("an account that was not chosen is refused even though the session can see it", async () => {
  const h = makeGate();
  await complete(h);
  await h.gate.choose([h.gate.handle(HSBC.uid)]);
  const balances = await h.gate.balances(h.gate.handle(HSBC.uid));
  assert.equal(balances.account, "Everyday Current Account · ••5555");
  assert.equal(balances.lines[0].amount, "1234.56");
  assert.equal(h.api.calls.find((c) => c.op === "balances")?.args[0], "acc-current", "the provider's own id is used for the call, and only there");

  await assert.rejects(() => h.gate.balances(h.gate.handle(SAVINGS.uid)), /not one you chose for this connection/);
  await assert.rejects(() => h.gate.balances("not-a-handle"), /not one you chose/);
  await assert.rejects(() => h.gate.transactions(h.gate.handle(SECRET.uid), "2026-11-01", "2026-11-15"), /not one you chose/);
  await assert.rejects(() => h.gate.balances(HSBC.uid), /not one you chose/);
  assert.equal(h.api.calls.filter((c) => c.op === "balances").length, 1, "and only the chosen account was ever asked about");
});

test("an account the provider no longer lists is refused rather than guessed at", async () => {
  const h = makeGate();
  await complete(h);
  await h.gate.choose([h.gate.handle(HSBC.uid)]);
  // The provider's own session no longer shows it. The list the page holds is only good for a few
  // minutes, so the clock moves past that first: the provider is asked again, as it would be in use.
  (h.api as unknown as { readSession: () => Promise<unknown> }).readSession = async () => ({ sessionId: "sess-1", accounts: [SAVINGS], aspsp: { name: "HSBC UK", country: "GB" }, scope: ["read"] });
  h.advance(6 * 60 * 1000);
  await assert.rejects(() => h.gate.balances(h.gate.handle(HSBC.uid)), /no longer lists that account/);
});

test("a credit-card account is only ever one the provider's own session listed, never support invented here", async () => {
  // The goal includes credit cards; the provider's own enum is personal and business only, and this
  // connector invents no card type and no card support. A card is whatever the bank's session lists
  // among its accounts, choosable and readable exactly like any other, with the label it was given.
  const h = makeGate({ api: { sessionAccounts: [HSBC, { uid: "acc-card", name: "Credit Card" }] } });
  await complete(h);
  const saved = await h.gate.choose([h.gate.handle("acc-card")]);
  assert.equal(saved.accounts.length, 1);
  assert.equal(saved.accounts[0].label, "Credit Card", "the provider's own name for it, and nothing added");
  const read = await h.gate.balances(h.gate.handle("acc-card"));
  assert.equal(read.account, "Credit Card");
});

test("a disconnected connection is never read from, whatever the record says", async () => {
  const h = makeGate();
  await complete(h);
  await h.gate.choose([h.gate.handle(HSBC.uid)]);
  await h.gate.disconnect();
  await assert.rejects(() => h.gate.balances(h.gate.handle(HSBC.uid)), /There is no bank connection to read from|was disconnected/);
  assert.equal(h.gate.state().kind, "none", "and the record is gone");
});

/* ---------- Dates and paging ---------- */

test("a window is checked before a request is made", () => {
  const s = settings;
  assert.deepEqual(windowCheck("2026-11-01", "2026-11-15", s, "2026-11-15"), { from: "2026-11-01", to: "2026-11-15" });
  const bad: Array<[string, string, RegExp]> = [
    ["2026-11-1", "2026-11-15", /Give both dates as YYYY-MM-DD/],
    ["2026-13-01", "2026-11-15", /Give both dates/],
    ["2026-02-30", "2026-03-01", /Give both dates/],
    ["", "2026-11-15", /Give both dates/],
    ["2026-11-15", "2026-11-01", /first date is after/],
    ["2014-12-31", "2015-01-02", /before this connector would look/],
    ["2026-11-01", "2026-11-20", /ends in the future/],
    ["2020-01-01", "2026-11-15", /reads at most 366 at a time/],
  ];
  for (const [from, to, pattern] of bad) assert.throws(() => windowCheck(from, to, s, "2026-11-15"), pattern, `${from}..${to}`);
  assert.equal(BANK_WINDOW_DAYS_MAX, 366);
  // A window that ends today is fine, and one that ends tomorrow is too (a bank's own time zone).
  assert.deepEqual(windowCheck("2026-11-15", "2026-11-16", s, "2026-11-15"), { from: "2026-11-15", to: "2026-11-16" });
});

test("transactions page to the end, and a safety bound that stops one early is said out loud", async () => {
  const h = makeGate();
  await complete(h);
  await h.gate.choose([h.gate.handle(HSBC.uid)]);
  const handle = h.gate.handle(HSBC.uid);

  // Two pages, ending in a page with no continuation key.
  const paged = makeGate({
    api: {
      pages: [
        { lines: [{ bookingDate: "2026-11-14", description: "ONE", amount: "-1.00", currency: "GBP" }], continuationKey: "k1" },
        { lines: [{ bookingDate: "2026-11-13", description: "TWO", amount: "-2.00", currency: "GBP" }], continuationKey: "k2" },
        { lines: [{ bookingDate: "2026-11-12", description: "THREE", amount: "-3.00", currency: "GBP" }] },
      ],
    },
  });
  await complete(paged);
  await paged.gate.choose([paged.gate.handle(HSBC.uid)]);
  const read = await paged.gate.transactions(paged.gate.handle(HSBC.uid), "2026-11-01", "2026-11-15");
  assert.equal(read.count, 3);
  assert.equal(read.pages, 3);
  assert.equal(read.truncated, false);
  assert.deepEqual(read.lines.map((l) => l.description), ["ONE", "TWO", "THREE"]);
  assert.equal(read.from, "2026-11-01");
  assert.equal(read.to, "2026-11-15");
  assert.equal(read.at, new Date(NOW).toISOString());
  assert.equal(read.account, "Everyday Current Account · ••5555");

  // The page bound: pagesMax is 10, so eleven pages of one line stop early and say so.
  const many = makeGate({
    api: { pages: Array.from({ length: 12 }, (_, i) => ({ lines: [{ bookingDate: "2026-11-14", description: `P${i}`, amount: "-1.00", currency: "GBP" }], continuationKey: `k${i}` })) },
  });
  await complete(many);
  await many.gate.choose([many.gate.handle(HSBC.uid)]);
  const clipped = await many.gate.transactions(many.gate.handle(HSBC.uid), "2026-11-01", "2026-11-15");
  assert.equal(clipped.truncated, true, "the bound is reported, never smoothed over");
  assert.equal(clipped.pages, 10);
  assert.equal(clipped.count, 10);
  assert.equal(clipped.shown, 10);
  assert.equal(clipped.partial, undefined, "the bound has its own words on the page; the gate adds none here");
  assert.ok(!handle.startsWith("acc-"), "and a handle is never the provider's id");
});

test("an empty page that still promises more stops the read, and is said as the partial history it is", async () => {
  // Page two is empty but still carries a continuation key: the provider's paging has gone odd, and
  // the read must neither loop over empty pages nor pretend the history ended cleanly there.
  const empty = makeGate({
    api: {
      pages: [
        { lines: [{ bookingDate: "2026-11-14", description: "ONE", amount: "-1.00", currency: "GBP" }], continuationKey: "k1" },
        { lines: [], continuationKey: "k2" },
        { lines: [{ bookingDate: "2026-11-12", description: "NEVER REACHED", amount: "-3.00", currency: "GBP" }] },
      ],
    },
  });
  await complete(empty);
  await empty.gate.choose([empty.gate.handle(HSBC.uid)]);
  const read = await empty.gate.transactions(empty.gate.handle(HSBC.uid), "2026-11-01", "2026-11-15");
  assert.equal(read.pages, 2, "it stopped on the empty page");
  assert.equal(read.count, 1, "the one real line it had");
  assert.equal(read.truncated, true, "and it is not smoothed over as a clean end");
  assert.match(read.partial ?? "", /empty page but said there was more/);
  assert.equal(empty.api.calls.filter((c) => c.op === "transactions").length, 2, "the page after the empty one was never asked for");
});

test("a page marker the provider already handed back once is a loop, and the read stops rather than spins", async () => {
  // Both pages carry the same continuation key: without the guard this would run to the page bound
  // asking for the same page again and again. It stops on the repeat and says the history is partial.
  const loop = makeGate({
    api: {
      pages: [
        { lines: [{ bookingDate: "2026-11-14", description: "ONE", amount: "-1.00", currency: "GBP" }], continuationKey: "k1" },
        { lines: [{ bookingDate: "2026-11-13", description: "TWO", amount: "-2.00", currency: "GBP" }], continuationKey: "k1" },
        { lines: [{ bookingDate: "2026-11-12", description: "NEVER REACHED", amount: "-3.00", currency: "GBP" }], continuationKey: "k3" },
      ],
    },
  });
  await complete(loop);
  await loop.gate.choose([loop.gate.handle(HSBC.uid)]);
  const read = await loop.gate.transactions(loop.gate.handle(HSBC.uid), "2026-11-01", "2026-11-15");
  assert.equal(read.pages, 2, "the repeat is where it stopped, well before the bound of 10");
  assert.equal(read.count, 2);
  assert.equal(read.truncated, true);
  assert.match(read.partial ?? "", /same page marker twice/);
  assert.equal(loop.api.calls.filter((c) => c.op === "transactions").length, 2, "and the provider was not asked again");
});

test("a read that the provider refuses is one plain sentence, and nothing is stored", async () => {
  const limited = makeGate({ api: { balanceFails: new BankApiError("rate-limit", "The provider is rate limiting this service. Nothing was read; try again shortly.", 429, 5_000) } });
  await complete(limited);
  await limited.gate.choose([limited.gate.handle(HSBC.uid)]);
  await assert.rejects(() => limited.gate.balances(limited.gate.handle(HSBC.uid)), /rate limiting this service/);

  const gone = makeGate({ api: { readFails: new BankApiError("missing", "The provider no longer has that bank session, so there is nothing to read from it.") } });
  await complete(gone);
  await assert.rejects(() => gone.gate.accounts(true), /no longer has that bank session/);
  assert.equal(gone.gate.state().kind, "connection", "the record is left alone: the failure is the provider's, not the record's");
});

/* ---------- Disconnect ---------- */

test("disconnecting blocks local reads first, deletes the provider's session, and destroys the record", async () => {
  const h = makeGate();
  await complete(h);
  await h.gate.choose([h.gate.handle(HSBC.uid)]);
  const report = await h.gate.disconnect();

  assert.equal(h.api.calls.find((c) => c.op === "deleteSession")?.args[0], "sess-1");
  assert.match(report.local, /Local reads are off from now on/);
  assert.match(report.vendor, /The provider's record of the session was deleted/);
  assert.match(report.bank, /The bank's own consent is the bank's record, and this service cannot revoke it from here/);
  assert.match(report.bank, /revoke the ClearOps access in the HSBC UK app or in online banking/);
  assert.match(report.bank, /2027-02-13T00:00:00Z/, "and says when it was due to expire anyway");
  assert.match(report.record, /destroyed with the record/);
  assert.equal(h.bankStore.state(CONNECTION_KEY).kind, "none", "the record is gone");
  assert.equal(fs.existsSync(h.bankStore.file()), false);
  await assert.rejects(() => h.gate.disconnect(), /no bank connection stored here/);
});

test("a provider that cannot be reached leaves local reads off and keeps the session id only to try again", async () => {
  const h = makeGate({ api: { deleteFails: true } });
  await complete(h);
  await h.gate.choose([h.gate.handle(HSBC.uid)]);
  const report = await h.gate.disconnect();

  assert.match(report.vendor, /could NOT be deleted: The provider could not be reached/);
  assert.match(report.record, /kept for one reason only: so the delete can be tried again/);
  assert.match(report.local, /Local reads are off from now on/);
  const state = h.bankStore.state(CONNECTION_KEY);
  assert.equal(state.kind, "connection", "the record survives so the delete can be retried");
  assert.equal((state as { connection: { disconnectedAt?: string } }).connection.disconnectedAt !== undefined, true);
  await assert.rejects(() => h.gate.balances(h.gate.handle(HSBC.uid)), /disconnected/);
  await assert.rejects(() => h.gate.accounts(), /disconnected/);

  // Trying again: the delete is called once more, and this time it works.
  (h.api as unknown as { deleteSession: () => Promise<void> }).deleteSession = async () => {};
  const second = await h.gate.disconnect();
  assert.match(second.vendor, /was deleted/);
  assert.equal(h.bankStore.state(CONNECTION_KEY).kind, "none");
});

test("the record blocks local reads before the provider is called at all", async () => {
  const h = makeGate();
  await complete(h);
  await h.gate.choose([h.gate.handle(HSBC.uid)]);
  let sawBlockedRecord = false;
  (h.api as unknown as { deleteSession: (id: string) => Promise<void> }).deleteSession = async () => {
    // The moment the provider's delete is in flight, the stored record already refuses reads.
    const state = h.bankStore.state(CONNECTION_KEY);
    sawBlockedRecord = state.kind === "connection" && !!state.connection.disconnectedAt;
    await assert.rejects(() => h.gate.balances(h.gate.handle(HSBC.uid)), /disconnected/);
  };
  await h.gate.disconnect();
  assert.equal(sawBlockedRecord, true, "the local block is written before the provider is asked anything");
});

/* ---------- The settings the gate depends on ---------- */

test("the redirect address and the country are exactly what was configured", async () => {
  // Settings from a synthetic literal, never from this process's own environment: a bank test must
  // not be able to load real credentials even on a host that has them.
  const h = makeGate({ settings: bankSettings({ BANK_ENABLED: "true", BANK_APPLICATION_ID: "app", BANK_JWT_PRIVATE_KEY: "key", BANK_CONNECTION_KEY: CONNECTION_KEY, BANK_REDIRECT_URL: "https://workforce.example/bank/callback", BANK_COUNTRY: "gb" }) });
  await h.gate.start(h.gate.newAction(FP1).token, FP1);
  assert.deepEqual(h.api.calls.find((c) => c.op === "listAspsps")?.args[0], "GB");
  assert.equal((h.api.calls.find((c) => c.op === "startAuthorisation")?.args[0] as { redirectUrl: string }).redirectUrl, "https://workforce.example/bank/callback");
  // A redirect address with a query in it would be one the provider could not match: refused at load.
  const bad = bankSettings({ BANK_ENABLED: "true", BANK_APPLICATION_ID: "a", BANK_JWT_PRIVATE_KEY: "k", BANK_CONNECTION_KEY: CONNECTION_KEY, BANK_REDIRECT_URL: "https://workforce.example/bank/callback?x=1" });
  assert.match(bankReady(bad) ?? "", /must not carry a query or a fragment/);
});

test("two sessions have two fingerprints, and a page's CSRF token belongs to one session only", () => {
  assert.notEqual(FP1, FP2);
  assert.equal(FP1, sessionFingerprint(`${SESSION_COOKIE}=v1.1.first-session-signature`), "and it is the same for the same cookie");
  assert.match(FP1, /^[0-9a-f]{64}$/);
  const h = makeGate();
  const token = h.gate.csrf(FP1);
  assert.ok(token && token.length > 20);
  assert.equal(h.gate.csrfOk(token, FP1), true);
  assert.equal(h.gate.csrfOk(token, FP2), false, "one session's form is not another's");
  assert.equal(h.gate.csrfOk("made-up", FP1), false);
  assert.equal(h.gate.csrfOk(undefined, FP1), false);
  assert.equal(h.gate.csrf(""), h.gate.csrf(""), "an unsigned-in fingerprint is just another string; the router never lets a request this far");
  // With no page password there is no session key, so there is no token to accept.
  const bare = makeGate();
  bare.store.setSetting("pagePassword", undefined);
  assert.equal(bare.gate.csrf(FP1), undefined);
  assert.equal(bare.gate.csrfOk("anything", FP1), false);
});
