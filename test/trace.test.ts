import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-trace-"));

const { JobTrace, readTrace, shapeTrace, traceFigures, traceText, TRACE_MAX_LINES } = await import("../src/trace.js");
const { traceMessage } = await import("../src/agents.js");
type Raw = import("../src/trace.js").RawTraceEvent;

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "traces-"));

test("an engineer's Bash call and its failing output are kept, clipped and redacted", () => {
  const d = dir();
  const t = new JobTrace("abc123", "engineer", d);
  t.event({ type: "tool", id: "1", name: "Bash", input: { command: "GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 npm test" } });
  t.event({ type: "tool_result", id: "1", isError: true, text: `${"x".repeat(5000)}\n1 failing: expected 302 -> /login, saw 302 -> /dashboard` });
  const lines = readTrace("abc123", d);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].name, "Bash");
  assert.doesNotMatch(lines[0].text ?? "", /ghp_/);
  assert.equal(lines[1].error, true);
  assert.match(lines[1].text ?? "", /saw 302 -> \/dashboard$/);
  assert.ok((lines[1].text ?? "").length < 800);
  assert.equal(fs.statSync(path.join(d, "abc123.jsonl")).mode & 0o777, 0o600);
});

test("a service tool keeps its name and outcome only, never its input or output", () => {
  const names = new Map<string, string>();
  const call = shapeTrace({ type: "tool", id: "9", name: "mcp__browse__type", input: { text: "paul@example.com" } }, "research", names);
  const res = shapeTrace({ type: "tool_result", id: "9", isError: true, text: "page said: secret things" }, "research", names);
  assert.equal(call?.text, undefined);
  assert.equal(res?.text, undefined);
  assert.equal(res?.error, true);
  assert.equal(res?.name, "mcp__browse__type");
});

test("the assistant, CV and DNS kinds record names and outcomes only, and no remarks", () => {
  for (const kind of ["ea", "cv", "dns"] as const) {
    const names = new Map<string, string>();
    assert.equal(shapeTrace({ type: "tool", id: "1", name: "Read", input: { file_path: "/data/cv/facts.md" } }, kind, names)?.text, undefined);
    assert.equal(shapeTrace({ type: "tool_result", id: "1", isError: true, text: "Dear Paul, your salary" }, kind, names)?.text, undefined);
    assert.equal(shapeTrace({ type: "text", text: "The email from Nikhil says" }, kind, names), undefined);
    // How the run ended, in the generic only: never the SDK's own result or errors, which may quote
    // the mail, calendar, CV or zone data the worker saw.
    const failed = shapeTrace({ type: "end", outcome: "API error: Dear Paul, your salary", turns: 2, isError: true }, kind, names);
    assert.equal(failed?.text, "failed");
    assert.equal(failed?.error, true);
    assert.equal(shapeTrace({ type: "end", outcome: "finished", turns: 4 }, kind, names)?.text, "finished");
  }
});

test("a job carrying a bound private source records names and outcomes only, whatever its kind", () => {
  // Synthetic fixture: a staged source's path and one of its own lines, the kinds that may carry one.
  const sourcePath = "/data/doc-snapshots/synthetic-snapshot.txt";
  const sourceLine = "Chapter one opens quietly.";
  for (const kind of ["write", "advisor"] as const) {
    const names = new Map<string, string>();
    // The worker's Bash call and its result both quote the bound source: neither is kept.
    const tool = shapeTrace({ type: "tool", id: "7", name: "Bash", input: { command: `grep -n ${sourceLine} ${sourcePath}` } }, kind, names, true);
    const res = shapeTrace({ type: "tool_result", id: "7", isError: false, text: `${sourceLine}\n` }, kind, names, true);
    const remark = shapeTrace({ type: "text", text: `The source says ${sourceLine}` }, kind, names, true);
    assert.equal(tool?.name, "Bash", "the tool name is kept");
    assert.equal(tool?.text, undefined, "a bound job's trace holds no command");
    assert.equal(res?.name, "Bash");
    assert.equal(res?.text, undefined, "no Bash tail");
    assert.equal(remark, undefined, "no worker remark");
    const kept = JSON.stringify([tool, res]);
    assert.ok(!kept.includes(sourcePath), "no source path");
    assert.ok(!kept.includes(sourceLine), "no source content");
    // The outcome half is kept exactly: a failing result says it failed, never what it said.
    const failed = shapeTrace({ type: "tool_result", id: "8", isError: true, text: `grep: ${sourcePath}: no such file` }, kind, names, true);
    assert.equal(failed?.error, true, "the outcome is kept");
    assert.equal(failed?.text, undefined, "the failure's words are not");
    // How the run ended is an outcome, so it stays: in the generic only, never the SDK's own
    // result or errors, which may quote the bound source.
    const ended = shapeTrace({ type: "end", outcome: "finished", turns: 4 }, kind, names, true);
    assert.equal(ended?.text, "finished");
    const crashed = shapeTrace({ type: "end", outcome: `error_during_execution: cat ${sourcePath}: ${sourceLine}`, turns: 2, isError: true }, kind, names, true);
    assert.equal(crashed?.text, "failed", "a bound job's failed run ends in the generic outcome");
    assert.equal(crashed?.error, true);
    assert.equal(crashed?.turns, 2, "the turn count is an outcome too");
    const crashJson = JSON.stringify(crashed);
    assert.ok(!crashJson.includes(sourcePath) && !crashJson.includes(sourceLine), "the end line holds none of the source");
  }
});

test("a bound job's saved trace holds no source path, content, tail or remark; an unbound job's is unchanged", () => {
  const sourcePath = "/data/doc-snapshots/synthetic-snapshot.txt";
  const sourceLine = "Chapter one opens quietly.";
  // A worker that quotes the bound source in a command, a Bash tail, a Read error and a remark.
  const events = (): Raw[] => [
    { type: "tool", id: "1", name: "Bash", input: { command: `cat ${sourcePath} | head -5` } },
    { type: "tool_result", id: "1", isError: false, text: `${sourceLine}\n${"a tail line of ordinary output. ".repeat(60)}` },
    { type: "text", text: `Working from the source: ${sourceLine}` },
    { type: "tool", id: "2", name: "Read", input: { file_path: sourcePath } },
    { type: "tool_result", id: "2", isError: true, text: `ENOENT: no such file ${sourcePath}` },
    { type: "end", outcome: "finished", turns: 3 },
  ];

  // The bound job: names and outcomes only, in the file and in what /trace replies.
  const boundDir = dir();
  const bound = new JobTrace("bound1", "write", boundDir, true);
  bound.note("write on product, model sonnet");
  for (const e of events()) bound.event(e);
  const boundLines = readTrace("bound1", boundDir);
  const boundJson = JSON.stringify(boundLines);
  assert.ok(boundLines.length >= 6, "every step is traced, as names and outcomes");
  assert.ok(boundLines.some((l) => l.ev === "tool" && l.name === "Bash"), "tool names are kept");
  assert.ok(boundLines.some((l) => l.ev === "result" && l.name === "Read" && l.error), "outcomes are kept");
  assert.ok(boundLines.some((l) => l.ev === "end" && l.text === "finished"), "the run's end is kept");
  for (const banned of [sourcePath, sourceLine, "cat ", "a tail line of ordinary output", "Working from the source"])
    assert.ok(!boundJson.includes(banned), `a bound job's trace holds none of it: ${banned}`);
  const boundText = traceText("Opening · write · bound1", "done", boundLines);
  assert.match(boundText, /steps/);
  assert.ok(!boundText.includes(sourcePath) && !boundText.includes(sourceLine), "/trace replies with none of the source");

  // The same kind unbound: the useful detailed trace, exactly as before.
  const freeDir = dir();
  const free = new JobTrace("free1", "write", freeDir);
  free.note("write on product, model sonnet");
  for (const e of events()) free.event(e);
  const freeLines = readTrace("free1", freeDir);
  const freeJson = JSON.stringify(freeLines);
  assert.ok((freeLines.find((l) => l.ev === "tool" && l.name === "Bash")?.text ?? "").includes(`cat ${sourcePath}`), "the command is kept");
  assert.ok(freeJson.includes(sourcePath), "an unbound job's trace keeps ordinary paths");
  assert.ok(freeJson.includes("a tail line of ordinary output"), "the Bash tail is kept");
  assert.ok(freeJson.includes("Working from the source"), "the worker's remark is kept");
  assert.match(traceText("Opening · write · free1", "done", freeLines), /Working from the source/);
});

test("a bound job's terminal entries hold generic outcomes only; an unbound job of the same kind keeps its detail", () => {
  // The regression this guards: the end of a run is written on three paths - the SDK's own "end"
  // event (`traceMessage`, src/agents.ts), and the service's stop and failure notes (`recordStop`,
  // `recordFailure`, src/jobs.ts) - and each can quote the source a bound job's worker was handed.
  // For a bound job (or a private kind) each keeps a generic outcome with its kind only.
  const sourcePath = "/data/doc-snapshots/synthetic-terminal.txt";
  const sourceLine = "Chapter one opens quietly.";
  const sdkEnd = { type: "end", outcome: `API error: could not read ${sourcePath}: ${sourceLine}`, turns: 2, isError: true } as Raw;
  const stopDetail = `Cancelled at Paul's request, quoting ${sourceLine} from ${sourcePath}.`;
  const failDetail = `The provider refused while reading ${sourcePath}: ${sourceLine}`;

  for (const kind of ["write", "advisor"] as const) {
    // The bound job: how the run ended is kept, as a generic outcome with its kind, never the detail.
    const boundDir = dir();
    const bound = new JobTrace("ends1", kind, boundDir, true);
    bound.note(`${kind} on product, model sonnet`);
    bound.event({ type: "tool", id: "1", name: "Bash", input: { command: `cat ${sourcePath}` } });
    bound.event({ type: "tool_result", id: "1", isError: true, text: `cat: ${sourcePath}: no such file` });
    bound.event({ type: "text", text: `Quoting the source: ${sourceLine}` });
    bound.event(sdkEnd);
    bound.noteEnd(true, "cancelled", stopDetail);
    bound.noteEnd(false, "api", failDetail);
    const boundLines = readTrace("ends1", boundDir);
    const boundJson = JSON.stringify(boundLines);
    assert.ok(boundLines.some((l) => l.ev === "start" && /model sonnet/.test(l.text ?? "")), "the start line (names) is kept");
    assert.deepEqual(
      boundLines.filter((l) => l.ev === "end").map((l) => l.text),
      ["failed", "stopped by the service (cancelled)", "failed (api)"],
      "the terminal entries are the generic outcomes with their kinds",
    );
    for (const banned of [sourcePath, sourceLine, "cat:", "Quoting the source", "Cancelled at Paul's request", "The provider refused"])
      assert.ok(!boundJson.includes(banned), `a bound job's terminal entries hold none of it: ${banned}`);
    const rendered = traceText("Opening · write · ends1", "failed (api)", boundLines);
    assert.match(rendered, /ended: failed$/m);
    assert.match(rendered, /ended: stopped by the service \(cancelled\)$/m);
    assert.match(rendered, /ended: failed \(api\)$/m);
    assert.ok(!rendered.includes(sourcePath) && !rendered.includes(sourceLine), "/trace replies with none of the source");

    // The same kind unbound: the SDK's own outcome and the service's stop and failure detail are
    // kept, byte for byte as before (the useful detailed trace, unchanged).
    const freeDir = dir();
    const free = new JobTrace("ends2", kind, freeDir);
    free.note(`${kind} on product, model sonnet`);
    free.event({ type: "tool", id: "1", name: "Bash", input: { command: `cat ${sourcePath}` } });
    free.event({ type: "tool_result", id: "1", isError: true, text: `cat: ${sourcePath}: no such file` });
    free.event({ type: "text", text: `Quoting the source: ${sourceLine}` });
    free.event(sdkEnd);
    free.noteEnd(true, "cancelled", stopDetail);
    free.noteEnd(false, "api", failDetail);
    const freeLines = readTrace("ends2", freeDir);
    const freeEnds = freeLines.filter((l) => l.ev === "end");
    assert.deepEqual(
      freeEnds.map((l) => l.text),
      [`API error: could not read ${sourcePath}: ${sourceLine}`, `stopped by the service (cancelled): ${stopDetail}`, `failed (api): ${failDetail}`],
      "an unbound job keeps its terminal detail exactly",
    );
    for (const x of freeEnds) assert.equal(x.error, true, "an end line is marked");
    const freeRendered = traceText("Opening · write · ends2", "failed (api)", freeLines);
    assert.match(freeRendered, /ended: failed \(api\): The provider refused/);
  }

  // A private kind ends the same way, binding or no binding: the generic outcome with its kind.
  const eaDir = dir();
  const ea = new JobTrace("ea1", "ea", eaDir);
  ea.note("ea on product, model sonnet");
  ea.event(sdkEnd);
  ea.noteEnd(false, "api", failDetail);
  const eaEnds = readTrace("ea1", eaDir).filter((l) => l.ev === "end");
  assert.deepEqual(eaEnds.map((l) => l.text), ["failed", "failed (api)"]);
  assert.ok(!JSON.stringify(eaEnds).includes(sourceLine), "a private kind's terminal entries hold none of it");
});

test("a trace stops growing at its cap but still records how the job ended", () => {
  const d = dir();
  const t = new JobTrace("big", "engineer", d);
  for (let i = 0; i < TRACE_MAX_LINES + 50; i++) t.event({ type: "text", text: `step ${i}` });
  t.event({ type: "end", outcome: "finished", turns: 9 });
  const lines = readTrace("big", d);
  assert.ok(lines.length <= TRACE_MAX_LINES + 2);
  assert.equal(lines[lines.length - 1].ev, "end");
});

test("the same failure twice is counted as a repeat, and /trace says so in plain text", () => {
  const d = dir();
  const t = new JobTrace("rep", "engineer", d);
  t.note("engineer on self, model sonnet");
  for (let i = 0; i < 3; i++) {
    t.event({ type: "tool", id: `b${i}`, name: "Bash", input: { command: "npm test" } });
    t.event({ type: "tool_result", id: `b${i}`, isError: true, text: "error TS2304: Cannot find name 'foo'." });
  }
  t.noteEnd(false, "stalled", "no activity for 30 minutes");
  const lines = readTrace("rep", d);
  const f = traceFigures(lines);
  assert.equal(f.steps, 3);
  assert.equal(f.errors, 3);
  assert.equal(f.repeats[0].times, 3);
  const text = traceText("Fix login · engineer · rep", "failed (stalled)", lines);
  assert.match(text, /3 steps/);
  assert.match(text, /Failed the same way 3 times/);
  assert.match(text, /Cannot find name 'foo'/);
  assert.match(text, /ended: failed \(stalled\)/);
});

test("a job with no trace says so", () => {
  assert.match(traceText("X · research · none", "done", []), /No trace is saved/);
});

test("SDK messages become trace events: tool call, tool result, remark, end", () => {
  const got: Raw[] = [];
  const emit = (e: Raw) => got.push(e);
  traceMessage({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Running the tests." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }] } }, emit);
  traceMessage({ type: "user", parent_tool_use_id: "p1", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: [{ type: "text", text: "boom" }] }] } }, emit);
  traceMessage({ type: "result", subtype: "error_max_turns", num_turns: 40 }, emit);
  assert.deepEqual(got.map((e) => e.type), ["text", "tool", "tool_result", "end"]);
  assert.equal((got[2] as { sub?: boolean }).sub, true);
  assert.equal((got[2] as { text: string }).text, "boom");
  assert.equal((got[3] as { isError?: boolean }).isError, true);
});
