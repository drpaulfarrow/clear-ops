/**
 * DNS changes, the one place the DNS agent's reach goes beyond reading, and only through this approval gate.
 *
 *  1. A dns job holding the "dns" permit (granted by the chief only because Paul asked in chat; scheduled
 *     runs never get it) PREPARES a change. The service, not the model, reads the live zone, applies the
 *     hard blocks (src/dns.ts) and shows Paul the exact records before and after, with an id. Nothing changes.
 *  2. Paul replies "dns apply <id>" from his own allowlisted chat account. The orchestrator matches that
 *     whole message before any model runs, so no email, web page, job output or upload can produce it.
 *     Only then does the gate re-read the zone, check it is still what Paul saw, save a snapshot of the
 *     whole zone, mint single-use grants for exactly these requests, apply, and verify.
 *
 * A change expires, can be cancelled, is bound by a hash to what Paul saw, and approving one never
 * authorises another. Every change is its own audit record in the store and a line in dns/changes.log.
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { config, isAllowed } from "./config.js";
import { blockers, digest, DnsError, listSnapshots, logApplied, mintDnsGrant, normalise, readSnapshot, relativeName, requestDigest, requestFor, requireDomain, saveSnapshot, touched, type DnsChange, type DnsRecord, type GoDaddyClient, allowedDomains } from "./dns.js";
import { fmt } from "./london.js";
import type { DnsAction, Store } from "./store.js";
import { shortId } from "./store.js";
import type { Messenger } from "./whatsapp.js";

export const DNS_SERVER = "dns";
export const DNS_TOOLS = [`mcp__${DNS_SERVER}__*`];

interface Origin {
  jobId?: string;
  replyTo?: string;
  /** A still-pending change of the same job to cancel when this replaces it (an edit). */
  replaces?: string;
}

const rec = (r: { type: string; name: string; data: string; ttl: number }) => `${r.type} ${r.name} -> ${r.data} (TTL ${r.ttl})`;

export class DnsGate {
  private readonly ttlMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly store: Store,
    private readonly client: GoDaddyClient,
    private readonly messenger?: Pick<Messenger, "send">,
    opts: { ttlMs?: number; now?: () => Date } = {},
  ) {
    this.ttlMs = opts.ttlMs ?? config.dns.ttlHours * 3_600_000;
    this.now = opts.now ?? (() => new Date());
  }

  private hashOf(domain: string, changes: DnsChange[], before: DnsRecord[]): string {
    return digest({ domain, changes, before });
  }

  /** Prepares a change: reads the zone, applies the hard blocks, shows Paul exactly what would happen. */
  async prepare(domainRaw: string, input: DnsChange[], reason: string | undefined, origin: Origin): Promise<DnsAction> {
    if (!origin.replyTo) throw new DnsError("Refused: there is no chat to show Paul this in, so it cannot be prepared.");
    const domain = requireDomain(domainRaw);
    const changes = (Array.isArray(input) ? input : []).map((c) => normalise(domain, c));
    const zone = await this.client.records(domain);
    const why = blockers(domain, changes, zone);
    if (why.length) throw new DnsError(`Refused, and nothing was prepared:\n- ${why.join("\n- ")}\nThese rules are fixed. Paul does anything they block in GoDaddy himself.`);
    if (origin.replaces) {
      const old = this.store.getDns(origin.replaces);
      if (old?.status === "pending") this.store.updateDns(old.id, { status: "cancelled", note: "replaced by an edit" });
    }
    const before = touched(zone, changes);
    const now = this.now();
    const action = this.store.putDns({ id: shortId(), status: "pending", createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(), jobId: origin.jobId, replyTo: origin.replyTo, domain, changes, before, ...(reason ? { reason: reason.slice(0, 300) } : {}), hash: this.hashOf(domain, changes, before) });
    await this.messenger?.send(action.replyTo, this.preview(action));
    return action;
  }

  /* ---------- What Paul sees ---------- */

  preview(a: DnsAction): string {
    const lines = [`DNS change waiting for your approval (${a.id}, expires ${fmt(new Date(a.expiresAt))}). Domain: ${a.domain}.`];
    if (a.reason) lines.push(`Why: ${a.reason}`);
    for (const c of a.changes) {
      const was = a.before.filter((r) => r.type === c.type && r.name === c.name);
      const after = `${c.type} ${c.name} -> ${c.data} (TTL ${c.ttl ?? 3600})`;
      lines.push("", `${c.action === "add" ? "Add" : "Replace"} ${c.type} ${c.name}`, `Before: ${was.length ? was.map(rec).join("; ") : "(nothing at this name and type)"}`, `After: ${c.action === "add" ? `${was.length ? `${was.map(rec).join("; ")}; plus ` : ""}${after}` : after}`);
    }
    lines.push("", `Reply "dns apply ${a.id}" to make this change, or "dns cancel ${a.id}". I save a snapshot of the whole zone first. Nothing happens until you do.`);
    return lines.join("\n");
  }

  pending(): DnsAction[] {
    this.expireOld();
    return this.store.listDns().filter((a) => a.status === "pending");
  }

  private expireOld(): void {
    const now = this.now().getTime();
    for (const a of this.store.listDns()) if (a.status === "pending" && new Date(a.expiresAt).getTime() <= now) this.store.updateDns(a.id, { status: "expired" });
  }

  has(id: string): boolean {
    return Boolean(this.store.getDns(id));
  }

  cancel(id: string, by: string): string {
    if (!isAllowed(by)) return "";
    if (!this.store.getDns(id)) return `No DNS change ${id}.`;
    this.expireOld();
    const cur = this.store.getDns(id)!;
    if (cur.status !== "pending") return `DNS change ${id} is already ${cur.status}, so there is nothing to cancel.`;
    this.store.updateDns(id, { status: "cancelled", note: `cancelled by ${by}` });
    return `Cancelled DNS change ${id}. Nothing was changed.`;
  }

  /**
   * Paul approved this id. `approver` must be an allowlisted chat account (the orchestrator has already
   * checked, and this checks again). Returns the confirmation, or why nothing changed.
   */
  async approve(id: string, approver: string): Promise<string> {
    if (!isAllowed(approver)) throw new DnsError("Refused: only Paul's own chat account can approve.");
    if (!this.store.getDns(id)) return `No DNS change ${id}.`;
    this.expireOld();
    const cur = this.store.getDns(id)!;
    if (cur.status !== "pending") return cur.status === "expired" ? `DNS change ${id} expired (approvals last ${Math.round(this.ttlMs / 3_600_000)} hours), so nothing was changed. Ask me to prepare it again.` : `DNS change ${id} is already ${cur.status}, so nothing more was done.`;
    // Claim it before anything awaits, so a second approval cannot run it twice.
    this.store.updateDns(id, { status: "executing", approvedBy: approver, approvedAt: this.now().toISOString() });
    let applied = 0;
    try {
      // The zone and the rules, again, now: what Paul approved must still be exactly what is true.
      const zone = await this.client.records(cur.domain);
      const why = blockers(cur.domain, cur.changes as DnsChange[], zone);
      if (why.length || this.hashOf(cur.domain, cur.changes as DnsChange[], touched(zone, cur.changes as DnsChange[])) !== cur.hash) {
        this.store.updateDns(id, { status: "changed", note: why.length ? why.join("; ") : "the zone changed after it was shown" });
        return `The zone at ${cur.domain} changed since you saw this${why.length ? ` (${why[0]})` : ""}, so I changed nothing. Ask me to prepare it again and you will see the current records.`;
      }
      // The snapshot first. If it cannot be saved, nothing is changed.
      const snapshot = saveSnapshot(cur.domain, id, zone, this.now());
      this.store.updateDns(id, { snapshot });
      for (const c of cur.changes as DnsChange[]) {
        const r = requestFor(cur.domain, c, this.client.mode(), zone);
        const grant = mintDnsGrant(id, requestDigest(r.method, r.path, r.body));
        await this.client.write(grant, r.method, r.path, r.body);
        applied++;
      }
      const after = await this.client.records(cur.domain).catch(() => undefined);
      const missing = after ? (cur.changes as DnsChange[]).filter((c) => !after.some((r) => r.type === c.type && r.name === c.name && r.data.toLowerCase().replace(/\.$/, "") === c.data.toLowerCase().replace(/\.$/, ""))) : [];
      this.store.updateDns(id, { status: "executed", executedAt: this.now().toISOString(), applied });
      logApplied({ at: this.now().toISOString(), id, domain: cur.domain, approvedBy: approver, changes: cur.changes, snapshot, applied });
      const verified = !after ? "I could not read the zone back to check it." : missing.length ? `GoDaddy accepted it but I could not see ${missing.map((c) => `${c.type} ${c.name}`).join(", ")} when I read the zone back; check in GoDaddy.` : "I read the zone back and the records are there.";
      return `Done on ${cur.domain}: ${cur.changes.length} change${cur.changes.length === 1 ? "" : "s"} applied. ${verified} The zone as it was is saved (${snapshot.split("/").pop()}). DNS can take a few minutes to spread.`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const done = this.store.getDns(id)!;
      if (done.status === "executing") this.store.updateDns(id, { status: applied ? "partial" : "failed", note: msg, applied });
      if (applied) logApplied({ at: this.now().toISOString(), id, domain: cur.domain, approvedBy: approver, changes: cur.changes, snapshot: done.snapshot, applied, partial: true, error: msg });
      return applied
        ? `Only ${applied} of ${cur.changes.length} changes went through on ${cur.domain} before an error: ${msg} The zone as it was is saved (${done.snapshot?.split("/").pop()}). Nothing else was changed; look at the records before trying again.`
        : `Nothing was changed on ${cur.domain}: ${msg}`;
    }
  }
}

/** Parses Paul's DNS approval or cancellation. Whole-message matches only, and always with the id. */
export function parseDnsCommand(text: string): { verb: "apply" | "cancel"; id: string } | undefined {
  const m = text.trim().replace(/[.!\s]+$/, "").match(/^dns\s+(apply|approve|cancel)\s+([a-f0-9]{6})$/i);
  return m ? { verb: /^cancel$/i.test(m[1]) ? "cancel" : "apply", id: m[2].toLowerCase() } : undefined;
}

/* ---------- The DNS agent's tools ---------- */

const fence = (what: string, body: string) => `[UNTRUSTED ${what} BEGIN]\n${body}\n[UNTRUSTED ${what} END]`;
const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) });

export interface DnsToolDeps {
  client: GoDaddyClient;
  gate: DnsGate;
  /** The "dns" permit: without it the job is read only and dns_prepare_change does not exist. */
  permit: boolean;
  jobId: string;
  replyTo?: string;
}

export function dnsServer(d: DnsToolDeps) {
  const guard = async (f: () => Promise<string>) => {
    try {
      return text(await f());
    } catch (err) {
      return text(err instanceof Error ? err.message : String(err), true);
    }
  };
  const tools: Array<ReturnType<typeof tool<any>>> = [
    tool("dns_list_domains", "List the domains on Paul's GoDaddy account that this agent is allowed to touch.", {}, () =>
      guard(async () => {
        const live = await d.client.domains().catch((e) => `(could not list them from GoDaddy: ${e instanceof Error ? e.message : e})`);
        return `Allowed domains: ${allowedDomains().join(", ") || "none"}.\nOn the account and allowed: ${Array.isArray(live) ? live.join(", ") || "none" : live}`;
      }),
    ),
    tool("dns_list_records", "List the DNS records of an allowed domain, optionally only one type or name. Read only.", { domain: z.string(), type: z.string().optional(), name: z.string().optional() }, ({ domain, type, name }) =>
      guard(async () => {
        const dom = requireDomain(domain);
        const n = name ? relativeName(dom, name) : undefined;
        const rows = (await d.client.records(dom)).filter((r) => (!type || r.type === type.toUpperCase()) && (!n || r.name === n));
        return fence("DNS DATA", rows.length ? rows.map((r) => `${r.type} ${r.name} -> ${r.data} (TTL ${r.ttl}${r.priority !== undefined ? `, priority ${r.priority}` : ""})`).join("\n") : "(no matching records)");
      }),
    ),
    tool("dns_snapshots", "List the saved zone snapshots (taken automatically before every applied change), or read one by its file name.", { file: z.string().optional(), domain: z.string().optional() }, ({ file, domain }) =>
      guard(async () => {
        if (file) {
          const s = readSnapshot(file);
          return fence("DNS DATA", `${s.domain} at ${s.takenAt}\n${s.records.map(rec).join("\n")}`);
        }
        const list = listSnapshots(domain ? requireDomain(domain) : undefined);
        return list.length ? list.join("\n") : "No snapshots yet.";
      }),
    ),
  ];
  if (d.permit) {
    tools.push(
      tool(
        "dns_prepare_change",
        'PREPARE a DNS change for Paul to approve. Nothing is changed: the service reads the zone, refuses anything on the hard-block list, and shows Paul the exact records before and after with an id; he approves with "dns apply <id>" himself in chat. At most 5 changes, one domain. Actions: "add" appends a record; "replace" swaps the single existing A, AAAA or CNAME at that name. Types: A, AAAA, CNAME, TXT only. There is no delete. Pass replaces with the id of a change of yours that is still waiting to edit it.',
        { domain: z.string(), changes: z.array(z.object({ action: z.enum(["add", "replace"]), type: z.string(), name: z.string().describe('Relative name such as "publisher", not the full host name'), data: z.string(), ttl: z.number().optional() })).max(10), reason: z.string().optional().describe("One short plain sentence for Paul: why this change"), replaces: z.string().optional() },
        ({ domain, changes, reason, replaces }) =>
          guard(async () => {
            const a = await d.gate.prepare(domain, changes as DnsChange[], reason, { jobId: d.jobId, replyTo: d.replyTo, replaces });
            return `Prepared ${a.id} and showed Paul the exact before and after in chat. It is waiting for him to reply "dns apply ${a.id}"; you cannot approve it and nothing has changed. Tell him in one sentence that it is waiting.`;
          }),
      ),
    );
  }
  return createSdkMcpServer({ name: DNS_SERVER, version: "1.0.0", tools });
}
