/**
 * Paul's login vault for the workforce's browser. Logins are added on a private one-time page served
 * by this service (never in chat, which keeps history), stored encrypted (AES-256-GCM, key from
 * VAULT_KEY, a service secret), and used only by the service itself: an agent asks to sign in to a
 * site and the service fills the form in the browser. No model ever sees a password or a two-factor
 * secret, and the service fills a login only on a page whose host is the entry's own domain.
 *
 * Paul's call (13 Nov 2026): a site with a vault entry is signed in to freely, without asking.
 * Some sites can never be stored (src/site-policy.ts `NEVER_SITES`): banks and payments, email,
 * Microsoft and work accounts, password managers.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { decrypt, encrypt } from "./google.js";
import { neverReason, normaliseDomain } from "./site-policy.js";

export interface VaultEntry {
  domain: string;
  username: string;
  password: string;
  /** Base32 TOTP secret, when Paul chose to store his two-factor setup key. */
  totp?: string;
  /** Where to start signing in, when the site's home page has no login form. */
  loginUrl?: string;
  addedAt: string;
  lastUsedAt?: string;
}

/** What chat and the agents may see about an entry: never the password or the TOTP secret. */
export interface VaultSummary {
  domain: string;
  username: string;
  twoFactor: boolean;
  addedAt: string;
  lastUsedAt?: string;
}

export class VaultError extends Error {}

const ADD_TTL_MS = 15 * 60_000;

export const vaultDir = () => path.join(config.dataDir, "vault");

function key(): Buffer {
  const k = process.env.VAULT_KEY;
  if (!k || k.length < 16) throw new VaultError("The vault is off: VAULT_KEY is not set (a long random secret in the Fly secrets).");
  return createHash("sha256").update(`clear-ops-vault-v1:${k}`).digest();
}

export function vaultEnabled(): boolean {
  const k = process.env.VAULT_KEY;
  return !!k && k.length >= 16;
}

/* ---------- TOTP (RFC 6238, SHA-1, 6 digits, 30 seconds) ---------- */

export function base32Decode(s: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = s.replace(/[\s=-]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = alphabet.indexOf(ch);
    if (i < 0) throw new VaultError("The two-factor key is not valid base32 (letters A to Z and digits 2 to 7).");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totp(secret: string, at = Date.now(), step = 30, digits = 6): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / step)));
  const h = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** digits).padStart(digits, "0");
}

/* ---------- The store ---------- */

export class Vault {
  private pending = new Map<string, { replyTo: string; domain?: string; expires: number }>();

  constructor(
    private readonly dir: string = vaultDir(),
    private readonly now: () => number = Date.now,
  ) {}

  private file(): string {
    return path.join(this.dir, "logins.enc");
  }

  private read(): Record<string, VaultEntry> {
    if (!fs.existsSync(this.file())) return {};
    try {
      return JSON.parse(decrypt(fs.readFileSync(this.file(), "utf8"), key())) as Record<string, VaultEntry>;
    } catch (err) {
      if (err instanceof VaultError) throw err;
      throw new VaultError("The vault cannot be decrypted (did VAULT_KEY change?).");
    }
  }

  private write(entries: Record<string, VaultEntry>): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.dir, 0o700);
    const tmp = `${this.file()}.tmp`;
    fs.writeFileSync(tmp, encrypt(JSON.stringify(entries), key()), { mode: 0o600 });
    fs.renameSync(tmp, this.file());
  }

  /** A one-time link to the add-a-login page, valid 15 minutes, tied to the chat that asked. */
  addLink(replyTo: string, domain?: string): string {
    key();
    for (const [k, p] of this.pending) if (p.expires < this.now()) this.pending.delete(k);
    const token = randomBytes(24).toString("base64url");
    this.pending.set(token, { replyTo, domain: domain ? normaliseDomain(domain) : undefined, expires: this.now() + ADD_TTL_MS });
    return `${config.publicUrl}${VAULT_ADD_PATH}?t=${token}`;
  }

  /** The pending add for a token, without using it up (the form page). */
  peek(token: string): { domain?: string } | undefined {
    const p = this.pending.get(token);
    if (!p || p.expires < this.now()) return undefined;
    return { domain: p.domain };
  }

  /**
   * Validates one login, whichever way it arrived: the one-time add page, or a sign-up Paul approved.
   * The never-list, a real username and password, a two-factor key if given, and a login address on
   * the site's own domain over https.
   */
  private entry(input: { domain: string; username: string; password: string; totp?: string; loginUrl?: string }): VaultEntry {
    const domain = normaliseDomain(input.domain);
    const never = neverReason(domain);
    if (never) throw new VaultError(`${domain} cannot be stored: ${never}.`);
    if (!input.username.trim() || !input.password) throw new VaultError("Give both a username and a password.");
    const secret = input.totp?.replace(/\s+/g, "") || undefined;
    if (secret) totp(secret); // validates the key
    let loginUrl: string | undefined;
    if (input.loginUrl?.trim()) {
      const u = new URL(input.loginUrl.trim());
      if (u.protocol !== "https:" || !hostMatches(u.hostname, domain)) throw new VaultError(`The login address must be https on ${domain}.`);
      loginUrl = u.toString();
    }
    return { domain, username: input.username.trim(), password: input.password, ...(secret ? { totp: secret } : {}), ...(loginUrl ? { loginUrl } : {}), addedAt: new Date(this.now()).toISOString() };
  }

  /** Saves a login from the add page. Uses up the token. Returns the chat to confirm in. */
  add(token: string, input: { domain: string; username: string; password: string; totp?: string; loginUrl?: string }): { replyTo: string; summary: VaultSummary } {
    const p = this.pending.get(token);
    if (!p || p.expires < this.now()) throw new VaultError("This link has expired or was already used. Ask ClearOps for a new one.");
    const entry = this.entry(input);
    this.pending.delete(token);
    const entries = this.read();
    entries[entry.domain] = entry;
    this.write(entries);
    return { replyTo: p.replyTo, summary: summarise(entry) };
  }

  /**
   * Saves a login the service itself made: an account created through the sign-up gate (src/signup-gate.ts)
   * after Paul approved it. The password is generated at that moment and never reaches a model, chat, a
   * log or a job output; this is the only other way into the vault.
   */
  save(input: { domain: string; username: string; password: string; loginUrl?: string }): VaultSummary {
    const entry = this.entry(input);
    const entries = this.read();
    entries[entry.domain] = entry;
    this.write(entries);
    return summarise(entry);
  }

  list(): VaultSummary[] {
    if (!vaultEnabled()) return [];
    return Object.values(this.read()).map(summarise).sort((a, b) => a.domain.localeCompare(b.domain));
  }

  remove(domain: string): boolean {
    const d = normaliseDomain(domain);
    const entries = this.read();
    if (!entries[d]) return false;
    delete entries[d];
    this.write(entries);
    const session = this.sessionFile(d);
    if (fs.existsSync(session)) fs.rmSync(session);
    return true;
  }

  /** The entry for a page's host, for the service's own sign-in code only. Never handed to a model. */
  entryFor(host: string): VaultEntry | undefined {
    if (!vaultEnabled()) return undefined;
    const entries = this.read();
    const match = Object.values(entries).find((e) => hostMatches(host, e.domain));
    return match;
  }

  /** Domains with a stored login (sign-in and acting there need no approval). */
  domains(): string[] {
    return this.list().map((s) => s.domain);
  }

  markUsed(domain: string): void {
    const entries = this.read();
    if (!entries[domain]) return;
    entries[domain].lastUsedAt = new Date(this.now()).toISOString();
    this.write(entries);
  }

  /* Signed-in sessions (cookies), saved encrypted so agents do not log in every time. */

  private sessionFile(domain: string): string {
    return path.join(this.dir, "sessions", `${domain.replace(/[^a-z0-9.-]/g, "_")}.enc`);
  }

  saveSession(domain: string, state: unknown): void {
    const f = this.sessionFile(domain);
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    fs.writeFileSync(f, encrypt(JSON.stringify(state), key()), { mode: 0o600 });
  }

  /** Cookies saved for every stored login, merged, for a new browser session. */
  savedCookies(): Array<Record<string, unknown>> {
    if (!vaultEnabled()) return [];
    const out: Array<Record<string, unknown>> = [];
    for (const d of this.domains()) {
      const f = this.sessionFile(d);
      if (!fs.existsSync(f)) continue;
      try {
        const s = JSON.parse(decrypt(fs.readFileSync(f, "utf8"), key())) as { cookies?: Array<Record<string, unknown>> };
        // Only that site's own cookies come back.
        out.push(...(s.cookies ?? []).filter((c) => hostMatches(String(c.domain ?? "").replace(/^\./, ""), d)));
      } catch {
        // A session that cannot be read is simply not restored; the agent signs in again.
      }
    }
    return out;
  }
}

export const VAULT_ADD_PATH = "/vault/add";

/** host is domain itself or a subdomain of it. */
export function hostMatches(host: string, domain: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return h === domain || h.endsWith(`.${domain}`);
}

function summarise(e: VaultEntry): VaultSummary {
  return { domain: e.domain, username: e.username, twoFactor: !!e.totp, addedAt: e.addedAt, ...(e.lastUsedAt ? { lastUsedAt: e.lastUsedAt } : {}) };
}

export const vault = new Vault();

/** The vault's domains, or none when it is off or cannot be read: a broken vault never breaks the browser. */
export function safeVaultDomains(): string[] {
  try {
    return vault.domains();
  } catch {
    return [];
  }
}
