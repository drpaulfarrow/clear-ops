import { config } from "./config.js";
import { transcribe as serviceTranscribe, TranscribeError } from "./transcribe.js";
import { speak as serviceSpeak, speakable, VoiceBrain, type VoiceTap } from "./voice.js";
import { WEB_SENDER, type WebChat } from "./web-chat.js";

/**
 * Cleo in the web app (docs/APP.md): Paul taps the Cleo button, speaks, taps again, and hears her
 * answer. One turn at a time, over one request: his audio in, her words and her voice out.
 *
 * It is the same Cleo as in a Discord voice channel (src/voice.ts): the same brain, the same one tool
 * that hands his request to the chief, and the same rule that nothing spoken can approve anything. A
 * spoken request reaches the chief only through `voiceRequestText`, whose prefix no approval command
 * can match, and the chief answers in the conversation he is in, where the answer also stays as text.
 *
 * What is kept: his words as transcribed and what she said, as two messages in that conversation
 * marked as spoken, so there is a record and the app's search finds it. What is not kept: the audio.
 * His recording and her speech are held in memory for the length of the request and written nowhere.
 */

/** The most one spoken turn may carry: about a minute and a half of a phone's recording, with room to spare. */
export const WEB_VOICE_BYTES = 2 * 1024 * 1024;
/** The body the voice route reads: the recording as base64, and a little JSON around it. */
export const WEB_VOICE_BODY_LIMIT = "3mb";
/** How much of the talk so far Cleo is given with each turn. */
export const WEB_VOICE_TURNS = 20;

/** The kinds of recording a browser makes, and the file name each is sent for transcription under. */
const RECORDINGS: Record<string, string> = { "audio/webm": "voice.webm", "audio/mp4": "voice.m4a", "audio/ogg": "voice.ogg" };

export const WEB_VOICE_SYSTEM = `You are Cleo, the voice of ClearOps, Paul's agentic workforce. You are talking with him by voice in the ClearOps app: he taps a button, speaks, and hears your answer. Your name is Cleo; if he asks who you are, you are Cleo. Everything you write is spoken aloud by a text-to-speech voice.

How to speak: plain spoken sentences only. No lists, markdown, headings, links, URLs, emojis, code or symbols. One to three short sentences unless he asks for more. British English. Never use em dashes. Say numbers the way a person would.

What you can do: you speak for the ClearOps workforce, which has research, writing, engineering, an email and calendar assistant, design and more. You cannot see his jobs, email, calendar, files or repositories yourself. For anything that needs ClearOps to look something up, start or check work, remember something, or act, call ask_clearops with his request in his own words plus any context from the conversation it needs. ClearOps's answer comes back to you, and is also written in the chat he has open; tell him the gist in a sentence or two, without links or ids unless he asks. Quick general questions and small talk you can answer yourself.

Never say something was done unless ask_clearops said so. If ClearOps is still working when you answer, say its answer will appear in the chat, because you cannot speak again until he next taps the button. You cannot approve anything: sending an email or invitation, a DNS change, a purchase or a merge is approved only by Paul's own tap on that item in the app, so if he asks you to approve one, tell him that.`;

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
  /** What Cleo said back. Empty when there was nothing to answer. */
  said: string;
  /** Her answer as speech: MP3, base64. Absent when it could not be spoken, in which case `said` is still shown. */
  audio?: string;
  /** Whether her words were added to the chat. Not when the chief's own answer is already there. */
  kept: boolean;
}

export interface WebVoiceDeps {
  /** Hands a request to the chief as the web app's sender, to be answered in `address`. */
  ask: (sender: string, address: string, text: string) => Promise<void>;
  tap: VoiceTap;
  chat: Pick<WebChat, "spoken" | "lastSaid">;
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
  private busy = false;

  constructor(private readonly deps: WebVoiceDeps) {
    this.brain = new VoiceBrain({ ask: deps.ask, tap: deps.tap, system: WEB_VOICE_SYSTEM, holding: false, ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.answerWaitMs !== undefined ? { answerWaitMs: deps.answerWaitMs } : {}) });
  }

  /** The talk so far in one conversation, forgotten once he has been quiet for as long as a voice call would wait. */
  private talk(address: string): Said[] {
    const now = (this.deps.now ?? Date.now)();
    for (const [key, t] of this.talks) if (now - t.at > config.voice.idleMinutes * 60_000) this.talks.delete(key);
    return this.talks.get(address)?.said ?? [];
  }

  /** One spoken turn in one of the app's conversations. The caller has already checked whose browser it is and that the conversation exists. */
  async turn(address: string, audio: { data: Buffer; type: string; name: string }): Promise<WebVoiceTurn> {
    if (this.busy) throw new WebVoiceError(409, "Cleo is still answering. Give her a moment.");
    this.busy = true;
    try {
      let heard: string;
      try {
        heard = (await (this.deps.transcribe ?? serviceTranscribe)(audio.data, { name: audio.name, mimeType: audio.type, ...(this.deps.fetch ? { fetchImpl: this.deps.fetch } : {}) })).replace(/\s+/g, " ").trim();
      } catch (err) {
        throw new WebVoiceError(422, err instanceof TranscribeError ? `Cleo could not hear that: ${err.message}.` : "Cleo could not hear that just now.");
      }
      if (!heard) return { heard: "", said: "", kept: false };
      await this.deps.chat.spoken(address, "paul", heard);
      const before = this.deps.chat.lastSaid(address);
      const said = [...this.talk(address), { role: "user" as const, content: heard }].slice(-WEB_VOICE_TURNS);
      let words = "";
      this.brain.setSession({ address, sender: WEB_SENDER });
      try {
        await this.brain.reply(said, (t) => (words += t));
      } catch {
        throw new WebVoiceError(502, "Cleo could not answer just now. What you said is in the chat.");
      } finally {
        // Nothing is listened for between turns: a later answer from the chief is in the chat as text.
        this.brain.setSession(undefined);
      }
      const answer = speakable(words);
      this.talks.set(address, { said: [...said, ...(answer ? [{ role: "assistant" as const, content: answer }] : [])].slice(-WEB_VOICE_TURNS), at: (this.deps.now ?? Date.now)() });
      if (!answer) return { heard, said: "", kept: false };
      // When the chief answered in the chat during this turn, its own words are the record; hers are only spoken.
      const kept = this.deps.chat.lastSaid(address) === before;
      if (kept) await this.deps.chat.spoken(address, "clearops", answer);
      let speech: Buffer | undefined;
      try {
        speech = await (this.deps.speak ?? ((t: string) => serviceSpeak(t, this.deps.fetch ?? fetch)))(answer);
      } catch {
        speech = undefined;
      }
      return { heard, said: answer, kept, ...(speech?.length ? { audio: speech.toString("base64") } : {}) };
    } finally {
      this.busy = false;
    }
  }
}
