import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { guardOpsSchema, OPS_SCHEMA_VERSION, OPS_SERVER_NAME } from "../src/ops-schema.js";
import { Store } from "../src/store.js";

/**
 * The real-SDK regression for the chief's resumed-session schema refresh, on the pinned Agent SDK
 * (0.3.311): the actual CLI binary against a loopback fake of the Messages API, a throwaway config
 * directory, and a synthetic start_job tool whose schema grows between turns, exactly the shape of
 * the incident (a `reviewOnly` argument added to start_job while Paul's conversations were live).
 * No live integration, no external model endpoint and no real session is touched: every request the
 * CLI makes goes to the loopback server, and the sessions are the ones this test creates.
 *
 * What it pins, in order:
 * 1. The old behaviour, reproduced: resuming a session with a freshly built server under the SAME
 *    namespace keeps advertising the OLD schema on the wire (the model never sees the new argument).
 * 2. The fix's mechanism: a NEW namespace on the next turn is registered fresh, the current schema
 *    (with `reviewOnly`, optional) is advertised, the session id and history are retained, and the
 *    real CLI dispatches a call with the flag to the in-process server.
 * 3. The fail-closed guard: the advertised shape is pinned per namespace in the store, and a schema
 *    change without a version bump is refused rather than served.
 *
 * Dispatch through the orchestrator (the flag reaching the stored job), storage and the absence of
 * maintainer successors are verified separately over the ops wire in test/chief-reviewonly.test.ts.
 */

// One scripted model reply per /v1/messages request: blocks (text or a tool call), then a stop reason.
interface Script {
  blocks: Array<{ text: string } | { id: string; name: string; input: Record<string, unknown> }>;
  end?: "end_turn" | "tool_use";
}
const scripts: Script[] = [];
/** Every parsed request body the CLI sent, in order (the tools array is what the model is advertised). */
const bodies: Array<{ tools?: Array<{ name: string; input_schema?: { properties?: Record<string, unknown>; required?: string[] } }>; messages?: unknown[] }> = [];

let server: http.Server;
let base: string;
let configDir: string;
let workDir: string;

before(async () => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "chief-schema-config-"));
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "chief-schema-cwd-"));
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url?.startsWith("/v1/messages")) {
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(body); } catch { /* the assertions below will fail on a bad request */ }
        bodies.push(parsed as typeof bodies[number]);
        const script = scripts.shift() ?? { blocks: [{ text: "unscripted" }] };
        res.writeHead(200, { "content-type": "text/event-stream" });
        const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        send("message_start", { type: "message_start", message: { id: "msg_schema_test", type: "message", role: "assistant", model: "claude-schema-test", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
        let index = 0;
        for (const block of script.blocks) {
          if ("text" in block) {
            send("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
            send("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
          } else {
            send("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
            send("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
          }
          send("content_block_stop", { type: "content_block_stop", index });
          index++;
        }
        send("message_delta", { type: "message_delta", delta: { stop_reason: script.end ?? "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
        send("message_stop", { type: "message_stop" });
        return res.end();
      }
      if (req.url?.includes("count_tokens")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ input_tokens: 10 }));
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "not_found", message: String(req.url) } }));
    });
  });
  await new Promise<void>((r) => (server = server.listen(0, "127.0.0.1", r)));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => server.close());

/** The child CLI's whole environment: curated, so no real key or setting on this machine reaches it. */
const cliEnv = () => ({
  PATH: process.env.PATH,
  HOME: configDir,
  TMPDIR: os.tmpdir(),
  LANG: "C.UTF-8",
  ANTHROPIC_BASE_URL: base,
  ANTHROPIC_API_KEY: "schema-test-key",
  ANTHROPIC_MODEL: "claude-schema-test",
  ANTHROPIC_SMALL_FAST_MODEL: "claude-schema-test",
  CLAUDE_CONFIG_DIR: configDir,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_AUTOUPDATER: "1",
  DISABLE_TELEMETRY: "1",
  DISABLE_BUG_COMMAND: "1",
  DISABLE_ERROR_REPORTING: "1",
  DISABLE_COST_WARNINGS: "1",
  DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
});

/** Every call the synthetic start_job tool actually received, through the real CLI's dispatch. */
const dispatched: Array<{ server: string; args: Record<string, unknown> }> = [];

/** The synthetic ops server: `kind` only at the old schema, `reviewOnly` added at the grown one, and `doneWhen` with `source` at the merged current one. */
const opsServer = (name: string, withReviewOnly: boolean, withCurrent = false) =>
  createSdkMcpServer({
    name,
    version: "1.0.0",
    tools: [
      tool(
        "start_job",
        "Start a job.",
        withCurrent
          ? { kind: z.enum(["engineer", "research"]), title: z.string(), brief: z.string(), reviewOnly: z.boolean().optional().describe("Leave the pull request for Paul."), doneWhen: z.string().optional().describe("The finish line the engineer works to."), source: z.string().optional().describe("The private source reference this one job works from.") }
          : withReviewOnly
          ? { kind: z.enum(["engineer", "research"]), title: z.string(), brief: z.string(), reviewOnly: z.boolean().optional().describe("Leave the pull request for Paul.") }
          : { kind: z.enum(["engineer", "research"]), title: z.string(), brief: z.string() },
        async (args) => {
          dispatched.push({ server: name, args });
          return { content: [{ type: "text", text: `Started: ${args.title} (reviewOnly=${String(args.reviewOnly)})` }] };
        },
      ),
    ],
  });

/** One real SDK turn: the scripted model searches for the tool, calls it, then wraps up. */
const runTurn = async (label: string, opts: { resume?: string; name: string; withReviewOnly: boolean; withCurrent?: boolean; callArgs: Record<string, unknown> }) => {
  const fullName = `mcp__${opts.name}__start_job`;
  scripts.length = 0;
  scripts.push(
    { blocks: [{ id: `toolu_search_${label}`, name: "ToolSearch", input: { query: `select:${fullName}` } }], end: "tool_use" },
    { blocks: [{ id: `toolu_job_${label}`, name: fullName, input: opts.callArgs }], end: "tool_use" },
    { blocks: [{ text: `${label} done.` }] },
  );
  const from = bodies.length;
  let text = "";
  let sessionId: string | undefined;
  let result: { subtype?: string; isError?: boolean } = {};
  const toolResults: string[] = [];
  for await (const message of query({
    prompt: `schema regression: ${label}`,
    options: {
      model: "claude-schema-test",
      systemPrompt: "You are a schema regression probe.",
      resume: opts.resume,
      cwd: workDir,
      permissionMode: "dontAsk",
      allowedTools: [`mcp__${opts.name}__*`],
      mcpServers: { [opts.name]: opsServer(opts.name, opts.withReviewOnly, opts.withCurrent) },
      maxTurns: 8,
      env: cliEnv(),
    },
  })) {
    if (message.type === "result") {
      text = message.result;
      sessionId = message.session_id;
      result = { subtype: message.subtype, isError: message.is_error };
    }
    // The SDK's own event stream carries each tool result back to the model, the same place a real
    // streaming consumer reads it: this is the round trip of a dispatched call, on a public surface.
    if (message.type === "user") toolResults.push(JSON.stringify((message as { message?: { content?: unknown } }).message?.content ?? ""));
  }
  const requests = bodies.slice(from);
  const advertised = requests.flatMap((b) => (b.tools ?? []).filter((t) => t.name === fullName).map((t) => t.input_schema));
  // The system-role notes the CLI added to the requests (it announces tool availability changes here).
  const systemNotes = JSON.stringify(requests.flatMap((b) => (b.messages ?? []).filter((m) => m.role === "system")));
  return { label, result, text, sessionId, advertised, toolResults, systemNotes };
};

/** The session turn one created, shared with the later tests (tests in a file run in order). */
let firstSession: string | undefined;

test("reproduced on the real pinned SDK: a resumed session keeps the schema it was built with under the same namespace", async () => {
  // Turn 1: a fresh session, the old schema (kind only), the unversioned "ops" namespace the chief used.
  const one = await runTurn("turn-one", { name: "ops", withReviewOnly: false, callArgs: { kind: "engineer", doneWhen: "npm test passes", title: "Schema turn one", brief: "Synthetic brief." } });
  assert.equal(one.result.subtype, "success", `the first turn succeeds: ${one.text}`);
  assert.ok(one.sessionId, "the first turn created a session");
  firstSession = one.sessionId;
  assert.ok(one.advertised.length, "start_job was advertised to the model after the tool search");
  for (const schema of one.advertised) assert.deepEqual(Object.keys(schema?.properties ?? {}), ["kind", "title", "brief"], "the old schema has kind, title and brief only");
  assert.equal(dispatched.at(-1)?.args.title, "Schema turn one", "the call dispatched to the in-process server through the real CLI");

  // Turn 2: the deploy that added reviewOnly, in the old code's world: the server is rebuilt with the
  // grown schema, the session is resumed, and the namespace is unchanged.
  const two = await runTurn("turn-two", { resume: one.sessionId, name: "ops", withReviewOnly: true, callArgs: { kind: "engineer", doneWhen: "npm test passes", title: "Schema turn two", brief: "Synthetic brief.", reviewOnly: true } });
  assert.equal(two.result.subtype, "success", `the resumed turn succeeds: ${two.text}`);
  assert.equal(two.sessionId, one.sessionId, "the resumed turn keeps the session");
  assert.ok(two.advertised.length, "start_job was advertised again after the tool search");
  // The regression: every advertisement on the wire still shows the OLD schema, so the model is never
  // told reviewOnly exists, however many times the server is rebuilt.
  for (const schema of two.advertised) assert.deepEqual(Object.keys(schema?.properties ?? {}), ["kind", "title", "brief"], "the resumed session is still advertised the old schema under the same namespace");
});

test("the fix's mechanism on the real pinned SDK: a new namespace re-registers the resumed session with the current schema", async () => {
  assert.ok(firstSession, "the earlier turn created a session");
  // The same session as above, one turn later, under the namespace a schema change brings (ops_v2):
  // the server is freshly built with the grown schema and registered under the new name.
  const three = await runTurn("turn-three", { resume: firstSession, name: "ops_v2", withReviewOnly: true, callArgs: { kind: "engineer", doneWhen: "npm test passes", title: "Schema turn three", brief: "Synthetic brief.", reviewOnly: true } });
  assert.equal(three.result.subtype, "success", `the resumed turn under the new namespace succeeds: ${three.text}`);
  assert.equal(three.sessionId, firstSession, "the session id and its history are retained under the new namespace");
  assert.ok(three.advertised.length, "start_job was advertised after the tool search");
  for (const schema of three.advertised) {
    assert.deepEqual(Object.keys(schema?.properties ?? {}), ["kind", "title", "brief", "reviewOnly"], "the resumed session is now advertised the current schema, reviewOnly included");
    assert.deepEqual(schema?.required, ["kind", "title", "brief"], "reviewOnly stays optional");
  }
  // The CLI itself bridges the namespace change for the model: its system note offers the new
  // namespace's tool and retires the old one, so the model is not left calling a stale definition.
  assert.match(three.systemNotes, /mcp__ops_v2__start_job/, "the CLI's system note offers the new namespace's tool");
  assert.match(three.systemNotes, /no longer available[\s\S]{0,200}mcp__ops__start_job/, "the same note retires the old namespace's tool");
  // The flag is not just advertised: the real CLI dispatches it to the in-process server, and the
  // tool result saying it arrived comes back on the SDK's event stream for the model to read.
  const call = dispatched.at(-1)!;
  assert.equal(call.server, "ops_v2", "the call went to the server under the new namespace");
  assert.equal(call.args.reviewOnly, true, "reviewOnly reached the tool through the real CLI's dispatch");
  assert.ok(three.toolResults.some((t) => t.includes("Schema turn three (reviewOnly=true)")), "the tool result confirming the flag returned to the model");
});

test("the merged current schema: a resumed session under the versioned namespace sees doneWhen and source together", async () => {
  assert.ok(firstSession, "the earlier turn created a session");
  // Two schema changes each shipped as version 3 on their own branch (main's 3 added start_job's
  // private source reference; the contract branch's 3 added doneWhen). The integration reconciles
  // them as one schema, version 4, so the versioned ops namespace stays the single source of truth.
  // Version 5 since 19 Nov 2026: the usage_report tool, a new tool and so a schema change of its own.
  // Version 6: the model catalogue tools (models, model_apply, model_revert), three new tools of their own.
  assert.equal(OPS_SCHEMA_VERSION, 7, "the current version: 4 merged both version 3s, 5 added usage_report, 6 added the model catalogue tools, 7 added the plan tools");
  assert.equal(OPS_SERVER_NAME, "ops_v7", "the one current namespace carries both parameters");
  // The same session again, resumed under the current namespace with the merged schema: the model
  // must be advertised doneWhen and source together, and the real CLI must dispatch both.
  const four = await runTurn("turn-four", { resume: firstSession, name: OPS_SERVER_NAME, withReviewOnly: true, withCurrent: true, callArgs: { kind: "engineer", doneWhen: "npm test passes", title: "Schema turn four", brief: "Synthetic brief.", reviewOnly: true, source: "synthetic-source-reference" } });
  assert.equal(four.result.subtype, "success", `the resumed turn under the current namespace succeeds: ${four.text}`);
  assert.equal(four.sessionId, firstSession, "the session id and its history are retained under the current namespace");
  assert.ok(four.advertised.length, "start_job was advertised after the tool search");
  for (const schema of four.advertised) {
    assert.deepEqual(Object.keys(schema?.properties ?? {}), ["kind", "title", "brief", "reviewOnly", "doneWhen", "source"], "the resumed session is advertised the merged current schema, doneWhen and source together");
    assert.deepEqual(schema?.required, ["kind", "title", "brief"], "both stay optional");
  }
  assert.match(four.systemNotes, new RegExp(`mcp__${OPS_SERVER_NAME}__start_job`), "the CLI's system note offers the current namespace's tool");
  const call = dispatched.at(-1)!;
  assert.equal(call.server, OPS_SERVER_NAME, "the call went to the server under the current namespace");
  assert.equal(call.args.doneWhen, "npm test passes", "doneWhen reached the tool through the real CLI's dispatch");
  assert.equal(call.args.source, "synthetic-source-reference", "the private source reference reached the tool through the real CLI's dispatch");
});

test("the guard pins the advertised shape per namespace and fails closed on a schema change without a version bump", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chief-schema-store-"));
  const store = new Store(dir);
  const probe = (withReviewOnly: boolean) => opsServer("guard-probe", withReviewOnly);
  // First boot under a namespace pins its shape.
  await guardOpsSchema("guard-probe", () => probe(false), store);
  const pinned = store.opsSchema("guard-probe")!;
  assert.ok(pinned.some((t) => t.name === "guard-probe__start_job" || t.name === "start_job"), "the pinned shape lists the tool");
  assert.ok(!JSON.stringify(pinned).includes("description"), "descriptions are stripped from the pinned shape, so only the schema is compared");
  // A later boot with a changed schema under the SAME namespace is refused: fail closed, with the fix named.
  await assert.rejects(guardOpsSchema("guard-probe", () => probe(true), store), /schema-version bump|ops-schema\.ts/);
  // The same change under a NEW namespace pins and passes: that is the version bump doing its job.
  await guardOpsSchema("guard-probe_v2", () => probe(true), store);
  const repinned = store.opsSchema("guard-probe_v2")!;
  const startJob = repinned.find((t) => t.name.endsWith("start_job"))!;
  const props = Object.keys((startJob.schema as { properties?: Record<string, unknown> }).properties ?? {});
  assert.ok(props.includes("reviewOnly"), "the newly pinned namespace carries the new argument");
  assert.deepEqual((startJob.schema as { required?: string[] }).required, ["kind", "title", "brief"], "and it stays optional");
  // The refusal is stable across boots, and re-booting the unchanged shape under the pinned
  // namespace keeps passing: the guard fails closed on drift, not on every deploy.
  await assert.rejects(guardOpsSchema("guard-probe", () => probe(true), store), /schema-version bump|ops-schema\.ts/);
  await guardOpsSchema("guard-probe", () => probe(false), store);
  assert.equal(store.opsSchema("guard-probe")!.length, pinned.length, "the refused namespace keeps its original pin");
});
