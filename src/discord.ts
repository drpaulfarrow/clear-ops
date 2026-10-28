import { ChannelType, Client, GatewayIntentBits, Partials, ThreadAutoArchiveDuration, type Message, type TextBasedChannel } from "discord.js";
import { config } from "./config.js";
import { chunk, type Messenger } from "./whatsapp.js";
import type { HandleContext } from "./orchestrator.js";
import { fetchCapped, UploadError, type Attachment } from "./uploads.js";

/** Discord addresses: "dc:u:<user id>" for a person, "dc:c:<channel or thread id>" for a place. */
export const DC_USER = "dc:u:";
export const DC_CHANNEL = "dc:c:";
export const dcUser = (id: string) => `${DC_USER}${id}`;
export const dcChannel = (id: string) => `${DC_CHANNEL}${id}`;

const DISCORD_MAX = 1900; // Discord's limit is 2000 characters per message

/**
 * How long a quiet job thread stays in the channel's thread list. A day hid threads Paul still
 * needed (a queued engineering job, a review the next morning, a design loop waiting on a deploy),
 * so a week. An archived thread is still reachable, and posting to it reopens it.
 */
export const JOB_THREAD_ARCHIVE_MINUTES = ThreadAutoArchiveDuration.OneWeek;
/** How many message ids we remember as already carrying a job thread. */
const CLAIMED_MAX = 500;

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The fields of a Discord attachment we use. */
export interface DiscordFile {
  name: string;
  contentType?: string | null;
  size: number;
  url: string;
}

/** Discord serves attachments from its own CDN only; anything else is refused. */
const DISCORD_CDN = /^https:\/\/(cdn\.discordapp\.com|media\.discordapp\.net)\//i;

/** A Discord attachment that downloads only when asked (after the allowlist check), from Discord's CDN only. */
export function discordAttachment(f: DiscordFile, fetchImpl: typeof fetch = fetch): Attachment {
  return {
    name: f.name,
    mimeType: f.contentType ?? undefined,
    size: f.size,
    async download(maxBytes: number) {
      if (!DISCORD_CDN.test(f.url)) throw new UploadError("refused a download from outside Discord");
      return fetchCapped(f.url, maxBytes, fetchImpl);
    },
  };
}

/** The parts of a channel that opening a job thread uses (a text channel, or a thread inside one). */
interface ThreadHome {
  type: ChannelType;
  isThread?: () => boolean;
  parent?: ThreadHome | null;
  messages: { fetch(id: string): Promise<{ hasThread: boolean; startThread(o: { name: string; autoArchiveDuration: ThreadAutoArchiveDuration; reason?: string }): Promise<{ id: string }> }> };
  threads: { create(o: { name: string; autoArchiveDuration: ThreadAutoArchiveDuration; type: ChannelType.PublicThread; reason?: string }): Promise<{ id: string }> };
}

/** Sends to a channel, thread or user through the Discord gateway client, and opens job threads. */
export class DiscordMessenger implements Messenger {
  /** Status messages that may still be edited or deleted, by handle (the message id). */
  private editable = new Map<string, { edit: (t: string) => Promise<unknown>; delete: () => Promise<unknown> }>();

  /** Message ids that already carry a job thread. */
  private claimed = new Set<string>();

  constructor(private readonly client: Client) {}

  async sendEditable(to: string, text: string): Promise<string | undefined> {
    const target = await this.resolve(to);
    const msg = (await target.send(text.slice(0, DISCORD_MAX))) as { id?: string; edit?: (t: string) => Promise<unknown>; delete?: () => Promise<unknown> };
    if (!msg?.id || !msg.edit || !msg.delete) return undefined;
    this.editable.set(msg.id, msg as { edit: (t: string) => Promise<unknown>; delete: () => Promise<unknown> });
    return msg.id;
  }

  async edit(_to: string, handle: string, text: string): Promise<void> {
    await this.editable.get(handle)?.edit(text.slice(0, DISCORD_MAX));
  }

  async remove(_to: string, handle: string): Promise<void> {
    const msg = this.editable.get(handle);
    this.editable.delete(handle);
    await msg?.delete();
  }

  /** Discord shows "is typing…" for about ten seconds per call. */
  async typing(to: string): Promise<boolean> {
    if (to.startsWith(DC_USER)) {
      const user = await this.client.users.fetch(to.slice(DC_USER.length));
      await (await user.createDM()).sendTyping();
      return true;
    }
    const channel = await this.client.channels.fetch(to.startsWith(DC_CHANNEL) ? to.slice(DC_CHANNEL.length) : to);
    if (!channel || !("sendTyping" in channel)) return false;
    await channel.sendTyping();
    return true;
  }

  /** An image attachment with the caption as the message text. */
  async sendImage(to: string, file: string, caption: string): Promise<void> {
    const target = (await this.resolve(to)) as unknown as { send: (m: { content?: string; files: string[] }) => Promise<unknown> };
    await target.send({ content: caption.slice(0, DISCORD_MAX) || undefined, files: [file] });
  }

  async send(to: string, text: string): Promise<void> {
    const target = await this.resolve(to);
    for (const part of chunk(text, DISCORD_MAX)) await target.send(part);
  }

  /**
   * Opens a thread for one job and returns its address, or undefined where Discord has no threads
   * (DMs, group DMs, forum or voice channels). Discord allows one thread per message, so only the
   * first job started from a message gets a thread under it; every other job (a batch from one
   * message, a message that already has a thread, a job started from inside a thread) gets a
   * standalone thread in the text channel, named after the job. Failures to thread under the
   * message are logged and fall back to a standalone thread; failure to open any thread throws.
   */
  async openThread(replyTo: string, messageId: string | undefined, name: string): Promise<string | undefined> {
    if (!replyTo.startsWith(DC_CHANNEL)) return undefined;
    const channel = (await this.client.channels.fetch(replyTo.slice(DC_CHANNEL.length))) as ThreadHome | null;
    if (!channel) return undefined;
    const fromThread = channel.isThread?.() ?? false;
    const home = fromThread ? channel.parent : channel;
    if (!home || home.type !== ChannelType.GuildText) return undefined; // a DM, or a thread under a forum or announcement channel
    const threadName = name.trim().slice(0, 100) || "Job";
    if (!fromThread && messageId && !this.claimed.has(messageId)) {
      this.claim(messageId);
      try {
        const message = await home.messages.fetch(messageId);
        if (!message.hasThread) {
          const thread = await message.startThread({ name: threadName, autoArchiveDuration: JOB_THREAD_ARCHIVE_MINUTES, reason: "Clear Ops job" });
          return dcChannel(thread.id);
        }
      } catch (err) {
        console.warn(`discord: could not open "${threadName}" under message ${messageId}, opening a standalone thread instead: ${errText(err)}`);
      }
    }
    const thread = await home.threads.create({ name: threadName, autoArchiveDuration: JOB_THREAD_ARCHIVE_MINUTES, type: ChannelType.PublicThread, reason: "Clear Ops job" });
    return dcChannel(thread.id);
  }

  /** Remembers a message as taken (before any await, so parallel start_job calls cannot both use it). */
  private claim(messageId: string): void {
    this.claimed.add(messageId);
    if (this.claimed.size > CLAIMED_MAX) this.claimed.delete(this.claimed.values().next().value as string);
  }

  private async resolve(to: string): Promise<{ send: (text: string) => Promise<unknown> }> {
    if (to.startsWith(DC_USER)) {
      const user = await this.client.users.fetch(to.slice(DC_USER.length));
      return user;
    }
    const id = to.startsWith(DC_CHANNEL) ? to.slice(DC_CHANNEL.length) : to;
    const channel = await this.client.channels.fetch(id);
    if (!channel || !channel.isTextBased() || !("send" in channel)) throw new Error(`Discord channel ${id} cannot receive messages`);
    // A job thread that went quiet for a week is archived; reopen it so its next report lands there.
    if (channel.isThread() && channel.archived && !channel.locked) {
      await channel.setArchived(false, "Clear Ops job report").catch((err) => console.warn(`discord: could not reopen thread ${id}: ${errText(err)}`));
    }
    return channel as TextBasedChannel & { send: (text: string) => Promise<unknown> };
  }
}

/**
 * Listens on the Discord gateway (a WebSocket; no public URL needed). Every message from an
 * allowlisted user in a server channel, thread or DM goes to the handler, with any attached files. Replies go back to
 * the same place, so a thread is its own conversation.
 */
export class DiscordListener {
  readonly client: Client;
  private hinted = new Set<string>();

  constructor(
    private readonly handle: (from: string, text: string, ctx: HandleContext) => Promise<void>,
    private readonly isAllowed: (from: string) => boolean,
  ) {
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
      partials: [Partials.Channel], // needed to receive DMs
    });
  }

  messenger(): DiscordMessenger {
    return new DiscordMessenger(this.client);
  }

  async start(): Promise<void> {
    this.client.on("messageCreate", (m) => void this.onMessage(m));
    this.client.once("clientReady", () => console.log(`discord: signed in as ${this.client.user?.tag}`));
    await this.client.login(config.discord.token);
  }

  stop(): void {
    void this.client.destroy();
  }

  /** Exposed for tests: route one message without the gateway. */
  async onMessage(
    m: Pick<Message, "author" | "content" | "channelId" | "id"> & {
      channel?: { send?: (t: string) => Promise<unknown> };
      attachments?: { values(): Iterable<DiscordFile> };
    },
  ): Promise<void> {
    const files = m.attachments ? [...m.attachments.values()] : [];
    if (m.author.bot || (!m.content?.trim() && !files.length)) return;
    const from = dcUser(m.author.id);
    const replyTo = dcChannel(m.channelId);
    if (!this.isAllowed(from)) {
      if (!this.hinted.has(from)) {
        this.hinted.add(from);
        await m.channel?.send?.(`This bot only answers its operator. Your Discord user id is ${m.author.id}.`);
      }
      return;
    }
    await this.handle(from, m.content ?? "", { replyTo, messageId: m.id, ...(files.length ? { attachments: files.map((f) => discordAttachment(f)) } : {}) });
  }
}
