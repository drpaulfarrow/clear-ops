import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";

/**
 * Paul's Google Workspace, for the executive assistant ("drafts plus holds").
 *
 * OAuth for his own user account (no service account, no domain-wide delegation). The refresh token
 * is encrypted at rest under DATA_DIR/secrets, owner-only. Every API call goes through GoogleApi,
 * which only reaches the endpoints in ALLOWED_ENDPOINTS: there is no route to sending mail, sending
 * a draft, deleting, archiving or relabelling mail, inviting anyone or answering an invitation,
 * whatever a prompt or an email says.
 */

/** The narrowest scopes for read plus drafts plus holds. gmail.compose could send, so GoogleApi forbids it. */
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
];

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const API_BASE = { gmail: "https://gmail.googleapis.com/gmail/v1/users/me/", calendar: "https://www.googleapis.com/calendar/v3/" } as const;

export type Fetch = typeof fetch;

export interface GoogleSettings {
  clientId: string;
  clientSecret: string;
  /** When set, the only account that may be connected (lower case). */
  account: string;
  /** Encrypts the stored token. Falls back to a key derived from the client secret. */
  tokenKey: string;
  /** e.g. https://clear-ops.fly.dev/google/callback */
  redirectUri: string;
  dataDir: string;
  fetch?: Fetch;
  now?: () => number;
}

interface StoredToken {
  account: string;
  refreshToken: string;
  scopes: string[];
  connectedAt: string;
}

interface PendingConsent {
  verifier: string;
  requestedBy: string;
  replyTo: string;
  expires: number;
}

/** How long a consent link stays valid. */
export const CONSENT_TTL_MS = 15 * 60_000;

export class GoogleError extends Error {}

/* ---------- Encryption at rest ---------- */

function keyFrom(settings: Pick<GoogleSettings, "tokenKey" | "clientSecret">): Buffer {
  if (settings.tokenKey) return createHash("sha256").update(settings.tokenKey).digest();
  if (!settings.clientSecret) throw new GoogleError("No key to encrypt the Google token: set GOOGLE_TOKEN_KEY or GOOGLE_CLIENT_SECRET.");
  return Buffer.from(hkdfSync("sha256", settings.clientSecret, "clear-ops", "google-token-v1", 32));
}

export function encrypt(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: body.toString("base64") });
}

export function decrypt(blob: string, key: Buffer): string {
  const { iv, tag, data } = JSON.parse(blob) as { iv: string; tag: string; data: string };
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
}

/* ---------- OAuth and token storage ---------- */

export class GoogleAuth {
  private pending = new Map<string, PendingConsent>();
  private access?: { token: string; expires: number };
  private readonly fetch: Fetch;
  private readonly now: () => number;
  readonly secretsDir: string;
  readonly tokenFile: string;

  constructor(private readonly s: GoogleSettings) {
    this.fetch = s.fetch ?? fetch;
    this.now = s.now ?? Date.now;
    this.secretsDir = path.join(s.dataDir, "secrets");
    this.tokenFile = path.join(this.secretsDir, "google-token.enc");
  }

  /** The OAuth client exists (the secrets are set). */
  configured(): boolean {
    return Boolean(this.s.clientId && this.s.clientSecret);
  }

  connected(): boolean {
    return fs.existsSync(this.tokenFile);
  }

  /** The connected account, or undefined. Throws only if the stored token cannot be read. */
  account(): string | undefined {
    return this.load()?.account;
  }

  /**
   * A one-time consent link for Paul, valid for CONSENT_TTL_MS. The state is single use and tied to
   * the chat that asked for it, which is where the result is reported. Uses PKCE as well as the secret.
   */
  consentUrl(requestedBy: string, replyTo: string): string {
    if (!this.configured()) throw new GoogleError("Google is not set up yet: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are missing.");
    for (const [k, p] of this.pending) if (p.expires < this.now()) this.pending.delete(k);
    const state = randomBytes(24).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    this.pending.set(state, { verifier, requestedBy, replyTo, expires: this.now() + CONSENT_TTL_MS });
    const q = new URLSearchParams({
      client_id: this.s.clientId,
      redirect_uri: this.s.redirectUri,
      response_type: "code",
      scope: GOOGLE_SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "false",
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    if (this.s.account) q.set("login_hint", this.s.account);
    return `${AUTH_URL}?${q}`;
  }

  /** Handles Google's redirect: checks the state, swaps the code for tokens, checks the account, stores the refresh token encrypted. */
  async completeConsent(state: string, code: string): Promise<{ account: string; requestedBy: string; replyTo: string }> {
    const p = this.pending.get(state);
    this.pending.delete(state);
    if (!p || p.expires < this.now()) throw new GoogleError("This link has expired or was already used. Ask for a new one in chat.");
    const tok = await this.tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.s.redirectUri,
      code_verifier: p.verifier,
    });
    if (!tok.refresh_token) throw new GoogleError("Google did not return a refresh token. Remove the app's access in your Google account settings and try the link again.");
    const granted = String(tok.scope ?? "").split(/\s+/).filter(Boolean);
    const missing = GOOGLE_SCOPES.filter((sc) => !granted.includes(sc));
    if (missing.length) {
      await this.revokeToken(tok.refresh_token).catch(() => undefined);
      throw new GoogleError(`Not all permissions were granted (missing ${missing.map((m) => m.split("/").pop()).join(", ")}). Try again and tick every box.`);
    }
    // Which account this is, from Gmail itself, so no extra identity scope is needed.
    const profile = await this.call(tok.access_token, `${API_BASE.gmail}profile`);
    const account = String((profile as { emailAddress?: string }).emailAddress ?? "").toLowerCase();
    if (!account) throw new GoogleError("Could not tell which Google account this is.");
    if (this.s.account && account !== this.s.account) {
      await this.revokeToken(tok.refresh_token).catch(() => undefined);
      throw new GoogleError(`That was ${account}, but only ${this.s.account} may be connected. Nothing was stored.`);
    }
    this.save({ account, refreshToken: tok.refresh_token, scopes: granted, connectedAt: new Date(this.now()).toISOString() });
    this.access = { token: tok.access_token, expires: this.now() + (Number(tok.expires_in ?? 3600) - 60) * 1000 };
    return { account, requestedBy: p.requestedBy, replyTo: p.replyTo };
  }

  /** A current access token, refreshed when needed. A revoked grant disconnects and says so. */
  async accessToken(): Promise<string> {
    if (this.access && this.access.expires > this.now()) return this.access.token;
    const stored = this.load();
    if (!stored) throw new GoogleError("Google is not connected. Ask the chief for a connect link.");
    if (this.s.account && stored.account !== this.s.account) throw new GoogleError(`The stored Google account ${stored.account} is not ${this.s.account}. Disconnect and connect again.`);
    let tok: Record<string, any>;
    try {
      tok = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: stored.refreshToken });
    } catch (err) {
      if (err instanceof GoogleError && /invalid_grant/.test(err.message)) {
        this.forget();
        throw new GoogleError("Google access was revoked or expired, so it is disconnected. Ask the chief for a new connect link.");
      }
      throw err;
    }
    this.access = { token: tok.access_token, expires: this.now() + (Number(tok.expires_in ?? 3600) - 60) * 1000 };
    // Google may rotate the refresh token; keep the newest.
    if (tok.refresh_token && tok.refresh_token !== stored.refreshToken) this.save({ ...stored, refreshToken: tok.refresh_token });
    return this.access.token;
  }

  /** Revokes the grant at Google and deletes the stored token. True if something was connected. */
  async disconnect(): Promise<boolean> {
    let stored: StoredToken | undefined;
    try {
      stored = this.load();
    } catch {
      stored = undefined;
    }
    const had = this.connected();
    if (stored) await this.revokeToken(stored.refreshToken).catch(() => undefined);
    this.forget();
    return had;
  }

  private forget(): void {
    this.access = undefined;
    fs.rmSync(this.tokenFile, { force: true });
  }

  private load(): StoredToken | undefined {
    if (!fs.existsSync(this.tokenFile)) return undefined;
    try {
      return JSON.parse(decrypt(fs.readFileSync(this.tokenFile, "utf8"), keyFrom(this.s))) as StoredToken;
    } catch {
      throw new GoogleError("The stored Google token cannot be decrypted (the key changed?). Disconnect and connect again.");
    }
  }

  private save(t: StoredToken): void {
    fs.mkdirSync(this.secretsDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.secretsDir, 0o700);
    const tmp = `${this.tokenFile}.tmp`;
    fs.writeFileSync(tmp, encrypt(JSON.stringify(t), keyFrom(this.s)), { mode: 0o600 });
    fs.renameSync(tmp, this.tokenFile);
    fs.chmodSync(this.tokenFile, 0o600);
  }

  private async tokenRequest(params: Record<string, string>): Promise<Record<string, any>> {
    const res = await this.fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...params, client_id: this.s.clientId, client_secret: this.s.clientSecret }).toString(),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok) throw new GoogleError(`Google token request failed: ${body.error ?? res.status}`);
    return body;
  }

  private async revokeToken(token: string): Promise<void> {
    await this.fetch(REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    });
  }

  private async call(token: string, url: string): Promise<unknown> {
    const res = await this.fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new GoogleError(`Google API ${res.status}`);
    return res.json();
  }
}

/* ---------- The only Google endpoints the workforce can reach ---------- */

export type Api = keyof typeof API_BASE;
export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const SEG = "[A-Za-z0-9_\\-.%@]+";

/**
 * Every Google endpoint the executive assistant can call, by API, method and path. Anything else is
 * refused before a request is made. Gmail: read, plus create and update drafts. Calendar: read every
 * calendar, plus create, change and delete events on the primary calendar, which GoogleApi further
 * restricts to holds with no attendees and no notifications.
 */
export const ALLOWED_ENDPOINTS: ReadonlyArray<{ api: Api; method: Method; path: RegExp; what: string }> = [
  { api: "gmail", method: "GET", path: /^profile$/, what: "who is connected" },
  { api: "gmail", method: "GET", path: /^messages$/, what: "search mail" },
  { api: "gmail", method: "GET", path: new RegExp(`^messages/${SEG}$`), what: "read a message" },
  { api: "gmail", method: "GET", path: new RegExp(`^threads/${SEG}$`), what: "read a thread" },
  { api: "gmail", method: "GET", path: /^labels$/, what: "list labels" },
  { api: "gmail", method: "GET", path: /^drafts$/, what: "list drafts" },
  { api: "gmail", method: "GET", path: new RegExp(`^drafts/${SEG}$`), what: "read a draft" },
  { api: "gmail", method: "POST", path: /^drafts$/, what: "create a draft" },
  { api: "gmail", method: "PUT", path: new RegExp(`^drafts/${SEG}$`), what: "update a draft" },
  { api: "calendar", method: "GET", path: /^users\/me\/calendarList$/, what: "list calendars" },
  { api: "calendar", method: "GET", path: new RegExp(`^calendars/${SEG}/events$`), what: "list events" },
  { api: "calendar", method: "GET", path: new RegExp(`^calendars/${SEG}/events/${SEG}$`), what: "read an event" },
  { api: "calendar", method: "POST", path: /^freeBusy$/, what: "free/busy" },
  { api: "calendar", method: "POST", path: /^calendars\/primary\/events$/, what: "place a hold" },
  { api: "calendar", method: "PATCH", path: new RegExp(`^calendars/primary/events/${SEG}$`), what: "move a hold" },
  { api: "calendar", method: "DELETE", path: new RegExp(`^calendars/primary/events/${SEG}$`), what: "remove a hold" },
];

/** Path segments that mean sending, deleting, relabelling or moving, refused even if a pattern above matched. */
const FORBIDDEN_SEGMENT = /(^|\/)(send|trash|untrash|delete|batchDelete|modify|batchModify|import|insert|quickAdd|move|watch|stop|settings|acl|instances)(\/|$)/i;

/** The private property that marks an event as a hold the workforce placed. */
export const HOLD_MARKER = "clearOpsHold";
export const HOLD_PREFIX = "Hold: ";
const HOLD_CREATE_KEYS = new Set(["summary", "description", "start", "end", "transparency", "visibility", "extendedProperties"]);
const HOLD_PATCH_KEYS = new Set(["summary", "description", "start", "end"]);

export function isHold(ev: Record<string, any>): boolean {
  const attendees = Array.isArray(ev.attendees) ? ev.attendees : [];
  const own = ev.organizer === undefined || ev.organizer.self === true;
  return ev.extendedProperties?.private?.[HOLD_MARKER] === "true" && attendees.length === 0 && own;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

/** The one door to Google. Refuses anything not in ALLOWED_ENDPOINTS, and checks every calendar write is a hold. */
export class GoogleApi {
  private readonly fetch: Fetch;

  constructor(
    private readonly auth: Pick<GoogleAuth, "accessToken">,
    fetchImpl?: Fetch,
  ) {
    this.fetch = fetchImpl ?? fetch;
  }

  /** Throws unless this call is one of the allowed operations. Exported for the invariant tests. */
  static check(api: Api, method: Method, p: string, opts: RequestOptions = {}): void {
    if (p.includes("?") || p.includes("#") || p.includes("..") || p.startsWith("/")) throw new GoogleError(`Refused: malformed path ${p}`);
    if (FORBIDDEN_SEGMENT.test(p)) throw new GoogleError(`Refused: ${method} ${api}/${p} is not something the assistant may do.`);
    if (!ALLOWED_ENDPOINTS.some((e) => e.api === api && e.method === method && e.path.test(p))) {
      throw new GoogleError(`Refused: ${method} ${api}/${p} is not an allowed operation.`);
    }
    if (api !== "calendar" || method === "GET" || p === "freeBusy") return;
    // Calendar writes: holds only. Nobody is notified or invited.
    if (opts.query?.sendUpdates !== "none") throw new GoogleError("Refused: calendar changes must use sendUpdates=none.");
    for (const k of ["conferenceDataVersion", "supportsAttachments"]) if (k in (opts.query ?? {})) throw new GoogleError(`Refused: ${k} is not allowed on holds.`);
    if (method === "DELETE") return;
    const body = (opts.body ?? {}) as Record<string, any>;
    const allowed = method === "POST" ? HOLD_CREATE_KEYS : HOLD_PATCH_KEYS;
    for (const k of Object.keys(body)) if (!allowed.has(k)) throw new GoogleError(`Refused: a hold cannot set "${k}" (holds never have attendees or invitations).`);
    if (method === "POST" && body.extendedProperties?.private?.[HOLD_MARKER] !== "true") throw new GoogleError("Refused: new events must be marked as holds.");
    if (method === "POST" && Object.keys(body.extendedProperties ?? {}).some((k) => k !== "private")) throw new GoogleError("Refused: holds use private properties only.");
    if (body.summary !== undefined && !String(body.summary).startsWith(HOLD_PREFIX)) throw new GoogleError(`Refused: a hold's title must start with "${HOLD_PREFIX}".`);
    if (method === "POST" && body.summary === undefined) throw new GoogleError("Refused: a hold needs a title.");
  }

  async request<T = any>(api: Api, method: Method, p: string, opts: RequestOptions = {}): Promise<T> {
    GoogleApi.check(api, method, p, opts);
    // Changing or deleting an event: only one this workforce placed as a hold, with nobody invited.
    if (api === "calendar" && (method === "PATCH" || method === "DELETE")) {
      const ev = await this.send<Record<string, any>>("calendar", "GET", p);
      if (!isHold(ev)) throw new GoogleError("Refused: that event is not a hold placed by the assistant, so it cannot be changed or removed.");
    }
    return this.send<T>(api, method, p, opts);
  }

  private async send<T>(api: Api, method: Method, p: string, opts: RequestOptions = {}): Promise<T> {
    const url = new URL(API_BASE[api] + p);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const token = await this.auth.accessToken();
    const res = await this.fetch(url.toString(), {
      method,
      headers: { authorization: `Bearer ${token}`, ...(opts.body !== undefined ? { "content-type": "application/json" } : {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!res.ok) {
      let reason = String(res.status);
      try {
        reason = JSON.parse(text).error?.message ?? reason;
      } catch {
        // not JSON
      }
      throw new GoogleError(`Google ${api} ${method} failed: ${reason}`);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

/* ---------- What Paul does once, relayed by the chief ---------- */

export function setupSteps(redirectUri: string): string {
  return `One-time Google setup (about 10 minutes, on a laptop):
1. Go to console.cloud.google.com signed in as your Clear Exchange Workspace account. Project picker (top left), New project, name it "clear-ops-ea", Create, then select it.
2. APIs & Services, Library: search "Gmail API", Enable. Back to Library: "Google Calendar API", Enable.
3. Google Auth Platform (also called OAuth consent screen), Get started. App name "Clear Ops EA", support email your address. Audience: Internal. Contact email your address. Agree and Create.
4. Data access, Add or remove scopes. Add: gmail.readonly, gmail.compose, calendar.readonly, calendar.events. Update, Save.
5. Clients, Create client. Type: Web application. Name "clear-ops". Authorised redirect URIs, Add URI: ${redirectUri}  Create, then copy the Client ID and Client secret.
6. In GitHub, drpaulfarrow/clear-ops, Settings, Secrets and variables, Actions, New repository secret, one each: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_ACCOUNT (your Workspace email, so no other account can connect) and GOOGLE_TOKEN_KEY (any long random string, it encrypts the stored token). (Your booking link for scheduling drafts can be set later in chat with /booking.) Then Actions, ci, Run workflow, so the service picks them up.
7. Tell me "connect Google". I send a link; open it, choose your account and Allow. That is all.
Only if Google says the app is blocked: admin.google.com, Security, Access and data control, API controls, Manage third-party app access, find "Clear Ops EA" and set it to Trusted.
To disconnect at any time say "disconnect Google" (or /google disconnect); you can also remove it at myaccount.google.com, Security, Third-party connections.`;
}
