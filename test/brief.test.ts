/**
 * The shaped brief and its acceptance IDs (src/brief.ts): an informal request the chief shaped keeps
 * Paul's words verbatim, visibly separates what is confirmed from what is inferred and what is open,
 * and says what evidence the outcome needs and what could go wrong and how to recover it, with
 * unchanged behaviour as the acceptance baseline of a refactor. Acceptance IDs are review evidence
 * (the engineer reports against them, the maintainer checks each by ID during review), and never a
 * gate: nothing is refused over them, no runner fails a job over them, and the existing review loop
 * is unchanged. Fixtures are synthetic throughout: no real document, pull request, site or message.
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

const { JobRunner } = await import("../src/jobs.js");
const { workerSpec, CONTRACT_HEADING } = await import("../src/agents.js");
const { Store } = await import("../src/store.js");
const { ConsoleMessenger } = await import("../src/whatsapp.js");
const {
  REQUEST_HEADING,
  INTENT_HEADING,
  ASSUMPTIONS_HEADING,
  UNKNOWNS_HEADING,
  EVIDENCE_HEADING,
  RISKS_HEADING,
  acceptances,
  hasAcceptanceIds,
  isShapedBrief,
} = await import("../src/brief.js");
const { OPS_SERVER_NAME } = await import("../src/ops-schema.js");
const { buildApp } = await import("../src/index.js");
// The real MCP client and a linked pair of in-memory transports, the same wiring the Agent SDK
// gives the chief's ops server on every turn: this is the shaping on the actual chief path, not a
// prompt-string assertion (the loopback pattern of test/chief-reviewonly.test.ts).
const { Client } = await import("@modelcontextprotocol/sdk/client");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
import type { AgentRunner } from "../src/agents.js";

const FOUNDER = "tg:424242";
const PR = "https://github.com/drpaulfarrow/clear-exchange/pull/7";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "brief-store-"));
const settle = () => new Promise((r) => setTimeout(r, 60));

/** Paul's informal fix request, synthetic: never a real chat message. */
const REQUEST = "the offers page takes ages to load on my phone, sort it out please";
/** The contract the chief writes for it: each acceptance individually identified, as the chief is told to. */
const DONE_WHEN = "A1: a new test reproduces the slow phone load and passes after the change\nA2: npm test and npm run build pass";
/** A shaped brief as the chief is told to write one: the request verbatim, then what it says, what was inferred, what is open, what proof it needs and what could go wrong. */
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
    "- The slowness is in the client-side rendering of offers, not the API response: inferred, to verify.",
    "",
    `${UNKNOWNS_HEADING}`,
    "- Which phone and browser Paul uses, to reproduce the slowness.",
    "",
    `${EVIDENCE_HEADING}`,
    "- A new test reproduces the slow phone load and passes after the change.",
    "",
    `${RISKS_HEADING}`,
    "- Faster rendering could change what loads first on a slow connection: recover by reverting the change.",
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

test("the engineer and the maintainer are both told how to read a shaped brief and its acceptances, as review evidence and never as a runner-side gate", () => {
  const engineer = workerSpec("engineer", "product").prompt;
  assert.match(engineer, /Request \(verbatim\):/);
  assert.match(engineer, /Confirmed intent:/);
  assert.match(engineer, /Assumptions \(inferred, not confirmed\):/);
  assert.match(engineer, /Unknowns \(open questions\):/);
  assert.match(engineer, /Evidence expected:/);
  assert.match(engineer, /Risks and recovery:/);
  assert.match(engineer, /Never present an assumption or an unknown as settled/);
  assert.match(engineer, /"ACCEPT A1: met" or "ACCEPT A2: not met: <one short reason>"/, "the engineer reports against its acceptance IDs");
  assert.match(engineer, /These lines are review evidence/);
  assert.doesNotMatch(engineer, /the service reads these lines/, "no runner-side enforcement is promised to the engineer");
  assert.doesNotMatch(engineer, /fails the job naming that acceptance/, "an acceptance reported not met is for the maintainer, not the runner");
  const maintainer = workerSpec("maintain", "product").prompt;
  assert.match(maintainer, /check each acceptance by its ID/);
  assert.doesNotMatch(maintainer, /ACCEPT A1: met/, "only the engineer reports verdict lines, never the maintainer");
});

test("an informal request shaped into a brief keeps its words verbatim, its sections separate and in order", async () => {
  const store = new Store(tmp());
  const jobs = new JobRunner(store, new ConsoleMessenger(false), (async () => ({ text: `Done. ${PR}` })) as never);
  const job = jobs.start("engineer", shapedBrief(), FOUNDER, "product", undefined, { title: "Fast phone offers", doneWhen: DONE_WHEN });
  const stored = store.getJob(job.id)!;
  // Paul's own words survive word for word, nowhere paraphrased away.
  assert.ok(stored.brief.includes(REQUEST), "the requester's own words are kept verbatim in the brief");
  // The sections are visibly separate and in order: request, intent, assumptions, unknowns, evidence, risks, contract.
  const at = (m: string) => stored.brief.indexOf(m);
  const markers = [REQUEST_HEADING, INTENT_HEADING, ASSUMPTIONS_HEADING, UNKNOWNS_HEADING, EVIDENCE_HEADING, RISKS_HEADING, CONTRACT_HEADING];
  assert.ok(markers.every((m) => at(m) >= 0), "every section marker is present");
  assert.ok(markers.every((m, i) => i === 0 || at(m) > at(markers[i - 1])), "the sections are in order, each visibly separate");
  // What is settled never borrows the words of what was only inferred.
  const intent = stored.brief.slice(at(INTENT_HEADING), at(ASSUMPTIONS_HEADING));
  assert.ok(!intent.includes("inferred, to verify"), "an assumption is not presented as confirmed intent");
  assert.ok(stored.brief.slice(at(ASSUMPTIONS_HEADING), at(UNKNOWNS_HEADING)).includes("inferred, to verify"), "the assumptions carry their own caveat");
  // The evidence and the risks each keep their own section, the one the engineer works to.
  assert.ok(stored.brief.slice(at(EVIDENCE_HEADING), at(RISKS_HEADING)).includes("A new test reproduces"), "the evidence expectation has its own section");
  assert.ok(stored.brief.slice(at(RISKS_HEADING), at(CONTRACT_HEADING)).includes("recover by reverting"), "the risks and their recovery have their own section");
  // The contract rides at the end of the brief exactly as passed, and is kept verbatim on the job.
  assert.ok(stored.brief.endsWith(`${CONTRACT_HEADING}\n${DONE_WHEN}`), "the acceptances are the last section, exactly as written");
  assert.equal(stored.doneWhen, DONE_WHEN, "the contract is kept verbatim on the job record");
  assert.deepEqual(acceptances(stored.doneWhen).map((a) => a.id), ["A1", "A2"]);
  for (let i = 0; i < 100 && store.getJob(job.id)?.status === "running"; i++) await settle();
  await settle();
});

test("a shaped brief without acceptance IDs starts: the IDs are shaping guidance, never a gate", () => {
  const store = new Store(tmp());
  const jobs = new JobRunner(store, new ConsoleMessenger(false), (async () => ({ text: "never runs" })) as never);
  // Nothing in the funnel refuses a shaped brief over its acceptance IDs: the requirement to give
  // them is prompt and shaping guidance only, and the job starts exactly as any engineer job.
  const job = jobs.start("engineer", shapedBrief(), FOUNDER, "product", undefined, { title: "Fast phone offers", doneWhen: "the offers page is fast on a phone" });
  assert.ok(job.id, "a shaped brief with no acceptance IDs starts as every engineer job does");
  assert.equal(store.getJob(job.id)?.doneWhen, "the offers page is fast on a phone", "the contract without IDs is kept as it was written");
  // A plain engineer brief keeps working exactly as before too, IDs or not.
  const plain = jobs.start("engineer", "Make the offers page fast on phones.", FOUNDER, "product", undefined, { title: "Fast offers", doneWhen: "the offers page loads in under a second on a phone in the test suite" });
  assert.ok(plain.id, "a plain brief with no IDs starts as it always did");
  assert.equal(store.allJobs().length, 2);
});

test("an engineer that reports one of its acceptances not met is done and reviewed as before, never failed by the runner", async () => {
  const store = new Store(tmp());
  const messenger = new ConsoleMessenger(false);
  const runner = async (o: { systemPrompt: string }) =>
    /You are the maintainer/.test(o.systemPrompt)
      ? { text: `Fine.\nREVIEW ${PR}: merged` }
      : { text: `The change is up. ${PR}\nACCEPT A1: met\nACCEPT A2: not met: the phone timing test still fails` };
  const jobs = new JobRunner(store, messenger, runner as never);
  const job = jobs.start("engineer", shapedBrief(), FOUNDER, "product", undefined, { title: "Fast phone offers", doneWhen: DONE_WHEN });
  // The runner never inspects the report for acceptance verdicts and never fails the job over one:
  // the self-verdict path is gone, and the job lands done so the existing review flow can act.
  for (let i = 0; i < 100 && !(store.getJob(job.id)?.status === "done" && store.allJobs().some((j) => j.kind === "maintain")); i++) await settle();
  await settle();
  const done = store.getJob(job.id)!;
  assert.equal(done.status, "done", "the job is done, not failed by the runner: the maintainer checks the acceptance during review");
  assert.ok(!done.error, "no runner-invented failure was recorded");
  assert.ok(!messenger.sent.some((m) => /Failed/.test(m.text)), "Paul is not told the job failed");
  // The full report is saved unaltered: the engineer's own word against A2 is there for the reviewer.
  const out = store.readOutput(job.id) ?? "";
  assert.match(out, /ACCEPT A2: not met: the phone timing test still fails/, "the engineer's own words are kept");
  assert.doesNotMatch(out, /Acceptance A2 of its contract is not met/, "no runner-side failure detail was appended");
  // The existing review flow is unchanged: the maintainer follows, quoting the contract with its IDs.
  const review = store.allJobs().find((j) => j.kind === "maintain")!;
  assert.ok(review, "the automatic review follows as it always did");
  assert.match(review.brief, new RegExp(`${CONTRACT_HEADING}\\nA1: a new test reproduces`), "the review quotes the contract with its acceptance IDs");
  assert.match(review.brief, /ACCEPT A2: not met/, "the review sees the engineer's report against the acceptance IDs");
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

/**
 * The chief's own side, over the actual ops wire: the real orchestrator, its ops server connected
 * through the real MCP client and a linked in-memory transport (the loopback pattern of
 * test/chief-reviewonly.test.ts), and a scripted model turn per case that does what the chief's
 * prompt tells it to for that request shape: shape the request into a brief with the requester's
 * words verbatim and the sections the prompt names, and call start_job. The five synthetic cases
 * cover the request shapes Paul actually sends: a feature, a fix, a refactor, an ambiguous request
 * and a high-risk shorthand one.
 */
interface ShapedCase {
  tag: string;
  title: string;
  request: string;
  /** Paul's reply that answers the blocking question of an ambiguous request. */
  answer?: string;
  /** The one blocking question the chief asks Paul before it starts, if the request has one. */
  blockingReply?: string;
  intent: string[];
  assumptions: string[];
  unknowns: string[];
  evidence: string[];
  risks: string[];
  doneWhen: string;
}

const SHAPED_CASES: ShapedCase[] = [
  {
    tag: "feature",
    title: "Dark offers mode",
    request: "Can the offers page have a dark mode? I'd use it at night.",
    intent: ["The offers page should offer a dark mode, for use at night."],
    assumptions: ["That dark mode is a colour theme of the existing page, not a redesign: inferred, to verify."],
    unknowns: ["Whether the theme should follow the phone's system setting or have its own toggle."],
    evidence: ["A new test renders the offers page with dark mode on and with it off."],
    risks: ["Dark colours could hurt the readability of offer cards: recover by reverting the theme change."],
    doneWhen: "A1: a new test renders the offers page in dark mode and passes\nA2: the existing light-mode tests pass unchanged\nA3: npm test and npm run build pass",
  },
  {
    tag: "fix",
    title: "Fast phone offers",
    request: REQUEST,
    intent: ["The offers page is too slow to use on Paul's phone, and he asked for that to be fixed."],
    assumptions: ["That the slowness is in the client-side rendering, not the API response: inferred, to verify."],
    unknowns: ["Which phone and browser Paul uses, to reproduce the slowness."],
    evidence: ["A new test reproduces the slow phone load and passes after the change."],
    risks: ["Faster rendering could change what loads first on a slow connection: recover by reverting the change."],
    doneWhen: DONE_WHEN,
  },
  {
    tag: "refactor",
    title: "Offers code tidy-up",
    request: "Tidy up the offers page code, it's a mess. Don't change what it does.",
    intent: ["The offers page's code should be tidied, with its behaviour unchanged."],
    assumptions: ["That 'tidy' means extracting the page's tangled components, not a rewrite: inferred, to verify."],
    unknowns: ["Which parts of the page Paul finds 'a mess', if any beyond the obvious."],
    evidence: ["Every existing test passes unmodified, proving the behaviour is unchanged."],
    risks: ["A tidy-up could accidentally change behaviour: the existing tests are the tripwire, and recovery is a revert."],
    doneWhen: "A1: unchanged behaviour: every existing test passes unmodified\nA2: the offers page code is tidied with no new features and no behaviour change\nA3: npm test and npm run build pass",
  },
  {
    tag: "ambiguous",
    title: "Better offers page",
    request: "Make the offers page better.",
    answer: "The load time. It's hopeless on my phone.",
    blockingReply: "Better how? If it's the load time on your phone I'll start there, say the word.",
    intent: ["Paul wants the offers page improved; his answer confirms he means its load time on his phone."],
    assumptions: ["That fixing the load time is the whole of 'better' for now, not a wider redesign: inferred, to verify."],
    unknowns: ["Whether anything besides the load time bothers him, which stays open for the next request."],
    evidence: ["A new test reproduces the slow phone load and passes after the change."],
    risks: ["Faster rendering could change what loads first on a slow connection: recover by reverting the change."],
    doneWhen: DONE_WHEN,
  },
  {
    tag: "high-risk shorthand",
    title: "Remove test logins",
    request: "Just delete the old test logins off the site, we don't need them any more.",
    intent: ["The old test-only login accounts should be removed from the site."],
    assumptions: ["That 'old test logins' means the seeded test accounts, not the site's login system itself: inferred, to verify."],
    unknowns: ["Whether anything still relies on the seeded accounts, such as an end-to-end suite."],
    evidence: ["A new test proves the seeded accounts are gone and the real login still works."],
    risks: ["Deleting accounts is destructive: remove them behind a reversible migration and recover by running it backwards; if anything unknown still relies on them, stop and report instead of deleting."],
    doneWhen: "A1: a new test proves the old test logins are gone from the site\nA2: the site's own login is unaffected: its existing tests pass\nA3: npm test and npm run build pass",
  },
];

/** The shaped brief the chief writes for a case: every section the chief's prompt names, in order. */
const shapedCaseBrief = (c: ShapedCase) =>
  [
    `${c.title}.`,
    "",
    REQUEST_HEADING,
    `"${c.request}"`,
    "",
    INTENT_HEADING,
    ...c.intent.map((l) => `- ${l}`),
    ...(c.answer ? [`- His answer to the blocking question, verbatim: "${c.answer}"`] : []),
    "",
    ASSUMPTIONS_HEADING,
    ...c.assumptions.map((l) => `- ${l}`),
    "",
    UNKNOWNS_HEADING,
    ...c.unknowns.map((l) => `- ${l}`),
    "",
    EVIDENCE_HEADING,
    ...c.evidence.map((l) => `- ${l}`),
    "",
    RISKS_HEADING,
    ...c.risks.map((l) => `- ${l}`),
    "",
    `Problem: ${c.tag}. Who benefits: Paul. Intended outcome: as confirmed above.`,
    "Scope: the product. Non-scope: anything the request did not name.",
    "Boundaries: the engineer owns the product code and its tests, needs no new permissions or data, and nothing here spends money.",
  ].join("\n");

/** What every shaped brief must hold, checked against the stored job the chief's turn created. */
const checkShaped = (brief: string, doneWhen: string | undefined, c: ShapedCase) => {
  const at = (m: string) => brief.indexOf(m);
  const markers = [REQUEST_HEADING, INTENT_HEADING, ASSUMPTIONS_HEADING, UNKNOWNS_HEADING, EVIDENCE_HEADING, RISKS_HEADING];
  assert.ok(brief.includes(c.request), `${c.tag}: the requester's own words are kept verbatim`);
  assert.ok(markers.every((m) => at(m) >= 0), `${c.tag}: every section marker is present`);
  assert.ok(markers.every((m, i) => i === 0 || at(m) > at(markers[i - 1])), `${c.tag}: the sections are in order, each visibly separate`);
  // Confirmed intent is the only settled part: the inferred and the open never borrow its place.
  for (const line of c.intent) assert.ok(brief.slice(at(INTENT_HEADING), at(ASSUMPTIONS_HEADING)).includes(line), `${c.tag}: the confirmed intent is in its own section`);
  for (const line of c.assumptions) assert.ok(brief.slice(at(ASSUMPTIONS_HEADING), at(UNKNOWNS_HEADING)).includes(line), `${c.tag}: the assumptions are in their own section, never settled`);
  for (const line of c.unknowns) assert.ok(brief.slice(at(UNKNOWNS_HEADING), at(EVIDENCE_HEADING)).includes(line), `${c.tag}: the unknowns are in their own section, never settled`);
  for (const line of c.evidence) assert.ok(brief.slice(at(EVIDENCE_HEADING), at(RISKS_HEADING)).includes(line), `${c.tag}: the evidence expectations are in their own section`);
  for (const line of c.risks) assert.ok(brief.slice(at(RISKS_HEADING), brief.indexOf("Problem:")).includes(line), `${c.tag}: the risks and their recovery are in their own section`);
  assert.equal(doneWhen, c.doneWhen, `${c.tag}: the contract is kept verbatim on the job record`);
  assert.ok(hasAcceptanceIds(doneWhen), `${c.tag}: the contract carries its acceptance IDs`);
};

/** What the wire said about the shaped brief without IDs, and the last chief prompt seen. */
let wireNoIds: { isError?: boolean; text?: string } | undefined;
let chiefPrompt = "";
const chiefMessenger = new ConsoleMessenger(false);
const chiefStore = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "brief-chief-")));
const chiefRunner: AgentRunner = async (o) => {
  const ops = o.mcpServers?.[OPS_SERVER_NAME] as { instance?: unknown } | undefined;
  if (!ops) return { text: "Synthetic worker report: nothing real was done.", costUsd: 0 };
  chiefPrompt = o.systemPrompt;
  const client = new Client({ name: "clear-ops-brief-wire", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await (ops.instance as any).connect(serverTransport);
  await client.connect(clientTransport);
  try {
    // The no-IDs probe first: its message quotes a case's request, so the case finder must not eat it.
    if (o.prompt.startsWith("shape without ids:")) {
      const r: any = await client.callTool({ name: "start_job", arguments: { kind: "engineer", title: "Fast phone offers", brief: shapedCaseBrief(SHAPED_CASES[1]), doneWhen: "the offers page is fast on a phone" } });
      wireNoIds = { isError: !!r.isError, text: r.content?.[0]?.text };
      return { text: "Started: nothing is refused over acceptance IDs.", sessionId: "s1" };
    }
    // Paul's answer to a blocking question, when there is one, selects the case it answers.
    const byAnswer = SHAPED_CASES.find((c) => c.answer && o.prompt.includes(c.answer));
    const c = byAnswer ?? SHAPED_CASES.find((x) => o.prompt.includes(x.request));
    if (c) {
      // An ambiguous request: the chief surfaces the one blocking question and starts nothing.
      if (c.blockingReply && !byAnswer) return { text: c.blockingReply, sessionId: "s1" };
      const r: any = await client.callTool({ name: "start_job", arguments: { kind: "engineer", title: c.title, brief: shapedCaseBrief(c), doneWhen: c.doneWhen, repo: "product" } });
      return { text: `I've shaped your request and started the work: ${c.title} (${JSON.stringify(r.content?.[0]?.text ?? "").slice(0, 60)}).`, sessionId: "s1" };
    }
    return { text: "chief says: nothing to start", sessionId: "s1" };
  } finally {
    await client.close();
  }
};

const { orchestrator } = buildApp({ messenger: chiefMessenger as never, runner: chiefRunner, store: chiefStore });
const waitForJob = async (title: string) => {
  for (let i = 0; i < 200 && !(chiefStore.allJobs().find((j) => j.title === title)?.status !== "running"); i++) await settle();
  return chiefStore.allJobs().find((j) => j.title === title);
};

test("the chief's prompt tells it how to shape, and only blocking questions reach Paul", async () => {
  await orchestrator.handle(FOUNDER, "shape: what tools do you see");
  assert.match(chiefPrompt, /quote his request exactly as it arrived under "Request \(verbatim\):"/);
  assert.match(chiefPrompt, /never present one as settled/);
  assert.match(chiefPrompt, /"Evidence expected:" what proof the outcome needs/);
  assert.match(chiefPrompt, /"Risks and recovery:" what could go wrong and how the change would be undone or recovered/);
  assert.match(chiefPrompt, /make unchanged behaviour the explicit acceptance baseline/, "a refactor's baseline is in the chief's instructions");
  assert.match(chiefPrompt, /Never invent intent or approval/);
  assert.match(chiefPrompt, /only the questions that genuinely block the work \(never every unknown\)/);
  assert.doesNotMatch(chiefPrompt, /a shaped brief whose doneWhen has no acceptance IDs is refused/, "no code refusal is promised for a shaped brief without IDs");
  assert.doesNotMatch(chiefPrompt, /a shaped brief without them is refused/);
  assert.match(chiefPrompt, /so the engineer reports against a specific acceptance and the maintainer checks each one by ID during review/);
});

for (const c of SHAPED_CASES.filter((x) => x.tag !== "ambiguous")) {
  test(`a ${c.tag} request reaches the chief path shaped: verbatim, separated, evidence, risks${c.tag === "refactor" ? ", and the unchanged-behaviour baseline" : ""}`, async () => {
    const before = new Set(chiefStore.allJobs().map((j) => j.id));
    await orchestrator.handle(FOUNDER, `shape: ${c.request}`);
    const job = chiefStore.allJobs().find((j) => j.title === c.title)!;
    assert.ok(job, `${c.tag}: the engineer job was started on the chief path`);
    assert.equal(job.kind, "engineer");
    checkShaped(job.brief, job.doneWhen, c);
    if (c.tag === "refactor") {
      assert.match(acceptances(job.doneWhen)![0].line ?? "", /unchanged behaviour: every existing test passes unmodified/, "the refactor's first acceptance is its unchanged-behaviour baseline");
    }
    const finished = await waitForJob(c.title);
    assert.equal(finished?.status, "done", `${c.tag}: the job ran to completion on the stubbed worker`);
    // The automatic maintain review is the existing flow and may follow; no other engineering work is.
    const started = chiefStore.allJobs().filter((j) => !before.has(j.id) && (j.kind === "engineer" || j.kind === "create_agent"));
    assert.equal(started.length, 1, `${c.tag}: exactly one engineering job was started`);
    assert.equal(started[0].id, job.id);
    await orchestrator.handle(FOUNDER, "/reset");
  });
}

test("an ambiguous request surfaces one blocking question to Paul and starts nothing until he answers", async () => {
  const c = SHAPED_CASES.find((x) => x.tag === "ambiguous")!;
  const before = chiefStore.allJobs().length;
  const repliesBefore = chiefMessenger.sent.length;
  await orchestrator.handle(FOUNDER, `shape: ${c.request}`);
  assert.equal(chiefStore.allJobs().length, before, "nothing was started while the blocking question was open");
  const asked = chiefMessenger.sent.slice(repliesBefore).map((m) => m.text).join("\n");
  assert.match(asked, /Better how\?/, "Paul is asked the one blocking question");
  assert.ok(asked.length < 200, "the blocking question is one short message, never every unknown");
  assert.doesNotMatch(asked, /toggle|which parts of the page|browser/, "the non-blocking unknowns stay in the brief, not in the message");
  // His answer settles the block, and the job that starts still quotes his original words verbatim.
  await orchestrator.handle(FOUNDER, `shape: ${c.answer}`);
  const job = chiefStore.allJobs().find((j) => j.title === c.title)!;
  assert.ok(job, "the engineer job started once the blocking question was answered");
  checkShaped(job.brief, job.doneWhen, c);
  assert.ok(job.brief.includes(c.answer!), "his answer is in the brief too");
  await waitForJob(c.title);
  await orchestrator.handle(FOUNDER, "/reset");
});

test("a shaped brief without acceptance IDs starts through the chief's own start_job, not refused", async () => {
  const before = new Set(chiefStore.allJobs().map((j) => j.id));
  await orchestrator.handle(FOUNDER, `shape without ids: ${REQUEST}`);
  assert.ok(wireNoIds, "the start_job call went over the ops wire");
  assert.ok(!wireNoIds!.isError, "the call succeeds: no pre-check refuses a shaped brief over its IDs");
  assert.match(wireNoIds!.text ?? "", /Started: Fast phone offers/, "the job starts like any engineer job");
  const job = chiefStore.allJobs().find((j) => j.title === "Fast phone offers" && j.doneWhen === "the offers page is fast on a phone")!;
  assert.ok(job, "the shaped brief with no IDs is the one that started, contract and all");
  assert.ok(isShapedBrief(job.brief));
  await waitForJob("Fast phone offers");
  // The automatic maintain review is the existing flow and may follow; no other engineering work is.
  const started = chiefStore.allJobs().filter((j) => !before.has(j.id) && (j.kind === "engineer" || j.kind === "create_agent"));
  assert.equal(started.length, 1, "exactly one engineering job was started");
  await orchestrator.handle(FOUNDER, "/reset");
});
