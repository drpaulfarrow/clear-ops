/**
 * The sign-in for the web app under /app (docs/APP.md): GitHub's own sign-in, and one GitHub account.
 *
 * Paul asked on 18 Nov 2026 for a proper interface in place of Discord, signed in with his GitHub
 * account. The app is a second set of browser pages beside the jobs board and the reports view, with
 * its own gate, because it shows more than they do (a job's trace and what it cost). What this gate
 * guarantees:
 *
 *  - Only one GitHub account gets in: `UI_GITHUB_LOGIN` (default drpaulfarrow). GitHub says who signed
 *    in; this service compares the login, and from the first sign-in also GitHub's numeric id for it,
 *    kept in the store, so a login that is renamed and re-registered by someone else is refused.
 *  - The service asks GitHub for no scope at all: the token it receives can read the public profile
 *    and nothing else, is used for exactly one request (`GET /user`) and is then dropped. It is never
 *    stored, logged, put in a cookie or shown to a model.
 *  - The round trip is tied to the browser that started it by a random `state` kept in a short-lived
 *    HttpOnly cookie and compared in constant time, so a callback nobody here asked for is refused.
 *  - A session is one HttpOnly, Secure cookie holding the time it was issued, the GitHub id and a
 *    signature made with the service's own key (`appSessionKey`, minted on first use). It lasts
 *    APP_SESSION_DAYS. It is SameSite=Lax, not Strict, because the sign-in ends on a redirect that
 *    began at github.com; everything under /app that changes anything is a POST, which Lax never
 *    carries from another site.
 *  - Off by default: with no OAuth client configured every page under /app is closed and says so.
 *
 * No model is involved anywhere here, and the client secret is a service secret: stripped from every
 * worker's environment (src/github-auth.ts) and never written to a page, a log or an error.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { cookieValue } from "./sign-in.js";
import type { Store } from "./store.js";

export const APP_PATH = "/app";
export const APP_SIGN_IN_PATH = "/app/sign-in";
export const APP_AUTH_START_PATH = "/app/auth/start";
export const APP_AUTH_CALLBACK_PATH = "/app/auth/callback";
export const APP_SIGN_OUT_PATH = "/app/sign-out";

export const APP_SESSION_COOKIE = "clear_ops_app";
export const APP_STATE_COOKIE = "clear_ops_app_state";
/** How long a session lasts before GitHub is asked again. */
export const APP_SESSION_DAYS = 30;
/** How long a started sign-in may take to come back from GitHub. */
export const APP_STATE_MINUTES = 10;

const GITHUB_AUTHORIZE = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN = "https://github.com/login/oauth/access_token";
const GITHUB_USER = "https://api.github.com/user";
/**
 * A returning sign-in costs two requests to GitHub, so they are limited for the whole service: far
 * more than one person needs, and too few to lean on GitHub with.
 */
export const APP_SIGN_INS_PER_MINUTE = 10;
/** How long either call to GitHub may take before the sign-in is abandoned. */
const GITHUB_TIMEOUT_MS = 8_000;

type AuthStore = Pick<Store, "settings" | "setSetting">;

export interface AppAuthOptions {
  clientId?: string;
  clientSecret?: string;
  /** The one GitHub login allowed in, lower case. */
  login?: string;
  /** Where GitHub sends the browser back to. */
  publicUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

/** Why a sign-in was refused, in words fit for the page. Never carries a code, a token or the secret. */
export type AppAuthRefusal = "off" | "state" | "github" | "account";

export const REFUSAL_TEXT: Record<AppAuthRefusal, string> = {
  off: "The app is not set up yet, so nobody can sign in.",
  state: "That sign-in did not start in this browser, or it took too long. Try again.",
  github: "GitHub did not confirm who you are just now. Try again in a minute.",
  account: "That GitHub account is not allowed in here.",
};

const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export class AppAuth {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly login: string;
  private readonly publicUrl: string;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  /** When GitHub was last asked who someone is, for the limit above. */
  private asked: number[] = [];

  constructor(o: AppAuthOptions = {}) {
    this.clientId = o.clientId ?? config.app.githubClientId;
    this.clientSecret = o.clientSecret ?? config.app.githubClientSecret;
    this.login = (o.login ?? config.app.githubLogin).toLowerCase();
    this.publicUrl = o.publicUrl ?? config.publicUrl;
    this.fetch = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
  }

  /** True once the OAuth client is configured. Until then every page under /app is closed. */
  enabled(): boolean {
    return !!this.clientId && !!this.clientSecret && !!this.login;
  }

  /** The login allowed in, for the sign-in page's one sentence. */
  allowedLogin(): string {
    return this.login;
  }

  private callbackUrl(): string {
    return `${this.publicUrl}${APP_AUTH_CALLBACK_PATH}`;
  }

  /** Starts a sign-in: where to send the browser, and the cookie that ties the answer to it. */
  start(): { url: string; cookie: string } | undefined {
    if (!this.enabled()) return undefined;
    const state = randomBytes(24).toString("base64url");
    const q = new URLSearchParams({ client_id: this.clientId, redirect_uri: this.callbackUrl(), state, allow_signup: "false" });
    return {
      url: `${GITHUB_AUTHORIZE}?${q.toString()}`,
      cookie: `${APP_STATE_COOKIE}=${state}; Path=${APP_PATH}/auth; Max-Age=${APP_STATE_MINUTES * 60}; HttpOnly; Secure; SameSite=Lax`,
    };
  }

  /** The Set-Cookie value that spends the state cookie, whatever the outcome. */
  clearStateCookie(): string {
    return `${APP_STATE_COOKIE}=; Path=${APP_PATH}/auth; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
  }

  /**
   * Finishes a sign-in from GitHub's redirect. A session cookie on success, a reason otherwise.
   * Nothing GitHub returned is kept beyond the login and its numeric id.
   */
  async finish(store: AuthStore, o: { code: unknown; state: unknown; cookieHeader: string | undefined }): Promise<{ cookie: string } | { refused: AppAuthRefusal }> {
    if (!this.enabled()) return { refused: "off" };
    const expected = cookieValue(o.cookieHeader, APP_STATE_COOKIE);
    if (typeof o.state !== "string" || typeof o.code !== "string" || !o.code || !expected || !safeEqual(o.state, expected)) return { refused: "state" };
    const t = this.now();
    this.asked = this.asked.filter((at) => t - at < 60_000);
    if (this.asked.length >= APP_SIGN_INS_PER_MINUTE) return { refused: "github" };
    this.asked.push(t);
    let user: { login: string; id: number } | undefined;
    try {
      user = await this.githubUser(o.code);
    } catch {
      return { refused: "github" };
    }
    if (!user) return { refused: "github" };
    if (user.login.toLowerCase() !== this.login) return { refused: "account" };
    const pinned = store.settings().appGithubUser;
    // The numeric id is pinned to the allowed login the first time it signs in. A different allowed
    // login (UI_GITHUB_LOGIN changed) is pinned afresh; the same login with another id is refused.
    if (pinned && pinned.login === this.login && pinned.id !== user.id) return { refused: "account" };
    if (!pinned || pinned.login !== this.login) store.setSetting("appGithubUser", { login: this.login, id: user.id });
    return { cookie: this.sessionCookie(store, user.id) };
  }

  /** The one exchange with GitHub: the code for a token, the token for who it is, then the token is dropped. */
  private async githubUser(code: string): Promise<{ login: string; id: number } | undefined> {
    const tokenRes = await this.fetch(GITHUB_TOKEN, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "user-agent": "clear-ops" },
      body: JSON.stringify({ client_id: this.clientId, client_secret: this.clientSecret, code, redirect_uri: this.callbackUrl() }),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (!tokenRes.ok) return undefined;
    const token = ((await tokenRes.json()) as { access_token?: unknown }).access_token;
    if (typeof token !== "string" || !token) return undefined;
    const userRes = await this.fetch(GITHUB_USER, {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "clear-ops" },
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (!userRes.ok) return undefined;
    const body = (await userRes.json()) as { login?: unknown; id?: unknown };
    if (typeof body.login !== "string" || typeof body.id !== "number" || !Number.isSafeInteger(body.id)) return undefined;
    return { login: body.login, id: body.id };
  }

  /* ---------- Sessions ---------- */

  private key(store: AuthStore): Buffer {
    let k = store.settings().appSessionKey;
    if (!k) {
      k = randomBytes(32).toString("base64url");
      store.setSetting("appSessionKey", k);
    }
    return Buffer.from(k, "base64url");
  }

  private sessionCookie(store: AuthStore, githubId: number): string {
    const body = `v1.${this.now()}.${githubId}`;
    const sig = createHmac("sha256", this.key(store)).update(body).digest("base64url");
    return `${APP_SESSION_COOKIE}=${body}.${sig}; Path=/; Max-Age=${APP_SESSION_DAYS * 24 * 60 * 60}; HttpOnly; Secure; SameSite=Lax`;
  }

  /** The Set-Cookie value that ends a session on sign-out. */
  clearCookie(): string {
    return `${APP_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
  }

  /**
   * True only for a session this service minted, still within its life, for the account that is
   * allowed in now. A tampered, expired or foreign cookie is refused, in constant time, and so is
   * every session while the app is switched off.
   */
  sessionValid(store: AuthStore, cookieHeader: string | undefined): boolean {
    if (!this.enabled()) return false;
    const s = store.settings();
    const pinned = s.appGithubUser;
    if (!s.appSessionKey || !pinned || pinned.login !== this.login) return false;
    const value = cookieValue(cookieHeader, APP_SESSION_COOKIE);
    if (!value) return false;
    const parts = value.split(".");
    if (parts.length !== 4 || parts[0] !== "v1") return false;
    const issued = Number(parts[1]);
    if (parts[1] === "" || !Number.isFinite(issued)) return false;
    const age = this.now() - issued;
    if (age > APP_SESSION_DAYS * 24 * 60 * 60_000 || age < -60_000) return false;
    if (parts[2] !== String(pinned.id)) return false;
    const expected = createHmac("sha256", Buffer.from(s.appSessionKey, "base64url")).update(`v1.${parts[1]}.${parts[2]}`).digest();
    const got = Buffer.from(parts[3], "base64url");
    return expected.length === got.length && timingSafeEqual(expected, got);
  }
}

/** The service's own instance. */
export const appAuth = new AppAuth();
