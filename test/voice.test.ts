import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { parseOutboundCommand } from "../src/outbound.js";
import { parseDnsCommand } from "../src/dns-gate.js";
import { config } from "../src/config.js";
import { InputPump, VOICE_FRAME_BYTES, VoiceBrain, VoiceTap, discordToVoice, speakable, voiceAuthorised, voiceRequestText, voiceToDiscord } from "../src/voice.js";

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

test("the voice brain's routes need the voice key", () => {
  assert.equal(voiceAuthorised("Bearer k1", "k1"), true);
  assert.equal(voiceAuthorised("Bearer k2", "k1"), false);
  assert.equal(voiceAuthorised("k1", "k1"), false);
  assert.equal(voiceAuthorised("Bearer ", ""), false);
  assert.equal(voiceAuthorised(undefined, "k1"), false);
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
  assert.equal(out.join(""), "One moment.Two jobs are running.");
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
  tap.saw("dc:c:9", "Started research on Prebid 11.");
  out.length = 0;
  await brain.reply([{ role: "assistant", content: "It's on it." }, { role: "user", content: "..." }], (t) => out.push(t));
  assert.equal(out.join(""), "The research is done.");
  assert.match((bodies[2].messages as Array<{ content: string }>)[0].content, /News from ClearOps[\s\S]*Started research on Prebid 11/);
});

test("the brain greets on the opening turn and stays silent on a pause with no news", async () => {
  const { f, bodies } = fakeOpenRouter([]);
  const brain = new VoiceBrain({ ask: async () => undefined, tap: new VoiceTap(), fetch: f });
  brain.setSession({ address: "dc:c:9", sender: "dc:u:1" });
  const out: string[] = [];
  await brain.reply([{ role: "system", content: "x" }, { role: "user", content: "Hello." }], (t) => out.push(t));
  assert.equal(out.join(""), "Hi Paul, it's Cleo. I'm listening.");
  out.length = 0;
  await brain.reply([{ role: "assistant", content: "Hi Paul, it's Cleo. I'm listening." }, { role: "user", content: "..." }], (t) => out.push(t));
  assert.equal(out.join(""), "");
  assert.equal(bodies.length, 0, "no model call for a greeting or a quiet pause");
});

test("the HTTP endpoint refuses without the key and streams OpenAI chunks with it", async () => {
  const saved = { key: config.voice.key, or: config.openrouter.apiKey };
  config.voice.key = "vk";
  config.openrouter.apiKey = "or";
  const { f } = fakeOpenRouter([[text("Hello there.")]]);
  const brain = new VoiceBrain({ ask: async () => undefined, tap: new VoiceTap(), fetch: f });
  brain.setSession({ address: "dc:c:9", sender: "dc:u:1" });
  const app = express();
  app.use(express.json());
  brain.mount(app);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/voice/v1/models`)).status, 401);
    assert.equal((await fetch(`${base}/voice/v1/models`, { headers: { Authorization: "Bearer nope" } })).status, 401);
    const models = await (await fetch(`${base}/voice/v1/models`, { headers: { Authorization: "Bearer vk" } })).json();
    assert.equal(models.data[0].id, "clearops-voice");
    const r = await fetch(`${base}/voice/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: "Bearer vk", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "clearops-voice", stream: true, messages: [{ role: "assistant", content: "Hi" }, { role: "user", content: "hello" }] }),
    });
    const body = await r.text();
    assert.match(body, /"content":"Hello there\."/);
    assert.match(body, /"finish_reason":"stop"/);
    assert.match(body, /data: \[DONE\]/);
  } finally {
    server.close();
    config.voice.key = saved.key;
    config.openrouter.apiKey = saved.or;
  }
});

test("speakable strips links, mentions, markdown and dashes", () => {
  assert.equal(speakable("See <#12> and [the PR](https://github.com/x) — **done**: https://a.b/c"), "See the chat and the PR, done: the link in chat");
});

test("audio conversion: 48 kHz stereo to 24 kHz mono and back", () => {
  const stereo = Buffer.alloc(3840); // 20 ms at 48 kHz stereo
  for (let i = 0; i < 960; i++) {
    stereo.writeInt16LE(1000, i * 4);
    stereo.writeInt16LE(3000, i * 4 + 2);
  }
  const mono = discordToVoice(stereo);
  assert.equal(mono.length, VOICE_FRAME_BYTES);
  assert.equal(mono.readInt16LE(0), 2000);
  const back = voiceToDiscord(mono, { last: 2000 });
  assert.equal(back.length, 3840);
  assert.equal(back.readInt16LE(0), 2000);
  assert.equal(back.readInt16LE(2), 2000);
});

test("the input pump pads with silence and drops a long backlog", () => {
  const pump = new InputPump();
  assert.deepEqual(pump.frame(), Buffer.alloc(VOICE_FRAME_BYTES));
  pump.push(Buffer.alloc(100, 1));
  const f = pump.frame();
  assert.equal(f[0], 1);
  assert.equal(f[99], 1);
  assert.equal(f[100], 0);
  for (let i = 0; i < 100; i++) pump.push(Buffer.alloc(VOICE_FRAME_BYTES, 2));
  let frames = 0;
  while (pump.frame()[0] === 2) frames++;
  assert.ok(frames <= 25, `backlog capped at half a second, got ${frames} frames`);
});
