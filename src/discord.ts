import { ChannelType, Client, GatewayIntentBits, Partials, type Message, type TextBasedChannel } from "discord.js";
import { config } from "./config.js";
import { chunk, type Messenger } from "./whatsapp.js";
import type { HandleContext } from "./orchestrator.js";

/** Discord addresses: "dc:u:<user id>" for a person, "dc:c:<channel or thread id>" for a place. */
export const DC_USER = "dc:u:";
export const DC_CHANNEL = "dc:c:";
export const dcUser = (id: string) => `${DC_USER}${id}`;
export const dcChannel = (id: string) => `${DC_CHANNEL}${id}`;

const DISCORD_MAX = 1900; // Discord's limit is 2000 characters per message

/** Sends to a channel, thread or user through the Discord gateway client, and opens job threads. */
export class DiscordMessenger implements Messenger {
  /** Status messages that may still be edited or deleted, by handle (the message id). */
  private editable = new Map<string, { edit: (t: string) => Promise<unknown>; delete: () => Promise<unknown> }>();

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

  async send(to: string, text: string): Promise<void> {
    const target = await this.resolve(to);
    for (const part of chunk(text, DISCORD_MAX)) await target.send(part);
  }

  async openThread(replyTo: string, messageId: string, name: string): Promise<string | undefined> {
    if (!replyTo.startsWith(DC_CHANNEL)) return undefined;
    const channel = await this.client.channels.fetch(replyTo.slice(DC_CHANNEL.length));
    if (!channel || channel.type !== ChannelType.GuildText) return undefined; // already a thread, or a DM
    const message = await channel.messages.fetch(messageId);
    const thread = await message.startThread({ name: name.slice(0, 100), autoArchiveDuration: 1440 });
    return dcChannel(thread.id);
  }

  private async resolve(to: string): Promise<{ send: (text: string) => Promise<unknown> }> {
    if (to.startsWith(DC_USER)) {
      const user = await this.client.users.fetch(to.slice(DC_USER.length));
      return user;
    }
    const id = to.startsWith(DC_CHANNEL) ? to.slice(DC_CHANNEL.length) : to;
    const channel = await this.client.channels.fetch(id);
    if (!channel || !channel.isTextBased() || !("send" in channel)) throw new Error(`Discord channel ${id} cannot receive messages`);
    return channel as TextBasedChannel & { send: (text: string) => Promise<unknown> };
  }
}

/**
 * Listens on the Discord gateway (a WebSocket; no public URL needed). Every message from an
 * allowlisted user in a server channel, thread or DM goes to the handler. Replies go back to
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
  async onMessage(m: Pick<Message, "author" | "content" | "channelId" | "id"> & { channel?: { send?: (t: string) => Promise<unknown> } }): Promise<void> {
    if (m.author.bot || !m.content?.trim()) return;
    const from = dcUser(m.author.id);
    const replyTo = dcChannel(m.channelId);
    if (!this.isAllowed(from)) {
      if (!this.hinted.has(from)) {
        this.hinted.add(from);
        await m.channel?.send?.(`This bot only answers its operator. Your Discord user id is ${m.author.id}.`);
      }
      return;
    }
    await this.handle(from, m.content, { replyTo, messageId: m.id });
  }
}
