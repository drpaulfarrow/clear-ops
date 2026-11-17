import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-import-"));

const { Store } = await import("../src/store.js");
const { importOffboardRun, OFFBOARD_DIR, OFFBOARD_RUN_ID } = await import("../src/offboard-import.js");

/** The run's own files, with the real run's facts (the 17 Nov 2026 offboard draft). */
function writeRun(dir: string, over: { status?: object; result?: object; output?: string } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "strategy.status.json"),
    JSON.stringify(
      {
        id: "strategy",
        model: "moonshotai/kimi-k3.1-pro",
        state: "completed",
        startedAt: "2026-11-17T02:53:09.424Z",
        updatedAt: "2026-11-17T03:01:35.960Z",
        lastActivityAt: "2026-11-17T03:01:35.918Z",
        cost: { usd: 0.84, calls: 13, read: 13, source: "provider" },
        ...(over.status ?? {}),
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(dir, "strategy.result.json"),
    JSON.stringify({ id: "strategy", output: "strategy.output.md", finishedAt: "2026-11-17T03:01:35.960Z", ...(over.result ?? {}) }, null, 2),
  );
  fs.writeFileSync(path.join(dir, "strategy.output.md"), over.output ?? "# Doubleshift: diligence and document pack\n\nDocument 00: index.\n");
}

test("the one-use import writes the offboard run's own facts as a truthful, finished record", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-run-"));
  writeRun(dir);
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-import-store-")));
  assert.equal(store.allJobs().length, 0);

  const imported = importOffboardRun(store, dir);
  assert.ok(imported?.created, "the first import creates the record");
  const job = imported!.job;
  assert.equal(job.importedRun, OFFBOARD_RUN_ID);
  assert.equal(job.kind, "write");
  assert.equal(job.title, "Doubleshift strategy pack (imported)");
  assert.equal(job.status, "done", "the run is imported as finished, never queued or running");
  assert.equal(job.model, "moonshotai/kimi-k3.1-pro", "the model that actually ran");
  assert.equal(job.startedAt, "2026-11-17T02:53:09.424Z", "the run's own start");
  assert.equal(job.createdAt, "2026-11-17T02:53:09.424Z");
  assert.equal(job.finishedAt, "2026-11-17T03:01:35.960Z", "the run's own finish");
  assert.equal(job.lastActivityAt, "2026-11-17T03:01:35.918Z");
  assert.equal(job.costUsd, 0.84, "the settled provider cost, not the SDK estimate");
  assert.equal(job.target, "doubleshift");
  assert.equal(job.triggerMessage, undefined, "no fabricated trigger provenance");
  assert.equal(job.permits, undefined);
  // The labelling says what it is: an import, not a run by this service.
  assert.match(job.brief, /^Imported record, not a run by this service/);
  assert.match(job.brief, /which began 2026-11-17T02:53:09\.424Z and finished 2026-11-17T03:01:35\.960Z on moonshotai\/kimi-k3\.1-pro/);
  assert.match(job.brief, /13 provider calls, USD 0\.84 settled/);
  assert.match(job.summary ?? "", /^Imported: the Doubleshift strategy pack from the completed offboard "strategy" run/);
  // The artifact is preserved verbatim as the saved output, and nothing else is read into it.
  const artifact = fs.readFileSync(path.join(dir, "strategy.output.md"), "utf8");
  assert.equal(store.readOutput(job.id), artifact);
  assert.equal(job.outputPath, store.outputPath(job.id));
});

test("the import is idempotent: a second call returns the same record and writes nothing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-run-"));
  writeRun(dir);
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-import-store-")));
  const first = importOffboardRun(store, dir)!;
  assert.ok(first.created, "the first import creates the record");
  const count = store.allJobs().length;
  const second = importOffboardRun(store, dir)!;
  assert.ok(!second.created, "the second import creates nothing");
  assert.equal(second.job.id, first.job.id, "the same record comes back");
  assert.equal(store.allJobs().length, count, "no second record");
  // Once the record is in the store it is the gate, whatever the directory says: nothing more is read.
  const third = importOffboardRun(store, "/a/directory/that/is/not/there")!;
  assert.ok(!third.created && third.job.id === first.job.id);
});

/** The refusal path, quietly: importOffboardRun itself warns. */
async function quietRejection(store: InstanceType<typeof Store>, dir: string) {
  const warns: string[] = [];
  const original = console.warn;
  console.warn = (m: unknown) => warns.push(String(m));
  try {
    return { warns, result: importOffboardRun(store, dir) };
  } finally {
    console.warn = original;
  }
}

test("the import refuses what is not the completed run, and creates nothing", async () => {
  for (const case_ of [
    { name: "no directory", make: (d: string) => void fs.mkdirSync(path.dirname(d), { recursive: true }) },
    { name: "no files", make: (d: string) => fs.mkdirSync(d, { recursive: true }) },
    {
      name: "not completed",
      make: (d: string) => writeRun(d, { status: { state: "running" } }),
    },
    {
      name: "another run",
      make: (d: string) => writeRun(d, { status: { id: "other" } }),
    },
    {
      name: "no settled cost",
      make: (d: string) => writeRun(d, { status: { cost: { calls: 13 } } }),
    },
    {
      name: "result names another artifact",
      make: (d: string) => writeRun(d, { result: { output: "elsewhere.md" } }),
    },
    {
      name: "unparsable status",
      make: (d: string) => {
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, "strategy.status.json"), "{ not json");
        fs.writeFileSync(path.join(d, "strategy.result.json"), "{}");
        fs.writeFileSync(path.join(d, "strategy.output.md"), "x");
      },
    },
    {
      name: "empty artifact",
      make: (d: string) => writeRun(d, { output: "   " }),
    },
  ]) {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-refuse-")), case_.name.replace(/\W+/g, "-"));
    case_.make(dir);
    const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-import-store-")));
    const { warns, result } = await quietRejection(store, dir);
    assert.equal(result, undefined, `${case_.name}: nothing is imported`);
    assert.equal(store.allJobs().length, 0, `${case_.name}: no record is created`);
    assert.ok(warns.some((w) => w.startsWith("offboard import: ") && w.endsWith("Nothing was imported.")), `${case_.name}: the refusal is said, once`);
  }
});

test("the import's scope is fixed: the one directory and the one run id, from the service's own entry", () => {
  assert.equal(OFFBOARD_DIR, "/data/overnight-20261117");
  assert.equal(OFFBOARD_RUN_ID, "strategy");
  const index = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(index, /importOffboardRun\(store\)/, "the import runs from the main entry only");
  assert.doesNotMatch(index, /importOffboardRun\(store, /, "the call passes no directory: the default is the fixed one");
});