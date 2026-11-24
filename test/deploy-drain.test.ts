/**
 * Draining for a deploy (Paul, 23 Nov 2026: "Can we pause jobs for deploy elegantly?"). Before, a deploy
 * waited up to 45 minutes for every worker to finish, while new jobs kept starting. Now CI drains first:
 * no job starts while the drain lasts, running ones carry on, and the held ones start when it ends or
 * when the restart comes. Only the deploy's own key can ask for it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ENGINEER_SLOTS = "1";
process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-drain-"));

const { Store } = await import("../src/store.js");
const { JobRunner } = await import("../src/jobs.js");
const { ConsoleMessenger } = await import("../src/whatsapp.js");
const { buildApp } = await import("../src/index.js");
const { appBoard } = await import("../src/app-data.js");
import type { AgentRunner, RunOptions } from "../src/agents.js";

const FOUNDER = "tg:99887766";
const waitFor = async (pred: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};
const pause = (ms = 50) => new Promise((r) => setTimeout(r, ms));

function world() {
  let clock = Date.UTC(2026, 10, 23, 10, 0, 0);
  const runs: RunOptions[] = [];
  const runner: AgentRunner = async (o) => {
    runs.push(o);
    return { text: "Done. Nothing to review." };
  };
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-drain-store-")));
  const jobs = new JobRunner(store, new ConsoleMessenger(), runner, undefined, { liveness: { now: () => clock } });
  return { store, jobs, runs, tick: (ms: number) => (clock += ms) };
}

test("while a drain lasts nothing starts; when it ends the held jobs start, in order", async () => {
  const w = world();
  const out = w.jobs.drain(25);
  assert.equal(out.until, new Date(Date.UTC(2026, 10, 23, 10, 25)).toISOString());
  assert.ok(w.jobs.draining());
  const research = w.jobs.start("research", "Look into X", FOUNDER, "product", FOUNDER);
  const build = w.jobs.start("engineer", "Build Y", FOUNDER, "product", FOUNDER, { doneWhen: "A1: Y works" });
  await pause();
  assert.equal(w.runs.length, 0, "nothing starts only to be cut off by the restart");
  for (const id of [research.id, build.id]) {
    const j = w.store.getJob(id)!;
    assert.equal(j.status, "queued");
    assert.equal(j.capBlocked, true, "held the way the cap holds a job, so the board shows it as held");
  }
  // The drain lapses (a deploy that never came): the watchdog's next turn starts them.
  w.tick(26 * 60_000);
  assert.equal(w.jobs.draining(), undefined);
  await w.jobs.resumeInterrupted();
  await w.jobs.checkLiveness();
  await waitFor(() => w.runs.length >= 2);
  assert.ok(w.store.allJobs().every((j) => !j.capBlocked));
});

test("a new process starts undrained, and boot starts what the drain held", async () => {
  const w = world();
  w.jobs.drain(25);
  const held = w.jobs.start("research", "Look into X", FOUNDER, "product", FOUNDER);
  await pause();
  // The restart: the same store, a new runner with nothing in memory.
  const runs: RunOptions[] = [];
  const after = new JobRunner(w.store, new ConsoleMessenger(), async (o) => (runs.push(o), { text: "Done." }));
  assert.equal(after.draining(), undefined);
  await after.resumeInterrupted();
  await after.checkLiveness();
  await waitFor(() => runs.length === 1);
  assert.ok(runs[0]!.prompt.includes("Look into X"));
  assert.notEqual(w.store.getJob(held.id)!.capBlocked, true);
});

test("a drain is capped, and a second one only ever extends it", () => {
  const w = world();
  const max = new Date(Date.UTC(2026, 10, 23, 10, JobRunner.DRAIN_MAX_MINUTES)).toISOString();
  assert.equal(w.jobs.drain(600).until, max);
  assert.equal(w.jobs.drain(1).until, max, "a shorter ask never shortens one already on");
  assert.equal(world().jobs.drain(Number.NaN).until, new Date(Date.UTC(2026, 10, 23, 10, 1)).toISOString());
});

test("only the deploy's own key drains, and without one the route does not exist", async () => {
  const listen = (key?: string) => {
    const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-drain-app-")));
    const built = buildApp({ messenger: { send: async () => undefined, recent: async () => [] }, runner: async () => ({ text: "" }), store, deployDrainToken: key ?? "" });
    return new Promise<{ base: string; close: () => void; jobs: typeof built.jobs; store: typeof store }>((resolve) => {
      const srv = built.app.listen(0, () =>
        resolve({ base: `http://127.0.0.1:${(srv.address() as import("node:net").AddressInfo).port}`, close: () => (built.scheduler.stopAll(), srv.close()), jobs: built.jobs, store }),
      );
    });
  };
  const drain = (base: string, auth?: string) => fetch(`${base}/deploy/drain`, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) }, body: JSON.stringify({ minutes: 25 }) });
  const off = await listen();
  try {
    assert.equal((await drain(off.base, "Bearer anything")).status, 404);
  } finally {
    off.close();
  }
  const on = await listen("the-deploys-own-key-0123456789");
  try {
    assert.equal((await drain(on.base)).status, 401);
    assert.equal((await drain(on.base, "Bearer wrong")).status, 401);
    assert.equal(on.jobs.draining(), undefined, "a refused ask holds nothing");
    const ok = await drain(on.base, "Bearer the-deploys-own-key-0123456789");
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { until: string; running: number; held: number };
    assert.equal(body.running, 0);
    assert.ok(on.jobs.draining());
    // The board says so.
    assert.ok(appBoard({ store: on.store, queue: on.jobs }).deploying);
  } finally {
    on.close();
  }
});

test("CI drains with the secret, waits a short grace, and falls back to waiting for quiet without it", () => {
  const yml = fs.readFileSync(new URL("../.github/workflows/deploy.yml", import.meta.url), "utf8");
  assert.match(yml, /DRAIN_TOKEN: \$\{\{ secrets\.DEPLOY_DRAIN_TOKEN \}\}/);
  assert.match(yml, /-H "Authorization: Bearer \$DRAIN_TOKEN"[^\n]*"https:\/\/\$\{FLY_APP\}\.fly\.dev\/deploy\/drain"/);
  assert.match(yml, /rounds=90\n[\s\S]*?rounds=20\n/);
  assert.match(yml, /for i in \$\(seq 1 "\$rounds"\); do/);
  assert.match(yml, /DEPLOY_DRAIN_TOKEN="\$\{\{ secrets\.DEPLOY_DRAIN_TOKEN \}\}"/);
  // The key is never printed: the drain's answer goes nowhere.
  assert.match(yml, /fly\.dev\/deploy\/drain" >\/dev\/null 2>&1/);
});

test("the drain key never reaches a worker", async () => {
  const { workerGithubEnv, GithubAuth } = await import("../src/github-auth.js");
  const env = await workerGithubEnv({ PATH: "/usr/bin", DEPLOY_DRAIN_TOKEN: "the-deploys-own-key" }, new GithubAuth(), undefined, []);
  assert.equal(env.DEPLOY_DRAIN_TOKEN, undefined);
});

test("the drain key is absent from the environment every launch path constructs, even when the live process.env holds it", async () => {
  const { workerGithubEnv, GithubAuth } = await import("../src/github-auth.js");
  const { installerEnv, workerBuildEnv } = await import("../src/setup.js");
  const { llmEnv } = await import("../src/llm.js");
  // The live base, not a stand-in: workerEnv (src/agents.ts) builds every worker's environment
  // from workerGithubEnv(process.env, githubAuth, ...), so the base that matters is process.env.
  const saved = process.env.DEPLOY_DRAIN_TOKEN;
  process.env.DEPLOY_DRAIN_TOKEN = "the-deploys-own-key-0123456789";
  try {
    // Every launch path is one funnel: sdkRunner (the only query() caller) composes its
    // environment from workerEnv, which is workerGithubEnv(process.env, ...) plus further
    // deletions (LLM, search, transcription keys), never an addition.
    const env = await workerGithubEnv(process.env, new GithubAuth(), undefined, []);
    assert.equal(env.DEPLOY_DRAIN_TOKEN, undefined);
    // After workerEnv, the composition only adds fixed keys: the npm development-mode settings a
    // kind that builds gets (the only RunOptions env, src/jobs.ts), the model keys, and the
    // SDK's own settings (src/agents.ts).
    const composed = {
      ...env,
      ...workerBuildEnv("/tmp/npm-cache"),
      ...llmEnv("an-openrouter-key"),
      CLAUDE_CONFIG_DIR: "/tmp/claude",
      CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1",
      CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "4",
    };
    assert.equal(composed.DEPLOY_DRAIN_TOKEN, undefined);
    assert.equal(workerBuildEnv(undefined).DEPLOY_DRAIN_TOKEN, undefined);
    assert.equal(llmEnv("an-openrouter-key").DEPLOY_DRAIN_TOKEN, undefined);
    // The npm child an engineer's own setup runs: an allowlist, so it never sees the key either.
    assert.equal(installerEnv(process.env, "/tmp/npm-cache").DEPLOY_DRAIN_TOKEN, undefined);
  } finally {
    if (saved === undefined) delete process.env.DEPLOY_DRAIN_TOKEN;
    else process.env.DEPLOY_DRAIN_TOKEN = saved;
  }
});

test("the runner's environment cannot be rebuilt around the strip", () => {
  const agents = fs.readFileSync(new URL("../src/agents.ts", import.meta.url), "utf8");
  // sdkRunner still builds the SDK's env from workerEnv, and workerEnv still builds on
  // workerGithubEnv(process.env, ...): a move of the construction cannot sidestep the strip.
  assert.match(agents, /env:\s*\{\s*\.\.\.\(await workerEnv\(/);
  assert.match(agents, /await workerGithubEnv\(process\.env, githubAuth/);
  // One query() caller, so no other path hands an environment to a run.
  assert.equal((agents.match(/query\(\{/g) ?? []).length, 1);
});
