/**
 * A run that needs to look at an image switches to a model that can (src/image-input.ts, Paul, 23 Nov
 * 2026: "if it NEEDS to use images, it should switch"). On OpenRouter the engineer runs on a text-only
 * model; refusing the picture meant nobody ever looked at the page. Now the Read stops the cheap run
 * where it stands and the job carries on, fresh, on the larger tier, so only the runs that look pay
 * for it. With no tier that can see, the old refusal stands.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ENGINEER_SLOTS = "1";
process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-image-switch-"));
process.env.OPENROUTER_API_KEY = "test-key-not-real";

const { Store } = await import("../src/store.js");
const { JobRunner } = await import("../src/jobs.js");
const { ConsoleMessenger } = await import("../src/whatsapp.js");
const { resolveModel } = await import("../src/llm.js");
const { config } = await import("../src/config.js");
/** The model the engineer runs on here. */
const ENGINEER = () => resolveModel(config.models.engineer);
const img = await import("../src/image-input.js");
import type { AgentRunner, RunOptions } from "../src/agents.js";

const FOUNDER = "tg:99887766";
const REFUSED = "API Error: 400 No endpoints found that support image input";
const pr = (n: number) => `https://github.com/acme/lusana/pull/${n}`;
const SHOT = "/data/repos/lusana/docs/screenshots/home.png";
const waitFor = async (pred: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};
const call = (h: ReturnType<typeof img.stopForImage>, tool_name: string, tool_input: unknown) => h({ hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: "t1" } as never, "t1", { signal: new AbortController().signal });

function world(engineer: (o: RunOptions, n: number) => { text: string; error?: { kind: "api"; detail: string } }) {
  const engineers: RunOptions[] = [];
  const runner: AgentRunner = async (o) => {
    if (o.systemPrompt.startsWith("You are the maintainer")) return { text: `REVIEW ${pr(1)}: merged` };
    engineers.push(o);
    return engineer(o, engineers.length);
  };
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-image-switch-store-")));
  const jobs = new JobRunner(store, new ConsoleMessenger(), runner);
  const settled = () => store.allJobs().every((j) => j.status === "done" || j.status === "failed");
  return { engineers, store, jobs, settled };
}

test("the tier to switch to is the first larger one on a model that is not known to be text only", () => {
  const store = { settings: () => ({ textOnlyModels: [] as string[] }) } as never;
  const resolve = (a: string) => ({ opus: "vendor/big", fable: "vendor/bigger" })[a] ?? a;
  assert.equal(img.visionAlias(store, "vendor/small", resolve), "opus");
  // Never the model the run is already on, and never one known to be text only.
  assert.equal(img.visionAlias(store, "vendor/big", resolve), "fable");
  const blind = { settings: () => ({ textOnlyModels: ["vendor/big", "vendor/bigger"] }) } as never;
  assert.equal(img.visionAlias(blind, "vendor/small", resolve), undefined);
});

test("a run that may switch stops at the Read of an image and says which file; every other call goes through", async () => {
  const seen: string[] = [];
  const h = img.stopForImage((f) => seen.push(f));
  const out = (await call(h, "Read", { file_path: ` ${SHOT} ` })) as { continue?: boolean; hookSpecificOutput?: { permissionDecision: string } };
  assert.equal(out.continue, false, "the run stops where it stands");
  assert.equal(out.hookSpecificOutput?.permissionDecision, "deny", "and the picture is never sent");
  assert.deepEqual(seen, [SHOT]);
  for (const [tool, input] of [["Read", { file_path: "src/app.ts" }], ["Bash", { command: "chromium --screenshot=home.png" }], ["Write", { file_path: "home.png" }], ["Read", {}]] as const) assert.deepEqual(await call(h, tool, input), {});
  assert.deepEqual(seen, [SHOT]);
});

test("a run that dies on an image switches the job to a model that can see, fresh, and the cheap model is remembered", async () => {
  const w = world((_o, n) => (n === 1 ? { text: "", error: { kind: "api", detail: REFUSED } } : { text: `Opened ${pr(1)}. Looked at the screenshot: the nav sits right.` }));
  const job = w.jobs.start("engineer", "Build the navigation shell", FOUNDER, "product", FOUNDER, { doneWhen: "A1: each area opens its own URL" });
  await waitFor(() => w.engineers.length === 2 && w.settled());
  const [first, second] = w.engineers;
  const cheap = resolveModel(first!.model);
  assert.notEqual(resolveModel("opus"), cheap, "the test needs two different models");
  assert.equal(second!.model, "opus");
  assert.ok(!second!.denyImages, "the larger model may look");
  assert.equal(second!.resume, undefined);
  assert.ok(second!.prompt.startsWith(first!.prompt), "the same task");
  assert.match(second!.prompt, /cannot take images, and that run stopped when it opened an image\. You are carrying it on, on a model that can see images\./);
  assert.equal(w.store.getJob(job.id)!.status, "done");
  assert.match(w.store.readOutput(job.id)!, new RegExp(`started on ${cheap.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}, which cannot take images\\. It switched to`));
  assert.deepEqual(img.textOnlyModels(w.store), [cheap]);
});

test("once the model is known, the next job stays cheap until it needs to look, then switches", async () => {
  const w = world((o, n) => {
    if (n === 1) {
      // The known text-only run: its Read of the screenshot stops it, as the SDK hook would.
      assert.equal(o.denyImages, true);
      assert.ok(o.onImageNeeded, "may switch");
      assert.ok(o.prompt.endsWith(img.TEXT_ONLY_NOTE));
      o.onImageNeeded!(SHOT);
      return { text: "" };
    }
    return { text: `Opened ${pr(1)}. Checked the screenshot.` };
  });
  w.store.setSetting("textOnlyModels", [ENGINEER()]);
  const job = w.jobs.start("engineer", "Add the projects page", FOUNDER, "product", FOUNDER, { doneWhen: "A1: the page lists projects" });
  await waitFor(() => w.engineers.length === 2 && w.settled());
  const second = w.engineers[1]!;
  assert.equal(second.model, "opus");
  assert.ok(!second.prompt.includes(img.TEXT_ONLY_NOTE), "the larger model is not told it cannot see");
  assert.match(second.prompt, /stopped when it needed to look at home\.png/);
  assert.equal(w.store.getJob(job.id)!.status, "done");
});

test("a job that never opens a picture never leaves the cheap model", async () => {
  const w = world(() => ({ text: `Opened ${pr(1)}. Tests green.` }));
  w.store.setSetting("textOnlyModels", [ENGINEER()]);
  w.jobs.start("engineer", "Fix a typo", FOUNDER, "product", FOUNDER, { doneWhen: "A1: typo fixed" });
  await waitFor(() => w.engineers.length === 1 && w.settled());
  assert.equal(w.engineers.length, 1);
});

test("with no tier that can see, the old refusal stands", async () => {
  const w = world((o, n) => (n === 1 ? { text: "", error: { kind: "api", detail: REFUSED } } : { text: `Opened ${pr(1)}. Could not look at the screenshot.` }));
  w.store.setSetting("textOnlyModels", [resolveModel("opus"), resolveModel("fable")]);
  w.jobs.start("engineer", "Build the navigation shell", FOUNDER, "product", FOUNDER, { doneWhen: "A1: each area opens its own URL" });
  await waitFor(() => w.engineers.length === 2 && w.settled());
  const second = w.engineers[1]!;
  assert.equal(second.denyImages, true);
  assert.equal(second.onImageNeeded, undefined);
  assert.ok(second.prompt.endsWith(img.TEXT_ONLY_NOTE));
});
