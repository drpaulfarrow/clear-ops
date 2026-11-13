import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-vault-"));
process.env.VAULT_KEY = "test-vault-key-0123456789abcdef";
process.env.ALLOWED_TELEGRAM_IDS = "99887766";

const { Vault, VaultError, totp, hostMatches } = await import("../src/vault.js");
const { SitePolicy, neverReason, normaliseDomain, CONSEQUENTIAL, DEFAULT_ACT_SITES } = await import("../src/site-policy.js");
const { BrowseSession } = await import("../src/browse.js");
const { config } = await import("../src/config.js");

const PASSWORD = "correct horse battery staple 42!";
const PAUL = "tg:99887766";

test("TOTP matches the RFC 6238 test vector", () => {
  // RFC 6238 appendix B, SHA-1 secret "12345678901234567890" in base32, T = 59 s: 94287082, six digits 287082.
  assert.equal(totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59_000), "287082");
  assert.equal(totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 1111111109_000), "081804");
});

test("a login is added only through a fresh one-time link, stored encrypted, and listed without secrets", () => {
  let now = 1_000_000;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
  const v = new Vault(dir, () => now);
  const link = v.addLink("dc:1", "Crunchbase.com");
  const token = new URL(link).searchParams.get("t")!;
  assert.deepEqual(v.peek(token), { domain: "crunchbase.com" });
  const r = v.add(token, { domain: "https://www.crunchbase.com/login", username: "paul@example.com", password: PASSWORD, totp: "GEZD GNBV GY3T QOJQ" });
  assert.equal(r.replyTo, "dc:1");
  assert.equal(r.summary.domain, "crunchbase.com");
  assert.throws(() => v.add(token, { domain: "crunchbase.com", username: "x", password: "y" }), VaultError, "single use");
  const raw = fs.readFileSync(path.join(dir, "logins.enc"), "utf8");
  assert.ok(!raw.includes(PASSWORD) && !raw.includes("paul@example.com"), "nothing readable at rest");
  assert.equal((fs.statSync(path.join(dir, "logins.enc")).mode & 0o777).toString(8), "600");
  const listed = JSON.stringify(v.list());
  assert.ok(!listed.includes(PASSWORD) && !listed.includes("GEZD"), "no password or two-factor key in what chat sees");
  assert.equal(v.entryFor("app.crunchbase.com")?.password, PASSWORD);
  assert.equal(v.entryFor("crunchbase.com.evil.test"), undefined, "a look-alike host gets nothing");
  const expired = new URL(v.addLink("dc:1")).searchParams.get("t")!;
  now += 16 * 60_000;
  assert.throws(() => v.add(expired, { domain: "x.com", username: "a", password: "b" }), /expired/);
  assert.ok(v.remove("crunchbase.com"));
  assert.deepEqual(v.list(), []);
});

test("banks, email, Microsoft, password managers and the workforce's own infrastructure can never be stored or allowed", () => {
  const v = new Vault(fs.mkdtempSync(path.join(os.tmpdir(), "vault-")));
  for (const d of ["paypal.com", "online.barclays.co.uk", "online.my-bank.example", "gmail.com", "accounts.google.com", "login.microsoftonline.com", "1password.com", "github.com", "fly.io", "hmrc.gov.uk"]) {
    assert.ok(neverReason(normaliseDomain(d)), d);
    const t = new URL(v.addLink("dc:1")).searchParams.get("t")!;
    assert.throws(() => v.add(t, { domain: d, username: "u", password: "p" }), /cannot be stored/, d);
  }
  assert.equal(neverReason("crunchbase.com"), undefined);
  assert.equal(neverReason("ons.gov.uk"), undefined, "public government statistics are fine; identity and tax sign-ins are not");
});

test("Paul edits the act-freely list in chat; the never list cannot be reached that way", () => {
  let rules = { added: [] as string[], removed: [] as string[] };
  const store = { siteRules: () => rules, setSiteRules: (r: typeof rules) => void (rules = r) };
  const p = new SitePolicy(store, () => ["crunchbase.com"]);
  assert.ok(p.mayAct("www.iabtechlab.com"), "a default");
  assert.ok(p.mayAct("app.crunchbase.com"), "a vault site");
  assert.ok(!p.mayAct("example.org"));
  assert.match(p.allow("https://www.Example.org/page"), /may now act on example\.org/);
  assert.ok(p.mayAct("shop.example.org"));
  assert.match(p.allow("paypal.com"), /stays read-only: banks/);
  assert.ok(!p.mayAct("paypal.com"));
  assert.match(p.allow("linkedin.com"), /terms forbid automated use/);
  p.disallow("iabtechlab.com");
  assert.ok(!p.mayAct("iabtechlab.com"), "a removed default stays removed");
  assert.ok(DEFAULT_ACT_SITES.every((d) => !neverReason(d)), "no default is on the never list");
});

test("consequential words are caught; ordinary navigation is not", () => {
  for (const w of ["Pay now", "Place order", "Send", "Post", "Delete", "Close account", "Book now", "Confirm payment", "Subscribe"]) assert.ok(CONSEQUENTIAL.test(w), w);
  for (const w of ["Search", "Next", "Sign in", "Log in", "Filter results", "Download report preview"]) assert.ok(!CONSEQUENTIAL.test(w), w);
});

test("hosts match only the domain itself and its subdomains", () => {
  assert.ok(hostMatches("crunchbase.com", "crunchbase.com"));
  assert.ok(hostMatches("www.crunchbase.com", "crunchbase.com"));
  assert.ok(!hostMatches("crunchbase.com.attacker.test", "crunchbase.com"));
  assert.ok(!hostMatches("notcrunchbase.com", "crunchbase.com"));
});

const chrome = (() => {
  for (const c of [process.env.CHROMIUM_PATH, "google-chrome", "chromium"]) {
    if (!c) continue;
    try {
      execFileSync("which", [c], { stdio: "ignore" });
      return c;
    } catch {
      // next
    }
  }
  return undefined;
})();
const noDesigner = (() => {
  if (process.getuid?.() !== 0) return false;
  try {
    execFileSync("id", ["designer"], { stdio: "ignore" });
    return false;
  } catch {
    return true;
  }
})();

test(
  "a real browser signs in from the vault without the model seeing the password, acts only where allowed, and refuses to pay",
  { skip: (!chrome && "no Chromium here") || (noDesigner && "running as root with no designer user") },
  async () => {
    config.design.chromiumPath = chrome!;
    const got: Array<{ path: string; body: string }> = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        res.setHeader("content-type", "text/html");
        if (req.method === "POST") {
          got.push({ path: req.url ?? "", body });
          if (req.url === "/login") {
            res.setHeader("set-cookie", "sid=abc; Path=/");
            return res.end(`<title>Account</title><p>Welcome back</p><form action="/note" method="post"><input name="note" placeholder="Note"><button>Save note</button></form><form action="/pay" method="post"><button>Pay now</button></form>`);
          }
          return res.end("<title>Done</title><p>saved</p>");
        }
        res.end(`<title>Login</title><form action="/login" method="post"><input name="email" type="email" placeholder="Email"><input name="password" type="password" placeholder="Password"><button>Sign in</button></form>`);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port;
    const { startEgressProxy } = await import("../src/design.js");
    const entry = { domain: "127.0.0.1", username: "paul@example.com", password: PASSWORD, addedAt: "2026-11-13" };
    const saved: string[] = [];
    let allowAct = true;
    const session = new BrowseSession({
      proxy: () => startEgressProxy({ allow: `127.0.0.1:${port}` }),
      policy: { mayAct: (h) => allowAct && h === "127.0.0.1" },
      vault: { entryFor: (h) => (h === "127.0.0.1" ? entry : undefined), markUsed: () => undefined, savedCookies: () => [], saveSession: (d) => void saved.push(d) },
      insecureSignInForTests: true,
    });
    try {
      const loginPage = await session.open(`http://127.0.0.1:${port}/`);
      assert.match(loginPage, /field\(password\)/);
      const box = Number(loginPage.match(/\[(\d+)\] field\(password\)/)![1]);
      await assert.rejects(session.type(box, "guess", true), /password fields are off limits/);
      const after = await session.signIn();
      assert.match(after, /Signed in[\s\S]*Welcome back/);
      assert.ok(!after.includes(PASSWORD), "the model never sees the password");
      assert.match(got[0].body, /password=correct\+horse/, "the service filled the real password");
      assert.deepEqual(saved, ["127.0.0.1"], "the session is saved for later jobs");
      // Acting on an allowed site works...
      const note = Number(after.match(/\[(\d+)\] field\(text\): Note/)![1]);
      await session.type(note, "hello", true);
      assert.ok(got.some((g) => g.path === "/note"));
      // ...but paying is refused even there.
      await session.back();
      const page = await session.read();
      const pay = Number(page.match(/\[(\d+)\] button: Pay now/)![1]);
      await assert.rejects(session.click(pay), /consequential action/);
      assert.ok(!got.some((g) => g.path === "/pay"));
      // And with the site read-only, a POST never leaves.
      allowAct = false;
      const again = await session.read();
      const note2 = Number(again.match(/\[(\d+)\] field\(text\): Note/)![1]);
      const before = got.length;
      await session.type(note2, "again", true);
      assert.equal(got.length, before, "read-only site: the POST was refused");
    } finally {
      await session.close();
      server.close();
    }
  },
);

test(
  "a sign-in that asks for a one-time code is finished by the service relay, and the worker never sees the code",
  { skip: (!chrome && "no Chromium here") || (noDesigner && "running as root with no designer user") },
  async () => {
    config.design.chromiumPath = chrome!;
    const got: Array<{ path: string; body: string }> = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        res.setHeader("content-type", "text/html");
        if (req.method === "POST" && req.url === "/login") {
          got.push({ path: req.url, body });
          // The site now wants the code it just sent: no password field on this page.
          return res.end(`<title>Verify</title><p>Enter the verification code we sent you.</p><form action="/verify" method="post"><input name="otp" placeholder="Code"><button>Verify</button></form>`);
        }
        if (req.method === "POST" && req.url === "/verify") {
          got.push({ path: req.url, body });
          res.setHeader("set-cookie", "sid=abc; Path=/");
          // This page echoes the code back at the worker, as some sites do.
          return res.end(`<title>Account</title><p>Welcome back. Your code 112233 was accepted.</p>`);
        }
        res.end(`<title>Login</title><form action="/login" method="post"><input name="email" type="email" placeholder="Email"><input name="password" type="password" placeholder="Password"><button>Sign in</button></form>`);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port;
    const { startEgressProxy } = await import("../src/design.js");
    // No two-factor key in the vault: the relay is what supplies the code.
    const entry = { domain: "127.0.0.1", username: "paul@example.com", password: PASSWORD, addedAt: "2026-11-13" };
    const asks: Array<{ domain: string; emailOffered?: boolean }> = [];
    const saved: string[] = [];
    const session = new BrowseSession({
      proxy: () => startEgressProxy({ allow: `127.0.0.1:${port}` }),
      policy: { mayAct: (h) => h === "127.0.0.1" },
      vault: { entryFor: (h) => (h === "127.0.0.1" ? entry : undefined), markUsed: () => undefined, savedCookies: () => [], saveSession: (d) => void saved.push(d) },
      otp: { code: async (i) => (asks.push({ domain: i.domain, ...(i.emailOffered !== undefined ? { emailOffered: i.emailOffered } : {}) }), "112233") },
      insecureSignInForTests: true,
    });
    try {
      await session.open(`http://127.0.0.1:${port}/`);
      const after = await session.signIn();
      assert.match(after, /Signed in[\s\S]*Welcome back/, "the session is held and finishes the sign-in");
      assert.equal(asks.length, 1, "the relay was asked exactly once");
      assert.equal(asks[0]!.domain, "127.0.0.1");
      assert.match(got.find((g) => g.path === "/verify")!.body, /otp=112233/, "the service typed the relay's code");
      assert.ok(!after.includes("112233"), "the code never reaches the worker's view");
      assert.match(after, /Your code \*{6} was accepted/, "a page that echoes the code back is masked out of what the worker reads");
      assert.deepEqual(saved, ["127.0.0.1"], "the signed-in session is saved for later jobs");
    } finally {
      await session.close();
      server.close();
    }
  },
);

test(
  "a stored two-factor key still signs in from the vault with no relay, unchanged",
  { skip: (!chrome && "no Chromium here") || (noDesigner && "running as root with no designer user") },
  async () => {
    config.design.chromiumPath = chrome!;
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    const got: string[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        res.setHeader("content-type", "text/html");
        if (req.method === "POST" && req.url === "/login") {
          return res.end(`<p>Enter the code we sent.</p><form action="/verify" method="post"><input name="otp" placeholder="Code"><button>Verify</button></form>`);
        }
        if (req.method === "POST" && req.url === "/verify") {
          got.push(body);
          res.setHeader("set-cookie", "sid=abc; Path=/");
          return res.end(`<title>Account</title><p>Welcome back</p>`);
        }
        res.end(`<title>Login</title><form action="/login" method="post"><input name="email" type="email" placeholder="Email"><input name="password" type="password" placeholder="Password"><button>Sign in</button></form>`);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port;
    const { startEgressProxy } = await import("../src/design.js");
    const entry = { domain: "127.0.0.1", username: "paul@example.com", password: PASSWORD, totp: secret, addedAt: "2026-11-13" };
    const session = new BrowseSession({
      proxy: () => startEgressProxy({ allow: `127.0.0.1:${port}` }),
      policy: { mayAct: (h) => h === "127.0.0.1" },
      vault: { entryFor: (h) => (h === "127.0.0.1" ? entry : undefined), markUsed: () => undefined, savedCookies: () => [], saveSession: () => undefined },
      // No relay at all: the vault's own key must be enough, exactly as before.
      insecureSignInForTests: true,
    });
    try {
      await session.open(`http://127.0.0.1:${port}/`);
      const after = await session.signIn();
      assert.match(after, /Signed in[\s\S]*Welcome back/);
      const filled = got.join(" ").match(/(?:^|&)otp=([0-9]{6})(?:&|$)/);
      assert.ok(filled, "the service filled a code into the page");
      // The code comes from the vault key, not from anywhere else. It is checked against the key's own
      // steps around now rather than one instant, because codes rotate every 30 seconds and a browser
      // test on a loaded machine takes longer than that between filling the field and asserting.
      const now = Date.now();
      const fromKey = [-2, -1, 0, 1].some((i) => totp(secret, now + i * 30_000) === filled[1]);
      assert.ok(fromKey, `the code the service filled came from the vault key (got ${filled[1]})`);
    } finally {
      await session.close();
      server.close();
    }
  },
);

test(
  "a code page whose only way on is its own button is finished from the same relay",
  { skip: (!chrome && "no Chromium here") || (noDesigner && "running as root with no designer user") },
  async () => {
    config.design.chromiumPath = chrome!;
    const got: string[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        res.setHeader("content-type", "text/html");
        if (req.method === "POST" && req.url === "/login") {
          // A page that builds its own form in JavaScript: the code field is in no form, so Enter in it
          // does nothing and the page's own "Continue" button is the only way on. The button is not
          // consequential, so the service may press it; a consequential one never would be.
          return res.end(
            `<title>Verify</title><p>Enter the verification code we sent you.</p><input name="otp" placeholder="Code"><button id="go">Continue</button>` +
              `<script>document.getElementById("go").addEventListener("click",function(){var f=document.createElement("form");f.method="post";f.action="/verify";` +
              `var i=document.createElement("input");i.name="otp";i.value=document.querySelector('[name=otp]').value;f.appendChild(i);document.body.appendChild(f);f.submit();});</script>`,
          );
        }
        if (req.method === "POST" && req.url === "/verify") {
          got.push(body);
          res.setHeader("set-cookie", "sid=abc; Path=/");
          return res.end(`<title>Account</title><p>Welcome back</p>`);
        }
        res.end(`<title>Login</title><form action="/login" method="post"><input name="email" type="email" placeholder="Email"><input name="password" type="password" placeholder="Password"><button>Sign in</button></form>`);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port;
    const { startEgressProxy } = await import("../src/design.js");
    const entry = { domain: "127.0.0.1", username: "paul@example.com", password: PASSWORD, addedAt: "2026-11-13" };
    const asks: number[] = [];
    const session = new BrowseSession({
      proxy: () => startEgressProxy({ allow: `127.0.0.1:${port}` }),
      policy: { mayAct: (h) => h === "127.0.0.1" },
      vault: { entryFor: (h) => (h === "127.0.0.1" ? entry : undefined), markUsed: () => undefined, savedCookies: () => [], saveSession: () => undefined },
      otp: { code: async () => (asks.push(Date.now()), "445566") },
      insecureSignInForTests: true,
    });
    try {
      await session.open(`http://127.0.0.1:${port}/`);
      const after = await session.signIn();
      assert.match(after, /Signed in[\s\S]*Welcome back/, "the page's own button carried the sign-in on");
      assert.equal(asks.length, 1, "one code was asked for, not a second one after the click");
      assert.match(got.join(" "), /otp=445566/, "the button posted the relay's code");
      assert.ok(!after.includes("445566"), "the code never reaches the worker's view");
    } finally {
      await session.close();
      server.close();
    }
  },
);

test(
  "a purchase job whose sign-in needs a code waits for the relay, then carries on to the checkout review",
  { skip: (!chrome && "no Chromium here") || (noDesigner && "running as root with no designer user") },
  async () => {
    config.design.chromiumPath = chrome!;
    const { Store } = await import("../src/store.js");
    const { PurchaseGate } = await import("../src/purchase.js");
    const { OtpRelay } = await import("../src/otp.js");
    const posted: string[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        res.setHeader("content-type", "text/html");
        if (req.method === "POST" && req.url === "/login") {
          return res.end(`<title>Verify</title><p>Enter the verification code we sent you. This code expires in 5 minutes.</p><form action="/verify" method="post"><input name="otp" placeholder="Code"><button>Verify</button></form>`);
        }
        if (req.method === "POST" && req.url === "/verify") {
          res.setHeader("set-cookie", "sid=abc; Path=/");
          return res.end(`<title>Account</title><p>Welcome back</p><a href="/basket">Basket</a>`);
        }
        if (req.method === "POST" && req.url === "/order") {
          posted.push("/order");
          return res.end(`<title>Thank you</title><p>Order placed, thanks. Order Total: £23.98</p>`);
        }
        if (req.url === "/basket") {
          return res.end(`<title>Basket</title><p>Nespresso compatible pods x 2\nOrder Total: £23.98</p><form action="/order" method="post"><button>Place your order</button></form>`);
        }
        res.end(`<title>Login</title><form action="/login" method="post"><input name="email" type="email" placeholder="Email"><input name="password" type="password" placeholder="Password"><button>Sign in</button></form>`);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port;
    const base = `http://127.0.0.1:${port}`;
    const { startEgressProxy } = await import("../src/design.js");
    // The service's own relay, exactly as a purchase job gets it: the code he is sent in chat is the code
    // the browser types, and the worker and its job output never see it.
    const asks: string[] = [];
    const relay = new OtpRelay({ messenger: { send: async (_to: string, t: string) => void asks.push(t) }, ttlMs: 5_000, minGapMs: 0 });
    const entry = { domain: "127.0.0.1", username: "paul@example.com", password: PASSWORD, addedAt: "2026-11-13" };
    const session = new BrowseSession({
      proxy: () => startEgressProxy({ allow: `127.0.0.1:${port}` }),
      policy: { mayAct: (h) => h === "127.0.0.1" },
      vault: { entryFor: (h) => (h === "127.0.0.1" ? entry : undefined), markUsed: () => undefined, savedCookies: () => [], saveSession: () => undefined },
      otp: relay.forJob({ id: "job1", replyTo: PAUL }),
      insecureSignInForTests: true,
    });
    const waitFor = async (what: () => string | undefined) => {
      for (let i = 0; i < 400 && !what(); i++) await new Promise((r) => setTimeout(r, 5));
      return what();
    };
    try {
      await session.open(`${base}/`);
      // The sign-in holds the page and waits for the relay rather than dead-ending on the code step.
      const signingIn = session.signIn();
      const ask = await waitFor(() => asks[0]);
      assert.match(ask ?? "", /^127 asked for a code to sign in\. Reply: code [a-f0-9]{6}\b/, "the ask names the site, the id and nothing else");
      assert.match(ask ?? "", /Type the code where it says <the code>\. It goes straight into the page/, "and tells him where the code goes");
      const codeId = ask!.match(/code ([a-f0-9]{6})/)![1];
      assert.ok(relay.pending().length === 1, "the sign-in is waiting for the code");
      assert.equal(relay.redeem({ id: codeId, code: "112233", by: PAUL }).accepted, true);
      const signed = await signingIn;
      assert.match(signed, /Welcome back/, "the sign-in carries on once the code is in");
      assert.ok(!signed.includes("112233") && !asks.join(" ").includes("112233"), "the code is nowhere the worker or chat can see");
      // On to the basket and the checkout review, as the job would: the relay-mediated sign-in leads
      // straight into the purchase path, which is otherwise unchanged. This checkout is the test's own
      // plain-http loopback page and the gate's own rule is that a checkout must be https, so the gate
      // stops there and presses nothing (the approve-and-press path is covered by test/purchase.test.ts).
      const basket = await session.open(`${base}/basket`);
      const place = Number(basket.match(/\[(\d+)\] button: Place your order/)![1]);
      const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-otp-buy-")));
      const gate = new PurchaseGate(store, { summary: () => undefined, forApprovedPurchase: () => undefined }, { send: async () => undefined }, { ttlMs: 3_000 });
      await assert.rejects(() => gate.prepareAndWait(session, place, { jobId: "job1", replyTo: PAUL }), /not on an https page/, "the gate still applies its own rule to the checkout the job reached");
      assert.deepEqual(posted, [], "nothing is pressed before Paul decides the order");
    } finally {
      await session.close();
      server.close();
    }
  },
);
