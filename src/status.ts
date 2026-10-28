import type { Messenger } from "./whatsapp.js";
import { validateTitle } from "./titles.js";

const clip = (s: unknown, max = 60): string => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};
const article = (word: string) => (/^[aeiou]/i.test(word) ? "an" : "a");
const KIND_WORDS: Record<string, string> = { create_agent: "agent-creator", maintain: "maintainer", analyse: "analysis" };

/**
 * A short, human status line for one of the chief's tool calls, shown to the founder while he waits.
 * Unknown tools get a generic line rather than their internal name.
 */
export function describeToolUse(name: string, input: Record<string, unknown> = {}): string {
  const id = typeof input.id === "string" && input.id ? input.id : undefined;
  switch (name.replace(/^mcp__ops__/, "")) {
    case "job_status":
      return id ? `Checking job ${id}…` : "Checking job status…";
    case "get_output":
      return id ? `Reading job ${id} output…` : "Reading job output…";
    case "start_job": {
      if (input.kind === "design" && input.continueLoop) return "Carrying on the design loop…";
      const checked = validateTitle(input.title);
      const titled = "title" in checked ? `: ${checked.title}` : "";
      if (input.kind === "design" && input.loop) return `Starting the design loop${titled}…`;
      const kind = KIND_WORDS[String(input.kind)] ?? String(input.kind ?? "worker");
      return `Starting ${article(kind)} ${kind} job${input.target === "self" ? " on the workforce" : ""}${titled}…`;
    }
    case "propose_action":
      return "Preparing an approval request…";
    case "schedule_job":
      return "Setting up a schedule…";
    case "list_schedules":
      return "Checking schedules…";
    case "cancel_schedule":
      return "Cancelling a schedule…";
    case "remember":
      return "Noting that for the future…";
    case "list_uploads":
      return "Checking your uploads…";
    case "delete_upload":
      return "Deleting an upload…";
    case "WebSearch":
      return input.query ? `Searching the web: ${clip(input.query)}…` : "Searching the web…";
    case "WebFetch": {
      try {
        return `Reading ${new URL(String(input.url)).hostname.replace(/^www\./, "")}…`;
      } catch {
        return "Reading a web page…";
      }
    }
    case "Read":
      return input.file_path ? `Reading ${clip(String(input.file_path).split("/").pop(), 40)}…` : "Reading a file…";
    case "Glob":
    case "Grep":
      return "Searching the code…";
    default:
      return "Working…";
  }
}

export interface LiveStatusOptions {
  /** How often to renew the typing indicator. Telegram's lasts about 5 seconds, Discord's about 10. */
  typingEveryMs?: number;
  /** Where neither a status message nor typing works (WhatsApp), send one "Working on it." after this long. */
  nudgeAfterMs?: number;
}

/**
 * What the founder sees while the chief works: a typing indicator, and one status message that is
 * edited in place as the chief calls tools, then deleted when the reply is ready. Every channel call
 * is best effort; a failure here never delays or breaks the reply. Channels that support neither
 * fall back to a single delayed "Working on it.".
 */
export class LiveStatus {
  private handle?: string;
  private shown?: string;
  private latest?: string;
  private editable: boolean;
  private typingWorks = false;
  private done = false;
  private chain: Promise<void> = Promise.resolve();
  private typingTimer?: NodeJS.Timeout;
  private nudgeTimer?: NodeJS.Timeout;

  constructor(
    private readonly messenger: Messenger,
    private readonly to: string,
    private readonly opts: LiveStatusOptions = {},
  ) {
    this.editable = Boolean(messenger.sendEditable && messenger.edit);
  }

  start(): this {
    if (this.messenger.typing) {
      void this.type();
      this.typingTimer = setInterval(() => void this.type(), this.opts.typingEveryMs ?? 4000);
    }
    this.nudgeTimer = setTimeout(() => {
      if (this.done || this.handle || this.typingWorks) return;
      void this.messenger.send(this.to, "Working on it.").catch(() => undefined);
    }, this.opts.nudgeAfterMs ?? 12_000);
    return this;
  }

  /** Show `text` as the current status. Rapid updates collapse: only the latest is sent. */
  update(text: string | undefined): void {
    if (!text || this.done || !this.editable) return;
    this.latest = text;
    this.chain = this.chain.then(() => this.flush()).catch(() => undefined);
  }

  /** Stop typing and remove the status message (or mark it done where deleting is unsupported). */
  async finish(): Promise<void> {
    this.done = true;
    clearInterval(this.typingTimer);
    clearTimeout(this.nudgeTimer);
    await this.chain;
    if (!this.handle) return;
    try {
      if (this.messenger.remove) await this.messenger.remove(this.to, this.handle);
      else await this.messenger.edit?.(this.to, this.handle, "Done.");
    } catch {
      // Best effort: a stale status line is harmless.
    }
  }

  private async type(): Promise<void> {
    try {
      if ((await this.messenger.typing?.(this.to)) === true) this.typingWorks = true;
    } catch {
      // Typing is a nicety; ignore failures.
    }
  }

  private async flush(): Promise<void> {
    const text = this.latest;
    if (this.done || !text || text === this.shown) return;
    if (!this.handle) {
      const handle = await this.messenger.sendEditable!(this.to, text);
      if (!handle) {
        // This conversation's channel cannot edit messages: stop trying rather than send a stream of new ones.
        this.editable = false;
        return;
      }
      this.handle = handle;
    } else {
      await this.messenger.edit!(this.to, this.handle, text);
    }
    this.shown = text;
  }
}
