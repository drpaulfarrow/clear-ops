import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

export interface InboundMessage {
  from: string; // E.164 digits, no plus
  text: string;
  messageId: string;
}

export interface Messenger {
  send(to: string, text: string): Promise<void>;
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
  constructor(private readonly print = false) {}
  async send(to: string, text: string): Promise<void> {
    this.sent.push({ to, text });
    if (this.print) console.log(`\n> ${to}\n${text}\n`);
  }
}
