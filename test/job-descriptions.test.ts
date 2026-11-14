/**
 * What a job's card on the jobs board says about it (src/job-descriptions.ts): the short plain
 * description read off the job's own brief, the line explaining what that kind of worker and that
 * repository mean, and the one line on what a finished job produced.
 *
 * The board is a page Paul reads on a phone, so the tests are about what the cards must not do as much
 * as what they say: markup and link targets in a brief are stripped, a token or a secret in a brief
 * never reaches a card, the machine sections a generated brief carries (a pasted report, the scheduler's
 * own note) are dropped, a very long brief is capped, the description is never the whole brief, and a
 * brief that yields nothing usable says so rather than showing filler. No model, no network and no
 * worker: this is text handling over the job's own record.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.GH_TOKEN = "ghp_thestoredworkforcetoken0000111122223333";

const { describeBrief, describeJob, kindLine, liveStep, repoLabel, DESCRIPTION_MAX_CHARS, DETAIL_MAX_CHARS, NO_DESCRIPTION } = await import("../src/job-descriptions.js");
const { JOB_KINDS } = await import("../src/agents.js");
import type { Job } from "../src/store.js";

type Card = Pick<Job, "kind" | "target" | "brief" | "status" | "fixRound" | "reviewOf" | "pr">;

const job = (over: Partial<Card>): Card => ({
  kind: "engineer",
  target: "self",
  brief: "Scaffold a Fastify service with a /health route and tests.",
  status: "running",
  ...over,
});

test("a card's description is read off the brief, with the brief's own label dropped", () => {
  const d = describeBrief("Engineer: scaffold a Fastify service with a /health route and a test that hits it.");
  assert.ok(d.description, "a plain brief describes itself");
  assert.equal(d.description, "Scaffold a Fastify service with a /health route and a test that hits it.");
  assert.equal(d.unavailable, undefined);
  // The leading label is dropped wherever it appears, not only the first time.
  assert.equal(describeBrief("Task: Engineer: fix the footer on the site now.").description, "Fix the footer on the site now.");
});

test("markup, links and query strings are stripped from a brief, never rendered as markup", () => {
  const d = describeBrief(
    [
      "## Restyle the **web interface**",
      "",
      "- Keep the fixed `file list` and the security headers",
      "- Read the live page at https://clear-exchange.fly.dev/jobs?t=SECRET-BOARD-TOKEN first",
      "",
      "See [the notes](https://example.com/notes?token=SECRET-QUERY) for the palette.",
    ].join("\n"),
  );
  const text = `${d.description ?? ""} ${d.more ?? ""}`;
  assert.ok(text.includes("Restyle the web interface"), text);
  assert.ok(text.includes("Keep the fixed file list"), text);
  for (const gone of ["##", "**", "`", "<", ">", "SECRET-BOARD-TOKEN", "SECRET-QUERY", "https://"]) {
    assert.ok(!text.includes(gone), `the description still carries ${gone}: ${text}`);
  }
  assert.ok(text.includes("clear-exchange.fly.dev"), "a link keeps its host, so the words still make sense");
  assert.ok(text.includes("the notes"), "a link keeps its words and drops its address");
  // Markup a brief happens to carry as text goes; a comparison in ordinary words stays.
  const html = describeBrief("<p>Make the header <strong>bold</strong> on every page.</p> See <https://example.com/a?token=SECRET-TAG> and keep the timeout under < 50 ms.");
  assert.equal(html.description, "Make the header bold on every page. See example.com and keep the timeout under < 50 ms.");
});

test("a token or a secret in a brief is redacted with the service's own redaction", () => {
  const d = describeBrief(
    "Read the deploy token ghp_AAAABBBBCCCCDDDDEEEE1111222233334444 and the key sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789, then push with Bearer abcdef1234567890.",
  );
  const text = `${d.description ?? ""} ${d.more ?? ""}`;
  assert.ok(text.includes("***"), text);
  for (const secret of ["ghp_AAAABBBBCCCCDDDDEEEE1111222233334444", "sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789", "abcdef1234567890", process.env.GH_TOKEN!]) {
    assert.ok(!text.includes(secret), `a secret reached the description: ${secret}`);
  }
});

test("a brief with nothing usable says so honestly rather than showing filler", () => {
  for (const brief of ["", "   ", "\n\n", "**", "### ", "See https://example.com", "TBD"]) {
    const d = describeBrief(brief);
    assert.equal(d.description, undefined, `"${brief}" produced a description`);
    assert.equal(d.unavailable, true, `"${brief}" was not reported as unusable`);
    const described = describeJob(job({ brief }));
    assert.equal(described.description, undefined);
    assert.match(described.kindLine, /^engineer on the workforce repo: /);
  }
  assert.match(NO_DESCRIPTION, /brief is empty or unreadable/);
});

test("a very long brief is capped, and the card never carries the whole brief", () => {
  const brief = `Add the harness decision step. ${"It returns needs_retrieval, engine and queries, and the harness decides whether to retrieve at all. ".repeat(40)}The last words of this brief are NOT-ON-A-CARD.`;
  const d = describeBrief(brief);
  assert.ok(d.description!.length <= DESCRIPTION_MAX_CHARS + 1, `description is ${d.description!.length} characters`);
  assert.ok(d.more!.length <= DETAIL_MAX_CHARS + 1, `detail is ${d.more!.length} characters`);
  assert.ok(d.more!.startsWith("It returns needs_retrieval"), "the detail carries on where the card's description stopped");
  assert.ok(brief.length > 4000, "the brief really is long");
  assert.ok(!`${d.description} ${d.more}`.includes("NOT-ON-A-CARD"));
  assert.ok(!d.description!.includes(brief), "the description is never the brief");
});

test("the machine sections of a generated brief never describe a job", () => {
  const review = "Review the pull request the engineer just opened for this task, and any other open pull requests:\n\nAdd the /health route.\n\nEngineer's report:\nSECRET-REPORT-TEXT that must never be on a card.";
  const d = describeBrief(review);
  assert.ok(d.description!.startsWith("Review the pull request the engineer just opened"), d.description!);
  assert.ok(!`${d.description ?? ""} ${d.more ?? ""}`.includes("SECRET-REPORT-TEXT"));
  assert.ok(!`${d.description ?? ""} ${d.more ?? ""}`.includes("Engineer's report"));

  // The same heading with the pasted text beside it rather than under it.
  const inline = "Review the pull requests:\n\nAdd the /health route.\n\nEngineer's report: SECRET-INLINE-REPORT that must never be on a card.";
  assert.equal(describeBrief(inline).description, "Review the pull requests: Add the /health route.");
  assert.ok(!`${describeBrief(inline).description} ${describeBrief(inline).more ?? ""}`.includes("SECRET-INLINE-REPORT"));

  const scheduled = "Check the Prebid releases against the primary sources.\n\n(This is the scheduled run abc123.)";
  const s = describeBrief(scheduled);
  assert.equal(s.description, "Check the Prebid releases against the primary sources.");
  assert.ok(!(s.description ?? "").includes("scheduled run"));
});

test("every kind of worker gets one plain line, and the repository is named as Paul names it", () => {
  assert.equal(repoLabel("self"), "workforce");
  assert.equal(repoLabel("product"), "Clear Exchange");
  assert.equal(repoLabel("site"), "drpaulfarrow.com", "Paul's own name for it, not the internal alias");
  assert.equal(repoLabel("doubleshift"), "doubleshift");
  for (const kind of JOB_KINDS) {
    const line = kindLine(kind, "self");
    assert.match(line, /^\S.* on the workforce repo: \S.+$/, `${kind} has no plain line: ${line}`);
    assert.ok(!line.includes(`${kind}, self`), "the raw alias and kind never reach a card");
  }
  assert.match(kindLine("engineer", "self"), /^engineer on the workforce repo: writes the change on a branch and opens a pull request$/);
  assert.match(kindLine("maintain", "product"), /^maintainer on the Clear Exchange repo: /, "the kind reads as a person, not a verb");
  assert.match(kindLine("research", "site"), /on the drpaulfarrow\.com repo: /);
});

test("a finished job says in one line what it produced, from the record only", () => {
  const done = (over: Partial<Job>, facts = { hasSavedOutput: true }) => describeJob(job({ status: "done", ...over }), facts).produced;
  assert.equal(done({}, { hasPullRequest: true }), "Opened the pull request.");
  assert.equal(done({ fixRound: 2, pr: "https://github.com/drpaulfarrow/clear-ops/pull/63" }, { hasPullRequest: true }), "Updated the pull request for the round of fixes.");
  assert.equal(done({}, { hasSavedOutput: false }), "Finished without a pull request; the report is in your chat.");
  assert.equal(done({ kind: "maintain", reviewOf: "abc123" }), "Reviewed its pull request; the report is linked below.");
  assert.equal(done({ kind: "maintain", reviewOf: "abc123", pr: "https://github.com/drpaulfarrow/clear-ops/pull/63" }), "Reviewed its pull request; the report is linked below.");
  assert.equal(done({ kind: "ea", target: "product" }, {}), "Worked over your mail and calendar; the report is in your chat.");
  assert.equal(done({ kind: "research", target: "product" }), "Wrote a report; the report is linked below.");
  assert.equal(describeJob(job({ status: "running" })).produced, undefined, "only a finished job produced anything");
  assert.equal(describeJob(job({ status: "failed" })).produced, undefined, "a failure is not a result");
  assert.equal(describeJob(job({ status: "queued" })).produced, undefined);
});

test("a running job's latest step is redacted and clipped to one short line", () => {
  assert.equal(liveStep("Editing jobs-board.ts"), "Editing jobs-board.ts");
  assert.equal(liveStep(undefined), undefined);
  assert.equal(liveStep("   "), undefined);
  assert.equal(liveStep(`Pushing ${"x".repeat(200)}`)!.length, 80);
  assert.ok(!liveStep("Pushing ghp_AAAABBBBCCCCDDDDEEEE1111222233334444")!.includes("ghp_"));
});
