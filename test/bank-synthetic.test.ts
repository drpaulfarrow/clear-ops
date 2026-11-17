/**
 * The synthetic-only boundary itself, as a commission condition: bank tests cannot load real
 * credentials, real keys on the host cannot silently enable real provider reads during this work, and
 * no test can call the provider's production address whatever it constructs.
 *
 * This file is the proof the boundary holds, not just the place it is declared: every bank test file
 * calls `bankTestBoundary()` (test/bank-synthetic.ts) before importing the source, and the assertions
 * here read that enforcement back out of the source and the test files rather than trusting the list.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { bankTestBoundary } from "./bank-synthetic.js";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-bank-synthetic-"));
process.env.PUBLIC_URL = "https://workforce.example";
bankTestBoundary();

const { bankSettings, bankReady, BANK_API_HOSTS } = await import("../src/bank.js");
const { BankApi, BankApiError } = await import("../src/bank-api.js");

const { privateKey: RSA_KEY } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

test("no bank test can load real credentials: every BANK_ variable is gone from the test process", () => {
  for (const k of Object.keys(process.env)) assert.ok(!k.startsWith("BANK_"), `${k} survived the boundary`);
  // A stray bankSettings() reads the process environment by default, so it must see a clean one even
  // on a host that has every real variable set.
  const stray = bankSettings();
  assert.equal(stray.enabled, false, "off by default, whatever the host has");
  assert.match(bankReady(stray) ?? "", /switched off here \(BANK_ENABLED is not set\)/);
});

test("real-looking keys in the environment cannot silently enable the connector, let alone a call", () => {
  // Everything a live application would need, except BANK_ENABLED: the connector stays off, and a
  // gate over these settings refuses before anything is asked of the provider.
  const without = bankSettings({
    BANK_APPLICATION_ID: "11111111-2222-3333-4444-555555555555",
    BANK_JWT_PRIVATE_KEY: RSA_KEY,
    BANK_CONNECTION_KEY: "a connection key long enough to be one",
    BANK_REDIRECT_URL: "https://workforce.example/bank/callback",
  });
  assert.equal(without.applicationId.length > 0 && without.jwtKey.length > 0 && without.connectionKey.length > 0, true, "the synthetic variables are all there");
  assert.match(bankReady(without) ?? "", /switched off here \(BANK_ENABLED is not set\)/, "and the connector is still off");
  // The one variable that turns it on is the switch itself, and it is never inherited from the host.
  const on = bankSettings({ BANK_ENABLED: "true", BANK_APPLICATION_ID: "11111111-2222-3333-4444-555555555555", BANK_JWT_PRIVATE_KEY: RSA_KEY, BANK_CONNECTION_KEY: "a connection key long enough to be one", BANK_REDIRECT_URL: "https://workforce.example/bank/callback" });
  assert.equal(bankReady(on), undefined, "only a synthetic literal that says so turns it on");
});

test("a bank test that would call the real provider fails loudly rather than leaving the machine", async () => {
  // A real client, complete synthetic settings, and no fetchImpl injected: the default fetch is the
  // boundary's wrapper, and the provider's own address is the one host the client may call — so this
  // is the closest a test can get to a real read, and it must not go anywhere.
  const api = new BankApi({
    settings: bankSettings({
      BANK_ENABLED: "true",
      BANK_APPLICATION_ID: "11111111-2222-3333-4444-555555555555",
      BANK_JWT_PRIVATE_KEY: RSA_KEY,
      BANK_CONNECTION_KEY: "a connection key long enough to be one",
      BANK_REDIRECT_URL: "https://workforce.example/bank/callback",
    }),
  });
  await assert.rejects(
    () => api.listAspsps("GB"),
    (err: unknown) => {
      // The client turns the refusal into its own network failure, so a caller sees its plain
      // sentence; the refusal itself must still be underneath it, not swallowed.
      assert.ok(err instanceof BankApiError && err.kind === "network", "the client fails the read rather than reaching anyone");
      assert.match(String((err.cause as Error | undefined)?.message ?? ""), /synthetic-only/, "and the boundary's own refusal is still visible on it");
      return true;
    },
    "the boundary refuses the call before it leaves",
  );
});

test("the boundary covers every bank test file, and no bank test builds settings from the host's environment", () => {
  const files = ["bank-api.test.ts", "bank-connect.test.ts", "bank-page.test.ts", "bank-store.test.ts", "bank-synthetic.test.ts"];
  for (const f of files) {
    const text = fs.readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
    assert.match(text, /bankTestBoundary\(\)/, `${f} must call the boundary before importing the source`);
    assert.doesNotMatch(text, /bankSettings\(\{\s*\.\.\.process\.env/, `${f} must not spread the host environment into bankSettings`);
  }
  assert.deepEqual(BANK_API_HOSTS, ["api.enablebanking.com"], "the one address the boundary refuses is the one the client may call");
});
