/**
 * The vault's one-time pages: the add-a-login form, the add-a-card form, and what each says back.
 *
 * These pages are the only place Paul types a password or a card number, so the tests are about what
 * they must not do as much as what they look like: the one-time link is the only way in (missing, wrong
 * and expired links get an apology and no form, and save nothing), the same no-store, no-referrer and
 * CSP headers ride on every response, the markup needs no JavaScript and fetches nothing external (the
 * CSP is `default-src 'none'; style-src 'unsafe-inline'`), and no stored secret is ever rendered: the
 * password, the username and the card number are not on a page, and a confirmation shows only the last
 * four digits. No model runs here; the fake runner fails the test if it is ever called.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-vault-pages-"));
process.env.VAULT_KEY = "test-vault-key-0123456789abcdef";

const { Store } = await import("../src/store.js");
const { buildApp } = await import("../src/index.js");
const { Vault, CardVault, VAULT_ADD_PATH, VAULT_CARD_PATH, VAULT_LINK_MINUTES } = await import("../src/vault.js");
import type { AgentRunner } from "../src/agents.js";
import type { Scheduler } from "../src/scheduler.js";

const PAUL = "tg:99887766";
const PASSWORD = "correct horse battery staple 42!";
const CARD = { number: "4242 4242 4242 4242", expiry: "08/39", cvc: "123", name: "Paul Farrow", postcode: "IP31 3AA" };
const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'";

/** The pages render from the vault alone, so any worker run here is a bug. */
const runner: AgentRunner = async () => {
  throw new Error("the vault pages must not run any worker");
};

const sent: string[] = [];
const messenger = { send: async (_to: string, text: string) => void sent.push(text) } as any;

/** The clock the two vaults are pinned to, so a link can be walked past its fifteen minutes. */
let now = Date.UTC(2026, 10, 13, 12, 0, 0);
const link = (l: string) => new URL(l).searchParams.get("t")!;

let vault: InstanceType<typeof Vault>;
let cards: InstanceType<typeof CardVault>;
let scheduler: Scheduler;
let server: import("node:http").Server;
let base: string;

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-vault-pages-store-"));

before(async () => {
  vault = new Vault(dir(), () => now);
  cards = new CardVault(dir(), () => now);
  const built = buildApp({ messenger, runner, store: new Store(process.env.DATA_DIR!), vault, cardVault: cards });
  scheduler = built.scheduler;
  await new Promise<void>((r) => (server = built.app.listen(0, r)));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => {
  scheduler.stopAll();
  server.close();
});

const get = (p: string) => fetch(`${base}${p}`);
const post = (p: string, body: Record<string, string>) =>
  fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });

/** Every page that carries a secret is never cached, framed, referred or allowed to load anything. */
function secretHeaders(res: Response): void {
  assert.match(res.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(res.headers.get("content-security-policy"), CSP);
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
}

/** Nothing on these pages is fetched: no script, no stylesheet, no font, no image, no CDN. */
function nothingExternal(html: string): void {
  assert.match(html, /name="viewport" content="width=device-width/, "reads on a phone");
  assert.match(html, /<style>/, "one inline stylesheet");
  assert.doesNotMatch(html, /<script/i, "no JavaScript");
  assert.doesNotMatch(html, /\ssrc=/i, "nothing is loaded from anywhere");
  assert.doesNotMatch(html, /<link/i, "no external stylesheet, font or icon");
  assert.doesNotMatch(html, /@import|url\(/i, "no import and no background image");
  assert.doesNotMatch(html, /\son\w+=/i, "no inline handler");
}

test("the login form is reached only with a fresh link, and it fetches nothing and needs no JavaScript", async () => {
  const noToken = await get(VAULT_ADD_PATH);
  assert.equal(noToken.status, 400);
  secretHeaders(noToken);
  const missing = await noToken.text();
  assert.match(missing, /Link expired/);
  assert.doesNotMatch(missing, /<form/i, "no form without a link");

  const wrong = await get(`${VAULT_ADD_PATH}?t=not-the-token`);
  assert.equal(wrong.status, 400);
  const wrongHtml = await wrong.text();
  assert.match(wrongHtml, /Link expired/);
  assert.doesNotMatch(wrongHtml, /not-the-token/, "nothing about the token is echoed back");

  const token = link(vault.addLink(PAUL, "crunchbase.com"));
  const form = await get(`${VAULT_ADD_PATH}?t=${token}`);
  assert.equal(form.status, 200);
  secretHeaders(form);
  const html = await form.text();
  nothingExternal(html);
  assert.match(html, /<h1>Save a login<\/h1>/, "a serif heading naming what the page does");
  assert.match(html, /class="tile"[\s\S]*<svg/, "a rounded icon above it, drawn in the document");
  assert.match(html, /<span class="chip">crunchbase\.com<\/span>/, "the site, in a quiet chip");
  assert.match(html, /max-width:26rem/, "one narrow centred column");
  assert.match(html, /ui-serif/, "the heading is set in a serif");
  assert.match(html, /<form method="post" action="\/vault\/add" autocomplete="off">/, "the token never rides in the form's URL");
  for (const name of ["domain", "username", "password", "totp", "loginUrl"]) assert.match(html, new RegExp(`name="${name}"`), name);
  assert.match(html, /name="domain"[^>]*value="crunchbase\.com"/, "the site the link named is filled in");
  assert.match(html, /type="password"/, "the password field masks what is typed");
  assert.match(html, /class="lock"[\s\S]{0,400}Password/, "with a small padlock beside its label");
  assert.match(html, new RegExp(`expires ${VAULT_LINK_MINUTES} minutes`), "the page says how long the link lasts");
  assert.match(html, /<input type="hidden" name="t" value="/, "the token rides in the form, in a hidden field");
});

test("the card form is reached only with a fresh link, and looks like the same page", async () => {
  assert.equal((await get(VAULT_CARD_PATH)).status, 410);
  assert.equal((await get(`${VAULT_CARD_PATH}?t=not-the-token`)).status, 410);

  const token = link(cards.addLink(PAUL));
  const res = await get(`${VAULT_CARD_PATH}?t=${token}`);
  assert.equal(res.status, 200);
  secretHeaders(res);
  const html = await res.text();
  nothingExternal(html);
  assert.match(html, /<h1>Save a card<\/h1>/);
  assert.match(html, /class="tile"[\s\S]*<svg/);
  assert.match(html, /<form method="post" action="\/vault\/card" autocomplete="off">/);
  for (const name of ["number", "expiry", "cvc", "name", "postcode"]) assert.match(html, new RegExp(`name="${name}"`), name);
  assert.match(html, /name="number"[^>]*inputmode="numeric"/, "a numeric keyboard on a phone");
  assert.match(html, /<button type="submit">Save card<\/button>/, "one full-width button at the bottom");
  assert.match(html, /width:100%[^"]*border-radius:12px/, "generously rounded fields");
});

test("a wrong, used or expired link is refused with an apology, the right headers, and saves nothing", async () => {
  // Wrong token: nothing is written.
  const bad = await post(VAULT_ADD_PATH, { t: "not-the-token", domain: "crunchbase.com", username: "paul@example.com", password: PASSWORD });
  assert.equal(bad.status, 400);
  secretHeaders(bad);
  const badHtml = await bad.text();
  assert.match(badHtml, /Not saved/);
  nothingExternal(badHtml);
  assert.deepEqual(vault.list(), []);

  // A real link, walked past its fifteen minutes: the form is gone and the token saves nothing.
  const expired = link(vault.addLink(PAUL, "crunchbase.com"));
  now += (VAULT_LINK_MINUTES + 1) * 60_000;
  const goneForm = await get(`${VAULT_ADD_PATH}?t=${expired}`);
  assert.equal(goneForm.status, 400);
  secretHeaders(goneForm);
  const goneHtml = await goneForm.text();
  assert.match(goneHtml, /Link expired/);
  assert.doesNotMatch(goneHtml, /<form/i, "an expired link gets no form");
  const gonePost = await post(VAULT_ADD_PATH, { t: expired, domain: "crunchbase.com", username: "paul@example.com", password: PASSWORD });
  assert.equal(gonePost.status, 400);
  assert.deepEqual(vault.list(), [], "an expired link saves nothing");

  const expiredCard = link(cards.addLink(PAUL));
  now += (VAULT_LINK_MINUTES + 1) * 60_000;
  assert.equal((await get(`${VAULT_CARD_PATH}?t=${expiredCard}`)).status, 410);
  const cardPost = await post(VAULT_CARD_PATH, { t: expiredCard, ...CARD });
  assert.equal(cardPost.status, 400);
  assert.equal(cards.summary(), undefined, "an expired link saves no card");
});

test("a login is saved once, from its own token, and the confirmation carries none of it", async () => {
  now = Date.UTC(2026, 10, 13, 12, 0, 0);
  const before = sent.length;
  const token = link(vault.addLink(PAUL, "crunchbase.com"));
  const res = await post(VAULT_ADD_PATH, { t: token, domain: "https://www.crunchbase.com/login", username: "paul@example.com", password: PASSWORD, totp: "GEZD GNBV GY3T QOJQ" });
  assert.equal(res.status, 200);
  secretHeaders(res);
  const html = await res.text();
  nothingExternal(html);
  assert.match(html, /<h1>Login saved<\/h1>/, "the confirmation screen");
  assert.match(html, /class="tile ok"[\s\S]*<svg/, "a tick, not a warning");
  assert.match(html, /<span class="chip">crunchbase\.com<\/span>/);
  assert.match(html, /in the vault/);
  assert.match(html, /You can close this tab\./);
  assert.ok(!html.includes(PASSWORD), "the password is never on the page");
  assert.ok(!html.includes("GEZD"), "nor the two-factor key");
  assert.ok(!html.includes("paul@example.com"), "nor the username");
  assert.ok(!html.includes(token), "nor the token, once it is spent");
  assert.equal(sent.length, before + 1, "and Paul is told in chat");
  assert.match(sent[before], /saved the login for crunchbase\.com/);

  // The token is single use: the form and the post both refuse it now, and nothing else is written.
  assert.equal((await get(`${VAULT_ADD_PATH}?t=${token}`)).status, 400);
  assert.equal((await post(VAULT_ADD_PATH, { t: token, domain: "example.org", username: "x", password: "y" })).status, 400);
  assert.deepEqual(vault.list().map((e) => e.domain), ["crunchbase.com"]);
});

test("a later page never shows a stored secret: no password, no username, no card number", async () => {
  // A fresh link for the same site shows the form, not what is already stored.
  const again = await get(`${VAULT_ADD_PATH}?t=${link(vault.addLink(PAUL, "crunchbase.com"))}`);
  const againHtml = await again.text();
  assert.match(againHtml, /<input[^>]*name="password"(?![^>]*value=)/, "the password field is empty");
  assert.ok(!againHtml.includes(PASSWORD) && !againHtml.includes("GEZD"), "no stored secret on a form");

  const token = link(cards.addLink(PAUL));
  const saved = await post(VAULT_CARD_PATH, { t: token, ...CARD });
  assert.equal(saved.status, 200);
  secretHeaders(saved);
  const savedHtml = await saved.text();
  nothingExternal(savedHtml);
  assert.match(savedHtml, /<h1>Card saved<\/h1>/);
  assert.match(savedHtml, /ending 4242/);
  assert.ok(!savedHtml.includes("4242 4242 4242 4242") && !savedHtml.includes("4242424242424242"), "only the last four digits");
  assert.ok(!savedHtml.includes(CARD.cvc), "never the security code");
  assert.ok(!savedHtml.includes("Paul Farrow"), "never the name on the card");
  assert.equal(cards.summary()?.last4, "4242");

  const nextCardPage = await get(`${VAULT_CARD_PATH}?t=${link(cards.addLink(PAUL))}`);
  const nextHtml = await nextCardPage.text();
  assert.ok(!nextHtml.includes("4242"), "a fresh card page shows nothing that is stored");
});

test("what a page is given is escaped, so nothing typed can become markup", async () => {
  const evil = `crunchbase.com"><script>alert(1)</script>`;
  const res = await post(VAULT_ADD_PATH, { t: "not-the-token", domain: evil, username: "u", password: "p" });
  const html = await res.text();
  assert.doesNotMatch(html, /<script/i);
  assert.ok(!html.includes(evil), "nothing typed is echoed raw");
});
