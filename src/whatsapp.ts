import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

export interface InboundMessage {
  from: string; // E.164 digits, no plus
  text: string;
  messageId: string;
}

export interface Messenger {
  /** `to` is an address: a phone number, "tg:<chat>", "dc:c:<channel>" or "dc:u:<user>". */
  send(to: string, text: string): Promise<void>;
  /**
   * Channels with threads (Discord) open one for a job and return its address: under the inbound
   * message when it has none yet, otherwise a standalone thread in the channel. Undefined where the
   * conversation cannot have threads; throws if opening one failed.
   */
  openThread?(replyTo: string, messageId: string | undefined, name: string): Promise<string | undefined>;
  /**
   * Channels that can edit messages (Telegram, Discord) send one and return a handle for edit and
   * remove; undefined means this address cannot be edited. Used for the chief's live status line.
   */
  sendEditable?(to: string, text: string): Promise<string | undefined>;
  edit?(to: string, handle: string, text: string): Promise<void>;
  remove?(to: string, handle: string): Promise<void>;
  /** Channels that carry images (Telegram, Discord) send a PNG or JPEG file with a caption. */
  sendImage?(to: string, file: string, caption: string): Promise<void>;
  /** Show a typing indicator for a few seconds. Resolves true if the channel supports it. */
  typing?(to: string): Promise<boolean>;
  /** Channels with readable history (Discord) return the last `limit` messages of a conversation, oldest first. */
  recent?(to: string, limit: number): Promise<Array<{ author: string; text: string }>>;
}

/** Split long text on paragraph boundaries so each piece fits a WhatsApp message. */
export function chunk(text: string, max = config.maxMessageChars): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

/** Pull text messages out of a Meta webhook payload. Ignores statuses, media and reactions. */
export function parseInbound(body: unknown): InboundMessage[] {
  const out: InboundMessage[] = [];
  const entries = (body as { entry?: unknown[] })?.entry ?? [];
  for (const entry of entries as Array<{ changes?: unknown[] }>) {
    for (const change of entry.changes ?? []) {
      const value = (change as { value?: { messages?: unknown[] } }).value;
      for (const m of value?.messages ?? []) {
        const msg = m as { type?: string; from?: string; id?: string; text?: { body?: string } };
        if (msg.type === "text" && msg.from && msg.text?.body) {
          out.push({ from: msg.from, text: msg.text.body, messageId: msg.id ?? "" });
        }
      }
    }
  }
  return out;
}

/** Verify Meta's X-Hub-Signature-256 header against the raw body. */
export function verifySignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!appSecret) return true; // not configured: skip (documented in README)
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const given = header.slice("sha256=".length);
  if (expected.length !== given.length) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(given, "hex"));
}

/** Sends through the WhatsApp Cloud API. */
export class CloudApiMessenger implements Messenger {
  async send(to: string, text: string): Promise<void> {
    const url = `https://graph.facebook.com/${config.whatsapp.apiVersion}/${config.whatsapp.phoneNumberId}/messages`;
    for (const part of chunk(text)) {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.whatsapp.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to,
          type: "text",
          text: { preview_url: false, body: part },
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`WhatsApp send failed: ${res.status} ${detail}`);
      }
    }
  }
}

/** Records instead of sending. The simulator prints; tests stay quiet so the test runner's output stream is untouched. */
export class ConsoleMessenger implements Messenger {
  readonly sent: Array<{ to: string; text: string }> = [];
  readonly images: Array<{ to: string; file: string; caption: string }> = [];
  constructor(private readonly print = false) {}
  async sendImage(to: string, file: string, caption: string): Promise<void> {
    this.images.push({ to, file, caption });
    if (this.print) console.log(`\n> ${to}\n[image ${file}] ${caption}\n`);
  }
  async send(to: string, text: string): Promise<void> {
    this.sent.push({ to, text });
    if (this.print) console.log(`\n> ${to}\n${text}\n`);
  }
}
