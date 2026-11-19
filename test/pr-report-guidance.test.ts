import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OPS_SERVER_NAME } from "../src/ops-schema.js";

// What this file proves, stated plainly: the pull request report guidance (the shape an engineer's
// report and a maintainer's review follow, src/report-guidance.ts) is carried by the two worker
// prompts, and a report written in that shape passes untouched through the chief's ops wire, the job
// runner and the store, with no gate failing a job over an unrun or not-met item. Every model answer
// below is scripted by this file. These are wiring and persistence checks: they do not prove a real
// model writes such reports, only that the prompts ask for it and that nothing in the system blocks,
// fails or rewrites one that does. Whether a real engineer report carries the shape is read in live
// reports and by npm run eval where a model key exists, never here.

process.env.ALLOWED_NUMBERS = "447700900321";
process.env.ALLOWED_TELEGRAM_IDS = "99887711";
process.env.WHATSAPP_VERIFY_TOKEN = "verify-me";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-prreport-"));

const { buildApp } = await import("../src/index.js");
const { Store } = await import("../src/store.js");
const { ConsoleMessenger } = await import("../src/whatsapp.js");
const { workerSpec } = await import("../src/agents.js");
// The real MCP client and a linked pair of in-memory transports, the same wiring the Agent SDK gives
// the chief's ops server on every turn: this is the schema and dispatch on the actual wire.
const { Client } = await import("@modelcontextprotocol/sdk/client");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
import type { AgentRunner } from "../src/agents.js";

const CHIEF_SESSION = "sess-wire-prreport";
const PR_URL = "https://github.com/drpaulfarrow/clear-exchange/pull/12";
// A finish line whose conditions carry acceptance IDs, the settled review-evidence contract the
// chief's shaping produces (pull 108). Nothing here parses the IDs: the runner never does, which is
// part of what this file pins.
const DONE_WHEN = "A1: a new test reproduces the redirect loop and passes after the fix\nA2: an expired session is redirected to /login";

/** A scripted engineer report in the required shape: the acceptance-to-evidence map, expected and actual results, test links, and one unrun item stated as unrun. */
const ENGINEER_REPORT = `Synthetic engineer report, scripted by the test, in the pull request report shape.

Purpose: a user whose session had expired was sent back to the dashboard; they now land on the sign-in page, which is what Paul asked for.
System delta: an expired session now redirects to /login instead of /dashboard; nothing else in behaviour, stored data or dependencies changes.

Acceptance evidence:
- A1: expected a new test reproduces the redirect loop and passes after the fix; actual test/auth-refresh.test.ts failed on the current code for the redirect reason and passes after the change; evidence: test/auth-refresh.test.ts.
- A2: expected an expired session is redirected to /login; actual the new assertion in the same test covers exactly that; evidence: test/auth-refresh.test.ts.
- Not run: the deployed site after the merge (no deploy happens from this job), which stays unrun and is not claimed as checked.

Test relevance: test/auth-refresh.test.ts covers the expired-cookie path only; it does not cover the sign-in page itself rendering, which stays untested.
Revision and integration: branch clear/expired-redirect at 4c1d2e9, based on main 9f8e7d6, up to date with origin/main when pushed, no conflicts.
Commands and environment: node --import tsx --test test/auth-refresh.test.ts; npm run build; the shared workforce machine.
Baseline failures: the suite's known environmental failures were failing before this change and after it, unchanged; this branch adds none.
Findings: none.
Risk, recovery and release unknowns: a wrong redirect target would strand users on a dead page; recovery is reverting the one commit and letting CI redeploy; the live behaviour stays unverified until that deploy, and is not claimed here.

Opened ${PR_URL} for review.

<message_to_paul>
Fixed the expired-session redirect and opened a pull request with the evidence mapped line by line. Nothing needs you; the maintainer reviews it. ${PR_URL}
</message_to_paul>`;

/** A scripted maintainer report checking each acceptance by its ID, as the guidance asks. */
const MAINTAINER_REPORT = `Synthetic maintainer report, scripted by the test, checking the acceptances by ID.

A1: met. I read test/auth-refresh.test.ts: it asserts the redirect for an expired session, and it fails on the default branch for that reason, so the evidence holds.
A2: met. The diff sends an expired session to /login and the same test covers it.
Reviewed at branch head 4c1d2e9, up to date with main, no conflicts. The checks pass with only the known environmental failures, which were failing before this branch.
Findings: none. Unverified at merge: the live behaviour after deploy, which the engineer reported as unrun, correctly.

REVIEW ${PR_URL}: merged`;

/** The worker system prompts the scripted runner saw, in order. */
const workerPrompts: string[] = [];
let chiefRuns = 0;

const runner: AgentRunner = async (o) => {
  const ops = o.mcpServers?.[OPS_SERVER_NAME] as { instance?: unknown } | undefined;
  if (!ops) {
    // A worker run: the answer is scripted here, not written by a model.
    workerPrompts.push(o.systemPrompt);
    if (/You are a senior engineer/.test(o.systemPrompt)) return { text: ENGINEER_REPORT };
    if (/You are the maintainer/.test(o.systemPrompt)) return { text: MAINTAINER_REPORT };
    return { text: "Unexpected worker run in the scripted test." };
  }
  // A chief turn: stand in for the Agent SDK and connect the ops server over an in-memory transport,
  // the same wiring the SDK gives it (the pattern of test/chief-reviewonly.test.ts).
  chiefRuns++;
  const client = new Client({ name: "clear-ops-wire-prreport", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await (ops.instance as any).connect(serverTransport);
  await client.connect(clientTransport);
  const script = scripts.shift();
  if (script) await script(client);
  await client.close();
  return { text: `Wire turn done.`, sessionId: CHIEF_SESSION };
};
const scripts: Array<(client: InstanceType<typeof Client>) => Promise<void>> = [];

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
const waitFor = async (pred: () => boolean, ms = 10000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting for the scripted chain");
    await new Promise((r) => setTimeout(r, 20));
  }
};

test("the engineer and the maintainer prompts carry the pull request report guidance, and keep their existing rules", () => {
  // A wiring check on the prompt text only: this proves the guidance is in the prompts, not that a
  // real model follows it.
  const eng = workerSpec("engineer").prompt;
  assert.match(eng, /The pull request report/, "the engineer is told the report shape exists");
  assert.match(eng, /scale every part to the size and risk of the change/, "the guidance is proportional, not boilerplate");
  assert.match(eng, /a small, low-risk change gets a short report/, "a small change is told it gets a short report");
  assert.match(eng, /not applicable, no stored-data change/, "an empty part is better than a padded one");
  assert.match(eng, /Purpose: the problem, who has it/, "part 1, purpose");
  assert.match(eng, /System delta: what changes in the world/, "part 2, the system delta, not a file list");
  assert.match(eng, /by its ID where the line carries one/, "acceptance conditions are mapped by ID where the brief gives one");
  assert.match(eng, /expected result, the actual result/, "the acceptance-to-evidence map carries expected and actual");
  assert.match(eng, /link to the test, command or check that evidences it/, "each condition links its evidence");
  assert.match(eng, /stays unrun/, "an unrun item stays unrun and is said so");
  assert.match(eng, /Never invent a fail-before you did not see/, "no invented fail-before");
  assert.match(eng, /never claim a live success you did not observe/, "no claimed live success");
  assert.match(eng, /what they do not cover/, "test relevance names what the tests do not cover");
  assert.match(eng, /Revision and integration/, "part 5, revision and integration");
  assert.match(eng, /up to date with the current default branch/, "up-to-date status is required");
  assert.match(eng, /Commands and environment/, "part 6, commands and environment");
  assert.match(eng, /Baseline failures/, "part 7, baseline failures");
  assert.match(eng, /Findings: anything found on the way/, "part 8, findings");
  assert.match(eng, /Risk, recovery and release unknowns/, "part 9, risk, recovery and release unknowns");
  // The existing rules survive, not weakened.
  assert.match(eng, /see it fail, then make the change/, "the fail-first contract rule stays");

  const m = workerSpec("maintain").prompt;
  assert.match(m, /The review is an evidence decision/, "the maintainer is told the review is an evidence decision");
  assert.match(m, /by its ID where the line carries one/, "the maintainer checks acceptance conditions by ID");
  assert.match(m, /whether it is met and whether its evidence holds/, "the maintainer judges the evidence, not just the claim");
  assert.match(m, /name the ID and what is missing/, "unsupported evidence names the ID");
  assert.match(m, /An honestly reported unrun or not-met item is never a reason to reject the report itself/, "honesty is not punished");
  assert.match(m, /Nothing in the runner enforces any of this/, "the guidance promises no runtime gate");
  assert.match(m, /A line that is not met is a blocking issue/, "the contract rule stays");
});

test("a report in the shape flows through the chief path: the IDs reach the job, the engineer's map and its unrun item are saved unaltered, and the maintainer checks by ID", async () => {
  // The loopback chief path (the pattern of test/chief-reviewonly.test.ts): Paul's message, the
  // chief's ops server over the in-memory MCP wire, the stored job, the scripted worker answers.
  // The chief's start_job call here (including its doneWhen with IDs) is scripted by this test; the
  // shaping that produces such a finish line is the chief's, checked by npm run eval, never here.
  const before = store.allJobs().length;
  let startReply = "";
  scripts.push(async (client) => {
    const r: any = await client.callTool({
      name: "start_job",
      arguments: {
        kind: "engineer",
        title: "Redirect fix",
        brief: "Fix the redirect loop: an expired session is sent back to the dashboard instead of /login.",
        doneWhen: DONE_WHEN,
      },
    });
    startReply = r.content?.[0]?.text ?? "";
  });
  await post(inbound("447700900321", "wire: fix the expired session redirect"));
  await waitFor(() => chiefRuns === 1);
  assert.ok(startReply.startsWith("Started: Redirect fix"), `the job started: ${startReply}`);

  // The finish line with its acceptance IDs reaches the stored job and its brief, verbatim.
  const engineer = store.listJobs(50).find((j) => j.title === "Redirect fix")!;
  assert.ok(engineer, "the engineer job was created");
  assert.equal(engineer.kind, "engineer");
  assert.equal(engineer.doneWhen, DONE_WHEN, "the acceptance IDs ride on the job verbatim");
  assert.match(engineer.brief, /Done when:\nA1: a new test reproduces the redirect loop/, "the contract carries the IDs");

  // The engineer's worker run saw the guidance, and its report in the shape lands done and unaltered:
  // no runtime gate fails the job over the unrun item (there is no gate; that is the point).
  await waitFor(() => workerPrompts.length >= 1 && /You are a senior engineer/.test(workerPrompts[0]));
  assert.match(workerPrompts[0], /The pull request report/, "the engineer's run carried the report guidance");
  assert.match(workerPrompts[0], /by its ID where the line carries one/, "the engineer's run carried the ID mapping rule");
  await waitFor(() => store.getJob(engineer.id)?.status === "done");
  const engineerReport = store.readOutput(engineer.id) ?? "";
  assert.match(engineerReport, /Acceptance evidence:/, "the saved report carries the acceptance-to-evidence map");
  assert.match(engineerReport, /- A1: expected a new test reproduces the redirect loop and passes after the fix; actual test\/auth-refresh\.test\.ts failed/, "expected and actual are both there");
  assert.match(engineerReport, /evidence: test\/auth-refresh\.test\.ts/, "each condition links its evidence");
  assert.match(engineerReport, /which stays unrun and is not claimed as checked/, "the unrun item is stated as unrun, saved unaltered");
  assert.match(engineerReport, /the live behaviour stays unverified until that deploy, and is not claimed here/, "no claimed live success");
  assert.equal(store.getJob(engineer.id)!.pr, PR_URL, "the pull request is read from the report");

  // The automatic review follows, its worker also sees the guidance, and its report checking the
  // acceptances by ID is saved unaltered with the loop closing on its verdict as always.
  await waitFor(() => workerPrompts.length >= 2 && /You are the maintainer/.test(workerPrompts[1]));
  const review = store.allJobs().find((j) => j.kind === "maintain" && j.reviewOf === engineer.id);
  assert.ok(review, "the maintainer job followed the engineer");
  assert.match(review!.brief, /Engineer's report:\n/, "the review's brief carries the engineer's report");
  assert.match(workerPrompts[1], /The review is an evidence decision/, "the maintainer's run carried the guidance");
  assert.match(workerPrompts[1], /by its ID where the line carries one/, "the maintainer's run carried the check-by-ID rule");
  await waitFor(() => store.getJob(review!.id)?.status === "done");
  const reviewReport = store.readOutput(review!.id) ?? "";
  assert.match(reviewReport, /A1: met\./, "the saved review checks A1");
  assert.match(reviewReport, /A2: met\./, "the saved review checks A2");
  assert.match(reviewReport, /the engineer reported as unrun, correctly/, "the review's judgement of the unrun item is saved unaltered");
  assert.match(reviewReport, /Unverified at merge: the live behaviour after deploy/, "the review names what stays unverified");

  // The loop closed on the merged verdict exactly as before: no fix round, exactly two jobs, nothing
  // failed, and no part of the runner blocked or rewrote either report.
  assert.equal(store.allJobs().filter((j) => j.kind === "engineer" && j.fixRound).length, 0, "merged closes the loop with no fix round");
  assert.equal(store.allJobs().length, before + 2, "exactly the engineer job and its review ran");
  assert.ok(store.allJobs().every((j) => j.status === "done"), "every job landed done: no gate failed one over an unrun or not-met item");
  const said = messenger.sent.map((m) => m.text).join("\n");
  assert.match(said, new RegExp(`Finished: Redirect fix · engineer · ${engineer.id}`), "the engineer's finish message went out");
});
