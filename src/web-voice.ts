import { randomBytes } from "node:crypto";
import { config } from "./config.js";
import { transcribe as serviceTranscribe, TranscribeError } from "./transcribe.js";
import { speak as serviceSpeak, speakable, VoiceBrain, type VoiceTap } from "./voice.js";
import { WEB_SENDER, type WebChat } from "./web-chat.js";

/**
 * Cleo in the web app (docs/APP.md): Paul taps the Cleo button, speaks, taps again, and hears her
 * answer. She is who he talks to; Marlo, the chief, is who does the work and writes in the feeds.
 *
 * It is the same Cleo as in a Discord voice channel (src/voice.ts): the same brain, the same one tool
 * that hands his request to the chief, and the same rule that nothing spoken can approve anything. A
 * spoken request reaches the chief only through `voiceRequestText`, whose prefix no approval command
 * can match, and the chief answers in the feed that was open, in writing.
 *
 * She speaks twice when she has to ask: straight away, to say she is asking Marlo, and again when he
 * has answered, to say what he said and where it is written. The first is the answer to the request
 * that carried his recording; the second waits in memory, briefly, for the page to collect.
 *
 * What is kept: his words as transcribed and what she said, in her own conversation, apart from the
 * chief's feeds, so there is a record and the app's search finds it. When she asks the chief, his feed
 * is given the question too, in Paul's words and marked as asked through her. What is not kept: the audio. His
 * recording and her speech are held in memory and written nowhere.
 */

/** The most one spoken turn may carry: about a minute and a half of a phone's recording, with room to spare. */
export const WEB_VOICE_BYTES = 2 * 1024 * 1024;
/** The body the voice route reads: the recording as base64, and a little JSON around it. */
export const WEB_VOICE_BODY_LIMIT = "3mb";
/** How much of the talk so far Cleo is given with each turn. */
export const WEB_VOICE_TURNS = 20;

/** The kinds of recording a browser makes, and the file name each is sent for transcription under. */
const RECORDINGS: Record<string, string> = { "audio/webm": "voice.webm", "audio/mp4": "voice.m4a", "audio/ogg": "voice.ogg" };

/** How long she waits for Marlo before telling Paul his answer will be in the feed. */
export const WEB_VOICE_ANSWER_WAIT_MS = 45_000;
/** How long what she says on coming back is held for the page to collect. It is speech, and is not kept. */
export const WEB_VOICE_FOLLOW_KEEP_MS = 5 * 60_000;
/** What she says when she has gone to ask and found no words of her own for it. */
export const WEB_VOICE_ASKING = "Okay, I'll ask Marlo.";

export const WEB_VOICE_SYSTEM = `You are Cleo, the voice of ClearOps, Paul's agentic workforce, and the one he talks to. You are warm, quick and plain-spoken, like a good colleague at the front desk who knows everyone. He taps a button, speaks, and hears your answer. Your name is Cleo; if he asks who you are, you are Cleo. Everything you write is spoken aloud by a text-to-speech voice.

How to speak: plain spoken sentences only. No lists, markdown, headings, links, URLs, emojis, code or symbols. One to three short sentences unless he asks for more. British English. Never use em dashes. Say numbers the way a person would.

Who does what: Marlo is the chief of staff. He runs the workforce (research, writing, engineering, an email and calendar assistant, design and more) and writes his answers in his feeds, which Paul reads in the app. You cannot see Paul's jobs, email, calendar, files or repositories yourself. Small talk and quick general questions you answer yourself.

When Paul asks for anything Marlo would know or do (look something up, start or check work, remember something, act), say one short friendly sentence telling him you are going to ask Marlo, in your own words, and in the same turn call ask_clearops with his request in his own words plus any context from the conversation it needs. Do not guess at the answer.

When Marlo's answer comes back, tell Paul what Marlo said in one to three sentences, and make it plain that you checked with Marlo and this is his answer. Vary how you put it. If there is more to it than you have said, tell him the rest is written in Marlo's feed, and name the feed. No links or ids unless he asks.

If Marlo is still working when you answer, say so, and say his answer will be written in that feed. Never say something was done unless Marlo said so. You cannot approve anything: sending an email or invitation, a DNS change, a purchase or a merge is approved only by Paul's own tap on that item in the app, so if he asks you to approve one, tell him that.`;

/** Why a spoken turn could not be taken, in words for Paul, with the status the route answers with. */
export class WebVoiceError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** The recording a browser sent: one of the kinds a browser makes, as base64, within the size one turn may carry. */
export function webVoiceAudio(raw: unknown): { data: Buffer; type: string; name: string } {
  const given = (raw ?? {}) as { type?: unknown; data?: unknown };
  const type = typeof given.type === "string" ? given.type.split(";")[0]!.trim().toLowerCase() : "";
  const name = Object.hasOwn(RECORDINGS, type) ? RECORDINGS[type] : undefined;
  if (!name) throw new WebVoiceError(400, "That is not a recording this app makes.");
  if (typeof given.data !== "string" || !given.data || !/^[A-Za-z0-9+/]+={0,2}$/.test(given.data)) throw new WebVoiceError(400, "There was no recording in that.");
  // Checked before it is decoded, so nothing larger is ever held twice.
  if (given.data.length > Math.ceil((WEB_VOICE_BYTES * 4) / 3) + 4) throw new WebVoiceError(413, "That was too long for one go. Keep it under a minute or so.");
  const data = Buffer.from(given.data, "base64");
  if (!data.length || data.length > WEB_VOICE_BYTES) throw new WebVoiceError(data.length ? 413 : 400, data.length ? "That was too long for one go. Keep it under a minute or so." : "There was no recording in that.");
  return { data, type, name };
}

export interface WebVoiceTurn {
  /** What he said, as transcribed. Empty when nothing could be made out. */
  heard: string;
  /** What Cleo said straight away. Empty when there was nothing to answer. */
  said: string;
  /** Those words as speech: MP3, base64. Absent when they could not be spoken, in which case `said` is still shown. */
  audio?: string;
  /** She has gone to ask Marlo: the name to collect what she says when he answers (`followUp`). */
  pending?: string;
}

/** What she says on coming back from Marlo. Not ready until he has answered or she has stopped waiting. */
export interface WebVoiceFollow {
  ready: boolean;
  said?: string;
  audio?: string;
}

export interface WebVoiceDeps {
  /** Hands a request to the chief as the web app's sender, to be answered in `address`. */
  ask: (sender: string, address: string, text: string) => Promise<void>;
  tap: VoiceTap;
  chat: Pick<WebChat, "spoken" | "asked">;
  transcribe?: typeof serviceTranscribe;
  speak?: (text: string) => Promise<Buffer>;
  fetch?: typeof fetch;
  answerWaitMs?: number;
  now?: () => number;
}

type Said = { role: "user" | "assistant"; content: string };

export class WebVoice {
  private readonly brain: VoiceBrain;
  private readonly talks = new Map<string, { said: Said[]; at: number }>();
  private readonly follows = new Map<string, { at: number; ready: boolean; said?: string; audio?: string }>();
  private busy = false;
  /** This turn's line for her about where Marlo's answer goes, and the signal that she has gone to ask him. */
  private about = "";
  private asked: (() => void) | undefined;
  private waiting = false;
  private feed: ((address: string) => string) | undefined;

  constructor(private readonly deps: WebVoiceDeps) {
    this.brain = new VoiceBrain({ ask: deps.ask, tap: deps.tap, system: WEB_VOICE_SYSTEM, holding: false, context: () => this.about, onAsk: () => this.asked?.(), words: { answered: (answer) => `Marlo answered, and his answer in full is written in the feed. He says: ${answer}`, working: "Marlo is still working on it. Tell Paul in one short sentence that Marlo is on it and that his answer will be written in the feed." }, answerWaitMs: deps.answerWaitMs ?? WEB_VOICE_ANSWER_WAIT_MS, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  }

  /** How feeds are named to her, so she can say where Marlo's written answer is. */
  feeds(name: (address: string) => string): void {
    this.feed = name;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** The talk so far in one conversation, forgotten once he has been quiet for as long as a voice call would wait. */
  private talk(address: string): Said[] {
    for (const [key, t] of this.talks) if (this.now() - t.at > config.voice.idleMinutes * 60_000) this.talks.delete(key);
    return this.talks.get(address)?.said ?? [];
  }

  /** Her words as speech, or nothing when they could not be spoken: the words are shown either way. */
  private async voiced(text: string): Promise<string | undefined> {
    try {
      const speech = await (this.deps.speak ?? ((t: string) => serviceSpeak(t, this.deps.fetch ?? fetch)))(text);
      return speech.length ? speech.toString("base64") : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * One spoken turn, with the feed that is open as where Marlo's written answer goes. The caller has
   * already checked whose browser it is and that the feed exists.
   *
   * She answers straight away. When that answer is that she is going to ask Marlo, the turn comes back
   * with `pending`, and what she says when he answers is collected with `followUp`.
   */
  async turn(address: string, audio: { data: Buffer; type: string; name: string }): Promise<WebVoiceTurn> {
    if (this.busy && this.waiting) throw new WebVoiceError(409, "Cleo is still waiting on Marlo. Give her a moment.");
    if (this.busy) throw new WebVoiceError(409, "Cleo is still answering. Give her a moment.");
    this.busy = true;
    let gone = false;
    try {
      let heard: string;
      try {
        heard = (await (this.deps.transcribe ?? serviceTranscribe)(audio.data, { name: audio.name, mimeType: audio.type, ...(this.deps.fetch ? { fetchImpl: this.deps.fetch } : {}) })).replace(/\s+/g, " ").trim();
      } catch (err) {
        throw new WebVoiceError(422, err instanceof TranscribeError ? `Cleo could not hear that: ${err.message}.` : "Cleo could not hear that just now.");
      }
      if (!heard) return { heard: "", said: "" };
      await this.deps.chat.spoken(address, "paul", heard);
      const said = [...this.talk(address), { role: "user" as const, content: heard }].slice(-WEB_VOICE_TURNS);
      const remember = (hers: string) => this.talks.set(address, { said: [...said, ...(hers ? [{ role: "assistant" as const, content: hers }] : [])].slice(-WEB_VOICE_TURNS), at: this.now() });
      this.about = `Marlo's written answer to anything you ask him now goes to the feed called "${this.feed?.(address) ?? "Main"}".`;
      let words = "";
      const asking = new Promise<"asked">(
        (resolve) =>
          (this.asked = () => {
            // What she asks him for is written in his feed, in Paul's words, so his answer has its question.
            this.deps.chat.asked(address, heard);
            resolve("asked");
          }),
      );
      this.brain.setSession({ address, sender: WEB_SENDER });
      const whole = (async () => {
        try {
          await this.brain.reply(said, (t) => (words += t));
        } finally {
          // Nothing is listened for between turns: a later answer from the chief is in his feed as text.
          this.brain.setSession(undefined);
        }
        return "done" as const;
      })();
      let first: "done" | "asked";
      try {
        first = await Promise.race([whole, asking]);
      } catch {
        throw new WebVoiceError(502, "Cleo could not answer just now. What you said is in her conversation.");
      }
      if (first === "done") {
        const answer = speakable(words);
        remember(answer);
        if (!answer) return { heard, said: "" };
        await this.deps.chat.spoken(address, "clearops", answer);
        const speech = await this.voiced(answer);
        return { heard, said: answer, ...(speech ? { audio: speech } : {}) };
      }
      // She has gone to ask Marlo. What she has said so far is her answer for now; the rest comes when he does.
      const sofar = words.length;
      const ack = speakable(words) || WEB_VOICE_ASKING;
      remember(ack);
      await this.deps.chat.spoken(address, "clearops", ack);
      const id = randomBytes(8).toString("hex");
      for (const [key, f] of this.follows) if (this.now() - f.at > WEB_VOICE_FOLLOW_KEEP_MS) this.follows.delete(key);
      this.follows.set(id, { at: this.now(), ready: false });
      gone = true;
      this.waiting = true;
      void whole
        .then(() => speakable(words.slice(sofar)) || "Marlo has answered. It is written in his feed.", () => "I could not get Marlo's answer just now. It will be written in his feed when he replies.")
        .then(async (back) => {
          remember(`${ack} ${back}`);
          await this.deps.chat.spoken(address, "clearops", back, true);
          const speech = await this.voiced(back);
          this.follows.set(id, { at: this.now(), ready: true, said: back, ...(speech ? { audio: speech } : {}) });
        })
        .catch(() => this.follows.set(id, { at: this.now(), ready: true, said: "" }))
        .finally(() => {
          this.asked = undefined;
          this.waiting = false;
          this.busy = false;
        });
      const speech = await this.voiced(ack);
      return { heard, said: ack, ...(speech ? { audio: speech } : {}), pending: id };
    } finally {
      if (!gone) {
        this.asked = undefined;
        this.busy = false;
      }
    }
  }

  /**
   * What she says on coming back from Marlo. Undefined for a name that was never given, or whose speech
   * is no longer held; not ready while she is still waiting on him. Reading it changes nothing.
   */
  followUp(id: string): WebVoiceFollow | undefined {
    const f = /^[a-f0-9]{16}$/.test(id) ? this.follows.get(id) : undefined;
    if (!f || this.now() - f.at > WEB_VOICE_FOLLOW_KEEP_MS) return undefined;
    if (!f.ready) return { ready: false };
    return { ready: true, said: f.said ?? "", ...(f.audio ? { audio: f.audio } : {}) };
  }
}
