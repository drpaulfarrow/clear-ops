/**
 * What is kept between visits, and what is never kept at all.
 *
 * The record holds one provider session id, the chosen accounts as keyed handles, masked labels and the
 * consent's own scope and expiry. No balance, no transaction, no credential, and nothing readable
 * without the dedicated key: a missing key, a changed key or a single altered byte stops the connector
 * with one plain sentence rather than reading part of a record. The Google token file is the precedent
 * this follows, and it goes further in two ways: the key is its own secret with no fallback to another,
 * and the record's own name is bound into the ciphertext.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-bank-store-"));

const { seal, open, connectionKey, uidHash, accountLabel, sameSecret, BankStore, BankError, BANK_KEY_NOTE } = await import("../src/bank.js");

const KEY = "a connection key long enough to be one";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-bank-store-"));

const connection = (over: Record<string, unknown> = {}) => ({
  sessionId: "sess-abcdef-1234",
  aspsp: { name: "HSBC UK", country: "GB" },
  scope: ["read"],
  accessValidUntil: "2027-02-13T00:00:00Z",
  accounts: [{ uidHash: uidHash("acc-1", connectionKey(KEY)), label: "Everyday Current Account · ••5555" }],
  connectedAt: "2026-11-15T09:00:00.000Z",
  ...over,
});

/* ---------- Sealing ---------- */

test("a record seals and opens, and never seals the same bytes twice", () => {
  const key = connectionKey(KEY);
  const a = seal("hello", key);
  const b = seal("hello", key);
  assert.notEqual(a, b, "a fresh nonce every time, so two records with the same content differ");
  assert.equal(open(a, key), "hello");
  assert.equal(open(b, key), "hello");
  assert.match(a, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, "version, nonce, body, tag");
  assert.ok(!a.includes("hello"), "and the plaintext is not in it");
});

test("one altered byte, one wrong key or one wrong name is nothing at all", () => {
  const key = connectionKey(KEY);
  const sealed = seal(JSON.stringify(connection()), key);
  const [v, iv, body, tag] = sealed.split(".");

  // A flipped byte anywhere: the nonce, the body or the tag.
  const flip = (s: string) => `${s.slice(0, 4)}${s[4] === "A" ? "B" : "A"}${s.slice(5)}`;
  for (const parts of [
    [v, flip(iv), body, tag],
    [v, iv, flip(body), tag],
    [v, iv, body, flip(tag)],
  ]) {
    assert.throws(() => open(parts.join("."), key), BankError, `${parts.join(".")} must not open`);
  }
  assert.throws(() => open(sealed, key, Buffer.from("something-else")), BankError, "the record's name is authenticated with it");
  assert.throws(() => open(sealed, connectionKey("a different connection key entirely")), /cannot be read/);
  // Shapes this service did not write.
  assert.throws(() => open("v2.a.b.c", key), /not in a form this service wrote/);
  assert.throws(() => open("just some text", key), /not in a form/);
  assert.throws(() => open("", key), /not in a form/);
  assert.throws(() => open(`${sealed}.extra`, key), /not in a form/);
});

test("the key is its own secret and there is no weaker one to fall back to", () => {
  assert.throws(() => connectionKey(""), /no connection key/);
  assert.throws(() => connectionKey("too short"), /no connection key/);
  assert.equal(connectionKey(KEY).length, 32, "hashed to 32 bytes for AES-256");
  assert.notDeepEqual(connectionKey(KEY), connectionKey(`${KEY} `), "and it is not another secret rewritten");
  assert.deepEqual(connectionKey(KEY), connectionKey(KEY));
  assert.match(BANK_KEY_NOTE, /AES-256-GCM/);
});

/* ---------- Handles and labels ---------- */

test("an account is kept as a keyed handle, and the page shows a masked label", () => {
  const key = connectionKey(KEY);
  const other = connectionKey("another connection key, also long enough");
  const h = uidHash("GB33BUKB20201555555555", key);
  assert.equal(h, uidHash("GB33BUKB20201555555555", key), "stable for the same key");
  assert.notEqual(h, uidHash("GB33BUKB20201555555556", key));
  assert.notEqual(h, uidHash("GB33BUKB20201555555555", other), "and useless without this key");
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.ok(!h.includes("BUKB"), "the id is not in its handle");

  assert.equal(accountLabel({ name: "Everyday Current Account", iban: "GB33BUKB20201555555555" }), "Everyday Current Account · ••5555");
  assert.equal(accountLabel({ iban: "GB33BUKB20201555555555" }), "••5555", "nothing but the last four characters, ever");
  assert.ok(!accountLabel({ name: "X", iban: "GB33BUKB20201555555555" }).includes("GB33BUKB"), "no full identifier");
  assert.equal(accountLabel({ name: "  Savings   Account  " }), "Savings Account");
  assert.equal(accountLabel({}), "unnamed account");
  const long = accountLabel({ name: "x".repeat(200), iban: "1234" });
  assert.ok(long.length <= 80, "and it is clipped");
  assert.match(long, /••1234$/);
});

test("two secrets are compared without the comparison saying anything", () => {
  assert.equal(sameSecret("abc", "abc"), true);
  assert.equal(sameSecret("abc", "abd"), false);
  assert.equal(sameSecret("abc", "abcd"), false);
  assert.equal(sameSecret(undefined, "abc"), false);
  assert.equal(sameSecret("abc", undefined), false);
  assert.equal(sameSecret("", ""), false, "an empty secret is never a match");
});

/* ---------- The stored record ---------- */

test("no key means the connector is off, not a plaintext file", () => {
  const dir = tmp();
  const store = new BankStore(dir);
  const off = store.state("");
  assert.equal(off.kind, "off");
  assert.match((off as { reason: string }).reason, /no connection key \(BANK_CONNECTION_KEY\)/);
  assert.equal(store.state("short").kind, "off");
  assert.equal(fs.existsSync(store.file()), false);
  assert.throws(() => store.save("", connection()), /no connection key/, "and it cannot write one either");
  assert.equal(fs.existsSync(store.file()), false);
});

test("a record is written owner-only, encrypted, and read back whole", () => {
  const dir = tmp();
  const store = new BankStore(dir);
  assert.deepEqual(store.state(KEY), { kind: "none" }, "nothing kept yet");
  store.save(KEY, connection());

  assert.equal(fs.statSync(store.file()).mode & 0o777, 0o600, "the file is owner-only");
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700, "and so is its directory");
  const raw = fs.readFileSync(store.file(), "utf8");
  assert.match(raw, /^v1\./);
  for (const secret of ["sess-abcdef-1234", "HSBC", "Everyday", "5555"]) {
    assert.ok(!raw.includes(secret), `the file does not contain ${secret} in the clear`);
  }
  const state = store.state(KEY);
  assert.equal(state.kind, "connection");
  assert.equal((state as { connection: { sessionId: string } }).connection.sessionId, "sess-abcdef-1234");
  assert.equal(store.connection(KEY)?.aspsp.name, "HSBC UK");
  assert.equal(store.connection("wrong") as unknown, undefined);
});

test("a changed key or an altered file is one plain state, never a partial record", () => {
  const dir = tmp();
  const store = new BankStore(dir);
  store.save(KEY, connection());

  const raw = fs.readFileSync(store.file(), "utf8");
  const changed = new BankStore(dir);
  const state = changed.state("a completely different connection key");
  assert.equal(state.kind, "unreadable");
  assert.match((state as { reason: string }).reason, /cannot be read \(its key changed, or the file was altered\)/);
  assert.throws(() => changed.connection("a completely different connection key"), BankError, "and it is never handed out");
  changed.touch("a completely different connection key"); // stamps nothing, and never throws
  assert.equal(fs.readFileSync(store.file(), "utf8"), raw, "an unreadable record is left exactly as it was");

  // An altered byte in the file itself is the same answer.
  const [v, iv, body, tag] = raw.split(".");
  fs.writeFileSync(store.file(), [v, iv, `${body.slice(0, -2)}${body.slice(-2) === "AA" ? "BB" : "AA"}`, tag].join("."), { mode: 0o600 });
  const altered = new BankStore(dir).state(KEY);
  assert.equal(altered.kind, "unreadable");
  assert.ok(!(altered as { reason: string }).reason.includes("sess-"), "and the sentence carries nothing from the record");

  // A file with something else in it entirely is refused as a shape, not parsed hopefully.
  fs.writeFileSync(store.file(), "hello there", { mode: 0o600 });
  assert.equal(new BankStore(dir).state(KEY).kind, "unreadable");
});

test("a record whose contents are not a connection is refused rather than half used", () => {
  const dir = tmp();
  const store = new BankStore(dir);
  for (const text of ["{}", "null", '"a string"', '{"sessionId":""}', '{"sessionId":"s"}', '{"sessionId":"s","accounts":"no"}']) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(store.file(), seal(text, connectionKey(KEY)), { mode: 0o600 });
    assert.equal(store.state(KEY).kind, "unreadable", `${text} is not a connection`);
  }
});

test("the time of a read is stamped without ever losing the record", () => {
  const dir = tmp();
  const store = new BankStore(dir, () => Date.UTC(2026, 10, 15, 12, 0, 0));
  store.save(KEY, connection());
  store.touch(KEY);
  assert.equal(store.connection(KEY)?.lastReadAt, "2026-11-15T12:00:00.000Z");
  store.touch(KEY, "2026-11-15T13:00:00.000Z");
  assert.equal(store.connection(KEY)?.lastReadAt, "2026-11-15T13:00:00.000Z");
  assert.equal(store.connection(KEY)?.sessionId, "sess-abcdef-1234", "and the rest of the record is untouched");
  // Touching a record that is not there, or cannot be read, is not an error.
  new BankStore(tmp(), () => 0).touch("") ;
  new BankStore(dir, () => 0).touch("a different key entirely, long enough", "2026-11-15T14:00:00.000Z");
  assert.equal(store.connection(KEY)?.lastReadAt, "2026-11-15T13:00:00.000Z", "which also leaves the good record alone");
});

test("disconnecting destroys the local record, provider session id and all", () => {
  const dir = tmp();
  const store = new BankStore(dir);
  assert.equal(store.forget(), false, "nothing to destroy");
  store.save(KEY, connection());
  assert.equal(store.forget(), true);
  assert.equal(fs.existsSync(store.file()), false);
  assert.equal(store.connection(KEY) as unknown, undefined);
  assert.equal(store.state(KEY).kind, "none");
  assert.equal(store.forget(), false);
});
