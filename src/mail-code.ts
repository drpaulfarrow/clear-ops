/**
 * Reading a site's one-time code out of Paul's mailbox, service-side.
 *
 * The relay (src/otp.ts) uses this when a page offers to send its code by email: the service, never a
 * model, reads the newest message from that site's own domain, pulls the code out of it and hands it
 * straight to the page the browser is holding. Nothing here reads anything but that site's mail, and
 * the code is never logged, saved or shown to a model.
 *
 * The mailbox is Paul's connected Google Workspace account (src/google.ts): the connection the
 * executive assistant already uses, through the same read-only Gmail endpoints, so no new scope and no
 * new consent. With Google disconnected, or with a message that has no code in it, the relay falls
 * back to asking Paul in chat.
 */
import type { GoogleApi } from "./google.js";
import { hostMatches } from "./vault.js";

/** One message's headers and MIME tree, as Gmail returns them for `format=full`. */
interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
}

interface GmailMessage {
  id: string;
  internalDate?: string;
  payload?: GmailPart;
}

/** Where a code may be read from, so tests can use a fake mailbox. */
export interface CodeMailbox {
  /**
   * The newest one-time code from `domain` that arrived after `since` (ms since the epoch), polling
   * until `timeoutMs` has passed. Undefined when nothing arrived in time. Never throws for a mailbox
   * that cannot be read: the caller asks Paul in chat instead.
   */
  codeFrom(input: { domain: string; since: number; timeoutMs: number }): Promise<string | undefined>;
}

const b64url = (s: string) => Buffer.from(s, "base64url").toString("utf8");

function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** The readable text of a message: text/plain where there is one, else text/html stripped. */
export function messageText(part: GmailPart | undefined, max = 20_000): string {
  const plain: string[] = [];
  const html: string[] = [];
  const walk = (p?: GmailPart) => {
    if (!p) return;
    if (p.body?.data && !p.filename) {
      if (p.mimeType === "text/plain") plain.push(b64url(p.body.data));
      else if (p.mimeType === "text/html") html.push(stripHtml(b64url(p.body.data)));
    }
    for (const c of p.parts ?? []) walk(c);
  };
  walk(part);
  return (plain.length ? plain.join("\n") : html.join("\n")).slice(0, max);
}

export function headerValue(headers: Array<{ name: string; value: string }> | undefined, name: string): string {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

/** The domain of the first address in a header value ("Amazon <no-reply@amazon.co.uk>"), lower case. */
export function senderDomain(value: string): string | undefined {
  const addr = value.match(/[A-Za-z0-9._%+'-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/)?.[1];
  return addr?.toLowerCase();
}

/**
 * The one-time code in a message, or undefined when there is no plausible one.
 *
 * A number next to a code word ("your verification code is 123456", "123456 is your code") wins, a
 * six-digit one first; failing that, a standalone six-digit number. A four-digit year, a price and a
 * number that is part of a longer number are not codes. Erring towards undefined is safe: the relay
 * then asks Paul in chat rather than typing something wrong into the page.
 */
export function extractCode(text: string): string | undefined {
  const flat = text.replace(/\s+/g, " ");
  const keyword = /(?:code|otp|passcode|one[- ]?time|verification|security code|pin)\b/i;
  const near: string[] = [];
  for (const m of flat.matchAll(/(?:code|otp|passcode|one[- ]?time|verification|security code|pin)\b[^0-9]{0,24}(?<!\d)(\d{4,8})(?!\d)/gi)) near.push(m[1]);
  for (const m of flat.matchAll(/(?<!\d)(\d{4,8})(?!\d)[^0-9A-Za-z]{0,24}(?:is your|as your)?\s*(?:code|otp|passcode|one[- ]?time|verification|pin)\b/gi)) near.push(m[1]);
  const six = near.find((c) => c.length === 6);
  if (six) return six;
  const other = near.find((c) => !/^(?:19|20)\d{2}$/.test(c));
  if (other) return other;
  if (!keyword.test(flat)) {
    // No code word anywhere: only a bare six-digit number is code-like, and never part of a longer
    // number, a price or a date with separators around it.
    const bare = flat.match(/(?<![\d.,£$€/-])(\d{6})(?![\d.,/%-])/);
    if (bare) return bare[1];
  }
  return undefined;
}

/** The code mailbox, backed by Paul's connected Google Workspace account. */
export class GmailCodeReader implements CodeMailbox {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollMs: number;
  /** Messages already searched, so a poll does not read the same one again. */
  private readonly seen = new Set<string>();

  constructor(
    private readonly api: Pick<GoogleApi, "request">,
    opts: { now?: () => number; sleep?: (ms: number) => Promise<void>; pollMs?: number } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.pollMs = opts.pollMs ?? 4_000;
  }

  async codeFrom({ domain, since, timeoutMs }: { domain: string; since: number; timeoutMs: number }): Promise<string | undefined> {
    const deadline = this.now() + Math.max(0, timeoutMs);
    for (;;) {
      const found = await this.searchOnce(domain, since);
      if (found) return found;
      const left = deadline - this.now();
      if (left <= 0) return undefined;
      await this.sleep(Math.min(this.pollMs, left));
    }
  }

  /** One pass over the recent mail from that site: the newest message with a code in it wins. */
  private async searchOnce(domain: string, since: number): Promise<string | undefined> {
    const list = await this.api.request<{ messages?: Array<{ id: string }> }>("gmail", "GET", "messages", {
      query: { q: `from:${domain} newer_than:1d`, maxResults: 10 },
    });
    for (const { id } of list.messages ?? []) {
      if (this.seen.has(id)) continue;
      this.seen.add(id);
      const m = await this.api.request<GmailMessage>("gmail", "GET", `messages/${encodeURIComponent(id)}`, { query: { format: "full" } });
      const sentAt = Number(m.internalDate ?? 0);
      // Only mail that arrived around or after the code was asked for: an old code is no use, and
      // typing it into the page would only fail. Gmail's own date, not the sender's.
      if (!sentAt || sentAt < since - 60_000) continue;
      const from = senderDomain(headerValue(m.payload?.headers, "From"));
      if (!from || !(hostMatches(from, domain) || hostMatches(domain, from))) continue;
      const code = extractCode(messageText(m.payload));
      if (code) return code;
    }
    return undefined;
  }
}
