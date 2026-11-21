/**
 * Cleo in the web app (src/web-voice.ts): one spoken turn at a time. The same brain as the Discord voice
 * channel's, so what is spoken reaches the chief only through the voice prefix, and nothing said aloud
 * can approve anything. The recording is held in memory and kept nowhere.
 *
 * She is who he talks to, and the chief is who writes in the feeds: what is said aloud is her own
 * conversation, and when she has to ask the chief she says so at once and speaks again when he answers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-web-voice-"));

const { WebVoice, WebVoiceError, webVoiceAudio, WEB_VOICE_BYTES, WEB_VOICE_SYSTEM, WEB_VOICE_ASKING, WEB_VOICE_FOLLOW_KEEP_MS } = await import("../src/web-voice.js");
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

function world(o: { heard?: string | Error; streams?: string[][]; speak?: (t: string) => Promise<Buffer>; chief?: string; chiefAfterMs?: number; now?: () => number } = {}) {
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
        if (o.chiefAfterMs) await new Promise((r) => setTimeout(r, o.chiefAfterMs));
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
  voice.feeds((address) => (address === MAIN ? "Main" : "clear-ops"));
  /** What is written in one of the chief's feeds. */
  const said = (to = MAIN) => chat.view(to).messages.map((m) => `${m.from}${m.via ? ` (via ${m.via})` : ""}: ${m.text}`);
  /** Her conversation: what was said aloud, and which feed was open. */
  const aloud = () => chat.cleo().map((m) => `${m.from}${m.back ? " (back)" : ""} [${m.thread ?? MAIN}]: ${m.text}`);
  /** What she says on coming back, once she has. */
  const back = async (id: string | undefined) => {
    assert.ok(id, "she said she had gone to ask");
    for (let i = 0; i < 200; i++) {
      const f = voice.followUp(id);
      if (f?.ready) return f;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("she never came back");
  };
  return { chat, voice, asked, heardAudio, spoke, model, said, aloud, back };
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

test("Cleo answers small talk herself: his words and hers are her own conversation, and no feed of the chief's holds them", async () => {
  const w = world({ heard: "  Morning,\n Cleo. ", streams: [[words("Morning"), words(", Paul.")]] });
  const turn = await w.voice.turn(MAIN, AUDIO);
  assert.deepEqual(turn, { heard: "Morning, Cleo.", said: "Morning, Paul.", audio: Buffer.from("mp3:Morning, Paul.").toString("base64") });
  assert.deepEqual(w.aloud(), ["paul [web:main]: Morning, Cleo.", "clearops [web:main]: Morning, Paul."]);
  assert.deepEqual(w.said(), [], "nothing said aloud is in the chief's feed");
  assert.deepEqual(w.asked, [], "nothing was handed to the chief");
  assert.deepEqual(w.heardAudio, [{ bytes: AUDIO.data.length, name: "voice.webm", mimeType: "audio/webm" }]);
  // She is told who she is, who the chief is, which feed his answer goes to, and what she cannot do.
  const told = String(w.model.bodies[0]!.messages[0]!.content);
  assert.ok(told.startsWith(WEB_VOICE_SYSTEM));
  assert.match(told, /Marlo's written answer to anything you ask him now goes to the feed called "Main"\.$/);
  assert.match(WEB_VOICE_SYSTEM, /Marlo is the chief of staff/);
  assert.match(WEB_VOICE_SYSTEM, /make it plain that you checked with Marlo and this is his answer/);
  assert.match(WEB_VOICE_SYSTEM, /You cannot approve anything/);
  assert.doesNotMatch(WEB_VOICE_SYSTEM, /Discord|\u2014/);
  assert.deepEqual(w.model.bodies[0]!.messages.slice(1), [{ role: "user", content: "Morning, Cleo." }]);
});

test("she is shown the board as it stands at each turn, and answers from it herself without asking the chief", async () => {
  const w = world({ heard: "Are any jobs running right now?", streams: [[words("Nothing is running right now, Paul.")], [words("Still nothing.")], [words("Let me ask.")]] });
  let reads = 0;
  w.voice.sees(() => `The board as it stands, read ${++reads}.\nRunning now: nothing.`);
  const turn = await w.voice.turn(MAIN, AUDIO);
  assert.deepEqual([turn.said, turn.pending], ["Nothing is running right now, Paul.", undefined], "one answer, and no wait for the chief");
  assert.deepEqual(w.asked, []);
  assert.deepEqual(w.said(), [], "nothing was written in his feed");
  const told = String(w.model.bodies[0]!.messages[0]!.content);
  assert.ok(told.startsWith(WEB_VOICE_SYSTEM));
  assert.match(told, /\n\nThe board as it stands, read 1\.\nRunning now: nothing\.\n\nMarlo's written answer to anything you ask him now goes to the feed called "Main"\.$/);
  // It is read afresh for every turn, never remembered.
  await w.voice.turn(MAIN, AUDIO);
  assert.match(String(w.model.bodies[1]!.messages[0]!.content), /read 2\./);
  assert.doesNotMatch(String(w.model.bodies[1]!.messages[0]!.content), /read 1\./);
  // A board that cannot be read costs her nothing but the board: the turn is taken as before.
  w.voice.sees(() => { throw new Error("the store is busy"); });
  assert.equal((await w.voice.turn(MAIN, AUDIO)).said, "Let me ask.");
  assert.doesNotMatch(String(w.model.bodies[2]!.messages[0]!.content), /The board as it stands|store is busy/);
  // She is told what she may answer from it, and what she still cannot see.
  assert.match(WEB_VOICE_SYSTEM, /When Paul's question is answered by what the board says, answer it yourself straight away/);
  assert.match(WEB_VOICE_SYSTEM, /Say only what the board says: if it is not there, you do not know it\./);
  assert.match(WEB_VOICE_SYSTEM, /You cannot see inside a job or a report, and you cannot see his email, calendar, files or repositories\./);
});

test("when she has to ask the chief she says so at once, and speaks again when he has answered", async () => {
  const space = "web:space:self";
  const w = world({ heard: "What is running?", streams: [[words("Okay, I'll ask Marlo."), asks("What is running?")], [words("I checked with Marlo, and he says two jobs are running. The rest is in the clear-ops feed.")]], chief: "Two jobs are running: **a1** and **b2**.", chiefAfterMs: 30 });
  const turn = await w.voice.turn(space, AUDIO);
  // The turn comes back before the chief has answered, with what she said and a name to collect the rest.
  assert.equal(turn.said, "Okay, I'll ask Marlo.");
  assert.equal(turn.audio, Buffer.from("mp3:Okay, I'll ask Marlo.").toString("base64"));
  assert.match(String(turn.pending), /^[a-f0-9]{16}$/);
  // His feed has the question, in Paul's words and marked as asked through her, and no answer yet.
  assert.deepEqual(w.said(space), ["paul (via cleo): What is running?"]);
  assert.deepEqual(w.voice.followUp(turn.pending!), { ready: false });
  // While she waits on him, another turn is refused in plain words.
  await assert.rejects(w.voice.turn(space, AUDIO), (e: unknown) => e instanceof WebVoiceError && e.status === 409 && e.message === "Cleo is still waiting on Marlo. Give her a moment.");
  const back = await w.back(turn.pending);
  assert.deepEqual(back, { ready: true, said: "I checked with Marlo, and he says two jobs are running. The rest is in the clear-ops feed.", audio: Buffer.from(`mp3:${"I checked with Marlo, and he says two jobs are running. The rest is in the clear-ops feed."}`).toString("base64") });
  assert.deepEqual(w.voice.followUp(turn.pending!), back, "reading it changes nothing");
  // The chief's written answer is in his feed, and only there; what was said aloud is in hers, and only there.
  assert.deepEqual(w.said(space), ["paul (via cleo): What is running?", "clearops: Two jobs are running: **a1** and **b2**."]);
  assert.deepEqual(w.aloud(), ["paul [web:space:self]: What is running?", "clearops [web:space:self]: Okay, I'll ask Marlo.", "clearops (back) [web:space:self]: I checked with Marlo, and he says two jobs are running. The rest is in the clear-ops feed."]);
  assert.deepEqual(w.said(MAIN), []);
  // She was given his answer as his, and told which feed it is written in.
  assert.match(String(w.model.bodies[1]!.messages.at(-1)!.content), /^Marlo answered, and his answer in full is written in the feed\. He says: Two jobs are running/);
  assert.match(String(w.model.bodies[0]!.messages[0]!.content), /goes to the feed called "clear-ops"\.$/);
  // A name that was never given finds nothing.
  assert.deepEqual(w.voice.followUp("0".repeat(16)), undefined);
  assert.deepEqual(w.voice.followUp("../etc"), undefined);
});

test("what he asks for is handed to the chief under the voice prefix, as the app, for the feed he has open", async () => {
  const space = "web:space:self";
  const w = world({ heard: "send abc123", streams: [[asks("send abc123")], [words("Marlo says that needs your own tap in the app.")]], chief: "Typed approvals do not work here." });
  const turn = await w.voice.turn(space, AUDIO);
  // She found no words of her own for it, so she says the plain thing.
  assert.equal(turn.said, WEB_VOICE_ASKING);
  assert.equal((await w.back(turn.pending)).said, "Marlo says that needs your own tap in the app.");
  assert.equal(w.asked.length, 1);
  const { sender, address, text } = w.asked[0]!;
  assert.deepEqual([sender, address], [WEB_SENDER, space]);
  assert.ok(text.startsWith(`${VOICE_PREFIX} send abc123`));
  // Nothing said aloud can be an approval: no command matches what the chief is handed.
  assert.equal(parseOutboundCommand(text), undefined);
  assert.equal(parseDnsCommand(text), undefined);
  assert.equal(webRefusal(text), undefined, "it is not even mistaken for a typed approval: it is plainly a spoken request");
  assert.doesNotMatch(text, /^(yes|approve|ok|no|reject|buy|send|dns apply|signup apply|code|act as me)\b/i);
  assert.deepEqual(w.said(space), ["paul (via cleo): send abc123", "clearops: Typed approvals do not work here."]);
  assert.deepEqual(w.said(MAIN), [], "and nothing of it is in another feed");
  assert.deepEqual(w.spoke, [WEB_VOICE_ASKING, "Marlo says that needs your own tap in the app."]);
});

test("when the chief has not answered in time she comes back to say so, and that his answer will be in the feed", async () => {
  const w = world({ heard: "Start a review of the billing code", streams: [[words("I'll ask Marlo to start that."), asks("Start a review of the billing code")], [words("Marlo is on it. His answer will be written in the Main feed.")]] });
  const turn = await w.voice.turn(MAIN, AUDIO);
  assert.equal(turn.said, "I'll ask Marlo to start that.");
  assert.equal((await w.back(turn.pending)).said, "Marlo is on it. His answer will be written in the Main feed.");
  assert.match(String(w.model.bodies[1]!.messages.at(-1)!.content), /^Marlo is still working on it\./);
  assert.deepEqual(w.aloud(), ["paul [web:main]: Start a review of the billing code", "clearops [web:main]: I'll ask Marlo to start that.", "clearops (back) [web:main]: Marlo is on it. His answer will be written in the Main feed."]);
  assert.deepEqual(w.said(), ["paul (via cleo): Start a review of the billing code"], "the question waits in his feed for his answer");
});

test("if she cannot come back with his answer she says where it will be, and her speech is held only for a few minutes", async () => {
  let now = Date.parse("2026-11-21T09:00:00.000Z");
  const chat = new WebChat();
  let calls = 0;
  // The first call asks the chief; the second, which would put his answer into words, fails.
  const model = fakeModel([[words("Let me ask Marlo."), asks("How is spend?")]]);
  const f = (async (url: string, init: RequestInit) => (++calls === 1 ? model.f(url, init) : new Response("no", { status: 500 }))) as unknown as typeof fetch;
  const voice = new WebVoice({ ask: async () => {}, tap: new VoiceTap(), chat, transcribe: async () => "How is spend?", speak: async (t) => Buffer.from(t), fetch: f, answerWaitMs: 20, now: () => now });
  const turn = await voice.turn(MAIN, AUDIO);
  assert.equal(turn.said, "Let me ask Marlo.");
  let back = voice.followUp(turn.pending!);
  for (let i = 0; i < 200 && !back?.ready; i++) {
    await new Promise((r) => setTimeout(r, 5));
    back = voice.followUp(turn.pending!);
  }
  assert.equal(back?.said, "I could not get Marlo's answer just now. It will be written in his feed when he replies.");
  assert.deepEqual(chat.cleo().map((m) => m.text), ["How is spend?", "Let me ask Marlo.", back!.said]);
  now += WEB_VOICE_FOLLOW_KEEP_MS + 1;
  assert.equal(voice.followUp(turn.pending!), undefined, "her speech is not kept past a few minutes");
});

test("what could not be heard, answered or spoken is said plainly, and leaves no half-made record", async () => {
  // Not transcribed: nothing is kept, and the reason is given in plain words.
  const deaf = world({ heard: new TranscribeError("it is longer than I transcribe in one go") });
  await assert.rejects(deaf.voice.turn(MAIN, AUDIO), (e: unknown) => e instanceof WebVoiceError && e.status === 422 && e.message === "Cleo could not hear that: it is longer than I transcribe in one go.");
  assert.deepEqual(deaf.aloud(), []);
  const broken = world({ heard: new Error("ECONNRESET secret-token-123") });
  await assert.rejects(broken.voice.turn(MAIN, AUDIO), (e: unknown) => e instanceof WebVoiceError && e.message === "Cleo could not hear that just now.", "no raw error reaches him");
  // Silence: nothing heard, nothing asked, nothing kept.
  const quiet = world({ heard: "   " });
  assert.deepEqual(await quiet.voice.turn(MAIN, AUDIO), { heard: "", said: "" });
  assert.deepEqual([quiet.aloud(), quiet.model.bodies.length], [[], 0]);
  // The model failing: his words are kept, and he is told where they are.
  const mute = world({ heard: "Hello", streams: [] });
  const failing = new WebVoice({ ask: async () => {}, tap: new VoiceTap(), chat: mute.chat, transcribe: async () => "Hello", speak: async () => Buffer.from("x"), fetch: (async () => new Response("no", { status: 500 })) as unknown as typeof fetch });
  await assert.rejects(failing.turn(MAIN, AUDIO), (e: unknown) => e instanceof WebVoiceError && e.status === 502 && /What you said is in her conversation/.test(e.message));
  assert.deepEqual(mute.aloud(), ["paul [web:main]: Hello"]);
  // The voice failing: her words are still returned and kept, without sound.
  const hoarse = world({ heard: "Hello", streams: [[words("Hello Paul.")]], speak: async () => { throw new Error("speech answered 500"); } });
  assert.deepEqual(await hoarse.voice.turn(MAIN, AUDIO), { heard: "Hello", said: "Hello Paul." });
  assert.deepEqual(hoarse.aloud(), ["paul [web:main]: Hello", "clearops [web:main]: Hello Paul."]);
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

test("what is said aloud is Cleo's own conversation: no feed shows it, counts it or marks it as something new", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-web-voice-chat-"));
  const chat = new WebChat({ dir });
  const space = "web:space:self";
  await chat.send(MAIN, "A written answer.");
  await chat.send(space, "Written in the space.");
  const before = { main: chat.mainSaidAt(), threads: JSON.stringify([...chat.threads()]) };
  await chat.spoken(MAIN, "paul", "What I said");
  await chat.spoken(space, "clearops", "What Cleo said", true);
  assert.deepEqual(chat.view(MAIN).messages.map((m) => m.text), ["A written answer."]);
  assert.deepEqual(chat.view(space).messages.map((m) => m.text), ["Written in the space."]);
  assert.deepEqual({ main: chat.mainSaidAt(), threads: JSON.stringify([...chat.threads()]) }, before, "her speech is not the chief's writing, and marks nothing as new");
  assert.deepEqual(chat.cleo().map((m) => [m.from, m.text, m.thread, m.spoken, m.back]), [["paul", "What I said", undefined, true, undefined], ["clearops", "What Cleo said", space, true, true]]);
  // Search finds what was said aloud, like anything else that is kept.
  assert.deepEqual(chat.kept().filter((m) => m.spoken).map((m) => m.text), ["What I said", "What Cleo said"]);
  // It is kept across a restart, still hers.
  const again = new WebChat({ dir });
  assert.deepEqual(again.cleo().map((m) => m.text), ["What I said", "What Cleo said"]);
  assert.deepEqual(again.view(MAIN).messages.map((m) => m.text), ["A written answer."]);
  // A feed keeps its own count: a long talk with her pushes nothing out of it.
  for (let i = 0; i < 30; i++) await chat.spoken("web:job:abc", "paul", `said ${i}`);
  assert.deepEqual(chat.view(MAIN).messages.map((m) => m.text), ["A written answer."]);
});

test("the app is sent her conversation as plain text, with the way to the chief's feed on what she reported back", async () => {
  const { Store } = await import("../src/store.js");
  const { appChat } = await import("../src/app-data.js");
  const { appCleo } = await import("../src/app-search.js");
  const s = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-web-voice-store-")));
  const chat = new WebChat();
  const own = chat.open("Pricing ideas")!;
  await chat.spoken(MAIN, "paul", "What is <b>running</b>?");
  await chat.spoken(MAIN, "clearops", "Okay, I'll ask Marlo.");
  await chat.spoken(`web:chat:${own.id}`, "clearops", "I checked with Marlo: two jobs, and **one** is <i>stuck</i>.", true);
  await chat.spoken("web:space:gone-space", "clearops", "Marlo says it is done.", true);
  await chat.send(MAIN, "A **written** answer.");
  const queue = { isHeld: () => false, queuePosition: () => undefined, latestStep: () => undefined, liveness: () => undefined, spendState: () => ({ usd: 0, source: "provider" as const, asOf: Date.now() }), capReached: () => false };
  const source = { store: s, queue, voice: () => true };
  // The chief's feed holds what he wrote, and nothing that was said aloud.
  assert.deepEqual(appChat(source, chat).messages.map((m) => [m.from, m.text, m.html === undefined]), [["clearops", undefined, false]]);
  // What she asked him for is there as Paul's own words, marked as asked through her, and as text.
  chat.asked(MAIN, "What is <b>running</b>?");
  assert.deepEqual(appChat(source, chat).messages.at(-1), { id: appChat(source, chat).messages.at(-1)!.id, at: appChat(source, chat).messages.at(-1)!.at, from: "paul", text: "What is <b>running</b>?", via: "cleo" });
  const talk = appCleo(source, chat);
  assert.equal(talk.on, true);
  assert.deepEqual(talk.messages.map((m) => [m.from, m.text, m.feed]), [
    ["paul", "What is <b>running</b>?", undefined],
    ["clearops", "Okay, I'll ask Marlo.", undefined],
    ["clearops", "I checked with Marlo: two jobs, and **one** is <i>stuck</i>.", { where: { in: "chat", id: own.id }, title: "Pricing ideas" }],
    // A feed that is no longer there is not offered.
    ["clearops", "Marlo says it is done.", undefined],
  ]);
  assert.ok(talk.messages.every((m) => !("html" in m)), "nothing she said is sent as markup");
  assert.equal(appCleo({ store: s, queue }, chat).on, false);
  const js = fs.readFileSync("public/app/app.js", "utf8");
  assert.match(js, /h\("div", \{ class: "said-aloud" \}, m\.text\)/, "her words are drawn as text");
  assert.match(js, /if \(m\.from === "paul"\) out\.push\(h\("div", \{ class: "mine" \}, h\("div", \{ class: "bubble" \}, m\.text\)\)\);/, "and so are his");
  assert.doesNotMatch(js, /item\.message\.spoken|Said to \$\{CLEO\}/, "the chief's feed draws nothing as spoken");
});
