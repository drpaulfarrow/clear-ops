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
import { randomBytes } from "node:crypto";
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
import type { Attachment } from "./uploads.js";
import type { Messenger } from "./whatsapp.js";

/** Every address the web app owns starts with this; the router sends them here and nowhere else. */
export const WEB_PREFIX = "web:";
/** Who a message from the app is from. In no allowlist, and produced by the app's route alone. */
export const WEB_SENDER = "web:paul";
/** The app's main conversation with the chief, and where its jobs report. */
export const WEB_CONVERSATION = "web:main";
/**
 * A thread about one job or one pull request, or (since 19 Nov 2026) a chat of Paul's own beside the
 * main one, under an id the service made when he opened it. Nothing else is a conversation of the app's.
 */
const WEB_THREAD = /^web:(?:job:([A-Za-z0-9_-]{1,64})|pull:([A-Za-z0-9._-]{1,64}):([1-9]\d{0,8})|chat:([a-f0-9]{8}))$/;
/** The address of one of Paul's own chats, by its id. */
const WEB_OWN = /^web:chat:[a-f0-9]{8}$/;
/** What the app sends as the thread of the first message of a chat that does not exist yet. */
export const WEB_NEW_CHAT = "chat:new";
/** How many chats of his own are kept. Opening one more drops the one quiet for longest, with everything in it. */
export const WEB_CHATS_MAX = 50;
/** The longest name a chat is given. */
export const WEB_CHAT_TITLE_MAX = 48;

/** One of Paul's own chats: the id the service gave it and the name it took from his first words. */
export interface OwnChat {
  id: string;
  title: string;
  createdAt: string;
}
/** What a thread is about. */
export type WebTopic = { job: string } | { pull: { repo: string; number: number } };

/** Whether an address is one of the app's own conversations: the main one, or a well-formed thread. */
export function isWebConversation(address: string): boolean {
  return address === WEB_CONVERSATION || WEB_THREAD.test(address);
}

/** What a thread's address is about, or undefined for the main conversation and anything else. */
export function webTopic(address: string): WebTopic | undefined {
  const m = WEB_THREAD.exec(address);
  // A chat of his own is about nothing in particular: only a job's or a pull request's thread has a topic.
  if (!m || m[4]) return undefined;
  return m[1] ? { job: m[1] } : { pull: { repo: m[2]!, number: Number(m[3]) } };
}

/** The address of one of Paul's own chats, or undefined when the id is not one the service makes. */
export function webOwnChat(id: string): string | undefined {
  const address = `web:chat:${id}`;
  return WEB_OWN.test(address) ? address : undefined;
}

/** The address of the thread about a job or a pull request, or undefined when it does not name one. */
export function webThread(topic: WebTopic): string | undefined {
  const address = "job" in topic ? `web:job:${topic.job}` : `web:pull:${topic.pull.repo}:${topic.pull.number}`;
  return WEB_THREAD.test(address) ? address : undefined;
}
/** The longest message the app accepts. */
export const WEB_TEXT_MAX = 4000;
/** How many files one message may carry from the app, and how much they may come to together. */
export const WEB_FILES_MAX = 5;
export const WEB_FILES_BYTES = 18 * 1024 * 1024;
/** The largest request body the app's chat route reads, and then only from a signed-in browser: the files above as base64, with room for the rest. */
export const WEB_BODY_LIMIT = "26mb";
/** The largest picture the service's side of the conversation keeps for the app to show. */
export const WEB_PICTURE_BYTES = 10 * 1024 * 1024;
/** The only names a kept picture has: the number of the message it came with, and what it is. */
const WEB_PICTURE = /^[1-9]\d{0,11}\.(png|jpg)$/;

/** PNG or JPEG, told from the bytes themselves and never from a name. Anything else is not a picture here. */
function pictureKind(bytes: Buffer): "png" | "jpg" | undefined {
  if (bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  return undefined;
}

/** One slash command as the app's menu offers it. */
export interface WebCommand {
  /** What is put in the box, e.g. "/trace". */
  command: string;
  /** What must be typed after it, as a hint, e.g. "<id>". The menu leaves the box ready for it. */
  needs?: string;
  /** What may be typed after it. The command is complete without it. */
  takes?: string;
  about: string;
}

/**
 * The slash commands the app's menu offers: the ones the chief understands (`HELP` in
 * src/orchestrator.ts) that work when typed here. The owner-only ones `webRefusal` turns away
 * (/password, /pair, /unpair, /whoami, /google disconnect) are left out, since offering a command
 * that is then refused helps nobody. The menu only fills the box; the message is still sent, checked
 * and refused like any other. test/app.test.ts holds this list against HELP in both directions.
 */
export const WEB_COMMANDS: readonly WebCommand[] = [
  { command: "/jobs", about: "Recent jobs" },
  { command: "/spend", takes: "yesterday or YYYY-MM-DD", about: "What jobs cost today, or on another day" },
  { command: "/usage", takes: "yesterday, YYYY-MM-DD or job <id>", about: "Tokens and cache hits, for a day or one job" },
  { command: "/trace", needs: "<id>", about: "What one job's worker did, step by step" },
  { command: "/pending", about: "What is waiting for your approval" },
  { command: "/resume", about: "Rerun failed jobs and restart the queue, after a credit or key problem" },
  { command: "/status", about: "Which GitHub login is active and what it reaches" },
  { command: "/followups", about: "Who is waiting on you, and what you promised" },
  { command: "/uploads", about: "Files you have sent" },
  { command: "/delete upload", needs: "<name or all>", about: "Delete a file you sent" },
  { command: "/google", about: "Whether Google is connected" },
  { command: "/booking", takes: "link", about: "Your booking link for scheduling drafts: see it, or set it" },
  { command: "/board", about: "A link to the read-only jobs board" },
  { command: "/reports", about: "A link to your saved reports" },
  { command: "/reset", about: "Start a fresh conversation. Jobs and notes are kept" },
  { command: "/help", about: "Everything the chief understands" },
];

/** Why the files on a message were refused, in words for Paul. */
export class WebFilesError extends Error {}

/**
 * The files on a message from the app, as attachments the orchestrator saves like any other channel's
 * (src/uploads.ts: the private directory, sanitised names, the size cap, never executed). The app sends
 * each as `{ name, type, data }` with the bytes in base64; anything else is refused whole, so a message
 * never arrives with some of its files missing.
 */
export function webFiles(raw: unknown): Attachment[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new WebFilesError("The files could not be read.");
  if (raw.length > WEB_FILES_MAX) throw new WebFilesError(`At most ${WEB_FILES_MAX} files go with one message.`);
  let total = 0;
  return raw.map((f: unknown) => {
    const { name, type, data } = (f ?? {}) as { name?: unknown; type?: unknown; data?: unknown };
    if (typeof name !== "string" || !name.trim() || name.length > 200 || typeof data !== "string" || (type !== undefined && (typeof type !== "string" || type.length > 100))) throw new WebFilesError("The files could not be read.");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0) throw new WebFilesError("The files could not be read.");
    const bytes = Buffer.from(data, "base64");
    if (!bytes.length) throw new WebFilesError(`${name.trim()} is empty.`);
    total += bytes.length;
    if (total > WEB_FILES_BYTES) throw new WebFilesError(`Together the files are too large. The most one message can carry is ${Math.round(WEB_FILES_BYTES / (1024 * 1024))} MB.`);
    return {
      name: name.trim(),
      ...(typeof type === "string" && type ? { mimeType: type } : {}),
      size: bytes.length,
      // The bytes are already here: the route read them from Paul's own signed-in browser.
      download: async () => bytes,
    };
  });
}
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
  /** The names of the files Paul sent with it. The files themselves are in the uploads directory. */
  files?: string[];
  /** A picture the service sent with it (a design job's), by the name it is kept under in the app's own pictures folder. */
  picture?: string;
}

export interface WebChatOptions {
  /** The data directory; the transcript is kept under `app/` inside it. Absent: memory only. */
  dir?: string;
  now?: () => number;
}

export class WebChat {
  private messages: WebMessage[] = [];
  /** Paul's own chats, in the order they were opened. */
  private chats: OwnChat[] = [];
  private seq = 0;
  private typingUntil = new Map<string, number>();
  /** `threads()` as last worked out, until a message is added or removed. The board asks every few seconds. */
  private notes?: Map<string, { count: number; lastAt: string }>;
  private readonly file?: string;
  /** Where kept pictures live, beside the transcript. Absent (no data directory): they are held in memory. */
  private readonly pictures?: string;
  private readonly held = new Map<string, Buffer>();
  /** Whether the transcript on disk was read at start, or there was none to read. */
  private read = false;
  private readonly now: () => number;

  constructor(o: WebChatOptions = {}) {
    this.now = o.now ?? Date.now;
    this.file = o.dir ? path.join(o.dir, "app", "chat.json") : undefined;
    this.pictures = o.dir ? path.join(o.dir, "app", "pictures") : undefined;
    this.load();
    this.sweep();
  }

  private load(): void {
    if (!this.file) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8")) as { seq?: unknown; messages?: unknown; chats?: unknown };
      if (Array.isArray(saved.chats)) this.chats = (saved.chats as OwnChat[]).filter((c) => c && typeof c.id === "string" && WEB_OWN.test(`web:chat:${c.id}`) && typeof c.title === "string" && typeof c.createdAt === "string").slice(-WEB_CHATS_MAX);
      if (Array.isArray(saved.messages)) this.messages = (saved.messages as WebMessage[]).filter((m) => m && typeof m.id === "string" && typeof m.text === "string" && (m.from === "paul" || m.from === "clearops") && (m.thread === undefined || (typeof m.thread === "string" && WEB_THREAD.test(m.thread))) && (m.picture === undefined || (typeof m.picture === "string" && WEB_PICTURE.test(m.picture))));
      // A message in a chat that is no longer kept goes with it.
      this.messages = this.messages.filter((m) => !m.thread || !WEB_OWN.test(m.thread) || this.chats.some((c) => `web:chat:${c.id}` === m.thread));
      this.seq = typeof saved.seq === "number" ? saved.seq : this.messages.length;
      this.read = true;
    } catch (err) {
      // No transcript yet, or an unreadable one: start empty rather than stop the service.
      this.read = (err as NodeJS.ErrnoException)?.code === "ENOENT";
    }
  }

  /** The status line is of the moment and is never written down. */
  private save(): void {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ seq: this.seq, chats: this.chats, messages: this.messages.filter((m) => !m.live) }), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.warn(`The app's chat could not be saved: ${err instanceof Error ? err.message : "error"}`);
    }
  }

  /** The thread an address names, or undefined for the main conversation. Anything else of the app's is the main one. */
  private threadOf(to: string): string | undefined {
    if (!WEB_THREAD.test(to)) return undefined;
    // One of his own chats that is no longer kept: what was meant for it lands in the main conversation, not nowhere.
    if (WEB_OWN.test(to) && !this.chats.some((c) => `web:chat:${c.id}` === to)) return undefined;
    return to;
  }

  /* ---------- Paul's own chats ---------- */

  /**
   * Opens a chat of Paul's own, named from the words it starts with: the first line, tidied and cut
   * short. The id is made here, at random, and is the only way the chat is ever addressed. Past
   * WEB_CHATS_MAX the chat quiet for longest goes, with its messages and pictures.
   */
  open(firstWords: string): OwnChat {
    const line = redact(firstWords).split("\n").find((l) => l.trim())?.replace(/\s+/g, " ").trim() ?? "";
    const title = line.length > WEB_CHAT_TITLE_MAX ? `${line.slice(0, WEB_CHAT_TITLE_MAX - 1).trimEnd()}\u2026` : line || "New chat";
    let id = randomBytes(4).toString("hex");
    while (this.chats.some((c) => c.id === id)) id = randomBytes(4).toString("hex");
    const opened: OwnChat = { id, title, createdAt: new Date(this.now()).toISOString() };
    this.chats.push(opened);
    if (this.chats.length > WEB_CHATS_MAX) {
      const quiet = (c: OwnChat) => this.in(`web:chat:${c.id}`).at(-1)?.at ?? c.createdAt;
      const oldest = this.chats.filter((c) => c !== opened).sort((a, b) => quiet(a).localeCompare(quiet(b)))[0]!;
      this.chats = this.chats.filter((c) => c !== oldest);
      for (const m of this.in(`web:chat:${oldest.id}`)) if (m.picture) this.discard(m.picture);
      this.messages = this.messages.filter((m) => m.thread !== `web:chat:${oldest.id}`);
      this.notes = undefined;
    }
    this.save();
    return opened;
  }

  /** One of his own chats by its id, if it is still kept. */
  chat(id: string): OwnChat | undefined {
    return this.chats.find((c) => c.id === id);
  }

  /** His own chats for the app's list: the one spoken in most recently first. */
  ownChats(): Array<OwnChat & { count: number; lastAt: string }> {
    const notes = this.threads();
    return this.chats
      .map((c) => ({ ...c, count: notes.get(`web:chat:${c.id}`)?.count ?? 0, lastAt: notes.get(`web:chat:${c.id}`)?.lastAt ?? c.createdAt }))
      .sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  }

  private in(thread: string | undefined): WebMessage[] {
    return this.messages.filter((m) => m.thread === thread);
  }

  private add(from: WebMessage["from"], text: string, live = false, to: string = WEB_CONVERSATION, files: string[] = [], picture?: string): WebMessage {
    this.seq += 1;
    const thread = this.threadOf(to);
    const message: WebMessage = { id: String(this.seq), at: new Date(this.now()).toISOString(), from, text: redact(text), ...(live ? { live: true as const } : {}), ...(thread ? { thread } : {}), ...(files.length ? { files } : {}), ...(picture ? { picture } : {}) };
    this.messages.push(message);
    this.notes = undefined;
    this.trim(thread);
    if (!live) this.save();
    return message;
  }

  /** Each conversation keeps its newest messages, and only so many threads are kept at all. */
  private trim(thread: string | undefined): void {
    const before = this.messages;
    // One of his own chats is a conversation in full and keeps as much as the main one.
    const keep = thread && !WEB_OWN.test(thread) ? WEB_THREAD_KEEP : WEB_KEEP;
    const mine = this.in(thread);
    if (mine.length > keep) {
      const drop = new Set(mine.slice(0, mine.length - keep));
      this.messages = this.messages.filter((m) => !drop.has(m));
    }
    const last = new Map<string, number>();
    // Only job and pull request threads are counted here: his own chats have their own limit (`open`).
    this.messages.forEach((m, i) => m.thread && !WEB_OWN.test(m.thread) && last.set(m.thread, i));
    if (last.size > WEB_THREADS_MAX) {
      const gone = new Set([...last].sort((a, b) => a[1] - b[1]).slice(0, last.size - WEB_THREADS_MAX).map(([t]) => t));
      this.messages = this.messages.filter((m) => !m.thread || !gone.has(m.thread));
    }
    // A picture goes when the message it came with does.
    if (this.messages !== before) {
      const kept = new Set(this.messages);
      for (const m of before) if (m.picture && !kept.has(m)) this.discard(m.picture);
    }
  }

  private discard(name: string): void {
    this.held.delete(name);
    if (this.pictures) fs.rmSync(path.join(this.pictures, name), { force: true });
  }

  /** At start: anything in the pictures folder that no kept message shows is removed, so the folder cannot outgrow the transcript. */
  private sweep(): void {
    // Only when the transcript was read (or there is none yet): an unreadable one says nothing about what is still shown.
    if (!this.pictures || !this.read) return;
    try {
      const shown = new Set(this.messages.map((m) => m.picture));
      for (const name of fs.readdirSync(this.pictures)) if (!shown.has(name)) fs.rmSync(path.join(this.pictures, name), { force: true, recursive: false });
    } catch {
      // No folder yet, or one that cannot be read: nothing to tidy, and never a reason to stop the service.
    }
  }

  /**
   * One kept picture for the signed-in app: only a name of the one shape these have, and only while a
   * kept message shows it. Nothing else in the folder, and nothing outside it, can be asked for.
   */
  picture(name: string): { bytes: Buffer; type: "image/png" | "image/jpeg" } | undefined {
    if (!WEB_PICTURE.test(name) || !this.messages.some((m) => m.picture === name)) return undefined;
    let bytes = this.held.get(name);
    if (!bytes && this.pictures) {
      try {
        bytes = fs.readFileSync(path.join(this.pictures, name));
      } catch {
        return undefined;
      }
    }
    return bytes ? { bytes, type: name.endsWith(".png") ? "image/png" : "image/jpeg" } : undefined;
  }

  /** Paul's own message, from the app's route. */
  inbound(text: string, to: string = WEB_CONVERSATION, files: string[] = []): WebMessage {
    return this.add("paul", text, false, to, files.map((n) => redact(n).slice(0, 200)));
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

  /**
   * A picture the service shows Paul (a design job's own PNG or JPEG, chosen by src/design.ts). A copy is
   * kept in the app's own pictures folder, owner-only, under the message's number, and goes when that
   * message does. What it is is told from its bytes; a file that is not a PNG or JPEG, is too large or
   * cannot be read is not kept, and its caption still is, so nothing a job said is lost.
   */
  async sendImage(to: string, file: string, caption: string): Promise<void> {
    const name = this.keepPicture(file);
    if (name || caption) this.add("clearops", caption, false, to, [], name);
  }

  private keepPicture(file: string): string | undefined {
    try {
      if (fs.statSync(file).size > WEB_PICTURE_BYTES) return undefined;
      const bytes = fs.readFileSync(file);
      const kind = pictureKind(bytes);
      if (!kind) return undefined;
      // The number the message is about to be given (`add` takes the next one).
      const name = `${this.seq + 1}.${kind}`;
      if (this.pictures) {
        fs.mkdirSync(this.pictures, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(this.pictures, name), bytes, { mode: 0o600 });
      } else this.held.set(name, bytes);
      return name;
    } catch {
      return undefined;
    }
  }

  async recent(to: string, limit: number): Promise<Array<{ author: string; text: string }>> {
    return this.in(this.threadOf(to))
      .filter((m) => !m.live)
      .slice(-limit)
      .map((m) => ({ author: m.from === "paul" ? "Paul" : "ClearOps", text: m.text || (m.picture ? "(a picture)" : "") }));
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
