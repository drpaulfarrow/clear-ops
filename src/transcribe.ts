/**
 * Voice notes and audio messages Paul sends in chat (a Telegram voice note, a Discord voice message,
 * a WhatsApp audio message). The service transcribes the file itself with one plain HTTPS call and
 * hands the chief the transcript in place of the missing text, so he never has to repeat himself.
 *
 * Provider: OpenRouter's OpenAI-compatible speech-to-text endpoint. OpenRouter does speech to text, and
 * its key is already set for the models, so this needs no second account; TRANSCRIBE_BASE_URL and
 * TRANSCRIBE_API_KEY point the same call at another OpenAI-compatible provider instead. No SDK, no
 * new runtime dependency: one multipart POST with fetch.
 *
 * The audio goes nowhere but that one endpoint. The file itself stays an upload (untrusted data, kept
 * in the uploads directory), and the transcript is marked for the chief as a transcript that may
 * mishear names and numbers. The key is read from the environment only: never logged, never written to
 * the store, a repository or a worker's environment.
 */
import path from "node:path";
import { config } from "./config.js";

/** The service secrets transcription needs, stripped from every worker's environment. */
export const TRANSCRIBE_SECRETS = ["TRANSCRIBE_API_KEY"];

/** The provider's name for messages to Paul. */
export const PROVIDER_NAME = "OpenRouter";

/** A failure whose message is safe and useful to show Paul. Never carries the key or the audio. */
export class TranscribeError extends Error {}

/** Audio formats the endpoint accepts, by the file extension we can recognise. */
const EXTENSION_FORMATS: Record<string, string> = {
  ".ogg": "ogg",
  ".oga": "ogg",
  ".opus": "ogg",
  ".mp3": "mp3",
  ".m4a": "m4a",
  ".mp4": "m4a",
  ".aac": "aac",
  ".wav": "wav",
  ".flac": "flac",
  ".webm": "webm",
};

const MIME_FORMATS: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/opus": "ogg",
  "audio/vorbis": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/aacp": "aac",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/webm": "webm",
};

/** The key: TRANSCRIBE_API_KEY if Paul set one, else the OpenRouter key the models already use. */
export function transcribeKey(): string {
  return config.transcribe.apiKey || config.openrouter.apiKey;
}

/** Whether a voice note can be transcribed at all. */
export function transcriptionAvailable(): boolean {
  return config.transcribe.enabled && !!transcribeKey();
}

/** Why not, in plain words: for the chief's note about a voice note it cannot hear. */
export function transcriptionUnavailableReason(): string {
  if (!config.transcribe.enabled) return "transcription is switched off (TRANSCRIBE=off)";
  return "no transcription key is set (TRANSCRIBE_API_KEY, or the OPENROUTER_API_KEY already used for the models)";
}

/** The channel's type, or "" when it gave none or only the generic "a file" guess (src/uploads.ts). */
function realMime(mimeType?: string): string {
  const mime = (mimeType ?? "").split(";")[0].trim().toLowerCase();
  return mime === "application/octet-stream" || mime === "binary/octet-stream" ? "" : mime;
}

/**
 * Whether an attachment is audio worth transcribing. The channel's own type decides when it gives one
 * (so a Telegram video is never mistaken for audio); otherwise the file extension does.
 */
export function isAudio(name: string, mimeType?: string): boolean {
  const mime = realMime(mimeType);
  if (mime) return mime.startsWith("audio/");
  return path.extname(name).toLowerCase() in EXTENSION_FORMATS;
}

/** The format name to send for this file, or undefined when it is not one the endpoint accepts. */
export function audioFormat(name: string, mimeType?: string): string | undefined {
  const mime = realMime(mimeType);
  if (mime) return MIME_FORMATS[mime];
  return EXTENSION_FORMATS[path.extname(name).toLowerCase()];
}

/**
 * Seconds of audio in an Ogg file, from the granule position of its last page, or undefined when it is
 * not an Ogg we can read. Voice notes are Opus, whose granule clock is 48 kHz; other Ogg codecs are
 * approximated, which is fine for a length guard.
 */
export function oggSeconds(data: Buffer): number | undefined {
  const at = data.lastIndexOf("OggS");
  if (at < 0 || at + 14 > data.length) return undefined;
  const granule = data.readBigUInt64LE(at + 6);
  if (granule <= 0n) return undefined;
  const seconds = Number(granule) / 48000;
  return Number.isFinite(seconds) ? seconds : undefined;
}

/** Never let the key, or anything that looks like one, into a message. */
function scrub(text: string): string {
  let out = String(text ?? "");
  for (const k of [config.transcribe.apiKey, config.openrouter.apiKey]) if (k && k.length >= 6) out = out.split(k).join("***");
  return out.replace(/\b(Bearer|sk-or-v1-|sk-)[\w.-]{6,}/gi, "***").slice(0, 200);
}

/** Extensions the endpoint itself lists. Anything else (Telegram's .oga, Discord's .opus) is renamed. */
const ENDPOINT_EXTENSIONS = new Set(["ogg", "mp3", "m4a", "wav", "flac", "webm", "aac"]);

/** A name for the upload whose extension tells the endpoint the format. */
function sendName(name: string, format: string): string {
  const clean = path.basename(name || "");
  const ext = path.extname(clean).slice(1).toLowerCase();
  if (ext === format && ENDPOINT_EXTENSIONS.has(ext)) return clean;
  return `voice-note.${format}`;
}

export interface TranscribeOptions {
  /** The saved upload's name, used for the format. */
  name: string;
  mimeType?: string;
  /** Injected in tests; the real one is fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Transcribe one audio file. Throws TranscribeError with a plain reason (too long, wrong format, the
 * provider refused it or did not answer) and nothing else: the caller tells Paul and asks for the text.
 */
export async function transcribe(data: Buffer, opts: TranscribeOptions): Promise<string> {
  if (!transcriptionAvailable()) throw new TranscribeError(transcriptionUnavailableReason());
  const format = audioFormat(opts.name, opts.mimeType);
  if (!format) {
    const what = (opts.mimeType || path.extname(opts.name) || "unknown type").trim();
    throw new TranscribeError(`it is in a format I cannot send for transcription (${what})`);
  }
  const maxBytes = Math.round(config.transcribe.maxMb * 1024 * 1024);
  if (data.length > maxBytes) throw new TranscribeError(`it is bigger than I transcribe in one go (over ${config.transcribe.maxMb} MB)`);
  const seconds = format === "ogg" ? oggSeconds(data) : undefined;
  if (seconds != null && seconds > config.transcribe.maxSeconds) {
    throw new TranscribeError(`it is longer than I transcribe in one go (about ${Math.round(seconds)} seconds; the limit is ${config.transcribe.maxSeconds})`);
  }

  const form = new FormData();
  form.append("model", config.transcribe.model);
  if (config.transcribe.language) form.append("language", config.transcribe.language);
  form.append("file", new Blob([new Uint8Array(data)], { type: opts.mimeType || `audio/${format}` }), sendName(opts.name, format));

  const fetchImpl = opts.fetchImpl ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config.transcribe.timeoutMs);
  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetchImpl(`${config.transcribe.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${transcribeKey()}`, Accept: "application/json" },
      body: form,
      signal: ac.signal,
    });
  } catch (err) {
    if (ac.signal.aborted) throw new TranscribeError(`the transcription service did not answer within ${Math.round(config.transcribe.timeoutMs / 1000)} seconds`);
    throw new TranscribeError(`the transcription service could not be reached (${scrub(err instanceof Error ? err.message : String(err))})`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const detail = scrub(String(await res.text().catch(() => "")).replace(/\s+/g, " "));
    throw new TranscribeError(`the transcription service refused it (HTTP ${res.status}${detail ? `: ${detail}` : ""})`);
  }
  const body = (await res.json().catch(() => undefined)) as { text?: unknown } | undefined;
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) throw new TranscribeError("the transcription service returned no text");
  return text;
}
