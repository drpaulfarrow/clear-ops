/**
 * DNS for Paul's GoDaddy domains: the one allowlisted door to the GoDaddy Domains API, and the rules
 * that decide which record changes may even be proposed.
 *
 * Reads are free (listing domains and records). A write exists only as a change Paul approved in chat
 * (src/dns-gate.ts): `GoDaddyClient.write` needs a single-use grant bound to the exact request, minted
 * only in dns-gate.ts. The client reaches only the paths in `routeOf`: it has no delete, no renew,
 * transfer, lock, contact, nameserver or any other registrar call, so no prompt can ask for one.
 * Credentials: a Personal Access Token (GODADDY_API_TOKEN, `Authorization: Bearer`) when set, which GoDaddy
 * accepts on the v3 Domains API (`/v3/domains/zones/{zone}/dns-records`); otherwise the classic key and secret
 * (`sso-key`) on v1. They are read here, sent only in the Authorization header and scrubbed from every error.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { config } from "./config.js";
import { looksLikeSecret } from "./outbound.js";

export interface DnsRecord {
  type: string;
  name: string;
  data: string;
  ttl: number;
  priority?: number;
  /** GoDaddy v3's id for the record, needed to replace it. Not part of what Paul is shown or approves. */
  recordId?: string;
}

/** One requested change. "add" appends a record; "replace" swaps the single existing record of that type and name. */
export interface DnsChange {
  action: "add" | "replace";
  type: "A" | "AAAA" | "CNAME" | "TXT";
  name: string;
  data: string;
  ttl?: number;
}

export class DnsError extends Error {}

export const DEFAULT_TTL = 3600;
export const MAX_CHANGES = 5;
const TYPES = ["A", "AAAA", "CNAME", "TXT"] as const;

export const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

/* ---------- Domains and names ---------- */

export const allowedDomains = (): string[] => config.dns.domains;
export function isAllowedDomain(domain: string): boolean {
  return allowedDomains().includes(domain.trim().toLowerCase());
}
export function requireDomain(domain: string): string {
  const d = String(domain ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!isAllowedDomain(d)) throw new DnsError(`Refused: ${d || "(no domain)"} is not on the list of domains the DNS agent may touch (${allowedDomains().join(", ") || "none"}). Paul changes that list in the GODADDY_DOMAINS setting.`);
  return d;
}

/** "publisher.clearexchange.ai" and "publisher" both become "publisher"; the apex becomes "@". */
export function relativeName(domain: string, name: string): string {
  let n = String(name ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (n === domain) return "@";
  if (n.endsWith(`.${domain}`)) n = n.slice(0, -domain.length - 1);
  return n || "@";
}

const LABEL = "[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?";
const NAME = new RegExp(`^(?:@|${LABEL}(?:\\.${LABEL})*)$`);
const HOST = /^(?=.{1,253}\.?$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\.?$/;

/** Email authentication names and values. Changing them can send or intercept Paul's mail, so they are never changed here. */
const EMAIL_NAME = /(^|\.)(_dmarc|_domainkey|_mta-sts|_smtp|_bimi)(\.|$)|\._domainkey(\.|$)/;
const EMAIL_VALUE = /v\s*=\s*(spf1|dmarc1|dkim1|stsv1|tlsrptv1|bimi1)/i;

function privateV4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

/* ---------- The rules ---------- */

/**
 * Why a proposed change is refused, or [] if it is acceptable. `zone` is the live zone; the rules
 * depend on what is already there (a replace needs exactly one record to replace, a CNAME needs a free name).
 * These are hard blocks: there is no extra-confirmation step, Paul does those in GoDaddy himself.
 */
export function blockers(domain: string, changes: DnsChange[], zone: DnsRecord[]): string[] {
  const out: string[] = [];
  if (!changes.length) return ["No change was given."];
  if (changes.length > MAX_CHANGES) return [`${changes.length} changes in one go is over the limit of ${MAX_CHANGES}. Split it, or do it in GoDaddy.`];
  const seen = new Set<string>();
  for (const c of changes) {
    const label = `${c.action} ${c.type} ${c.name}`;
    const no = (why: string) => out.push(`${label}: ${why}`);
    if (c.action !== "add" && c.action !== "replace") {
      no('deleting records is never done here (only "add" and "replace" exist); delete in GoDaddy.');
      continue;
    }
    if (!(TYPES as readonly string[]).includes(c.type)) {
      no(`${String(c.type).toUpperCase()} records are never changed here (only A, AAAA, CNAME and TXT). NS, MX, SRV, CAA and SOA stay in GoDaddy.`);
      continue;
    }
    if (c.name === "@" && c.type !== "TXT") no("apex A, AAAA and CNAME records are never changed here, because they point the whole domain and its www at a server.");
    if (c.name === "@" && c.type === "TXT" && c.action === "replace") no("replacing apex TXT records is never done here (they hold SPF); add one instead.");
    if (!NAME.test(c.name) || c.name.length > 200) no("that is not a plain record name (letters, digits, hyphens and underscores; no wildcards).");
    if (EMAIL_NAME.test(c.name)) no("SPF, DKIM, DMARC and other email authentication records are never changed here.");
    if (typeof c.data !== "string" || !c.data.trim() || c.data.length > 512 || /[\r\n]/.test(c.data)) no("the value must be one line of 1 to 512 characters.");
    if (c.ttl !== undefined && (!Number.isInteger(c.ttl) || c.ttl < 600 || c.ttl > 86_400)) no("the TTL must be a whole number of seconds from 600 to 86400.");
    if (EMAIL_VALUE.test(c.data ?? "")) no("SPF, DKIM, DMARC and other email authentication values are never set here.");
    if (looksLikeSecret(c.data ?? "")) no("the value looks like a secret or a private path.");
    if (c.type === "CNAME" && !HOST.test(c.data.trim().toLowerCase())) no("a CNAME value must be a host name such as clear-exchange.fly.dev.");
    if (c.type === "CNAME" && c.data.trim().toLowerCase().replace(/\.$/, "") === `${c.name}.${domain}`) no("a CNAME cannot point at itself.");
    if (c.type === "A" && (!net.isIPv4(c.data.trim()) || privateV4(c.data.trim()))) no("an A value must be a public IPv4 address.");
    if (c.type === "AAAA" && (!net.isIPv6(c.data.trim()) || /^(::1?|f[cd]|fe[89ab])/i.test(c.data.trim()))) no("an AAAA value must be a public IPv6 address.");
    const key = `${c.type} ${c.name}`;
    if (seen.has(key)) no("two changes in one go touch the same record.");
    seen.add(key);
    if (out.some((o) => o.startsWith(label))) continue;
    const here = zone.filter((r) => r.name.toLowerCase() === c.name);
    const same = here.filter((r) => r.type === c.type);
    if (c.action === "add") {
      if (c.type === "CNAME" && here.length) no(`${c.name} already has ${here.map((r) => r.type).join(", ")} records, and a CNAME cannot share a name with anything.`);
      else if (c.type !== "CNAME" && here.some((r) => r.type === "CNAME")) no(`${c.name} is already a CNAME, which cannot share a name with other records.`);
      else if (c.type === "CNAME" && same.length) no(`${c.name} already has a CNAME; use replace to repoint it.`);
      else if (same.some((r) => r.data.trim().toLowerCase() === c.data.trim().toLowerCase())) no("that exact record already exists, so there is nothing to add.");
      else if (c.type !== "TXT" && same.length) no(`${c.name} already has ${c.type} records; use replace if you mean to swap it.`);
    } else {
      if (c.type === "TXT") no("TXT records are only ever added here, never replaced.");
      else if (same.length !== 1) no(same.length ? `${c.name} has ${same.length} ${c.type} records and a replace swaps one, so it is refused; change it in GoDaddy.` : `there is no ${c.type} record at ${c.name} to replace; use add.`);
      else if (same[0].data.trim().toLowerCase() === c.data.trim().toLowerCase() && (c.ttl === undefined || c.ttl === same[0].ttl)) no("it already has that value.");
    }
  }
  return out;
}

export const normalise = (domain: string, c: DnsChange): DnsChange => ({
  action: c.action,
  type: String(c.type).toUpperCase() as DnsChange["type"],
  name: relativeName(domain, c.name),
  data: String(c.data ?? "").trim(),
  ...(c.ttl !== undefined ? { ttl: c.ttl } : {}),
});

/** The records at the names a change touches: what Paul is shown as "before", and what must still be true when he approves. */
export function touched(zone: DnsRecord[], changes: DnsChange[]): DnsRecord[] {
  const keys = new Set(changes.map((c) => `${c.name}`));
  return zone.filter((r) => keys.has(r.name.toLowerCase())).map((r) => ({ type: r.type, name: r.name.toLowerCase(), data: r.data, ttl: r.ttl, ...(r.priority !== undefined ? { priority: r.priority } : {}) }));
}

/* ---------- Snapshots ---------- */

export const dnsDir = () => path.join(config.dataDir, "dns");
export const snapshotDir = () => path.join(dnsDir(), "snapshots");

/** Saves the whole zone before a change so it can be restored. Owner-only, outside every checkout. Throws if it cannot be saved. */
export function saveSnapshot(domain: string, actionId: string, zone: DnsRecord[], at = new Date()): string {
  fs.mkdirSync(snapshotDir(), { recursive: true, mode: 0o700 });
  fs.chmodSync(dnsDir(), 0o700);
  fs.chmodSync(snapshotDir(), 0o700);
  const file = path.join(snapshotDir(), `${domain}-${at.toISOString().replace(/[:.]/g, "-")}-${actionId}.json`);
  fs.writeFileSync(file, JSON.stringify({ domain, actionId, takenAt: at.toISOString(), records: zone }, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

export function listSnapshots(domain?: string): string[] {
  try {
    return fs.readdirSync(snapshotDir()).filter((f) => f.endsWith(".json") && (!domain || f.startsWith(`${domain}-`))).sort();
  } catch {
    return [];
  }
}

/** One snapshot by its plain file name; nothing outside the snapshot folder. */
export function readSnapshot(file: string): { domain: string; actionId: string; takenAt: string; records: DnsRecord[] } {
  if (!/^[a-z0-9.-]+-\d{4}-[0-9T-]+Z-[a-f0-9]{6}\.json$/.test(file)) throw new DnsError("That is not a snapshot file name; list them first.");
  return JSON.parse(fs.readFileSync(path.join(snapshotDir(), file), "utf8"));
}

/** An append-only log of applied changes, as well as the record in the store. */
export function logApplied(entry: Record<string, unknown>): void {
  fs.mkdirSync(dnsDir(), { recursive: true, mode: 0o700 });
  const file = path.join(dnsDir(), "changes.log");
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

/* ---------- Write grants ---------- */

/** What a write needs: minted once per request by the approval gate, spent on first use. */
export interface DnsGrant {
  actionId: string;
  digest: string;
}
const minted = new WeakSet<DnsGrant>();
/** Only src/dns-gate.ts calls this, and only for a change Paul approved (enforced by test/invariants.test.ts). */
export function mintDnsGrant(actionId: string, requestDigest: string): DnsGrant {
  const g = { actionId, digest: requestDigest };
  minted.add(g);
  return g;
}
export const requestDigest = (method: string, p: string, body: unknown) => digest({ method, p, body });

/* ---------- The client ---------- */

type Route = { write: boolean };

/**
 * The only requests the client makes, by method and path. Domain names are checked against the
 * allowlist first; everything else (renew, transfer, contacts, privacy, nameservers, agreements,
 * delete) has no route.
 */
function routeOf(method: string, p: string): Route | undefined {
  if (method === "GET" && /^\/v1\/domains$/.test(p)) return { write: false };
  if (method === "GET" && /^\/v1\/domains\/[a-z0-9.-]+\/records$/.test(p)) return { write: false };
  if (method === "PATCH" && /^\/v1\/domains\/[a-z0-9.-]+\/records$/.test(p)) return { write: true };
  if (method === "PUT" && /^\/v1\/domains\/[a-z0-9.-]+\/records\/(A|AAAA|CNAME|TXT)\/[a-z0-9_.-]+$/.test(p)) return { write: true };
  // v3, the API a Personal Access Token works with.
  if (method === "GET" && /^\/v3\/domains\/domain-names$/.test(p)) return { write: false };
  if (method === "GET" && /^\/v3\/domains\/zones\/[a-z0-9.-]+\/dns-records$/.test(p)) return { write: false };
  if (method === "POST" && /^\/v3\/domains\/zones\/[a-z0-9.-]+\/dns-records$/.test(p)) return { write: true };
  if (method === "PUT" && /^\/v3\/domains\/zones\/[a-z0-9.-]+\/dns-records\/[A-Za-z0-9._~-]+$/.test(p)) return { write: true };
  return undefined;
}

export type AuthMode = "token" | "key";
export interface DnsCreds {
  key: string;
  secret: string;
  base: string;
  /** GoDaddy Personal Access Token; wins over key and secret when set. */
  token?: string;
}

export class GoDaddyClient {
  private readonly used = new WeakSet<DnsGrant>();

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly creds: DnsCreds = config.dns,
  ) {}

  /** "token" (Bearer, v3) when GODADDY_API_TOKEN is set, otherwise "key" (sso-key, v1). */
  mode(): AuthMode {
    return this.creds.token ? "token" : "key";
  }

  configured(): boolean {
    return Boolean(this.creds.token || (this.creds.key && this.creds.secret));
  }

  /** Removes the credentials from any text that is about to be shown or logged. */
  private scrub(text: string): string {
    let t = text;
    for (const s of [this.creds.token, this.creds.key, this.creds.secret]) if (s) t = t.split(s).join("***");
    return t;
  }

  private async call(method: string, p: string, body?: unknown, query?: Record<string, string>): Promise<any> {
    if (!this.configured()) throw new DnsError("GoDaddy is not connected yet: neither GODADDY_API_TOKEN nor the GODADDY_API_KEY and GODADDY_API_SECRET secrets are set. docs/GODADDY.md has the steps.");
    const qs = query ? `?${new URLSearchParams(query)}` : "";
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.creds.base}${p}${qs}`, {
        method,
        headers: { Authorization: this.creds.token ? `Bearer ${this.creds.token}` : `sso-key ${this.creds.key}:${this.creds.secret}`, Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new DnsError(`Could not reach GoDaddy: ${this.scrub(err instanceof Error ? err.message : String(err))}`);
    }
    const raw = await res.text();
    if (!res.ok) {
      let code = "";
      let message = raw;
      try {
        const j = JSON.parse(raw);
        code = String(j.code ?? "");
        message = String(j.message ?? raw);
      } catch {
        // not JSON
      }
      const hint =
        res.status === 401 ? (this.mode() === "token" ? " The token was refused: check it has not expired or been revoked, and that it is the one for GODADDY_API_TOKEN." : " The key and secret were refused: check they are the production pair and still active.")
        : this.mode() === "token" && (res.status === 403 || code === "ACCESS_DENIED") ? " GoDaddy is refusing the token: check it has the scopes domains.domain:read and domains.dns:update, and that its account owns this domain."
        : res.status === 403 || code === "ACCESS_DENIED" ? " GoDaddy is refusing this account the Domains API. Its docs limit it to accounts with enough domains or a Discount Domain Club plan; reply to GoDaddy's developer support with the account number to ask for access."
        : res.status === 429 ? " GoDaddy is rate limiting; try again in a minute."
        : "";
      throw new DnsError(`GoDaddy said ${res.status}${code ? ` ${code}` : ""}: ${this.scrub(message).slice(0, 300)}.${hint}`);
    }
    return raw ? JSON.parse(raw) : undefined;
  }

  /** Domains on the account, narrowed to the allowlist. */
  async domains(): Promise<string[]> {
    if (this.mode() === "token") return this.domainsV3();
    const all = (await this.call("GET", "/v1/domains", undefined, { statuses: "ACTIVE", limit: "1000" })) as Array<{ domain?: string }>;
    return (Array.isArray(all) ? all : []).map((d) => String(d.domain ?? "").toLowerCase()).filter((d) => d && isAllowedDomain(d)).sort();
  }

  /** Every record in the zone of an allowlisted domain. */
  async records(domain: string): Promise<DnsRecord[]> {
    const d = requireDomain(domain);
    if (this.mode() === "token") return this.recordsV3(d);
    const rows = (await this.call("GET", `/v1/domains/${d}/records`)) as Array<Record<string, any>>;
    return (Array.isArray(rows) ? rows : []).map((r) => ({ type: String(r.type), name: String(r.name).toLowerCase(), data: String(r.data), ttl: Number(r.ttl) || DEFAULT_TTL, ...(r.priority !== undefined && r.priority !== null ? { priority: Number(r.priority) } : {}) }));
  }

  /** v3: cursor pages with a `next` link. Only follows links on GoDaddy's own base, at most 20 pages. */
  private async domainsV3(): Promise<string[]> {
    const out: string[] = [];
    let next: { p: string; q: Record<string, string> } | undefined = { p: "/v3/domains/domain-names", q: { pageSize: "200" } };
    for (let i = 0; next && i < 20; i++) {
      const page: any = await this.call("GET", next.p, undefined, next.q);
      for (const d of Array.isArray(page?.items) ? page.items : []) out.push(String(d.domain ?? "").toLowerCase());
      next = this.nextLink(page?.links);
    }
    return [...new Set(out)].filter((d) => d && isAllowedDomain(d)).sort();
  }

  private nextLink(links: unknown): { p: string; q: Record<string, string> } | undefined {
    const l = (Array.isArray(links) ? links : []).find((x: any) => x?.rel === "next" && typeof x.href === "string");
    if (!l) return undefined;
    try {
      const u = new URL(l.href, this.creds.base);
      if (u.origin !== new URL(this.creds.base).origin || u.pathname !== "/v3/domains/domain-names") return undefined;
      return { p: u.pathname, q: Object.fromEntries(u.searchParams) };
    } catch {
      return undefined;
    }
  }

  /** v3: offset pages of up to 100, at most 50 pages. */
  private async recordsV3(d: string): Promise<DnsRecord[]> {
    const rows: Array<Record<string, any>> = [];
    for (let page = 1; page <= 50; page++) {
      const res: any = await this.call("GET", `/v3/domains/zones/${d}/dns-records`, undefined, { page: String(page), pageSize: "100" });
      const items: Array<Record<string, any>> = Array.isArray(res?.items) ? res.items : [];
      rows.push(...items);
      if (items.length < 100) break;
    }
    return rows.map((r) => ({
      type: String(r.type),
      name: String(r.name).toLowerCase(),
      data: String(r.data),
      ttl: Number(r.ttl) || DEFAULT_TTL,
      ...(r.priority !== undefined && r.priority !== null ? { priority: Number(r.priority) } : {}),
      ...(r.recordId !== undefined && r.recordId !== null ? { recordId: String(r.recordId) } : {}),
    }));
  }

  /** The one write path. Needs a grant from the approval gate, bound to exactly this request, usable once. */
  async write(grant: DnsGrant, method: "PATCH" | "PUT" | "POST", p: string, body: unknown): Promise<void> {
    if (!minted.has(grant) || this.used.has(grant)) throw new DnsError("Refused: a change needs a fresh approval from Paul.");
    if (grant.digest !== requestDigest(method, p, body)) throw new DnsError("Refused: the approval does not match this request.");
    const m = p.match(/^\/v1\/domains\/([a-z0-9.-]+)\/|^\/v3\/domains\/zones\/([a-z0-9.-]+)\//);
    if (!m || !isAllowedDomain(m[1] ?? m[2]) || !routeOf(method, p)?.write) throw new DnsError("Refused: that is not a DNS record change on an allowed domain.");
    this.used.add(grant);
    await this.call(method, p, body);
  }
}

/**
 * The GoDaddy request that carries out one change. Key mode is v1 (append with PATCH, swap with PUT by type and name);
 * token mode is v3 (POST a record, or PUT by the record id found in the live `zone`).
 */
export function requestFor(domain: string, c: DnsChange, mode: AuthMode = "key", zone: DnsRecord[] = []): { method: "PATCH" | "PUT" | "POST"; path: string; body: unknown } {
  const ttl = c.ttl ?? DEFAULT_TTL;
  if (mode === "token") {
    const base = `/v3/domains/zones/${domain}/dns-records`;
    if (c.action === "add") return { method: "POST", path: base, body: { type: c.type, name: c.name, data: c.data, ttl } };
    const same = zone.filter((r) => r.type === c.type && r.name.toLowerCase() === c.name);
    const id = same.length === 1 ? same[0].recordId : undefined;
    if (!id || !/^[A-Za-z0-9._~-]+$/.test(id)) throw new DnsError(`GoDaddy gave no usable id for the ${c.type} record at ${c.name}, so it cannot be replaced here; change it in GoDaddy.`);
    return { method: "PUT", path: `${base}/${id}`, body: { type: c.type, name: c.name, data: c.data, ttl } };
  }
  return c.action === "add"
    ? { method: "PATCH", path: `/v1/domains/${domain}/records`, body: [{ type: c.type, name: c.name, data: c.data, ttl }] }
    : { method: "PUT", path: `/v1/domains/${domain}/records/${c.type}/${c.name}`, body: [{ data: c.data, ttl }] };
}
