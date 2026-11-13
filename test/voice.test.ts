import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { parseOutboundCommand } from "../src/outbound.js";
import { parseDnsCommand } from "../src/dns-gate.js";
import { config } from "../src/config.js";
import { SentenceSplitter, VoiceBrain, VoiceTap, decodeToDiscord, discordToVoice, level, speak, speakable, voiceRequestText, wav } from "../src/voice.js";

/** A fetch that answers OpenRouter with the given SSE streams, one per call, and records the bodies. */
function fakeOpenRouter(streams: string[][]) {
  const bodies: Array<Record<string, unknown>> = [];
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
const text = (t: string) => JSON.stringify({ choices: [{ delta: { content: t } }] });
const toolCall = (args: string) => JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "ask_clearops", arguments: args } }] } }] });

test("a spoken request can never be an approval command", () => {
  for (const said of ["send abc123", "send it", "dns apply abc123", "yes abc123", "approve abc123", "cancel abc123", "/reset", "buy abc123"]) {
    const t = voiceRequestText(said);
    assert.equal(parseOutboundCommand(t), undefined, said);
    assert.equal(parseDnsCommand(t), undefined, said);
    assert.doesNotMatch(t, /^(yes|approve|ok|no|reject)\s+([a-f0-9]{6})\b/i, said);
    assert.doesNotMatch(t, /^\//, said);
  }
});

test("the tap passes sends through, hands the next reply to a waiter and keeps the rest as news", async () => {
  const sent: string[] = [];
  const tap = new VoiceTap();
  const m = tap.wrap({ send: async (to: string, t: string) => void sent.push(`${to}|${t}`) });
  tap.watch("dc:c:1");
  const next = tap.next("dc:c:1", 1000);
  await m.send("dc:c:1", "first answer");
  assert.equal(await next, "first answer");
  await m.send("dc:c:1", "a job finished");
  await m.send("dc:c:2", "elsewhere");
  assert.deepEqual(sent, ["dc:c:1|first answer", "dc:c:1|a job finished", "dc:c:2|elsewhere"]);
  assert.deepEqual(tap.takeNews("dc:c:1"), ["a job finished"]);
  assert.deepEqual(tap.takeNews("dc:c:1"), []);
  assert.deepEqual(tap.takeNews("dc:c:2"), []);
  assert.equal(await tap.next("dc:c:1", 10), undefined);
});

test("the brain answers small talk itself, streamed", async () => {
  const { f, bodies } = fakeOpenRouter([[text("Morning"), text(", Paul.")]]);
  const brain = new VoiceBrain({ ask: async () => assert.fail("should not ask"), tap: new VoiceTap(), fetch: f });
  brain.setSession({ address: "dc:c:9", sender: "dc:u:1" });
  const out: string[] = [];
  await brain.reply([{ role: "system", content: "Unmute's own prompt" }, { role: "assistant", content: "Hi Paul, it's Cleo. I'm listening." }, { role: "user", content: "Morning" }], (t) => out.push(t));
  assert.equal(out.join(""), "Morning, Paul.");
  const msgs = bodies[0].messages as Array<{ role: string; content: string }>;
  assert.match(msgs[0].content, /You are Cleo/);
  assert.ok(!msgs.some((m) => m.content === "Unmute's own prompt"), "Unmute's system prompt is replaced");
  assert.ok(Array.isArray(bodies[0].tools));
});

test("the brain hands work to ClearOps as a voice request and speaks the answer", async () => {
  const { f, bodies } = fakeOpenRouter([[text("One moment."), toolCall('{"request":"what jobs are running"}')], [text("Two jobs are running.")]]);
  const tap = new VoiceTap();
  const asked: string[] = [];
  const brain = new VoiceBrain({
    ask: async (sender, address, t) => {
      asked.push(`${sender}|${address}|${t}`);
      tap.saw(address, "Two running: <#123> research and the Fly deploy. https://example.com/x");
    },
    tap,
    fetch: f,
  });
  brain.setSession({ address: "dc:c:9", sender: "dc:u:1" });
  const out: string[] = [];
  await brain.reply([{ role: "assistant", content: "Hi" }, { role: "user", content: "what's running" }], (t) => out.push(t));
  assert.equal(asked.length, 1);
  assert.ok(asked[0].startsWith("dc:u:1|dc:c:9|Voice request from Paul"));
  assert.match(asked[0], /what jobs are running$/);
  assert.equal(out.join(""), "One moment. Two jobs are running.");
  const second = bodies[1].messages as Array<{ role: string; content: string }>;
  const tool = second.find((m) => m.role === "tool")!;
  assert.match(tool.content, /ClearOps answered/);
  assert.doesNotMatch(tool.content, /https?:|<#/);
  assert.equal(bodies[1].tools, undefined);
});

test("a slow answer is promised in chat and passed on later as news", async () => {
  const { f, bodies } = fakeOpenRouter([[toolCall('{"request":"research Prebid 11"}')], [text("It's on it.")], [text("The research is done.")]]);
  const tap = new VoiceTap();
  const brain = new VoiceBrain({ ask: async () => undefined, tap, fetch: f, answerWaitMs: 20 });
  brain.setSession({ address: "dc:c:9", sender: "dc:u:1" });
  const out: string[] = [];
  await brain.reply([{ role: "assistant", content: "Hi" }, { role: "user", content: "research prebid eleven" }], (t) => out.push(t));
  const tool = (bodies[1].messages as Array<{ role: string; content: string }>).find((m) => m.role === "tool")!;
  assert.match(tool.content, /still working/);
  assert.ok(out.join("").startsWith("One moment. "), "Paul hears something straight away, with a trailing space so Unmute speaks it");
  tap.saw("dc:c:9", "Started research on Prebid 11.");
  out.length = 0;
  await brain.reply([{ role: "assistant", content: "It's on it." }, { role: "user", content: "..." }], (t) => out.push(t));
  assert.equal(out.join(""), "The research is done.");
  assert.match((bodies[2].messages as Array<{ content: string }>)[0].content, /News from ClearOps[\s\S]*Started research on Prebid 11/);
});

test("a pause with no news costs nothing and says nothing", async () => {
  const { f, bodies } = fakeOpenRouter([]);
  const brain = new VoiceBrain({ ask: async () => undefined, tap: new VoiceTap(), fetch: f });
  brain.setSession({ address: "dc:c:9", sender: "dc:u:1" });
  const out: string[] = [];
  await brain.reply([{ role: "assistant", content: "Hi Paul, it's Cleo." }, { role: "user", content: "..." }], (t) => out.push(t));
  assert.equal(out.join(""), "");
  assert.equal(bodies.length, 0);
});

test("news arriving while Paul is quiet is announced", async () => {
  const tap = new VoiceTap();
  const announced: string[] = [];
  const brain = new VoiceBrain({ ask: async () => undefined, tap, fetch: fakeOpenRouter([]).f });
  brain.setSession({ address: "dc:c:9", sender: "dc:u:1" });
  brain.onNews((a) => announced.push(a));
  tap.saw("dc:c:9", "The research job finished.");
  tap.saw("dc:c:7", "not the voice channel");
  assert.deepEqual(announced, ["dc:c:9"]);
});

test("speakable strips links, mentions, markdown and dashes", () => {
  assert.equal(speakable("See <#12> and [the PR](https://github.com/x) — **done**: https://a.b/c"), "See the chat and the PR, done: the link in chat");
});

test("audio: 48 kHz stereo to 24 kHz mono, a WAV header, and the level of a turn", () => {
  const stereo = Buffer.alloc(3840); // 20 ms at 48 kHz stereo
  for (let i = 0; i < 960; i++) {
    stereo.writeInt16LE(1000, i * 4);
    stereo.writeInt16LE(3000, i * 4 + 2);
  }
  const mono = discordToVoice(stereo);
  assert.equal(mono.length, 960);
  assert.equal(mono.readInt16LE(0), 2000);
  const file = wav(mono);
  assert.equal(file.toString("ascii", 0, 4), "RIFF");
  assert.equal(file.toString("ascii", 8, 12), "WAVE");
  assert.equal(file.readUInt32LE(24), 24000);
  assert.equal(file.readUInt32LE(40), mono.length);
  assert.equal(file.length, 44 + mono.length);
  assert.ok(Math.abs(level(mono) - 2000 / 32768) < 1e-6);
  assert.equal(level(Buffer.alloc(100)), 0);
});

test("sentences are spoken as soon as each is complete", () => {
  const got: string[] = [];
  const s = new SentenceSplitter((x) => got.push(x));
  s.push("One moment. Two jobs");
  assert.deepEqual(got, ["One moment."]);
  s.push(" are running: research and the deploy! Anything");
  assert.deepEqual(got, ["One moment.", "Two jobs are running: research and the deploy!"]);
  s.push(" else");
  s.flush();
  assert.deepEqual(got, ["One moment.", "Two jobs are running: research and the deploy!", "Anything else"]);
  s.flush();
  assert.equal(got.length, 3);
});

test("speech goes to OpenRouter's speech endpoint with the configured model and voice", async () => {
  let url = "";
  let body: Record<string, unknown> = {};
  const f = (async (u: string, init: RequestInit) => {
    url = u;
    body = JSON.parse(String(init.body));
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  }) as unknown as typeof fetch;
  const mp3 = await speak("Hello Paul.", f);
  assert.equal(url, "https://openrouter.ai/api/v1/audio/speech");
  assert.equal(body.input, "Hello Paul.");
  assert.equal(body.model, config.voice.ttsModel);
  assert.equal(body.voice, config.voice.ttsVoice);
  assert.equal(body.response_format, "mp3");
  assert.deepEqual([...mp3], [1, 2, 3]);
  const bad = (async () => new Response("nope", { status: 402 })) as unknown as typeof fetch;
  await assert.rejects(speak("x", bad), /402/);
});

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("an MP3 decodes to Discord's 48 kHz stereo PCM", { skip: !hasFfmpeg && "ffmpeg is not installed here" }, async () => {
  const mp3 = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.5", "-f", "mp3", "pipe:1"]);
  const pcm = await decodeToDiscord(mp3);
  const seconds = pcm.length / (48000 * 4);
  assert.ok(seconds > 0.4 && seconds < 0.7, `about half a second, got ${seconds}`);
  assert.ok(level(pcm) > 0.05);
  await assert.rejects(decodeToDiscord(Buffer.from("not audio")));
});
