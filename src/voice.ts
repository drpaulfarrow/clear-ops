import { timingSafeEqual } from "node:crypto";
import type express from "express";
import { config } from "./config.js";
import { resolveModel } from "./llm.js";
import type { Messenger } from "./whatsapp.js";

/**
 * Live voice, the Fly half. Paul talks in a Discord voice channel; src/voice-bridge.ts carries the
 * audio to the voice GPU on Modal (voice/), where Kyutai's Unmute turns speech into text, decides
 * when he has finished, and calls back here, to the voice brain, for what to say. The brain is a
 * fast OpenRouter model with one tool, ask_clearops, which hands the request to the chief exactly as
 * if Paul had typed it in the voice channel's chat, waits a little for the chief's reply and says it.
 *
 * What a spoken request can never do: approve anything. It reaches the chief prefixed "Voice request
 * from Paul", so no approval command (send, dns apply, yes <id>, buy) can match it, and the brain
 * tells Paul to type approvals in chat. Only the allowlisted speaker's audio is ever listened to.
 */

/** The prefix every spoken request carries to the chief. Approval commands are anchored at the start, so none can match. */
export const VOICE_PREFIX = "Voice request from Paul (spoken and transcribed, so names and numbers may be misheard):";

export function voiceRequestText(request: string): string {
  return `${VOICE_PREFIX} ${request.replace(/\s+/g, " ").trim()}`;
}

export function voiceEnabled(): boolean {
  return config.voice.enabled && !!config.voice.key && !!config.voice.gatewayUrl && !!config.openrouter.apiKey;
}

/** Bearer check in constant time; no key configured lets nobody in. */
export function voiceAuthorised(header: string | undefined, key = config.voice.key): boolean {
  if (!key || !header?.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------------------------
// Catching the chief's replies to the voice channel, so they can be spoken.

interface Waiter {
  resolve: (text: string | undefined) => void;
}

/**
 * Watches what the service sends to one conversation address. The next message after a spoken
 * request goes to whoever is waiting for it; anything else (a late answer, a job report) is kept as
 * news for the brain to pass on at the next pause. Chat delivery is unchanged either way.
 */
export class VoiceTap {
  private waiters = new Map<string, Waiter[]>();
  private news = new Map<string, Array<{ text: string; at: number }>>();
  private watching = new Set<string>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Wraps a messenger so every send also reaches the tap. Everything else passes straight through. */
  wrap<T extends Messenger>(m: T): T {
    const tap = this;
    return new Proxy(m, {
      get(target, prop, receiver) {
        if (prop === "send") {
          return async (to: string, text: string) => {
            await target.send(to, text);
            tap.saw(to, text);
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  }

  watch(address: string): void {
    this.watching.add(address);
  }

  unwatch(address: string): void {
    this.watching.delete(address);
    this.news.delete(address);
    for (const w of this.waiters.get(address) ?? []) w.resolve(undefined);
    this.waiters.delete(address);
  }

  saw(to: string, text: string): void {
    if (!this.watching.has(to)) return;
    const queue = this.waiters.get(to);
    const first = queue?.shift();
    if (first) return first.resolve(text);
    const list = this.news.get(to) ?? [];
    list.push({ text, at: this.now() });
    this.news.set(to, list.slice(-5));
  }

  /** The next message to `address`, or undefined after `ms`. Register before sending the request. */
  next(address: string, ms: number): Promise<string | undefined> {
    return new Promise((resolve) => {
      const waiter: Waiter = {
        resolve: (t) => {
          clearTimeout(timer);
          resolve(t);
        },
      };
      const timer = setTimeout(() => {
        const q = this.waiters.get(address) ?? [];
        this.waiters.set(address, q.filter((w) => w !== waiter));
        resolve(undefined);
      }, ms);
      const q = this.waiters.get(address) ?? [];
      q.push(waiter);
      this.waiters.set(address, q);
    });
  }

  /** News from the last 30 minutes, removed once taken. */
  takeNews(address: string): string[] {
    const cutoff = this.now() - 30 * 60_000;
    const list = (this.news.get(address) ?? []).filter((n) => n.at >= cutoff).map((n) => n.text);
    this.news.delete(address);
    return list;
  }
}

// ---------------------------------------------------------------------------------------------
// The voice brain: an OpenAI-compatible chat endpoint that Unmute calls.

export interface VoiceSession {
  /** Where chat replies go and the conversation key: the voice channel's own text chat. */
  address: string;
  /** Who is speaking, an allowlisted Discord user address. */
  sender: string;
}

type ChatMessage = { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string };
interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export const VOICE_SYSTEM = `You are Cleo, the voice of ClearOps, Paul's agentic workforce. You are his chief of staff, talking with him by voice in a Discord voice channel. Your name is Cleo; if he asks who you are, you are Cleo. Everything you write is spoken aloud by a text-to-speech voice.

How to speak: plain spoken sentences only. No lists, markdown, headings, links, URLs, emojis, code or symbols. One to three short sentences unless he asks for more. British English. Never use em dashes. Say numbers the way a person would.

What you can do: you speak for the ClearOps workforce, which has research, writing, engineering, an email and calendar assistant, design and more. You cannot see his jobs, email, calendar, files or repositories yourself. For anything that needs ClearOps to look something up, start or check work, remember something, or act, call ask_clearops with his request in his own words plus any context from the conversation it needs. ClearOps's answer comes back to you; tell him the gist in a sentence or two, without links or ids unless he asks. Quick general questions and small talk you can answer yourself.

Never say something was done unless ask_clearops said so. You cannot approve anything: sending an email or invitation, a DNS change or a purchase is approved only by Paul typing the command in the Discord chat, so if he asks you to approve one, tell him that.

A user message of "..." means he has gone quiet. Then say nothing at all, unless there is news from ClearOps below, in which case pass it on in a sentence.`;

const ASK_TOOL = {
  type: "function",
  function: {
    name: "ask_clearops",
    description: "Hand Paul's request to the ClearOps chief of staff, who can start and check jobs, read his mail and calendar through the assistant, search, and remember things. Returns its answer.",
    parameters: {
      type: "object",
      properties: { request: { type: "string", description: "What Paul wants, in his words, with any context ClearOps needs." } },
      required: ["request"],
    },
  },
} as const;

export interface VoiceBrainDeps {
  /** Hands a request to the chief as if Paul had typed it in `session.address`. */
  ask: (sender: string, address: string, text: string) => Promise<void>;
  tap: VoiceTap;
  fetch?: typeof fetch;
  /** Seconds to wait for the chief before saying the answer will come in chat. */
  answerWaitMs?: number;
}

/** One OpenAI-style SSE chunk of text. */
function sseChunk(id: string, content: string | null, finish: string | null = null): string {
  const delta = content === null ? {} : { content };
  return `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "clearops-voice", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

/** Strips what a voice must not say aloud: links, markdown, ids in code marks. */
export function speakable(text: string): string {
  return text
    .replace(/<#\d+>/g, "the chat")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "the link in chat")
    .replace(/[`*_#>]+/g, "")
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
}

export class VoiceBrain {
  private session: VoiceSession | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly deps: VoiceBrainDeps) {
    this.fetchImpl = deps.fetch ?? fetch;
  }

  setSession(s: VoiceSession | undefined): void {
    if (this.session && this.session.address !== s?.address) this.deps.tap.unwatch(this.session.address);
    this.session = s;
    if (s) this.deps.tap.watch(s.address);
  }

  current(): VoiceSession | undefined {
    return this.session;
  }

  /** Mounts GET /voice/v1/models and POST /voice/v1/chat/completions. */
  mount(app: express.Express): void {
    const guard = (req: express.Request, res: express.Response): boolean => {
      if (voiceAuthorised(req.get("authorization"))) return true;
      res.status(401).json({ error: { message: "unauthorised" } });
      return false;
    };
    app.get("/voice/v1/models", (req, res) => {
      if (!guard(req, res)) return;
      res.json({ object: "list", data: [{ id: "clearops-voice", object: "model", owned_by: "clear-ops" }] });
    });
    app.post("/voice/v1/chat/completions", async (req, res) => {
      if (!guard(req, res)) return;
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-store");
      res.flushHeaders?.();
      const id = `chatcmpl-${Date.now().toString(36)}`;
      const write = (t: string) => res.write(sseChunk(id, t));
      const aborted = new AbortController();
      res.on("close", () => aborted.abort());
      try {
        await this.reply((req.body?.messages ?? []) as ChatMessage[], write, aborted.signal);
      } catch (err) {
        if (!aborted.signal.aborted) {
          console.warn(`voice brain: ${err instanceof Error ? err.message : err}`);
          write("Sorry, I lost my train of thought there. Could you say that again?");
        }
      }
      if (!aborted.signal.aborted) {
        res.write(sseChunk(id, null, "stop"));
        res.write("data: [DONE]\n\n");
        res.end();
      }
    });
  }

  /** Writes the spoken answer to `messages`, a piece at a time. */
  async reply(incoming: ChatMessage[], write: (t: string) => void, signal?: AbortSignal): Promise<void> {
    const session = this.session;
    const history = incoming.filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim()).slice(-20);
    const last = history[history.length - 1];
    const news = session ? this.deps.tap.takeNews(session.address) : [];
    const quiet = !last || last.role !== "user" || last.content?.replace(/\.+/g, "").trim() === "" || (history.length === 1 && last.content?.trim() === "Hello.");
    if (quiet && !news.length) {
      // Unmute's opening turn has no real words from Paul; greet. A silence marker with no news: say nothing.
      if (!last || history.every((m) => m.role !== "assistant")) write("Hi Paul, it's Cleo. I'm listening.");
      return;
    }
    const system = news.length ? `${VOICE_SYSTEM}\n\nNews from ClearOps since you last spoke (pass it on briefly):\n${news.map((n) => `- ${speakable(n)}`).join("\n")}` : VOICE_SYSTEM;
    const messages: ChatMessage[] = [{ role: "system", content: system }, ...history];

    const first = await this.complete(messages, true, write, signal);
    if (!first.toolCall) return;
    let request = "";
    try {
      request = String(JSON.parse(first.toolCall.function.arguments || "{}").request ?? "").trim();
    } catch {
      request = "";
    }
    const result = request && session ? await this.askClearOps(session, request) : "Nothing was asked: there is no voice session or the request was empty.";
    messages.push({ role: "assistant", content: first.text || null, tool_calls: [first.toolCall] });
    messages.push({ role: "tool", tool_call_id: first.toolCall.id, content: result });
    await this.complete(messages, false, write, signal);
  }

  private async askClearOps(session: VoiceSession, request: string): Promise<string> {
    const wait = this.deps.answerWaitMs ?? config.voice.answerWaitSeconds * 1000;
    const answer = this.deps.tap.next(session.address, wait);
    void this.deps.ask(session.sender, session.address, voiceRequestText(request)).catch((err) => console.warn(`voice: ask failed: ${err instanceof Error ? err.message : err}`));
    const text = await answer;
    if (text === undefined) return "ClearOps is still working on it and will post its answer in the Discord chat. Tell Paul that in one short sentence.";
    return `ClearOps answered (also posted in the chat): ${speakable(text)}`;
  }

  /** One streamed OpenRouter call. Text goes straight to `write`; a tool call is returned instead of run. */
  private async complete(messages: ChatMessage[], tools: boolean, write: (t: string) => void, signal?: AbortSignal): Promise<{ text: string; toolCall?: ToolCall }> {
    const res = await this.fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.openrouter.apiKey}`, "Content-Type": "application/json", "X-Title": "ClearOps voice" },
      body: JSON.stringify({ model: resolveModel(config.voice.model), messages, stream: true, max_tokens: 400, ...(tools ? { tools: [ASK_TOOL] } : {}) }),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`OpenRouter answered ${res.status}`);
    let text = "";
    const calls = new Map<number, ToolCall>();
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(part, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let delta: { content?: string | null; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> } | undefined;
        try {
          delta = JSON.parse(data).choices?.[0]?.delta;
        } catch {
          continue;
        }
        if (delta?.content) {
          text += delta.content;
          write(delta.content);
        }
        for (const tc of delta?.tool_calls ?? []) {
          const i = tc.index ?? 0;
          const cur = calls.get(i) ?? { id: tc.id ?? `call_${i}`, type: "function" as const, function: { name: "", arguments: "" } };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.function.name += tc.function.name;
          if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
          calls.set(i, cur);
        }
      }
    }
    const toolCall = [...calls.values()].find((c) => c.function.name === "ask_clearops");
    return { text, toolCall };
  }
}

// ---------------------------------------------------------------------------------------------
// Audio: Discord speaks 48 kHz stereo, the voice GPU 24 kHz mono, both 16-bit little-endian PCM.

/** 48 kHz stereo to 24 kHz mono: average the channels, then each pair of samples (a gentle low-pass). */
export function discordToVoice(pcm: Buffer): Buffer {
  const frames = Math.floor(pcm.length / 4);
  const out = Buffer.alloc(Math.floor(frames / 2) * 2);
  for (let o = 0, i = 0; o < out.length; o += 2, i += 8) {
    const a = (pcm.readInt16LE(i) + pcm.readInt16LE(i + 2)) / 2;
    const b = (pcm.readInt16LE(i + 4) + pcm.readInt16LE(i + 6)) / 2;
    out.writeInt16LE(Math.round((a + b) / 2), o);
  }
  return out;
}

/** 24 kHz mono to 48 kHz stereo, by linear interpolation. `prev` carries the last sample across chunks. */
export function voiceToDiscord(pcm: Buffer, prev = { last: 0 }): Buffer {
  const n = Math.floor(pcm.length / 2);
  const out = Buffer.alloc(n * 8);
  let last = prev.last;
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2);
    const mid = Math.round((last + s) / 2);
    out.writeInt16LE(mid, i * 8);
    out.writeInt16LE(mid, i * 8 + 2);
    out.writeInt16LE(s, i * 8 + 4);
    out.writeInt16LE(s, i * 8 + 6);
    last = s;
  }
  prev.last = last;
  return out;
}

/** 20 ms of 24 kHz mono 16-bit audio. */
export const VOICE_FRAME_BYTES = 960;

/**
 * Turns Discord's bursty audio (packets only while Paul speaks) into a steady 20 ms stream, with
 * silence in the gaps: the speech model needs the silence to know he has stopped.
 */
export class InputPump {
  private queue: Buffer[] = [];
  private queued = 0;
  /** At most half a second waits; older audio is dropped so a hiccup does not add lasting delay. */
  static readonly MAX_BACKLOG = VOICE_FRAME_BYTES * 25;

  push(pcm: Buffer): void {
    this.queue.push(pcm);
    this.queued += pcm.length;
    while (this.queued > InputPump.MAX_BACKLOG && this.queue.length) this.queued -= this.queue.shift()!.length;
  }

  /** The next 20 ms frame: queued audio, padded with silence. */
  frame(): Buffer {
    const out = Buffer.alloc(VOICE_FRAME_BYTES);
    let filled = 0;
    while (filled < VOICE_FRAME_BYTES && this.queue.length) {
      const head = this.queue[0];
      const take = Math.min(head.length, VOICE_FRAME_BYTES - filled);
      head.copy(out, filled, 0, take);
      filled += take;
      if (take === head.length) this.queue.shift();
      else this.queue[0] = head.subarray(take);
      this.queued -= take;
    }
    return out;
  }
}
