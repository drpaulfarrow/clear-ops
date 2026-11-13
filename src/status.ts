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
/** " on the workforce", " on site": the repository a job is about, unless it is the product. */
function repoWords(repo: unknown): string {
  const r = typeof repo === "string" ? repo.trim().toLowerCase() : "";
  if (!r || r === "product") return "";
  return r === "self" ? " on the workforce" : ` on ${clip(r)}`;
}

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
      return `Starting ${article(kind)} ${kind} job${repoWords(input.repo ?? input.target)}${titled}…`;
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

/** The host of a URL without "www.", or undefined. */
function hostOf(url: unknown): string | undefined {
  try {
    return new URL(String(url)).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

/** What a shell command is doing, in a few plain words. */
function describeCommand(command: unknown): string {
  const c = String(command ?? "");
  if (/\bgh\s+pr\s+(create|new)\b/.test(c)) return "Opening the pull request";
  if (/\bgh\s+pr\s+merge\b/.test(c)) return "Merging the pull request";
  if (/\bgh\s+pr\s+(review|comment)\b/.test(c)) return "Writing the review";
  if (/\bgh\s+pr\b/.test(c)) return "Checking the pull request";
  if (/\bgit\s+push\b/.test(c)) return "Pushing the branch";
  if (/\bgit\s+commit\b/.test(c)) return "Committing";
  if (/\bgit\s+(diff|log|show|status)\b/.test(c)) return "Looking at the changes";
  if (/\bgit\b/.test(c)) return "Using git";
  if (/\b(npm|pnpm|yarn)\s+(run\s+)?test\b|\b(vitest|jest|mocha)\b/.test(c)) return "Running the tests";
  if (/\b(npm|pnpm|yarn)\s+run\s+build\b|\btsc\b/.test(c)) return "Typechecking";
  if (/\b(npm|pnpm|yarn)\s+(ci|install|i)\b/.test(c)) return "Installing packages";
  if (/\b(curl|wget)\b/.test(c)) return "Fetching something";
  return "Running a command";
}

/**
 * What a worker is doing, for the progress line in its job's thread: one short plain phrase per tool
 * call. Never shows a command, an argument or a query beyond a short clip of what is searched for or read.
 */
export function describeWorkerTool(name: string, input: Record<string, unknown> = {}): string {
  const bare = name.startsWith("mcp__") ? (name.split("__").pop() ?? name) : name;
  const file = (p: unknown) => clip(String(p ?? "").split("/").pop(), 40);
  switch (bare) {
    case "Read":
      return input.file_path ? `Reading ${file(input.file_path)}` : "Reading a file";
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return input.file_path ? `Editing ${file(input.file_path)}` : "Editing a file";
    case "Write":
      return input.file_path ? `Writing ${file(input.file_path)}` : "Writing a file";
    case "Glob":
    case "Grep":
      return "Searching the code";
    case "Bash":
      return describeCommand(input.command);
    case "WebSearch":
    case "web_search":
    case "exa_search":
      return input.query ? `Searching the web: ${clip(input.query, 50)}` : "Searching the web";
    case "WebFetch":
    case "open":
      return hostOf(input.url) ? `Reading ${hostOf(input.url)}` : "Reading a web page";
    case "read":
    case "click":
    case "type":
    case "back":
      return "Using the browser";
    case "sign_in":
      return "Signing in";
    case "TodoWrite":
      return "Planning the work";
    case "Task":
    case "Agent":
      return "Handing part of it to a helper";
    case "screenshot":
      return "Taking screenshots";
    case "save_asset":
    case "save_cv_file":
    case "save_deck_file":
      return "Saving a file";
    default:
      return "Working";
  }
}

export interface JobProgressOptions {
  /** Nothing is shown until the job has run this long, so short jobs stay quiet. */
  firstAfterMs?: number;
  /** How often the line may be edited. */
  everyMs?: number;
  now?: () => number;
}

/** "45 seconds", "12 minutes", "1 hour 5 minutes". */
function elapsedWords(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return `${Math.max(1, Math.round(ms / 1000))} seconds`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  const mins = `${rest} minute${rest === 1 ? "" : "s"}`;
  if (!h) return mins;
  return `${h} hour${h === 1 ? "" : "s"}${rest ? ` ${mins}` : ""}`;
}

/**
 * The running commentary in a job's thread: once a job has run a minute, one message that is edited in
 * place with what the worker is doing and how long it has been going, removed when the job ends. Only
 * where the channel can edit messages (Discord, Telegram); elsewhere nothing is sent. Best effort: a
 * failure here never touches the job.
 */
export class JobProgress {
  private handle?: string;
  private shown?: string;
  private latest?: string;
  private done = false;
  private editable: boolean;
  private timer?: NodeJS.Timeout;
  private chain: Promise<void> = Promise.resolve();
  private readonly started: number;
  private readonly now: () => number;

  constructor(
    private readonly messenger: Messenger,
    private readonly to: string,
    private readonly opts: JobProgressOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.started = this.now();
    this.editable = Boolean(messenger.sendEditable && messenger.edit);
  }

  start(): this {
    if (!this.editable) return this;
    this.timer = setInterval(() => this.tick(), this.opts.everyMs ?? 20_000);
    this.timer.unref?.();
    return this;
  }

  /** The worker's latest step. Shown at the next tick. */
  note(text: string): void {
    if (text) this.latest = text;
  }

  /** The text the line would show now (exported behaviour for tests). */
  text(): string | undefined {
    if (!this.latest) return undefined;
    return `Working, ${elapsedWords(this.now() - this.started)} in: ${this.latest}…`;
  }

  tick(): void {
    if (this.done || !this.editable) return;
    if (this.now() - this.started < (this.opts.firstAfterMs ?? 60_000)) return;
    this.chain = this.chain.then(() => this.flush()).catch(() => undefined);
  }

  async finish(): Promise<void> {
    if (this.done) return;
    this.done = true;
    clearInterval(this.timer);
    await this.chain;
    if (!this.handle) return;
    try {
      if (this.messenger.remove) await this.messenger.remove(this.to, this.handle);
      else await this.messenger.edit?.(this.to, this.handle, "Finished working.");
    } catch {
      // A stale progress line is harmless.
    }
  }

  private async flush(): Promise<void> {
    const text = this.text();
    if (this.done || !text || text === this.shown) return;
    if (!this.handle) {
      const handle = await this.messenger.sendEditable!(this.to, text);
      if (!handle) {
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
