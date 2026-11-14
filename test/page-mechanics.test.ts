/**
 * The ordinary mechanics of a page: a two-step verification screen, a cookie wall, a region chooser, an
 * offer that covers the page. What the service presses, and (in a real browser) that a browsing agent
 * drives the phone-text route itself instead of stopping and handing the page back to Paul.
 *
 * The fixture page is shaped like Amazon UK's Two-Step Verification page, the one that stopped jobs
 * e56976 and 059bad on 14 November 2026: "Two-Step Verification / Choose where to receive or generate
 * the code", with the authenticator, text, WhatsApp and call routes, a "Didn't receive a code?" link and
 * a "Send OTP" button.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-mechanics-"));
process.env.VAULT_KEY = "test-vault-key-0123456789abcdef";

const { asksForVerification, interruptionStep, routeRank, verificationStep, PAGE_MECHANICS_NOTE } = await import("../src/page-mechanics.js");
const { BrowseSession } = await import("../src/browse.js");
const { config } = await import("../src/config.js");

/** The routes Amazon UK's page offers, exactly as it words them. */
const ROUTES = [
  { value: "totp", label: "Enter OTP from Authenticator App" },
  { value: "text", label: "Text me on my number ending in 802" },
  { value: "whatsapp", label: "WhatsApp me at my number ending in 802" },
  { value: "call", label: "Call me on my number ending in 802" },
];
const CHOOSER_TEXT = "Two-Step Verification\nChoose where to receive or generate the code.";

/** The same page as the browser reads it: a radio per route, its label, the resend link, the send button. */
const chooserControls = (checked?: string) => [
  ...ROUTES.flatMap((r, i) => [
    { ref: i * 2 + 1, tag: "input", words: r.value, checked: checked === r.value },
    { ref: i * 2 + 2, tag: "label", words: r.label, checked: false },
  ]),
  { ref: 9, tag: "a", words: "Didn't receive a code?", checked: false },
  { ref: 10, tag: "button", words: "Send OTP", checked: false },
];

const pick = (items: ReturnType<typeof chooserControls>, text: string, opts: { totp?: boolean; done?: string[] } = {}) => verificationStep(items, text, opts);

/* ---------- the verification screen ---------- */

test("a two-step verification screen is walked the way a person walks it: resend, then the phone-text route, then send", () => {
  const items = chooserControls();
  const first = pick(items, CHOOSER_TEXT);
  assert.equal(first?.words, "Didn't receive a code?", "the site's own path is taken first");
  const done = [first!.words];
  const second = pick(items, CHOOSER_TEXT, { done });
  assert.equal(routeRank(second!.words), 3, "then the route that reaches Paul on his phone, chosen not asked about");
  done.push(second!.words);
  const third = pick(items, CHOOSER_TEXT, { done });
  assert.equal(third?.words, "Send OTP", "and then the button that sends the code");
  done.push(third!.words);
  assert.equal(pick(items, CHOOSER_TEXT, { done }), undefined, "and then there is nothing left to press");
});

test("the route chosen is the one that reaches Paul, and never the authenticator app unless we hold the key", () => {
  assert.equal(routeRank("Text me on my number ending in 802"), 3);
  assert.equal(routeRank("WhatsApp me at my number ending in 802"), 2);
  assert.equal(routeRank("Call me on my number ending in 802"), 1);
  assert.equal(routeRank("Enter OTP from Authenticator App"), 0, "we cannot make a code we hold no key for");
  assert.equal(routeRank("Enter OTP from Authenticator App", true), 4, "with the vault's own key it is the surest route");
  assert.equal(routeRank("Send OTP"), 0, "the send button is not a route");
  // Text beats WhatsApp beats a call, whichever order the page lists them in.
  const only = (labels: string[]) => labels.map((l, i) => ({ ref: i + 1, tag: "label", words: l, checked: false }));
  const routes = only(["Call me on my number ending in 802", "WhatsApp me at my number ending in 802", "Text me on my number ending in 802"]);
  const asked = { done: ["Didn't receive a code?"] };
  assert.equal(verificationStep(routes, CHOOSER_TEXT, asked)?.words, "Text me on my number ending in 802");
  assert.equal(verificationStep(routes.filter((r) => !/text/i.test(r.words)), CHOOSER_TEXT, asked)?.words, "WhatsApp me at my number ending in 802");
  assert.equal(verificationStep(only(["Call me on my number ending in 802"]), CHOOSER_TEXT, asked)?.words, "Call me on my number ending in 802");
  // With the vault's key held, the authenticator route is taken and the code is the service's own.
  const all = only([...ROUTES.map((r) => r.label)]);
  assert.equal(verificationStep(all, CHOOSER_TEXT, { ...asked, totp: true })?.words, "Enter OTP from Authenticator App");
  assert.equal(verificationStep(all, CHOOSER_TEXT, asked)?.words, "Text me on my number ending in 802", "without it, the route that reaches his phone");
});

test("a chosen route is left alone, so the page is never pressed in a circle", () => {
  const items = chooserControls("text");
  assert.equal(verificationStep(items, CHOOSER_TEXT, { done: ["Didn't receive a code?"] })?.words, "Send OTP", "a checked route is not changed");
});

test("nothing is pressed on an ordinary page, and nothing consequential is ever pressed", () => {
  // A shop's discount-code box and a "Send" button are not a verification screen.
  const shop = [
    { ref: 1, tag: "button", words: "Send message" },
    { ref: 2, tag: "button", words: "Send OTP" },
  ];
  assert.equal(verificationStep(shop, "Your basket"), undefined);
  assert.equal(verificationStep(shop, "Apply a discount code at checkout"), undefined, "the word code alone does not make a page a verification screen");
  // On a real verification screen, paying, sending content, deleting and changing an account are still refused.
  const bad = [
    { ref: 1, tag: "button", words: "Send OTP" },
    { ref: 2, tag: "button", words: "Email me a code" },
    { ref: 3, tag: "button", words: "Delete my account" },
    { ref: 4, tag: "button", words: "Pay now" },
  ];
  const step = verificationStep(bad, CHOOSER_TEXT);
  assert.equal(step?.words, "Send OTP", "the one safe control is pressed, and none of the others");
  assert.equal(verificationStep(bad.filter((b) => b.words !== "Send OTP"), CHOOSER_TEXT), undefined, "with that gone, nothing else is");
});

test("the verification wording is read off the page, and a settings page is not a verification screen", () => {
  assert.ok(asksForVerification(CHOOSER_TEXT));
  assert.ok(asksForVerification("Enter the verification code we sent you."));
  assert.ok(asksForVerification("Verify it's you"));
  assert.ok(!asksForVerification("Your basket is empty"));
  assert.ok(!asksForVerification("Two-step verification is on for your account"), "a settings page says the words but asks nothing");
});

/* ---------- the interruptions a page puts in front of a visitor ---------- */

test("a cookie wall is cleared with a plain accept, never by refusing or by opening the settings", () => {
  const items = [
    { ref: 1, tag: "button", words: "Reject all" },
    { ref: 2, tag: "button", words: "Manage preferences" },
    { ref: 3, tag: "button", words: "Accept all cookies" },
  ];
  const step = interruptionStep(items, "We use cookies to improve your experience.");
  assert.equal(step?.words, "Accept all cookies");
  assert.equal(interruptionStep([{ ref: 1, tag: "button", words: "Accept" }], "We use cookies on this site.")?.words, "Accept", "a bare accept is taken on a page that is talking about cookies");
  assert.equal(interruptionStep([{ ref: 1, tag: "button", words: "Accept" }], "Sign up to our newsletter")?.words, undefined, "and not otherwise");
  assert.equal(interruptionStep(items, "Your basket is empty"), undefined, "no cookie notice, nothing pressed");
});

test("a region chooser is answered for Paul, and an offer is dismissed the way a person dismisses one", () => {
  const regions = [
    { ref: 1, tag: "a", words: "United States" },
    { ref: 2, tag: "a", words: "United Kingdom" },
  ];
  assert.equal(interruptionStep(regions, "Choose your country or region")?.words, "United Kingdom");
  assert.equal(interruptionStep(regions, "Welcome back")?.words, undefined, "no chooser, nothing pressed");
  assert.equal(interruptionStep([{ ref: 1, tag: "button", words: "No thanks" }, { ref: 2, tag: "button", words: "Subscribe" }], "Get 20% off your first order")?.words, "No thanks");
  assert.equal(interruptionStep([{ ref: 1, tag: "button", words: "Subscribe" }], "Get 20% off")?.words, undefined, "a consequential control is never pressed");
});

test("every browsing job is told to work the site's own mechanics and never to ask Paul to", () => {
  assert.match(PAGE_MECHANICS_NOTE, /work the ordinary steps of a site yourself/);
  assert.match(PAGE_MECHANICS_NOTE, /never for something you could have done yourself/);
  assert.match(PAGE_MECHANICS_NOTE, /didn't receive a code/);
});

/* ---------- the same page in a real browser ---------- */

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

const PASSWORD = "correct horse battery staple 42!";

test(
  "an agent on Amazon's Two-Step Verification page drives the phone-text route itself instead of stopping",
  { skip: (!chrome && "no Chromium here") || (noDesigner && "running as root with no designer user") },
  async () => {
    config.design.chromiumPath = chrome!;
    const posted: Array<{ path: string; body: string }> = [];
    const chooser = () => `<title>Two-Step Verification</title>
      <p>Two-Step Verification</p>
      <p>Choose where to receive or generate the code.</p>
      <form action="/send-otp" method="post">
        ${ROUTES.map((r) => `<label><input type="radio" name="route" value="${r.value}"> ${r.label}</label>`).join("\n")}
        <a href="/resend">Didn't receive a code?</a>
        <button>Send OTP</button>
      </form>`;
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        res.setHeader("content-type", "text/html");
        if (req.method === "POST") {
          posted.push({ path: req.url ?? "", body });
          if (req.url === "/signin") return res.end(chooser());
          if (req.url === "/send-otp") {
            return res.end(`<title>Enter code</title><p>Enter the one-time code we sent you.</p><form action="/verify" method="post"><input name="otp" placeholder="Code"><button>Verify</button></form>`);
          }
          if (req.url === "/verify") {
            res.setHeader("set-cookie", "sid=abc; Path=/");
            return res.end(`<title>Account</title><p>Welcome back</p>`);
          }
          return res.end("<title>Done</title><p>done</p>");
        }
        if ((req.url ?? "").startsWith("/resend")) return res.end(chooser());
        res.end(`<title>Sign in</title><form action="/signin" method="post"><input name="email" type="email" placeholder="Email"><input name="password" type="password" placeholder="Password"><button>Sign in</button></form>`);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port;
    const { startEgressProxy } = await import("../src/design.js");
    const entry = { domain: "127.0.0.1", username: "paul@example.com", password: PASSWORD, addedAt: "2026-11-14" };
    const asks: Array<Record<string, unknown>> = [];
    const session = new BrowseSession({
      proxy: () => startEgressProxy({ allow: `127.0.0.1:${port}` }),
      policy: { mayAct: (h) => h === "127.0.0.1" },
      vault: { entryFor: (h) => (h === "127.0.0.1" ? entry : undefined), markUsed: () => undefined, savedCookies: () => [], saveSession: () => undefined },
      // The service's own relay: it is asked for the code, and it is never asked which route to use.
      otp: { code: async (i) => (asks.push({ ...i }), "112233") },
      insecureSignInForTests: true,
    });
    try {
      await session.open(`http://127.0.0.1:${port}/`);
      const after = await session.signIn();
      assert.match(after, /Signed in[\s\S]*Welcome back/, "the sign-in finished rather than stopping on the verification page");
      assert.ok(posted.some((p) => p.path === "/send-otp"), "the site's own send button was pressed");
      assert.match(posted.find((p) => p.path === "/send-otp")!.body, /route=text/, "the phone-text route was chosen, not WhatsApp or a call");
      assert.match(posted.find((p) => p.path === "/verify")!.body, /otp=112233/, "the service typed the code the relay got");
      assert.ok(!after.includes("112233"), "and the worker never sees the code");
      assert.equal(asks.length, 1, "the relay was asked for a code exactly once");
      assert.deepEqual(Object.keys(asks[0]!).sort(), ["domain", "emailOffered", "since"], "and it was never asked to choose a delivery route: that is the page's own work, done above");
      assert.equal(asks[0]!.domain, "127.0.0.1");
    } finally {
      await session.close();
      server.close();
    }
  },
);

test(
  "a cookie wall on the way to a page is cleared before the worker reads it",
  { skip: (!chrome && "no Chromium here") || (noDesigner && "running as root with no designer user") },
  async () => {
    config.design.chromiumPath = chrome!;
    const server = http.createServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(`<title>Journal</title><p>We use cookies to improve your experience.</p>
        <button onclick="this.parentNode.removeChild(this)">Accept all cookies</button>
        <p>The article you came for</p>`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port;
    const { startEgressProxy } = await import("../src/design.js");
    const session = new BrowseSession({
      proxy: () => startEgressProxy({ allow: `127.0.0.1:${port}` }),
      policy: { mayAct: (h) => h === "127.0.0.1" },
    });
    try {
      const page = await session.open(`http://127.0.0.1:${port}/`);
      assert.match(page, /The article you came for/, "the page is read");
      assert.match(page, /We use cookies/, "and the notice is gone from what the worker can press, though its words are still on the page");
      assert.doesNotMatch(page, /Accept all cookies/, "the worker is not left looking at the wall");
    } finally {
      await session.close();
      server.close();
    }
  },
);
