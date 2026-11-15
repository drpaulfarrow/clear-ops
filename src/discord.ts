import { ChannelType, Client, GatewayIntentBits, PermissionFlagsBits, Partials, ThreadAutoArchiveDuration, type Message, type TextBasedChannel } from "discord.js";
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

  /**
   * Paul's own message, deleted after the service took a one-time code out of it. Best effort: if the
   * bot may not manage that message, or it is too old for Discord to delete, his message stays.
   */
  async deleteInbound(to: string, messageId: string): Promise<void> {
    const target = (await this.resolve(to)) as unknown as { messages?: { fetch(id: string): Promise<{ delete(): Promise<unknown> }> } };
    const msg = await target.messages?.fetch(messageId);
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

  /** The last `limit` messages of a channel or thread, oldest first. */
  async recent(to: string, limit: number): Promise<Array<{ author: string; text: string }>> {
    if (!to.startsWith(DC_CHANNEL)) return [];
    const channel = await this.client.channels.fetch(to.slice(DC_CHANNEL.length));
    if (!channel || !channel.isTextBased() || !("messages" in channel)) return [];
    const fetched = await channel.messages.fetch({ limit });
    return [...fetched.values()]
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .map((m) => ({ author: m.author?.bot ? "Clear Ops" : "Paul", text: m.content ?? "" }))
      .filter((m) => m.text.trim());
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
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
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
      channel?: { send?: (t: string) => Promise<unknown>; type?: ChannelType };
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
    await this.handle(from, m.content ?? "", { replyTo, messageId: m.id, ...(m.channel?.type === ChannelType.DM ? { direct: true } : {}), ...(files.length ? { attachments: files.map((f) => discordAttachment(f)) } : {}) });
  }
}

/** What `inspectGuilds` needs from the gateway client, so a test can use a plain object. */
export interface GuildView {
  id: string;
  name: string;
  ownerId: string;
  members: { me?: { permissions: { has(p: bigint): boolean } } | null; fetch(id: string): Promise<{ permissions: { has(p: bigint): boolean } }> };
  channels: { cache: Iterable<{ id: string; name: string; type: number; parentId: string | null }> | { values(): Iterable<{ id: string; name: string; type: number; parentId: string | null }> } };
}

/**
 * Read-only look at where the bot is, for the Instinct bridge: guild names and ids, channel and category names,
 * whether the bot may manage channels, and whether the owner is the guild owner or an administrator. No
 * messages, no token, no member lists, nothing written.
 */
/** discord.js caches are Maps, whose plain iteration yields [id, value] pairs; take the values. A plain array or set works too. */
function cacheValues<T>(cache: Iterable<T> | { values(): Iterable<T> }): T[] {
  const withValues = cache as { values?: () => Iterable<T> };
  return [...(typeof withValues.values === "function" ? withValues.values() : (cache as Iterable<T>))];
}

export async function inspectGuilds(client: { guilds: { cache: Iterable<GuildView> | { values(): Iterable<GuildView> } } }, ownerUserId: string) {
  const out = [];
  for (const g of cacheValues(client.guilds.cache)) {
    let ownerIsAdmin: boolean | null = null;
    try {
      ownerIsAdmin = (await g.members.fetch(ownerUserId)).permissions.has(PermissionFlagsBits.Administrator);
    } catch {
      ownerIsAdmin = null; // not a member, or Discord would not say
    }
    const chans = cacheValues(g.channels.cache).map((c) => ({ id: c.id, name: c.name, kind: c.type === ChannelType.GuildCategory ? "category" : c.type === ChannelType.GuildText ? "text" : "other", parentId: c.parentId }));
    out.push({
      id: g.id,
      name: g.name,
      ownerIsOwner: g.ownerId === ownerUserId,
      ownerIsAdministrator: ownerIsAdmin,
      botCanManageChannels: g.members.me?.permissions.has(PermissionFlagsBits.ManageChannels) ?? null,
      channels: chans,
    });
  }
  return { guilds: out };
}

/** What `readOwnerDm` needs from the gateway client, so a test can use a plain object. */
export interface DmView {
  users: { fetch(id: string): Promise<{ createDM(): Promise<{ messages: { fetch(o: { limit: number; before?: string }): Promise<{ values(): Iterable<{ id: string; createdTimestamp: number; content?: string | null; author?: { id: string; bot?: boolean } | null; attachments?: { size: number } | null }> }> } }> }> };
}

/**
 * Read-only look at the bot's own direct-message channel with the owner, for the Instinct bridge. The channel
 * is always the owner's DM (the owner id comes from the service's configuration, never from the request), so
 * no guild, server channel or other person can be reached. Text only (attachments are counted, not fetched),
 * oldest first, one page at a time. Nothing is sent, written or marked read.
 */
export async function readOwnerDm(client: DmView, ownerUserId: string, limit: number, before?: string) {
  const dm = await (await client.users.fetch(ownerUserId)).createDM();
  const fetched = await dm.messages.fetch({ limit, ...(before ? { before } : {}) });
  const rows = [...fetched.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  return {
    messages: rows.map((m) => ({
      id: m.id,
      at: new Date(m.createdTimestamp).toISOString(),
      from: m.author?.id === ownerUserId ? "Paul" : m.author?.bot ? "Clear Ops" : "other",
      text: m.content ?? "",
      attachments: m.attachments?.size ?? 0,
    })),
    ...(rows.length >= limit && rows[0] ? { nextBefore: rows[0].id } : {}),
  };
}

/** What `readJobThread` needs from the gateway client, so a test can use a plain object. */
export interface ThreadReadView {
  channels: { fetch(id: string): Promise<{ id: string; guildId?: string | null; parentId?: string | null; isThread?: () => boolean; messages?: { fetch(o: { limit: number; before?: string }): Promise<{ values(): Iterable<{ id: string; createdTimestamp: number; content?: string | null; author?: { id: string } | null; attachments?: { size: number } }> }> } } | null> };
}

/**
 * Read-only look at ONE job thread, for the Instinct bridge. The thread id comes from the service's own job record
 * (never from the request). It must be a thread inside the one configured guild whose parent is the one configured
 * text channel, or nothing is read. Only the owner's messages and this bot's own are returned with text; any other
 * author is counted and never read out. If Discord will not show the thread (for example it is archived) the result
 * says so and nothing is worked around. Nothing is sent, written, unarchived or marked read.
 */
export async function readJobThread(client: ThreadReadView, bind: { ownerUserId: string; botUserId: string; guildId: string; parentId: string }, threadId: string, limit: number, before?: string) {
  if (!bind.ownerUserId || !bind.botUserId || !bind.guildId || !bind.parentId || !/^\d{15,25}$/.test(threadId)) return undefined;
  let channel;
  try { channel = await client.channels.fetch(threadId); } catch { return { readable: false as const, reason: "Discord would not show this thread to the bot." }; }
  if (!channel || channel.id !== threadId || !(channel.isThread?.() ?? false) || channel.guildId !== bind.guildId || channel.parentId !== bind.parentId || !channel.messages) return undefined;
  let fetched;
  try { fetched = await channel.messages.fetch({ limit, ...(before ? { before } : {}) }); } catch { return { readable: false as const, reason: "The thread's messages could not be read (it may be archived or hidden from the bot)." }; }
  const rows = [...fetched.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  let otherAuthorMessages = 0;
  const messages: Array<{ id: string; at: string; from: "Paul" | "Clear Ops"; text: string; attachments: number }> = [];
  for (const m of rows) {
    const id = m.author?.id;
    if (id === bind.ownerUserId) messages.push({ id: m.id, at: new Date(m.createdTimestamp).toISOString(), from: "Paul", text: m.content ?? "", attachments: m.attachments?.size ?? 0 });
    else if (id === bind.botUserId) messages.push({ id: m.id, at: new Date(m.createdTimestamp).toISOString(), from: "Clear Ops", text: m.content ?? "", attachments: m.attachments?.size ?? 0 });
    else otherAuthorMessages++;
  }
  return { readable: true as const, messages, otherAuthorMessages, ...(rows.length >= limit && rows[0] ? { nextBefore: rows[0].id } : {}) };
}

/** The one Discord user the owner-only reads may target. More than one `dc:u:` entry is ambiguous, so none is chosen. */
export function soleDiscordOwner(senderIds: readonly string[]): string | undefined {
  const ids = [...new Set(senderIds.filter((x) => x.startsWith("dc:u:")).map((x) => x.slice(5)))];
  return ids.length === 1 && /^\d{15,25}$/.test(ids[0]!) ? ids[0] : undefined;
}
