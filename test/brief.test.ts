/**
 * The shaped brief and its acceptance IDs (src/brief.ts): an informal request the chief shaped keeps
 * Paul's words verbatim and visibly separates what is confirmed from what is inferred and what is
 * open, and its contract names its acceptances ("A1:", "A2:") through the same doneWhen path every
 * engineer job already uses. These tests hold the three behaviours Paul asked for: the shaping is
 * preserved, an acceptance the engineer reports unmet fails the job naming it, and a shaped brief
 * with no acceptance IDs starts nothing. Fixtures are synthetic throughout: no real document, pull
 * request or title.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-brief-"));
process.env.ALLOWED_TELEGRAM_IDS = "424242";
process.env.CHANNELS = "";
process.env.VOICE = "off";

const { JobRunner, withContract } = await import("../src/jobs.js");
const { workerSpec, CONTRACT_HEADING } = await import("../src/agents.js");
const { Store } = await import("../src/store.js");
const { ConsoleMessenger } = await import("../src/whatsapp.js");
const {
  REQUEST_HEADING,
  INTENT_HEADING,
  ASSUMPTIONS_HEADING,
  UNKNOWNS_HEADING,
  acceptances,
  hasAcceptanceIds,
  isShapedBrief,
  acceptanceVerdicts,
  unmetAcceptance,
  SHAPING_REFUSAL,
} = await import("../src/brief.js");
const { OPS_SERVER_NAME } = await import("../src/ops-schema.js");
const { buildApp } = await import("../src/index.js");
import type { AgentRunner, RunOptions } from "../src/agents.js";

const FOUNDER = "tg:424242";
const PR = "https://github.com/drpaulfarrow/clear-exchange/pull/7";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "brief-store-"));
const settle = () => new Promise((r) => setTimeout(r, 60));

/** Paul's informal request, synthetic: never a real chat message. */
const REQUEST = "the offers page takes ages to load on my phone, sort it out please";
/** The contract the chief writes for it: each acceptance individually identified, as the chief is told to. */
const DONE_WHEN = "A1: a new test reproduces the slow phone load and passes after the change\nA2: npm test and npm run build pass";
/** A shaped brief as the chief is told to write one: the request verbatim, then what it says, what was inferred, what is open. */
const shapedBrief = () =>
  [
    "Make the offers page usable on a phone.",
    "",
    `${REQUEST_HEADING}`,
    `"${REQUEST}"`,
    "",
    `${INTENT_HEADING}`,
    "- The offers page is too slow to use on Paul's phone, and he asked for that to be fixed in the product.",
    "",
    `${ASSUMPTIONS_HEADING}`,
    "- The slowness is in the client-side rendering of offers, not the API response: a proposal to verify, not a settled requirement.",
    "",
    `${UNKNOWNS_HEADING}`,
    "- Which phone and browser Paul uses, to reproduce the slowness.",
    "",
    "Problem: the offers page blocks interaction for several seconds on a phone.",
    "Who benefits: Paul checking offers on his phone.",
    "Intended outcome: the page is usable while offers load.",
    "Scope: the offers page's client-side loading. Non-scope: the offers API, analytics and any design change.",
    "Boundaries: the engineer owns the product code and its tests, needs no new permissions or data, and nothing here spends money.",
  ].join("\n");

test("acceptance IDs are read from the contract's lines, and only from those", () => {
  assert.deepEqual(acceptances("A1: one thing is true\nplain line, no ID\n- A2: another\n> A3: a third"), [
    { id: "A1", line: "one thing is true" },
    { id: "A2", line: "another" },
    { id: "A3", line: "a third" },
  ]);
  assert.deepEqual(acceptances(undefined), []);
  assert.deepEqual(acceptances("no IDs here, only the contract's own lines"), []);
  assert.deepEqual(acceptances("A1: first\nA1: second"), [{ id: "A1", line: "first" }], "the first occurrence of an ID wins");
  assert.equal(hasAcceptanceIds("A1: x"), true);
  assert.equal(hasAcceptanceIds("1: x\nA: x\na1: x"), false, "an acceptance ID is A followed by digits, at the start of a line");
});

test("a shaped brief is recognised by its verbatim request section, and only by that", () => {
  assert.equal(isShapedBrief(shapedBrief()), true);
  assert.equal(isShapedBrief(`> ${REQUEST_HEADING}\n"${REQUEST}"`), true, "a quoted block still carries the request");
  assert.equal(isShapedBrief("A plain brief the chief wrote itself from an exact request."), false);
});

test("the engineer's per-acceptance verdicts are read from its report", () => {
  assert.deepEqual(acceptanceVerdicts("Done.\nACCEPT A1: met\n- ACCEPT A2: not met: the timing test is still over the line\nACCEPT A3: met."), [
    { id: "A1", met: true, reason: undefined },
    { id: "A2", met: false, reason: "the timing test is still over the line" },
    { id: "A3", met: true, reason: undefined },
  ]);
  assert.deepEqual(acceptanceVerdicts("All done, but no verdict lines."), []);
});

test("only this job's own unmet acceptance fails it, and only on the engineer's own word", () => {
  const contract = "A1: first\nA2: second";
  assert.deepEqual(unmetAcceptance("ACCEPT A2: not met: still slow on a phone", contract), { id: "A2", reason: "still slow on a phone" });
  assert.deepEqual(unmetAcceptance("ACCEPT A9: not met: some other job's acceptance", contract), undefined, "a verdict against an ID this contract never named settles nothing");
  assert.deepEqual(unmetAcceptance("ACCEPT A1: met\nACCEPT A2: met", contract), undefined, "a met acceptance is not a failure");
  assert.deepEqual(unmetAcceptance("No verdict lines at all.", contract), undefined, "no verdicts is for the maintainer to check, not a failure the service invents");
  assert.deepEqual(unmetAcceptance("ACCEPT A2: not met", "A2: second"), { id: "A2", reason: "the engineer's report says it is not met" }, "a not-met verdict without a reason still names what is not met");
});

test("the engineer and the maintainer are both told how to read a shaped brief and its acceptances", () => {
  const engineer = workerSpec("engineer", "product").prompt;
  assert.match(engineer, /Request \(verbatim\):/);
  assert.match(engineer, /Confirmed intent:/);
  assert.match(engineer, /Assumptions \(inferred, not confirmed\):/);
  assert.match(engineer, /Unknowns \(open questions\):/);
  assert.match(engineer, /Never present an assumption or an unknown as settled/);
  assert.match(engineer, /"ACCEPT A1: met" or "ACCEPT A2: not met: <one short reason>"/);
  const maintainer = workerSpec("maintain", "product").prompt;
  assert.match(maintainer, /check each acceptance by its ID/);
  assert.doesNotMatch(maintainer, /ACCEPT A1: met/, "only the engineer reports verdict lines, never the maintainer");
});

test("an informal request shaped into a brief keeps its words verbatim and its sections separate", async () => {
  const store = new Store(tmp());
  const jobs = new JobRunner(store, new ConsoleMessenger(false), (async () => ({ text: `Done. ${PR}` })) as never);
  const job = jobs.start("engineer", shapedBrief(), FOUNDER, "product", undefined, { title: "Fast phone offers", doneWhen: DONE_WHEN });
  const stored = store.getJob(job.id)!;
  // Paul's own words survive word for word, nowhere paraphrased away.
  assert.ok(stored.brief.includes(REQUEST), "the requester's own words are kept verbatim in the brief");
  // The sections are visibly separate and in order: request, confirmed intent, assumptions, unknowns, contract.
  const at = (m: string) => stored.brief.indexOf(m);
  const markers = [REQUEST_HEADING, INTENT_HEADING, ASSUMPTIONS_HEADING, UNKNOWNS_HEADING, CONTRACT_HEADING];
  assert.ok(markers.every((m) => at(m) >= 0), "every section marker is present");
  assert.ok(markers.every((m, i) => i === 0 || at(m) > at(markers[i - 1])), "the sections are in order, each visibly separate");
  // What is settled never borrows the words of what was only inferred.
  const intent = stored.brief.slice(at(INTENT_HEADING), at(ASSUMPTIONS_HEADING));
  assert.ok(!intent.includes("a proposal to verify"), "an assumption is not presented as confirmed intent");
  assert.ok(stored.brief.slice(at(ASSUMPTIONS_HEADING), at(UNKNOWNS_HEADING)).includes("a proposal to verify"), "the assumptions carry their own caveat");
  // The contract rides at the end of the brief exactly as passed, and is kept verbatim on the job.
  assert.ok(stored.brief.endsWith(`${CONTRACT_HEADING}\n${DONE_WHEN}`), "the acceptances are the last section, exactly as written");
  assert.equal(stored.doneWhen, DONE_WHEN, "the contract is kept verbatim on the job record");
  assert.deepEqual(acceptances(stored.doneWhen).map((a) => a.id), ["A1", "A2"]);
  await settle();
  await settle();
});

test("a shaped brief without individually identified acceptances starts nothing, at the one funnel every job goes through", () => {
  const store = new Store(tmp());
  const jobs = new JobRunner(store, new ConsoleMessenger(false), (async () => ({ text: "never runs" })) as never);
  assert.throws(
    () => jobs.start("engineer", shapedBrief(), FOUNDER, "product", undefined, { title: "Fast phone offers", doneWhen: "the offers page is fast on a phone" }),
    (err: Error) => err.message === SHAPING_REFUSAL,
    SHAPING_REFUSAL,
  );
  assert.equal(store.allJobs().length, 0, "no job record was created");
  // The rule is only for shaped briefs: a plain engineer brief keeps working exactly as before, IDs or not.
  jobs.start("engineer", "Make the offers page fast on phones.", FOUNDER, "product", undefined, { title: "Fast offers", doneWhen: "the offers page loads in under a second on a phone in the test suite" });
  assert.equal(store.allJobs().length, 1, "a plain brief with no IDs starts as it always did");
});

test("a fix round or a design-loop build quoting a shaped original is not asked for new acceptances", async () => {
  const store = new Store(tmp());
  const jobs = new JobRunner(store, new ConsoleMessenger(false), (async () => ({ text: "never runs" })) as never);
  const orig = withContract(shapedBrief(), DONE_WHEN);
  const round = `Address the maintainer's review on ${PR} (automatic fix round 1 of 3).\n\nOriginal task:\n${orig}\n\nMaintainer's review (job r1):\nSomething small.`;
  // The inherited contract is the one the original job set; quoting a shaped brief must not be refused.
  const fixed = jobs.start("engineer", round, FOUNDER, "product", undefined, { title: "Fix round", fixRound: 1, pr: PR, reviewOf: "r1", doneWhen: "a line the loop inherited without IDs" });
  assert.ok(fixed.id, "a fix round quoting a shaped brief starts");
  const loop = jobs.start("engineer", `Build round 2 of the design loop.\n\nOriginal task:\n${orig}`, FOUNDER, "product", undefined, { title: "Loop build", designLoop: "d1", designRound: 2, doneWhen: "a line the loop inherited without IDs" });
  assert.ok(loop.id, "a design-loop build quoting a shaped brief starts");
  assert.equal(store.allJobs().length, 2);
  await settle();
  await settle();
});

test("an engineer that reports one of its own acceptances not met fails the job naming it, and nothing follows", async () => {
  const store = new Store(tmp());
  const messenger = new ConsoleMessenger(false);
  const runner = async (o: { systemPrompt: string }) =>
    /You are the maintainer/.test(o.systemPrompt)
      ? { text: `Fine.\nREVIEW ${PR}: merged` }
      : { text: `The change is up. ${PR}\nACCEPT A1: met\nACCEPT A2: not met: the phone timing test still fails` };
  const jobs = new JobRunner(store, messenger, runner as never);
  const job = jobs.start("engineer", shapedBrief(), FOUNDER, "product", undefined, { title: "Fast phone offers", doneWhen: DONE_WHEN });
  for (let i = 0; i < 100 && store.getJob(job.id)?.status === "running"; i++) await settle();
  const failed = store.getJob(job.id)!;
  assert.equal(failed.status, "failed", "the job fails");
  assert.match(failed.error ?? "", /Acceptance A2 of its contract is not met: the phone timing test still fails/, "the failure names the specific acceptance");
  assert.match(failed.summary ?? "", /Failed \(unmet acceptance A2\)/);
  assert.equal(failed.failure, "error");
  // The full report is still the saved output, with the failure appended: nothing is lost.
  const out = store.readOutput(job.id) ?? "";
  assert.match(out, /ACCEPT A2: not met: the phone timing test still fails/, "the engineer's own words are kept");
  assert.match(out, /Acceptance A2 of its contract is not met/);
  // Nothing follows a failure: no review, no fix round, no merge attempt.
  assert.ok(!store.allJobs().some((j) => j.kind === "maintain"), "no maintainer follows a job failed on an acceptance");
  assert.ok(!store.allJobs().some((j) => j.fixRound), "no fix round follows it either");
  assert.match(messenger.sent.map((m) => m.text).join("\n"), /Acceptance A2 of its contract is not met/, "Paul is told which acceptance is not met");
});

test("an engineer that reports every acceptance met is done and reviewed as before", async () => {
  const store = new Store(tmp());
  const runner = async (o: { systemPrompt: string }) =>
    /You are the maintainer/.test(o.systemPrompt) ? { text: `Fine.\nREVIEW ${PR}: merged` } : { text: `The change is up. ${PR}\nACCEPT A1: met\nACCEPT A2: met` };
  const jobs = new JobRunner(store, new ConsoleMessenger(false), runner as never);
  const job = jobs.start("engineer", shapedBrief(), FOUNDER, "product", undefined, { title: "Fast phone offers", doneWhen: DONE_WHEN });
  for (let i = 0; i < 100 && !(store.getJob(job.id)?.status === "done" && store.allJobs().some((j) => j.kind === "maintain")); i++) await settle();
  await settle();
  assert.equal(store.getJob(job.id)?.status, "done", "all met: the job is done, not failed");
  const review = store.allJobs().find((j) => j.kind === "maintain");
  assert.ok(review, "the automatic review follows as it always did");
  assert.match(review!.brief, new RegExp(`${CONTRACT_HEADING}\\nA1: a new test reproduces`), "the review quotes the contract with its acceptance IDs");
});

// The chief's own side: the ops tool server the chief talks to. The fake runner stands in for the
// model and calls the registered start_job handler exactly as the chief would, so the refusal Paul
// asked for is tested where the chief actually meets it.
const chiefCalls: RunOptions[] = [];
let chiefPrompt = "";
const chiefStore = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "brief-chief-")));
const chiefMessenger = new ConsoleMessenger(false);
const chiefRunner: AgentRunner = async (o) => {
  chiefCalls.push(o);
  const ops = o.mcpServers?.[OPS_SERVER_NAME] as { instance?: unknown } | undefined;
  if (!ops) return { text: "The offers work is under way.", costUsd: 0 };
  chiefPrompt = o.systemPrompt;
  const server = ops.instance as { _registeredTools?: { start_job?: { callback?: Function; handler?: Function } } };
  const handler = server?._registeredTools?.start_job?.callback ?? server?._registeredTools?.start_job?.handler;
  if (o.prompt.startsWith("shape without ids:")) {
    const r = await handler!({ kind: "engineer", title: "Fast phone offers", brief: shapedBrief(), doneWhen: "the offers page is fast on a phone" }, {});
    return { text: `Delegated. ${(r as { content: Array<{ text: string }> }).content[0].text}`, sessionId: "s1" };
  }
  if (o.prompt.startsWith("shape with ids:")) {
    const r = await handler!({ kind: "engineer", title: "Fast phone offers", brief: shapedBrief(), doneWhen: DONE_WHEN }, {});
    return { text: `Delegated. ${(r as { content: Array<{ text: string }> }).content[0].text}`, sessionId: "s1" };
  }
  return { text: "chief says: nothing to start", sessionId: "s1" };
};

const { orchestrator } = buildApp({ messenger: chiefMessenger as never, runner: chiefRunner, store: chiefStore });

test("the chief is told to shape informal requests, and its start_job refuses a shaped brief with no acceptance IDs", async () => {
  const before = chiefStore.allJobs().length;
  await orchestrator.handle(FOUNDER, "shape without ids: the offers page takes ages to load on my phone, sort it out please");
  const said = chiefMessenger.sent.map((m) => m.text).join("\n");
  assert.match(said, /A shaped brief needs its acceptances individually identified/, "the refusal reaches Paul");
  assert.match(said, /Nothing was started/);
  assert.equal(chiefStore.allJobs().length, before, "no job was started");
  // The chief's own instructions carry the shaping, and its start_job tool advertises it.
  assert.match(chiefPrompt, /quote his request exactly as it arrived under "Request \(verbatim\):"/);
  assert.match(chiefPrompt, /never present one as settled/);
  assert.ok(chiefCalls.length > 0, "the chief turn ran");
});

test("the same brief with acceptance IDs starts through the same path, keeping the request and its turn", async () => {
  await orchestrator.handle(FOUNDER, "shape with ids: the offers page takes ages to load on my phone, sort it out please");
  const job = chiefStore.allJobs().find((j) => j.kind === "engineer")!;
  assert.ok(job, "the engineer job started");
  assert.ok(job.brief.includes(REQUEST), "the verbatim request is in the brief");
  assert.equal(job.doneWhen, DONE_WHEN, "the contract with its acceptance IDs is on the job");
  assert.match(job.triggerMessage?.text ?? "", /sort it out please/, "the chat turn that started it is kept verbatim too");
  for (let i = 0; i < 100 && chiefStore.getJob(job.id)?.status === "running"; i++) await settle();
  await settle();
  assert.equal(chiefStore.getJob(job.id)?.status, "done", "the job ran to completion on the stubbed worker");
});
