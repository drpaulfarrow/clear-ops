/**
 * Engineering jobs at once per repository (Paul's call, 13 Nov 2026: more of them, not fewer), each in
 * its own working copy: the checkout for the first, a git worktree beside it for the next, and so on up
 * to ENGINEER_SLOTS. Anything past the slots waits its turn, in order, and a job that cannot be given a
 * working copy of its own waits for the checkout rather than writing into the copy someone else is using.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-parallel-"));
// Real checkouts, so the copies the jobs are given are real git worktrees.
const PRODUCT = gitRepo().checkout;
const SELF = gitRepo().checkout;
process.env.REPO_DIR = PRODUCT;
process.env.SELF_REPO_DIR = SELF;

const { Store } = await import("../src/store.js");
const { JobRunner, ensureLane, laneDir, laneNote, loadNote, memoryNote, readMemory, serialiseLaneSetup } = await import("../src/jobs.js");
const { ConsoleMessenger } = await import("../src/whatsapp.js");
const { config, engineerSlots, engineerSlotsLine, ENGINEER_SLOTS_MAX } = await import("../src/config.js");
import type { AgentRunner, RunResult } from "../src/agents.js";

const FOUNDER = "tg:99887766";

const waitFor = async (pred: () => boolean, ms = 8000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

function setup(slots = 2, copyWaitMs = 5) {
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
  const jobs = new JobRunner(store, messenger, runner, undefined, { slots, liveness: { copyWaitMs } });
  return { store, jobs, started, finish: (key: string) => gates.get(key)!({ text: `${key} done` }) };
}

test("the default is two engineers per repository", () => {
  assert.equal(config.engineerSlots, 2);
});

test("the slots are a plain number: more than before, and anything past the ceiling is refused", () => {
  assert.deepEqual(engineerSlots(undefined), { slots: 2, asked: 2 }, "unset: the default");
  assert.deepEqual(engineerSlots("4"), { slots: 4, asked: 4 }, "four at once, as the live machine runs");
  assert.deepEqual(engineerSlots("20"), { slots: ENGINEER_SLOTS_MAX, asked: 20 }, "above the ceiling: the ceiling wins");
  assert.equal(ENGINEER_SLOTS_MAX, 8);
  assert.deepEqual(engineerSlots("nonsense"), { slots: 2, asked: 2 });
  assert.deepEqual(engineerSlots("0"), { slots: 2, asked: 2 });
  // The start-up line says which number is in force, and says so plainly when a bigger one was refused.
  assert.match(engineerSlotsLine("4"), /^engineering: 4 jobs per repository at once, each in its own working copy, at most 8$/);
  assert.match(engineerSlotsLine("20"), /4?8 jobs per repository at once.*ENGINEER_SLOTS=20 is above the maximum of 8, so 8 is used/);
  assert.match(engineerSlotsLine("1"), /^engineering: 1 job per repository at once, at most 8$/);
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

test("four engineer jobs run at once, each in a copy of its own, and a fifth waits its turn", async () => {
  const { store, jobs, started, finish } = setup(4);
  const jobs4 = ["P1", "P2", "P3", "P4"].map((k) => jobs.start("engineer", k, FOUNDER, "product"));
  const fifth = jobs.start("engineer", "P5", FOUNDER, "product");
  for (const j of jobs4) assert.equal(store.getJob(j.id)!.status, "running");
  assert.equal(fifth.status, "queued", "past the slots, a job waits as before");
  assert.ok(jobs4.some((j) => j.id === fifth.waitingFor), "and says which job it is behind");
  assert.equal(jobs.queuePosition(fifth.id), 1);
  await waitFor(() => started.length >= 4);
  assert.deepEqual(
    jobs4.map((j) => store.getJob(j.id)!.lane),
    [undefined, 1, 2, 3],
    "the checkout and three git worktrees beside it: four working copies, no two the same",
  );
  assert.equal(started.some((s) => s.key === "P5"), false, "the fifth does not start while all four copies are busy");

  finish("P1");
  await waitFor(() => started.some((s) => s.key === "P5"));
  assert.equal(store.getJob(fifth.id)!.lane, undefined, "the fifth takes the copy the first job freed");
  for (const k of ["P2", "P3", "P4", "P5"]) finish(k);
});

test("eight at once is the most that may run, and a ninth queues rather than starting", async () => {
  const { store, jobs, started, finish } = setup(ENGINEER_SLOTS_MAX);
  const many = Array.from({ length: ENGINEER_SLOTS_MAX + 1 }, (_, i) => jobs.start("engineer", `M${i + 1}`, FOUNDER, "product"));
  const startedNow = many.filter((j) => store.getJob(j.id)!.status === "running");
  assert.equal(startedNow.length, ENGINEER_SLOTS_MAX, "no more than the ceiling starts, however many are asked for");
  assert.deepEqual(
    startedNow.map((j) => store.getJob(j.id)!.lane),
    [undefined, 1, 2, 3, 4, 5, 6, 7],
    "one working copy each",
  );
  const ninth = many[many.length - 1];
  assert.equal(ninth.status, "queued");
  await waitFor(() => started.length >= ENGINEER_SLOTS_MAX);
  for (let i = 1; i <= ENGINEER_SLOTS_MAX; i++) finish(`M${i}`);
});

test("the machine's load is a line in the log, never a throttle", () => {
  assert.equal(loadNote(1.5, 4), undefined, "a core and a half of work on four cores: nothing to say");
  assert.match(loadNote(4, 4)!, /heavy load 4\.0 on 4 cores/);
  assert.match(loadNote(9.2, 4)!, /heavy load 9\.2 on 4 cores/);
  assert.equal(loadNote(8, 0), undefined, "no cores known: no line");
});

test("the machine's memory is a line in the log when it is nearly full", () => {
  const GB = 1024 ** 3;
  assert.equal(memoryNote({ total: 4 * GB, available: 2 * GB }), undefined, "half the machine free: nothing to say");
  assert.equal(memoryNote({ total: 4 * GB, available: 0.6 * GB }), undefined, "15% free is still headroom");
  assert.match(
    memoryNote({ total: 4 * GB, available: 0.33 * GB })!,
    /^memory nearly full, 0\.3GB of 4\.0GB free$/,
    "the case four typechecks and their test runs reach: 333MB of 4GB",
  );
  assert.equal(memoryNote({ total: 0, available: 0 }), undefined, "no machine known: no line");
  assert.equal(memoryNote({ total: NaN, available: NaN }), undefined);
  // The real machine reads its own memory, and never invents a figure.
  const real = readMemory();
  assert.ok(real.total > 0 && real.available >= 0 && real.available <= real.total);
});

test("working copies for one repository are made one at a time, and a failure does not block the next", async () => {
  let inside = 0;
  let most = 0;
  const step = (key: string, ms: number) =>
    serialiseLaneSetup("/repo", async () => {
      inside++;
      most = Math.max(most, inside);
      await new Promise((r) => setTimeout(r, ms));
      inside--;
      return key;
    });
  const [one, two] = await Promise.all([step("one", 30), step("two", 1)]);
  assert.deepEqual([one, two], ["one", "two"], "and in the order they were asked for");
  assert.equal(most, 1, "two set-ups never run at once in the same repository");
  const bad = serialiseLaneSetup("/repo2", async () => {
    throw new Error("git said no");
  });
  const good = serialiseLaneSetup("/repo2", async () => "still here");
  await assert.rejects(bad, /git said no/);
  assert.equal(await good, "still here", "one checkout's failure never stops the next set-up");
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

test("the third and fourth copies are worktrees too, even when two jobs ask for one at the same moment", async () => {
  const { checkout } = gitRepo();
  const [one, three] = await Promise.all([ensureLane(checkout, 1), ensureLane(checkout, 3)]);
  assert.equal(one, laneDir(checkout, 1));
  assert.equal(three, laneDir(checkout, 3));
  for (const dir of [one, three]) {
    assert.ok(fs.existsSync(path.join(dir, ".git")), `${dir} is a working copy of its own`);
    assert.equal(execFileSync("git", ["-C", dir, "log", "--format=%s", "-1"], { encoding: "utf8" }).trim(), "two");
  }
});

test("the engineer in the second copy is told where it works and to leave the checkout alone", () => {
  const note = laneNote("/data/workspace", "/data/workspace.lane1");
  assert.match(note, /your own copy of the repository at \/data\/workspace\.lane1/);
  assert.match(note, /never touch \/data\/workspace/);
  assert.equal(laneNote("/data/workspace", "/data/workspace"), "", "no note when it fell back to the checkout");
});

test("a job that cannot be given a copy of its own waits for the checkout rather than sharing one", async () => {
  // The copy the second job would work in cannot be made: git has nowhere to put a worktree here.
  const blocked = laneDir(SELF, 1);
  fs.writeFileSync(blocked, "not a working copy");
  try {
    const { store, jobs, started, finish } = setup(2);
    const a = jobs.start("engineer", "W1", FOUNDER, "self");
    const b = jobs.start("engineer", "W2", FOUNDER, "self");
    await waitFor(() => started.some((s) => s.key === "W1"));
    assert.equal(started.find((s) => s.key === "W1")!.cwd, SELF, "the first job works in the checkout");
    // The second job waits: its own copy cannot be made and the checkout is the other job's working copy.
    await waitFor(() => /waiting for a working copy of its own/.test(jobs.liveness(b.id)?.summary ?? ""), 12_000);
    assert.equal(started.some((s) => s.key === "W2"), false, "it never starts in the first job's working copy");
    assert.equal(store.getJob(b.id)!.lane, 1, "it is still waiting for a copy of its own");
    // The first job finishes: its copy is free, and the job that was waiting takes it as its own.
    finish("W1");
    await waitFor(() => started.some((s) => s.key === "W2"));
    assert.equal(started.find((s) => s.key === "W2")!.cwd, SELF);
    assert.equal(store.getJob(b.id)!.lane, undefined, "the checkout is its own copy now, so the next job gets a lane");
    assert.equal(store.getJob(b.id)!.status, "running");
    finish("W2");
  } finally {
    fs.unlinkSync(blocked);
  }
});
