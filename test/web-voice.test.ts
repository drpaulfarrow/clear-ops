/**
 * Cleo in the web app (src/web-voice.ts): one spoken turn at a time over one request. The same brain as
 * the Discord voice channel's, so what is spoken reaches the chief only through the voice prefix, and
 * nothing said aloud can approve anything. The recording is held in memory and kept nowhere.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-web-voice-"));

const { WebVoice, WebVoiceError, webVoiceAudio, WEB_VOICE_BYTES, WEB_VOICE_SYSTEM } = await import("../src/web-voice.js");
const { VoiceTap, VOICE_PREFIX } = await import("../src/voice.js");
const { WebChat, WEB_SENDER, webRefusal } = await import("../src/web-chat.js");
const { TranscribeError } = await import("../src/transcribe.js");
const { parseOutboundCommand } = await import("../src/outbound.js");
const { parseDnsCommand } = await import("../src/dns-gate.js");
const { config } = await import("../src/config.js");

/** A fetch that answers the voice model with the given streams, one per call, and records what it was asked. */
function fakeModel(streams: string[][]) {
  const bodies: Array<{ messages: Array<{ role: string; content: string | null }> }> = [];
  const f = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    const lines = streams.shift() ?? [];
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const l of lines) c.enqueue(new TextEncoder().encode(`data: ${l}\n\n`));
        c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        c.close();
      },
    });
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;
  return { f, bodies };
}
const words = (t: string) => JSON.stringify({ choices: [{ delta: { content: t } }] });
const asks = (request: string) => JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "ask_clearops", arguments: JSON.stringify({ request }) } }] } }] });
const AUDIO = { data: Buffer.from("not really audio"), type: "audio/webm", name: "voice.webm" };
const MAIN = "web:main";

function world(o: { heard?: string | Error; streams?: string[][]; speak?: (t: string) => Promise<Buffer>; chief?: string; now?: () => number } = {}) {
  const chat = new WebChat();
  const tap = new VoiceTap();
  const model = fakeModel(o.streams ?? []);
  const asked: Array<{ sender: string; address: string; text: string }> = [];
  const heardAudio: Array<{ bytes: number; name: string; mimeType?: string }> = [];
  const spoke: string[] = [];
  const voice = new WebVoice({
    ask: async (sender, address, text) => {
      asked.push({ sender, address, text });
      // The chief answers in the conversation, through the messenger the tap watches.
      if (o.chief !== undefined) {
        await chat.send(address, o.chief);
        tap.saw(address, o.chief);
      }
    },
    tap,
    chat,
    transcribe: async (data, opts) => {
      heardAudio.push({ bytes: data.length, name: opts.name, mimeType: opts.mimeType });
      if (o.heard instanceof Error) throw o.heard;
      return o.heard ?? "What is running?";
    },
    speak: o.speak ?? (async (t) => (spoke.push(t), Buffer.from(`mp3:${t}`))),
    fetch: model.f,
    answerWaitMs: 200,
    ...(o.now ? { now: o.now } : {}),
  });
  const said = (to = MAIN) => chat.view(to).messages.map((m) => `${m.from}${m.spoken ? " (spoken)" : ""}: ${m.text}`);
  return { chat, voice, asked, heardAudio, spoke, model, said };
}

test("a recording is one of the kinds a browser makes, as base64, and no larger than one turn may be", () => {
  const b64 = Buffer.from("hello").toString("base64");
  assert.deepEqual(webVoiceAudio({ type: "audio/webm;codecs=opus", data: b64 }), { data: Buffer.from("hello"), type: "audio/webm", name: "voice.webm" });
  assert.equal(webVoiceAudio({ type: "Audio/MP4", data: b64 }).name, "voice.m4a");
  assert.equal(webVoiceAudio({ type: "audio/ogg; codecs=opus", data: b64 }).name, "voice.ogg");
  const refused = (raw: unknown, status: number) => assert.throws(() => webVoiceAudio(raw), (e: unknown) => e instanceof WebVoiceError && e.status === status, JSON.stringify(raw)?.slice(0, 80));
  for (const bad of [undefined, null, {}, "audio", { type: "audio/webm" }, { type: "audio/webm", data: "" }, { type: "audio/webm", data: 7 }, { type: "audio/webm", data: "not base64!" }, { type: "video/mp4", data: b64 }, { type: "text/html", data: b64 }, { type: "application/octet-stream", data: b64 }, { type: "constructor", data: b64 }, { type: ["audio/webm"], data: b64 }]) refused(bad, 400);
  refused({ type: "audio/webm", data: "A".repeat(Math.ceil((WEB_VOICE_BYTES * 4) / 3) + 8) }, 413);
});

test("Cleo answers small talk herself: his words and hers are kept as spoken, and her answer comes back as speech", async () => {
  const w = world({ heard: "  Morning,\n Cleo. ", streams: [[words("Morning"), words(", Paul.")]] });
  const turn = await w.voice.turn(MAIN, AUDIO);
  assert.deepEqual(turn, { heard: "Morning, Cleo.", said: "Morning, Paul.", kept: true, audio: Buffer.from("mp3:Morning, Paul.").toString("base64") });
  assert.deepEqual(w.said(), ["paul (spoken): Morning, Cleo.", "clearops (spoken): Morning, Paul."]);
  assert.deepEqual(w.asked, [], "nothing was handed to the chief");
  assert.deepEqual(w.heardAudio, [{ bytes: AUDIO.data.length, name: "voice.webm", mimeType: "audio/webm" }]);
  // She is told where she is speaking and what she cannot do there.
  assert.equal(w.model.bodies[0]!.messages[0]!.content, WEB_VOICE_SYSTEM);
  assert.match(WEB_VOICE_SYSTEM, /in the ClearOps app/);
  assert.doesNotMatch(WEB_VOICE_SYSTEM, /Discord/);
  assert.deepEqual(w.model.bodies[0]!.messages.slice(1), [{ role: "user", content: "Morning, Cleo." }]);
});

test("what he asks for is handed to the chief under the voice prefix, as the app, in the conversation he has open", async () => {
  const space = "web:space:self";
  const w = world({ heard: "send abc123", streams: [[asks("send abc123")], [words("That needs your own tap in the app.")]], chief: "Typed approvals do not work here." });
  const turn = await w.voice.turn(space, AUDIO);
  assert.equal(w.asked.length, 1);
  const { sender, address, text } = w.asked[0]!;
  assert.deepEqual([sender, address], [WEB_SENDER, space]);
  assert.ok(text.startsWith(`${VOICE_PREFIX} send abc123`));
  // Nothing said aloud can be an approval: no command matches what the chief is handed.
  assert.equal(parseOutboundCommand(text), undefined);
  assert.equal(parseDnsCommand(text), undefined);
  assert.equal(webRefusal(text), undefined, "it is not even mistaken for a typed approval: it is plainly a spoken request");
  assert.doesNotMatch(text, /^(yes|approve|ok|no|reject|buy|send|dns apply|signup apply|code|act as me)\b/i);
  // The chief answered in the chat during the turn, so its own words are the record and hers are only spoken.
  assert.deepEqual([turn.said, turn.kept], ["That needs your own tap in the app.", false]);
  assert.deepEqual(w.said(space), ["paul (spoken): send abc123", "clearops: Typed approvals do not work here."]);
  assert.deepEqual(w.said(MAIN), [], "and nothing of it is in another conversation");
  assert.deepEqual(w.spoke, ["That needs your own tap in the app."]);
  // The chief's answer was given to her to pass on.
  assert.match(String(w.model.bodies[1]!.messages.at(-1)!.content), /ClearOps answered \(also posted in the chat\): Typed approvals do not work here\./);
});

test("when the chief has not answered in time she says so, and her words are kept because nothing else was said", async () => {
  const w = world({ heard: "Start a review of the billing code", streams: [[asks("Start a review of the billing code")], [words("It's on it. The answer will appear in the chat.")]] });
  const turn = await w.voice.turn(MAIN, AUDIO);
  assert.deepEqual([turn.said, turn.kept], ["It's on it. The answer will appear in the chat.", true]);
  assert.match(String(w.model.bodies[1]!.messages.at(-1)!.content), /ClearOps is still working on it/);
  assert.deepEqual(w.said(), ["paul (spoken): Start a review of the billing code", "clearops (spoken): It's on it. The answer will appear in the chat."]);
});

test("what could not be heard, answered or spoken is said plainly, and leaves no half-made record", async () => {
  // Not transcribed: nothing is kept, and the reason is given in plain words.
  const deaf = world({ heard: new TranscribeError("it is longer than I transcribe in one go") });
  await assert.rejects(deaf.voice.turn(MAIN, AUDIO), (e: unknown) => e instanceof WebVoiceError && e.status === 422 && e.message === "Cleo could not hear that: it is longer than I transcribe in one go.");
  assert.deepEqual(deaf.said(), []);
  const broken = world({ heard: new Error("ECONNRESET secret-token-123") });
  await assert.rejects(broken.voice.turn(MAIN, AUDIO), (e: unknown) => e instanceof WebVoiceError && e.message === "Cleo could not hear that just now.", "no raw error reaches him");
  // Silence: nothing heard, nothing asked, nothing kept.
  const quiet = world({ heard: "   " });
  assert.deepEqual(await quiet.voice.turn(MAIN, AUDIO), { heard: "", said: "", kept: false });
  assert.deepEqual([quiet.said(), quiet.model.bodies.length], [[], 0]);
  // The model failing: his words are kept, and he is told where they are.
  const mute = world({ heard: "Hello", streams: [] });
  mute.model.f = undefined as never;
  const failing = new WebVoice({ ask: async () => {}, tap: new VoiceTap(), chat: mute.chat, transcribe: async () => "Hello", speak: async () => Buffer.from("x"), fetch: (async () => new Response("no", { status: 500 })) as unknown as typeof fetch });
  await assert.rejects(failing.turn(MAIN, AUDIO), (e: unknown) => e instanceof WebVoiceError && e.status === 502 && /What you said is in the chat/.test(e.message));
  assert.deepEqual(mute.said(), ["paul (spoken): Hello"]);
  // The voice failing: her words are still returned and kept, without sound.
  const hoarse = world({ heard: "Hello", streams: [[words("Hello Paul.")]], speak: async () => { throw new Error("speech answered 500"); } });
  assert.deepEqual(await hoarse.voice.turn(MAIN, AUDIO), { heard: "Hello", said: "Hello Paul.", kept: true });
  // A turn after a failed one still works: nothing is left held.
  const again = world({ heard: "Hello", streams: [[words("Hello again.")]] });
  await assert.rejects(new WebVoice({ ask: async () => {}, tap: new VoiceTap(), chat: again.chat, transcribe: async () => { throw new TranscribeError("x"); } }).turn(MAIN, AUDIO));
  assert.equal((await again.voice.turn(MAIN, AUDIO)).said, "Hello again.");
});

test("one turn at a time, and the talk so far is remembered only while he keeps talking", async () => {
  let release: (v: string) => void = () => {};
  const chat = new WebChat();
  const model = fakeModel([[words("One.")], [words("Two.")], [words("Three.")]]);
  let now = Date.parse("2026-11-20T12:00:00.000Z");
  let first = true;
  const voice = new WebVoice({ ask: async () => {}, tap: new VoiceTap(), chat, transcribe: () => (first ? ((first = false), new Promise<string>((r) => (release = r))) : Promise.resolve("And again")), speak: async () => Buffer.from("x"), fetch: model.f, now: () => now });
  const slow = voice.turn(MAIN, AUDIO);
  await assert.rejects(voice.turn(MAIN, AUDIO), (e: unknown) => e instanceof WebVoiceError && e.status === 409, "a second turn is refused while the first is in hand");
  release("First thing");
  assert.equal((await slow).said, "One.");
  // The next turn carries the talk so far.
  await voice.turn(MAIN, AUDIO);
  assert.deepEqual(model.bodies[1]!.messages.slice(1), [{ role: "user", content: "First thing" }, { role: "assistant", content: "One." }, { role: "user", content: "And again" }]);
  // Another conversation starts from nothing.
  // After he has been quiet for as long as a voice call would wait, so does this one.
  now += (config.voice.idleMinutes + 1) * 60_000;
  await voice.turn(MAIN, AUDIO);
  assert.deepEqual(model.bodies[2]!.messages.slice(1), [{ role: "user", content: "And again" }]);
});

test("a spoken message is kept like any other, marked as speech, and is not taken for something the chief wrote", async () => {
  const chat = new WebChat();
  await chat.send(MAIN, "A written answer.");
  const written = chat.lastSaid(MAIN);
  await chat.spoken(MAIN, "paul", "What I said");
  await chat.spoken(MAIN, "clearops", "What Cleo said");
  assert.equal(chat.lastSaid(MAIN), written, "her speech is not the chief's writing");
  assert.deepEqual(chat.view(MAIN).messages.map((m) => [m.from, m.text, m.spoken]), [["clearops", "A written answer.", undefined], ["paul", "What I said", true], ["clearops", "What Cleo said", true]]);
  assert.equal(chat.lastSaid("web:space:self"), undefined);
  // Search finds what was said aloud, like anything else in the conversation.
  assert.deepEqual(chat.kept().filter((m) => m.spoken).map((m) => m.text), ["What I said", "What Cleo said"]);
});

test("the app is sent what was said aloud as plain text, marked as speech, never as markup", async () => {
  const { Store } = await import("../src/store.js");
  const { appChat } = await import("../src/app-data.js");
  const s = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-web-voice-store-")));
  const chat = new WebChat();
  await chat.spoken(MAIN, "paul", "What is <b>running</b>?");
  await chat.spoken(MAIN, "clearops", "Two jobs, and **one** is <i>stuck</i>.");
  await chat.send(MAIN, "A **written** answer.");
  const queue = { isHeld: () => false, queuePosition: () => undefined, latestStep: () => undefined, liveness: () => undefined, spendState: () => ({ usd: 0, source: "provider" as const, asOf: Date.now() }), capReached: () => false };
  const sent = appChat({ store: s, queue }, chat).messages;
  assert.deepEqual(sent.map((m) => [m.from, m.spoken, m.text, m.html === undefined]), [
    ["paul", true, "What is <b>running</b>?", true],
    ["clearops", true, "Two jobs, and **one** is <i>stuck</i>.", true],
    ["clearops", undefined, undefined, false],
  ]);
  const js = fs.readFileSync("public/app/app.js", "utf8");
  assert.match(js, /h\("div", \{ class: "said-aloud" \}, item\.message\.text\)/, "her words are drawn as text");
  assert.match(js, /h\("span", \{ class: "voice-said" \}, m\.text\)/, "and so are his");
});
