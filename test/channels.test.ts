import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.ALLOWED_DISCORD_IDS = "424242";
process.env.CHANNELS = "telegram,discord";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-ch-"));

const { RouterMessenger } = await import("../src/channels.js");
const { DiscordListener, dcChannel, dcUser } = await import("../src/discord.js");
const { plainText } = await import("../src/telegram.js");
const { isAllowed, config } = await import("../src/config.js");
const { Store } = await import("../src/store.js");
const { JobRunner } = await import("../src/jobs.js");
const { Orchestrator } = await import("../src/orchestrator.js");
const { Scheduler } = await import("../src/scheduler.js");
const { ConsoleMessenger } = await import("../src/whatsapp.js");
import type { AgentRunner } from "../src/agents.js";

/** A messenger that records sends and can open threads, standing in for Discord. */
class ThreadMessenger extends ConsoleMessenger {
  threads: string[] = [];
  async openThread(replyTo: string, messageId: string, name: string): Promise<string | undefined> {
    if (!replyTo.startsWith("dc:c:")) return undefined;
    const t = `dc:c:thread-${messageId}`;
    this.threads.push(`${t} ${name}`);
    return t;
  }
}

const waitFor = async (pred: () => boolean, ms = 2000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

test("config runs both channels and the allowlist spans them", () => {
  assert.deepEqual(config.channels, ["telegram", "discord"]);
  assert.equal(isAllowed(dcUser("424242")), true);
  assert.equal(isAllowed("tg:99887766"), true);
  assert.equal(isAllowed(dcUser("1")), false);
});

test("the router picks a messenger by address prefix", async () => {
  const tg = new ConsoleMessenger();
  const dc = new ThreadMessenger();
  const router = new RouterMessenger([
    { prefix: "tg:", messenger: tg },
    { prefix: "dc:", messenger: dc },
  ]);
  await router.send("tg:1", "a");
  await router.send("dc:c:2", "b");
  assert.equal(tg.sent[0].text, "a");
  assert.equal(dc.sent[0].text, "b");
  assert.equal(await router.openThread("tg:1", "m", "n"), undefined, "Telegram has no threads");
  assert.equal(await router.openThread("dc:c:2", "m", "n"), "dc:c:thread-m");
  await assert.rejects(() => router.send("447", "c"), /No channel can deliver/);
});

test("Discord messages route to the conversation they came from; unlisted users get the id hint once", async () => {
  const handled: Array<{ from: string; text: string; ctx: unknown }> = [];
  const listener = new DiscordListener(async (from, text, ctx) => void handled.push({ from, text, ctx }), isAllowed);
  const sent: string[] = [];
  const channel = { send: async (t: string) => void sent.push(t) };
  await listener.onMessage({ author: { id: "424242", bot: false }, content: "hello", channelId: "chan1", id: "msg1", channel } as any);
  assert.deepEqual(handled[0], { from: "dc:u:424242", text: "hello", ctx: { replyTo: "dc:c:chan1", messageId: "msg1" } });
  await listener.onMessage({ author: { id: "7", bot: false }, content: "hi", channelId: "chan1", id: "msg2", channel } as any);
  await listener.onMessage({ author: { id: "7", bot: false }, content: "hi again", channelId: "chan1", id: "msg3", channel } as any);
  assert.equal(handled.length, 1);
  assert.deepEqual(sent, ["This bot only answers its operator. Your Discord user id is 7."]);
  await listener.onMessage({ author: { id: "424242", bot: true }, content: "bot echo", channelId: "chan1", id: "msg4", channel } as any);
  assert.equal(handled.length, 1, "bots are ignored");
});

test("a job started from a Discord channel gets its own thread, and the maintainer reports there too", async () => {
  const store = new Store(process.env.DATA_DIR!);
  const messenger = new ThreadMessenger();
  const runner: AgentRunner = async (o) => {
    const ops = o.mcpServers?.ops as any;
    if (ops) {
      const handler = ops.instance?._registeredTools?.start_job?.callback ?? ops.instance?._registeredTools?.start_job?.handler;
      const r = await handler({ kind: "engineer", brief: "Build the /offers endpoint", target: "product" }, {});
      return { text: `Delegated. ${r.content[0].text}`, sessionId: "s-thread" };
    }
    return { text: "done", costUsd: 0.01 };
  };
  const jobs = new JobRunner(store, messenger, runner);
  const orch = new Orchestrator(store, messenger, jobs, new Scheduler(store, jobs), runner);
  await orch.handle(dcUser("424242"), "build the offers endpoint", { replyTo: dcChannel("chan1"), messageId: "msg9" });

  const eng = store.listJobs(20).find((j) => j.kind === "engineer")!;
  assert.equal(eng.replyTo, "dc:c:thread-msg9");
  assert.match(messenger.threads[0], /^dc:c:thread-msg9 engineer: Build the \/offers endpoint/);
  assert.equal(store.getSession(dcChannel("chan1")), "s-thread", "the session is keyed by the conversation, not the user");
  await waitFor(() => store.listJobs(20).some((j) => j.kind === "maintain" && j.status === "done"));
  const maint = store.listJobs(20).find((j) => j.kind === "maintain")!;
  assert.equal(maint.replyTo, "dc:c:thread-msg9", "the maintainer inherits the engineer's thread");
  const inThread = messenger.sent.filter((m) => m.to === "dc:c:thread-msg9").map((m) => m.text);
  assert.ok(inThread.some((t) => t.startsWith(`Job ${eng.id} (engineer) started`)));
  assert.ok(inThread.some((t) => t.startsWith(`Job ${eng.id} (engineer) finished`)));
  assert.ok(inThread.some((t) => t.startsWith(`Job ${maint.id} (maintain) finished`)));
  const inChannel = messenger.sent.filter((m) => m.to === "dc:c:chan1").map((m) => m.text);
  assert.ok(inChannel.some((t) => t.startsWith("Delegated.")), "the chief's reply goes to the channel");
});

test("jobs left running by a restart are re-queued with a resume note, and give up after three restarts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-resume-"));
  let store = new Store(dir);
  const j1 = store.createJob("engineer", "Finish the catalogue", "dc:u:424242", "product", "dc:c:t1");
  store.updateJob(j1.id, { status: "running" });
  const j2 = store.createJob("research", "Old one", "tg:99887766");
  store.updateJob(j2.id, { status: "running", resumed: 3 });

  store = new Store(dir); // a fresh process reading the same volume
  const messenger = new ConsoleMessenger();
  const prompts: string[] = [];
  const runner: AgentRunner = async (o) => {
    prompts.push(o.prompt);
    return { text: "resumed and finished" };
  };
  const jobs = new JobRunner(store, messenger, runner);
  const n = await jobs.resumeInterrupted();
  assert.equal(n, 2);
  await waitFor(() => store.getJob(j1.id)?.status === "done");
  assert.equal(store.getJob(j1.id)!.resumed, 1);
  assert.match(prompts[0], /interrupted by a service restart.*check the working directory, git status and branches/s);
  assert.ok(messenger.sent.some((m) => m.to === "dc:c:t1" && /was interrupted by a restart. Resuming/.test(m.text)));
  assert.equal(store.getJob(j2.id)!.status, "failed");
  assert.ok(messenger.sent.some((m) => m.to === "tg:99887766" && /three times/.test(m.text)));
});

test("Telegram output drops Markdown markers it would otherwise show literally", () => {
  assert.equal(plainText("- **Query:** one endpoint\n## Heading\n__under__"), "• Query: one endpoint\nHeading\nunder");
});
