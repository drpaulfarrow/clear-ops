/**
 * Models that take no images (src/image-input.ts). A worker on one that opens an image file ends its
 * own run: the provider refuses the picture and the run dies as an API error. That stopped the first
 * plan on its first evening, six times over, on a step that had built its work and only wanted to look
 * at a screenshot. Now the Read is refused before it happens, and the service learns which models
 * those are from the refusal itself and runs the job again at once.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ENGINEER_SLOTS = "1";
process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-image-input-"));

const { Store } = await import("../src/store.js");
const { JobRunner } = await import("../src/jobs.js");
const { ConsoleMessenger } = await import("../src/whatsapp.js");
const img = await import("../src/image-input.js");
import type { AgentRunner, RunOptions } from "../src/agents.js";

const FOUNDER = "tg:99887766";
/** The provider's own words, as the job's trace recorded them on 22 and 23 Nov 2026. */
const REFUSED = "API Error: 400 No endpoints found that support image input";
const pr = (n: number) => `https://github.com/acme/lusana/pull/${n}`;
const waitFor = async (pred: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};
const hook = (tool_name: string, tool_input: unknown) => img.refuseImageRead({ hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: "t1" } as never, "t1", { signal: new AbortController().signal });

test("the provider's refusal of an image is recognised, and nothing else is taken for it", () => {
  assert.equal(img.isImageInputFailure(REFUSED), true);
  assert.equal(img.isImageInputFailure({ detail: REFUSED }), true);
  assert.equal(img.isImageInputFailure("This model does not support images."), true);
  assert.equal(img.isImageInputFailure("image input is not supported by this endpoint"), true);
  // A model that has gone, a data-policy refusal and an ordinary error are other failures with other cures.
  for (const other of ["API Error: 404 No endpoints found for z-ai/glm-5.3", "No endpoints found matching your data policy", "API Error: 500 upstream error", "", undefined]) assert.equal(img.isImageInputFailure(other), false, String(other));
});

test("on such a model a Read of an image file is refused before it happens, and every other call is let through", async () => {
  for (const file of ["/data/repos/lusana/docs/screenshots/home.png", "/tmp/shots/work.PNG", "shot.jpeg", "a.jpg", "b.webp", "c.gif", " d.png "]) {
    const out = (await hook("Read", { file_path: file })) as { hookSpecificOutput?: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string } };
    assert.deepEqual([out.hookSpecificOutput?.hookEventName, out.hookSpecificOutput?.permissionDecision], ["PreToolUse", "deny"], file);
    assert.equal(out.hookSpecificOutput?.permissionDecisionReason, img.IMAGE_READ_REFUSAL);
  }
  assert.match(img.IMAGE_READ_REFUSAL, /The file has not been read\. Do not try again or open it another way\./);
  for (const file of ["/data/repos/lusana/src/app.ts", "README.md", "notes.png.txt", "styles.css"]) assert.deepEqual(await hook("Read", { file_path: file }), {}, file);
  // Making a screenshot, committing it and listing it are untouched: only looking at one is refused.
  assert.deepEqual(await hook("Bash", { command: "chromium --headless --screenshot=home.png http://localhost:3210/" }), {});
  assert.deepEqual(await hook("Write", { file_path: "docs/screenshots/home.png" }), {});
  assert.deepEqual(await hook("Read", {}), {});
  assert.deepEqual(await hook("Read", undefined), {});
  // The runner wires it in for a run marked as taking no images, and for no other.
  const agents = fs.readFileSync(new URL("../src/agents.ts", import.meta.url), "utf8");
  assert.match(agents, /\.\.\.\(o\.denyImages \? \{ hooks: \{ PreToolUse: \[\{ matcher: "Read", hooks: \[refuseImageRead\] \}\] \} \} : \{\}\),/);
});

/** A workforce whose engineer answers what `engineer` says for each of its runs, and whose maintainer merges. */
function world(engineer: (o: RunOptions, n: number) => { text: string; error?: { kind: "api"; detail: string } }) {
  const engineers: RunOptions[] = [];
  const runner: AgentRunner = async (o) => {
    if (o.systemPrompt.startsWith("You are the maintainer")) return { text: `REVIEW ${pr(1)}: merged` };
    engineers.push(o);
    return engineer(o, engineers.length);
  };
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-image-input-store-")));
  const messenger = new ConsoleMessenger();
  const jobs = new JobRunner(store, messenger, runner);
  const settled = () => store.allJobs().every((j) => j.status === "done" || j.status === "failed");
  return { engineers, store, messenger, jobs, settled };
}

test("a run that dies on an image file is run again at once with image files refused, and the model is remembered", async () => {
  const w = world((_o, n) => (n === 1 ? { text: "", error: { kind: "api", detail: REFUSED } } : { text: `Opened ${pr(1)}. Tests green. I could not look at the screenshots.` }));
  const job = w.jobs.start("engineer", "Build the navigation shell", FOUNDER, "product", FOUNDER, { doneWhen: "A1: each area opens its own URL" });
  await waitFor(() => w.engineers.length === 2 && w.settled());
  const [first, second] = w.engineers;
  assert.ok(!first!.denyImages, "the first run did not know");
  assert.ok(!first!.prompt.includes("cannot take images"));
  // The second run is the same task, fresh, with the guard on and the worker told.
  assert.equal(second!.denyImages, true);
  assert.equal(second!.resume, undefined, "never the ended conversation: it holds the picture and would be refused again");
  assert.ok(second!.prompt.startsWith(first!.prompt), "the same task");
  assert.ok(second!.prompt.endsWith(img.TEXT_ONLY_NOTE));
  assert.match(img.TEXT_ONLY_NOTE, /Never open an image file .* with the Read tool/);
  assert.match(img.TEXT_ONLY_NOTE, /You can still make screenshots for a pull request and commit them; just do not open them\./);
  // The job is done, not failed, and its report says what was not checked by eye.
  const done = w.store.getJob(job.id)!;
  assert.equal(done.status, "done");
  assert.match(w.store.readOutput(job.id)!, /cannot take images\. Its first run ended when it opened an image file, so it was run again with image files refused: anything it says about how a page looks was not checked by eye\./);
  assert.equal(img.textOnlyModels(w.store).length, 1, "the model is remembered");
  assert.ok(!w.messenger.sent.some((m) => /failed|API error/i.test(m.text)), "Paul hears of a finished job, not a failed one");
  // The next job on that model starts with the guard on: no run is spent learning it twice.
  w.jobs.start("engineer", "Add the projects page", FOUNDER, "product", FOUNDER, { doneWhen: "A1: the page lists projects" });
  await waitFor(() => w.engineers.length === 3 && w.settled());
  assert.equal(w.engineers[2]!.denyImages, true);
  assert.ok(w.engineers[2]!.prompt.endsWith(img.TEXT_ONLY_NOTE));
  assert.equal(img.textOnlyModels(w.store).length, 1);
});

test("the cure is tried once: a run that is refused again with the guard on fails honestly", async () => {
  const w = world(() => ({ text: "", error: { kind: "api", detail: REFUSED } }));
  const job = w.jobs.start("engineer", "Build the navigation shell", FOUNDER, "product", FOUNDER, { doneWhen: "A1: each area opens its own URL" });
  await waitFor(() => w.settled() && w.store.getJob(job.id)!.status === "failed");
  assert.equal(w.engineers.length, 2, "one run, one retry, and no more");
  assert.equal(w.store.getJob(job.id)!.failure, "api");
});

test("a run that fails for any other reason is not run again here, and no model is marked", async () => {
  const w = world(() => ({ text: "", error: { kind: "api", detail: "API Error: 500 upstream error" } }));
  const job = w.jobs.start("engineer", "Build the navigation shell", FOUNDER, "product", FOUNDER, { doneWhen: "A1: each area opens its own URL" });
  await waitFor(() => w.settled() && w.store.getJob(job.id)!.status === "failed");
  assert.equal(w.engineers.length, 1);
  assert.deepEqual(img.textOnlyModels(w.store), []);
});

test("no more than a handful of models are remembered, and each once", () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-image-input-set-")));
  assert.equal(img.rememberTextOnly(store, "z-ai/glm-5.3"), true);
  assert.equal(img.rememberTextOnly(store, "z-ai/glm-5.3"), false);
  assert.equal(img.rememberTextOnly(store, ""), false);
  assert.equal(img.isTextOnly(store, "z-ai/glm-5.3"), true);
  assert.equal(img.isTextOnly(store, "moonshotai/kimi-k3.1-pro"), false);
  for (let i = 0; i < img.TEXT_ONLY_MAX + 5; i++) img.rememberTextOnly(store, `vendor/model-${i}`);
  assert.equal(img.textOnlyModels(store).length, img.TEXT_ONLY_MAX);
  assert.equal(img.isTextOnly(store, "z-ai/glm-5.3"), false, "the oldest go first");
});
