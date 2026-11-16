/**
 * The connect gate: everything between the owner pressing a button and a bank read coming back.
 *
 * The shape is the service's usual one (the DNS and sign-up gates): the browser asks, the service
 * decides, and only the owner's own signed-in session can move anything along. Concretely:
 *
 *  - **A connect action** is minted per press of "Connect", bound to the session that asked (the
 *    fingerprint of its session cookie), valid for ten minutes and usable once. A board link or the
 *    bridge token is not a session, so neither can start anything.
 *  - **A bank flow** is parked in memory with a high-entropy state (32 random bytes) and the same
 *    session binding, and it dies with the process: after a restart the owner starts again, which is
 *    safer than trusting a flow this process did not make.
 *  - **The callback** (src/bank-router.ts) can only park the provider's one-time code against that
 *    state. It exchanges nothing, writes nothing and decides nothing: the exchange happens on the
 *    owner's next authenticated, CSRF-checked POST in the tab that started the flow, once, and a code
 *    that has already been used is refused rather than offered again.
 *  - **Reads** only ever reach accounts the owner chose, resolved by matching a keyed hash against what
 *    the provider's own session reports. A valid session is not permission to read every account it can
 *    see: an account that is not in the stored selection is refused, and a selection of nothing reads
 *    nothing at all (an empty selection is not a connected success).
 *  - **Disconnect** blocks local reads first, then calls the documented session delete, then destroys
 *    the local record. The provider's own deletion and the bank's own consent are reported as the
 *    separate things they are: nothing here ever claims the bank's consent has been revoked.
 *
 * No model is called anywhere in this file, nothing is persisted except what src/bank.ts keeps, and no
 * balance or transaction is ever written anywhere.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  BANK_ACTION_TTL_MS,
  BANK_FLOW_TTL_MS,
  BANK_LISTING_TTL_MS,
  BANK_RENDER_ROWS_MAX,
  BankError,
  type BankAccountSelection,
  type BankConnection,
  type BankSettings,
  type BankStore,
  type BankStoreState,
  accountLabel,
  bankStore as defaultBankStore,
  bankReady,
  connectionKey,
  uidHash,
} from "./bank.js";
import { type BankAccount, type BankApi, BankApiError, bankFailureSentence, pickHsbcUkPersonal, scrub } from "./bank-api.js";
import { addDays, londonYmd } from "./london.js";
import { SESSION_COOKIE, cookieValue } from "./sign-in.js";
import type { Store } from "./store.js";

/** How long a consent is asked for, in days. The provider gives it an end date; the page shows it. */
export const BANK_CONSENT_DAYS = 90;

const iso = (at: number) => new Date(at).toISOString();

/** The fingerprint of the owner's own session cookie: what a connect action and a flow are bound to. */
export function sessionFingerprint(cookieHeader: string | undefined): string {
  const value = cookieValue(cookieHeader, SESSION_COOKIE) ?? "";
  return createHash("sha256").update(`clear-ops-bank-session-v1:${value}`).digest("hex");
}

export type CallbackOutcome =
  | { kind: "parked"; aspsp: { name: string; country: string }; at: number }
  | { kind: "refused"; reason: string }
  | { kind: "declined"; reason: string };

export interface BankAction {
  token: string;
  expires: number;
}

interface Flow {
  state: string;
  fingerprint: string;
  aspsp: { name: string; country: string };
  /** The bank's own authorisation address, held in memory so the waiting page can offer it as a link. */
  url: string;
  startedAt: number;
  expires: number;
  code?: string;
  codeAt?: number;
}

export interface BankDeps {
  store: Store;
  settings: BankSettings;
  api: BankApi;
  bankStore?: BankStore;
  now?: () => number;
}

/** One line of a read, as the page draws it: provider words, escaped by the renderer. */
export interface ReadBalance {
  type: string;
  name?: string;
  amount: string;
  currency: string;
  asOf?: string;
}

export interface ReadTransaction {
  date: string;
  valueDate?: string;
  description: string;
  amount: string;
  currency: string;
  status?: string;
}

export interface BalanceRead {
  at: string;
  account: string;
  lines: ReadBalance[];
}

export interface TransactionRead {
  at: string;
  account: string;
  from: string;
  to: string;
  lines: ReadTransaction[];
  count: number;
  shown: number;
  truncated: boolean;
  pages: number;
}

export interface DisconnectReport {
  local: string;
  vendor: string;
  bank: string;
  record: string;
}

/** A date the page's form gave, checked before it is ever put in a request. */
export function windowCheck(from: string, to: string, s: BankSettings, today: string): { from: string; to: string } {
  const real = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [y, m, d] = value.split("-").map(Number);
    if (m < 1 || m > 12 || d < 1 || d > 31) return false;
    return londonYmd(new Date(Date.UTC(y, m - 1, d, 12))) === value;
  };
  if (!real(from) || !real(to)) throw new BankError("Give both dates as YYYY-MM-DD.");
  if (from > to) throw new BankError("The first date is after the second one, so there is no range to read.");
  if (from < "2015-01-01") throw new BankError("That range starts before this connector would look, so nothing was read.");
  if (to > addDays(today, 1)) throw new BankError("That range ends in the future, where there is nothing to read. Use today or earlier.");
  const span = Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000) + 1;
  if (span > s.windowDaysMax) throw new BankError(`That is ${span} days, and this connector reads at most ${s.windowDaysMax} at a time. Narrow the range.`);
  return { from, to };
}

export class BankGate {
  private actions = new Map<string, { fingerprint: string; expires: number }>();
  private flows = new Map<string, Flow>();
  /** The accounts the provider's session last showed, with when. In memory only, for a few minutes. */
  private listing?: { at: number; sessionId: string; accounts: BankAccount[] };
  private readonly now: () => number;
  private readonly bank: BankStore;

  constructor(private readonly o: BankDeps) {
    this.now = o.now ?? Date.now;
    this.bank = o.bankStore ?? defaultBankStore;
  }

  private get s(): BankSettings {
    return this.o.settings;
  }

  /** In plain words, why the connector cannot run, or nothing when it can. */
  off(): string | undefined {
    return bankReady(this.s);
  }

  /* ---------- CSRF ---------- */
  /**
   * The token every form on the bank page carries, and the only thing that lets a POST change anything.
   * It is tied to the owner's own session (the cookie's fingerprint) and signed with the service's own
   * session key, so a page served to one session cannot be replayed into another, and a password change
   * (which ends every session) ends these too. Nothing is stored: it is derived when the page is built
   * and checked in constant time when the form comes back.
   */
  csrf(fingerprint: string): string | undefined {
    const settings = this.o.store.settings();
    if (!settings.pageSessionKey || !settings.pagePassword) return undefined;
    return createHmac("sha256", Buffer.from(settings.pageSessionKey, "base64url")).update(`clear-ops-bank-csrf-v1:${fingerprint}`).digest("base64url");
  }

  csrfOk(value: unknown, fingerprint: string): boolean {
    const want = this.csrf(fingerprint);
    if (!want || typeof value !== "string" || !value) return false;
    const a = Buffer.from(want, "utf8");
    const b = Buffer.from(value, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Forgets actions and flows that have expired, so the maps stay small whatever is left behind. */
  private prune(): void {
    const now = this.now();
    for (const [token, action] of this.actions) if (action.expires < now) this.actions.delete(token);
    for (const [state, flow] of this.flows) if (flow.expires < now) this.flows.delete(state);
  }

  /* ---------- The connect action ---------- */

  /** A fresh action for this session, valid ten minutes and usable once. */
  newAction(fingerprint: string): BankAction {
    this.prune();
    const token = randomBytes(24).toString("base64url");
    const expires = this.now() + BANK_ACTION_TTL_MS;
    this.actions.set(token, { fingerprint, expires });
    return { token, expires };
  }

  /** Whether an action is this session's and still live, without using it up (the confirm page). */
  actionValid(token: string, fingerprint: string): boolean {
    const a = this.actions.get(token);
    return !!a && a.expires >= this.now() && a.fingerprint === fingerprint;
  }

  /* ---------- Starting the bank authorisation ---------- */

  /**
   * Uses the action up, asks the provider for its bank list, picks the HSBC UK personal entry from
   * that reply, parks a flow and returns the bank's own address. Nothing is exchanged and nothing is
   * stored: the connection is only ever made at the end, on the owner's own POST.
   *
   * The address is the bank's own, not the provider's, and the browser is sent to it by the owner
   * following a link rather than by this service redirecting a form submission: the page's CSP is
   * `form-action 'self'`, and a browser applies that to the redirects of a form submission too, which
   * would block a bank whose domain cannot be named in advance. See src/bank-router.ts.
   */
  async start(token: string, fingerprint: string): Promise<{ url: string; aspsp: { name: string; country: string } }> {
    const off = this.off();
    if (off) throw new BankError(off);
    const action = this.actions.get(token);
    if (!action || action.expires < this.now() || action.fingerprint !== fingerprint) {
      throw new BankError("That connect action has expired or was already used, so nothing was started. Press Connect again.");
    }
    this.actions.delete(token);
    const state = randomBytes(32).toString("base64url");
    const aspsps = await this.o.api.listAspsps(this.s.country);
    const aspsp = pickHsbcUkPersonal(aspsps, this.s.country);
    const flow: Flow = { state, fingerprint, aspsp: { name: aspsp.name, country: aspsp.country }, url: "", startedAt: this.now(), expires: this.now() + BANK_FLOW_TTL_MS };
    this.flows.set(state, flow);
    try {
      flow.url = await this.o.api.startAuthorisation({
        aspsp: flow.aspsp,
        state,
        redirectUrl: this.s.redirectUrl,
        validUntil: `${addDays(londonYmd(new Date(this.now())), BANK_CONSENT_DAYS)}T00:00:00Z`,
      });
      return { url: flow.url, aspsp: flow.aspsp };
    } catch (err) {
      this.flows.delete(state);
      throw err;
    }
  }

  /**
   * The flow this session started and has not finished, for the page while it waits. The bank's own
   * address comes back with it while the bank has not been visited yet, so the waiting page can offer
   * it as a link; once a code is parked there is nothing left to visit.
   */
  waiting(fingerprint: string): { aspsp: { name: string; country: string }; parked: boolean; startedAt: number; url?: string } | undefined {
    for (const flow of this.flows.values()) {
      if (flow.fingerprint !== fingerprint) continue;
      if (flow.expires < this.now()) continue;
      return { aspsp: flow.aspsp, parked: !!flow.code, startedAt: flow.startedAt, ...(flow.code || !flow.url ? {} : { url: flow.url }) };
    }
    return undefined;
  }

  /**
   * Drops this session's waiting attempt. Nothing was exchanged and nothing was stored, so cancelling
   * is only forgetting: a code the bank has already handed back is discarded with it.
   */
  cancel(fingerprint: string): boolean {
    let dropped = false;
    for (const [state, flow] of this.flows) {
      if (flow.fingerprint !== fingerprint) continue;
      this.flows.delete(state);
      dropped = true;
    }
    return dropped;
  }

  /* ---------- The bank's own redirect back ---------- */

  /**
   * What the bank's redirect does here, and all it does: parks the provider's one-time code against the
   * state this service minted, or refuses. No code is exchanged, nothing is written, and nothing about
   * the query string is kept beyond the code itself, which lives in memory until the owner's session
   * uses it once.
   */
  acceptCallback(q: { state?: string; code?: string; error?: string }): CallbackOutcome {
    const state = typeof q.state === "string" ? q.state : "";
    if (!state || state.length > 256) return { kind: "refused", reason: "That reply from the bank did not carry a state this service recognises, so nothing was done. Connect again from the bank page." };
    const flow = this.flows.get(state);
    if (!flow || flow.expires < this.now()) {
      if (flow) this.flows.delete(flow.state);
      return { kind: "refused", reason: "That connection attempt has expired or was not started here, so nothing was done. Connect again from the bank page." };
    }
    if (q.error) {
      // The bank said no. The flow is dropped and no code is kept, so there is nothing left to exchange.
      this.flows.delete(flow.state);
      const words = scrub(String(q.error), [], 80);
      return { kind: "declined", reason: `The bank did not complete the authorisation${words ? ` (it said: ${words})` : ""}. Nothing was connected and no session was made.` };
    }
    const code = typeof q.code === "string" ? q.code : "";
    if (!code || code.length > 4_096) return { kind: "refused", reason: "That reply from the bank carried no code, so nothing was done. Connect again from the bank page." };
    if (flow.code) {
      // A second arrival for the same state: the first code is kept and this one is dropped, so a
      // replayed callback can neither overwrite a good code nor make a second session.
      return { kind: "refused", reason: "That reply from the bank had already been received, so this one changed nothing. Finish in the tab you started from, or connect again." };
    }
    flow.code = code;
    flow.codeAt = this.now();
    flow.expires = this.now() + BANK_FLOW_TTL_MS;
    return { kind: "parked", aspsp: flow.aspsp, at: flow.codeAt };
  }

  /* ---------- Finishing, in the owner's own session ---------- */

  /**
   * The one place a session is made: the owner's authenticated POST in the session that started the
   * flow. The code is taken (single use, before the call) and exchanged, and what is stored is only
   * what keeps the connection alive. An account list of nothing is not a success: the session the
   * provider gave is deleted again and the owner is told plainly.
   */
  async complete(fingerprint: string): Promise<BankConnection> {
    const off = this.off();
    if (off) throw new BankError(off);
    const flow = [...this.flows.values()].find((f) => f.fingerprint === fingerprint && f.code);
    if (!flow) throw new BankError("There is no finished authorisation waiting in this session. If you have just come back from the bank, finish in the tab you started from, or connect again from here.");
    if (flow.expires < this.now()) {
      this.flows.delete(flow.state);
      throw new BankError("That authorisation took too long to finish, so nothing was connected. Connect again.");
    }
    const code = flow.code as string;
    this.flows.delete(flow.state);
    const session = await this.o.api.createSession(code);
    if (!session.accounts.length) {
      // Nothing to read is not a connection. The session this service just made is deleted again.
      let vendor = "The provider was asked to delete it again.";
      try {
        await this.o.api.deleteSession(session.sessionId);
      } catch {
        vendor = "The provider could not be reached to delete it again, so it will expire on its own.";
      }
      throw new BankError(`The bank handed back a session with no accounts in it, which is not a connection, so nothing was kept. ${vendor}`);
    }
    const connection: BankConnection = {
      sessionId: session.sessionId,
      aspsp: session.aspsp.name && session.aspsp.name !== "the bank" ? { name: session.aspsp.name, country: session.aspsp.country || flow.aspsp.country } : flow.aspsp,
      scope: session.scope,
      ...(session.accessValidUntil ? { accessValidUntil: session.accessValidUntil } : {}),
      // Nothing is readable until Paul chooses: an empty list here is a state the page says out loud.
      accounts: [],
      connectedAt: iso(this.now()),
    };
    this.bank.save(this.s.connectionKey, connection);
    this.listing = { at: this.now(), sessionId: session.sessionId, accounts: session.accounts };
    return connection;
  }

  /* ---------- What is stored, and what may be read ---------- */

  state(): BankStoreState {
    return this.bank.state(this.s.connectionKey);
  }

  /** The stored connection, or a plain error. A disconnected one is never read from. */
  connection(): BankConnection {
    const state = this.state();
    if (state.kind === "off" || state.kind === "unreadable") throw new BankError(state.reason);
    if (state.kind === "none") throw new BankError("There is no bank connection to read from. Connect first.");
    if (state.connection.disconnectedAt) throw new BankError("This connection was disconnected, so nothing is read from it. Connect again if you want it back.");
    return state.connection;
  }

  /**
   * The accounts the provider's session can see, with when they were read. Held in memory for a few
   * minutes so pressing a button does not cost a call; `refresh` always asks the provider again.
   */
  async accounts(refresh = false): Promise<{ at: string; accounts: BankAccount[] }> {
    const connection = this.connection();
    if (!refresh && this.listing && this.listing.sessionId === connection.sessionId && this.now() - this.listing.at < BANK_LISTING_TTL_MS) {
      return { at: iso(this.listing.at), accounts: this.listing.accounts };
    }
    const session = await this.o.api.readSession(connection.sessionId);
    this.listing = { at: this.now(), sessionId: session.sessionId, accounts: session.accounts };
    return { at: iso(this.listing.at), accounts: session.accounts };
  }

  /** The keyed handle for one of the provider's accounts, as the page's forms carry it. */
  handle(uid: string): string {
    return uidHash(uid, connectionKey(this.s.connectionKey));
  }

  /**
   * Saves which accounts may be read. Every submitted value must be an account the provider's session
   * showed just now, and there must be at least one: choosing none is refused rather than stored, so
   * "connected" always means at least one account is readable.
   */
  async choose(values: string[]): Promise<BankConnection> {
    const connection = this.connection();
    const { accounts } = await this.accounts();
    const wanted = [...new Set(values.map((v) => String(v ?? "").trim()).filter(Boolean))];
    if (!wanted.length) throw new BankError("Choose at least one account. While none is chosen, nothing on your account is readable.");
    const byHandle = new Map(accounts.map((a) => [this.handle(a.uid), a] as const));
    for (const value of wanted) {
      if (!byHandle.has(value)) throw new BankError("One of the accounts submitted is not one the provider's session can see, so nothing was changed.");
    }
    const selection: BankAccountSelection[] = accounts.filter((a) => wanted.includes(this.handle(a.uid))).map((a) => ({ uidHash: this.handle(a.uid), label: accountLabel(a) }));
    const saved: BankConnection = { ...connection, accounts: selection };
    this.bank.save(this.s.connectionKey, saved);
    return saved;
  }

  /**
   * The provider's account id behind one of the page's handles, and only for an account the owner
   * chose: the stored selection is checked first, then the provider's own session, so an account that
   * was never chosen is refused even though the session can see it, and one the provider no longer
   * lists is refused with a plain sentence rather than a guess.
   */
  private async resolve(value: string): Promise<{ connection: BankConnection; account: BankAccount; label: string }> {
    const connection = this.connection();
    const chosen = connection.accounts.find((a) => a.uidHash === String(value ?? ""));
    if (!chosen) throw new BankError("That account is not one you chose for this connection, so nothing was read.");
    const { accounts } = await this.accounts();
    const account = accounts.find((a) => this.handle(a.uid) === chosen.uidHash);
    if (!account) throw new BankError("The provider no longer lists that account in this session, so nothing was read. Refresh the accounts, or choose again.");
    return { connection, account, label: chosen.label };
  }

  /** One account's balances, read now and kept nowhere. */
  async balances(value: string): Promise<BalanceRead> {
    const { account, label } = await this.resolve(value);
    const at = iso(this.now());
    const lines = await this.o.api.balances(account.uid);
    this.bank.touch(this.s.connectionKey, at);
    return { at, account: label, lines: lines.map((l) => ({ type: l.type, ...(l.name ? { name: l.name } : {}), amount: l.amount, currency: l.currency, ...(l.asOf ? { asOf: l.asOf } : {}) })) };
  }

  /**
   * One account's transactions over a checked window, paged to the end or to the safety bound, and
   * kept nowhere. A bound that stops the read early is reported as such, never smoothed over.
   */
  async transactions(value: string, fromInput: string, toInput: string): Promise<TransactionRead> {
    const today = londonYmd(new Date(this.now()));
    const { from, to } = windowCheck(fromInput, toInput, this.s, today);
    const { account, label } = await this.resolve(value);
    const at = iso(this.now());
    const collected: ReadTransaction[] = [];
    let pages = 0;
    let key: string | undefined;
    let truncated = false;
    for (;;) {
      const page = await this.o.api.transactions(account.uid, { from, to, ...(key ? { continuationKey: key } : {}) });
      pages += 1;
      for (const line of page.lines) {
        collected.push({
          date: line.bookingDate,
          ...(line.valueDate ? { valueDate: line.valueDate } : {}),
          description: line.description,
          amount: line.amount,
          currency: line.currency,
          ...(line.status ? { status: line.status } : {}),
        });
      }
      if (!page.continuationKey || !page.lines.length) break;
      if (pages >= this.s.pagesMax || collected.length >= this.s.rowsMax) {
        truncated = true;
        break;
      }
      key = page.continuationKey;
    }
    this.bank.touch(this.s.connectionKey, at);
    const lines = collected.slice(0, Math.min(this.s.rowsMax, BANK_RENDER_ROWS_MAX));
    return { at, account: label, from, to, lines, count: collected.length, shown: lines.length, truncated, pages };
  }

  /* ---------- Disconnect ---------- */

  /**
   * Three separate things, reported separately: local reads are blocked first (so nothing can be read
   * from this connection even if the rest fails), then the provider's documented session delete is
   * called, then the local record is destroyed. The bank's own consent is its own record and is never
   * claimed here to have been revoked: the report says what to do about it.
   */
  async disconnect(): Promise<DisconnectReport> {
    const state = this.state();
    if (state.kind === "off" || state.kind === "unreadable") throw new BankError(state.reason);
    if (state.kind === "none") throw new BankError("There is no bank connection stored here, so there is nothing to disconnect.");
    const connection = state.connection;
    if (!connection.disconnectedAt) {
      // 1. Blocked now, before anything else, and written down first: a process that stops half way
      //    through leaves a connection that cannot be read, not one that still can.
      this.bank.save(this.s.connectionKey, { ...connection, disconnectedAt: iso(this.now()) });
    }
    this.listing = undefined;
    const local = "Local reads are off from now on: this page refuses every read from that connection.";
    let vendor: string;
    let ok = false;
    try {
      await this.o.api.deleteSession(connection.sessionId);
      ok = true;
      vendor = "The provider's record of the session was deleted (that is the vendor's own record, and it answered).";
    } catch (err) {
      const sentence = err instanceof BankApiError ? bankFailureSentence(err) : err instanceof BankError ? err.message : "The provider could not be reached.";
      vendor = `The provider's record of the session could NOT be deleted: ${sentence}`;
    }
    const until = connection.accessValidUntil ? ` It was due to expire on ${connection.accessValidUntil}.` : "";
    const bank = `The bank's own consent is the bank's record, and this service cannot revoke it from here, whatever the two lines above say.${until} To end it now, revoke the ClearOps access in the HSBC UK app or in online banking.`;
    const record = ok
      ? "The stored session id and the account labels were destroyed with the record."
      : "Because the provider could not be reached, the stored session id was kept for one reason only: so the delete can be tried again. Local reads stay off. Press Disconnect again.";
    if (ok) this.bank.forget();
    return { local, vendor, bank, record };
  }
}
