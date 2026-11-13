import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { fetchCapped, UploadError, type Attachment } from "./uploads.js";

export interface InboundMessage {
  from: string; // E.164 digits, no plus
  text: string;
  messageId: string;
  /** A voice note or audio file on the message, fetched only after the sender passes the allowlist. */
  audio?: WhatsAppAudio;
}

/** An audio message on WhatsApp: Meta keeps the bytes, so the id is exchanged for a URL when we ask. */
export interface WhatsAppAudio {
  /** Meta's media id. */
  id: string;
  mimeType?: string;
  size?: number;
  /** A voice note recorded in the app, rather than an attached audio file. */
  voice?: boolean;
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
  /**
   * Remove an inbound message of Paul's own, where the channel allows a bot to. Used for the one message
   * that carries a one-time code: the service takes the code out of it and then tidies it away, so it is
   * not left sitting in the chat. Best effort: a channel that cannot delete it leaves it as it is.
   */
  deleteInbound?(to: string, messageId: string): Promise<void>;
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

/**
 * Pull text and audio messages out of a Meta webhook payload. Ignores statuses, images, video,
 * documents and reactions. Only the sender's own id and a media id are taken from the payload: the
 * bytes are fetched later, and only after the sender passes the allowlist.
 */
export function parseInbound(body: unknown): InboundMessage[] {
  const out: InboundMessage[] = [];
  const entries = (body as { entry?: unknown[] })?.entry ?? [];
  for (const entry of entries as Array<{ changes?: unknown[] }>) {
    for (const change of entry.changes ?? []) {
      const value = (change as { value?: { messages?: unknown[] } }).value;
      for (const m of value?.messages ?? []) {
        const msg = m as {
          type?: string;
          from?: string;
          id?: string;
          text?: { body?: string };
          audio?: { id?: string; mime_type?: string; file_size?: number; voice?: boolean };
        };
        if (msg.type === "text" && msg.from && msg.text?.body) {
          out.push({ from: msg.from, text: msg.text.body, messageId: msg.id ?? "" });
        } else if ((msg.type === "audio" || msg.type === "voice") && msg.from && msg.audio?.id) {
          out.push({
            from: msg.from,
            text: "",
            messageId: msg.id ?? "",
            audio: { id: msg.audio.id, mimeType: msg.audio.mime_type, size: msg.audio.file_size, voice: msg.audio.voice },
          });
        }
      }
    }
  }
  return out;
}

/** The saved name for a WhatsApp audio message, with an extension the transcriber recognises. */
export function whatsappAudioName(a: WhatsAppAudio): string {
  const mime = (a.mimeType ?? "").toLowerCase();
  const ext = /mpeg|mp3/.test(mime) ? ".mp3" : /mp4|m4a|aac/.test(mime) ? ".m4a" : /wav/.test(mime) ? ".wav" : /webm/.test(mime) ? ".webm" : ".ogg";
  return `${a.voice === false ? "audio" : "voice-note"}-${a.id}${ext}`;
}

/** Meta's media lookup answers with a small JSON body: cap it, and never wait on it forever. */
const MEDIA_INFO_MAX_BYTES = 64 * 1024;
const MEDIA_INFO_TIMEOUT_MS = 15_000;

/** The media id's short-lived URL and size, read with a timeout and a cap. Empty when it cannot be read. */
async function mediaInfo(mediaUrl: string, fetchImpl: typeof fetch): Promise<{ url?: string; file_size?: number }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), MEDIA_INFO_TIMEOUT_MS);
  try {
    const res = await fetchImpl(mediaUrl, {
      headers: { Authorization: `Bearer ${config.whatsapp.token}` },
      signal: ac.signal,
    });
    if (!res.ok || !res.body) return {};
    const parts: Buffer[] = [];
    let total = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MEDIA_INFO_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        return {};
      }
      parts.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(parts).toString("utf8") || "{}") as { url?: string; file_size?: number };
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Turn a WhatsApp audio message into an attachment that downloads only when asked (after the
 * allowlist check). Meta hands back a short-lived URL for the media id first, then the bytes from it;
 * both calls carry the service token, so neither the URL nor any error text is ever logged or shown.
 */
export function whatsappAttachment(a: WhatsAppAudio, fetchImpl: typeof fetch = fetch): Attachment {
  return {
    name: whatsappAudioName(a),
    mimeType: a.mimeType,
    size: a.size,
    async download(maxBytes: number) {
      const data = await mediaInfo(`https://graph.facebook.com/${config.whatsapp.apiVersion}/${encodeURIComponent(a.id)}`, fetchImpl);
      if (!data.url) throw new UploadError("WhatsApp would not hand the audio message over");
      if (data.file_size != null && data.file_size > maxBytes) throw new UploadError("too large");
      return fetchCapped(data.url, maxBytes, fetchImpl, { Authorization: `Bearer ${config.whatsapp.token}` });
    },
  };
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
