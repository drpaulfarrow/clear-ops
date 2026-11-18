/**
 * The web app's chat with the chief (docs/APP.md, slice 2): one conversation, kept by the service, that
 * the signed-in app reads and adds to.
 *
 * It is a channel like Telegram or Discord as far as the orchestrator is concerned: Paul's message goes
 * to `orchestrator.handle`, and everything addressed to the conversation (the chief's replies, a job's
 * finished message, the live status line) lands here instead of in a chat app. Three things make it
 * different, and each is deliberate:
 *
 *  - Who is speaking is vouched for by the route, not by a channel allowlist. The only way a message
 *    enters is `POST /app/api/chat`, behind the GitHub sign-in (src/app-auth.ts), and it is handed to
 *    the orchestrator as `WEB_SENDER` with `web: true`. No other listener can produce that sender, and
 *    it is in no allowlist, so every approval gate that checks `isAllowed` for itself still refuses it.
 *  - Approval words are refused here (`webRefusal`), before anything is kept and before any model:
 *    sending mail, buying, DNS, sign-ups, one-time codes, acting as Paul on a site, reading a private
 *    document, the page password and device pairing are never taken from typed words here. Since
 *    slice 3 the app approves a waiting item with its own button instead (src/app-approver.ts), which
 *    is tied to the exact text shown for that item; a typed word is tied to nothing.
 *  - A one-time code typed here by mistake is never written down: the message is replaced before it is
 *    stored, and it never reaches the orchestrator.
 *
 * The transcript lives in one owner-only file under DATA_DIR/app, capped at WEB_KEEP messages. It holds
 * what the chief said to Paul, which can include what a job found, so it is treated like the rest of
 * the data volume: never in a checkout, never copied anywhere, read only by the signed-in app.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { parseDnsCommand } from "./dns-gate.js";
import { parseDocReadCommand } from "./doc-reader.js";
import { parseCodeCommand } from "./otp.js";
import { parseOutboundCommand } from "./outbound.js";
import { parsePurchaseCommand } from "./purchase.js";
import { redact } from "./repos.js";
import { parseSignupCommand } from "./signup-gate.js";
import { parseActAsMeCommand } from "./site-policy.js";
import type { Messenger } from "./whatsapp.js";

/** Every address the web app owns starts with this; the router sends them here and nowhere else. */
export const WEB_PREFIX = "web:";
/** Who a message from the app is from. In no allowlist, and produced by the app's route alone. */
export const WEB_SENDER = "web:paul";
/** The one conversation the app has with the chief, and where its jobs report. */
export const WEB_CONVERSATION = "web:main";
/** The longest message the app accepts. */
export const WEB_TEXT_MAX = 4000;
/** How many messages the transcript keeps. */
export const WEB_KEEP = 500;
/** How many the app is sent at a time: the newest. */
export const WEB_SHOWN = 200;
/** How long a typing signal counts for. */
const TYPING_MS = 8_000;

export const WEB_APPROVAL_REFUSAL =
  "Typed approvals do not work in the app, so nothing was done. Use the Approve and Decline buttons under Waiting on me, or send that in Discord.";
export const WEB_CODE_REFUSAL = "That looks like a one-time code. I have not kept it and nothing was done with it. Send it in Discord, where the sign-in is waiting for it.";
/** What is kept in place of a code-shaped message, so the code itself is never written down. */
export const WEB_CODE_PLACEHOLDER = "(A one-time code. Not kept.)";

/**
 * Why a message is refused in the app's chat, or undefined when it may go to the orchestrator. Every
 * owner-only word the orchestrator parses before the model is here, so none of them can be reached
 * from the app whatever the orchestrator would have made of it.
 */
export function webRefusal(text: string): string | undefined {
  const t = text.trim();
  if (parseCodeCommand(t)) return WEB_CODE_REFUSAL;
  if (
    parseDnsCommand(t) ||
    parseSignupCommand(t) ||
    parsePurchaseCommand(t) ||
    parseOutboundCommand(t) ||
    parseActAsMeCommand(t) ||
    parseDocReadCommand(t) ||
    /^(?:docs consent|connect docs|\/docs)$/i.test(t) ||
    /^(yes|approve|ok|no|reject)\s+[a-f0-9]{6}\b/i.test(t) ||
    /^\/(password|pair\b.*|unpair|whoami|google disconnect)$/i.test(t)
  )
    return WEB_APPROVAL_REFUSAL;
  return undefined;
}

export interface WebMessage {
  id: string;
  /** ISO time. */
  at: string;
  from: "paul" | "clearops";
  text: string;
  /** The chief's live status line: edited in place while it works, removed when the reply is ready. */
  live?: true;
}

export interface WebChatOptions {
  /** The data directory; the transcript is kept under `app/` inside it. Absent: memory only. */
  dir?: string;
  now?: () => number;
}

export class WebChat {
  private messages: WebMessage[] = [];
  private seq = 0;
  private typingUntil = 0;
  private readonly file?: string;
  private readonly now: () => number;

  constructor(o: WebChatOptions = {}) {
    this.now = o.now ?? Date.now;
    this.file = o.dir ? path.join(o.dir, "app", "chat.json") : undefined;
    this.load();
  }

  private load(): void {
    if (!this.file) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8")) as { seq?: unknown; messages?: unknown };
      if (Array.isArray(saved.messages)) this.messages = (saved.messages as WebMessage[]).filter((m) => m && typeof m.id === "string" && typeof m.text === "string" && (m.from === "paul" || m.from === "clearops"));
      this.seq = typeof saved.seq === "number" ? saved.seq : this.messages.length;
    } catch {
      // No transcript yet, or an unreadable one: start empty rather than stop the service.
    }
  }

  /** The status line is of the moment and is never written down. */
  private save(): void {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ seq: this.seq, messages: this.messages.filter((m) => !m.live) }), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.warn(`The app's chat could not be saved: ${err instanceof Error ? err.message : "error"}`);
    }
  }

  private add(from: WebMessage["from"], text: string, live = false): WebMessage {
    this.seq += 1;
    const message: WebMessage = { id: String(this.seq), at: new Date(this.now()).toISOString(), from, text: redact(text), ...(live ? { live: true as const } : {}) };
    this.messages.push(message);
    if (this.messages.length > WEB_KEEP) this.messages = this.messages.slice(-WEB_KEEP);
    if (!live) this.save();
    return message;
  }

  /** Paul's own message, from the app's route. */
  inbound(text: string): WebMessage {
    return this.add("paul", text);
  }

  /** What the app shows: the newest messages, and whether the chief is working on a reply. */
  view(): { messages: WebMessage[]; typing: boolean } {
    return { messages: this.messages.slice(-WEB_SHOWN), typing: this.typingUntil > this.now() };
  }

  /* ---------- The Messenger side: what the service says to the conversation ---------- */

  async send(_to: string, text: string): Promise<void> {
    this.typingUntil = 0;
    this.add("clearops", text);
  }

  async sendEditable(_to: string, text: string): Promise<string | undefined> {
    return this.add("clearops", text, true).id;
  }

  async edit(_to: string, handle: string, text: string): Promise<void> {
    const m = this.messages.find((x) => x.id === handle && x.live);
    if (m) m.text = redact(text);
  }

  async remove(_to: string, handle: string): Promise<void> {
    this.messages = this.messages.filter((x) => !(x.id === handle && x.live));
  }

  async typing(_to: string): Promise<boolean> {
    this.typingUntil = this.now() + TYPING_MS;
    return true;
  }

  /** Pictures are a later slice; until then the caption is kept so nothing a job said is lost. */
  async sendImage(_to: string, _file: string, caption: string): Promise<void> {
    if (caption) this.add("clearops", caption);
  }

  async recent(_to: string, limit: number): Promise<Array<{ author: string; text: string }>> {
    return this.messages
      .filter((m) => !m.live)
      .slice(-limit)
      .map((m) => ({ author: m.from === "paul" ? "Paul" : "ClearOps", text: m.text }));
  }
}

/**
 * A messenger that delivers every web address to the app's chat and everything else exactly as before.
 * A method the wrapped messenger does not have stays absent, so no other channel behaves differently.
 */
export function routeWeb<M extends Messenger>(messenger: M, chat: WebChat): M {
  return new Proxy(messenger, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (typeof args[0] === "string" && args[0].startsWith(WEB_PREFIX)) {
          const own = (chat as unknown as Record<string | symbol, unknown>)[prop];
          return typeof own === "function" ? (own as (...a: unknown[]) => unknown).apply(chat, args) : Promise.resolve(undefined);
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

/** The service's own transcript. */
export const webChat = new WebChat({ dir: config.dataDir });
