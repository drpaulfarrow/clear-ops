import { config } from "./config.js";
import { chunk, type Messenger } from "./whatsapp.js";
import type { HandleContext } from "./orchestrator.js";
import { fetchCapped, UploadError, type Attachment } from "./uploads.js";

/** Telegram identities are stored as "tg:<chat id>" so they never collide with phone numbers. */
export const TG = "tg:";
export const tgId = (chatId: number | string) => `${TG}${chatId}`;

interface TgFileRef {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
  width?: number;
}

interface Update {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    caption?: string;
    chat: { id: number; type: string };
    from?: { id: number; username?: string };
    document?: TgFileRef;
    photo?: TgFileRef[];
    video?: TgFileRef;
    audio?: TgFileRef;
    voice?: TgFileRef;
  };
}

/** A file on a Telegram message, not yet downloaded. */
export interface TelegramFile {
  fileId: string;
  name: string;
  mimeType?: string;
  size?: number;
}

export interface TelegramInbound {
  from: string; // "tg:<chat id>"
  text: string;
  /** Present only when the message carries files. */
  files?: TelegramFile[];
}

/** The files on one message. Photos come in several sizes; take the largest. */
function filesOf(m: NonNullable<Update["message"]>): TelegramFile[] {
  const out: TelegramFile[] = [];
  if (m.document) out.push({ fileId: m.document.file_id, name: m.document.file_name ?? "document", mimeType: m.document.mime_type, size: m.document.file_size });
  if (m.photo?.length) {
    const p = [...m.photo].sort((a, b) => (b.file_size ?? b.width ?? 0) - (a.file_size ?? a.width ?? 0))[0];
    out.push({ fileId: p.file_id, name: `photo-${m.message_id}.jpg`, mimeType: "image/jpeg", size: p.file_size });
  }
  for (const [key, ext] of [["video", ".mp4"], ["audio", ""], ["voice", ".ogg"]] as const) {
    const f = m[key];
    if (f) out.push({ fileId: f.file_id, name: f.file_name ?? `${key}-${m.message_id}${ext}`, mimeType: f.mime_type, size: f.file_size });
  }
  return out;
}

/** Pull messages from private chats out of a batch of updates: text, or files with an optional caption. */
export function parseUpdates(updates: Update[]): TelegramInbound[] {
  const out: TelegramInbound[] = [];
  for (const u of updates) {
    const m = u.message;
    if (!m || m.chat.type !== "private") continue;
    const files = filesOf(m);
    const text = m.text ?? m.caption ?? "";
    if (files.length) out.push({ from: tgId(m.chat.id), text, files });
    else if (text) out.push({ from: tgId(m.chat.id), text });
  }
  return out;
}

/**
 * Turn a Telegram file into an attachment that downloads only when asked (after the allowlist check).
 * The download URL carries the bot token, so it is never logged or put in an error.
 */
export function telegramAttachment(f: TelegramFile, fetchImpl: typeof fetch = fetch): Attachment {
  return {
    name: f.name,
    mimeType: f.mimeType,
    size: f.size,
    async download(maxBytes: number) {
      const res = await fetchImpl(api("getFile"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file_id: f.fileId }) });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: { file_path?: string; file_size?: number } };
      if (!data.ok || !data.result?.file_path) throw new UploadError("Telegram would not hand the file over (bots can fetch files up to 20 MB)");
      if (data.result.file_size != null && data.result.file_size > maxBytes) throw new UploadError("too large");
      return fetchCapped(`https://api.telegram.org/file/bot${config.telegram.token}/${data.result.file_path}`, maxBytes, fetchImpl);
    },
  };
}

const api = (method: string) => `https://api.telegram.org/bot${config.telegram.token}/${method}`;

/** Telegram shows Markdown markers literally in plain-text mode, so take the common ones out. */
export function plainText(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "• ");
}

/** Sends through the Telegram Bot API as plain text. */
export class TelegramMessenger implements Messenger {
  async send(to: string, text: string): Promise<void> {
    const chat_id = chatId(to);
    for (const part of chunk(plainText(text))) {
      const res = await fetch(api("sendMessage"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id, text: part, disable_web_page_preview: true }),
      });
      if (!res.ok) throw new Error(`Telegram send failed: ${res.status} ${await res.text().catch(() => "")}`);
    }
  }

  /** A single short message whose id is the handle for edit and remove. */
  async sendEditable(to: string, text: string): Promise<string | undefined> {
    const data = (await call("sendMessage", { chat_id: chatId(to), text: plainText(text).slice(0, 4000), disable_web_page_preview: true })) as { message_id?: number };
    return data?.message_id != null ? String(data.message_id) : undefined;
  }

  async edit(to: string, handle: string, text: string): Promise<void> {
    await call("editMessageText", { chat_id: chatId(to), message_id: Number(handle), text: plainText(text).slice(0, 4000), disable_web_page_preview: true });
  }

  async remove(to: string, handle: string): Promise<void> {
    await call("deleteMessage", { chat_id: chatId(to), message_id: Number(handle) });
  }

  /** Telegram shows "typing…" for about five seconds per call. */
  async typing(to: string): Promise<boolean> {
    await call("sendChatAction", { chat_id: chatId(to), action: "typing" });
    return true;
  }
}

const chatId = (to: string) => (to.startsWith(TG) ? to.slice(TG.length) : to);

/** One Bot API call; returns `result`, throws on an error response. */
async function call(method: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(api(method), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: unknown; description?: string };
  if (!res.ok || !data.ok) throw new Error(`Telegram ${method} failed: ${res.status} ${data.description ?? ""}`.trim());
  return data.result;
}

/**
 * Long-polls getUpdates and hands each private message (text, or files with a caption) to the handler.
 * No public URL needed, which is why Telegram is the quickest channel to run anywhere.
 */
export class TelegramPoller {
  private offset = 0;
  private stopped = false;
  private hinted = new Set<string>();

  constructor(
    private readonly handle: (from: string, text: string, ctx?: HandleContext) => Promise<void>,
    private readonly messenger: Messenger,
    private readonly isAllowed: (from: string) => boolean,
  ) {}

  async start(): Promise<void> {
    // Drop any webhook so getUpdates works, then loop.
    await fetch(api("deleteWebhook"), { method: "POST" }).catch(() => undefined);
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        const res = await fetch(api("getUpdates"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ offset: this.offset, timeout: 30, allowed_updates: ["message"] }),
        });
        const data = (await res.json()) as { ok: boolean; result?: Update[] };
        for (const u of data.result ?? []) {
          this.offset = u.update_id + 1;
          for (const m of parseUpdates([u])) {
            if (this.isAllowed(m.from)) void this.handle(m.from, m.text, m.files ? { attachments: m.files.map((f) => telegramAttachment(f)) } : {});
            else if (!this.hinted.has(m.from)) {
              // Tell the sender their id once, so the operator can allowlist it. Nothing else leaks.
              this.hinted.add(m.from);
              await this.messenger.send(m.from, `This bot only answers its operator. Your Telegram id is ${m.from.slice(TG.length)}.`);
            }
          }
        }
      } catch (err) {
        console.error("telegram poll error", err instanceof Error ? err.message : err);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }
}
