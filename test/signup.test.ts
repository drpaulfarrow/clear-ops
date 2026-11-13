/**
 * Signing Paul up on a site: the gate, the rules, and what is never done. No network: the submitter and
 * the vault are fakes here, and the browser session is a fake too, so every request is recorded rather
 * than sent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SignupPlan } from "../src/signup.js";

process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-signup-"));
process.env.VAULT_KEY = "test-vault-key-that-is-long-enough";
process.env.SIGNUP_EMAILS = "paul@example.test,other@example.test";
process.env.SIGNUP_SITES = "signupme.test";

const { Store } = await import("../src/store.js");
const { Vault } = await import("../src/vault.js");
const { SitePolicy } = await import("../src/site-policy.js");
const { SignupGate, parseSignupCommand, signupServer } = await import("../src/signup-gate.js");
const { BrowserSignupSubmitter, canonicalPlan, classify, confirmOutcome, digest, generatedPassword, outcomeStep, pageStep, prepareCheck, requireUrl, resolveUsername } = await import("../src/signup.js");
const { Orchestrator } = await import("../src/orchestrator.js");
const { JobRunner } = await import("../src/jobs.js");
const { Scheduler } = await import("../src/scheduler.js");

const PAUL = "tg:99887766";
const ALLOWED = "crunchbase.com"; // on the act-freely list, so agents may act there
const EXTRA = "signupme.test"; // allowed only because SIGNUP_SITES names it

const plan = (extra: Partial<SignupPlan> = {}): SignupPlan => ({ url: `https://${ALLOWED}/signup`, email: "paul@example.test", fields: [{ label: "Full name", value: "Paul Farrow" }], termsUrl: `https://${ALLOWED}/terms`, why: "An account to pull market data", ...extra });

/** A submitter that records what it was asked to do and answers with a page of our choosing. */
function fakeSubmitter(answer: { ok: boolean; step?: "payment" | "phone" | "identity" | "email-verification"; message?: string; usedPassword?: boolean } = {}) {
  const calls: Array<{ plan: SignupPlan; password: string }> = [];
  return {
    calls,
    submit: async (p: SignupPlan, password: string) => {
      calls.push({ plan: p, password });
      return { ok: answer.ok !== false, url: p.url, message: answer.message ?? "Welcome, Paul", ...(answer.step ? { step: answer.step } : {}), usedPassword: answer.usedPassword !== false };
    },
  };
}

function setup(opts: { answer?: Parameters<typeof fakeSubmitter>[0]; ttlMs?: number } = {}) {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-signup-store-")));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-signup-vault-"));
  const logins = new Vault(dir);
  const submitter = fakeSubmitter(opts.answer);
  const sent: Array<{ to: string; text: string }> = [];
  const messenger = { send: async (to: string, text: string) => void sent.push({ to, text }) } as never;
  const policy = new SitePolicy(store, () => []);
  const gate = new SignupGate(store, submitter, logins, policy, messenger, opts.ttlMs ? { ttlMs: opts.ttlMs } : {});
  return { store, logins, submitter, sent, policy, gate, messenger, dir };
}
const origin = { jobId: "j1", replyTo: PAUL };
const log = () => fs.readFileSync(path.join(process.env.DATA_DIR!, "signup", "actions.log"), "utf8");

test("a sign-up is shown to Paul in full and nothing is filled in until his own id arrives", async () => {
  const s = setup();
  const a = await s.gate.prepare(plan(), origin);
  assert.equal(s.submitter.calls.length, 0, "preparing fills nothing in");
  assert.equal(s.sent.length, 1);
  const shown = s.sent[0].text;
  assert.match(shown, new RegExp(`Site: ${ALLOWED}`));
  assert.match(shown, /Email to use: paul@example\.test/);
  assert.match(shown, /Full name: Paul Farrow/);
  assert.match(shown, new RegExp(`Terms: https://${ALLOWED}/terms`));
  assert.match(shown, /never shown to me in chat, in a log or in a job output/);
  assert.match(shown, /Reply "signup apply [a-f0-9]{6}"/);
  assert.equal(s.store.getSignup(a.id)?.status, "pending");
  assert.match(log(), /"event":"prepared"/);

  const out = await s.gate.approve(a.id, PAUL);
  assert.equal(s.submitter.calls.length, 1, "his approval is what submits it");
  assert.match(out, new RegExp(`Account created on ${ALLOWED}`));
  assert.equal(s.store.getSignup(a.id)?.status, "executed");
  assert.equal(s.store.getSignup(a.id)?.approvedBy, PAUL, "the record names the approver");
  const domains = s.logins.domains();
  assert.deepEqual(domains, [ALLOWED], "the login is in the vault");
  assert.match(await s.gate.approve(a.id, PAUL), /already executed/, "approval is single use");
  assert.equal(s.submitter.calls.length, 1);
});

test("the password is generated here and never appears in chat, in the log or in the record", async () => {
  const s = setup();
  const a = await s.gate.prepare(plan(), origin);
  await s.gate.approve(a.id, PAUL);
  const password = s.submitter.calls[0].password;
  assert.ok(password.length >= 16, "a long random password");
  assert.notEqual(password, generatedPassword(), "generated fresh each time");
  for (const m of s.sent) assert.ok(!m.text.includes(password), `chat never carries the password: ${m.text}`);
  assert.ok(!log().includes(password), "the log never carries the password");
  const record = JSON.stringify(s.store.getSignup(a.id));
  assert.ok(!record.includes(password), "the record never carries the password");
  assert.equal(record.includes("password"), false, "the record has no password field at all");
  // And the vault can use it: the entry is stored with that password.
  assert.equal(s.logins.entryFor(ALLOWED)?.password, password);
});

test("the hard blocks: no blocked site, no payment step, no phone step, no duplicate account", async () => {
  const s = setup();
  const refused: Array<[string, SignupPlan]> = [
    ["an email provider", plan({ url: "https://gmail.com/signup" })],
    ["a money site", plan({ url: "https://stripe.com/signup" })],
    ["a site Paul never allowed", plan({ url: "https://stranger.test/signup" })],
    ["an address Paul did not name", plan({ email: "someone@else.test" })],
    ["a card field", plan({ fields: [{ label: "Card number", value: "4111111111111111" }] })],
    ["a billing field", plan({ fields: [{ label: "Billing address", value: "1 High Street" }] })],
    ["a phone field", plan({ fields: [{ label: "Mobile number", value: "+44 7700 900000" }] })],
    ["a date of birth field", plan({ fields: [{ label: "Date of birth", value: "1976-01-31" }] })],
    ["a payment page", plan({ url: `https://${ALLOWED}/checkout` })],
    ["a secret in a field", plan({ fields: [{ label: "Notes", value: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" }] })],
  ];
  for (const [what, p] of refused) {
    await assert.rejects(s.gate.prepare(p, origin), (e: Error) => {
      assert.match(e.message, /Refused, and nothing was prepared/, what);
      return true;
    });
  }
  assert.equal(s.sent.length, 0, "Paul is never shown a refused sign-up");
  assert.equal(s.store.listSignups().length, 0);
  assert.equal(s.submitter.calls.length, 0);
  // A duplicate: a login is already stored for the site.
  const v = setup();
  v.logins.save({ domain: ALLOWED, username: "paul@example.test", password: "stored-already" });
  await assert.rejects(v.gate.prepare(plan(), origin), /already in the vault/);
  assert.equal(v.store.listSignups().length, 0);
});

test("a site Paul allowed through SIGNUP_SITES is fine, and one with no address named at all is refused", async () => {
  const s = setup();
  const a = await s.gate.prepare(plan({ url: `https://${EXTRA}/join` }), origin);
  assert.equal(a.domain, EXTRA);
  // With no address named for sign-ups, nothing can be prepared, whatever the plan says (SIGNUP_EMAILS empty).
  const none = new SignupGate(s.store, s.submitter, s.logins, s.policy, s.messenger, { emails: [] });
  await assert.rejects(none.prepare(plan(), origin), /has not named an address for sign-ups/);
  assert.equal(s.store.listSignups().length, 1, "nothing new was prepared");
});

test("only Paul's own chat account approves or cancels, and approvals expire", async () => {
  const s = setup();
  const a = await s.gate.prepare(plan(), origin);
  await assert.rejects(s.gate.approve(a.id, "tg:12345"), /only Paul's own chat account/);
  assert.equal(s.gate.cancel(a.id, "tg:12345"), "", "a stranger cannot cancel either");
  assert.equal(s.submitter.calls.length, 0);
  assert.match(s.gate.cancel(a.id, PAUL), /Cancelled sign-up/);
  assert.match(await s.gate.approve(a.id, PAUL), /already cancelled/);
  assert.equal(s.submitter.calls.length, 0, "a cancelled sign-up never submits");
  // Expiry
  let now = new Date("2026-11-13T10:00:00Z");
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-signup-exp-")));
  const submitter = fakeSubmitter();
  const e = new SignupGate(store, submitter, s.logins, s.policy, undefined, { now: () => now, ttlMs: 3_600_000 });
  const b = await e.prepare(plan(), origin);
  now = new Date("2026-11-13T11:00:01Z");
  assert.match(await e.approve(b.id, PAUL), /expired/);
  assert.equal(submitter.calls.length, 0);
  assert.equal(store.getSignup(b.id)?.status, "expired");
});

test("the site asking to be paid, or for a phone or an identity, stops there and hands it back to Paul", async () => {
  for (const [step, words] of [
    ["payment", /asked to be paid \(or for card details\)/],
    ["phone", /asked for a phone number/],
    ["identity", /asked for identity or age details/],
  ] as const) {
    const s = setup({ answer: { ok: false, step, message: `Please add a ${step} to continue` } });
    const a = await s.gate.prepare(plan(), origin);
    const out = await s.gate.approve(a.id, PAUL);
    assert.match(out, words, step);
    assert.match(out, new RegExp(`That part is yours`));
    assert.equal(s.store.getSignup(a.id)?.status, "needsPaul");
    assert.equal(s.store.getSignup(a.id)?.step, step);
    assert.deepEqual(s.logins.domains(), [], `nothing is stored when the site wants ${step}`);
    assert.match(log(), /"event":"stopped"/);
  }
});

test("a verification email is reported, and nothing is sent back to it", async () => {
  const s = setup({ answer: { ok: true, step: "email-verification", message: "Check your inbox to confirm your email" } });
  const a = await s.gate.prepare(plan(), origin);
  const out = await s.gate.approve(a.id, PAUL);
  assert.match(out, /wants the email address confirmed/);
  assert.match(out, /Replying to it, forwarding it or sending anything is never done/);
  assert.equal(s.store.getSignup(a.id)?.status, "executed");
  assert.deepEqual(s.logins.domains(), [ALLOWED]);
});

test("a submit that did not work is never reported as an account, and stores nothing", async () => {
  const pageFields = [
    { index: 1, label: "Email address", type: "email", name: "email", required: true },
    { index: 2, label: "Password", type: "password", name: "password", required: true },
  ];
  const session = (text: string, endUrl = `https://${ALLOWED}/welcome`) => ({
    formData: async () => ({ url: `https://${ALLOWED}/signup`, title: "Sign up", text: "Create your account", fields: pageFields, submits: [{ index: 1, label: "Sign up" }] }),
    fillForm: async () => ({ url: endUrl, title: "Done", text }),
    close: async () => undefined,
  });
  const answer = async (text: string) => new BrowserSignupSubmitter(() => session(text) as never).submit(plan(), "generated-password");

  // Every one of these was reported as "Account created" before, and put a wrong password in the vault.
  for (const said of [
    "Please agree to the Terms of Service before continuing. Create your account",
    "Password must be at least 12 characters and contain a number",
    "That email address is already registered. Sign in instead",
    "Something went wrong. Please try again later",
    "Thanks for visiting. Come back later.",
  ]) {
    const out = await answer(said);
    assert.equal(out.ok, false, said);
    assert.equal(out.step, "unclear", said);
  }
  // A page that says nothing at all is not a created account either.
  assert.equal((await answer("")).ok, false);
  // What a page says when it did work still counts, and a verification email is a real outcome.
  assert.equal((await answer("Welcome, Paul")).ok, true);
  assert.equal((await answer("Your account has been created")).ok, true);
  const verify = await answer("Check your inbox to confirm your email");
  assert.equal(verify.ok, true);
  assert.equal(verify.step, "email-verification");
  // A complaint beats a success word: "welcome back" is what a refused sign-up is sent to.
  assert.equal((await answer("Welcome back. That email address is already registered")).ok, false);
  // And the words themselves.
  assert.equal(confirmOutcome({ text: "Success" }, undefined), undefined);
  assert.equal(confirmOutcome({ text: "Please try again" }, undefined), "unclear");
  assert.equal(confirmOutcome({ text: "Welcome! No credit card required" }, undefined), undefined, "a success page is not read as a refusal");
  assert.equal(confirmOutcome({ text: "anything" }, "payment"), "payment", "payment still stops it");
});

test("an unconfirmed submit stores no login, so nothing in the vault pretends the account exists", async () => {
  const s = setup({ answer: { ok: false, step: "unclear", message: "Something went wrong. Please try again later" } });
  const a = await s.gate.prepare(plan(), origin);
  const out = await s.gate.approve(a.id, PAUL);
  assert.match(out, /could not confirm that an account was created/);
  assert.doesNotMatch(out, /Account created/);
  assert.deepEqual(s.logins.domains(), [], "nothing was stored");
  assert.equal(s.store.getSignup(a.id)?.status, "needsPaul");
  assert.equal(s.store.getSignup(a.id)?.stored, undefined);
  assert.match(log(), /"event":"stopped"/);
  // Nothing in the vault, so the same site can be prepared again rather than blocked as a duplicate.
  const again = await s.gate.prepare(plan(), origin);
  assert.equal(s.store.getSignup(again.id)?.status, "pending");
});

test("a required consent box is shown to Paul and ticked only when the plan names it", async () => {
  const terms = "I agree to the Terms of Service and Privacy Policy";
  const fields = [
    { index: 1, label: "Email address", type: "email", name: "email", required: true },
    { index: 2, label: "Password", type: "password", name: "password", required: true },
    { index: 3, label: terms, type: "checkbox", name: "terms", required: true },
  ];
  const page = { url: `https://${ALLOWED}/signup`, title: "Sign up", text: "Create your account", fields, submits: [{ index: 1, label: "Create account" }] };
  const bare = { url: `https://${ALLOWED}/signup`, email: "paul@example.test" };
  // A required consent box the plan does not name is refused: nothing is ticked that Paul did not see.
  assert.throws(() => classify(page, bare, "pw"), /asks Paul to tick "I agree to the Terms of Service and Privacy Policy"/);
  // Named with a plain yes, it is ticked, and it is one of the fields he was shown.
  const withTerms = classify(page, { ...bare, fields: [{ label: terms, value: "yes" }] }, "pw");
  assert.deepEqual(withTerms.fills, [
    { index: 1, value: "paul@example.test" },
    { index: 2, value: "pw" },
    { index: 3, value: "yes" },
  ]);
  // Any other value is refused rather than guessed at.
  assert.throws(() => classify(page, { ...bare, fields: [{ label: terms, value: "no" }] }, "pw"), /only ever ticked when the plan says yes/);
  // And through the gate: the consent box appears in what Paul is shown before he approves.
  const s = setup();
  const a = await s.gate.prepare(plan({ fields: [{ label: terms, value: "yes" }] }), origin);
  assert.match(s.sent[0].text, new RegExp(`${terms}: yes`));
  assert.deepEqual(s.store.getSignup(a.id)?.fields, [{ label: terms, value: "yes" }]);
});

test("the daily cap is checked again when Paul approves, not only when a plan is prepared", async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-signup-cap2-")));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-signup-cap2v-"));
  const submitter = fakeSubmitter();
  const gate = new SignupGate(store, submitter, new Vault(dir), new SitePolicy(store, () => []), undefined, { dailyCap: 1 });
  const first = await gate.prepare(plan(), origin);
  const second = await gate.prepare(plan({ url: `https://${EXTRA}/join` }), origin);
  assert.match(await gate.approve(first.id, PAUL), /Account created/);
  const refused = await gate.approve(second.id, PAUL);
  assert.match(refused, /daily cap/);
  assert.equal(submitter.calls.length, 1, "the second account was never submitted");
  assert.equal(store.getSignup(second.id)?.status, "pending", "it still waits, and can be approved tomorrow");
});

test("the username Paul is shown, the page's username field and the vault all carry one value", async () => {
  const s = setup();
  // The natural reading of the tool: the worker names the username among the fields, not as its own argument.
  const a = await s.gate.prepare(plan({ fields: [{ label: "Username", value: "paulf" }] }), origin);
  assert.equal(a.username, "paulf", "resolved once, from the plan's own field");
  assert.match(s.sent[0].text, /Username: paulf/);
  await s.gate.approve(a.id, PAUL);
  assert.equal(s.submitter.calls[0].plan.username, "paulf", "the page's username field gets that value");
  assert.equal(s.logins.entryFor(ALLOWED)?.username, "paulf", "and the vault stores that same value");
  // The reviewer's own repro: classify must not fall back to the address's local part once prepare has resolved it.
  const fields = [
    { index: 1, label: "Email address", type: "email", name: "email", required: true },
    { index: 2, label: "Username", type: "text", name: "username", required: true },
    { index: 3, label: "Password", type: "password", name: "password", required: true },
  ];
  const page = { url: `https://${ALLOWED}/signup`, title: "Sign up", text: "Create your account", fields, submits: [{ index: 1, label: "Create account" }] };
  const filled = classify(page, { url: `https://${ALLOWED}/signup`, email: "paul@example.test", username: a.username }, "pw");
  assert.deepEqual(filled.fills[1], { index: 2, value: "paulf" });
  // Resolution order: the worker's own argument, then a field it labelled as a username, then the local part.
  assert.equal(resolveUsername({ url: "x", email: "paul@example.test", username: "arg" }, "paul@example.test"), "arg");
  assert.equal(resolveUsername({ url: "x", email: "paul@example.test", fields: [{ label: "Choose a username", value: "chosen" }] }, "paul@example.test"), "chosen");
  assert.equal(resolveUsername({ url: "x", email: "paul@example.test" }, "paul@example.test"), "paul");
  // The hash covers the resolved username, and the plan rebuilds to the same digest at approval time.
  const b = await s.gate.prepare(plan({ url: `https://${EXTRA}/join` }), origin);
  const rebuilt = canonicalPlan({ url: b.url, email: b.email, username: b.username, fields: b.fields, termsUrl: b.termsUrl, why: b.why });
  assert.equal(b.hash, digest({ domain: b.domain, plan: rebuilt }), "the hash covers the plan as it is rebuilt when he approves");
  assert.match(await s.gate.approve(b.id, PAUL), /^Account created/);
});

test("a refused preparation still leaves one audit line, and it never carries a secret", async () => {
  const s = setup();
  await assert.rejects(s.gate.prepare(plan({ url: "https://stripe.com/signup" }), origin));
  await assert.rejects(s.gate.prepare(plan({ fields: [{ label: "Notes", value: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" }] }), origin));
  const written = log();
  assert.match(written, /"event":"refused"/);
  assert.match(written, /stripe\.com is off limits/);
  assert.ok(!written.includes("ghp_abcdefghijklmnopqrstuvwxyz0123456789"), "the secret is not in the log");
  assert.equal(s.sent.length, 0, "and Paul is shown nothing");
});

test("one job never cancels another job's waiting sign-up", async () => {
  const s = setup();
  const mine = await s.gate.prepare(plan(), { jobId: "j1", replyTo: PAUL });
  const theirs = await s.gate.prepare(plan({ url: `https://${EXTRA}/join` }), { jobId: "j2", replyTo: PAUL }, mine.id);
  assert.equal(s.store.getSignup(mine.id)?.status, "pending", "another job's plan is left alone");
  const edit = await s.gate.prepare(plan({ url: `https://${EXTRA}/join2` }), { jobId: "j2", replyTo: PAUL }, theirs.id);
  assert.equal(s.store.getSignup(theirs.id)?.status, "cancelled", "the same job's own edit replaces it");
  assert.equal(s.store.getSignup(edit.id)?.status, "pending");
});

test("the daily cap stops more sign-ups being approved that day", async () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-signup-cap-")));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-signup-capvault-"));
  const sent: string[] = [];
  // SIGNUP_DAILY_CAP set to 1 (the config default is 3): one approved sign-up fills the day.
  const gate = new SignupGate(store, fakeSubmitter(), new Vault(dir), new SitePolicy(store, () => []), { send: async (_to: string, text: string) => void sent.push(text) } as never, { dailyCap: 1 });
  const a = await gate.prepare(plan(), origin);
  await gate.approve(a.id, PAUL);
  await assert.rejects(gate.prepare(plan({ url: `https://${EXTRA}/join` }), origin), /daily cap/);
});

test("the vault being off stops a sign-up rather than losing the password", async () => {
  const key = process.env.VAULT_KEY;
  delete process.env.VAULT_KEY;
  try {
    const s = setup();
    await assert.rejects(s.gate.prepare(plan(), origin), /vault is off/);
    assert.equal(s.submitter.calls.length, 0);
  } finally {
    process.env.VAULT_KEY = key;
  }
});

test("the page's own rules: a card, a phone or an identity field stops it, and so does a consequential button", () => {
  const fields = (...f: Array<[string, string, boolean?]>) => f.map(([label, type, required], i) => ({ index: i + 1, label, type, required: required !== false }));
  const page = (fields2: ReturnType<typeof fields>, submits = [{ index: 1, label: "Create account" }], text = "Sign up to Example") => ({ url: `https://${ALLOWED}/signup`, title: "Sign up", text, fields: fields2, submits });
  assert.equal(pageStep(page(fields(["Email", "email"], ["Password", "password"]))), undefined);
  assert.equal(pageStep(page(fields(["Card number", "text"]))), "payment");
  assert.equal(pageStep(page(fields(["Phone number", "tel"]))), "phone");
  assert.equal(pageStep(page(fields(["Date of birth", "text"]))), "identity");
  assert.equal(pageStep(page(fields(["Email address", "email"]), [{ index: 1, label: "Create account" }], "Verify your identity before you continue")), "identity");
  assert.equal(outcomeStep("Please add a payment method to start your trial"), "payment");
  assert.equal(outcomeStep("We sent a code to your phone"), "phone");
  assert.equal(outcomeStep("Check your inbox to confirm your email"), "email-verification");
  assert.equal(outcomeStep("Welcome to Example"), undefined);
  // Filling in: the email, a username, the password twice, and the planned fields.
  const filled = classify(page(fields(["Email address", "email"], ["Choose a username", "text"], ["Password", "password"], ["Confirm password", "password"], ["Full name", "text"])), { url: `https://${ALLOWED}/signup`, email: "paul@example.test", username: "paulf", fields: [{ label: "Full name", value: "Paul Farrow" }] }, "generated-password");
  assert.deepEqual(filled.fills, [
    { index: 1, value: "paul@example.test" },
    { index: 2, value: "paulf" },
    { index: 3, value: "generated-password" },
    { index: 4, value: "generated-password" },
    { index: 5, value: "Paul Farrow" },
  ]);
  assert.equal(filled.submit, 1);
  // A field the page asks for that is money or a tax detail is refused outright, whether or not the plan named it.
  assert.throws(() => classify(page(fields(["Email address", "email"], ["Company VAT number", "text"])), { url: `https://${ALLOWED}/signup`, email: "paul@example.test" }, "pw"), /"Company VAT number", which is never filled in/);
  // A required field nobody planned for is refused rather than guessed at.
  assert.throws(() => classify(page(fields(["Email address", "email"], ["Referral code", "text"])), { url: `https://${ALLOWED}/signup`, email: "paul@example.test" }, "pw"), /asks for Referral code/);
  // And a button that pays or posts is refused.
  assert.throws(() => classify(page(fields(["Email", "email"]), [{ index: 1, label: "Pay now" }]), { url: `https://${ALLOWED}/signup`, email: "paul@example.test" }, "pw"), /consequential/);
  assert.throws(() => classify(page([], [], "nothing"), { url: `https://${ALLOWED}/signup`, email: "paul@example.test" }, "pw"), /sign-up form/);
});

test("the submitter fills the form itself and stops if the page moves to another site", async () => {
  const pageFields = { index: 1, label: "Email address", type: "email", name: "email", required: true };
  const pwField = { index: 2, label: "Password", type: "password", name: "password", required: true };
  const calls: Array<{ fills: unknown; submit: number }> = [];
  const session = (url: string, endUrl: string, text = "Welcome, Paul") => ({
    formData: async () => ({ url, title: "Sign up", text: "Create your account", fields: [pageFields, pwField], submits: [{ index: 1, label: "Sign up" }] }),
    fillForm: async (fills: unknown, submit: number) => {
      calls.push({ fills, submit });
      return { url: endUrl, title: "Done", text };
    },
    close: async () => undefined,
  });
  const ok = new BrowserSignupSubmitter(() => session(`https://${ALLOWED}/signup`, `https://${ALLOWED}/welcome`) as never);
  const out = await ok.submit(plan(), "generated-password");
  assert.equal(out.ok, true);
  assert.equal(out.usedPassword, true);
  assert.deepEqual(calls[0].fills, [
    { index: 1, value: "paul@example.test" },
    { index: 2, value: "generated-password" },
  ]);
  assert.equal(calls[0].submit, 1);
  // A page that redirects off the site is never filled in.
  const moved = new BrowserSignupSubmitter(() => session(`https://lookalike.test/signup`, `https://lookalike.test/`) as never);
  const stopped = await moved.submit(plan(), "generated-password");
  assert.equal(stopped.ok, false);
  assert.match(stopped.message, /not crunchbase\.com/);
  assert.equal(calls.length, 1, "nothing was filled in on the look-alike");
});

test("'signup apply <id>' only matches a whole message that names the id", () => {
  assert.deepEqual(parseSignupCommand("signup apply abc123"), { verb: "apply", id: "abc123" });
  assert.deepEqual(parseSignupCommand("SIGNUP apply ABC123."), { verb: "apply", id: "abc123" });
  assert.deepEqual(parseSignupCommand("signup cancel abc123"), { verb: "cancel", id: "abc123" });
  for (const t of ["signup apply", "signup apply it", "apply abc123", "send abc123", "yes", "please signup apply abc123", "signup apply abc123 and signup apply def456", "signup apply abc123\nsignup cancel def456", "signup apply abc12"]) {
    assert.equal(parseSignupCommand(t), undefined, t);
  }
});

test("in chat: 'signup apply <id>' from Paul runs with no model call; a stranger or a sentence does nothing", async () => {
  const s = setup();
  const a = await s.gate.prepare(plan(), origin);
  const sent: Array<{ to: string; text: string }> = [];
  const m = { send: async (to: string, text: string) => void sent.push({ to, text }) } as never;
  const runnerCalls: string[] = [];
  const runner = (async (o: { prompt: string }) => (runnerCalls.push(o.prompt), { text: "chief reply", sessionId: "s" })) as never;
  const jobs = new JobRunner(s.store, m, runner);
  const orch = new Orchestrator(s.store, m, jobs, new Scheduler(s.store, jobs), runner, {}, undefined, undefined, undefined, undefined, undefined, undefined, s.gate);
  await orch.handle("tg:12345", `signup apply ${a.id}`, { replyTo: "tg:12345" });
  assert.equal(s.submitter.calls.length, 0, "a stranger cannot approve");
  assert.equal(sent.length, 0, "and is not answered");
  await orch.handle(PAUL, `please signup apply ${a.id}`, { replyTo: PAUL });
  assert.equal(s.submitter.calls.length, 0, "a sentence that merely contains the command does not approve");
  runnerCalls.length = 0;
  await orch.handle(PAUL, `signup apply ${a.id}`, { replyTo: PAUL });
  assert.equal(s.submitter.calls.length, 1);
  assert.equal(runnerCalls.length, 0, "approval never reaches a model");
  assert.match(sent.at(-1)!.text, /Account created on crunchbase\.com/);
  await orch.handle(PAUL, "signup apply ffffff", { replyTo: PAUL });
  assert.match(sent.at(-1)!.text, /No sign-up ffffff/);
  // /pending shows the plan, with the site, the address and the fields.
  const b = await s.gate.prepare(plan({ url: `https://${EXTRA}/join`, fields: [{ label: "Company", value: "Clear Exchange" }] }), origin);
  await orch.handle(PAUL, "/pending", { replyTo: PAUL });
  const shown = sent.at(-1)!.text;
  assert.match(shown, new RegExp(`Site: ${EXTRA}`));
  assert.match(shown, /Company: Clear Exchange/);
  assert.match(shown, new RegExp(`signup cancel ${b.id}`));
});

test("the preparing job gets one tool, and only the browse kinds ever carry the permit", async () => {
  const s = setup();
  const srv: any = signupServer({ gate: s.gate, jobId: "j1", replyTo: PAUL });
  const names = Object.keys(srv.instance?._registeredTools ?? {}).sort();
  assert.deepEqual(names, ["signup_prepare"], "one tool: prepare");
  assert.ok(!names.some((n) => /apply|approve|submit|cancel/.test(n)), "no tool submits or approves");
  const sent: string[] = [];
  const runner = (async () => ({ text: "x", sessionId: "s" })) as never;
  const jobs = new JobRunner(s.store, { send: async (_t: string, t: string) => void sent.push(t) } as never, runner);
  for (const kind of ["research", "ideate", "advisor", "prebid"] as const) {
    assert.deepEqual(jobs.start(kind, "register me on suno.com", PAUL, "product", undefined, { permits: ["signup"] }).permits, ["signup"], kind);
  }
  for (const kind of ["write", "engineer", "maintain", "analyse", "cv", "design"] as const) {
    assert.equal(jobs.start(kind, "register me", PAUL, "product", undefined, { permits: ["signup"] }).permits, undefined, kind);
  }
  for (const kind of ["ea", "dns"] as const) {
    assert.ok(!jobs.start(kind, "register me", PAUL, "product", undefined, { permits: ["signup"] }).permits?.length, kind);
  }
});

test("prepareCheck reports the reason a plan cannot be prepared", () => {
  const check = { existing: [], mayAct: (h: string) => h === ALLOWED };
  assert.deepEqual(prepareCheck(plan(), check).domain, ALLOWED);
  assert.throws(() => prepareCheck(plan({ email: "nobody@example.test" }), check), /not an address Paul named/);
  assert.throws(() => prepareCheck(plan({ url: "http://crunchbase.com/signup" }), check), /must be an https address/);
  assert.throws(() => prepareCheck(plan({ url: "https://lookalike.test/signup" }), check), /not a site Paul has allowed/);
  assert.throws(() => requireUrl("https://lookalike.test/signup", ALLOWED), /is not crunchbase\.com/);
});
