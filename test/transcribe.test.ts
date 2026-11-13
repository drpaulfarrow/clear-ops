/**
 * Voice notes: a Telegram voice note, a Discord voice message or a WhatsApp audio message is
 * transcribed by the service and the chief answers the transcript as if Paul had typed it.
 * The provider is stubbed here; no test touches the network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.ALLOWED_DISCORD_IDS = "424242";
process.env.ALLOWED_NUMBERS = "447700900123";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-voice-"));
process.env.TELEGRAM_BOT_TOKEN = "123:SECRET-TOKEN";
process.env.WHATSAPP_TOKEN = "wa-token-123456";
process.env.OPENROUTER_API_KEY = "sk-or-v1-openrouter-key";
delete process.env.TRANSCRIBE_API_KEY;

const { config } = await import("../src/config.js");
const { audioFormat, isAudio, oggSeconds, transcribe, TranscribeError, transcriptionAvailable, transcriptionUnavailableReason } = await import("../src/transcribe.js");
const { Orchestrator } = await import("../src/orchestrator.js");
const { Store } = await import("../src/store.js");
const { JobRunner } = await import("../src/jobs.js");
const { Scheduler } = await import("../src/scheduler.js");
const { ConsoleMessenger, parseInbound, whatsappAttachment, whatsappAudioName } = await import("../src/whatsapp.js");
const { Uploads } = await import("../src/uploads.js");
import type { AgentRunner, RunOptions } from "../src/agents.js";
import type { Attachment } from "../src/uploads.js";

const KEY = "sk-or-v1-transcribe-key";
const fixedDate = () => new Date("2026-11-13T09:00:00Z");

/** Put the transcription settings back to the defaults the service runs with. */
function useTranscribe(opts: { key?: string; enabled?: boolean; timeoutMs?: number } = {}) {
  config.transcribe.enabled = opts.enabled ?? true;
  config.transcribe.apiKey = opts.key ?? "";
  config.openrouter.apiKey = opts.key ?? "";
  config.transcribe.baseUrl = "https://openrouter.ai/api/v1";
  config.transcribe.model = "openai/whisper-large-v3";
  config.transcribe.maxMb = 12;
  config.transcribe.maxSeconds = 300;
  config.transcribe.timeoutMs = opts.timeoutMs ?? 60_000;
  config.transcribe.language = "";
}

/** A minimal Ogg page header carrying a granule position, which is where the length comes from. */
function ogg(seconds: number): Buffer {
  const b = Buffer.alloc(64);
  b.write("OggS", 0);
  b.writeBigUInt64LE(BigInt(Math.round(seconds * 48000)), 6);
  return b;
}

interface Call {
  url: string;
  init: RequestInit;
}

/** Stub the network: every call is recorded, and nothing leaves the process. */
function stubFetch(reply: (call: Call) => Response | Promise<Response>): { calls: Call[]; restore: () => void } {
  const real = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (url: unknown, init: unknown) => {
    const call = { url: String(url), init: (init ?? {}) as RequestInit };
    calls.push(call);
    return reply(call);
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = real) };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/* ---------- the call itself ---------- */

test("a voice note is transcribed with one plain HTTPS call: multipart, the model, and the key in the header", async () => {
  useTranscribe({ key: KEY });
  const { calls, restore } = stubFetch(() => json({ text: "  Move the standup to Thursday  " }));
  try {
    const text = await transcribe(ogg(2), { name: "voice-note-1.ogg", mimeType: "audio/ogg" });
    assert.equal(text, "Move the standup to Thursday");
    assert.equal(calls.length, 1, "one call, no SDK and no retry");
    assert.equal(calls[0].url, "https://openrouter.ai/api/v1/audio/transcriptions");
    assert.equal(calls[0].init.method, "POST");
    assert.equal((calls[0].init.headers as Record<string, string>).Authorization, `Bearer ${KEY}`);
    const form = calls[0].init.body as FormData;
    assert.equal(form.get("model"), "openai/whisper-large-v3");
    assert.equal((form.get("file") as File).name, "voice-note-1.ogg");
  } finally {
    restore();
  }
});

test("without any key, transcription is off, nothing is sent and the reason is plain", async () => {
  useTranscribe({ key: "" });
  assert.equal(transcriptionAvailable(), false);
  const { calls, restore } = stubFetch(() => json({ text: "should never be asked for" }));
  try {
    await assert.rejects(
      () => transcribe(ogg(2), { name: "voice-note-1.ogg", mimeType: "audio/ogg" }),
      (err: Error) => err instanceof TranscribeError && /no transcription key is set/.test(err.message),
    );
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test("TRANSCRIBE=off switches transcription off even when a key is set, and says so", async () => {
  useTranscribe({ key: KEY, enabled: false });
  assert.equal(transcriptionAvailable(), false);
  assert.match(transcriptionUnavailableReason(), /TRANSCRIBE=off/);
  await assert.rejects(() => transcribe(ogg(2), { name: "voice-note-1.ogg", mimeType: "audio/ogg" }), /switched off/);
  useTranscribe({ key: KEY });
});

test("a provider that refuses is a plain failure, never a leak of the key or the audio", async () => {
  useTranscribe({ key: KEY });
  const { restore } = stubFetch(() => json({ error: { message: `Insufficient credits for key ${KEY}` } }, 402));
  try {
    await assert.rejects(
      () => transcribe(ogg(2), { name: "voice-note-1.ogg", mimeType: "audio/ogg" }),
      (err: Error) => err instanceof TranscribeError && /HTTP 402/.test(err.message) && !err.message.includes(KEY),
    );
  } finally {
    restore();
  }
});

test("a clip that is too long, too big or not audio is refused before anything is sent", async () => {
  useTranscribe({ key: KEY });
  const { calls, restore } = stubFetch(() => json({ text: "should never be asked for" }));
  try {
    await assert.rejects(() => transcribe(ogg(600), { name: "voice-note-1.ogg", mimeType: "audio/ogg" }), /longer than I transcribe in one go/);
    const big = Buffer.alloc(Math.round(config.transcribe.maxMb * 1024 * 1024) + 1);
    await assert.rejects(() => transcribe(big, { name: "voice-note-2.ogg", mimeType: "audio/ogg" }), /bigger than I transcribe in one go/);
    await assert.rejects(() => transcribe(Buffer.from("%PDF-1.4"), { name: "brief.pdf", mimeType: "application/pdf" }), /format I cannot send for transcription/);
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test("a provider that never answers gives up on the timeout with a plain reason", async () => {
  useTranscribe({ key: KEY, timeoutMs: 30 });
  const real = globalThis.fetch;
  globalThis.fetch = ((_url: unknown, init: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as typeof fetch;
  try {
    await assert.rejects(() => transcribe(ogg(2), { name: "voice-note-1.ogg", mimeType: "audio/ogg" }), /did not answer within/);
  } finally {
    globalThis.fetch = real;
    useTranscribe({ key: KEY });
  }
});

test("only audio is transcribed, and a generic file type does not hide a voice note", () => {
  assert.ok(isAudio("voice-note-1.ogg", "audio/ogg"));
  assert.ok(isAudio("voice-77.ogg", "application/octet-stream"), "Telegram may send no real type for a voice note");
  assert.ok(isAudio("voice-77.ogg"), "and no type at all");
  assert.ok(!isAudio("video-1.mp4", "video/mp4"), "a Telegram video is not a voice note");
  assert.ok(!isAudio("Connections.csv", "text/csv"));
  assert.equal(audioFormat("voice-note-1.ogg", "audio/ogg"), "ogg");
  assert.equal(audioFormat("audio-2.mp3"), "mp3");
  assert.equal(audioFormat("brief.pdf", "application/pdf"), undefined);
  assert.equal(oggSeconds(ogg(3.5))!.toFixed(1), "3.5");
  assert.equal(oggSeconds(Buffer.from("not an ogg at all")), undefined);
});

/* ---------- what the chief receives ---------- */

const att = (name: string, data: Buffer, mimeType?: string): Attachment & { calls: number } => {
  const a = { name, mimeType, calls: 0, download: async () => (a.calls++, data) };
  return a;
};

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-voice-orch-"));
  const store = new Store(dir);
  const messenger = new ConsoleMessenger();
  const calls: RunOptions[] = [];
  const uploads = new Uploads(path.join(dir, "uploads"), undefined, fixedDate);
  const runner: AgentRunner = async (o) => {
    calls.push(o);
    return { text: "chief replied", sessionId: "s" };
  };
  const jobs = new JobRunner(store, messenger, runner);
  const orch = new Orchestrator(store, messenger, jobs, new Scheduler(store, jobs), runner, {}, uploads);
  return { orch, messenger, calls, uploads };
}

test("a voice note reaches the chief as a transcript, marked as one, with the file kept as an upload", async () => {
  useTranscribe({ key: KEY });
  const { calls: net, restore } = stubFetch(() => json({ text: "Move the standup to Thursday" }));
  try {
    const { orch, messenger, calls, uploads } = harness();
    const note = att("voice-note-1.ogg", ogg(4), "audio/ogg");
    await orch.handle("tg:99887766", "", { attachments: [note] });
    assert.equal(note.calls, 1);
    assert.match(messenger.sent[0].text, /^Saved voice-note-1\.ogg \(64 B\)\./, "the receipt is what it always was");
    assert.deepEqual(fs.readdirSync(uploads.dir), ["2026-11-13-voice-note-1.ogg"], "the original file stays in the uploads directory");
    assert.equal(net.length, 1);
    const prompt = calls[0].prompt;
    assert.match(prompt, /transcribed automatically/);
    assert.match(prompt, /may mishear names, numbers and places/);
    assert.match(prompt, /- Voice note \S*2026-11-13-voice-note-1\.ogg \(transcript\): "Move the standup to Thursday"/);
    assert.equal(messenger.sent.at(-1)!.text, "chief replied");
  } finally {
    restore();
  }
});

test("with no key the chief is told plainly that it cannot hear the voice note and to ask for the text", async () => {
  useTranscribe({ key: "" });
  const { orch, messenger, calls } = harness();
  await orch.handle("tg:99887766", "", { attachments: [att("voice-note-1.ogg", ogg(4), "audio/ogg")] });
  assert.match(messenger.sent[0].text, /^Saved voice-note-1\.ogg \(64 B\)\./);
  const prompt = calls[0].prompt;
  assert.match(prompt, /was not transcribed: no transcription key is set/);
  assert.match(prompt, /cannot play the voice note and ask Paul to type it/);
  assert.doesNotMatch(prompt, /transcript\):/, "nothing is invented for a note it never heard");
});

test("a provider error never fails the turn: the chief says it could not be transcribed", async () => {
  useTranscribe({ key: KEY });
  const { restore } = stubFetch(() => new Response("upstream boom", { status: 500 }));
  try {
    const { orch, messenger, calls } = harness();
    await orch.handle("dc:u:424242", "", { attachments: [att("voice-message.ogg", ogg(2), "audio/ogg")] });
    assert.equal(messenger.sent.at(-1)!.text, "chief replied", "the turn finished normally");
    assert.match(calls[0].prompt, /was not transcribed: the transcription service refused it \(HTTP 500/);
    assert.match(calls[0].prompt, /ask Paul to type it/);
  } finally {
    restore();
  }
});

test("text and other attachments behave exactly as before: no transcription, no extra call", async () => {
  useTranscribe({ key: KEY });
  const { calls: net, restore } = stubFetch(() => json({ text: "should never be asked for" }));
  try {
    const { orch, calls } = harness();
    await orch.handle("tg:99887766", "here is the list", { attachments: [att("Connections.csv", Buffer.from("First Name\n"), "text/csv")] });
    await orch.handle("tg:99887766", "and a plain message");
    assert.equal(net.length, 0, "nothing is sent for a spreadsheet or for text");
    assert.match(calls[0].prompt, /Connections\.csv/);
    assert.doesNotMatch(calls[0].prompt, /Voice note|transcrib/i);
    assert.equal(calls[1].prompt, "and a plain message");
  } finally {
    restore();
  }
});

/* ---------- WhatsApp, whose audio arrives as a media id ---------- */

test("a WhatsApp audio message is parsed, named and fetched only when the download is asked for", async () => {
  const body = {
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                { from: "447700900123", id: "wamid.1", type: "audio", audio: { id: "MEDIA1", mime_type: "audio/ogg; codecs=opus", voice: true, file_size: 4096 } },
                { from: "447700900123", id: "wamid.2", type: "image", image: { id: "IMG1" } },
                { from: "447700900123", id: "wamid.3", type: "text", text: { body: "and a typed one" } },
              ],
            },
          },
        ],
      },
    ],
  };
  const msgs = parseInbound(body);
  assert.deepEqual(msgs.map((m) => m.text), ["", "and a typed one"], "an image is still ignored");
  assert.equal(msgs[0].audio!.id, "MEDIA1");
  assert.equal(whatsappAudioName(msgs[0].audio!), "voice-note-MEDIA1.ogg");

  const { calls, restore } = stubFetch((call) =>
    call.url.includes("graph.facebook.com")
      ? json({ url: "https://lookaside.fbsbx.com/whatsapp/audio/MEDIA1", file_size: 10 })
      : new Response("audio-bytes", { status: 200 }),
  );
  try {
    const a = whatsappAttachment(msgs[0].audio!);
    assert.equal(calls.length, 0, "nothing is fetched until the allowlist has been passed and the download asked for");
    const data = await a.download(1024 * 1024);
    assert.equal(data.toString(), "audio-bytes");
    assert.equal(calls[0].url, "https://graph.facebook.com/v21.0/MEDIA1");
    assert.equal((calls[0].init.headers as Record<string, string>).Authorization, `Bearer ${config.whatsapp.token}`);
    assert.equal(calls[1].url, "https://lookaside.fbsbx.com/whatsapp/audio/MEDIA1", "the bytes come from the URL Meta handed back");
    assert.equal((calls[1].init.headers as Record<string, string>).Authorization, `Bearer ${config.whatsapp.token}`);
  } finally {
    restore();
  }
});

test("WhatsApp audio is never fetched from anywhere but https, and a refusal is plain", async () => {
  const { restore } = stubFetch(() => json({ url: "http://lookaside.fbsbx.com/plain-http" }));
  try {
    const a = whatsappAttachment({ id: "MEDIA2", mimeType: "audio/ogg", voice: true });
    await assert.rejects(() => a.download(1024 * 1024), /refused a non-https download/);
  } finally {
    restore();
  }
  const { restore: restore2 } = stubFetch(() => json({ error: { message: "media expired" } }, 404));
  try {
    const a = whatsappAttachment({ id: "MEDIA3", mimeType: "audio/ogg", voice: true });
    await assert.rejects(() => a.download(1024 * 1024), /WhatsApp would not hand the audio message over/);
  } finally {
    restore2();
  }
});

test("a WhatsApp voice note goes to the chief as a transcript, through the same path as any channel", async () => {
  useTranscribe({ key: KEY });
  const { restore } = stubFetch((call) => {
    if (call.url.includes("graph.facebook.com")) return json({ url: "https://lookaside.fbsbx.com/whatsapp/audio/MEDIA4", file_size: 64 });
    if (call.url.includes("lookaside.fbsbx.com")) return new Response(ogg(3), { status: 200 });
    return json({ text: "Move the standup to Thursday" });
  });
  try {
    const { orch, messenger, calls } = harness();
    const msgs = parseInbound({ entry: [{ changes: [{ value: { messages: [{ from: "447700900123", id: "wamid.9", type: "audio", audio: { id: "MEDIA4", mime_type: "audio/ogg", voice: true } }] } }] }] });
    await orch.handle(msgs[0].from, msgs[0].text, msgs[0].audio ? { attachments: [whatsappAttachment(msgs[0].audio)] } : {});
    assert.match(messenger.sent[0].text, /^Saved voice-note-MEDIA4\.ogg \(64 B\)\./);
    assert.match(calls[0].prompt, /\(transcript\): "Move the standup to Thursday"/);
  } finally {
    restore();
  }
});
