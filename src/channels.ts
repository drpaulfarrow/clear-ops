import type { Messenger } from "./whatsapp.js";

/** How to point Paul at a conversation in chat: a clickable mention for a Discord channel or thread, else undefined. */
export function threadMention(address: string): string | undefined {
  const id = address.match(/^dc:c:(\d+)$/)?.[1];
  return id ? `<#${id}>` : undefined;
}

/**
 * One messenger that routes by address prefix, so the orchestrator never knows which channel a
 * conversation lives on. "tg:" goes to Telegram, "dc:" to Discord, anything else to WhatsApp.
 */
export class RouterMessenger implements Messenger {
  constructor(private readonly routes: Array<{ prefix: string; messenger: Messenger }>, private readonly fallback?: Messenger) {}

  private pick(to: string): Messenger {
    const r = this.routes.find((x) => to.startsWith(x.prefix));
    if (r) return r.messenger;
    if (this.fallback) return this.fallback;
    throw new Error(`No channel can deliver to ${to}`);
  }

  async send(to: string, text: string): Promise<void> {
    await this.pick(to).send(to, text);
  }

  async openThread(replyTo: string, messageId: string | undefined, name: string): Promise<string | undefined> {
    const m = this.pick(replyTo);
    return m.openThread ? m.openThread(replyTo, messageId, name) : undefined;
  }

  async sendEditable(to: string, text: string): Promise<string | undefined> {
    const m = this.pick(to);
    return m.sendEditable && m.edit ? m.sendEditable(to, text) : undefined;
  }

  async edit(to: string, handle: string, text: string): Promise<void> {
    await this.pick(to).edit?.(to, handle, text);
  }

  async remove(to: string, handle: string): Promise<void> {
    const m = this.pick(to);
    if (m.remove) await m.remove(to, handle);
    else await m.edit?.(to, handle, "Done.");
  }

  /** Images go where the channel carries them; elsewhere the caption is sent as text so nothing is lost. */
  async sendImage(to: string, file: string, caption: string): Promise<void> {
    const m = this.pick(to);
    if (m.sendImage) await m.sendImage(to, file, caption);
    else if (caption) await m.send(to, caption);
  }

  async typing(to: string): Promise<boolean> {
    const m = this.pick(to);
    return m.typing ? m.typing(to) : false;
  }

  async recent(to: string, limit: number): Promise<Array<{ author: string; text: string }>> {
    const m = this.pick(to);
    return m.recent ? m.recent(to, limit) : [];
  }
}
