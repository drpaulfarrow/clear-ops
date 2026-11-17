import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ALLOWED_NUMBERS = "447700900123";
process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.WHATSAPP_VERIFY_TOKEN = "verify-me";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-reviewonly-"));

const { buildApp } = await import("../src/index.js");
const { Store } = await import("../src/store.js");
const { ConsoleMessenger } = await import("../src/whatsapp.js");
// The real MCP client and a linked pair of in-memory transports, the same wiring the Agent SDK
// gives the chief's ops server on every turn: this is the schema and dispatch on the actual wire.
const { Client } = await import("@modelcontextprotocol/sdk/client");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
import type { AgentRunner } from "../src/agents.js";

const CHIEF_SESSION = "sess-wire-reviewonly";
const PR_URL = "https://github.com/drpaulfarrow/clear-ops/pull/101";

/** What one chief turn saw and did on the ops wire. */
interface WireTurn {
  resume?: string;
  systemPrompt: string;
  advertised?: { tools: Array<{ name: string; inputSchema: any }> };
  calls: Array<{ isError?: boolean; text?: string }>;
}
const wireTurns: WireTurn[] = [];
/** One script per chief turn, in order: each drives that turn's ops server over the MCP wire. */
const scripts: Array<(client: InstanceType<typeof Client>, turn: WireTurn) => Promise<void>> = [];

const runner: AgentRunner = async (o) => {
  const ops = o.mcpServers?.ops as { instance?: unknown } | undefined;
  if (!ops) {
    // A worker run: a synthetic engineer's report ending in a pull request URL.
    return { text: `Synthetic worker report.\nOpened ${PR_URL} for review.` };
  }
  // A chief turn: stand in for the Agent SDK, which connects the ops server over an in-memory
  // transport and advertises its tools to the model fresh on every turn, resumed or not.
  const turn: WireTurn = { systemPrompt: o.systemPrompt, resume: o.resume, calls: [] };
  wireTurns.push(turn);
  const client = new Client({ name: "clear-ops-wire-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await (ops.instance as any).connect(serverTransport);
  await client.connect(clientTransport);
  const script = scripts.shift();
  if (script) await script(client, turn);
  await client.close();
  return { text: `Wire turn done: ${turn.calls.length} call(s).`, sessionId: CHIEF_SESSION };
};

const messenger = new ConsoleMessenger();
let server: import("node:http").Server;
let base: string;
let store: InstanceType<typeof Store>;

before(async () => {
  store = new Store(process.env.DATA_DIR!);
  const { app } = buildApp({ messenger, runner, store });
  await new Promise<void>((r) => (server = app.listen(0, r)));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});
after(() => server.close());

const inbound = (from: string, text: string) => ({
  entry: [{ changes: [{ value: { messages: [{ type: "text", from, id: "wamid.1", text: { body: text } }] } }] }],
});
const post = (body: unknown) =>
  fetch(`${base}/webhook`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const waitFor = async (pred: () => boolean, ms = 4000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};
/** Post a message, wait for that chief turn to finish, and return what it saw and did. */
const chiefTurn = async (text: string) => {
  const done = wireTurns.length;
  const replies = messenger.sent.filter((m) => m.text.startsWith("Wire turn done")).length;
  await post(inbound("447700900123", text));
  await waitFor(() => wireTurns.length === done + 1 && messenger.sent.filter((m) => m.text.startsWith("Wire turn done")).length === replies + 1);
  return wireTurns[done]!;
};
const startJob = (args: Record<string, unknown>) => ({ name: "start_job", arguments: args });
const advertisedStartJob = (turn: WireTurn) => {
  const start = turn.advertised!.tools.find((t) => t.name === "start_job");
  assert.ok(start, "start_job is advertised on the ops wire");
  return start.inputSchema;
};

test("the schema advertised to a chief session carries reviewOnly, and the prompt tells the chief when to pass it", async () => {
  scripts.push(async (client, turn) => {
    turn.advertised = (await client.listTools()) as any;
  });
  const turn = await chiefTurn("wire: what tools do you see");
  const schema = advertisedStartJob(turn);
  assert.equal(schema.type, "object");
  const flag = schema.properties.reviewOnly;
  assert.ok(flag, "reviewOnly is a property of the advertised start_job schema");
  assert.equal(flag.type, "boolean");
  assert.match(flag.description, /Engineer and create_agent only/);
  assert.match(flag.description, /only when Paul himself asked for the pull request to be left for him/);
  assert.deepEqual(schema.required, ["kind", "title", "brief"], "reviewOnly stays optional on the wire");
  // The incident's cause was the prompt, not the plumbing: the chief is now told the flag exists.
  assert.match(turn.systemPrompt, /pass reviewOnly: true on that job's start_job/, "the chief's prompt says when to pass reviewOnly");
  assert.match(turn.systemPrompt, /Clean room rule/, "the prompt keeps its clean-room rule");
});

test("reviewOnly dispatched over the wire reaches the stored job, the reply says it, and no maintainer follows", async () => {
  const before = store.allJobs().length;
  scripts.push(async (client, turn) => {
    const r: any = await client.callTool(startJob({ kind: "engineer", title: "Wire held change", brief: "Synthetic brief: leave the pull request for Paul.", repo: "self", reviewOnly: true }));
    turn.calls.push({ isError: r.isError, text: r.content?.[0]?.text });
  });
  const turn = await chiefTurn("wire: leave the pull request for me");
  const call = turn.calls[0]!;
  assert.ok(!call.isError, "the tool call succeeds");
  assert.ok(call.text!.startsWith("Started: Wire held change"), `the reply starts with the job: ${call.text}`);
  assert.match(call.text!, /Review only: no automatic review or merge; Paul reviews and merges it himself\./);
  const job = store.listJobs(50).find((j) => j.title === "Wire held change")!;
  assert.ok(job, "the job was created");
  assert.equal(job.kind, "engineer");
  assert.equal(job.target, "self");
  assert.equal(job.reviewOnly, true, "the flag is persisted on the stored job record");
  // The synthetic worker finishes with a pull request in its report: none of the follow-ons may start.
  await waitFor(() => store.getJob(job.id)?.status === "done");
  await waitFor(() => messenger.sent.some((m) => m.text.startsWith(`Finished: Wire held change · engineer, workforce · ${job.id}`)));
  assert.equal(store.getJob(job.id)!.pr, PR_URL, "the pull request is read from the report onto the record");
  assert.equal(store.allJobs().filter((j) => j.kind === "maintain").length, 0, "no maintainer, fix round or merge follows a review-only job");
  assert.equal(store.allJobs().length, before + 1, "exactly one job was created");
});

test("reviewOnly on a kind that opens no pull request is refused over the wire, and nothing is created", async () => {
  const before = store.allJobs().length;
  scripts.push(async (client, turn) => {
    const r: any = await client.callTool(startJob({ kind: "research", title: "Wire refused research", brief: "Synthetic brief.", reviewOnly: true }));
    turn.calls.push({ isError: r.isError, text: r.content?.[0]?.text });
  });
  const turn = await chiefTurn("wire: research but review only");
  const call = turn.calls[0]!;
  assert.equal(call.isError, true, "the tool call is an error result");
  assert.match(call.text!, /A research job cannot be review only/);
  assert.match(call.text!, /Nothing was started/);
  assert.equal(store.allJobs().length, before, "no job record was created");
});

test("a resumed chief session is advertised the same current schema: no restart or session reset is needed", async () => {
  scripts.push(async (client, turn) => {
    turn.advertised = (await client.listTools()) as any;
  });
  const turn = await chiefTurn("wire: and now, resumed");
  assert.equal(turn.resume, CHIEF_SESSION, "the later turn resumes the stored session");
  const schema = advertisedStartJob(turn);
  const first = advertisedStartJob(wireTurns[0]!);
  assert.deepEqual(schema.properties.reviewOnly, first.properties.reviewOnly, "a resumed session sees the same advertised reviewOnly");
  assert.deepEqual(schema.required, first.required);
  assert.ok(!schema.required.includes("reviewOnly"), "reviewOnly stays optional for a resumed session");
});