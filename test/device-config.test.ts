/** Everything about the bridge chat and the home device is off when the deploy passes nothing (empty values). */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-devcfg-"));
for (const k of ["BRIDGE_CHAT_ENABLED", "BRIDGE_CHAT_BUDGET_USD", "BRIDGE_COMMISSION_ALLOW", "BRIDGE_THREAD_GUILD_ID", "BRIDGE_THREAD_PARENT_ID", "OVERSIGHT_SENDER_IDS", "DEVICE_ENABLED", "DEVICE_TEST_BUDGET_USD", "INSTINCT_BRIDGE_TOKEN", "OPENROUTER_DEVICE_API_KEY", "OPENROUTER_BRIDGE_API_KEY"]) process.env[k] = "";

const { config, isOversightSender } = await import("../src/config.js");

test("empty deploy values leave the bridge chat, the device and its budget off", () => {
  assert.equal(config.instinctBridgeChat, false);
  assert.equal(config.deviceEnabled, false);
  assert.equal(config.deviceTestBudgetUsd, 0);
  assert.equal(config.instinctBridgeToken, "");
  assert.equal(config.deviceOpenrouterKey, "");
  assert.equal(config.bridgeOpenrouterKey, "");
  assert.equal(config.bridgeChatBudgetUsd, 0);
  assert.deepEqual(config.instinctBridgeCommissions, {});
  assert.equal(config.bridgeThreadGuildId, "");
  assert.equal(config.bridgeThreadParentId, "");
  assert.equal(isOversightSender("tg:1"), false);
});

test("the deploy passes those settings from repository variables, not secrets, so they can be set without a code change", () => {
  const yml = fs.readFileSync(path.join(import.meta.dirname, "..", ".github", "workflows", "deploy.yml"), "utf8");
  for (const k of ["BRIDGE_CHAT_ENABLED", "BRIDGE_CHAT_BUDGET_USD", "BRIDGE_COMMISSION_ALLOW", "BRIDGE_THREAD_GUILD_ID", "BRIDGE_THREAD_PARENT_ID", "OVERSIGHT_SENDER_IDS", "DEVICE_ENABLED", "DEVICE_TEST_BUDGET_USD", "OPENROUTER_FABLE_MODEL"]) assert.match(yml, new RegExp(`${k}="\\$\\{\\{ vars\\.${k} \\}\\}"`));
});

test("the deploy passes the device's separate OpenRouter key from a secret, next to (not instead of) the main key", () => {
  const yml = fs.readFileSync(path.join(import.meta.dirname, "..", ".github", "workflows", "deploy.yml"), "utf8");
  assert.match(yml, /OPENROUTER_DEVICE_API_KEY="\$\{\{ secrets\.OPENROUTER_DEVICE_API_KEY \}\}"/);
  assert.match(yml, /OPENROUTER_API_KEY="\$\{\{ secrets\.OPENROUTER_API_KEY \}\}"/);
});

test("the deploy passes the bridge chat's own separate key from a secret, never the main key", () => {
  const yml = fs.readFileSync(path.join(import.meta.dirname, "..", ".github", "workflows", "deploy.yml"), "utf8");
  assert.match(yml, /OPENROUTER_BRIDGE_API_KEY="\$\{\{ secrets\.OPENROUTER_BRIDGE_API_KEY \}\}"/);
});
