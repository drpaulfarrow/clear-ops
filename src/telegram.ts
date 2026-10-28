import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { chunk, type Messenger } from "./whatsapp.js";

/** Telegram identities are stored as "tg:<chat id>" so they never collide with phone numbers. */
export const TG = "tg:";
export const tgId = (chatId: number | string) => `${TG}${chatId}`;

interface Update {
  update_id: number;
  message?: { message_id: number; text?: string; chat: { id: number; type: string }; from?: { id: number; username?: string } };
}

export interface TelegramInbound {
  from: string; // "tg:<chat id>"
  text: string;
}

/** Pull text messages from private chats out of a batch of updates. */
export function parseUpdates(updates: Update[]): TelegramInbound[] {
  const out: TelegramInbound[] = [];
  for (const u of updates) {
    const m = u.message;
    if (m?.text && m.chat.type === "private") out.push({ from: tgId(m.chat.id), text: m.text });
  }
  return out;
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

  /** A photo with a caption (Telegram caps captions at 1024 characters). */
  async sendImage(to: string, file: string, caption: string): Promise<void> {
    const form = new FormData();
    form.append("chat_id", chatId(to));
    form.append("caption", plainText(caption).slice(0, 1000));
    form.append("photo", new Blob([fs.readFileSync(file)], { type: file.endsWith(".png") ? "image/png" : "image/jpeg" }), path.basename(file));
    const res = await fetch(api("sendPhoto"), { method: "POST", body: form });
    if (!res.ok) throw new Error(`Telegram sendPhoto failed: ${res.status} ${await res.text().catch(() => "")}`);
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
 * Long-polls getUpdates and hands each private text message to the handler.
 * No public URL needed, which is why Telegram is the quickest channel to run anywhere.
 */
export class TelegramPoller {
  private offset = 0;
  private stopped = false;
  private hinted = new Set<string>();

  constructor(
    private readonly handle: (from: string, text: string) => Promise<void>,
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
            if (this.isAllowed(m.from)) void this.handle(m.from, m.text);
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
