import type { Messenger } from "./whatsapp.js";

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

  async openThread(replyTo: string, messageId: string, name: string): Promise<string | undefined> {
    const m = this.pick(replyTo);
    return m.openThread ? m.openThread(replyTo, messageId, name) : undefined;
  }
}
