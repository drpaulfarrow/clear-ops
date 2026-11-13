/**
 * Buying things for Paul: the card vault, the purchase gate and what is never done. No network and no
 * real browser: the checkout browser is a fake that records whether the final button was pressed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.ALLOWED_TELEGRAM_IDS = "99887766";
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-purchase-"));
process.env.VAULT_KEY = "test-vault-key-that-is-long-enough";

const { Store } = await import("../src/store.js");
const { CardVault, checkCard, luhn } = await import("../src/vault.js");
const { PurchaseGate, orderTotal, orderItems, parsePurchaseCommand } = await import("../src/purchase.js");
const { PurchaseChanged } = await import("../src/browse.js");
const { CONSEQUENTIAL, FINAL_ORDER, checkoutStepOnly } = await import("../src/site-policy.js");
const { voiceRequestText } = await import("../src/voice.js");

const PAUL = "tg:99887766";
const CARD = { number: "4242 4242 4242 4242", expiry: "08/39", cvc: "123", name: "Paul Farrow", postcode: "ip31 3aa" };

const CHECKOUT = `Review your order
Delivering to Paul Farrow, Thurston
Nespresso compatible pods x 2
£11.99 each
Items: £23.98
Postage & Packing: £0.00
Order Total: £23.98
Place your order`;

function fakeBrowser(over: Partial<{ host: string; url: string; text: string; needsCard: boolean }> = {}, onComplete?: () => void) {
  const calls: Array<{ ref: number; expect: { host: string; total: string }; card?: { number: string } }> = [];
  return {
    calls,
    async checkout(_ref: number) {
      return { url: over.url ?? "https://www.amazon.co.uk/gp/buy/spc", host: over.host ?? "www.amazon.co.uk", title: "Checkout", text: over.text ?? CHECKOUT, button: "Place your order", needsCard: over.needsCard ?? false, screenshot: "AAAA" };
    },
    async completePurchase(ref: number, expect: { host: string; total: string }, card?: { number: string; expiry: string; cvc: string; name: string }) {
      calls.push({ ref, expect, ...(card ? { card } : {}) });
      onComplete?.();
      return { url: "https://www.amazon.co.uk/thankyou", title: "Thank you", text: "Order placed, thanks!\nConfirmation will be sent to your email.", cardEntered: !!card };
    },
  };
}

function setup(cards?: { summary: () => ReturnType<InstanceType<typeof CardVault>["summary"]>; forApprovedPurchase: () => ReturnType<InstanceType<typeof CardVault>["forApprovedPurchase"]> }) {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-purchase-store-")));
  const sent: string[] = [];
  const gate = new PurchaseGate(store, cards ?? { summary: () => undefined, forApprovedPurchase: () => undefined }, { send: async (_to: string, t: string) => void sent.push(t) }, { ttlMs: 2000 });
  return { store, sent, gate };
}

/** Waits until the gate has asked Paul, and returns the purchase id from its message. */
async function asked(sent: string[]): Promise<string> {
  for (let i = 0; i < 100 && !sent.length; i++) await new Promise((r) => setTimeout(r, 5));
  const id = sent[0]?.match(/\(([a-f0-9]{6}),/)?.[1];
  assert.ok(id, `expected an approval message, got: ${sent[0]}`);
  return id!;
}

test("the order total is read from the page, not from the model", () => {
  assert.equal(orderTotal(CHECKOUT), "£23.98");
  assert.equal(orderTotal("Subtotal £10.00\nDelivery £3.99\nTotal £13.99\nPay now"), "£13.99");
  assert.equal(orderTotal("Grand total: $1,204.50"), "$1,204.50");
  assert.equal(orderTotal("Basket is empty"), undefined);
  assert.match(orderItems(CHECKOUT, "£23.98"), /Nespresso compatible pods x 2/);
});

test("card checks: Luhn, a future expiry, a real security code", () => {
  assert.equal(luhn("4242424242424242"), true);
  assert.equal(luhn("4242424242424241"), false);
  const c = checkCard(CARD);
  assert.equal(c.number, "4242424242424242");
  assert.equal(c.expiry, "08/39");
  assert.equal(c.postcode, "IP31 3AA");
  assert.throws(() => checkCard({ ...CARD, number: "1234 5678 9012 3456" }), /does not look right/);
  assert.throws(() => checkCard({ ...CARD, expiry: "01/20" }), /expired/);
  assert.throws(() => checkCard({ ...CARD, cvc: "12" }), /security code/);
});

test("the card is added only through a one-time link and never summarised with its number", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-card-"));
  const cards = new CardVault(dir);
  assert.equal(cards.summary(), undefined);
  const link = cards.addLink(PAUL);
  const token = new URL(link).searchParams.get("t")!;
  assert.equal(cards.valid(token), true);
  const r = cards.add(token, CARD);
  assert.equal(r.replyTo, PAUL);
  assert.deepEqual({ last4: r.summary.last4, expiry: r.summary.expiry }, { last4: "4242", expiry: "08/39" });
  assert.doesNotMatch(JSON.stringify(cards.summary()), /4242424242424242|123"/);
  assert.throws(() => cards.add(token, CARD), /expired or was already used/);
  assert.ok(fs.existsSync(path.join(dir, "card.enc")));
  assert.equal((fs.statSync(path.join(dir, "card.enc")).mode & 0o777).toString(8), "600");
  assert.doesNotMatch(fs.readFileSync(path.join(dir, "card.enc"), "utf8"), /4242/, "encrypted on disk");
  assert.equal(cards.forApprovedPurchase()?.number, "4242424242424242");
  assert.equal(cards.remove(), true);
  assert.equal(cards.summary(), undefined);
});

test("approving presses the button once, with the exact total Paul saw", async () => {
  const { store, sent, gate } = setup();
  const browser = fakeBrowser();
  const result = gate.prepareAndWait(browser, 7, { jobId: "job1", replyTo: PAUL, why: "Paul asked for coffee pods" });
  const id = await asked(sent);
  assert.match(sent[0], /£23\.98 on www\.amazon\.co\.uk/);
  assert.match(sent[0], new RegExp(`buy ${id}`));
  assert.match(sent[0], /\/purchase\/[a-f0-9]{6}\?t=/);
  assert.equal(browser.calls.length, 0, "nothing is pressed before Paul decides");
  assert.equal(gate.decide(id, "approve", "tg:12345"), "", "only Paul can decide");
  assert.equal(browser.calls.length, 0);
  assert.match(gate.decide(id, "approve", PAUL), /Approved/);
  assert.match(await result, /placed it on www\.amazon\.co\.uk for £23\.98/);
  assert.equal(browser.calls.length, 1);
  assert.deepEqual(browser.calls[0], { ref: 7, expect: { host: "www.amazon.co.uk", total: "£23.98" } });
  assert.equal(store.getPurchase(id)?.status, "executed");
  assert.equal(store.getPurchase(id)?.decidedBy, PAUL);
  assert.match(gate.decide(id, "approve", PAUL), /already executed/, "one approval, one purchase");
});

test("declining or letting it expire presses nothing", async () => {
  const a = setup();
  const b1 = fakeBrowser();
  const r1 = a.gate.prepareAndWait(b1, 3, { replyTo: PAUL });
  const id1 = await asked(a.sent);
  assert.match(a.gate.decide(id1, "decline", PAUL), /Declined/);
  assert.match(await r1, /declined/);
  assert.equal(b1.calls.length, 0);

  const b = setup();
  const b2 = fakeBrowser();
  const r2 = await b.gate.prepareAndWait(b2, 3, { replyTo: PAUL });
  assert.match(r2, /did not approve .* in time/);
  assert.equal(b2.calls.length, 0);
  assert.equal(b.store.listPurchases()[0].status, "expired");
});

test("the approval page's token approves once, and a wrong token does nothing", async () => {
  const { sent, gate } = setup();
  const browser = fakeBrowser();
  const result = gate.prepareAndWait(browser, 1, { replyTo: PAUL });
  const id = await asked(sent);
  const token = sent[0].match(/\?t=([A-Za-z0-9_-]+)/)![1];
  assert.equal(gate.decideWithToken(id, "wrong-token", "approve"), undefined);
  assert.equal(gate.screenshot(id), "AAAA");
  assert.match(gate.decideWithToken(id, token, "approve")!, /Approved/);
  await result;
  assert.equal(gate.decideWithToken(id, token, "approve"), undefined, "the link works once");
  assert.equal(browser.calls.length, 1);
});

test("a card is entered only when the checkout asks for one, and only after approval", async () => {
  const cards = new CardVault(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-card2-")));
  cards.add(new URL(cards.addLink(PAUL)).searchParams.get("t")!, CARD);
  const { sent, gate, store } = setup(cards);
  const browser = fakeBrowser({ host: "shop.example.test", url: "https://shop.example.test/checkout", needsCard: true, text: "Card number\nExpiry\nTotal: £9.50" });
  const result = gate.prepareAndWait(browser, 2, { replyTo: PAUL });
  const id = await asked(sent);
  assert.match(sent[0], /card ending 4242/);
  assert.doesNotMatch(sent.join("\n"), /4242424242424242/);
  gate.decide(id, "approve", PAUL);
  await result;
  assert.equal(browser.calls[0].card?.number, "4242424242424242");
  assert.doesNotMatch(JSON.stringify(store.getPurchase(id)), /4242424242424242/, "the record never holds the number");
  const log = fs.readFileSync(path.join(process.env.DATA_DIR!, "purchases", "actions.log"), "utf8");
  assert.doesNotMatch(log, /4242424242424242|"123"/);
});

test("refused before Paul is even asked: no total, no card when one is needed, a money site, not https", async () => {
  const { gate, sent } = setup();
  await assert.rejects(gate.prepareAndWait(fakeBrowser({ text: "Your basket\nPlace order" }), 1, { replyTo: PAUL }), /could not find the order total/);
  await assert.rejects(gate.prepareAndWait(fakeBrowser({ needsCard: true }), 1, { replyTo: PAUL }), /no card in the vault/);
  await assert.rejects(gate.prepareAndWait(fakeBrowser({ host: "www.paypal.com", url: "https://www.paypal.com/checkout" }), 1, { replyTo: PAUL }), /off limits/);
  await assert.rejects(gate.prepareAndWait(fakeBrowser({ url: "http://www.amazon.co.uk/checkout" }), 1, { replyTo: PAUL }), /not on an https page/);
  await assert.rejects(gate.prepareAndWait(fakeBrowser(), 1, {}), /no chat/);
  assert.equal(sent.length, 0);
});

test("a page that changed after approval is not pressed", async () => {
  const { sent, gate, store } = setup();
  const browser = fakeBrowser();
  browser.completePurchase = async () => {
    throw new PurchaseChanged("the page no longer shows the total you approved (£23.98)");
  };
  const result = gate.prepareAndWait(browser, 7, { replyTo: PAUL });
  const id = await asked(sent);
  gate.decide(id, "approve", PAUL);
  assert.match(await result, /not placed/);
  assert.equal(store.getPurchase(id)?.status, "changed");
  assert.match(sent.at(-1)!, /Nothing was paid/);
});

test("buy commands: whole message, id named; a spoken request never matches", () => {
  assert.deepEqual(parsePurchaseCommand("buy abc123"), { verb: "approve", id: "abc123" });
  assert.deepEqual(parsePurchaseCommand("Buy cancel ABC123."), { verb: "decline", id: "abc123" });
  assert.deepEqual(parsePurchaseCommand("buy no abc123"), { verb: "decline", id: "abc123" });
  assert.equal(parsePurchaseCommand("buy it"), undefined);
  assert.equal(parsePurchaseCommand("please buy abc123"), undefined);
  assert.equal(parsePurchaseCommand("buy abc123 and another"), undefined);
  assert.equal(parsePurchaseCommand(voiceRequestText("buy abc123")), undefined);
});

test("agents never press the final order button; buying jobs may take checkout steps", () => {
  for (const t of ["Place your order", "Buy now", "Pay now", "Pay £23.98", "Confirm and pay", "Complete purchase", "Submit order"]) {
    assert.ok(FINAL_ORDER.test(t), t);
    assert.ok(CONSEQUENTIAL.test(t), `${t} is refused to agents without the permit too`);
    assert.equal(checkoutStepOnly(t), false, t);
  }
  for (const t of ["Proceed to checkout", "Continue to payment", "Use this payment method"]) assert.equal(checkoutStepOnly(t), true, t);
  for (const t of ["Delete payment method", "Send payment", "Proceed to checkout Place your order"]) assert.equal(checkoutStepOnly(t), false, t);
});
