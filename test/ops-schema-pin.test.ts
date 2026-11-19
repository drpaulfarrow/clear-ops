import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OPS_SCHEMA_VERSION, OPS_SERVER_NAME, type OpsToolShape } from "../src/ops-schema.js";

/**
 * The chief's ops tool shapes, checked in.
 *
 * `guardOpsSchema` refuses to boot when the chief's tools differ from what the production store has
 * pinned under the current namespace. CI's store is always empty, so that refusal can only ever
 * happen in production, where it is an outage: on 19 Nov 2026 a new tool (usage_report) merged
 * without a schema-version bump, every check passed, and the deploy that carried it could not start.
 *
 * This test moves the same comparison to `npm test`. It boots the real app on an empty store, reads
 * what the guard pinned (the exact shapes production compares), and holds them against
 * test/fixtures/ops-schema.json. A tool added, removed or changed without a version bump fails here.
 *
 * To change the chief's tools: bump OPS_SCHEMA_VERSION in src/ops-schema.ts, then rewrite the copy
 * with `PIN_OPS_SCHEMA=1 node --import tsx --test test/ops-schema-pin.test.ts` and commit it. The
 * rewrite is refused while the version is unchanged, so the copy cannot be refreshed in place of the bump.
 */
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "ops-schema.json");

interface Pinned {
  version: number;
  tools: OpsToolShape[];
}

const byName = (a: OpsToolShape, b: OpsToolShape) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** What a first boot pins: the real app, an empty store, the guard the service awaits before it listens. */
async function bootShapes(): Promise<OpsToolShape[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-pin-"));
  process.env.DATA_DIR = dir;
  const { buildApp } = await import("../src/index.js");
  const { Store } = await import("../src/store.js");
  const store = new Store(dir);
  const messenger = { send: async () => undefined } as never;
  const runner = (async () => ({ text: "" })) as never;
  const { orchestrator } = buildApp({ messenger, runner, store });
  await orchestrator.opsSchemaGuard;
  const pinned = store.opsSchema(OPS_SERVER_NAME);
  assert.ok(pinned?.length, "a first boot pins the chief's tool shapes under the current namespace");
  return [...pinned].sort(byName);
}

test("the chief's ops tools match the checked-in shapes for this schema version", async () => {
  const now = await bootShapes();
  const held = JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as Pinned;
  const same = JSON.stringify([...held.tools].sort(byName)) === JSON.stringify(now);

  if (process.env.PIN_OPS_SCHEMA === "1") {
    assert.ok(same || held.version !== OPS_SCHEMA_VERSION, `The chief's tools changed but OPS_SCHEMA_VERSION is still ${OPS_SCHEMA_VERSION}. Bump it in src/ops-schema.ts first, then pin again.`);
    fs.writeFileSync(FIXTURE, `${JSON.stringify({ version: OPS_SCHEMA_VERSION, tools: now }, null, 2)}\n`);
    return;
  }

  const heldNames = new Set(held.tools.map((t) => t.name));
  const nowNames = new Set(now.map((t) => t.name));
  const added = now.filter((t) => !heldNames.has(t.name)).map((t) => t.name);
  const removed = held.tools.filter((t) => !nowNames.has(t.name)).map((t) => t.name);
  const changed = now.filter((t) => heldNames.has(t.name) && JSON.stringify(t) !== JSON.stringify(held.tools.find((h) => h.name === t.name))).map((t) => t.name);
  const what = [added.length ? `added ${added.join(", ")}` : "", removed.length ? `removed ${removed.join(", ")}` : "", changed.length ? `changed ${changed.join(", ")}` : ""].filter(Boolean).join("; ");
  const fix = "Bump OPS_SCHEMA_VERSION in src/ops-schema.ts, then run `PIN_OPS_SCHEMA=1 node --import tsx --test test/ops-schema-pin.test.ts` and commit test/fixtures/ops-schema.json.";

  assert.ok(same, `The chief's ops tools differ from test/fixtures/ops-schema.json (${what}). Deployed as it is, the service would refuse to boot against the production store. ${fix}`);
  assert.equal(held.version, OPS_SCHEMA_VERSION, `test/fixtures/ops-schema.json was pinned for version ${held.version} and OPS_SCHEMA_VERSION is ${OPS_SCHEMA_VERSION}. Pin the copy again so the two move together.`);
});
