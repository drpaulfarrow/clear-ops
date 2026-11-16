/**
 * The read-only bank connector's core: its settings, its sealed connection record, and the plain
 * words it uses about itself.
 *
 * What this is for: showing Paul the balances of, and a date-bounded transaction list for, the HSBC UK
 * personal accounts he chooses, by reading them through an account information provider (Enable
 * Banking's AIS API). It is deliberately narrow:
 *
 *  - It never pays, moves or changes anything. There is no payment operation in this file, in the
 *    provider client (src/bank-api.ts) or anywhere else: the client's allowlist is a list of reads
 *    plus the one session delete that disconnect needs.
 *  - No model ever sees any of it. Bank data reaches the owner's page (src/bank-page.ts) and nothing
 *    else: not the job store, not a brief, not a prompt, not an upload, not a job output, not the
 *    outputs mirror, not chat and not the bridge routes.
 *  - Nothing is fetched on a schedule. Every read happens because Paul pressed a button.
 *  - What is kept between visits is the least that keeps the connection alive: the provider's session
 *    id, the chosen accounts as keyed hashes with a masked label, the consent scope and its expiry.
 *    No balance and no transaction is ever stored.
 *
 * The record is sealed with AES-256-GCM under its own key (BANK_CONNECTION_KEY, a service secret kept
 * outside the repository), with the record's own name as additional authenticated data, and there is
 * deliberately no plaintext fallback and no derived-from-something-else key: a missing or short key, a
 * changed key, or a single altered byte of ciphertext stops the connector with a plain sentence rather
 * than letting it read or write anything. (The Google token store in src/google.ts is a precedent to
 * read, not a pattern to copy: it falls back to another secret, which is exactly what is not done here.)
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

/* ---------- Where the owner's page lives ---------- */

/** The owner's page, and every route under it. All of it sits behind the sign-in (src/sign-in.ts). */
export const BANK_PATH = "/bank";
/** Starts a connect action: owner session plus CSRF, POST only. */
export const BANK_CONNECT_PATH = `${BANK_PATH}/connect`;
/** Uses the action up and sends the browser to the bank. POST only. */
export const BANK_START_PATH = `${BANK_PATH}/connect/start`;
/** Where the bank sends the browser back. The one route under BANK_PATH that arrives without a session. */
export const BANK_CALLBACK_PATH = `${BANK_PATH}/callback`;
/** Exchanges the parked one-time code, in the owner's own signed-in session. POST only. */
export const BANK_COMPLETE_PATH = `${BANK_PATH}/connect/complete`;
/** Drops a waiting connection attempt without exchanging anything. POST only. */
export const BANK_CANCEL_PATH = `${BANK_PATH}/connect/cancel`;
/** Saves which accounts are readable. POST only. */
export const BANK_ACCOUNTS_PATH = `${BANK_PATH}/accounts`;
/** Reads balances for one chosen account. POST only. */
export const BANK_BALANCES_PATH = `${BANK_PATH}/balances`;
/** Reads a date-bounded transaction list for one chosen account. POST only. */
export const BANK_TRANSACTIONS_PATH = `${BANK_PATH}/transactions`;
/** Blocks local reads, deletes the provider's session and destroys the local record. POST only. */
export const BANK_DISCONNECT_PATH = `${BANK_PATH}/disconnect`;
/** Re-reads the accounts the provider's session can see. POST only. */
export const BANK_REFRESH_PATH = `${BANK_PATH}/refresh`;

/* ---------- Environment and settings ---------- */

/**
 * Every name this connector owns. None of them may reach a worker, a subprocess, a model conversation,
 * a log or a report: they are added to the strips in src/agents.ts and src/llm.ts, and asserted over
 * every worker kind and every subprocess entry point in test/invariants.test.ts.
 *
 * BANK_CONNECTION_KEY is the key the connection record is sealed under. The other two are the
 * provider's own: the application id (the JWT's `kid`) and the RSA private key the service signs with.
 */
export const BANK_SECRETS = ["BANK_APPLICATION_ID", "BANK_JWT_PRIVATE_KEY", "BANK_CONNECTION_KEY"];

/**
 * The service's own environment with those three names taken out. Almost every subprocess this service
 * starts is given a constructed environment instead of this one (src/bootstrap.ts `gitEnv`, src/setup.ts
 * `installerEnv`, and the browser's own), and none of them ever gets this one. The two that must keep the
 * service's environment, because they need a credential that lives there, are the founder's own approved
 * shell command (src/jobs.ts `run_command`, which deploys with FLY_API_TOKEN) and the gh call that
 * watches the product's deploy (src/design.ts). They are handed this instead, so the bank's keys are the
 * one thing no subprocess of this service can read, whatever it was started for.
 */
export function withoutBankSecrets(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const k of BANK_SECRETS) delete out[k];
  return out;
}

/** The documented provider API. Nothing else is ever called, whatever the environment says. */
export const BANK_API_HOSTS = ["api.enablebanking.com"];
export const BANK_API_BASE_URL_DEFAULT = "https://api.enablebanking.com";

/** The JWT's issuer and audience, as the provider documents them. */
export const BANK_JWT_ISSUER_DEFAULT = "enablebanking.com";
export const BANK_JWT_AUDIENCE_DEFAULT = "api.enablebanking.com";
/** How long a signing token lasts. Short by design, and never longer than the provider's own hour. */
export const BANK_JWT_TTL_SECONDS_DEFAULT = 300;
export const BANK_JWT_TTL_SECONDS_MAX = 3_600;

/** The London date window a transaction read may cover, and how much of it is fetched. */
export const BANK_WINDOW_DAYS_DEFAULT = 30;
export const BANK_WINDOW_DAYS_MAX = 366;
/** The paging safety bound: past this the read stops and says so rather than running on. */
export const BANK_PAGES_MAX_DEFAULT = 10;
export const BANK_ROWS_MAX_DEFAULT = 1_000;
/** How many lines of a read the page draws. The rest is reported as a count, never drawn. */
export const BANK_RENDER_ROWS_MAX = 200;
/** How long a connect action, and a pending bank flow, lasts before it must be started again. */
export const BANK_ACTION_TTL_MS = 10 * 60_000;
export const BANK_FLOW_TTL_MS = 10 * 60_000;
/** How long the accounts listing behind the chooser is reused before the provider is asked again. */
export const BANK_LISTING_TTL_MS = 5 * 60_000;

export class BankError extends Error {}

export interface BankSettings {
  /** Off by default: with BANK_ENABLED unset, every route under /bank says so and calls nothing. */
  enabled: boolean;
  /** The provider's base URL. https, and one of BANK_API_HOSTS. */
  baseUrl: string;
  /** The base URL's host, checked on every single request. */
  host: string;
  /** Set when BANK_API_BASE_URL named something other than the provider's own host: the connector then stays off. */
  baseUrlProblem?: string;
  applicationId: string;
  /** The RSA private key, PEM. Never logged, never rendered, never handed to a worker. */
  jwtKey: string;
  jwtIssuer: string;
  jwtAudience: string;
  jwtTtlSeconds: number;
  /** Where the connection record is sealed. Empty means the connector is off. */
  connectionKey: string;
  /** The exact address registered with the provider, which the callback must come back to. */
  redirectUrl: string;
  /** Which country's banks the discovery call asks for. */
  country: string;
  /** The window (in days) the transaction form offers, and the widest it accepts. */
  windowDays: number;
  windowDaysMax: number;
  /** Paging bounds. */
  pagesMax: number;
  rowsMax: number;
  /**
   * Whether a loopback http address is acceptable for the redirect URL and the provider's
   * authorisation URL. Only the local preview script and the tests set this, and no environment
   * variable can turn it on: it is a constructor option, never read from process.env.
   */
  allowLoopback: boolean;
}

const num = (value: string | undefined, fallback: number, min: number, max: number): number => {
  const n = Number(value);
  if (!value || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
};

const str = (value: string | undefined): string => (value ?? "").trim();

/**
 * A private key is often placed in one environment variable, where a PEM's newlines have to be
 * written as `\n`. Both spellings are accepted; nothing else about the key is interpreted here.
 */
export function pemFromEnv(value: string): string {
  return value.includes("\\n") ? value.replace(/\\n/g, "\n") : value;
}

/** The base URL, checked: https, and one of the hosts the provider actually documents. */
export function checkBaseUrl(value: string): { ok: true; baseUrl: string; host: string } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "BANK_API_BASE_URL is not a web address." };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "BANK_API_BASE_URL must be https." };
  if (!BANK_API_HOSTS.includes(url.hostname)) return { ok: false, reason: `BANK_API_BASE_URL must be one of ${BANK_API_HOSTS.join(", ")}, and it is not.` };
  return { ok: true, baseUrl: `${url.protocol}//${url.host}`, host: url.host };
}

/** Every setting, its default, and the provider's own limits. */
export function bankSettings(env: NodeJS.ProcessEnv = process.env): BankSettings {
  const raw = str(env.BANK_API_BASE_URL) || BANK_API_BASE_URL_DEFAULT;
  const checked = checkBaseUrl(raw);
  // A base URL that is not the provider's own is never silently replaced by the default: the connector
  // stays off and says which setting is wrong (see bankReady), rather than quietly calling somewhere else.
  const base = checked.ok ? checked.baseUrl : BANK_API_BASE_URL_DEFAULT;
  const host = checked.ok ? checked.host : new URL(BANK_API_BASE_URL_DEFAULT).host;
  return {
    enabled: str(env.BANK_ENABLED).toLowerCase() === "true" || str(env.BANK_ENABLED) === "1",
    baseUrl: base,
    host,
    ...(checked.ok ? {} : { baseUrlProblem: checked.reason }),
    applicationId: str(env.BANK_APPLICATION_ID),
    jwtKey: pemFromEnv(str(env.BANK_JWT_PRIVATE_KEY)),
    jwtIssuer: str(env.BANK_JWT_ISSUER) || BANK_JWT_ISSUER_DEFAULT,
    jwtAudience: str(env.BANK_JWT_AUDIENCE) || BANK_JWT_AUDIENCE_DEFAULT,
    jwtTtlSeconds: num(env.BANK_JWT_TTL_SECONDS, BANK_JWT_TTL_SECONDS_DEFAULT, 60, BANK_JWT_TTL_SECONDS_MAX),
    connectionKey: str(env.BANK_CONNECTION_KEY),
    redirectUrl: str(env.BANK_REDIRECT_URL) || `${config.publicUrl}${BANK_CALLBACK_PATH}`,
    country: (str(env.BANK_COUNTRY) || "GB").toUpperCase().slice(0, 2),
    windowDays: num(env.BANK_WINDOW_DAYS, BANK_WINDOW_DAYS_DEFAULT, 1, BANK_WINDOW_DAYS_MAX),
    windowDaysMax: num(env.BANK_WINDOW_DAYS_MAX, BANK_WINDOW_DAYS_MAX, 1, BANK_WINDOW_DAYS_MAX),
    pagesMax: num(env.BANK_PAGES_MAX, BANK_PAGES_MAX_DEFAULT, 1, 100),
    rowsMax: num(env.BANK_ROWS_MAX, BANK_ROWS_MAX_DEFAULT, 1, 10_000),
    allowLoopback: false,
  };
}

/**
 * Whether the connector can run at all, and in plain words why it cannot when it cannot. The page
 * shows this sentence as it is; nothing here is a guess, and a partly configured connector says which
 * piece is missing.
 */
export function bankReady(s: BankSettings): string | undefined {
  if (!s.enabled) return "The bank connector is switched off here (BANK_ENABLED is not set), so nothing is read from any bank.";
  if (s.baseUrlProblem) return `${s.baseUrlProblem} The connector stays off rather than calling anywhere but the provider.`;
  const check = checkBaseUrl(s.baseUrl);
  if (!check.ok) return check.reason;
  if (!s.applicationId) return "The bank connector has no provider application id (BANK_APPLICATION_ID), so it cannot ask the provider for anything.";
  if (!s.jwtKey) return "The bank connector has no signing key (BANK_JWT_PRIVATE_KEY), so it cannot ask the provider for anything.";
  if (!s.connectionKey || s.connectionKey.length < 16) return "The bank connector has no connection key (BANK_CONNECTION_KEY), so nothing would be safe to keep between visits. It stays off until that is set.";
  const redirect = redirectCheck(s.redirectUrl, s.allowLoopback);
  if (!redirect.ok) return redirect.reason;
  return undefined;
}

/**
 * The redirect URL: the exact address registered with the provider. https, or a loopback address for
 * the local preview only. Nothing else is accepted, because the provider sends a one-time code there.
 */
export function redirectCheck(value: string, allowLoopback = false): { ok: true; url: string } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "BANK_REDIRECT_URL is not a web address." };
  }
  if (url.search || url.hash) return { ok: false, reason: "BANK_REDIRECT_URL must not carry a query or a fragment: the provider adds the code itself." };
  if (url.protocol === "https:") return { ok: true, url: url.toString() };
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (allowLoopback && url.protocol === "http:" && loopback) return { ok: true, url: url.toString() };
  return { ok: false, reason: "BANK_REDIRECT_URL must be https (the provider sends a one-time code to it)." };
}

/* ---------- The sealed connection record ---------- */

/** What may be kept about one account: a keyed hash of the provider's id, and a masked label. */
export interface BankAccountSelection {
  /** HMAC-SHA-256 of the provider's account id under the connection key. Never the id itself. */
  uidHash: string;
  /** What the page shows for it: the provider's own name, and the last four characters of its id. */
  label: string;
}

/**
 * The whole of what is kept between visits. There is no balance here, no transaction and no provider
 * credential: the session id is the provider's, and it is only ever handed back to the provider.
 */
export interface BankConnection {
  sessionId: string;
  /** The name the provider's own discovery response gave for the bank, and its country. */
  aspsp: { name: string; country: string };
  /** The consent's scope, exactly as the provider reported it. */
  scope: string[];
  /** The provider's own expiry for the consent, when it gave one. */
  accessValidUntil?: string;
  /** The accounts Paul chose. Empty means nothing is readable, which is not the same as connected. */
  accounts: BankAccountSelection[];
  connectedAt: string;
  lastReadAt?: string;
  /**
   * Set the moment a disconnect starts, before the provider is called: every local read is refused
   * from then on, even if the process stops half way through.
   */
  disconnectedAt?: string;
}

export type BankStoreState =
  | { kind: "off"; reason: string }
  | { kind: "none" }
  | { kind: "unreadable"; reason: string }
  | { kind: "connection"; connection: BankConnection };

export const bankDir = () => path.join(config.dataDir, "bank");

/** The record's own name, bound into the ciphertext as additional authenticated data. */
const AAD = Buffer.from("clear-ops-bank-connection-v1", "utf8");

/**
 * The sealing key: a dedicated secret, hashed to 32 bytes. There is no fallback to another secret and
 * nothing else is tried when it is missing: asking for the key without one is an error, not a weaker
 * key. (BANK_CONNECTION_KEY is not in any repository, brief, log or worker environment.)
 */
export function connectionKey(secret: string): Buffer {
  if (!secret || secret.length < 16) throw new BankError("The bank connector has no connection key (BANK_CONNECTION_KEY), so nothing is read or written.");
  return createHash("sha256").update(`clear-ops-bank-connection-v1:${secret}`).digest();
}

/** AES-256-GCM, a fresh random nonce every time, the record's name authenticated alongside it. */
export function seal(plain: string, key: Buffer, aad: Buffer = AAD): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), body.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
}

/**
 * Opens the record. A wrong key, an altered byte, a truncated value or a shape this service did not
 * write is one plain error and never a partial read: authenticated encryption either gives the whole
 * plaintext back or nothing at all.
 */
export function open(sealed: string, key: Buffer, aad: Buffer = AAD): string {
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") throw new BankError("The stored bank connection is not in a form this service wrote, so it is left alone.");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parts[1], "base64url"));
    decipher.setAAD(aad);
    decipher.setAuthTag(Buffer.from(parts[3], "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(parts[2], "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new BankError("The stored bank connection cannot be read (its key changed, or the file was altered). Nothing is read or written until a fresh connection is made.");
  }
}

/** A keyed handle for one of the provider's account ids. Never reversible, and stable per key. */
export function uidHash(uid: string, key: Buffer): string {
  return createHmac("sha256", key).update(`clear-ops-bank-account-v1:${uid}`).digest("hex");
}

/**
 * What the page calls an account: the provider's own name for it, and only the last four characters of
 * its identifier. A full IBAN or account number never leaves the provider's response.
 */
export function accountLabel(a: { name?: unknown; iban?: unknown }): string {
  const name = typeof a.name === "string" ? a.name.trim().replace(/\s+/g, " ").slice(0, 60) : "";
  const id = typeof a.iban === "string" ? a.iban.replace(/\s+/g, "") : "";
  const tail = id ? `••${id.slice(-4)}` : "";
  const label = [name, tail].filter(Boolean).join(" · ");
  return label.slice(0, 80) || "unnamed account";
}

/** Two strings compared without letting the comparison's timing say anything. */
export function sameSecret(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * The stored record, on the data volume, owner-only. Every failure mode is a state the page can say
 * out loud: off (no key), none (never connected), unreadable (key changed or file altered, which is
 * also what a tampered ciphertext gives) or the connection itself. Nothing else in the service reads
 * this file, and there is no plaintext path to it.
 */
export class BankStore {
  constructor(
    private readonly dir: string = bankDir(),
    private readonly now: () => number = Date.now,
  ) {}

  file(): string {
    return path.join(this.dir, "connection.enc");
  }

  /** Whether a key is configured at all. Nothing is read or written without one. */
  keyed(key: string): boolean {
    return !!key && key.length >= 16;
  }

  state(secret: string): BankStoreState {
    if (!this.keyed(secret)) return { kind: "off", reason: "The bank connector has no connection key (BANK_CONNECTION_KEY), so nothing would be safe to keep between visits. It stays off until that is set." };
    if (!fs.existsSync(this.file())) return { kind: "none" };
    let text: string;
    try {
      text = open(fs.readFileSync(this.file(), "utf8").trim(), connectionKey(secret));
    } catch (err) {
      return { kind: "unreadable", reason: err instanceof BankError ? err.message : "The stored bank connection cannot be read." };
    }
    let parsed: BankConnection;
    try {
      parsed = JSON.parse(text) as BankConnection;
    } catch {
      return { kind: "unreadable", reason: "The stored bank connection cannot be read, so it is left alone." };
    }
    if (!parsed || typeof parsed.sessionId !== "string" || !parsed.sessionId || !Array.isArray(parsed.accounts)) {
      return { kind: "unreadable", reason: "The stored bank connection is not in a form this service wrote, so it is left alone." };
    }
    return { kind: "connection", connection: parsed };
  }

  /** The connection, or undefined when there is none. An unreadable record throws, on purpose. */
  connection(secret: string): BankConnection | undefined {
    const state = this.state(secret);
    if (state.kind === "unreadable") throw new BankError(state.reason);
    return state.kind === "connection" ? state.connection : undefined;
  }

  save(secret: string, connection: BankConnection): void {
    const sealed = seal(JSON.stringify(connection), connectionKey(secret));
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.dir, 0o700);
    const tmp = `${this.file()}.tmp`;
    fs.writeFileSync(tmp, sealed, { mode: 0o600 });
    fs.renameSync(tmp, this.file());
  }

  /** Records a read's time, so the page can say when the record was last used. Never throws. */
  touch(secret: string, at = new Date(this.now()).toISOString()): void {
    try {
      const connection = this.connection(secret);
      if (!connection) return;
      this.save(secret, { ...connection, lastReadAt: at });
    } catch {
      // A record that cannot be read is not made worse by failing to stamp it.
    }
  }

  /** Destroys the local record. The provider's session id goes with it. */
  forget(): boolean {
    if (!fs.existsSync(this.file())) return false;
    fs.rmSync(this.file());
    return true;
  }
}

export const bankStore = new BankStore();

/** How a sealed record and its key are described to Paul, in one line, without either of them. */
export const BANK_KEY_NOTE = "The record is encrypted (AES-256-GCM) under its own key, kept outside the repository; a missing, changed or altered key stops the connector rather than reading anything.";
