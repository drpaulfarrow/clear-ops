import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.ALLOWED_DISCORD_IDS = "424242";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-dcthreads-"));

const { ChannelType, ThreadAutoArchiveDuration } = await import("discord.js");
const { DiscordMessenger, JOB_THREAD_ARCHIVE_MINUTES } = await import("../src/discord.js");
const { RouterMessenger, threadMention } = await import("../src/channels.js");
const { Store } = await import("../src/store.js");
const { JobRunner } = await import("../src/jobs.js");
const { Orchestrator } = await import("../src/orchestrator.js");
const { Scheduler } = await import("../src/scheduler.js");
const { ConsoleMessenger } = await import("../src/whatsapp.js");
import type { AgentRunner } from "../src/agents.js";

const FOUNDER = "tg:99887766";
const PR = "https://github.com/acme/clear-exchange/pull/9";
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

const waitFor = async (pred: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** Captures console.warn while `fn` runs. */
async function warnings<T>(fn: () => Promise<T>): Promise<{ result: T | undefined; error: unknown; logged: string[] }> {
  const logged: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
  try {
    return { result: await fn(), error: undefined, logged };
  } catch (error) {
    return { result: undefined, error, logged };
  } finally {
    console.warn = orig;
  }
}

/**
 * A stand-in for the discord.js client: one text channel "100" with messages, a thread "200"
 * inside it, a DM channel "300", and threads that record how they were opened. Like Discord, a
 * message can carry only one thread.
 */
function fakeDiscord(opts: { startThreadFails?: boolean; createFails?: boolean } = {}) {
  let next = 1000;
  const opened: Array<{ id: string; how: "message" | "channel"; on?: string; name: string; autoArchiveDuration: number }> = [];
  const sent: Array<{ to: string; text: string }> = [];
  const hasThread = new Set<string>();
  const threads = new Map<string, any>();
  const makeThread = (id: string, parent: any, archived = false) => {
    const t: any = {
      id,
      type: ChannelType.PublicThread,
      archived,
      locked: false,
      parent,
      isThread: () => true,
      isTextBased: () => true,
      async setArchived(a: boolean) {
        t.archived = a;
      },
      async send(text: string) {
        sent.push({ to: id, text });
      },
    };
    threads.set(id, t);
    return t;
  };
  const text: any = {
    id: "100",
    type: ChannelType.GuildText,
    isThread: () => false,
    isTextBased: () => true,
    async send(t: string) {
      sent.push({ to: "100", text: t });
    },
    messages: {
      async fetch(mid: string) {
        return {
          get hasThread() {
            return hasThread.has(mid);
          },
          async startThread(o: { name: string; autoArchiveDuration: number }) {
            if (opts.startThreadFails) throw new Error("Missing Permissions");
            if (hasThread.has(mid)) throw new Error("A thread has already been created for this message");
            hasThread.add(mid);
            const id = String(next++);
            opened.push({ id, how: "message", on: mid, name: o.name, autoArchiveDuration: o.autoArchiveDuration });
            makeThread(id, text);
            return { id };
          },
        };
      },
    },
    threads: {
      async create(o: { name: string; autoArchiveDuration: number; type: number }) {
        if (opts.createFails) throw new Error("Missing Access");
        assert.equal(o.type, ChannelType.PublicThread);
        const id = String(next++);
        opened.push({ id, how: "channel", name: o.name, autoArchiveDuration: o.autoArchiveDuration });
        makeThread(id, text);
        return { id };
      },
    },
  };
  makeThread("200", text);
  makeThread("250", text, true);
  const dm: any = { id: "300", type: ChannelType.DM, isThread: () => false, isTextBased: () => true, async send() {} };
  const client: any = {
    channels: {
      async fetch(id: string) {
        if (id === "100") return text;
        if (id === "300") return dm;
        return threads.get(id) ?? null;
      },
    },
    users: { async fetch() { return { send: async () => undefined }; } },
  };
  return { messenger: new DiscordMessenger(client), opened, sent, threads, hasThread };
}

test("job threads auto-archive after a week, not a day", () => {
  assert.equal(JOB_THREAD_ARCHIVE_MINUTES, ThreadAutoArchiveDuration.OneWeek);
  assert.equal(JOB_THREAD_ARCHIVE_MINUTES, 10080);
});

test("several jobs from one message each get their own named thread", async () => {
  const d = fakeDiscord();
  const names = ["Fly deploy", "TollBit research", "Pitch deck", "Inbox triage", "Web UI restyle", "Docs site"];
  const got = await Promise.all(names.map((n) => d.messenger.openThread("dc:c:100", "m1", n)));
  assert.equal(new Set(got).size, 6, "six distinct threads");
  assert.ok(got.every((a) => a && /^dc:c:\d+$/.test(a)));
  assert.equal(d.opened.filter((o) => o.how === "message").length, 1, "only one thread hangs off the message");
  assert.equal(d.opened.filter((o) => o.how === "channel").length, 5, "the rest are standalone threads in the channel");
  assert.deepEqual(d.opened.map((o) => o.name).sort(), [...names].sort(), "each is named after its job");
  assert.ok(d.opened.every((o) => o.autoArchiveDuration === JOB_THREAD_ARCHIVE_MINUTES));
});

test("a message that already has a thread, or no message id, gets a standalone thread", async () => {
  const d = fakeDiscord();
  d.hasThread.add("m2");
  const a = await d.messenger.openThread("dc:c:100", "m2", "Fly deploy");
  const b = await d.messenger.openThread("dc:c:100", undefined, "Pitch deck");
  assert.ok(a && b && a !== b);
  assert.deepEqual(d.opened.map((o) => o.how), ["channel", "channel"]);
});

test("a job started from inside a thread gets its own thread in the parent channel", async () => {
  const d = fakeDiscord();
  const t = await d.messenger.openThread("dc:c:200", "m3", "Docs site");
  assert.ok(t && t !== "dc:c:200");
  assert.deepEqual(d.opened, [{ id: t!.slice(5), how: "channel", name: "Docs site", autoArchiveDuration: JOB_THREAD_ARCHIVE_MINUTES }]);
});

test("DMs, unknown channels and other platforms have no threads", async () => {
  const d = fakeDiscord();
  assert.equal(await d.messenger.openThread("dc:c:300", "m", "x"), undefined, "a DM channel");
  assert.equal(await d.messenger.openThread("dc:u:424242", "m", "x"), undefined, "a DM by user");
  assert.equal(await d.messenger.openThread("dc:c:999", "m", "x"), undefined, "a channel we cannot see");
  assert.equal(d.opened.length, 0);
  const router = new RouterMessenger([{ prefix: "tg:", messenger: new ConsoleMessenger() }, { prefix: "dc:", messenger: d.messenger }], new ConsoleMessenger());
  assert.equal(await router.openThread("tg:1", "m", "x"), undefined, "Telegram");
  assert.equal(await router.openThread("447700900000", "m", "x"), undefined, "WhatsApp");
});

test("a failure to thread under the message is logged and falls back to a standalone thread", async () => {
  const d = fakeDiscord({ startThreadFails: true });
  const { result, logged } = await warnings(() => d.messenger.openThread("dc:c:100", "m4", "Fly deploy"));
  assert.ok(result && /^dc:c:\d+$/.test(result));
  assert.deepEqual(d.opened.map((o) => o.how), ["channel"]);
  assert.ok(logged.some((l) => /could not open "Fly deploy" under message m4/.test(l) && /Missing Permissions/.test(l)), logged.join("\n"));
});

test("when no thread can be opened at all, the error is thrown for the caller to log", async () => {
  const d = fakeDiscord({ startThreadFails: true, createFails: true });
  const { error } = await warnings(() => d.messenger.openThread("dc:c:100", "m5", "Fly deploy"));
  assert.match(String(error), /Missing Access/);
});

test("thread names are trimmed to Discord's 100 characters and never empty", async () => {
  const d = fakeDiscord();
  await d.messenger.openThread("dc:c:100", "m6", "x".repeat(150));
  await d.messenger.openThread("dc:c:100", "m6", "   ");
  assert.equal(d.opened[0].name.length, 100);
  assert.equal(d.opened[1].name, "Job");
});

test("a report to an archived job thread reopens it first", async () => {
  const d = fakeDiscord();
  await d.messenger.send("dc:c:250", "Finished: Fly deploy.");
  assert.equal(d.threads.get("250").archived, false);
  assert.deepEqual(d.sent, [{ to: "250", text: "Finished: Fly deploy." }]);
});

test("threadMention links Discord channels and threads only", () => {
  assert.equal(threadMention("dc:c:1234"), "<#1234>");
  assert.equal(threadMention("dc:u:1234"), undefined);
  assert.equal(threadMention("tg:1234"), undefined);
});

/** Runs the chief once, calling its tools in order, and returns each tool's result. */
function chiefCalling(calls: Array<[string, Record<string, unknown>]>, worker: AgentRunner) {
  const results: Array<{ text: string; isError?: boolean }> = [];
  const runner: AgentRunner = async (o) => {
    const ops = o.mcpServers?.ops as any;
    if (!ops) return worker(o);
    const tools = ops.instance?._registeredTools;
    for (const [name, args] of calls) {
      const r = await (tools[name].callback ?? tools[name].handler)(args, {});
      results.push({ text: r.content[0].text, isError: r.isError });
    }
    return { text: "ok", sessionId: "s1" };
  };
  return { runner, results };
}

/** A Discord-shaped messenger over the fake client, recording what was sent where. */
class FakeDiscordMessenger extends ConsoleMessenger {
  constructor(private readonly d: ReturnType<typeof fakeDiscord>, private readonly failNames: string[] = []) {
    super();
  }
  async openThread(replyTo: string, messageId: string | undefined, name: string): Promise<string | undefined> {
    if (this.failNames.includes(name)) throw new Error("Discord is down");
    return this.d.messenger.openThread(replyTo.replace(/^tg:99887766$/, "dc:c:100"), messageId, name);
  }
}

test("a batch from one chat message: every job gets its own thread, a failure is logged, reviews follow the job", async () => {
  const d = fakeDiscord();
  const messenger = new FakeDiscordMessenger(d, ["Docs site"]);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const worker: AgentRunner = async (o) => {
    if (o.systemPrompt.startsWith("You are the maintainer")) return { text: `REVIEW ${PR}: merged` };
    if (o.systemPrompt.includes("engineer")) {
      await gate; // hold the first engineering job so the second queues behind it
      return { text: `Opened ${PR}` };
    }
    return { text: "done" };
  };
  const { runner, results } = chiefCalling(
    [
      ["start_job", { kind: "research", brief: "What did TollBit launch?", title: "TollBit research" }],
      ["start_job", { kind: "write", brief: "Draft the pitch deck.", title: "Pitch deck" }],
      ["start_job", { kind: "engineer", brief: "Add a docs site.", title: "Docs site" }],
      ["start_job", { kind: "engineer", brief: "Deploy to Fly.", title: "Fly deploy" }],
    ],
    worker,
  );
  const store = new Store(tmp("clear-ops-dcthreads-batch-"));
  const jobs = new JobRunner(store, messenger, runner);
  const orch = new Orchestrator(store, messenger, jobs, new Scheduler(store, jobs), runner);
  const { logged } = await warnings(async () => {
    await orch.handle(FOUNDER, "do all four", { messageId: "m7" });
    release();
    await waitFor(() => store.allJobs().some((j) => j.kind === "maintain" && j.status === "done") && store.allJobs().filter((j) => j.kind === "maintain").length === 2 && store.allJobs().every((j) => j.status === "done"));
  });

  const byTitle = (t: string) => store.allJobs().find((j) => j.title === t && j.kind !== "maintain")!;
  const research = byTitle("TollBit research");
  const deck = byTitle("Pitch deck");
  const docs = byTitle("Docs site");
  const fly = byTitle("Fly deploy");
  assert.deepEqual(d.opened.map((o) => o.name), ["TollBit research", "Pitch deck", "Fly deploy"]);
  assert.deepEqual(d.opened.map((o) => o.how), ["message", "channel", "channel"], "one under the message, the rest standalone");
  const addrs = [research, deck, fly].map((j) => j.replyTo);
  assert.equal(new Set(addrs).size, 3);
  assert.ok(addrs.every((a) => /^dc:c:\d+$/.test(a!)));

  // The thread that failed to open was logged, and that job reports in the conversation instead.
  assert.equal(docs.replyTo, FOUNDER);
  assert.ok(logged.some((l) => /could not open a thread for "Docs site"/.test(l) && /Discord is down/.test(l)), logged.join("\n"));

  // The chief is handed each thread's link to pass on to Paul.
  assert.match(results[0].text, new RegExp(`Its thread: ${threadMention(research.replyTo!)!}\\.`));
  assert.match(results[1].text, new RegExp(`Its thread: ${threadMention(deck.replyTo!)!}\\.`));
  assert.doesNotMatch(results[2].text, /Its thread/);
  assert.match(results[3].text, /^Queued: .*Its thread: <#\d+>\.$/, "a queued job still has its thread");

  // Each job's own reports, and its maintainer review, land in its thread.
  for (const j of [research, deck, fly]) {
    assert.ok(messenger.sent.some((m) => m.to === j.replyTo && m.text.startsWith("Finished:") && m.text.includes(j.id)), `${j.title} finished in its thread`);
  }
  for (const eng of [docs, fly]) {
    const review = store.allJobs().find((j) => j.kind === "maintain" && j.reviewOf === eng.id)!;
    assert.equal(review.replyTo, eng.replyTo, `${eng.title}'s review reports where the job did`);
  }
});

test("on Telegram there are no threads and jobs report in the chat", async () => {
  const messenger = new ConsoleMessenger();
  const { runner, results } = chiefCalling([["start_job", { kind: "research", brief: "What did TollBit launch?", title: "TollBit research" }]], async () => ({ text: "done" }));
  const store = new Store(tmp("clear-ops-dcthreads-tg-"));
  const jobs = new JobRunner(store, messenger, runner);
  await new Orchestrator(store, messenger, jobs, new Scheduler(store, jobs), runner).handle(FOUNDER, "research", { messageId: "1" });
  assert.equal(store.allJobs()[0].replyTo, FOUNDER);
  assert.doesNotMatch(results[0].text, /thread/i);
});
