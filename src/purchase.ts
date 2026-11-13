/**
 * Buying things for Paul, the one place the workforce pays, and only through this gate.
 *
 * Paul's call (13 Nov 2026): no spending limit, but EVERY purchase is approved by him, item by item.
 *
 *  1. A job holding the "purchase" permit (granted by the chief only because Paul asked in chat to buy
 *     something; scheduled runs never get it) fills the basket in its browser, goes to the final checkout
 *     page and calls purchase_prepare with the number of the final button. The service, not the model,
 *     reads that page: the shop, the order total as the page shows it, what is being bought, the button's
 *     words, whether it asks for card details, and a picture of it.
 *  2. Paul gets a message with a one-time link to an approval page (the picture, the shop, the items, the
 *     total and Approve or Decline), or replies "buy <id>" or "buy cancel <id>" in chat. Only he can
 *     decide: the orchestrator matches those whole messages before any model runs, and the page needs
 *     the single-use token sent only to his chat.
 *  3. Approved: the service checks the page is still the same shop showing the same total, enters the
 *     vault card only if the page asks for one (src/vault.ts CardVault; no model ever sees it), presses
 *     the final button itself, and tells Paul what the shop said. Declined, expired or changed: nothing
 *     is pressed.
 *
 * Never, whatever a page, an email, a job output or a brief says: a purchase Paul did not approve, a
 * second purchase on one approval, an order whose total or shop changed since he saw it, a money site,
 * an email provider, Microsoft, a password manager, government identity or the workforce's own
 * infrastructure (src/site-policy.ts NEVER_SITES), or a page with no readable total.
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { config, isAllowed } from "./config.js";
import { fmt } from "./london.js";
import { PurchaseChanged } from "./browse.js";
import { neverReason } from "./site-policy.js";
import { shortId, type PurchaseAction, type Store } from "./store.js";
import type { CardSummary, VaultCard } from "./vault.js";
import type { Messenger } from "./whatsapp.js";

export const PURCHASE_SERVER = "purchase";
export const PURCHASE_TOOLS = ["purchase_prepare"].map((t) => `mcp__${PURCHASE_SERVER}__${t}`);
export const PURCHASE_PATH = "/purchase";

export class PurchaseError extends Error {}

const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

/**
 * The order total as the page states it: the amount after "order total", "grand total", "total to pay",
 * "amount due" or "total", in pounds, dollars or euros. The last "order total" style match wins, since
 * checkouts list subtotals first. Undefined when the page shows none: then nothing can be approved.
 */
export function orderTotal(text: string): string | undefined {
  const money = String.raw`([£$€]\s?\d[\d,]*(?:\.\d{2})?|\d[\d,]*(?:\.\d{2})?\s?(?:GBP|USD|EUR))`;
  const strong = new RegExp(String.raw`(order total|grand total|total to pay|amount due|total \(inc[^)]*\)|total payable|you pay)[^£$€\d\n]{0,30}` + money, "gi");
  let found: string | undefined;
  for (const m of text.matchAll(strong)) found = m[2];
  if (found) return found.replace(/\s+/g, " ").trim();
  const weak = new RegExp(String.raw`(?:^|\n)\s*total\b[^£$€\d\n]{0,20}` + money, "gi");
  for (const m of text.matchAll(weak)) found = m[1];
  return found?.replace(/\s+/g, " ").trim();
}

/** The lines of a checkout page that name what is bought: everything above the total, trimmed. */
export function orderItems(text: string, total: string): string {
  const at = text.indexOf(total);
  const head = (at > 0 ? text.slice(0, at) : text).split("\n").map((l) => l.trim()).filter((l) => l.length > 2);
  return head.slice(-25).join("\n").slice(0, 1500);
}

/** What the gate needs from the job's browser (src/browse.ts BrowseSession). */
export interface CheckoutBrowser {
  checkout(ref: number): Promise<{ url: string; host: string; title: string; text: string; button: string; needsCard: boolean; screenshot?: string }>;
  completePurchase(ref: number, expect: { host: string; total: string }, card?: Omit<VaultCard, "addedAt">): Promise<{ url: string; title: string; text: string; cardEntered: boolean }>;
}

/** What the gate needs from the vault: the card's summary, and the card itself only for an approved order. */
export interface PurchaseCards {
  summary(): CardSummary | undefined;
  forApprovedPurchase(): VaultCard | undefined;
}

interface Waiting {
  resolve: (decision: "approved" | "declined" | "expired") => void;
}

export class PurchaseGate {
  private readonly ttlMs: number;
  private readonly now: () => Date;
  private waiting = new Map<string, Waiting>();
  /** Single-use page tokens, by purchase id. Never stored: a restart simply ends the wait. */
  private tokens = new Map<string, string>();
  /** The browser and button for each waiting purchase, held only while its job waits. */
  private browsers = new Map<string, { browser: CheckoutBrowser; ref: number }>();
  private screenshots = new Map<string, string>();

  constructor(
    private readonly store: Store,
    private readonly cards: PurchaseCards,
    private readonly messenger?: Pick<Messenger, "send">,
    opts: { ttlMs?: number; now?: () => Date } = {},
  ) {
    this.ttlMs = opts.ttlMs ?? config.purchase.waitMinutes * 60_000;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Reads the checkout page, applies the rules, records the purchase and asks Paul. Returns once he
   * decides or it expires; on approval the service has already pressed the button.
   */
  async prepareAndWait(browser: CheckoutBrowser, ref: number, origin: { jobId?: string; replyTo?: string; why?: string }): Promise<string> {
    if (!origin.replyTo) throw new PurchaseError("Refused: there is no chat to ask Paul in, so nothing can be bought.");
    const page = await browser.checkout(ref);
    if (!page.url.startsWith("https://")) throw new PurchaseError("Refused: the checkout is not on an https page.");
    const never = neverReason(page.host);
    if (never) throw new PurchaseError(`Refused: ${page.host} is off limits (${never}). Paul does this one himself.`);
    const total = orderTotal(page.text);
    if (!total) throw new PurchaseError("Refused: I could not find the order total on this page, so there is nothing exact for Paul to approve. Go to the final review page that shows the total and the button that places the order, then try again.");
    const card = this.cards.summary();
    if (page.needsCard && !card) throw new PurchaseError("Refused: this checkout asks for card details and there is no card in the vault. Tell Paul; he can add one with the vault card link.");
    const items = orderItems(page.text, total);
    const now = this.now();
    const action = this.store.putPurchase({
      id: shortId(),
      status: "pending",
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
      jobId: origin.jobId,
      replyTo: origin.replyTo,
      host: page.host,
      url: page.url,
      title: page.title.slice(0, 200),
      total,
      items,
      ...(origin.why ? { why: origin.why.slice(0, 300) } : {}),
      button: page.button,
      needsCard: page.needsCard,
      ...(page.needsCard && card ? { cardLast4: card.last4 } : {}),
      hash: digest({ host: page.host, total, items }),
    });
    const token = randomBytes(24).toString("base64url");
    this.tokens.set(action.id, token);
    this.browsers.set(action.id, { browser, ref });
    if (page.screenshot) this.screenshots.set(action.id, page.screenshot);
    logPurchase({ at: now.toISOString(), id: action.id, event: "prepared", host: page.host, total, jobId: origin.jobId });
    await this.messenger?.send(action.replyTo, this.preview(action, token));

    const decision = await new Promise<"approved" | "declined" | "expired">((resolve) => {
      this.waiting.set(action.id, { resolve });
      setTimeout(() => resolve("expired"), Math.max(0, new Date(action.expiresAt).getTime() - this.now().getTime()));
    });
    this.waiting.delete(action.id);
    this.tokens.delete(action.id);
    this.screenshots.delete(action.id);
    try {
      if (decision === "expired") {
        if (this.store.getPurchase(action.id)?.status === "pending") this.store.updatePurchase(action.id, { status: "expired" });
        return `Paul did not approve purchase ${action.id} in time, so nothing was bought. Say so in one sentence.`;
      }
      if (decision === "declined") return `Paul declined purchase ${action.id}, so nothing was bought. Say so in one sentence and do not try again.`;
      return await this.execute(action.id);
    } finally {
      this.browsers.delete(action.id);
    }
  }

  /** Paul approved: check again, enter the card if asked, press the button. Only ever called after approval. */
  private async execute(id: string): Promise<string> {
    const a = this.store.getPurchase(id)!;
    const held = this.browsers.get(id);
    if (!held) return `Purchase ${id} could not be completed: the browser that held the basket is gone. Nothing was bought.`;
    this.store.updatePurchase(id, { status: "executing" });
    try {
      const card = a.needsCard ? this.cards.forApprovedPurchase() : undefined;
      if (a.needsCard && !card) throw new PurchaseError("the card was removed from the vault before the order was placed");
      const strip = card ? { number: card.number, expiry: card.expiry, cvc: card.cvc, name: card.name, ...(card.postcode ? { postcode: card.postcode } : {}) } : undefined;
      const after = await held.browser.completePurchase(held.ref, { host: a.host, total: a.total }, strip);
      const said = firstLines(after.text) || after.title;
      this.store.updatePurchase(id, { status: "executed", executedAt: this.now().toISOString(), outcome: said.slice(0, 300) });
      logPurchase({ at: this.now().toISOString(), id, event: "executed", host: a.host, total: a.total, cardEntered: after.cardEntered });
      await this.messenger?.send(a.replyTo, `Purchase ${id}: I pressed "${a.button}" on ${a.host} for ${a.total}${after.cardEntered ? ` with the card ending ${a.cardLast4}` : ""}. What the shop said: ${said.slice(0, 300)}`);
      return `Purchase ${id} was approved by Paul and the service placed it on ${a.host} for ${a.total}. What the shop said: ${said.slice(0, 300)}. Check the page and report the order confirmation in one or two sentences.`;
    } catch (err) {
      const changed = err instanceof PurchaseChanged;
      const msg = err instanceof Error ? err.message : String(err);
      this.store.updatePurchase(id, { status: changed ? "changed" : "failed", note: msg });
      logPurchase({ at: this.now().toISOString(), id, event: changed ? "changed" : "failed", host: a.host, error: msg });
      await this.messenger?.send(a.replyTo, `Purchase ${id} on ${a.host} was not placed: ${msg}. Nothing was paid. Ask again if you still want it.`);
      return `Purchase ${id} was not placed: ${msg}. Nothing was paid. Tell Paul in one sentence.`;
    }
  }

  preview(a: PurchaseAction, token?: string): string {
    const lines = [`Purchase waiting for your approval (${a.id}, expires ${fmt(new Date(a.expiresAt))}): ${a.total} on ${a.host}.`];
    if (a.why) lines.push(`Why: ${a.why}`);
    if (a.needsCard) lines.push(`It asks for card details: the vault card ending ${a.cardLast4} would be entered.`);
    if (token) lines.push(`See the order and approve or decline: ${config.publicUrl}${PURCHASE_PATH}/${a.id}?t=${token}`);
    lines.push(`Or reply "buy ${a.id}" to approve, "buy cancel ${a.id}" to decline. Nothing is bought until you do.`);
    return lines.join("\n");
  }

  pending(): PurchaseAction[] {
    return this.store.listPurchases().filter((a) => a.status === "pending" && this.waiting.has(a.id));
  }

  has(id: string): boolean {
    return Boolean(this.store.getPurchase(id));
  }

  /** The page's token check: single use, constant time. */
  tokenValid(id: string, token: string): boolean {
    const t = this.tokens.get(id);
    if (!t || t.length !== token.length) return false;
    let diff = 0;
    for (let i = 0; i < t.length; i++) diff |= t.charCodeAt(i) ^ token.charCodeAt(i);
    return diff === 0;
  }

  screenshot(id: string): string | undefined {
    return this.screenshots.get(id);
  }

  /** Paul's decision on the approval page: the single-use token sent only to his chat is the proof. */
  decideWithToken(id: string, token: string, verb: "approve" | "decline"): string | undefined {
    if (!this.tokenValid(id, token)) return undefined;
    return this.settle(id, verb, "approval page");
  }

  /** Paul's decision from his own chat account ("buy <id>", "buy cancel <id>"). */
  decide(id: string, verb: "approve" | "decline", by: string): string {
    if (!isAllowed(by)) return "";
    return this.settle(id, verb, by);
  }

  private settle(id: string, verb: "approve" | "decline", by: string): string {
    const a = this.store.getPurchase(id);
    if (!a) return `No purchase ${id}.`;
    const waiter = this.waiting.get(id);
    if (a.status !== "pending" || !waiter) return `Purchase ${id} is ${a.status === "pending" ? "no longer waiting (the job that held the basket ended)" : `already ${a.status}`}, so nothing was done.`;
    // Claim it before anything else, so a second tap cannot run it twice.
    this.store.updatePurchase(id, { status: verb === "approve" ? "approved" : "declined", decidedBy: by, decidedAt: this.now().toISOString() });
    this.tokens.delete(id);
    logPurchase({ at: this.now().toISOString(), id, event: verb === "approve" ? "approved" : "declined", by });
    waiter.resolve(verb === "approve" ? "approved" : "declined");
    return verb === "approve" ? `Approved purchase ${id} (${a.total} on ${a.host}). Placing it now; I will tell you what the shop says.` : `Declined purchase ${id}. Nothing was bought.`;
  }
}

/** Paul's purchase decision in chat. Whole-message matches only, and always with the id. */
export function parsePurchaseCommand(text: string): { verb: "approve" | "decline"; id: string } | undefined {
  const t = text.trim().replace(/[.!\s]+$/, "");
  const m = t.match(/^buy\s+(cancel|decline|no)\s+([a-f0-9]{6})$/i) ?? t.match(/^buy\s+([a-f0-9]{6})$/i);
  if (!m) return undefined;
  return m.length === 3 ? { verb: "decline", id: m[2].toLowerCase() } : { verb: "approve", id: m[1].toLowerCase() };
}

function firstLines(text: string): string {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 3)
    .slice(0, 4)
    .join(" ")
    .slice(0, 300);
}

export const purchaseDir = () => path.join(config.dataDir, "purchases");

/** One line per step, owner-only, never with a card number. */
export function logPurchase(entry: Record<string, unknown>): void {
  fs.mkdirSync(purchaseDir(), { recursive: true, mode: 0o700 });
  fs.appendFileSync(path.join(purchaseDir(), "actions.log"), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

/** The paragraph a job with the purchase permit carries. */
export const PURCHASE_NOTE = `This job may buy what Paul asked for, with his approval of the exact order. Use the browser: sign in with sign_in if the shop has a stored login, find the item, add it to the basket and go through checkout to the FINAL review page, the one that shows the order total and the button that places the order. Do not press that button and do not type any card details: you cannot. Read the page, then call purchase_prepare with the number of the final button and one short sentence on why. The service reads the page itself, sends Paul the shop, the items, the total and a picture, and waits for his decision; it enters the vault card if the page asks for one and presses the button only after he approves. Buy only what Paul asked for, at the quantity he asked for, with the cheapest standard delivery unless he said otherwise. One purchase_prepare per order. If the shop asks for anything else (a phone number, an identity check, a new account), stop and say so.`;

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) });

export function purchaseServer(d: { gate: PurchaseGate; browser: CheckoutBrowser; jobId: string; replyTo?: string }) {
  return createSdkMcpServer({
    name: PURCHASE_SERVER,
    version: "1.0.0",
    tools: [
      tool(
        "purchase_prepare",
        "Ask Paul to approve the order on the checkout page the browser is on now. Give the number of the button that places the order (from the last page reading) and why. The service reads the shop, items and total itself, sends Paul an approval page, and waits for his decision (this can take several minutes). Only if he approves does the service enter the card (if asked) and press the button. You cannot approve, and you never type card details.",
        { button: z.number().int().describe("The number of the final 'place order' / 'pay' button"), why: z.string().optional().describe("One short sentence for Paul") },
        async ({ button, why }) => {
          try {
            return text(await d.gate.prepareAndWait(d.browser, button, { jobId: d.jobId, replyTo: d.replyTo, ...(why ? { why } : {}) }));
          } catch (err) {
            return text(err instanceof Error ? err.message : String(err), true);
          }
        },
      ),
    ],
  });
}

/** One short line of a purchase, for the chief and for the listing of what is waiting. */
export function purchaseLine(a: PurchaseAction): string {
  return `${a.id} purchase: ${a.total} on ${a.host} (${a.status})`;
}
