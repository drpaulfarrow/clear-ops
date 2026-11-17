/**
 * The provider client: the operation allowlist, the signing token, the address it may call, the shapes
 * it reads and the words it uses when something goes wrong.
 *
 * No network and no real bank: every call here goes to a fake `fetch` that answers with synthetic
 * replies in the shapes the provider's public documentation describes (and that a live application has
 * not been tried against: see docs/BANK.md). The tests are mostly about what must never happen: no
 * payment operation reachable, no signing key or application id in a message, no call anywhere but the
 * provider's own host, and a reply that is not understood said plainly rather than guessed at.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bankTestBoundary } from "./bank-synthetic.js";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-bank-api-"));
process.env.PUBLIC_URL = "https://workforce.example";
// The synthetic-only boundary: no BANK_ variable of the host's reaches this process, and a call that
// would leave for the provider fails loudly rather than going (test/bank-synthetic.ts).
bankTestBoundary();

const {
  BANK_OPERATIONS,
  PAYMENT_SHAPED,
  paymentShapedStatics,
  routeOf,
  bankJwt,
  scrub,
  parseAspsps,
  parseSession,
  parseBalances,
  parseTransactions,
  pickHsbcUkPersonal,
  parseAuthUrl,
  authUrlOk,
  providerSentence,
  rateLimitSentence,
  BankApi,
  BankApiError,
  bankFailureSentence,
  idFingerprint,
} = await import("../src/bank-api.js");
const { bankSettings, bankReady, checkBaseUrl, pemFromEnv, BankError, BANK_SECRETS } = await import("../src/bank.js");

const { privateKey: RSA_KEY, publicKey: RSA_PUBLIC } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const { privateKey: SMALL_KEY } = generateKeyPairSync("rsa", {
  modulusLength: 1024,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const { privateKey: EC_KEY } = generateKeyPairSync("ec", {
  namedCurve: "P-256",
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const APPLICATION_ID = "11111111-2222-3333-4444-555555555555";
const CONNECTION_KEY = "connection key that is long enough to be a key";

const settings = (over: Record<string, unknown> = {}) => ({
  ...bankSettings({
    BANK_ENABLED: "true",
    BANK_APPLICATION_ID: APPLICATION_ID,
    BANK_JWT_PRIVATE_KEY: RSA_KEY,
    BANK_CONNECTION_KEY: CONNECTION_KEY,
    BANK_REDIRECT_URL: "https://workforce.example/bank/callback",
  }),
  ...over,
}) as ReturnType<typeof bankSettings>;

/** One recorded request, and a fake provider that answers by path. */
function provider(routes: Record<string, unknown | (() => Response)>, over: Record<string, unknown> = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const path2 = new URL(url).pathname;
    const key = `${init.method ?? "GET"} ${path2}`;
    const route = routes[key] ?? routes[path2] ?? routes[`${path2}*`];
    if (route === undefined) return new Response("{}", { status: 404 });
    if (typeof route === "function") return route();
    return new Response(JSON.stringify(route), { status: 200, headers: { "content-type": "application/json" } });
  };
  const api = new BankApi({ settings: settings(over), fetchImpl, now: () => Date.UTC(2026, 10, 15, 9, 0, 0) });
  return { api, calls };
}

/* ---------- The allowlist ---------- */

test("the operations are the reads plus one session delete, and nothing else", () => {
  const seen = new Map(Object.entries(BANK_OPERATIONS).map(([op, r]) => [`${r.method} ${r.path}`, op]));
  assert.equal(routeOf("GET", "/aspsps"), "list-aspsps");
  assert.equal(routeOf("get", "/aspsps?country=GB"), "list-aspsps", "case and query are not part of the identity of an operation");
  assert.equal(routeOf("POST", "/auth"), "start-authorisation");
  assert.equal(routeOf("POST", "/sessions"), "create-session");
  assert.equal(routeOf("GET", "/sessions/abc-123"), "read-session");
  assert.equal(routeOf("DELETE", "/sessions/abc-123"), "delete-session");
  assert.equal(routeOf("GET", "/accounts/abc-123/details"), "account-details");
  assert.equal(routeOf("GET", "/accounts/abc-123/balances"), "account-balances");
  assert.equal(routeOf("GET", "/accounts/abc-123/transactions"), "account-transactions");
  assert.equal(seen.size, 8, "eight operations, each one place in this table");
  // Nothing else, in either direction.
  assert.equal(routeOf("POST", "/sessions/abc-123"), undefined, "a session is not started at a session's own address");
  assert.equal(routeOf("GET", "/accounts/abc-123"), undefined);
  assert.equal(routeOf("PUT", "/accounts/abc-123/balances"), undefined);
  assert.equal(routeOf("GET", "/accounts/abc-123/balances/extra"), undefined);
});

test("no payment operation exists or is reachable, whatever it is called", () => {
  const forbidden = [
    "POST /payments",
    "POST /payments/sepa-credit-transfers",
    "POST /accounts/abc/payments",
    "POST /accounts/abc/payments/sepa-credit-transfers",
    "POST /bulk-payments",
    "POST /periodic-payments",
    "POST /domestic-payments",
    "POST /transfer",
    "POST /transfers",
    "POST /funds-confirmations",
    "POST /beneficiaries",
    "POST /standing-orders",
    "POST /direct-debits",
    "POST /pisp/payments",
    "POST /consents/abc/payment",
    "POST /payments/abc/authorisations",
  ];
  for (const line of forbidden) {
    const [method, p] = line.split(" ");
    assert.equal(routeOf(method, p), undefined, `${line} must not resolve to any operation`);
  }
  // The belt: a route whose own words are payment-shaped is refused even if it once matched a template.
  assert.ok(paymentShapedStatics(["accounts", "{account}", "payments"]));
  assert.ok(paymentShapedStatics(["{x}", "payments"]));
  assert.ok(!paymentShapedStatics(["accounts", "{account}", "balances"]));
  assert.ok(!paymentShapedStatics(["sessions", "{session}"]));
  // And the words themselves cover the ways a payment could be named.
  for (const word of ["payments", "transfer", "beneficiary", "bulk", "funds", "standing-orders", "domestic", "sepa", "pisp", "fx", "top-up"]) {
    assert.ok(PAYMENT_SHAPED.test(word), `${word} is refused as payment-shaped`);
  }
  // No route in the table is payment-shaped at all.
  for (const [op, route] of Object.entries(BANK_OPERATIONS)) {
    assert.ok(!paymentShapedStatics(route.path.split("/").filter(Boolean)), `${op} is not payment-shaped`);
  }
});

test("the client refuses an identifier, a query key or a body it was not built with", async () => {
  const { api, calls } = provider({});
  await assert.rejects(() => api.call("account-balances", { params: { account: "../../aspsps" } }), /will not put in a request/);
  await assert.rejects(() => api.call("account-balances", { params: { account: "a/b" } }), /will not put in a request/);
  await assert.rejects(() => api.call("account-transactions", { params: { account: "abc" }, query: { date_from: "2026-01-01", account_id: "x" } }), /not one this connector is allowed/);
  await assert.rejects(() => api.call("account-transactions", { params: { account: "abc" }, query: { date_from: "2026-01-01", date_to: "2026-01-02", continue: "x" } }), /not one this connector is allowed/);
  await assert.rejects(() => api.call("list-aspsps", { body: { anything: true } }), /not one this connector is allowed/);
  assert.equal(calls.length, 0, "nothing left this process");
});

/* ---------- The signing token ---------- */

test("the application token is RS256, short-lived, and carries nothing of ours but its id", async () => {
  const jwt = bankJwt({ applicationId: APPLICATION_ID, privateKey: RSA_KEY, issuer: "enablebanking.com", audience: "api.enablebanking.com", ttlSeconds: 300, now: Date.UTC(2026, 10, 15, 9, 0, 0) });
  const [head, body, sig] = jwt.split(".");
  const header = JSON.parse(Buffer.from(head, "base64url").toString());
  const payload = JSON.parse(Buffer.from(body, "base64url").toString());
  assert.deepEqual(header, { typ: "JWT", alg: "RS256", kid: APPLICATION_ID });
  assert.equal(payload.iss, "enablebanking.com");
  assert.equal(payload.aud, "api.enablebanking.com");
  assert.equal(payload.exp - payload.iat, 300, "a short token, as the provider documents");
  assert.equal(payload.iat, Date.UTC(2026, 10, 15, 9, 0, 0) / 1000);
  // The signature is real: it verifies against the public half with the algorithm named above.
  const { createVerify } = await import("node:crypto");
  assert.ok(createVerify("RSA-SHA256").update(`${head}.${body}`).verify(RSA_PUBLIC, Buffer.from(sig, "base64url")));
  // The key material is nowhere in it, and neither is anything else of ours.
  assert.ok(!jwt.includes("BEGIN"), "no key material");
  assert.ok(!jwt.includes(CONNECTION_KEY));

  // A life is clamped to the provider's hour, and never below a minute.
  assert.equal(JSON.parse(Buffer.from(bankJwt({ applicationId: APPLICATION_ID, privateKey: RSA_KEY, issuer: "i", audience: "a", ttlSeconds: 999_999 }).split(".")[1], "base64url").toString()).exp - JSON.parse(Buffer.from(bankJwt({ applicationId: APPLICATION_ID, privateKey: RSA_KEY, issuer: "i", audience: "a", ttlSeconds: 999_999 }).split(".")[1], "base64url").toString()).iat, 3_600);
  const short = bankJwt({ applicationId: APPLICATION_ID, privateKey: RSA_KEY, issuer: "i", audience: "a", ttlSeconds: 1 });
  const shortPayload = JSON.parse(Buffer.from(short.split(".")[1], "base64url").toString());
  assert.equal(shortPayload.exp - shortPayload.iat, 60);
});

test("a key that is not an RSA private key says so, and never quotes itself", () => {
  const cases: Array<[string, RegExp]> = [
    ["not a key at all", /not a private key in PEM form/],
    [EC_KEY, /must be an RSA private key/],
    [SMALL_KEY, /shorter than 2048 bits/],
  ];
  for (const [key, pattern] of cases) {
    assert.throws(
      () => bankJwt({ applicationId: APPLICATION_ID, privateKey: key, issuer: "i", audience: "a", ttlSeconds: 300 }),
      (err: unknown) => {
        assert.ok(err instanceof BankError);
        assert.match(err.message, pattern);
        const middle = key.slice(30, 60);
        if (middle.length > 8) assert.ok(!err.message.includes(middle), "the key itself is never in the message");
        assert.match(err.message, /^[ -~]*$/, "and it is one plain line");
        return true;
      },
    );
  }
  assert.throws(() => bankJwt({ applicationId: "", privateKey: RSA_KEY, issuer: "i", audience: "a", ttlSeconds: 300 }), /no provider application id/);
  assert.throws(() => bankJwt({ applicationId: APPLICATION_ID, privateKey: "", issuer: "i", audience: "a", ttlSeconds: 300 }), /no signing key/);
});

test("a private key written into one environment variable keeps its newlines", () => {
  const oneLine = RSA_KEY.replace(/\n/g, "\\n");
  assert.equal(pemFromEnv(oneLine), RSA_KEY);
  assert.equal(pemFromEnv(RSA_KEY), RSA_KEY);
  assert.ok(bankJwt({ applicationId: APPLICATION_ID, privateKey: pemFromEnv(oneLine), issuer: "i", audience: "a", ttlSeconds: 300 }).split(".").length === 3);
});

/* ---------- One address ---------- */

test("every call goes to the provider's own host over https, and nowhere else", async () => {
  const { api, calls } = provider({ "GET /aspsps": { aspsps: [{ name: "HSBC UK", country: "GB" }] } });
  await api.listAspsps("GB");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.enablebanking.com/aspsps?country=GB&psu_type=personal");
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization.startsWith("Bearer ey"), true);
  assert.equal(calls[0].init.redirect, "error", "a redirect is an error, not something to follow");
  assert.equal(calls[0].init.cache, "no-store");

  // A settings object naming another host is refused before anything leaves, even though it was built by
  // hand rather than from the environment.
  const elsewhere = new BankApi({ settings: settings({ baseUrl: "https://bank.example", host: "bank.example" }), fetchImpl: async () => new Response("{}") });
  await assert.rejects(() => elsewhere.listAspsps("GB"), /somewhere other than the provider/);
});

test("a base URL that is not the documented one turns the connector off rather than calling it", () => {
  const bad = bankSettings({ BANK_ENABLED: "true", BANK_API_BASE_URL: "https://bank.example" });
  assert.match(bankReady(bad) ?? "", /must be one of api\.enablebanking\.com/);
  assert.equal(bad.baseUrl, "https://api.enablebanking.com", "and the default is what would be used, never the odd address");
  assert.equal(checkBaseUrl("http://api.enablebanking.com").ok, false, "https only");
  assert.equal(checkBaseUrl("not a url").ok, false);
  assert.equal(checkBaseUrl("https://api.enablebanking.com/").ok, true);
  const good = bankSettings({ BANK_ENABLED: "true", BANK_APPLICATION_ID: APPLICATION_ID, BANK_JWT_PRIVATE_KEY: RSA_KEY, BANK_CONNECTION_KEY: CONNECTION_KEY, BANK_REDIRECT_URL: "https://workforce.example/bank/callback" });
  assert.equal(bankReady(good), undefined, "and a complete configuration is ready");
  assert.equal(bankReady(bankSettings({})), "The bank connector is switched off here (BANK_ENABLED is not set), so nothing is read from any bank.");
  assert.match(bankReady({ ...good, connectionKey: "short" }) ?? "", /no connection key/);
});

/* ---------- The reply shapes ---------- */

test("the bank list is read as the provider sent it, and the HSBC UK personal entry comes from it", () => {
  const list = parseAspsps({
    aspsps: [
      { name: "Monzo", country: "GB", logo: "x" },
      { name: "HSBC UK Business", country: "GB" },
      { name: "HSBC UK Premier", country: "GB", psu_types: ["personal"] },
      { name: "HSBC UK", country: "GB", psu_types: ["personal", "business"], bic: "HBUKGB4B" },
      { name: "Some junk", country: "GB" },
      { country: "GB" },
      "not an object",
    ],
  });
  assert.equal(list.length, 5, "an entry with no name, and an entry that is not an object at all, are left out");
  assert.ok(list.every((a) => a.name && a.country), "what is kept is usable: a name to show and a country to match");
  assert.equal(list.find((a) => a.name === "Monzo")?.country, "GB");
  assert.equal(pickHsbcUkPersonal(list).name, "HSBC UK", "the plainest HSBC UK name with a personal use, taken from the list itself");

  // The provider's own marking decides when the names do not.
  const marked = parseAspsps({ aspsps: [{ name: "HSBC UK", country: "GB", psu_types: ["business"] }, { name: "HSBC Bank plc", country: "GB", psu_types: ["personal"] }] });
  assert.equal(pickHsbcUkPersonal(marked).name, "HSBC Bank plc");

  // An explicit non-personal marking is never fallen back past, whatever the entry is called: a lone
  // business-only HSBC entry (even one whose name looks personal) is refused, not used.
  for (const lone of [
    [{ name: "HSBC UK", country: "GB", psu_types: ["business"] }],
    [{ name: "HSBCUK", country: "GB", psu_types: ["business"] }],
  ] as const) {
    assert.throws(() => pickHsbcUkPersonal(parseAspsps({ aspsps: [...lone] })), /business ones/, `${lone[0].name} is business-only and must not be used`);
  }
  // An entry the provider marks as personal is the supported one, and an unmarked entry stays eligible.
  assert.equal(pickHsbcUkPersonal(parseAspsps({ aspsps: [{ name: "HSBC UK", country: "GB", psu_types: ["personal"] }] })).name, "HSBC UK");
  assert.equal(pickHsbcUkPersonal(parseAspsps({ aspsps: [{ name: "HSBC UK", country: "GB" }] })).name, "HSBC UK", "no psu_types at all is the provider not saying, not a refusal");

  // Nothing to pick, or more than one thing that could be it, is refused in plain words rather than guessed.
  assert.throws(() => pickHsbcUkPersonal(parseAspsps({ aspsps: [{ name: "Monzo", country: "GB" }] })), /none of them is HSBC/);
  assert.throws(() => pickHsbcUkPersonal(parseAspsps({ aspsps: [{ name: "HSBC UK Business", country: "GB" }] })), /only HSBC GB entries are business ones/);
  assert.throws(() => pickHsbcUkPersonal(parseAspsps({ aspsps: [{ name: "HSBC UK", country: "IE" }] })), /no banks for GB/);
  assert.throws(() => pickHsbcUkPersonal(parseAspsps({ aspsps: [{ name: "HSBC Premier Account", country: "GB" }, { name: "HSBC Advance", country: "GB" }] })), /more than one HSBC GB entry/);
  assert.throws(() => parseAspsps({}), /not in a shape this connector understands/);
  assert.throws(() => parseAspsps({ aspsps: [] }), /not in a shape/);
});

test("a session, a balance list and a page of transactions are read as they come", () => {
  const session = parseSession({
    session_id: "sess-1",
    accounts: [
      { uid: "acc-1", account_id: { iban: "GB33BUKB20201555555555" }, name: "Everyday Current Account", currency: "GBP" },
      { uid: "acc-2", account_id: { other: { identification: "12345678" } } },
      { account_id: { iban: "GB00" } },
      { uid: "acc-3", name: "Savings" },
    ],
    aspsp: { name: "HSBC UK", country: "gb" },
    access: { valid_until: "2027-02-13T00:00:00Z" },
    scope: "read",
  });
  assert.equal(session.sessionId, "sess-1");
  assert.equal(session.accounts.length, 3, "an account with no id at all is not usable and is left out");
  assert.equal(session.accounts[0].iban, "GB33BUKB20201555555555");
  assert.equal(session.accounts[1].iban, "12345678");
  assert.deepEqual(session.aspsp, { name: "HSBC UK", country: "GB" });
  assert.deepEqual(session.scope, ["read"]);
  assert.equal(session.accessValidUntil, "2027-02-13T00:00:00Z");
  assert.throws(() => parseSession({ accounts: [] }), /not in a shape/);

  const balances = parseBalances({
    balances: [
      { name: "Booked", balance_type: "ITBD", balance_amount: { currency: "gbp", amount: "1234.56" } },
      { balance_type: "ITAV", balance_amount: { currency: "GBP", amount: "-12.34" }, reference_date: "2026-11-15" },
      { balance_type: "no amount" },
      { name: "odd", balance_type: "weird", balance_amount: { currency: "GBP", amount: "not a number at all really" } },
    ],
  });
  assert.equal(balances.length, 3);
  assert.equal(balances[0].currency, "GBP");
  assert.equal(balances[0].type, "ITBD", "the provider's documented ISO 20022 codes, shown as its own words");
  assert.equal(balances[1].amount, "-12.34");
  assert.equal(balances[1].asOf, "2026-11-15");
  assert.equal(balances[2].amount, "not a number at all really", "an amount that is not a number is shown as the provider's words, not as a guess");
  assert.throws(() => parseBalances({}), /not in a shape/);

  const txns = parseTransactions({
    transactions: [
      { entry_reference: "ref-1", transaction_amount: { currency: "GBP", amount: "-4.20" }, creditor: { name: "COFFEE SHOP" }, booking_date: "2026-11-14", status: "BOOK" },
      { transaction_amount: { currency: "GBP", amount: "2500.00" }, remittance_information: ["SALARY", "NOVEMBER"], value_date: "2026-11-13" },
      { transaction_amount: { currency: "GBP", amount: "1.00" } },
    ],
    continuation_key: "next-page",
  });
  assert.equal(txns.lines.length, 3);
  assert.equal(txns.lines[0].description, "COFFEE SHOP");
  assert.equal(txns.lines[1].description, "SALARY NOVEMBER");
  assert.equal(txns.lines[2].description, "no description given");
  assert.equal(txns.lines[2].bookingDate, "", "a missing date is left empty, not invented");
  assert.equal(txns.continuationKey, "next-page");
  assert.throws(() => parseTransactions({ transactions: "no" }), /not in a shape/);
});

test("a read-session reply is read in its own documented shape, not the create-session's", () => {
  // GET /sessions/{session} (GetSessionResponse in the provider's published specification): no session
  // id of its own, accounts as bare id strings, the same uids again in `accounts_data` with no names
  // among them. (POST /sessions answers with the full AccountResource objects the test above uses.)
  const read = parseSession(
    {
      status: "AUTHORIZED",
      accounts: ["497f6eca-6276-4993-bfeb-53cbbbba6f08", "0f4a2d1e-1111-2222-3333-444455556666"],
      accounts_data: [
        { uid: "497f6eca-6276-4993-bfeb-53cbbbba6f08", identification_hash: "hash-a", identification_hashes: ["hash-a"] },
        { uid: "c4f3aaaa-7777-8888-9999-000000001111", identification_hash: "hash-c", identification_hashes: ["hash-c"] },
      ],
      aspsp: { name: "HSBC UK", country: "GB" },
      psu_type: "personal",
      access: { valid_until: "2027-02-13T00:00:00Z", balances: true, transactions: true },
      created: "2026-11-15T09:00:00Z",
    },
    "sess-1",
  );
  assert.equal(read.sessionId, "sess-1", "the id is the one from the path: the reply carries none of its own");
  assert.deepEqual(
    read.accounts.map((a) => a.uid),
    ["497f6eca-6276-4993-bfeb-53cbbbba6f08", "0f4a2d1e-1111-2222-3333-444455556666", "c4f3aaaa-7777-8888-9999-000000001111"],
    "both documented lists, deduped, and nothing dropped",
  );
  assert.ok(read.accounts.every((a) => a.name === undefined && a.iban === undefined), "a read-session account is a uid and no label: the page says unnamed rather than inventing one");
  assert.equal(read.accessValidUntil, "2027-02-13T00:00:00Z");
  // And a reply with no id anywhere is still a shape error, never a guess.
  assert.throws(() => parseSession({ accounts: ["x"] }), /not in a shape/);
  assert.throws(() => parseSession({ accounts: ["x"] }, "  "), /not in a shape/);
});

test("the address the bank sends the browser to must be https", () => {
  assert.equal(parseAuthUrl({ url: "https://api.enablebanking.com/auth?state=x" }), "https://api.enablebanking.com/auth?state=x");
  assert.throws(() => parseAuthUrl({ url: "http://api.enablebanking.com/auth" }), /not https/);
  assert.throws(() => parseAuthUrl({ url: "javascript:alert(1)" }), /not https/);
  assert.throws(() => parseAuthUrl({}), /did not give an address/);
  assert.equal(authUrlOk("http://127.0.0.1:1234/auth", true).ok, true, "the local preview may use loopback");
  assert.equal(authUrlOk("http://127.0.0.1:1234/auth").ok, false, "and nothing else may");
});

/* ---------- Failures, said plainly ---------- */

test("each kind of refusal from the provider becomes one plain sentence", async () => {
  const answer = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
    provider({ "GET /accounts/abc/balances": () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } }) });

  const credential = answer(401, { message: `bad key ${APPLICATION_ID}` });
  await assert.rejects(() => credential.api.balances("abc"), (err: unknown) => {
    assert.ok(err instanceof BankApiError);
    assert.equal(err.kind, "credential");
    assert.match(err.message, /refused this service's application key/);
    assert.ok(!err.message.includes(APPLICATION_ID), "the application id is not echoed back");
    return true;
  });

  const limited = answer(429, {}, { "retry-after": "7" });
  await assert.rejects(() => limited.api.balances("abc"), (err: unknown) => {
    assert.equal((err as InstanceType<typeof BankApiError>).kind, "rate-limit");
    assert.equal((err as InstanceType<typeof BankApiError>).retryAfterMs, 7_000);
    assert.match((err as Error).message, /about 7 seconds/);
    return true;
  });

  const gone = answer(404);
  await assert.rejects(() => gone.api.balances("abc"), (err: unknown) => {
    assert.equal((err as InstanceType<typeof BankApiError>).kind, "missing");
    assert.match((err as Error).message, /no longer has that bank session/);
    return true;
  });

  const expired = answer(400, { message: "consent has expired" });
  await assert.rejects(() => expired.api.balances("abc"), (err: unknown) => {
    assert.equal((err as InstanceType<typeof BankApiError>).kind, "consent");
    assert.match((err as Error).message, /consent for this connection has expired or was withdrawn/);
    return true;
  });

  const broken = answer(500, { message: `boom ${APPLICATION_ID} eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJlIn0.abcdefgh` });
  await assert.rejects(() => broken.api.balances("abc"), (err: unknown) => {
    assert.equal((err as InstanceType<typeof BankApiError>).kind, "provider");
    assert.match((err as Error).message, /answered 500/);
    assert.ok(!(err as Error).message.includes(APPLICATION_ID), "nor is the application id");
    assert.ok(!(err as Error).message.includes("eyJhbGciOiJSUzI1NiJ9"), "nor a token-shaped value from the provider's body");
    return true;
  });

  const nowhere = provider({ "GET /accounts/abc/balances": () => { throw new Error("getaddrinfo ENOTFOUND"); } });
  await assert.rejects(() => nowhere.api.balances("abc"), (err: unknown) => {
    assert.equal((err as InstanceType<typeof BankApiError>).kind, "network");
    assert.match((err as Error).message, /could not be reached/);
    return true;
  });

  const nonsense = provider({ "GET /accounts/abc/balances": () => new Response("<html>hello</html>", { status: 200 }) });
  await assert.rejects(() => nonsense.api.balances("abc"), /not in a shape this connector understands/);
});

test("a refused request says so without a status number standing alone", () => {
  assert.match(bankFailureSentence(new BankApiError("refused", "nope")), /^nope$/);
  assert.match(providerSentence(503), /\(it answered 503\)/);
  assert.match(rateLimitSentence(3_000), /about 3 seconds/);
  assert.equal(rateLimitSentence(), "The provider is rate limiting this service. Nothing was read; try again shortly.");
  assert.match(idFingerprint("sess-123"), /^[0-9a-f]{12}$/);
});

test("scrubbing keeps a token, a key or a long value out of any sentence", () => {
  const token = "eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJlbmFibGViYW5raW5nLmNvbSJ9.c2lnbmF0dXJlLWhlcmU";
  const clean = scrub(`failed with ${token} and ${"A".repeat(120)} and "quotes" and\nnewlines`, [APPLICATION_ID]);
  assert.ok(!clean.includes(token));
  assert.ok(!clean.includes("A".repeat(80)));
  assert.ok(!clean.includes('"'));
  assert.ok(!clean.includes("\n"));
  assert.ok(clean.length <= 120);
  assert.equal(scrub(`key ${APPLICATION_ID}`, [APPLICATION_ID]), "key [secret]");
  assert.equal(scrub(""), "");
});

/* ---------- Paging ---------- */

test("transactions page to the end, and an identifier that merely looks like money is not refused", async () => {
  const pages = [
    { transactions: [{ transaction_amount: { currency: "GBP", amount: "-1.00" }, booking_date: "2026-11-14" }], continuation_key: "k1" },
    { transactions: [{ transaction_amount: { currency: "GBP", amount: "-2.00" }, booking_date: "2026-11-13" }] },
  ];
  let i = 0;
  const calls: string[] = [];
  const api = new BankApi({
    settings: settings(),
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response(JSON.stringify(pages[i++]), { status: 200 });
    },
  });
  const uid = "account-with-pay-in-its-id-9f2b";
  const first = await api.transactions(uid, { from: "2026-11-01", to: "2026-11-15" });
  assert.equal(first.lines.length, 1);
  assert.equal(first.continuationKey, "k1");
  const second = await api.transactions(uid, { from: "2026-11-01", to: "2026-11-15", continuationKey: first.continuationKey });
  assert.equal(second.lines.length, 1);
  assert.equal(second.continuationKey, undefined);
  assert.equal(calls.length, 2);
  assert.match(calls[0], /\/accounts\/account-with-pay-in-its-id-9f2b\/transactions\?date_from=2026-11-01&date_to=2026-11-15$/);
  assert.match(calls[1], /continuation_key=k1$/);
});

test("the client can only be pointed at the provider, whatever settings it is given", async () => {
  // The base URL and host travel together in settings a test or the environment builds; a settings object
  // whose host does not match its own base URL is refused rather than followed.
  const api = new BankApi({ settings: settings({ baseUrl: "https://api.enablebanking.com", host: "api.enablebanking.com.evil.example" }), fetchImpl: async () => new Response("{}") });
  await assert.rejects(() => api.listAspsps("GB"), /somewhere other than the provider/);
});

test("the secrets this connector owns are named in one place", () => {
  assert.deepEqual(BANK_SECRETS, ["BANK_APPLICATION_ID", "BANK_JWT_PRIVATE_KEY", "BANK_CONNECTION_KEY"]);
});
