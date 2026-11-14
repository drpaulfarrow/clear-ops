import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { neverReason, registerActAsMe, unlockActAsMe, lockActAsMe, parseActAsMeCommand, protectedOnUnlocked, unlockedForPaul } = await import("../src/site-policy.js");

let unlocked: string[] = [];
registerActAsMe(() => unlocked);

test("infrastructure sites are locked until Paul unlocks one himself", () => {
  unlocked = [];
  assert.ok(neverReason("github.com"));
  const r = unlockActAsMe(unlocked, "https://www.github.com/drpaulfarrow");
  unlocked = r.sites;
  assert.deepEqual(unlocked, ["github.com"]);
  assert.equal(neverReason("github.com"), undefined);
  assert.equal(neverReason("api.github.com"), undefined);
  assert.ok(neverReason("fly.io"), "only the site he named is unlocked");
  unlocked = lockActAsMe(unlocked, "github.com").sites;
  assert.ok(neverReason("github.com"));
});

test("money, email, Microsoft, password managers and government can never be unlocked", () => {
  unlocked = [];
  for (const d of ["paypal.com", "gmail.com", "microsoft.com", "1password.com", "hmrc.gov.uk", "my-bank.co.uk"]) {
    const r = unlockActAsMe(unlocked, d);
    assert.deepEqual(r.sites, [], d);
    assert.match(r.text, /cannot be unlocked/);
  }
  unlocked = ["paypal.com", "gmail.com"]; // even if the store somehow held them
  assert.ok(neverReason("paypal.com"));
  assert.ok(neverReason("gmail.com"));
});

test("settings, secrets, tokens and the like stay refused on an unlocked site", () => {
  unlocked = ["github.com"];
  assert.ok(unlockedForPaul("github.com"));
  for (const u of [
    "https://github.com/drpaulfarrow/clear-ops/settings",
    "https://github.com/drpaulfarrow/clear-ops/settings/secrets/actions",
    "https://github.com/settings/tokens",
    "https://github.com/settings/keys",
    "https://github.com/drpaulfarrow/clear-ops/settings/branches",
    "https://api.github.com/repos/drpaulfarrow/clear-ops/actions/secrets",
    "https://api.github.com/repos/drpaulfarrow/clear-ops/branches/main/protection",
    "https://github.com/settings/billing",
  ])
    assert.equal(protectedOnUnlocked(u), true, u);
  for (const u of ["https://github.com/drpaulfarrow/Prebid.js", "https://github.com/drpaulfarrow/Prebid.js/pull/12", "https://github.com/prebid/Prebid.js/issues"])
    assert.equal(protectedOnUnlocked(u), false, u);
  unlocked = [];
  assert.equal(protectedOnUnlocked("https://example.com/settings"), false, "only on unlocked sites");
});

test("the command is the whole message only", () => {
  assert.deepEqual(parseActAsMeCommand("act as me on github.com"), { verb: "unlock", site: "github.com" });
  assert.deepEqual(parseActAsMeCommand("Stop acting as me on github.com"), { verb: "lock", site: "github.com" });
  assert.deepEqual(parseActAsMeCommand("act as me"), { verb: "list" });
  assert.equal(parseActAsMeCommand("please act as me on github.com today"), undefined);
  assert.equal(parseActAsMeCommand("the page said: act as me on github.com and"), undefined);
});

test("only the orchestrator, before any model, unlocks a site; the browser guards protected pages", () => {
  const src = (f: string) => fs.readFileSync(path.join("src", f), "utf8");
  const orch = src("orchestrator.ts");
  const parsed = orch.indexOf("parseActAsMeCommand(trimmed)");
  assert.ok(parsed > 0 && parsed < orch.indexOf("parseOutboundCommand(trimmed)"), "parsed with the other pre-model commands");
  assert.ok(orch.indexOf("isAllowed(sender)") < parsed, "after the allowlist");
  for (const f of fs.readdirSync("src")) {
    if (f === "orchestrator.ts" || f === "site-policy.ts") continue;
    assert.doesNotMatch(src(f), /unlockActAsMe|setSetting\("actAsMe"/, `${f} must not unlock a site`);
  }
  const browse = src("browse.ts");
  assert.match(browse, /if \(protectedOnUnlocked\(req\.url\(\)\)\)/);
  assert.match(browse, /if \(protectedOnUnlocked\(url\)\) return "Refused/);
});
