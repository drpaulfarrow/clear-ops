/**
 * Sending email, inviting people and cancelling events that have attendees, the one place the executive assistant's reach goes beyond drafts and
 * holds, and only through this approval gate.
 *
 * The flow is two steps and never autonomous:
 *  1. An ea job holding the "send" permit (granted by the chief only because Paul asked in chat) PREPARES an
 *     action. The service itself, not the model, shows Paul the exact recipients, subject and body (or the
 *     invite's title, time, attendees, location and description, or the event to cancel and who is told)
 *     with an id. Nothing is sent or cancelled.
 *  2. Paul replies "send <id>" (or "send it" when exactly one is waiting) from his own allowlisted chat
 *     account. The orchestrator matches that message before any model runs, so no email, calendar entry, job
 *     output or upload can produce it. Only then does the gate mint a single-use grant for that exact request.
 *
 * An action expires, can be cancelled, is bound by a hash to what Paul saw (a changed draft needs a new
 * approval), and approving one never authorises another. Every action is its own audit record in the store.
 */
import { createHash } from "node:crypto";
import { config, isAllowed } from "./config.js";
import { addresses, attachmentNames, bodyParts, buildRawMessage, EMAIL, header, oneLine } from "./ea.js";
import { GoogleError, isHold, mintSendGrant, requestDigest, type GoogleApi } from "./google.js";
import { fmt, londonYmd } from "./london.js";
import type { OutboundAction, OutboundKind, Store } from "./store.js";
import { shortId } from "./store.js";
import type { Messenger } from "./whatsapp.js";

export interface OutboundLimits {
  dailyCap: number;
  maxRecipients: number;
  ttlMs: number;
}

export const MAX_BODY_CHARS = 20_000;
const MAX_SUBJECT_CHARS = 300;

/** Credentials and private paths must never ride in an outbound message unless Paul saw them; refused outright. */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-ant-[A-Za-z0-9_-]{10,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bya29\.[A-Za-z0-9_-]{20,}/,
  /\b1\/\/[A-Za-z0-9_-]{30,}/,
  /\/data\/(uploads|secrets)\b/,
];
export function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some((r) => r.test(text));
}

/** Calendar event ids are base32hex (a to v, 0 to 9). */
const CANCEL_EVENT_ID = /^[a-v0-9]{5,1024}$/;

const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

/** What a Gmail draft is, as far as sending it goes. */
export interface DraftSnapshot {
  draftId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
  attachments: string[];
  hash: string;
}

/** Reads a draft in full and hashes everything that would be delivered. */
export async function readDraft(api: GoogleApi, draftId: string): Promise<DraftSnapshot> {
  const d = await api.request<{ id: string; message?: { threadId?: string; payload?: { headers?: Array<{ name: string; value: string }> } & Record<string, any> } }>("gmail", "GET", `drafts/${encodeURIComponent(draftId)}`, { query: { format: "full" } });
  const payload = d.message?.payload;
  if (!payload) throw new GoogleError(`Draft ${draftId} could not be read.`);
  const h = payload.headers;
  const { plain, html } = bodyParts(payload as never);
  const attachments = attachmentNames(payload as never);
  const snap = {
    draftId,
    to: addresses(header(h, "To")),
    cc: addresses(header(h, "Cc")),
    bcc: addresses(header(h, "Bcc")),
    subject: oneLine(header(h, "Subject")),
    body: plain || html,
    threadId: d.message?.threadId,
    inReplyTo: header(h, "In-Reply-To") || undefined,
    references: header(h, "References") || undefined,
    attachments,
  };
  return { ...snap, hash: digest({ ...snap, plain, html }) };
}

export class OutboundError extends Error {}

export interface EmailInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
}
export interface InviteInput {
  title: string;
  start: string;
  end: string;
  attendees: string[];
  location?: string;
  description?: string;
}
interface Origin {
  jobId?: string;
  replyTo?: string;
  /** A still-pending action of the same job to cancel when this replaces it (an edit). */
  replaces?: string;
}

const clean = (list?: string[]) => [...new Set((list ?? []).map((a) => a.trim().toLowerCase()).filter(Boolean))];

export class OutboundGate {
  private readonly limits: OutboundLimits;
  private readonly now: () => Date;

  constructor(
    private readonly store: Store,
    private readonly api: GoogleApi,
    private readonly messenger?: Pick<Messenger, "send">,
    opts: { limits?: Partial<OutboundLimits>; now?: () => Date } = {},
  ) {
    this.limits = { dailyCap: config.outbound.dailyCap, maxRecipients: config.outbound.maxRecipients, ttlMs: config.outbound.ttlHours * 3_600_000, ...opts.limits };
    this.now = opts.now ?? (() => new Date());
  }

  /* ---------- Preparing ---------- */

  private checkAddresses(label: string, list: string[]): void {
    for (const a of list) if (!EMAIL.test(a)) throw new OutboundError(`Refused: "${oneLine(a).slice(0, 80)}" is not a plain email address (${label}).`);
  }

  /** Recipient cap, and (when preparing) the daily cap. At execution the daily cap is checked by approve(). */
  private checkRoom(count: number, daily = true): void {
    if (count > this.limits.maxRecipients) throw new OutboundError(`Refused: ${count} recipients is over the limit of ${this.limits.maxRecipients} per message.`);
    if (daily && this.usedToday() >= this.limits.dailyCap) throw new OutboundError(`Refused: ${this.limits.dailyCap} sends and invitations have already gone today, which is the daily limit.`);
  }

  /** Sends and invitations that went, or are going, today (London). */
  usedToday(): number {
    const today = londonYmd(this.now());
    return this.store.listOutbound().filter((a) => (a.status === "executed" || a.status === "executing") && londonYmd(new Date(a.executedAt ?? a.approvedAt ?? a.createdAt)) === today).length;
  }

  private create(kind: OutboundKind, origin: Origin, fields: Pick<OutboundAction, "email" | "invite" | "cancel" | "hash">): OutboundAction {
    const replyTo = origin.replyTo;
    if (!replyTo) throw new OutboundError("Refused: there is no chat to show Paul this in, so it cannot be prepared.");
    if (origin.replaces) {
      const old = this.store.getOutbound(origin.replaces);
      if (old?.status === "pending") this.store.updateOutbound(old.id, { status: "cancelled", note: "replaced by an edit" });
    }
    const now = this.now();
    return this.store.putOutbound({ id: shortId(), kind, status: "pending", createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + this.limits.ttlMs).toISOString(), jobId: origin.jobId, replyTo, ...fields });
  }

  /** Prepares sending an existing draft the assistant created. Shows Paul the draft as it is right now. */
  async prepareDraft(draftId: string, origin: Origin, authorise?: (s: DraftSnapshot) => Promise<void>): Promise<OutboundAction> {
    if (!this.store.isCreatedDraft(draftId)) throw new OutboundError("Refused: only a draft the assistant created can be prepared for sending. For another draft, Paul sends it himself or asks for a new one.");
    const snap = await readDraft(this.api, draftId);
    if (snap.attachments.length) throw new OutboundError("Refused: the draft has attachments, which the assistant cannot show Paul for approval. Paul sends it himself.");
    this.validateEmail(snap);
    await authorise?.(snap);
    const action = this.create("send_draft", origin, { hash: snap.hash, email: { draftId, to: snap.to, cc: snap.cc, bcc: snap.bcc, subject: snap.subject, body: snap.body, threadId: snap.threadId, attachments: [] } });
    await this.show(action);
    return action;
  }

  /** Prepares a new message. */
  async prepareEmail(input: EmailInput, origin: Origin, authorise?: (e: Required<Pick<EmailInput, "to" | "cc" | "bcc">>) => Promise<void>): Promise<OutboundAction> {
    const email = { to: clean(input.to), cc: clean(input.cc), bcc: clean(input.bcc), subject: oneLine(input.subject ?? ""), body: input.body ?? "", threadId: input.threadId, inReplyTo: input.inReplyTo, references: input.references };
    this.validateEmail(email);
    await authorise?.(email);
    const action = this.create("send_email", origin, { hash: digest({ ...email }), email: { ...email, attachments: [] } });
    await this.show(action);
    return action;
  }

  private validateEmail(e: { to: string[]; cc: string[]; bcc: string[]; subject: string; body: string }, daily = true): void {
    if (!e.to.length) throw new OutboundError("Refused: a message needs at least one recipient in To.");
    this.checkAddresses("To", e.to);
    this.checkAddresses("Cc", e.cc);
    this.checkAddresses("Bcc", e.bcc);
    this.checkRoom(new Set([...e.to, ...e.cc, ...e.bcc]).size, daily);
    if (!e.subject.trim()) throw new OutboundError("Refused: a message needs a subject.");
    if (e.subject.length > MAX_SUBJECT_CHARS) throw new OutboundError(`Refused: the subject is over ${MAX_SUBJECT_CHARS} characters.`);
    if (!e.body.trim()) throw new OutboundError("Refused: the message body is empty.");
    if (e.body.length > MAX_BODY_CHARS) throw new OutboundError(`Refused: the body is over ${MAX_BODY_CHARS} characters.`);
    if (looksLikeSecret(`${e.subject}\n${e.body}`)) throw new OutboundError("Refused: the text looks like it contains a secret, a key or a private file path. Nothing like that is ever sent.");
  }

  /** Prepares an invitation on Paul's own calendar. */
  async prepareInvite(input: InviteInput, origin: Origin, authorise?: (attendees: string[]) => Promise<void>): Promise<OutboundAction> {
    const attendees = clean(input.attendees);
    const title = oneLine(input.title ?? "");
    const start = new Date(input.start);
    const end = new Date(input.end);
    if (!attendees.length) throw new OutboundError("Refused: an invitation needs at least one attendee (use a hold for time with nobody invited).");
    this.checkAddresses("attendees", attendees);
    this.checkRoom(attendees.length);
    if (!title) throw new OutboundError("Refused: an invitation needs a title.");
    if (/^hold:/i.test(title)) throw new OutboundError('Refused: an invitation cannot be titled "Hold:".');
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) throw new OutboundError("Refused: the start and end must be real times with the end after the start.");
    if (!/(Z|[+-]\d{2}:?\d{2})$/.test(input.start) || !/(Z|[+-]\d{2}:?\d{2})$/.test(input.end)) throw new OutboundError("Refused: start and end need a time zone offset, for example 2026-11-05T14:00:00+00:00.");
    if (end.getTime() - start.getTime() > 14 * 86_400_000) throw new OutboundError("Refused: an invitation cannot last more than 14 days.");
    if ((input.location ?? "").length > 300 || (input.description ?? "").length > 5000) throw new OutboundError("Refused: the location or description is too long.");
    if (looksLikeSecret(`${title}\n${input.location ?? ""}\n${input.description ?? ""}`)) throw new OutboundError("Refused: the text looks like it contains a secret, a key or a private file path.");
    await authorise?.(attendees);
    const invite = { title, start: start.toISOString(), end: end.toISOString(), attendees, location: input.location?.trim() || undefined, description: input.description?.trim() || undefined };
    const action = this.create("invite", origin, { hash: digest(invite), invite });
    await this.show(action);
    return action;
  }

  /**
   * Prepares cancelling an event on Paul's own calendar that has attendees. The event is read here, so Paul is
   * shown its real title, time and attendees, not what the model said. Holds, events Paul does not organise
   * (cancelling those would be answering an invitation) and events with nobody else invited are refused.
   */
  async prepareCancel(eventId: string, origin: Origin): Promise<OutboundAction> {
    const cancel = await this.readEventToCancel(eventId);
    this.checkRoom(cancel.attendees.length);
    const action = this.create("cancel_event", origin, { hash: digest(cancel), cancel });
    await this.show(action);
    return action;
  }

  private async readEventToCancel(eventId: string): Promise<NonNullable<OutboundAction["cancel"]>> {
    if (!CANCEL_EVENT_ID.test(eventId)) throw new OutboundError("Refused: that is not a calendar event id.");
    const ev = await this.api.request<Record<string, any>>("calendar", "GET", `calendars/primary/events/${eventId}`);
    if (ev.status === "cancelled") throw new OutboundError("Refused: that event is already cancelled.");
    if (isHold(ev)) throw new OutboundError("Refused: that is a hold; remove it with remove_hold, which needs no approval.");
    if (ev.organizer?.self !== true) throw new OutboundError("Refused: Paul is not the organiser of that event, so cancelling it would be answering an invitation, which the assistant never does.");
    const attendees = clean((Array.isArray(ev.attendees) ? ev.attendees : []).filter((a: any) => a?.self !== true && !a?.resource).map((a: any) => String(a?.email ?? "")));
    if (!attendees.length) throw new OutboundError("Refused: that event has no other attendees to notify.");
    this.checkAddresses("attendees", attendees);
    const start = new Date(ev.start?.dateTime ?? ev.start?.date ?? "");
    const end = new Date(ev.end?.dateTime ?? ev.end?.date ?? "");
    if (Number.isNaN(start.getTime())) throw new OutboundError("Refused: the event has no readable start time.");
    return { eventId, title: oneLine(String(ev.summary ?? "(no title)")).slice(0, 300), start: start.toISOString(), end: (Number.isNaN(end.getTime()) ? start : end).toISOString(), attendees };
  }

  /* ---------- What Paul sees ---------- */

  preview(a: OutboundAction): string {
    const expires = `expires ${fmt(new Date(a.expiresAt))}`;
    const how = `Reply "send ${a.id}" to go ahead, or "cancel ${a.id}". Nothing happens until you do.`;
    if (a.cancel) {
      const c = a.cancel;
      return [`Cancellation waiting for your approval (${a.id}, ${expires}). Google will email a cancellation to every attendee below.`, `Event: ${c.title}`, `When: ${fmt(new Date(c.start))} to ${fmt(new Date(c.end))}`, `Attendees who will be told: ${c.attendees.join(", ")}`, "", `Reply "send ${a.id}" to cancel the event, or "cancel ${a.id}" to keep it. Nothing happens until you do.`].join("\n");
    }
    if (a.invite) {
      const i = a.invite;
      return [`Invitation waiting for your approval (${a.id}, ${expires}). Attendees will be emailed by Google.`, `Title: ${i.title}`, `When: ${fmt(new Date(i.start))} to ${fmt(new Date(i.end))}`, `Attendees: ${i.attendees.join(", ")}`, `Location: ${i.location ?? "(none)"}`, `Description: ${i.description ?? "(none)"}`, "", how].join("\n");
    }
    const e = a.email!;
    return [`Email waiting for your approval (${a.id}, ${expires}).${a.kind === "send_draft" ? ` It is Gmail draft ${e.draftId}.` : ""}`, `To: ${e.to.join(", ")}`, `Cc: ${e.cc.join(", ") || "(none)"}`, `Bcc: ${e.bcc.join(", ") || "(none)"}`, `Subject: ${e.subject}`, "---", e.body, "---", how].join("\n");
  }

  private async show(a: OutboundAction): Promise<void> {
    await this.messenger?.send(a.replyTo, this.preview(a));
  }

  /** Everything still waiting, for /pending. */
  pending(): OutboundAction[] {
    this.expireOld();
    return this.store.listOutbound().filter((a) => a.status === "pending");
  }

  private expireOld(): void {
    const now = this.now().getTime();
    for (const a of this.store.listOutbound()) if (a.status === "pending" && new Date(a.expiresAt).getTime() <= now) this.store.updateOutbound(a.id, { status: "expired" });
  }

  /** True when this id belongs to the gate, so the orchestrator knows which handler to use. */
  has(id: string): boolean {
    return Boolean(this.store.getOutbound(id));
  }

  /** The id "send it" means: only when exactly one action is waiting. */
  soleId(): string | undefined {
    const p = this.pending();
    return p.length === 1 ? p[0].id : undefined;
  }

  /* ---------- Cancelling and approving ---------- */

  cancel(id: string, by: string): string {
    if (!isAllowed(by)) return "";
    const a = this.store.getOutbound(id);
    if (!a) return `No pending send or invitation ${id}.`;
    this.expireOld();
    const cur = this.store.getOutbound(id)!;
    if (cur.status !== "pending") return `${id} is already ${cur.status}, so there is nothing to cancel.`;
    this.store.updateOutbound(id, { status: "cancelled", note: `cancelled by ${by}` });
    return `Cancelled ${id}. Nothing was sent or cancelled.`;
  }

  /**
   * Paul approved this id. `approver` must be an allowlisted chat account (the orchestrator has already
   * checked, and this checks again). Returns the one-line confirmation, or why nothing went.
   */
  async approve(id: string, approver: string): Promise<string> {
    if (!isAllowed(approver)) throw new OutboundError("Refused: only Paul's own chat account can approve.");
    const a = this.store.getOutbound(id);
    if (!a) return `No pending send or invitation ${id}.`;
    this.expireOld();
    const cur = this.store.getOutbound(id)!;
    if (cur.status !== "pending") return cur.status === "expired" ? `${id} expired (approvals last ${Math.round(this.limits.ttlMs / 3_600_000)} hours), so nothing was sent. Ask me to prepare it again.` : `${id} is already ${cur.status}, so nothing more was done.`;
    // Claim it before anything awaits, so a second approval cannot run it twice.
    this.store.updateOutbound(id, { status: "executing", approvedBy: approver, approvedAt: this.now().toISOString() });
    try {
      if (this.usedToday() > this.limits.dailyCap) throw new OutboundError(`the daily limit of ${this.limits.dailyCap} sends and invitations has been reached`);
      if (cur.kind === "cancel_event") return await this.runCancel(cur);
      return cur.kind === "invite" ? await this.runInvite(cur) : cur.kind === "send_draft" ? await this.runDraft(cur) : await this.runEmail(cur);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const done = this.store.getOutbound(id)!;
      if (done.status === "executing") this.store.updateOutbound(id, { status: "failed", note: msg });
      return `Not sent: ${msg}. ${/^Google /.test(msg) ? "Check your Sent folder before trying again." : ""}`.trim();
    }
  }

  private executed(a: OutboundAction, resultId: string | undefined): void {
    this.store.updateOutbound(a.id, { status: "executed", executedAt: this.now().toISOString(), resultId });
  }

  private async runDraft(a: OutboundAction): Promise<string> {
    const e = a.email!;
    const snap = await readDraft(this.api, e.draftId!);
    if (snap.hash !== a.hash || snap.attachments.length) {
      // What Paul approved is not what is in the draft any more: nothing is sent, he sees the new version.
      this.store.updateOutbound(a.id, { status: "changed", note: "the draft changed after it was shown" });
      this.validateEmail(snap);
      const next = this.create("send_draft", { jobId: a.jobId, replyTo: a.replyTo }, { hash: snap.hash, email: { draftId: snap.draftId, to: snap.to, cc: snap.cc, bcc: snap.bcc, subject: snap.subject, body: snap.body, threadId: snap.threadId, attachments: [] } });
      await this.show(next);
      return `The draft changed after you saw it, so I did not send it. I have shown you the new version as ${next.id}; reply "send ${next.id}" if it is right.`;
    }
    this.validateEmail(snap, false);
    const body = { id: e.draftId };
    const grant = mintSendGrant(a.id, requestDigest("gmail", "POST", "drafts/send", { body }));
    const sent = await this.api.approved<{ id?: string }>(grant, "gmail", "POST", "drafts/send", { body });
    this.executed(a, sent?.id);
    return this.confirmEmail(a, sent?.id);
  }

  private async runEmail(a: OutboundAction): Promise<string> {
    const e = a.email!;
    this.validateEmail(e, false);
    const raw = buildRawMessage({ to: e.to, cc: e.cc, bcc: e.bcc, subject: e.subject, body: e.body, inReplyTo: e.inReplyTo, references: e.references });
    const body = { raw, ...(e.threadId ? { threadId: e.threadId } : {}) };
    const grant = mintSendGrant(a.id, requestDigest("gmail", "POST", "messages/send", { body }));
    const sent = await this.api.approved<{ id?: string }>(grant, "gmail", "POST", "messages/send", { body });
    this.executed(a, sent?.id);
    return this.confirmEmail(a, sent?.id);
  }

  private confirmEmail(a: OutboundAction, id?: string): string {
    const e = a.email!;
    const who = [e.to.join(", "), e.cc.length ? `cc ${e.cc.join(", ")}` : "", e.bcc.length ? `bcc ${e.bcc.join(", ")}` : ""].filter(Boolean).join("; ");
    return `Sent to ${who}: "${e.subject}"${id ? ` (message ${id})` : ""}. Today ${this.usedToday()} of ${this.limits.dailyCap}.`;
  }

  private async runCancel(a: OutboundAction): Promise<string> {
    const c = a.cancel!;
    // Re-read the event: if it changed since Paul saw it (time, title, attendees), nothing is cancelled.
    const now = await this.readEventToCancel(c.eventId);
    if (digest(now) !== a.hash) {
      this.store.updateOutbound(a.id, { status: "changed", note: "the event changed after it was shown" });
      const next = this.create("cancel_event", { jobId: a.jobId, replyTo: a.replyTo }, { hash: digest(now), cancel: now });
      await this.show(next);
      return `The event changed after you saw it, so I did not cancel it. I have shown you the current version as ${next.id}; reply "send ${next.id}" if it is right.`;
    }
    const p = `calendars/primary/events/${c.eventId}`;
    const query = { sendUpdates: "all" };
    const grant = mintSendGrant(a.id, requestDigest("calendar", "DELETE", p, { query }));
    await this.api.approved(grant, "calendar", "DELETE", p, { query });
    this.executed(a, c.eventId);
    return `Cancelled "${c.title}", ${fmt(new Date(c.start))}. Cancellation emailed to ${c.attendees.join(", ")}. Today ${this.usedToday()} of ${this.limits.dailyCap}.`;
  }

  private async runInvite(a: OutboundAction): Promise<string> {
    const i = a.invite!;
    const query = { sendUpdates: "all" };
    const body = { summary: i.title, start: { dateTime: i.start }, end: { dateTime: i.end }, attendees: i.attendees.map((email) => ({ email })), ...(i.location ? { location: i.location } : {}), ...(i.description ? { description: i.description } : {}) };
    const grant = mintSendGrant(a.id, requestDigest("calendar", "POST", "calendars/primary/events", { query, body }));
    const ev = await this.api.approved<{ id?: string }>(grant, "calendar", "POST", "calendars/primary/events", { query, body });
    this.executed(a, ev?.id);
    return `Invited ${i.attendees.join(", ")} to "${i.title}", ${fmt(new Date(i.start))}${ev?.id ? ` (event ${ev.id})` : ""}. Today ${this.usedToday()} of ${this.limits.dailyCap}.`;
  }
}

/** Parses Paul's approval or cancellation. Whole-message matches only, so no sentence can contain one. */
export function parseOutboundCommand(text: string): { verb: "send" | "cancel"; id?: string } | undefined {
  const t = text.trim().replace(/[.!\s]+$/, "");
  const m = t.match(/^(send|approve|yes|ok|cancel|no|reject)(?:\s+(?:it|([a-f0-9]{6})))?$/i);
  if (!m) return undefined;
  const verb = /^(send|approve|yes|ok)$/i.test(m[1]) ? "send" : "cancel";
  // A bare "yes" or "ok" is left to the normal flow; "send it" and "cancel it" name no id.
  if (!m[2] && !/\s+it$/i.test(t)) return undefined;
  return { verb, id: m[2]?.toLowerCase() };
}
