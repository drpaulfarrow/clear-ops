/**
 * The provider client: the only place in this service that talks to a bank's data provider, and the
 * only place that signs a request.
 *
 * Three rules live here and nowhere else:
 *
 *  1. **The operation allowlist.** Every request is one of a fixed set of reads (the bank list, starting
 *     an authorisation, exchanging a one-time code for a session, reading a session, an account's
 *     details, its balances and a date-bounded transaction list) plus the single session delete that
 *     disconnect needs. `routeOf` is the only thing that turns a method and a path into a request, and
 *     anything payment-shaped (a payment, a transfer, a standing order, a beneficiary, a domestic
 *     payment, funds confirmation, a bulk payment, an FX or PISP call) is refused before it is matched
 *     against anything: there is no such operation in this module, so none can be reached through it.
 *  2. **One address.** Every request goes to the provider's documented host over https, whatever the
 *     environment says, and a redirect is an error rather than something to follow.
 *  3. **Nothing else gets out.** The signing key, the application id and the session's one-time code
 *     never appear in a message, an error or anything the page or a log could print: every outgoing
 *     line is scrubbed, and no reply body is ever copied into a sentence whole.
 *
 * The reply shapes are parsed defensively: this connector shows what the provider actually said, and
 * says plainly when a reply is not in a shape it understands, rather than guessing. The shapes
 * themselves (paths, field names, the RS256 JWT the provider takes) come from the provider's public
 * documentation and general knowledge of the AIS standard; they have been written here without a live
 * application, and the tests use synthetic replies in those shapes only.
 */
import { createHash, createPrivateKey, createSign } from "node:crypto";
import { BANK_JWT_TTL_SECONDS_MAX, BankError, checkBaseUrl, type BankSettings } from "./bank.js";

/* ---------- The allowlist ---------- */

export type BankOperation =
  | "list-aspsps"
  | "start-authorisation"
  | "create-session"
  | "read-session"
  | "delete-session"
  | "account-details"
  | "account-balances"
  | "account-transactions";

export interface BankRoute {
  method: "GET" | "POST" | "DELETE";
  /** The path template, with `{session}` or `{account}` filled from a checked identifier. */
  path: string;
  /** The query keys this operation may carry, and no others. */
  query: string[];
  /** Whether the call carries a JSON body. */
  body: boolean;
  /** Reads only: what the page calls it, so a refusal can be said in plain words. */
  what: string;
}

export const BANK_OPERATIONS: Record<BankOperation, BankRoute> = {
  "list-aspsps": { method: "GET", path: "/aspsps", query: ["country", "psu_type"], body: false, what: "the list of banks the provider serves" },
  "start-authorisation": { method: "POST", path: "/auth", query: [], body: true, what: "starting a bank authorisation" },
  "create-session": { method: "POST", path: "/sessions", query: [], body: true, what: "exchanging the one-time code for a session" },
  "read-session": { method: "GET", path: "/sessions/{session}", query: [], body: false, what: "reading a session" },
  "delete-session": { method: "DELETE", path: "/sessions/{session}", query: [], body: false, what: "deleting a session" },
  "account-details": { method: "GET", path: "/accounts/{account}/details", query: [], body: false, what: "reading an account's details" },
  "account-balances": { method: "GET", path: "/accounts/{account}/balances", query: [], body: false, what: "reading an account's balances" },
  "account-transactions": { method: "GET", path: "/accounts/{account}/transactions", query: ["date_from", "date_to", "continuation_key"], body: false, what: "reading an account's transactions" },
};

/**
 * Anything shaped like money moving, refused outright. This is checked before the allowlist is even
 * consulted, so a path that is both (there is none here, and there must never be one) is still refused,
 * and a future edit that added such a route would have to delete this line to make it reachable.
 */
export const PAYMENT_SHAPED = /(pay|payment|payments|pisp|pis\b|transfer|transfers|funds|bulk|beneficiar|standing-order|standingorder|direct-debit|mandate|domestic|sepa|instant|credit-transfer|sweep|forex|foreign-exchange|fx|top-?up|refund|charge)/i;

/** An identifier the provider's own response gave us: no slash, no dot-segment, nothing to escape. */
const IDENT = /^[A-Za-z0-9._~:-]{1,128}$/;

/**
 * Whether a route's own words are payment-shaped. Checked on a route's literal segments only, never on
 * the identifier the provider put in the path (an id that happened to contain "pay" would otherwise
 * refuse a perfectly ordinary balance read).
 */
export function paymentShapedStatics(want: string[]): boolean {
  return PAYMENT_SHAPED.test(want.filter((s) => !s.startsWith("{")).join("/"));
}

/** Whether a method and a path are one of the operations above, and nothing else. */
export function routeOf(method: string, path: string): BankOperation | undefined {
  const m = method.toUpperCase();
  const clean = path.split("?")[0].replace(/\/+$/, "") || "/";
  const got = clean.split("/").filter(Boolean);
  for (const [op, route] of Object.entries(BANK_OPERATIONS) as Array<[BankOperation, BankRoute]>) {
    if (route.method !== m) continue;
    const want = route.path.split("/").filter(Boolean);
    if (want.length !== got.length) continue;
    if (!want.every((seg, i) => (seg.startsWith("{") ? IDENT.test(got[i]) : seg === got[i]))) continue;
    // Refused before the allowlist's answer is used: no route of ours is payment-shaped, and one that
    // became so later could not be reached without deleting this line.
    if (paymentShapedStatics(want)) return undefined;
    return op;
  }
  return undefined;
}

/* ---------- Failures, said plainly ---------- */

export type BankFailureKind = "config" | "credential" | "rate-limit" | "missing" | "consent" | "provider" | "network" | "refused" | "shape";

export class BankApiError extends Error {
  constructor(
    readonly kind: BankFailureKind,
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** One plain sentence the page may show for a failure, always about the read and never about data. */
/** What a failure of each kind means, in words the owner's page can show as they are. */
export const BANK_FAILURE_SENTENCES: Record<BankFailureKind, string> = {
  config: "The bank connector is not set up for this, so nothing was asked of the provider.",
  credential: "The provider refused this service's application key, so nothing could be read. Nothing on your account was changed, and nothing was stored.",
  "rate-limit": "The provider is rate limiting this service. Nothing was read; try again shortly.",
  missing: "The provider no longer has that bank session, so there was nothing to read. Connect again to make a fresh one.",
  consent: "The bank's own consent for this connection has expired or was withdrawn, so the provider refused the read. Connect again to give a fresh consent.",
  provider: "The provider could not answer that request, so nothing was read.",
  network: "The provider could not be reached, so nothing was read. Try again in a moment.",
  refused: "That request is not one this connector is allowed to make, so it was not made.",
  shape: "The provider's reply was not in a shape this connector understands, so nothing was shown.",
};

/** The provider's own failure, with its status number when there is one (never a body). */
export const providerSentence = (status?: number): string => `The provider could not answer that request${status ? ` (it answered ${status})` : ""}, so nothing was read.`;

/** Rate limiting, with what the provider asked us to wait when it said. */
export const rateLimitSentence = (retryAfterMs?: number): string =>
  retryAfterMs ? `The provider is rate limiting this service and asked for about ${Math.max(1, Math.ceil(retryAfterMs / 1000))} seconds. Nothing was read; try again after that.` : BANK_FAILURE_SENTENCES["rate-limit"];

export function bankFailureSentence(err: BankApiError | BankError): string {
  // A failure carries its own sentence, made in this module, and that is what the page shows. A message
  // that somehow arrived empty falls back to the sentence for its kind, never to a stack or a body.
  return err.message || (err instanceof BankApiError ? BANK_FAILURE_SENTENCES[err.kind] : BANK_FAILURE_SENTENCES.provider);
}

/**
 * What may be put in a sentence: no signing token, no application id, no long encoded blob, and a
 * length a page can hold. A reply's own words are never printed whole.
 */
export function scrub(text: string, extra: string[] = [], limit = 120): string {
  let out = text
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, "[token]")
    .replace(/[A-Za-z0-9_-]{80,}/g, "[long value]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[<>"'`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  for (const secret of extra) if (secret && secret.length >= 4) out = out.split(secret).join("[secret]");
  return out.length > limit ? `${out.slice(0, limit - 1)}…` : out;
}

/** The provider's own short words for a failure, scrubbed, and never more than one line of it. */
function providerWords(body: string, extra: string[]): string | undefined {
  let text = body;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const cand = [parsed.message, parsed.error, parsed.error_description, parsed.detail, parsed.title].find((v) => typeof v === "string" && v.trim());
    if (typeof cand === "string") text = cand;
  } catch {
    // Not JSON: the raw body is below, clipped and scrubbed like anything else.
  }
  const clean = scrub(text, extra, 100);
  return clean ? clean : undefined;
}

/* ---------- Signing ---------- */

export interface BankJwtInput {
  applicationId: string;
  privateKey: string;
  issuer: string;
  audience: string;
  ttlSeconds: number;
  now?: number;
}

const b64 = (buf: Buffer | string) => Buffer.from(buf).toString("base64url");

/**
 * The provider's application token: RS256, the application id as `kid`, a short life and nothing else
 * of ours in it. The key is checked to be a real RSA key of at least 2048 bits first, so a wrong
 * variable says so plainly instead of failing later at the provider. The token is minted per request
 * and never stored, cached or logged.
 */
export function bankJwt(o: BankJwtInput): string {
  if (!o.applicationId) throw new BankError("The bank connector has no provider application id (BANK_APPLICATION_ID).");
  if (!o.privateKey) throw new BankError("The bank connector has no signing key (BANK_JWT_PRIVATE_KEY).");
  let key: ReturnType<typeof createPrivateKey>;
  try {
    key = createPrivateKey(o.privateKey);
  } catch {
    throw new BankError("BANK_JWT_PRIVATE_KEY is not a private key in PEM form (the whole key, including its BEGIN and END lines).");
  }
  if (key.asymmetricKeyType !== "rsa") throw new BankError("BANK_JWT_PRIVATE_KEY must be an RSA private key, as the provider documents.");
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (bits && bits < 2048) throw new BankError("BANK_JWT_PRIVATE_KEY is an RSA key shorter than 2048 bits, which the provider does not accept.");
  const ttl = Math.min(Math.max(60, Math.trunc(o.ttlSeconds)), BANK_JWT_TTL_SECONDS_MAX);
  const iat = Math.floor((o.now ?? Date.now()) / 1000);
  const header = b64(JSON.stringify({ typ: "JWT", alg: "RS256", kid: o.applicationId }));
  const payload = b64(JSON.stringify({ iss: o.issuer, aud: o.audience, iat, exp: iat + ttl }));
  const body = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(body).sign(key).toString("base64url");
  return `${body}.${signature}`;
}

/* ---------- What the provider's replies mean ---------- */

export interface BankAspsp {
  name: string;
  country: string;
  /** The provider's own list of how this bank may be used, when it gives one. */
  psuTypes?: string[];
  bic?: string;
}

export interface BankAccount {
  uid: string;
  name?: string;
  iban?: string;
  currency?: string;
}

export interface BankSessionInfo {
  sessionId: string;
  accounts: BankAccount[];
  aspsp: { name: string; country: string };
  scope: string[];
  accessValidUntil?: string;
}

export interface BankBalanceLine {
  /** The provider's own type words, e.g. interimAvailable. Never invented when it is missing. */
  type: string;
  name?: string;
  amount: string;
  currency: string;
  asOf?: string;
}

export interface BankTransactionLine {
  bookingDate: string;
  valueDate?: string;
  description: string;
  amount: string;
  currency: string;
  status?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const asString = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : undefined);

/** The first string that is there, out of a reply's several ways of saying the same thing. */
function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    const s = asString(v);
    if (s) return s;
    if (Array.isArray(v)) {
      const joined = v.map((x) => asString(x)).filter(Boolean).join(" ");
      if (joined) return joined;
    }
  }
  return undefined;
}

export function parseAspsps(reply: unknown): BankAspsp[] {
  const raw = isObj(reply) ? (reply.aspsps ?? reply.banks ?? reply) : reply;
  if (!Array.isArray(raw)) throw new BankApiError("shape", BANK_FAILURE_SENTENCES.shape);
  const out: BankAspsp[] = [];
  for (const entry of raw) {
    if (!isObj(entry)) continue;
    const name = asString(entry.name);
    const country = asString(entry.country);
    if (!name || !country) continue;
    const psuTypes = Array.isArray(entry.psu_types) ? entry.psu_types.filter((x): x is string => typeof x === "string") : undefined;
    const bic = asString(entry.bic);
    out.push({ name, country: country.toUpperCase(), ...(psuTypes ? { psuTypes } : {}), ...(bic ? { bic } : {}) });
  }
  if (!out.length) throw new BankApiError("shape", BANK_FAILURE_SENTENCES.shape);
  return out;
}

const NOT_PERSONAL = /(business|corporate|commercial|invest|markets|global|merchant|sole trader|trade|private bank)/i;

/**
 * Which bank the authorisation is for, taken from the provider's own list rather than guessed: the
 * HSBC entry for the configured country that is not a business or corporate one, with a preference for
 * the entry the provider itself marks as usable by a personal customer. One candidate is used; none, or
 * more than one, is refused in plain words, because picking by name where the list is ambiguous is
 * exactly the guess this connector must not make.
 */
export function pickHsbcUkPersonal(aspsps: BankAspsp[], country = "GB"): BankAspsp {
  const wanted = country.toUpperCase();
  const inCountry = aspsps.filter((a) => a.country.toUpperCase() === wanted);
  if (!inCountry.length) throw new BankApiError("config", `The provider returned no banks for ${wanted} at all, so nothing could be started.`);
  const hsbc = inCountry.filter((a) => /hsbc/i.test(a.name));
  if (!hsbc.length) throw new BankApiError("config", `The provider returned ${inCountry.length} ${wanted} banks and none of them is HSBC, so nothing was started.`);
  const personal = hsbc.filter((a) => !NOT_PERSONAL.test(a.name));
  // What the provider itself says the entry is for comes first: an entry it marks as business-only is
  // not the personal one, whatever it is called.
  const personalOnly = personal.filter((a) => !a.psuTypes || a.psuTypes.includes("personal"));
  const candidates = personalOnly.length ? personalOnly : personal;
  if (!candidates.length) throw new BankApiError("config", `The provider's only HSBC ${wanted} entries are business ones (${hsbc.map((a) => a.name).join(", ")}), so nothing was started.`);
  // The plainest name for the bank, if there is exactly one of those, is the personal entry.
  const exact = candidates.filter((a) => /^hsbc( uk| bank uk| uk bank)?( plc| ltd)?$/i.test(a.name.trim()));
  if (exact.length === 1) return exact[0];
  if (candidates.length === 1) return candidates[0];
  throw new BankApiError("config", `The provider returned more than one HSBC ${wanted} entry that could be the personal one (${candidates.map((a) => a.name).join(", ")}), so nothing was started rather than guessing.`);
}

/** The provider's authorisation address: https, or a loopback address for the local preview only. */
export function authUrlOk(value: unknown, allowLoopback = false): { ok: true; url: string } | { ok: false; reason: string } {
  const s = asString(value);
  if (!s) return { ok: false, reason: "The provider did not give an address to send you to." };
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return { ok: false, reason: "The provider's authorisation address is not a web address." };
  }
  if (url.protocol === "https:") return { ok: true, url: url.toString() };
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (allowLoopback && url.protocol === "http:" && loopback) return { ok: true, url: url.toString() };
  return { ok: false, reason: "The provider's authorisation address is not https, so it was not followed." };
}

export function parseSession(reply: unknown): BankSessionInfo {
  if (!isObj(reply)) throw new BankApiError("shape", BANK_FAILURE_SENTENCES.shape);
  const sessionId = firstString(reply.session_id, reply.sessionId);
  if (!sessionId) throw new BankApiError("shape", BANK_FAILURE_SENTENCES.shape);
  const accountsRaw = Array.isArray(reply.accounts) ? reply.accounts : [];
  const accounts: BankAccount[] = [];
  for (const a of accountsRaw) {
    if (!isObj(a)) continue;
    const uid = asString(a.uid);
    if (!uid) continue;
    const id = isObj(a.account_id) ? a.account_id : {};
    const iban = firstString(id.iban, isObj(id.other) ? id.other.identification : undefined);
    accounts.push({ uid, ...(asString(a.name) ? { name: asString(a.name) } : {}), ...(iban ? { iban } : {}), ...(asString(a.currency) ? { currency: asString(a.currency) } : {}) });
  }
  const aspsp = isObj(reply.aspsp) ? reply.aspsp : {};
  const access = isObj(reply.access) ? reply.access : {};
  const stringsOf = (v: unknown): string[] => (typeof v === "string" && v.trim() ? [v.trim()] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  // The provider's own words for the consent's scope, however it writes them.
  const scope = [...stringsOf(reply.scope), ...stringsOf(access.scope), ...stringsOf(reply.access)];
  return {
    sessionId,
    accounts,
    aspsp: { name: firstString(aspsp.name) ?? "the bank", country: (firstString(aspsp.country) ?? "").toUpperCase() },
    scope,
    ...(firstString(access.valid_until, reply.valid_until) ? { accessValidUntil: firstString(access.valid_until, reply.valid_until) as string } : {}),
  };
}

const NUMERIC = /^-?\d+(\.\d+)?$/;

export function parseBalances(reply: unknown): BankBalanceLine[] {
  const raw = isObj(reply) ? reply.balances : undefined;
  if (!Array.isArray(raw)) throw new BankApiError("shape", BANK_FAILURE_SENTENCES.shape);
  const out: BankBalanceLine[] = [];
  for (const entry of raw) {
    if (!isObj(entry)) continue;
    const amountObj = isObj(entry.balance_amount) ? entry.balance_amount : isObj(entry.amount) ? entry.amount : undefined;
    const amount = firstString(amountObj?.amount, typeof entry.balance_amount === "string" ? entry.balance_amount : undefined, typeof entry.amount === "string" ? entry.amount : undefined);
    const currency = firstString(amountObj?.currency, entry.currency);
    const type = firstString(entry.balance_type, entry.type);
    if (!amount || !currency || !type) continue;
    out.push({
      type,
      ...(firstString(entry.name) ? { name: firstString(entry.name) as string } : {}),
      amount: NUMERIC.test(amount) ? amount : amount.slice(0, 40),
      currency: currency.toUpperCase(),
      ...(firstString(entry.reference_date, entry.last_change_date_time) ? { asOf: firstString(entry.reference_date, entry.last_change_date_time) as string } : {}),
    });
  }
  return out;
}

export function parseTransactions(reply: unknown): { lines: BankTransactionLine[]; continuationKey?: string } {
  if (!isObj(reply) || !Array.isArray(reply.transactions)) throw new BankApiError("shape", BANK_FAILURE_SENTENCES.shape);
  const lines: BankTransactionLine[] = [];
  for (const t of reply.transactions) {
    if (!isObj(t)) continue;
    const amountObj = isObj(t.transaction_amount) ? t.transaction_amount : isObj(t.amount) ? t.amount : undefined;
    const amount = firstString(amountObj?.amount, typeof t.transaction_amount === "string" ? t.transaction_amount : undefined);
    const currency = firstString(amountObj?.currency, t.currency);
    const bookingDate = firstString(t.booking_date, t.value_date, t.transaction_date) ?? "";
    const description =
      firstString(t.remittance_information_unstructured, t.remittance_information, isObj(t.creditor) ? t.creditor.name : undefined, isObj(t.debtor) ? t.debtor.name : undefined, t.entry_reference, t.additional_information) ??
      "no description given";
    lines.push({
      bookingDate,
      ...(firstString(t.value_date) ? { valueDate: firstString(t.value_date) as string } : {}),
      description: description.replace(/\s+/g, " ").slice(0, 140),
      amount: amount && NUMERIC.test(amount) ? amount : (amount ?? "unknown"),
      currency: (currency ?? "").toUpperCase(),
      ...(firstString(t.status, t.credit_debit_indicator) ? { status: firstString(t.status, t.credit_debit_indicator) as string } : {}),
    });
  }
  const key = firstString(reply.continuation_key);
  return { lines, ...(key ? { continuationKey: key } : {}) };
}

export function parseAuthUrl(reply: unknown, allowLoopback = false): string {
  const candidate = isObj(reply) ? (reply.url ?? reply.redirect_url ?? reply.authorisation_url) : undefined;
  const checked = authUrlOk(candidate, allowLoopback);
  if (!checked.ok) throw new BankApiError("shape", checked.reason);
  return checked.url;
}

/* ---------- The client ---------- */

export type BankFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface BankApiOptions {
  settings: BankSettings;
  /** The real `fetch` by default; every test and the local preview inject their own. */
  fetchImpl?: BankFetch;
  now?: () => number;
  timeoutMs?: number;
  /** Where a refusal or a provider failure is recorded. One short line, never a body or a token. */
  onRefused?: (line: string) => void;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export class BankApi {
  private readonly fetchImpl: BankFetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(private readonly o: BankApiOptions) {
    this.fetchImpl = o.fetchImpl ?? (fetch as unknown as BankFetch);
    this.now = o.now ?? Date.now;
    this.timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private get s(): BankSettings {
    return this.o.settings;
  }

  /** One request, and the only place one is made. Everything about it is checked before it leaves. */
  async call(op: BankOperation, input: { params?: Record<string, string>; query?: Record<string, string>; body?: unknown } = {}): Promise<unknown> {
    const route = BANK_OPERATIONS[op];
    if (!route) throw new BankApiError("refused", BANK_FAILURE_SENTENCES.refused);
    let path = route.path;
    for (const [name, value] of Object.entries(input.params ?? {})) {
      if (!IDENT.test(value)) throw new BankApiError("refused", "The provider gave an identifier this connector will not put in a request, so nothing was read.");
      path = path.replace(`{${name}}`, value);
    }
    if (/\{[a-z]+\}/.test(path)) throw new BankApiError("refused", BANK_FAILURE_SENTENCES.refused);
    if (routeOf(route.method, path) !== op) throw new BankApiError("refused", BANK_FAILURE_SENTENCES.refused);
    for (const key of Object.keys(input.query ?? {})) if (!route.query.includes(key)) throw new BankApiError("refused", BANK_FAILURE_SENTENCES.refused);
    if (input.body !== undefined && !route.body) throw new BankApiError("refused", BANK_FAILURE_SENTENCES.refused);

    // The address itself is checked on every call, not only where the settings were built: a settings
    // object that named some other host would otherwise be followed simply because it agreed with itself.
    const base = checkBaseUrl(this.s.baseUrl);
    if (!base.ok) {
      this.o.onRefused?.(`refused a base address that is not the provider's own`);
      throw new BankApiError("refused", "That request would have gone somewhere other than the provider, so it was not made.");
    }
    let url: URL;
    try {
      url = new URL(path, base.baseUrl);
    } catch {
      throw new BankApiError("config", "The provider's address is not a web address, so nothing was sent.");
    }
    if (url.protocol !== "https:" || url.host !== this.s.host || url.origin !== `https://${base.host}`) {
      this.o.onRefused?.(`refused to leave for ${url.host} (not the provider's own address)`);
      throw new BankApiError("refused", "That request would have gone somewhere other than the provider, so it was not made.");
    }
    for (const [key, value] of Object.entries(input.query ?? {})) url.searchParams.set(key, value);

    const token = bankJwt({ applicationId: this.s.applicationId, privateKey: this.s.jwtKey, issuer: this.s.jwtIssuer, audience: this.s.jwtAudience, ttlSeconds: this.s.jwtTtlSeconds, now: this.now() });
    const headers: Record<string, string> = { Accept: "application/json", Authorization: `Bearer ${token}` };
    if (input.body !== undefined) headers["Content-Type"] = "application/json";

    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), {
        method: route.method,
        headers,
        ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const name = (err as { name?: string }).name ?? "";
      if (name === "AbortError" || name === "TimeoutError") throw new BankApiError("network", "The provider took too long to answer, so nothing was read.");
      throw new BankApiError("network", BANK_FAILURE_SENTENCES.network);
    }

    const body = (await res.text().catch(() => "")).slice(0, MAX_BODY_BYTES);
    if (res.ok) {
      if (!body.trim()) return {};
      try {
        return JSON.parse(body) as unknown;
      } catch {
        throw new BankApiError("shape", BANK_FAILURE_SENTENCES.shape, res.status);
      }
    }
    throw this.failureFor(op, res, body);
  }

  /** What a refusal from the provider means, in this connector's own words. */
  private failureFor(op: BankOperation, res: Response, body: string): BankApiError {
    const status = res.status;
    const words = providerWords(body, [this.s.applicationId, this.s.jwtKey.slice(0, 24)]);
    if (status === 401 || status === 403) return new BankApiError("credential", BANK_FAILURE_SENTENCES.credential, status);
    if (status === 429) {
      const header = Number(res.headers.get("retry-after"));
      const retryAfterMs = Number.isFinite(header) && header > 0 ? header * 1000 : undefined;
      return new BankApiError("rate-limit", rateLimitSentence(retryAfterMs), status, retryAfterMs);
    }
    if (status === 404) return new BankApiError("missing", BANK_FAILURE_SENTENCES.missing, status);
    if (status === 405 || status === 501) return new BankApiError("refused", BANK_FAILURE_SENTENCES.refused, status);
    const consentish = /consent|expire|expired|revoke|revoked|authorisation has|authorization has/i.test(body) && ["read-session", "account-details", "account-balances", "account-transactions"].includes(op);
    if (status === 400 && consentish) return new BankApiError("consent", BANK_FAILURE_SENTENCES.consent, status);
    const sentence = providerSentence(status);
    return new BankApiError("provider", words ? `${sentence} It said: ${words}` : sentence, status);
  }

  /* The operations themselves, each one a single checked call. */

  async listAspsps(country = this.s.country, psuType = "personal"): Promise<BankAspsp[]> {
    return parseAspsps(await this.call("list-aspsps", { query: { country: country.toUpperCase(), psu_type: psuType } }));
  }

  async startAuthorisation(o: { aspsp: { name: string; country: string }; state: string; redirectUrl: string; validUntil?: string; psuType?: string }): Promise<string> {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(o.state)) throw new BankError("The state this connector would send is not in the form it makes, so nothing was started.");
    const access = o.validUntil ? { valid_until: o.validUntil } : {};
    const body = { access, aspsp: { name: o.aspsp.name, country: o.aspsp.country }, state: o.state, redirect_url: o.redirectUrl, psu_type: o.psuType ?? "personal" };
    return parseAuthUrl(await this.call("start-authorisation", { body }), this.s.allowLoopback);
  }

  async createSession(code: string): Promise<BankSessionInfo> {
    if (!code || code.length > 4_096) throw new BankError("The one-time code from the bank is missing, so no session could be made.");
    return parseSession(await this.call("create-session", { body: { code } }));
  }

  async readSession(sessionId: string): Promise<BankSessionInfo> {
    return parseSession(await this.call("read-session", { params: { session: sessionId } }));
  }

  async accountDetails(uid: string): Promise<Record<string, unknown>> {
    const reply = await this.call("account-details", { params: { account: uid } });
    if (!isObj(reply)) throw new BankApiError("shape", BANK_FAILURE_SENTENCES.shape);
    return reply;
  }

  async balances(uid: string): Promise<BankBalanceLine[]> {
    return parseBalances(await this.call("account-balances", { params: { account: uid } }));
  }

  async transactions(uid: string, o: { from: string; to: string; continuationKey?: string }): Promise<{ lines: BankTransactionLine[]; continuationKey?: string }> {
    return parseTransactions(await this.call("account-transactions", { params: { account: uid }, query: { date_from: o.from, date_to: o.to, ...(o.continuationKey ? { continuation_key: o.continuationKey } : {}) } }));
  }

  /** The documented session delete, used by disconnect and by nothing else. */
  async deleteSession(sessionId: string): Promise<void> {
    await this.call("delete-session", { params: { session: sessionId } });
  }
}

/** A short, non-reversible fingerprint of a provider id, for a log line that must not carry one. */
export const idFingerprint = (id: string): string => createHash("sha256").update(id).digest("hex").slice(0, 12);
