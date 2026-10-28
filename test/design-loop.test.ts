import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-dloop-"));

const { Store } = await import("../src/store.js");
const { JobRunner, designBrief } = await import("../src/jobs.js");
const { MAX_DESIGN_ROUNDS, designDir } = await import("../src/design.js");
const { ConsoleMessenger } = await import("../src/whatsapp.js");
import type { AgentRunner, RunOptions } from "../src/agents.js";

const FOUNDER = "tg:99887766";
let prs = 20;

const waitFor = async (pred: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

const isDesigner = (o: RunOptions) => o.systemPrompt.startsWith("You are the brand and design director");
const isMaintainer = (o: RunOptions) => o.systemPrompt.startsWith("You are the maintainer");

/**
 * The designer answers with the next scripted report; engineers open a fresh pull request (or report
 * the one they are fixing); the maintainer answers with the next scripted verdict, merging by default.
 */
function loop(designReplies: string[], maintainerReplies: string[] = []) {
  const runs: RunOptions[] = [];
  const deployWaits: Date[] = [];
  const runner: AgentRunner = async (o) => {
    runs.push(o);
    if (isDesigner(o)) return { text: designReplies.shift() ?? "Looks good.\nDESIGN: no high-impact issues" };
    const pr = o.prompt.match(/https:\/\/github\.com\/acme\/clear-exchange\/pull\/\d+/)?.[0];
    if (isMaintainer(o)) return { text: maintainerReplies.shift()?.replace("<pr>", pr ?? "") ?? `REVIEW ${pr}: merged` };
    if (o.prompt.startsWith("Address the maintainer's review")) return { text: `Fixed ${pr}.` };
    return { text: `Opened https://github.com/acme/clear-exchange/pull/${++prs}. Tests green.` };
  };
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-dl-")));
  const messenger = new ConsoleMessenger();
  const jobs = new JobRunner(store, messenger, runner, { waitForDeploy: async (since) => void deployWaits.push(since) });
  const settled = () => store.allJobs().every((j) => j.status === "done" || j.status === "failed");
  return { runs, deployWaits, store, messenger, jobs, settled };
}

const SPEC = "Top findings...\nSpec: make the hero say what the exchange does.\nDESIGN: spec ready";

test("the loop runs spec, build, review, merge, deploy and critique, capped at the round limit, then reports", async () => {
  const { runs, deployWaits, store, messenger, jobs, settled } = loop(Array.from({ length: MAX_DESIGN_ROUNDS + 2 }, () => SPEC));
  const first = jobs.startDesignLoop("Make the site look like something I can show customers.", FOUNDER, "dc:c:thread-9");
  await waitFor(() => settled() && messenger.sent.some((m) => m.text.includes(`Design loop ${first.id} finished`)));

  const all = store.allJobs();
  const designs = all.filter((j) => j.kind === "design").sort((a, b) => a.designRound! - b.designRound!);
  const engineers = all.filter((j) => j.kind === "engineer");
  assert.equal(designs.length, MAX_DESIGN_ROUNDS + 1, "one design job per round plus the closing critique");
  assert.equal(engineers.length, MAX_DESIGN_ROUNDS, "one engineer job per implemented round, no more");
  assert.equal(all.filter((j) => j.kind === "maintain").length, MAX_DESIGN_ROUNDS, "every engineer pull request is reviewed by the maintainer");
  assert.ok(all.filter((j) => j.kind !== "maintain").every((j) => j.designLoop === first.id), "every design and engineer job carries the loop id");
  assert.deepEqual(designs.map((j) => j.designRound), [1, 2, 3, 4]);
  assert.ok(designs.at(-1)!.designFinal, "the last design job is the closing critique");
  assert.ok(!designs[0].awaitDeploy && designs.slice(1).every((j) => j.awaitDeploy), "rounds after a merge wait for the deploy");
  assert.equal(deployWaits.length, MAX_DESIGN_ROUNDS);
  assert.ok(all.every((j) => j.replyTo === "dc:c:thread-9"), "the whole loop reports in one place");

  for (const e of engineers) {
    assert.equal(e.target, "product");
    assert.match(e.brief, /Implement this design spec on the Clear Exchange product/);
    assert.match(e.brief, /make the hero say what the exchange does/, "the engineer gets the spec in full");
  }
  const engRun = runs.find((r) => r.prompt.startsWith("Implement this design spec"))!;
  assert.ok(engRun.additionalDirectories!.includes(path.dirname(designDir("x"))), "engineers can read the designer's assets");
  assert.match(designs[1].brief, /round 2 of 3/);
  assert.match(designs[1].brief, /Goal from Paul:\nMake the site look like something I can show customers\.$/);
  assert.match(designs.at(-1)!.brief, /closing review/);
  assert.match(designs.at(-1)!.brief, /Write no new spec/);

  const designRun = runs.find(isDesigner)!;
  assert.ok(designRun.mcpServers?.design, "the designer gets its screenshot tools");
  assert.deepEqual(designRun.allowedTools, ["WebSearch", "WebFetch", "Read", "Glob", "Grep", "mcp__design__screenshot", "mcp__design__save_asset"]);
  const finished = messenger.sent.filter((m) => m.text.includes(`Design loop ${first.id} finished`));
  assert.equal(finished.length, 1, "the founder gets one closing report");
  assert.match(finished[0].text, /after 3 implemented rounds: that was the last round/);
});

test("the loop stops early when the critiques find no high-impact issues", async () => {
  const { store, messenger, jobs, settled } = loop([SPEC, "Personas are convinced.\nDESIGN: no high-impact issues"]);
  const first = jobs.startDesignLoop("Customer-ready site", FOUNDER);
  await waitFor(() => settled() && messenger.sent.some((m) => m.text.includes("finished after")));
  assert.equal(store.allJobs().filter((j) => j.kind === "engineer").length, 1);
  assert.equal(store.allJobs().filter((j) => j.kind === "design").length, 2);
  assert.ok(messenger.sent.some((m) => m.text.includes(`Design loop ${first.id} finished after 1 implemented round: the customer critiques found no high-impact issues`)));
});

test("a decision only Paul can make pauses the loop, shows him only the job's own images, and his answer carries it on", async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-dlp-")));
  const messenger = new ConsoleMessenger();
  const runner: AgentRunner = async (o) => {
    if (!isDesigner(o)) return { text: "Opened https://github.com/acme/clear-exchange/pull/7." };
    if (o.prompt.includes("Paul has answered")) return { text: SPEC };
    const id = store.allJobs().find((j) => j.kind === "design" && j.status === "running")!.id;
    for (const n of ["a", "b"]) fs.writeFileSync(path.join(designDir(id), `direction-${n}-desktop.png`), "png");
    return {
      text: `Three directions.\nIMAGE: ${path.join(designDir(id), "direction-a-desktop.png")} | A: Ledger\nIMAGE: direction-b-desktop.png | B: Signal\nIMAGE: /etc/hosts | nope\nIMAGE: ../other/x.png | other job\nDESIGN: needs Paul: pick a brand direction, A, B or C.`,
    };
  };
  const jobs = new JobRunner(store, messenger, runner, { waitForDeploy: async () => undefined });
  const first = jobs.startDesignLoop("Brand identity, then the site", FOUNDER, "dc:c:t1");
  await waitFor(() => messenger.sent.some((m) => m.text.startsWith("Design decision for you")));
  const ask = messenger.sent.filter((m) => m.text.startsWith("Design decision for you"));
  assert.equal(ask.length, 1);
  assert.equal(ask[0].text.split("\n")[0], `Design decision for you (loop ${first.id}, round 1): pick a brand direction, A, B or C.`);
  assert.deepEqual(messenger.images, [
    { to: "dc:c:t1", file: path.join(designDir(first.id), "direction-a-desktop.png"), caption: "A: Ledger" },
    { to: "dc:c:t1", file: path.join(designDir(first.id), "direction-b-desktop.png"), caption: "B: Signal" },
  ]);
  assert.equal(store.allJobs().filter((j) => j.kind === "engineer").length, 0, "nothing is built until Paul decides");

  assert.equal(store.getJob(first.id)!.designPaused, true, "the loop is marked as waiting for Paul");
  const cont = jobs.startDesignLoop("B, but warmer", FOUNDER, undefined, first.id);
  assert.equal(cont.designLoop, first.id);
  // A loop that is running again cannot be carried on a second time: that would start a second build.
  assert.equal(store.getJob(first.id)!.designPaused, false);
  assert.throws(() => jobs.startDesignLoop("C instead", FOUNDER, undefined, first.id), /not paused/);
  assert.equal(cont.designRound, 1, "the same round carries on");
  assert.equal(cont.replyTo, "dc:c:t1", "it reports where the loop always has");
  assert.match(cont.brief, new RegExp(`Paul has answered the open question from job ${first.id}: B, but warmer`));
  assert.match(cont.brief, /Goal from Paul:\nBrand identity, then the site$/);
  await waitFor(() => store.allJobs().some((j) => j.kind === "engineer" && j.designLoop === first.id));
  assert.throws(() => jobs.startDesignLoop("x", FOUNDER, undefined, "nope00"), /not part of a design loop/);
  // Naming the loop (its first job) instead of the asking job still carries on from the latest round.
  store.updateJob(cont.id, { designRound: 2 });
  store.updateJob(first.id, { designPaused: true });
  const again = jobs.startDesignLoop("A after all", FOUNDER, undefined, first.id);
  assert.equal(again.designRound, 2);
  assert.match(again.brief, new RegExp(`from job ${cont.id}: A after all`));
});

test("changes requested on a loop's pull request go to a fix round that stays in the loop", async () => {
  const { store, messenger, jobs, settled } = loop([SPEC, "DESIGN: no high-impact issues"], ["Blocking: contrast.\nREVIEW <pr>: changes requested"]);
  const first = jobs.startDesignLoop("Customer-ready site", FOUNDER);
  await waitFor(() => settled() && messenger.sent.some((m) => m.text.includes("finished after")));
  const fix = store.allJobs().find((j) => j.fixRound === 1)!;
  assert.equal(fix.designLoop, first.id);
  assert.equal(fix.designRound, 1);
  const designs = store.allJobs().filter((j) => j.kind === "design");
  assert.equal(designs.length, 2, "the next round starts only after the fixed pull request merges");
  assert.equal(store.allJobs().filter((j) => j.kind === "maintain").length, 2);
});

test("a founder-only blocker or a missing verdict pauses the loop and tells Paul once", async () => {
  const a = loop([SPEC], ["REVIEW <pr>: needs Paul: add the FLY_API_TOKEN secret."]);
  a.jobs.startDesignLoop("Site", FOUNDER);
  await waitFor(() => a.settled() && a.messenger.sent.some((m) => m.text.startsWith("Action needed")));
  assert.equal(a.store.allJobs().filter((j) => j.kind === "design").length, 1, "no next round while blocked");

  const b = loop([SPEC], ["I looked at it."]);
  const fb = b.jobs.startDesignLoop("Site", FOUNDER);
  await waitFor(() => b.settled() && b.messenger.sent.some((m) => m.text.startsWith(`Design loop ${fb.id} is paused`)));

  const c = loop(["Some thoughts, no verdict."]);
  const fc = c.jobs.startDesignLoop("Site", FOUNDER);
  await waitFor(() => c.settled() && c.messenger.sent.some((m) => m.text.startsWith(`Design loop ${fc.id} is paused: round 1 ended without a spec`)));
  assert.equal(c.store.allJobs().filter((j) => j.kind === "engineer").length, 0);
  for (const [x, first] of [[b, fb], [c, fc]] as const) assert.equal(x.store.getJob(first.id)!.designPaused, true, "a paused loop can be carried on");
  const fa = a.store.allJobs().find((j) => j.kind === "design")!;
  assert.equal(a.store.getJob(fa.id)!.designPaused, true);
});

test("a loop that is running or finished cannot be carried on, so no round is built twice", async () => {
  const { store, messenger, jobs, settled } = loop(["DESIGN: no high-impact issues"]);
  const first = jobs.startDesignLoop("Site", FOUNDER);
  assert.throws(() => jobs.startDesignLoop("go on", FOUNDER, undefined, first.id), /not paused/, "a running loop");
  await waitFor(() => settled() && messenger.sent.some((m) => m.text.includes("finished after")));
  assert.throws(() => jobs.startDesignLoop("go on", FOUNDER, undefined, first.id), /not paused/, "a finished loop");
  assert.equal(store.allJobs().length, 1);
});

test("a loop's engineer job waits its turn behind the product's running engineering job", async () => {
  let release!: () => void;
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-dlq-")));
  const messenger = new ConsoleMessenger();
  const runner: AgentRunner = async (o) => {
    if (isDesigner(o)) return { text: SPEC };
    if (o.prompt.startsWith("Other work")) await new Promise<void>((r) => (release = r));
    return { text: "REVIEW https://github.com/acme/clear-exchange/pull/1: merged" };
  };
  const jobs = new JobRunner(store, messenger, runner, { waitForDeploy: async () => undefined });
  const other = jobs.start("engineer", "Other work", FOUNDER, "product");
  jobs.startDesignLoop("Site", FOUNDER);
  await waitFor(() => store.allJobs().some((j) => j.kind === "engineer" && j.designLoop));
  const eng = store.allJobs().find((j) => j.kind === "engineer" && j.designLoop)!;
  assert.equal(eng.status, "queued");
  assert.equal(eng.waitingFor, other.id);
  assert.ok(messenger.sent.some((m) => m.text.includes(`queued behind job ${other.id}`)));
  release();
  await waitFor(() => store.getJob(eng.id)!.status !== "queued");
});

test("design jobs have their own spend cap and turn limit, and plain design jobs start no loop", async () => {
  const { config } = await import("../src/config.js");
  const { runs, store, jobs, settled } = loop(["DESIGN: spec ready"]);
  jobs.start("design", "Three brand directions for Clear Exchange", FOUNDER);
  await waitFor(() => settled() && runs.length === 1);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(runs[0].maxBudgetUsd, config.design.budgetUsd);
  assert.equal(runs[0].maxTurns, 80);
  assert.equal(runs[0].cwd, config.dataDir);
  assert.equal(store.allJobs().length, 1, "a one-off design job never starts an engineer");
  assert.match(designBrief("Goal", 2, { merged: "#4" }), /^Design loop, round 2 of 3\. The previous round's spec was built in #4/);
});
