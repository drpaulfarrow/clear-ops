/**
 * The owner's bank page, rendered offline for docs/bank-page/.
 *
 * This runs the real thing: a real Express app from `buildApp`, the real bank router, gate and page
 * (src/bank-router.ts, src/bank-gate.ts, src/bank-page.ts), a real owner sign-in, the real forms, and
 * the real CSRF tokens. Only the provider is faked, so that nothing leaves this machine:
 *
 *  - no bank is contacted, no provider credential is used and no real bank data exists anywhere here:
 *    the accounts, balances and transactions below are made up for the picture;
 *  - the provider's own authorisation page is intercepted by the browser and replaced with a stub, and
 *    the one-time code handed to the callback is a string written in this file;
 *  - the connection record is sealed into a temporary DATA_DIR that is deleted at the end.
 *
 * Every image is therefore what the page really renders, with synthetic data.
 *
 *   npm run bank-preview
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-bank-preview-"));
process.env.PUBLIC_URL = "https://workforce.example";
process.env.ALLOWED_TELEGRAM_IDS = "1000001";
process.env.BANK_ENABLED = "true";

const { Store } = await import("../src/store.js");
const { buildApp } = await import("../src/index.js");
const { SignIn, SIGN_IN_PATH } = await import("../src/sign-in.js");
const { BankStore, bankSettings, BANK_PATH, BANK_CALLBACK_PATH } = await import("../src/bank.js");
const { BankApiError } = await import("../src/bank-api.js");
const { chromium } = await import("playwright-core");
import type { AgentRunner } from "../src/agents.js";

/* ---------- What is in the picture ---------- */

const PASSWORD = "a preview password, not a real one";
const CONNECTION_KEY = "a preview connection key, not a real one";
const APPLICATION_ID = "00000000-0000-0000-0000-000000000000";
const SYNTHETIC_CODE = "synthetic-one-time-code";
const OUT = path.resolve("docs/bank-page");

/** The accounts the fake provider's session can see. Nothing here is a real account. */
const CURRENT = { uid: "acc-current", name: "Everyday Current Account", iban: "GB00XXXX00000000123456" };
const SAVER = { uid: "acc-saver", name: "Online Bonus Saver", iban: "GB00XXXX00000000654321" };
const ISA = { uid: "acc-isa", name: "Cash ISA", iban: "GB00XXXX00000000999999" };

const BALANCES = [
  { type: "interimBooked", name: "Booked", amount: "2431.19", currency: "GBP" },
  { type: "interimAvailable", name: "Available", amount: "2401.19", currency: "GBP" },
];

const TRANSACTIONS = [
  { bookingDate: "2026-11-14", description: "TESCO STORES 3294", amount: "-38.42", currency: "GBP" },
  { bookingDate: "2026-11-13", description: "TFL TRAVEL CH", amount: "-2.80", currency: "GBP" },
  { bookingDate: "2026-11-13", description: "COSTA COFFEE 1027", amount: "-3.65", currency: "GBP" },
  { bookingDate: "2026-11-12", description: "BRITISH GAS ENERGY", amount: "-88.00", currency: "GBP" },
  { bookingDate: "2026-11-11", description: "AMAZON UK MARKETPLACE", amount: "-16.99", currency: "GBP" },
  { bookingDate: "2026-11-10", description: "SAINSBURYS S/MKT", amount: "-52.10", currency: "GBP" },
  { bookingDate: "2026-11-09", description: "NETFLIX.COM", amount: "-10.99", currency: "GBP" },
  { bookingDate: "2026-11-07", description: "VODAFONE LTD", amount: "-24.00", currency: "GBP" },
  { bookingDate: "2026-11-05", description: "SHELL FILLING STATION", amount: "-61.35", currency: "GBP" },
  { bookingDate: "2026-11-03", description: "PHARMACY 1182", amount: "-9.15", currency: "GBP" },
  { bookingDate: "2026-10-31", description: "SALARY EXAMPLE EMPLOYER LTD", amount: "3120.44", currency: "GBP" },
  { bookingDate: "2026-10-29", description: "COUNCIL TAX DIRECT DEBIT", amount: "-168.00", currency: "GBP" },
];

/* ---------- The faked provider ---------- */

/** Every call the page makes, recorded so the run can print what actually happened. */
const calls: string[] = [];

function fakeApi(over: { balancesFails?: boolean; truncates?: boolean } = {}) {
  return {
    async listAspsps() {
      calls.push("list-aspsps");
      return [
        { name: "Barclays", country: "GB", psuTypes: ["personal"] },
        { name: "HSBC UK Business", country: "GB", psuTypes: ["business"] },
        { name: "HSBC UK", country: "GB", psuTypes: ["personal", "business"] },
      ];
    },
    async startAuthorisation(o: { state: string; redirectUrl: string; validUntil: string }) {
      calls.push(`start-authorisation (valid until ${o.validUntil})`);
      return `https://api.enablebanking.com/auth?state=${encodeURIComponent(o.state)}&redirect_uri=${encodeURIComponent(o.redirectUrl)}`;
    },
    async createSession(code: string) {
      calls.push(`create-session (code of ${code.length} characters)`);
      return { sessionId: "synthetic-session", accounts: [CURRENT, SAVER, ISA], aspsp: { name: "HSBC UK", country: "GB" }, scope: ["read"], accessValidUntil: "2027-02-13T00:00:00Z" };
    },
    async readSession() {
      calls.push("read-session");
      return { sessionId: "synthetic-session", accounts: [CURRENT, SAVER, ISA], aspsp: { name: "HSBC UK", country: "GB" }, scope: ["read"] };
    },
    async deleteSession() {
      calls.push("delete-session");
    },
    async balances() {
      calls.push("account-balances");
      if (over.balancesFails) throw new BankApiError("rate-limit", "The provider is rate limiting this service and asked for about 30 seconds. Nothing was read; try again after that.", 429, 30_000);
      return BALANCES;
    },
    async transactions(_uid: string, q: { from: string; to: string; continuationKey?: string }) {
      calls.push(`account-transactions ${q.from}..${q.to}${q.continuationKey ? " (next page)" : ""}`);
      if (over.truncates) return { lines: [{ bookingDate: "2026-11-14", description: "TFL TRAVEL CH", amount: "-2.80", currency: "GBP" }], continuationKey: "another-page" };
      return { lines: TRANSACTIONS };
    },
  };
}

/* ---------- One app, one owner, one browser ---------- */

const runner: AgentRunner = async () => {
  throw new Error("the bank page runs no worker, and this preview must not either");
};

/** A fresh app with its own temporary data directory, a fake provider and a signed-in owner. */
async function scenario(over: { enabled?: boolean; bank?: { balancesFails?: boolean; truncates?: boolean } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-bank-preview-"));
  const store = new Store(dir);
  const signIn = new SignIn(() => Date.now(), async () => {});
  signIn.setPassword(store, PASSWORD);
  const bankStore = new BankStore(path.join(dir, "bank"));
  const api = fakeApi(over.bank);
  const settings = bankSettings({
    BANK_ENABLED: over.enabled === false ? "" : "true",
    BANK_APPLICATION_ID: APPLICATION_ID,
    // A placeholder, so no real key is anywhere near this: the fake provider never checks a signature.
    BANK_JWT_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nnot a real key, never used\n-----END PRIVATE KEY-----",
    BANK_CONNECTION_KEY: CONNECTION_KEY,
  });
  const built = buildApp({
    messenger: { send: async () => {} } as never,
    runner,
    store,
    signIn,
    bank: { settings, api: api as never, store: bankStore },
  });
  const server = await new Promise<import("node:http").Server>((r) => {
    const s = built.app.listen(0, "127.0.0.1", () => r(s));
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  // The provider sends the browser back to the registered address; a loopback address is accepted only
  // here and in the tests (`allowLoopback` is a constructor option, never an environment variable).
  settings.allowLoopback = true;
  settings.redirectUrl = `${base}${BANK_CALLBACK_PATH}`;
  return {
    dir,
    base,
    settings,
    bankStore,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** The bank's own page, stubbed: the browser is sent there, and this is what it finds. */
const bankStub = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HSBC UK (simulated)</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:0 auto;padding:2rem 1.25rem;color:#1b1b1b}h1{font-size:1.3rem}button{font:inherit;padding:.8rem 1rem;margin-top:1rem;width:100%;border:0;border-radius:10px;background:#0b0b0b;color:#fff}p{color:#555}</style></head>
<body><h1>HSBC UK</h1><p>This is not HSBC's page. It is a stub standing in for it in the local preview: in the real flow the browser would be on your bank's own site, authorising a read-only consent, and this service would never see your banking password or a one-time code.</p><p>The browser is then sent back to the connector's registered callback with a one-time code, which the preview supplies itself.</p></body></html>`;

/** Chromium's own binary: playwright-core needs an absolute path, so the usual ones are tried. */
function chromiumBinary(): string {
  const candidates = [process.env.CHROMIUM_PATH, "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].filter((p): p is string => Boolean(p));
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error(`No Chromium found. Set CHROMIUM_PATH (tried ${candidates.join(", ")}).`);
  return found;
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: chromiumBinary(), args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const shot = async (page: import("playwright-core").Page, name: string): Promise<void> => {
    for (const [label, width, height, scale] of [["phone", 390, 900, 2], ["desktop", 1280, 1000, 1]] as const) {
      await page.setViewportSize({ width, height });
      await page.screenshot({ path: path.join(OUT, `${name}-${label}.png`), fullPage: true });
      console.log(`  ${name}-${label}.png`);
    }
  };
  const signIn = async (page: import("playwright-core").Page, base: string): Promise<void> => {
    await page.goto(`${base}${SIGN_IN_PATH}?next=${encodeURIComponent(BANK_PATH)}`);
    await page.fill("input[name=password]", PASSWORD);
    await page.click("button[type=submit]");
    await page.waitForURL(`${base}${BANK_PATH}`);
  };

  /* ---------- The whole flow, from the front door to a disconnected connection ---------- */

  const flow = async (s: Awaited<ReturnType<typeof scenario>>, names: { balances?: string; transactions?: string } = {}): Promise<void> => {
    const page = await browser.newPage();
    // The bank's own page is never fetched: the browser is served a stub, and the state is read off the
    // address it was sent to (which is what the real bank would send back with its one-time code).
    let state = "";
    await page.route(/^https:\/\/api\.enablebanking\.com\//, async (route) => {
      state = new URL(route.request().url()).searchParams.get("state") ?? "";
      await route.fulfill({ status: 200, contentType: "text/html", body: bankStub });
    });
    await signIn(page, s.base);

    await page.goto(`${s.base}${BANK_PATH}`);
    await shot(page, "02-not-connected");

    await page.getByRole("button", { name: "Connect to HSBC UK" }).click();
    await page.waitForURL(`${s.base}${BANK_PATH}/connect`);
    await shot(page, "03-confirm");

    // The bank's page is reached by following the link on the page, never by a redirect: the page's
    // `form-action 'self'` is applied by browsers to a form submission's redirects too.
    await page.getByRole("button", { name: "Go to HSBC to authorise" }).click();
    await page.waitForURL(`${s.base}${BANK_PATH}/connect/start`);
    await shot(page, "04-go-to-your-bank");
    await page.getByRole("link", { name: /^Continue to / }).click();
    await page.waitForURL(/^https:\/\/api\.enablebanking\.com\//);

    // The bank's redirect back, with the one-time code the preview invents.
    await page.goto(`${s.base}${BANK_CALLBACK_PATH}?state=${encodeURIComponent(state)}&code=${SYNTHETIC_CODE}`);
    await shot(page, "05-back-from-the-bank");

    // The same attempt, seen from the signed-in page: one press finishes it.
    await page.goto(`${s.base}${BANK_PATH}`);
    await shot(page, "06-finish-connecting");

    await page.getByRole("button", { name: "Finish connecting" }).click();
    await page.waitForURL(`${s.base}${BANK_PATH}/connect/complete`);
    await shot(page, "07-connected-nothing-chosen");

    // Only one of the three accounts is chosen, and only that one is ever readable.
    await page.check("#c-0");
    await page.getByRole("button", { name: "Save these accounts" }).click();
    await page.waitForURL(`${s.base}${BANK_PATH}/accounts`);
    await shot(page, "08-one-account-chosen");

    await page.getByRole("button", { name: "Show balances" }).click();
    await page.waitForURL(`${s.base}${BANK_PATH}/balances`);
    await shot(page, names.balances ?? "09-balances");

    await page.getByRole("button", { name: "Show transactions" }).click();
    await page.waitForURL(`${s.base}${BANK_PATH}/transactions`);
    await shot(page, names.transactions ?? "10-transactions");

    // The disconnect report, which is three separate statements and never one.
    await page.locator("summary", { hasText: "Refresh the account list, or disconnect" }).click();
    await page.getByRole("button", { name: "Disconnect" }).click();
    await page.waitForURL(`${s.base}${BANK_PATH}/disconnect`);
    await shot(page, "13-disconnected");
    await page.close();
  };

  /* ---------- 1. Switched off ---------- */
  console.log("off:");
  {
    const s = await scenario({ enabled: false });
    const page = await browser.newPage();
    await signIn(page, s.base);
    await shot(page, "01-switched-off");
    await page.close();
    await s.close();
  }

  /* ---------- 2. A stored record that cannot be read ---------- */
  console.log("unreadable:");
  {
    const s = await scenario();
    // A record sealed under a different key: the connector says so plainly and reads nothing.
    const other = new BankStore(path.join(s.dir, "bank"));
    other.save("a different connection key, long enough", {
      sessionId: "synthetic-session",
      aspsp: { name: "HSBC UK", country: "GB" },
      scope: ["read"],
      accounts: [],
      connectedAt: new Date().toISOString(),
    } as never);
    const page = await browser.newPage();
    await signIn(page, s.base);
    await shot(page, "14-record-unreadable");
    await page.close();
    await s.close();
  }

  /* ---------- 3. The whole flow ---------- */
  console.log("the flow:");
  {
    const s = await scenario();
    await flow(s);
    await s.close();
  }

  /* ---------- 4. The provider's own failures, and the paging bound ---------- */
  console.log("truncated read:");
  {
    const s = await scenario({ bank: { truncates: true } });
    await flow(s, { transactions: "11-read-stopped-at-the-bound" });
    await s.close();
  }
  console.log("provider failure:");
  {
    const s = await scenario({ bank: { balancesFails: true } });
    await flow(s, { balances: "12-provider-failure" });
    await s.close();
  }

  await browser.close();
  console.log(`\nwritten to ${OUT}`);
  console.log(`the provider was called: ${calls.length} times, and every one of them was faked`);
}

await main();
