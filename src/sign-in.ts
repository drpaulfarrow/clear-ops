/**
 * The sign-in that stands in front of the service's two browser pages: the reports view
 * (src/reports.ts) and the jobs board (src/jobs-board.ts).
 *
 * Paul asked on 14 Nov 2026 for those pages to sit behind a password, so that a link which is
 * forwarded, screenshotted or read over his shoulder is not enough on its own. The password is his
 * alone and this service is the only place it ever lives in the clear:
 *
 *  - It is set and changed only on a private one-time page (`GET /password?t=<token>`, then a POST),
 *    opened from the link the chief sends in chat when Paul sends `/password`. The link works once and
 *    expires like the vault's (src/vault.ts, the same pattern). The password is typed there, on his own
 *    phone, and never appears in chat, in a brief, in a log line, in an error message, in a page or in
 *    the store in the clear.
 *  - What the store keeps is a random salt and a scrypt hash (`pagePassword`), compared in constant
 *    time. There is no other copy anywhere, and the hash is written by this service, never by a model.
 *  - Signing in (`POST /sign-in`) sets one session cookie: HttpOnly, Secure, SameSite=Strict, scoped to
 *    this service, carrying nothing but the time it was issued and a signature, so it holds no personal
 *    data and a forwarded link or a screenshot is not a session. It lasts SESSION_DAYS (90) so his
 *    phone stays signed in.
 *  - The signing key is the service's own (`pageSessionKey`), minted on first use and kept in the store
 *    beside the other tokens, so it survives a restart and Paul places no secret anywhere. The key it
 *    actually signs with folds in the password's own hash, so setting a new password ends every session
 *    on every device at once with nothing to sweep.
 *  - Attempts are rate limited per address: a growing delay after each wrong password, then a short
 *    cool-off after too many. Nothing here locks Paul out for good, there is no second factor, and the
 *    `/password` link in chat always gets him back in.
 *
 * The pages themselves are the house style (src/page-style.ts): one narrow column built for a phone,
 * one inline stylesheet, no script, nothing fetched. The password field is the only field the form
 * takes, and the POST is the only thing that ever reads it.
 */
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { escapeHtml, field, htmlPage } from "./page-style.js";
import type { Store } from "./store.js";

/** The sign-in page, the sign-out route, and the one-time page that sets the password. */
export const SIGN_IN_PATH = "/sign-in";
export const SIGN_OUT_PATH = "/sign-out";
export const PASSWORD_PATH = "/password";

/** The cookie that holds a signed-in session. Nothing but the issued time and a signature is in it. */
export const SESSION_COOKIE = "clear_ops_session";
/** How long a session lasts: long enough that his phone stays signed in. */
export const SESSION_DAYS = 90;
/** How long a one-time set-a-password link lasts, the same as the vault's. */
const PASSWORD_TTL_MS = 15 * 60_000;
/** The same number in whole minutes, which the page says in plain words. */
export const PASSWORD_LINK_MINUTES = PASSWORD_TTL_MS / 60_000;
/** The shortest password the page accepts. */
export const MIN_PASSWORD_LENGTH = 8;
/** The longest, so a password cannot be used to make the hashing itself the attack. */
const MAX_PASSWORD_LENGTH = 1024;

/** Rate limiting: a growing delay per wrong attempt, a short cool-off after too many, never permanent. */
export const SIGN_IN_MAX_FAILURES = 5;
export const SIGN_IN_BASE_DELAY_MS = 250;
export const SIGN_IN_MAX_DELAY_MS = 2_000;
export const SIGN_IN_COOL_OFF_MS = 60_000;

/** scrypt's output length, and the salt's, in bytes. */
const KEYLEN = 32;
const SALT_BYTES = 16;

export class SignInError extends Error {}

/** scrypt, with a random salt: the only form of the password the store ever holds. */
const hash = (password: string, salt: Buffer): Buffer => scryptSync(password, salt, KEYLEN);

/** One field out of a Cookie header, whatever else it carries. */
export function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

export interface RateLimit {
  /** Whether this attempt may be checked now. */
  allowed: boolean;
  /** How long to wait before the answer goes back, so guessing is slow as well as limited. */
  delayMs: number;
  /** When it is not allowed, how long until it is again. */
  retryAfterMs: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class SignIn {
  /**
   * One-time set-a-password links, tied to the chat that asked for them. Kept in memory, like the
   * vault's, so a restart simply means asking for a new link.
   */
  private pending = new Map<string, { replyTo: string; expires: number }>();
  /** Wrong attempts per address: how many in a row, and when the last one was. */
  private attempts = new Map<string, { failures: number; last: number }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly wait: (ms: number) => Promise<void> = sleep,
  ) {}

  /* ---------- The password ---------- */

  hasPassword(store: Store): boolean {
    return !!store.settings().pagePassword;
  }

  /**
   * Sets the password, from the one-time page and nowhere else. A fresh random salt every time, and
   * only the salt and the scrypt hash are written; the password itself is never stored, logged or sent
   * anywhere. The session-signing key is minted here on first use and kept, so a restart does not sign
   * Paul out, and because the key folds in the hash, this also ends every session on every device.
   */
  setPassword(store: Store, password: string): void {
    if (password.length < MIN_PASSWORD_LENGTH) throw new SignInError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
    if (password.length > MAX_PASSWORD_LENGTH) throw new SignInError("That password is too long.");
    const salt = randomBytes(SALT_BYTES);
    store.setSetting("pagePassword", { salt: salt.toString("base64"), hash: hash(password, salt).toString("base64"), at: new Date(this.now()).toISOString() });
    if (!store.settings().pageSessionKey) store.setSetting("pageSessionKey", randomBytes(32).toString("base64url"));
  }

  /** True only for the password Paul set, compared in constant time. */
  checkPassword(store: Store, password: string): boolean {
    const p = store.settings().pagePassword;
    if (!p) return false;
    const expected = Buffer.from(p.hash, "base64");
    const got = hash(password, Buffer.from(p.salt, "base64"));
    return expected.length === got.length && timingSafeEqual(expected, got);
  }

  /* ---------- The one-time link (the vault's pattern) ---------- */

  /** A one-time link to the set-a-password page, valid 15 minutes, tied to the chat that asked. */
  link(store: Store, replyTo: string): string {
    for (const [k, p] of this.pending) if (p.expires < this.now()) this.pending.delete(k);
    const token = randomBytes(24).toString("base64url");
    this.pending.set(token, { replyTo, expires: this.now() + PASSWORD_TTL_MS });
    return `${config.publicUrl}${PASSWORD_PATH}?t=${token}`;
  }

  /** The pending link for a token, without using it up (the form page). */
  peek(token: string): boolean {
    const p = this.pending.get(token);
    return !!p && p.expires >= this.now();
  }

  /**
   * Uses up the link and sets the password. Returns the chat to confirm in. A password that is too
   * short, or two that do not match, leaves the link unspent so Paul can try again on the same page.
   */
  setFromLink(store: Store, token: string, password: string, confirm: string): { replyTo: string } {
    const p = this.pending.get(token);
    if (!p || p.expires < this.now()) throw new SignInError("This link has expired or was already used. Ask ClearOps for a new one.");
    if (password !== confirm) throw new SignInError("The two passwords are not the same. Try again.");
    this.setPassword(store, password);
    this.pending.delete(token);
    return { replyTo: p.replyTo };
  }

  /* ---------- Sessions ---------- */

  /**
   * The key a session is signed with: the service's own random key, folded together with the password's
   * hash. No password and no key means no session at all, and a new password changes this key, so a
   * cookie minted before it is refused afterwards.
   */
  private signingKey(store: Store): Buffer | undefined {
    const s = store.settings();
    if (!s.pageSessionKey || !s.pagePassword) return undefined;
    return createHmac("sha256", Buffer.from(s.pageSessionKey, "base64url")).update(s.pagePassword.hash).digest();
  }

  /** The Set-Cookie value for a fresh session. Nothing personal, and nothing readable in it. */
  sessionCookie(store: Store): string | undefined {
    const key = this.signingKey(store);
    if (!key) return undefined;
    const body = `v1.${this.now()}`;
    const sig = createHmac("sha256", key).update(body).digest("base64url");
    return `${SESSION_COOKIE}=${body}.${sig}; Path=/; Max-Age=${SESSION_DAYS * 24 * 60 * 60}; HttpOnly; Secure; SameSite=Strict`;
  }

  /** The Set-Cookie value that clears a session on sign-out. */
  clearCookie(): string {
    return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
  }

  /**
   * True only for a session this service minted, still within its life and still matching the current
   * password. A tampered, expired or foreign cookie is refused, in constant time.
   */
  sessionValid(store: Store, cookieHeader: string | undefined): boolean {
    const key = this.signingKey(store);
    if (!key) return false;
    const value = cookieValue(cookieHeader, SESSION_COOKIE);
    if (!value) return false;
    const parts = value.split(".");
    if (parts.length !== 3 || parts[0] !== "v1") return false;
    const issued = Number(parts[1]);
    if (!Number.isFinite(issued) || parts[1] === "") return false;
    const age = this.now() - issued;
    if (age > SESSION_DAYS * 24 * 60 * 60_000 || age < -60_000) return false;
    const expected = createHmac("sha256", key).update(`v1.${parts[1]}`).digest();
    const got = Buffer.from(parts[2], "base64url");
    return expected.length === got.length && timingSafeEqual(expected, got);
  }

  /* ---------- Rate limiting, per address ---------- */

  /** Whether an attempt from this address may be checked now, and how long to pause first. */
  limit(address: string): RateLimit {
    const key = address || "unknown";
    this.prune(key);
    const seen = this.attempts.get(key);
    if (seen && seen.failures >= SIGN_IN_MAX_FAILURES) {
      const left = SIGN_IN_COOL_OFF_MS - (this.now() - seen.last);
      if (left > 0) return { allowed: false, delayMs: 0, retryAfterMs: left };
      // The cool-off has passed: the record is forgotten, so he is never locked out beyond it.
      this.attempts.delete(key);
      return { allowed: true, delayMs: 0, retryAfterMs: 0 };
    }
    return { allowed: true, delayMs: seen ? Math.min(SIGN_IN_BASE_DELAY_MS * seen.failures, SIGN_IN_MAX_DELAY_MS) : 0, retryAfterMs: 0 };
  }

  /** Records a wrong password and returns the delay to wait before answering it. */
  failed(address: string): { delayMs: number } {
    const key = address || "unknown";
    const seen = this.attempts.get(key) ?? { failures: 0, last: 0 };
    seen.failures += 1;
    seen.last = this.now();
    this.attempts.set(key, seen);
    return { delayMs: Math.min(SIGN_IN_BASE_DELAY_MS * seen.failures, SIGN_IN_MAX_DELAY_MS) };
  }

  /** A right password clears the address's record, so a slip never counts against him afterwards. */
  succeeded(address: string): void {
    this.attempts.delete(address || "unknown");
  }

  /** The small delay before a failed attempt is answered. */
  async pause(ms: number): Promise<void> {
    if (ms > 0) await this.wait(ms);
  }

  /** Forgets addresses whose last wrong attempt is older than the cool-off, so the map stays small. */
  private prune(current: string): void {
    if (this.attempts.size < 64) return;
    for (const [k, v] of this.attempts) if (k !== current && this.now() - v.last > SIGN_IN_COOL_OFF_MS) this.attempts.delete(k);
  }
}

/* ---------- The pages ---------- */

/**
 * The sign-in page: one password field, POST only, in the house style, with one plain sentence on what
 * it unlocks. Nothing typed is ever echoed back, and the page carries no script and fetches nothing.
 */
export function signInPage(o: { next?: string; error?: string }): string {
  const body =
    `<form method="post" action="${SIGN_IN_PATH}" autocomplete="on">` +
    (o.next ? `<input type="hidden" name="next" value="${escapeHtml(o.next)}">` : "") +
    (o.error ? `<p class="hint">${escapeHtml(o.error)}</p>` : "") +
    field({ label: "Password", name: "password", type: "password", required: true, lock: true, attrs: 'autocomplete="current-password"' }) +
    `<button type="submit">Sign in</button></form>`;
  return htmlPage({
    title: "Sign in",
    heading: "Sign in",
    icon: "lock",
    text: "Your saved reports and the jobs board are behind this password.",
    body,
    foot: "Signed in on this device for 90 days. Send /password in chat if you have forgotten it.",
  });
}

/** The page shown when no password has been set yet: no form, just how to get one. */
export function noPasswordPage(): string {
  return htmlPage({
    title: "Sign in",
    heading: "Sign in",
    icon: "lock",
    tone: "alert",
    text: "No password is set yet, so these pages are closed. Send /password in chat and I will send you a private link to choose one.",
    foot: "The reports and the jobs board sit behind this password.",
  });
}

/** The one-time page that sets a new password: the password twice, and nothing else. */
export function passwordPage(token: string, o: { error?: string } = {}): string {
  const body =
    `<form method="post" action="${PASSWORD_PATH}">` +
    `<input type="hidden" name="t" value="${escapeHtml(token)}">` +
    (o.error ? `<p class="hint">${escapeHtml(o.error)}</p>` : "") +
    field({ label: "New password", name: "password", type: "password", required: true, lock: true, attrs: `autocomplete="new-password" minlength="${MIN_PASSWORD_LENGTH}"`, hint: `At least ${MIN_PASSWORD_LENGTH} characters.` }) +
    field({ label: "New password again", name: "confirm", type: "password", required: true, lock: true, attrs: 'autocomplete="new-password"' }) +
    `<button type="submit">Save password</button></form>`;
  return htmlPage({
    title: "Set a password",
    heading: "Set a password",
    icon: "lock",
    text: "This password opens your saved reports and the jobs board. Only its hash is stored, and it never reaches a model or chat.",
    body,
    foot: `This link works once and expires ${PASSWORD_LINK_MINUTES} minutes after it was sent.`,
  });
}

/** What the page says back once the password is saved. */
export function passwordSavedPage(): string {
  return htmlPage({
    title: "Password saved",
    heading: "Password saved",
    icon: "tick",
    tone: "ok",
    text: "Every device that was signed in with the old password is now signed out. Use the new one to sign in again on your phone.",
    foot: "You can close this tab.",
  });
}

/** The service's own instance: the routes and the /password command share it, so a link is the same one. */
export const signIn = new SignIn();
