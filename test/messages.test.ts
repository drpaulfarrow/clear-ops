/**
 * Paul's messaging rule: whatever reaches him in chat reads like a colleague on WhatsApp (three or four
 * plain sentences, what was done, what he must do, a link), while the full report, verdict lines and
 * all, is still saved as the job's output.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-messages-"));

const { Store } = await import("../src/store.js");
const { JobRunner } = await import("../src/jobs.js");
const { ConsoleMessenger } = await import("../src/whatsapp.js");
const { plainMessage, splitReport, tidyReply, splitSentences, MESSAGE_OPEN, MESSAGE_CLOSE, MAX_MESSAGE_CHARS, PAUL_STYLE, REPORT_RULE } = await import("../src/messages.js");
const { workerSpec, JOB_KINDS } = await import("../src/agents.js");
const { nudgeText } = await import("../src/followups.js");
const { EA_SCHEDULES, LEGACY_EA_BRIEFS, upgradeEaSchedules } = await import("../src/ea.js");
import type { AgentRunner, RunOptions } from "../src/agents.js";

const FOUNDER = "tg:99887766";
const PR = "https://github.com/acme/clear-exchange/pull/42";

const waitFor = async (pred: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** The shape Paul does not want in chat. */
function assertPlain(text: string, what: string, maxChars = 900) {
  assert.doesNotMatch(text, /^\s*#{1,6}\s/m, `${what}: no headings`);
  assert.doesNotMatch(text, /^\s*(?:[-*+•]|\d{1,2}[.)])\s+/m, `${what}: no bullets or numbered lists`);
  assert.doesNotMatch(text, /\bOutcome\s*:/i, `${what}: no "Outcome:"`);
  assert.doesNotMatch(text, /\bWhat changed\b/i, `${what}: no "What changed"`);
  assert.doesNotMatch(text, /^\s*\|/m, `${what}: no tables`);
  assert.doesNotMatch(text, /\*\*/, `${what}: no markdown bold`);
  assert.doesNotMatch(text, /—/, `${what}: no em dashes`);
  assert.doesNotMatch(text, /^\s*(?:REVIEW\s+\S+\s*:|DESIGN\s*:|IMAGE\s*:|VERDICT\s*:)/im, `${what}: no machine-readable lines`);
  assert.ok(text.length <= maxChars, `${what}: ${text.length} characters is too long for a phone`);
}

/** A report written like a pull request, the way workers used to answer. */
const PR_STYLE = `## Outcome
Opened ${PR} adding the 402 flow.

## What changed
- \`src/offers.ts\`: returns 402 with a price quote
- \`test/offers.test.ts\`: covers the paid path
- **README**: documents the header

| File | Lines |
|------|-------|
| src/offers.ts | +40 |

### Tests
All 212 pass; typecheck clean.

### Open questions
None.`;

test("a pull-request-style report becomes a few plain sentences that keep the link", () => {
  const m = plainMessage(PR_STYLE);
  assertPlain(m, "derived message");
  assert.ok(m.includes(PR), "the pull request link survives");
  assert.ok(splitSentences(m).length <= 4);
  assert.ok(m.startsWith(`Opened ${PR} adding the 402 flow.`));
});

test("machine-readable lines, em dashes and length are dealt with; links are never split", () => {
  const long = Array.from({ length: 12 }, (_, i) => `Sentence ${i + 1} explains one more detail about the change in some depth.`).join(" ");
  const m = plainMessage(`Merged it — all green.\nREVIEW ${PR}: merged\nDESIGN: spec ready\nIMAGE: home.png | Home\nVERDICT: new worker\nSee https://example.com/a.b?c=d. ${long}`);
  assertPlain(m, "message");
  assert.ok(m.startsWith("Merged it, all green."));
  assert.ok(m.includes("https://example.com/a.b?c=d"));
  assert.ok(splitSentences(m).length <= 4);
  assert.ok(plainMessage(long.repeat(5), { maxSentences: 50 }).length <= MAX_MESSAGE_CHARS);
  assert.equal(plainMessage("```\nnpm test\n```\n"), "", "code is not a message");
});

test("a worker's message block is what Paul sees; the report, verdict lines included, is what is saved", () => {
  const text = `${PR_STYLE}\n\nREVIEW ${PR}: merged\n\n${MESSAGE_OPEN}\nI merged the 402 flow (${PR}); CI deploys it in a few minutes. Nothing needs you.\n${MESSAGE_CLOSE}`;
  const { report, message } = splitReport(text);
  assert.equal(message, `I merged the 402 flow (${PR}); CI deploys it in a few minutes. Nothing needs you.`);
  assert.ok(report.includes("## What changed") && report.includes(`REVIEW ${PR}: merged`), "full detail and the verdict stay in the report");
  assert.ok(!report.includes(MESSAGE_OPEN) && !report.includes("Nothing needs you"));
  // A message that breaks the rule anyway is still made plain.
  const bad = splitReport(`Report.\n${MESSAGE_OPEN}\n## Outcome\n- Merged ${PR}\n- **Nothing** needs you\nREVIEW ${PR}: merged\n${MESSAGE_CLOSE}`);
  assertPlain(bad.message, "rule-breaking message");
  assert.equal(bad.message, `Merged ${PR}. Nothing needs you.`);
  // An empty block falls back to the report.
  assert.equal(splitReport(`Opened ${PR}.\n${MESSAGE_OPEN}\n${MESSAGE_CLOSE}`).message, `Opened ${PR}.`);
});

function harness(reply: (o: RunOptions) => string) {
  const runs: RunOptions[] = [];
  const runner: AgentRunner = async (o) => {
    runs.push(o);
    return { text: reply(o), costUsd: 0.5 };
  };
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-msg-")));
  const messenger = new ConsoleMessenger();
  const jobs = new JobRunner(store, messenger, runner);
  const settled = () => store.allJobs().length > 0 && store.allJobs().every((j) => j.status === "done" || j.status === "failed");
  return { runs, store, messenger, jobs, settled };
}

test("job notifications are short and plain, and the full report is still saved and reviewed", async () => {
  const engineerReport = `${PR_STYLE}\n\n${MESSAGE_OPEN}\nThe 402 flow is up for review at ${PR}, with tests green. The maintainer reviews and merges it next. Nothing needs you.\n${MESSAGE_CLOSE}`;
  // The maintainer forgets the message block: its message is derived from the report, without the verdict line.
  const maintainerReport = `## Review of ${PR}\n**Outcome:** merged as abc1234.\n- tests pass\n- CI green\n\nREVIEW ${PR}: merged`;
  const { store, messenger, jobs, settled } = harness((o) => (o.systemPrompt.startsWith("You are the maintainer") ? maintainerReport : engineerReport));
  const eng = jobs.start("engineer", "Add the 402 flow to /offers", FOUNDER, "product", undefined, { title: "402 flow" });
  await waitFor(() => settled() && store.allJobs().length === 2);
  const review = store.allJobs().find((j) => j.kind === "maintain")!;

  const finished = messenger.sent.filter((m) => m.text.startsWith("Finished:"));
  assert.equal(finished.length, 2);
  for (const f of finished) assertPlain(f.text, f.text.split("\n")[0]);
  const engMsg = finished.find((f) => f.text.startsWith(`Finished: 402 flow · engineer · ${eng.id}.`))!.text;
  assert.equal(
    engMsg,
    `Finished: 402 flow · engineer · ${eng.id}.\nThe 402 flow is up for review at ${PR}, with tests green. The maintainer reviews and merges it next. Nothing needs you. Started Review: 402 flow · maintain · ${review.id} to review and merge. Full report: show job ${eng.id}.`,
  );
  const revMsg = finished.find((f) => f.text.startsWith(`Finished: Review: 402 flow · maintain · ${review.id}.`))!.text;
  assert.match(revMsg, /merged as abc1234\./);
  assert.ok(!revMsg.includes(`REVIEW ${PR}`));

  // Full detail is saved, the chat message is kept on the job, and the maintainer saw the whole report.
  assert.equal(store.readOutput(eng.id), PR_STYLE);
  assert.equal(store.getJob(eng.id)!.summary, `The 402 flow is up for review at ${PR}, with tests green. The maintainer reviews and merges it next. Nothing needs you.`);
  assert.ok(store.readOutput(review.id)!.includes(`REVIEW ${PR}: merged`), "the verdict line stays in the saved output");
  assert.ok(review.brief.includes("## What changed") && !review.brief.includes(MESSAGE_OPEN), "the maintainer reviews the full report");
  assert.equal(store.getJob(eng.id)!.pr, PR);
});

test("the review loop still reads verdicts from the saved report, and its escalation is plain", async () => {
  const { store, messenger, jobs, settled } = harness((o) =>
    o.systemPrompt.startsWith("You are the maintainer")
      ? `Blocked on a secret.\n\nREVIEW ${PR}: needs Paul: add the FLY_API_TOKEN secret under Settings, Secrets and variables, Actions.\n${MESSAGE_OPEN}\nThe deploy job needs a GitHub secret only you can add, so ${PR} is on hold.\n${MESSAGE_CLOSE}`
      : `Opened ${PR}.`,
  );
  jobs.start("engineer", "Deploy on merge", FOUNDER, "product", undefined, { title: "Deploy on merge" });
  await waitFor(() => settled() && messenger.sent.some((m) => m.text.startsWith("Action needed")));
  const ask = messenger.sent.find((m) => m.text.startsWith("Action needed"))!.text;
  assertPlain(ask, "escalation", 600);
  assert.match(ask, /FLY_API_TOKEN/);
  assert.ok(!store.allJobs().some((j) => j.fixRound), "needs Paul starts no fix round");
});

test("system messages are plain too: failures, stale follow-ups", async () => {
  const { messenger, jobs, settled } = harness(() => {
    throw new Error(`boom\n    at stack line one\n    at stack line two ${"x".repeat(800)}`);
  });
  jobs.start("research", "SPUR news", FOUNDER, "product", undefined, { title: "SPUR news" });
  await waitFor(() => settled() && messenger.sent.some((m) => m.text.startsWith("Failed:")));
  const failed = messenger.sent.find((m) => m.text.startsWith("Failed:"))!.text;
  assertPlain(failed, "failure", 450);
  assert.ok(!failed.includes("\n"), "one line, no stack trace layout");

  const since = new Date("2026-10-20T09:00:00Z").toISOString();
  const items = Array.from({ length: 6 }, (_, i) => ({
    id: `a1b2c${i}`,
    kind: (["owed", "promised", "waiting"] as const)[i % 3],
    who: `Person ${i}`,
    subject: `Subject ${i}`,
    excerpt: `I'll send the deck ${i}`,
    threadId: `t${i}`,
    since,
    dueAt: since,
  }));
  const nudge = nudgeText(items as any);
  assertPlain(nudge, "stale nudge", 900);
  assert.ok(!nudge.includes("\n"));
  assert.match(nudge, /^6 follow-ups have gone stale: a1b2c0 Person 0 is waiting on you/);
  assert.match(nudge, /There are 2 more in \/followups\./);
});

test("the chief's replies lose headings, labels, bold and bullet glyphs, but keep numbered steps", () => {
  const reply = tidyReply(`## Outcome\n**Outcome:** The deck is drafted.\n- Pitch: ready\n\n**What changed**\nNothing else.\n\n1. Open Google Cloud\n2. Create a client\n\nREVIEW ${PR}: merged`);
  assert.equal(reply, "The deck is drafted.\nPitch: ready\n\nNothing else.\n\n1. Open Google Cloud\n2. Create a client");
  assert.equal(tidyReply("Short and plain. Nothing needs you."), "Short and plain. Nothing needs you.");
});

test("every agent prompt carries Paul's messaging rule and the two-part answer", () => {
  for (const kind of JOB_KINDS) {
    for (const target of ["product", "self"] as const) {
      const p = workerSpec(kind, target).prompt;
      assert.ok(p.includes(PAUL_STYLE), `${kind} (${target}) carries Paul's messaging rule`);
      assert.ok(p.includes(REPORT_RULE), `${kind} (${target}) writes a full report and a short message`);
    }
  }
  assert.match(PAUL_STYLE, /three or four plain sentences/);
  assert.match(PAUL_STYLE, /No headings, no "Outcome:", no "What changed", no bullet lists/);
  assert.ok(REPORT_RULE.includes(MESSAGE_OPEN) && REPORT_RULE.includes(MESSAGE_CLOSE));
  assert.match(workerSpec("create_agent").prompt, /REPORT_RULE/, "the agent-creator keeps the rule in new agents");
});

test("the morning brief and wrap ask for a plain message, and schedules on the previous wording are upgraded", () => {
  for (const s of EA_SCHEDULES) {
    assert.match(s.brief, /three or four plain sentences/);
    assert.doesNotMatch(s.brief, /Keep it to one phone screen/);
  }
  const previous = Object.keys(LEGACY_EA_BRIEFS).filter((b) => b.includes("scan_followups") && b.endsWith("Keep it to one phone screen."));
  assert.equal(previous.length, 2, "both previous default briefs are upgraded");
  const list: any[] = [];
  const sched = {
    list: () => list.filter((s) => s.enabled !== false),
    add: (s: any) => (list.push({ ...s, id: `s${list.length}` }), list[list.length - 1]),
    cancel: (id: string) => ((list.find((s) => s.id === id)!.enabled = false), true),
  };
  for (const b of previous) sched.add({ cron: "15 7 * * 1-5", timezone: "Europe/London", kind: "ea", brief: b, requestedBy: FOUNDER, replyTo: FOUNDER });
  assert.equal(upgradeEaSchedules(sched), 2);
  assert.deepEqual(sched.list().map((s) => s.brief).sort(), EA_SCHEDULES.map((s) => s.brief).sort());
  assert.ok(sched.list().every((s) => s.cron === "15 7 * * 1-5"), "Paul's times are kept");
});
