/** Everything about the bridge chat and the home device is off when the deploy passes nothing (empty values). */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-devcfg-"));
for (const k of ["BRIDGE_CHAT_ENABLED", "OVERSIGHT_SENDER_IDS", "DEVICE_ENABLED", "DEVICE_TEST_BUDGET_USD", "INSTINCT_BRIDGE_TOKEN"]) process.env[k] = "";

const { config, isOversightSender } = await import("../src/config.js");

test("empty deploy values leave the bridge chat, the device and its budget off", () => {
  assert.equal(config.instinctBridgeChat, false);
  assert.equal(config.deviceEnabled, false);
  assert.equal(config.deviceTestBudgetUsd, 0);
  assert.equal(config.instinctBridgeToken, "");
  assert.equal(isOversightSender("tg:1"), false);
});

test("the deploy passes those settings from repository variables, not secrets, so they can be set without a code change", () => {
  const yml = fs.readFileSync(path.join(import.meta.dirname, "..", ".github", "workflows", "deploy.yml"), "utf8");
  for (const k of ["BRIDGE_CHAT_ENABLED", "OVERSIGHT_SENDER_IDS", "DEVICE_ENABLED", "DEVICE_TEST_BUDGET_USD"]) assert.match(yml, new RegExp(`${k}="\\$\\{\\{ vars\\.${k} \\}\\}"`));
});
