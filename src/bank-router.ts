/**
 * The bank page's routes: the HTTP skin over src/bank-gate.ts, and the only place the owner's session
 * is checked for it.
 *
 *  - Every route under /bank except the bank's own redirect back requires the owner's own signed-in
 *    session (src/sign-in.ts), checked here as well as by the gate in src/index.ts, so reordering a
 *    middleware cannot open it. A board link, a reports link or the bridge token is not a session.
 *  - Every route that changes anything is a POST carrying the session's CSRF token, and there is no
 *    state-changing GET anywhere: the callback is the bank's own GET redirect, and all it does is park
 *    a one-time code in memory for the owner's next authenticated POST. It exchanges nothing, writes
 *    nothing, and its query string is never logged, echoed or put in a link.
 *  - Every answer is `no-store`, framed by nothing, with a restrictive CSP, no referrer and no sniffing,
 *    and every page it sends comes from src/bank-page.ts, which escapes everything the provider said.
 *  - A failure is one plain sentence: a provider status is never shown as a number alone, a stack is
 *    never shown at all, and an unexpected error becomes a fixed sentence rather than whatever the
 *    error's message happened to be (an error's message can carry a token).
 */
import express from "express";
import {
  BANK_ACCOUNTS_PATH,
  BANK_BALANCES_PATH,
  BANK_CALLBACK_PATH,
  BANK_CANCEL_PATH,
  BANK_COMPLETE_PATH,
  BANK_CONNECT_PATH,
  BANK_DISCONNECT_PATH,
  BANK_PATH,
  BANK_REFRESH_PATH,
  BANK_START_PATH,
  BANK_TRANSACTIONS_PATH,
  BankError,
  accountLabel,
  type BankSettings,
  type BankStore,
} from "./bank.js";
import { BankApiError, type BankApi, bankFailureSentence } from "./bank-api.js";
import { BANK_CONSENT_DAYS, BankGate, sessionFingerprint } from "./bank-gate.js";
import { bankMessagePage, renderBank, type BankRead, type BankView } from "./bank-page.js";
import { addDays, londonYmd } from "./london.js";
import { SIGN_IN_PATH, type SignIn } from "./sign-in.js";
import type { Store } from "./store.js";

export interface BankRouterDeps {
  store: Store;
  signIn: SignIn;
  settings: BankSettings;
  api: BankApi;
  /** The sealed record's store. The real one on the data volume by default; tests inject one. */
  bankStore?: BankStore;
  now?: () => number;
}

const bankHeaders = (res: express.Response): void => {
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    Pragma: "no-cache",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; img-src 'none'; object-src 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Opener-Policy": "same-origin",
  });
};

const one = (v: unknown): string => (typeof v === "string" ? v : "");
const many = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * This router is mounted at BANK_PATH, so a route registered inside it carries only the part after it
 * (the address the browser uses is still the one in src/bank.ts, which is also what the sign-in gate
 * and the sign-out link use).
 */
const rel = (p: string): string => (p === BANK_PATH ? "/" : p.startsWith(`${BANK_PATH}/`) ? p.slice(BANK_PATH.length) : p);

export function bankRouter(deps: BankRouterDeps): express.Router {
  const router = express.Router();
  const gate = new BankGate({ store: deps.store, settings: deps.settings, api: deps.api, bankStore: deps.bankStore, now: deps.now });
  const { store, signIn, settings } = deps;
  const now = deps.now ?? Date.now;
  router.use(express.urlencoded({ extended: false, limit: "16kb" }));

  /** The owner's session, or a redirect to the sign-in page carrying where he was going. */
  const owner = (req: express.Request, res: express.Response): string | undefined => {
    if (signIn.sessionValid(store, req.headers.cookie)) return sessionFingerprint(req.headers.cookie);
    res.redirect(303, `${SIGN_IN_PATH}?next=${encodeURIComponent(BANK_PATH)}`);
    return undefined;
  };

  /** The window the transaction form starts with, and the bounds every read is checked against. */
  const defaultWindow = () => {
    const today = londonYmd(new Date(now()));
    return { from: addDays(today, -(settings.windowDays - 1)), to: today };
  };

  const base = (fingerprint: string): BankView => ({
    csrf: gate.csrf(fingerprint) ?? "",
    state: "not-connected",
    window: defaultWindow(),
    redirectUrl: settings.redirectUrl,
    days: BANK_CONSENT_DAYS,
  });

  /** One plain sentence for whatever went wrong, and never an unexpected error's own words. */
  const sentenceFor = (err: unknown): string => {
    if (err instanceof BankApiError || err instanceof BankError) return bankFailureSentence(err);
    return "Something went wrong at this end, so nothing was read and nothing was changed. Try again.";
  };

  /**
   * Everything the page needs in its current state: this service's own records, and — for the account
   * list alone — the provider. Never a balance and never a transaction: those are read only by the POST
   * that asked for them.
   */
  const view = async (fingerprint: string, o: { notice?: string; failure?: string; read?: BankRead } = {}): Promise<BankView> => {
    const off = gate.off();
    if (off) return { ...base(fingerprint), state: "off", off, ...o };
    const stored = gate.state();
    if (stored.kind === "off") return { ...base(fingerprint), state: "off", off: stored.reason, ...o };
    if (stored.kind === "unreadable") return { ...base(fingerprint), state: "unreadable", off: stored.reason, ...o };
    const waiting = gate.waiting(fingerprint);
    const waitingView = (): BankView => ({
      ...base(fingerprint),
      state: waiting?.parked ? "parked" : "waiting",
      aspsp: waiting?.aspsp.name,
      ...(waiting
        ? { waiting: { aspsp: waiting.aspsp.name, parked: waiting.parked, startedAt: new Date(waiting.startedAt).toISOString(), ...(waiting.url ? { url: waiting.url } : {}) } }
        : {}),
      ...o,
    });
    const connection = stored.kind === "connection" ? stored.connection : undefined;
    if (!connection || connection.disconnectedAt) {
      if (waiting) return waitingView();
      if (!connection) return { ...base(fingerprint), ...o };
      // A connection that was disconnected: nothing is read from it again, and that is said plainly.
      return { ...base(fingerprint), ...o, notice: `This connection was disconnected. Local reads are off, and it is not read from again.${o.notice ? ` ${o.notice}` : ""}` };
    }
    if (waiting) return waitingView();
    const head: BankView = {
      ...base(fingerprint),
      state: "connected",
      aspsp: connection.aspsp.name,
      connection: {
        aspsp: connection.aspsp.name,
        scope: connection.scope,
        connectedAt: connection.connectedAt,
        ...(connection.accessValidUntil ? { accessValidUntil: connection.accessValidUntil } : {}),
        ...(connection.lastReadAt ? { lastReadAt: connection.lastReadAt } : {}),
      },
      ...o,
    };
    try {
      const listed = await gate.accounts();
      const chosen = new Set(connection.accounts.map((a) => a.uidHash));
      return {
        ...head,
        listingAt: listed.at,
        accounts: listed.accounts.map((a) => ({ handle: gate.handle(a.uid), label: accountLabel(a), chosen: chosen.has(gate.handle(a.uid)) })),
      };
    } catch (err) {
      // The connection is still there and still readable; only the list of what it can see failed, and
      // that is said as itself rather than as a lost connection.
      return { ...head, failure: o.failure ?? sentenceFor(err) };
    }
  };

  /**
   * A POST route's boilerplate: the owner's session, then the session's CSRF token, then one place its
   * failures are turned into plain words. Returns the session's fingerprint, or undefined when the
   * request was answered here (not signed in, or not this session's form).
   */
  const guarded = async (req: express.Request, res: express.Response): Promise<string | undefined> => {
    const fingerprint = owner(req, res);
    if (!fingerprint) return undefined;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!gate.csrfOk(one(body.csrf), fingerprint)) {
      const refused = await view(fingerprint, { failure: "That form was not one this session was given, so nothing was done. Reload the bank page and try again." });
      res.status(400).type("html").send(renderBank(refused));
      return undefined;
    }
    return fingerprint;
  };

  /** A POST route that answers with the page, whatever the outcome. */
  const change = (path: string, run: (req: express.Request, fingerprint: string) => Promise<BankView>) => {
    router.post(rel(path), async (req, res) => {
      bankHeaders(res);
      const fingerprint = await guarded(req, res);
      if (!fingerprint) return;
      try {
        res.type("html").send(renderBank(await run(req, fingerprint)));
      } catch (err) {
        res.type("html").send(renderBank(await view(fingerprint, { failure: sentenceFor(err) })));
      }
    });
  };

  /* ---------- The page itself ---------- */

  router.get("/", async (req, res) => {
    bankHeaders(res);
    const fingerprint = owner(req, res);
    if (!fingerprint) return;
    try {
      res.type("html").send(renderBank(await view(fingerprint)));
    } catch (err) {
      res.type("html").send(renderBank(await view(fingerprint, { failure: sentenceFor(err) })));
    }
  });

  /* ---------- Connecting ---------- */

  change(BANK_CONNECT_PATH, async (req, fingerprint) => ({ ...base(fingerprint), state: "confirm", action: gate.newAction(fingerprint).token }));

  /**
   * Uses the connect action up and answers with the page that offers the bank's own address as a link.
   *
   * Deliberately not a redirect to the bank. Every page here is served with `form-action 'self'`, and a
   * browser applies `form-action` to the redirects of a form submission as well as to its target, so a
   * 303 to the bank's page is refused by the browser outright (the navigation is aborted) and the owner never
   * reaches his bank. The bank's own domain cannot be named in the policy in advance, because which
   * bank the provider hands back is its answer, not this service's setting. A link is not a form
   * submission, so the policy stays strict and the owner still gets to the bank: one press, from this
   * signed-in page, and the address is the provider's own over https (checked in src/bank-api.ts). It
   * is drawn escaped by src/bank-page.ts and never put in this page's own address.
   *
   * Nothing has been read and nothing is stored: the connection is made only at the end, on the
   * owner's own POST.
   */
  router.post(rel(BANK_START_PATH), async (req, res) => {
    bankHeaders(res);
    const fingerprint = await guarded(req, res);
    if (!fingerprint) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const started = await gate.start(one(body.action), fingerprint);
      const notice = `Nothing has been read yet. Continue to ${started.aspsp.name} to authorise a read-only consent, then come back here to finish.`;
      res.type("html").send(renderBank(await view(fingerprint, { notice })));
    } catch (err) {
      res.type("html").send(renderBank(await view(fingerprint, { failure: sentenceFor(err) })));
    }
  });

  change(BANK_COMPLETE_PATH, async (_req, fingerprint) => {
    const connection = await gate.complete(fingerprint);
    return view(fingerprint, { notice: `Connected to ${connection.aspsp.name}. Now choose which accounts may be read: until you do, nothing on your account is readable.` });
  });
  change(BANK_CANCEL_PATH, async (req, fingerprint) => {
    gate.cancel(fingerprint);
    return view(fingerprint, { notice: "That connection attempt was cancelled. Nothing was exchanged and nothing was stored." });
  });
  change(BANK_ACCOUNTS_PATH, async (req, fingerprint) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const saved = await gate.choose(many(body.account));
    return view(fingerprint, { notice: `Saved: ${saved.accounts.length} account${saved.accounts.length === 1 ? "" : "s"} readable.` });
  });
  change(BANK_REFRESH_PATH, async (req, fingerprint) => {
    const listed = await gate.accounts(true);
    return view(fingerprint, { notice: `The account list was read from the provider again (${listed.accounts.length} account${listed.accounts.length === 1 ? "" : "s"}).` });
  });

  /* ---------- Reads ---------- */

  change(BANK_BALANCES_PATH, async (req, fingerprint) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    return view(fingerprint, { read: { kind: "balances", read: await gate.balances(one(body.account)) } });
  });

  change(BANK_TRANSACTIONS_PATH, async (req, fingerprint) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    return view(fingerprint, { read: { kind: "transactions", read: await gate.transactions(one(body.account), one(body.from), one(body.to)) } });
  });

  change(BANK_DISCONNECT_PATH, async (req, fingerprint) => {
    const report = await gate.disconnect();
    return { ...(await view(fingerprint, { read: { kind: "disconnect", report } })), notice: report.local };
  });

  /* ---------- The bank's own redirect back ---------- */

  /**
   * The only route here without a session, because the bank's cross-site redirect cannot carry one (the
   * session cookie is SameSite=Strict, deliberately). It decides nothing: it parks the one-time code
   * against the state this service minted, or refuses, and either way it writes nothing and exchanges
   * nothing. Its query string is never logged, echoed, put in a link or kept beyond the code itself.
   */
  router.get(rel(BANK_CALLBACK_PATH), (req, res) => {
    bankHeaders(res);
    const outcome = gate.acceptCallback({ state: one(req.query.state), code: one(req.query.code), error: one(req.query.error) });
    if (outcome.kind === "parked") {
      return res.type("html").send(
        bankMessagePage({
          title: "Back from the bank",
          heading: "Back from the bank",
          icon: "bank",
          tone: "ok",
          text: "The bank has handed back an authorisation for this connection.",
          body: `<p class="note">It is held in memory, useable once, and is discarded the moment it is used or this attempt expires. Nothing has been read and nothing has been stored yet.</p><a class="back" href="${BANK_PATH}">Go to the bank page to finish</a>`,
          foot: "The tab you started from is the one that can finish this. This page is not signed in.",
        }),
      );
    }
    return res.status(outcome.kind === "declined" ? 400 : 400).type("html").send(
      bankMessagePage({
        title: "Nothing was connected",
        heading: "Nothing was connected",
        icon: "alert",
        tone: "alert",
        text: outcome.reason,
        foot: "Nothing was read, nothing was stored, and no session was made.",
      }),
    );
  });

  return router;
}
