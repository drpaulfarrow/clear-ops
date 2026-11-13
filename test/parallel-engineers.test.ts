/**
 * Two engineering jobs per repository at once (Paul's call, 13 Nov 2026), each in its own working copy:
 * the checkout for the first, a git worktree beside it for the second. A third waits its turn.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-parallel-"));

const { Store } = await import("../src/store.js");
const { JobRunner, ensureLane, laneDir, laneNote } = await import("../src/jobs.js");
const { ConsoleMessenger } = await import("../src/whatsapp.js");
const { config } = await import("../src/config.js");
import type { AgentRunner, RunResult } from "../src/agents.js";

const FOUNDER = "tg:99887766";

const waitFor = async (pred: () => boolean, ms = 8000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

function setup(slots = 2) {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-par-")));
  const messenger = new ConsoleMessenger();
  const gates = new Map<string, (r: RunResult) => void>();
  const started: Array<{ key: string; cwd?: string; prompt: string }> = [];
  const runner: AgentRunner = (o) =>
    new Promise<RunResult>((resolve) => {
      const key = o.prompt.split("\n")[0];
      started.push({ key, cwd: o.cwd, prompt: `${o.systemPrompt ?? ""}\n${o.prompt}` });
      gates.set(key, resolve);
    });
  const jobs = new JobRunner(store, messenger, runner, undefined, { slots });
  return { store, jobs, started, finish: (key: string) => gates.get(key)!({ text: `${key} done` }) };
}

test("the default is two engineers per repository", () => {
  assert.equal(config.engineerSlots, 2);
});

test("two engineer jobs on one repository run at once; a third waits and takes the freed copy", async () => {
  const { store, jobs, started, finish } = setup();
  const a = jobs.start("engineer", "A", FOUNDER, "product");
  const b = jobs.start("engineer", "B", FOUNDER, "product");
  const c = jobs.start("engineer", "C", FOUNDER, "product");
  assert.equal(store.getJob(a.id)!.status, "running");
  assert.equal(store.getJob(b.id)!.status, "running");
  assert.equal(c.status, "queued");
  assert.ok(c.waitingFor);
  await waitFor(() => started.some((s) => s.key === "A") && started.some((s) => s.key === "B"));
  assert.equal(started.some((s) => s.key === "C"), false, "C waits while both copies are busy");
  assert.equal(store.getJob(a.id)!.lane, undefined, "the first works in the checkout");
  assert.equal(store.getJob(b.id)!.lane, 1, "the second gets its own copy");

  finish("A");
  await waitFor(() => started.some((s) => s.key === "C"));
  assert.equal(store.getJob(c.id)!.status, "running");
  assert.equal(store.getJob(c.id)!.lane, undefined, "C takes the copy A freed, not B's");
  finish("B");
  finish("C");
});

test("other repositories and other kinds are unaffected; one slot keeps the old one-at-a-time queue", async () => {
  const { store, jobs, started } = setup(1);
  const a = jobs.start("engineer", "A1", FOUNDER, "product");
  const b = jobs.start("engineer", "B1", FOUNDER, "product");
  const s = jobs.start("engineer", "S1", FOUNDER, "self");
  assert.equal(store.getJob(a.id)!.status, "running");
  assert.equal(b.status, "queued");
  assert.equal(store.getJob(s.id)!.status, "running", "the workforce repository has its own slots");
  await waitFor(() => started.length >= 2);
});

function gitRepo(): { origin: string; checkout: string } {
  const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const origin = fs.mkdtempSync(path.join(os.tmpdir(), "par-origin-"));
  sh(origin, "init", "--bare", "-b", "main", ".");
  const seed = fs.mkdtempSync(path.join(os.tmpdir(), "par-seed-"));
  sh(seed, "init", "-b", "main", ".");
  sh(seed, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "one");
  sh(seed, "remote", "add", "origin", origin);
  sh(seed, "push", "-q", "origin", "main");
  const checkout = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "par-co-")), "product");
  execFileSync("git", ["clone", "-q", origin, checkout]);
  // A newer commit lands on main after the checkout was cloned.
  sh(seed, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "two");
  sh(seed, "push", "-q", "origin", "main");
  return { origin, checkout };
}

test("a second copy is a git worktree beside the checkout, on the latest main, and work in it is kept", async () => {
  const { checkout } = gitRepo();
  const dir = await ensureLane(checkout, 1);
  assert.equal(dir, laneDir(checkout, 1));
  assert.equal(dir, `${checkout}.lane1`);
  const log = (cwd: string) => execFileSync("git", ["-C", cwd, "log", "--format=%s", "-1"], { encoding: "utf8" }).trim();
  assert.equal(log(dir), "two", "the copy starts on the latest main, not the checkout's older commit");
  assert.equal(log(checkout), "one", "the checkout itself is untouched");
  // Unfinished work in the copy survives the next job's set-up.
  fs.writeFileSync(path.join(dir, "wip.txt"), "half done");
  assert.equal(await ensureLane(checkout, 1), dir);
  assert.equal(fs.readFileSync(path.join(dir, "wip.txt"), "utf8"), "half done");
  // Without git or a checkout it falls back to the checkout rather than failing the job.
  const nowhere = path.join(os.tmpdir(), "par-no-such-checkout");
  assert.equal(await ensureLane(nowhere, 1), nowhere);
});

test("the engineer in the second copy is told where it works and to leave the checkout alone", () => {
  const note = laneNote("/data/workspace", "/data/workspace.lane1");
  assert.match(note, /your own copy of the repository at \/data\/workspace\.lane1/);
  assert.match(note, /never touch \/data\/workspace/);
  assert.equal(laneNote("/data/workspace", "/data/workspace"), "", "no note when it fell back to the checkout");
});
