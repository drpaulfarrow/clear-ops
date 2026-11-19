/**
 * The web app's chat with the chief (docs/APP.md, slice 2): conversations kept by the service, that
 * the signed-in app reads and adds to. There is the main one, and since 19 Nov 2026 one thread for each
 * job and each pull request Paul talks about from its own page, so the chief knows the topic without
 * being told (`webThread`). Each is a conversation of its own to the orchestrator, as a Discord thread is.
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
/** The app's main conversation with the chief, and where its jobs report. */
export const WEB_CONVERSATION = "web:main";
/** A thread about one job or one pull request. Nothing else is a conversation of the app's. */
const WEB_THREAD = /^web:(?:job:([A-Za-z0-9_-]{1,64})|pull:([A-Za-z0-9._-]{1,64}):([1-9]\d{0,8}))$/;
/** What a thread is about. */
export type WebTopic = { job: string } | { pull: { repo: string; number: number } };

/** Whether an address is one of the app's own conversations: the main one, or a well-formed thread. */
export function isWebConversation(address: string): boolean {
  return address === WEB_CONVERSATION || WEB_THREAD.test(address);
}

/** What a thread's address is about, or undefined for the main conversation and anything else. */
export function webTopic(address: string): WebTopic | undefined {
  const m = WEB_THREAD.exec(address);
  if (!m) return undefined;
  return m[1] ? { job: m[1] } : { pull: { repo: m[2]!, number: Number(m[3]) } };
}

/** The address of the thread about a job or a pull request, or undefined when it does not name one. */
export function webThread(topic: WebTopic): string | undefined {
  const address = "job" in topic ? `web:job:${topic.job}` : `web:pull:${topic.pull.repo}:${topic.pull.number}`;
  return WEB_THREAD.test(address) ? address : undefined;
}
/** The longest message the app accepts. */
export const WEB_TEXT_MAX = 4000;
/** How many messages the transcript keeps of the main conversation. */
export const WEB_KEEP = 500;
/** How many it keeps of each thread, and how many threads; the thread quiet for longest goes first. */
export const WEB_THREAD_KEEP = 200;
export const WEB_THREADS_MAX = 200;
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
  /** The thread it belongs to, by address. Absent: the main conversation. */
  thread?: string;
}

export interface WebChatOptions {
  /** The data directory; the transcript is kept under `app/` inside it. Absent: memory only. */
  dir?: string;
  now?: () => number;
}

export class WebChat {
  private messages: WebMessage[] = [];
  private seq = 0;
  private typingUntil = new Map<string, number>();
  /** `threads()` as last worked out, until a message is added or removed. The board asks every few seconds. */
  private notes?: Map<string, { count: number; lastAt: string }>;
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
      if (Array.isArray(saved.messages)) this.messages = (saved.messages as WebMessage[]).filter((m) => m && typeof m.id === "string" && typeof m.text === "string" && (m.from === "paul" || m.from === "clearops") && (m.thread === undefined || (typeof m.thread === "string" && WEB_THREAD.test(m.thread))));
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

  /** The thread an address names, or undefined for the main conversation. Anything else of the app's is the main one. */
  private threadOf(to: string): string | undefined {
    return WEB_THREAD.test(to) ? to : undefined;
  }

  private in(thread: string | undefined): WebMessage[] {
    return this.messages.filter((m) => m.thread === thread);
  }

  private add(from: WebMessage["from"], text: string, live = false, to: string = WEB_CONVERSATION): WebMessage {
    this.seq += 1;
    const thread = this.threadOf(to);
    const message: WebMessage = { id: String(this.seq), at: new Date(this.now()).toISOString(), from, text: redact(text), ...(live ? { live: true as const } : {}), ...(thread ? { thread } : {}) };
    this.messages.push(message);
    this.notes = undefined;
    this.trim(thread);
    if (!live) this.save();
    return message;
  }

  /** Each conversation keeps its newest messages, and only so many threads are kept at all. */
  private trim(thread: string | undefined): void {
    const keep = thread ? WEB_THREAD_KEEP : WEB_KEEP;
    const mine = this.in(thread);
    if (mine.length > keep) {
      const drop = new Set(mine.slice(0, mine.length - keep));
      this.messages = this.messages.filter((m) => !drop.has(m));
    }
    const last = new Map<string, number>();
    this.messages.forEach((m, i) => m.thread && last.set(m.thread, i));
    if (last.size > WEB_THREADS_MAX) {
      const gone = new Set([...last].sort((a, b) => a[1] - b[1]).slice(0, last.size - WEB_THREADS_MAX).map(([t]) => t));
      this.messages = this.messages.filter((m) => !m.thread || !gone.has(m.thread));
    }
  }

  /** Paul's own message, from the app's route. */
  inbound(text: string, to: string = WEB_CONVERSATION): WebMessage {
    return this.add("paul", text, false, to);
  }

  /** What the app shows of one conversation: the newest messages, and whether the chief is working on a reply. */
  view(to: string = WEB_CONVERSATION): { messages: WebMessage[]; typing: boolean } {
    const thread = this.threadOf(to);
    return { messages: this.in(thread).slice(-WEB_SHOWN), typing: (this.typingUntil.get(thread ?? WEB_CONVERSATION) ?? 0) > this.now() };
  }

  /** Every thread that has anything in it: how many messages, and when the last was. */
  threads(): Map<string, { count: number; lastAt: string }> {
    if (this.notes) return this.notes;
    const out = new Map<string, { count: number; lastAt: string }>();
    for (const m of this.messages) if (m.thread && !m.live) out.set(m.thread, { count: (out.get(m.thread)?.count ?? 0) + 1, lastAt: m.at });
    return (this.notes = out);
  }

  /* ---------- The Messenger side: what the service says to the conversation ---------- */

  async send(to: string, text: string): Promise<void> {
    this.typingUntil.delete(this.threadOf(to) ?? WEB_CONVERSATION);
    this.add("clearops", text, false, to);
  }

  async sendEditable(to: string, text: string): Promise<string | undefined> {
    return this.add("clearops", text, true, to).id;
  }

  async edit(_to: string, handle: string, text: string): Promise<void> {
    const m = this.messages.find((x) => x.id === handle && x.live);
    if (m) m.text = redact(text);
  }

  async remove(_to: string, handle: string): Promise<void> {
    this.messages = this.messages.filter((x) => !(x.id === handle && x.live));
    this.notes = undefined;
  }

  async typing(to: string): Promise<boolean> {
    this.typingUntil.set(this.threadOf(to) ?? WEB_CONVERSATION, this.now() + TYPING_MS);
    return true;
  }

  /** Pictures are a later slice; until then the caption is kept so nothing a job said is lost. */
  async sendImage(to: string, _file: string, caption: string): Promise<void> {
    if (caption) this.add("clearops", caption, false, to);
  }

  async recent(to: string, limit: number): Promise<Array<{ author: string; text: string }>> {
    return this.in(this.threadOf(to))
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
