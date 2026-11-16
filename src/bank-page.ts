/**
 * The owner's bank page, and everything it says.
 *
 * Rules this file keeps, all of them checked in test/bank-page.test.ts:
 *
 *  - Every state is somewhere the owner can actually be, said plainly: switched off, no connection,
 *    an authorisation waiting at the bank, an authorisation to finish, connected with nothing chosen
 *    yet (which is not a success), connected and readable, or a read that failed. Nothing is dressed up
 *    and nothing is claimed that did not happen.
 *  - Every form is a POST carrying the session's CSRF token; there is no state-changing GET, no link
 *    that does anything, and no account or session identifier in any address: a read's account travels
 *    in a hidden field as a keyed handle, and the result is drawn in the POST's own answer.
 *  - Everything that came from the provider (a bank's name, an account's label, a transaction's words,
 *    a balance's type, an error's own words) is escaped here, once, and never trusted as markup.
 *  - The page fetches nothing: one inline stylesheet, inline SVG, no script, no font, no image, no
 *    third-party anything, so it renders the same with JavaScript off and leaks nothing by loading.
 */
import {
  BANK_ACCOUNTS_PATH,
  BANK_BALANCES_PATH,
  BANK_CANCEL_PATH,
  BANK_COMPLETE_PATH,
  BANK_CONNECT_PATH,
  BANK_DISCONNECT_PATH,
  BANK_PATH,
  BANK_REFRESH_PATH,
  BANK_START_PATH,
  BANK_TRANSACTIONS_PATH,
} from "./bank.js";
import type { BalanceRead, DisconnectReport, TransactionRead } from "./bank-gate.js";
import { fmtDay, londonTime } from "./london.js";
import { escapeHtml, field, htmlPage } from "./page-style.js";

/** The rules the bank page needs beyond the house style. Written here, never taken from a request. */
export const BANK_CSS = `main{max-width:30rem}
section{margin-top:1.9rem;border-top:1px solid var(--line);padding-top:1.2rem}
h2{font-size:.95rem;font-weight:600;color:#4a423a;margin:0 0 .7rem}
p.note{color:var(--muted);font-size:.85rem;margin:.5rem 0 0}
p.notice{background:#e8efe9;color:#2b3933;font-size:.88rem;border-radius:10px;padding:.7rem .8rem;margin:.9rem 0 0;overflow-wrap:anywhere}
p.problem{background:#f7eddd;color:#6d4a1c;font-size:.88rem;border-radius:10px;padding:.7rem .8rem;margin:.9rem 0 0;overflow-wrap:anywhere}
p.warn{background:#f7eddd;color:#6d4a1c;font-size:.88rem;border-radius:10px;padding:.7rem .8rem;margin:.4rem 0 0;overflow-wrap:anywhere}
dl.facts{margin:.6rem 0 0;display:grid;grid-template-columns:auto 1fr;gap:.25rem .8rem;font-size:.85rem;color:var(--muted)}
dl.facts dt{margin:0}
dl.facts dd{margin:0;color:var(--ink);overflow-wrap:anywhere}
.card{border:1px solid var(--line);background:var(--card);border-radius:12px;padding:.85rem .9rem;margin:.7rem 0 0}
.card .who{font-weight:600;font-size:.95rem;overflow-wrap:anywhere}
.card .meta{color:var(--muted);font-size:.82rem;margin:.25rem 0 0;overflow-wrap:anywhere}
form.act{margin-top:.7rem}
form.act button{margin-top:0;padding:.7rem;font-size:.95rem}
form.quiet button{background:transparent;color:var(--accent);border:1px solid var(--line);font-weight:500}
form.quiet button:hover{background:var(--tile)}
form.act.inline{display:flex;flex-wrap:wrap;gap:.6rem;align-items:flex-end;margin-top:.8rem}
form.act.inline .pair{flex:1 1 8rem;min-width:0}
form.act.inline label{margin:0 0 .3rem}
form.act.inline button{flex:1 1 100%;margin-top:0}
table.ledger{width:100%;border-collapse:collapse;font-size:.88rem;margin-top:.7rem}
table.ledger th{text-align:left;font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:600;border-bottom:1px solid var(--line);padding:.3rem .25rem}
table.ledger td{padding:.5rem .25rem;border-bottom:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere}
table.ledger td.num,table.ledger th.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
table.ledger td.when{white-space:nowrap;color:var(--muted)}
p.tot{margin:.7rem 0 0;color:var(--muted);font-size:.85rem}
details{margin-top:1.3rem;border-top:1px solid var(--line);padding-top:.9rem}
summary{cursor:pointer;font-weight:600;font-size:.9rem;color:#4a423a}
details .in{padding-top:.4rem}
a.back{display:inline-block;margin-top:1.2rem;color:var(--accent);font-size:.9rem}
a.go{display:block;text-align:center;margin-top:1.2rem;padding:1.05rem;border-radius:12px;background:var(--accent);color:var(--accent-ink);font-weight:600;text-decoration:none;overflow-wrap:anywhere}
a.go:hover{background:#2b3933}
label.check{display:flex;gap:.6rem;align-items:flex-start;font-size:.92rem;font-weight:500;color:var(--ink);margin:.6rem 0 0}
label.check input{width:1.15rem;height:1.15rem;flex:0 0 auto;margin:.15rem 0 0}
ul.plain{margin:.6rem 0 0;padding-left:1.1rem;color:var(--muted);font-size:.88rem}
ul.plain li{margin:.35rem 0}`;

export interface BankAccountView {
  /** The keyed handle the form carries. Never the provider's own identifier. */
  handle: string;
  label: string;
  chosen: boolean;
}

export type BankRead =
  | { kind: "balances"; read: BalanceRead }
  | { kind: "transactions"; read: TransactionRead }
  | { kind: "disconnect"; report: DisconnectReport };

export interface BankView {
  csrf: string;
  state: "off" | "unreadable" | "not-connected" | "confirm" | "waiting" | "parked" | "connected";
  /** Why it is off, or why the stored record cannot be read. Shown as it is. */
  off?: string;
  /** The one-time connect action, on the page that confirms what will happen. */
  action?: string;
  /** What the last thing the owner did came to, in one sentence. */
  notice?: string;
  /** What failed, in one sentence. Never a stack, a status code alone or a provider body. */
  failure?: string;
  /** The bank's name as the provider's own list gave it. */
  aspsp?: string;
  connection?: { aspsp: string; scope: string[]; connectedAt: string; accessValidUntil?: string; lastReadAt?: string };
  /** The accounts the provider's session can see, with the ones chosen marked. */
  accounts?: BankAccountView[];
  /** When that list was read from the provider. */
  listingAt?: string;
  /** The waiting attempt's own state, while the bank has the browser. */
  waiting?: { aspsp: string; parked: boolean; startedAt: string; url?: string };
  read?: BankRead;
  /** The dates the transaction form starts with. */
  window: { from: string; to: string };
  /** The exact address the provider will send the browser back to, shown before anything starts. */
  redirectUrl: string;
  days: number;
}

const hidden = (name: string, value: string) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;

const post = (action: string, fields: string, o: { button?: string; cls?: string } = {}) =>
  `<form method="post" action="${action}"${o.cls ? ` class="${o.cls}"` : ""} autocomplete="off">${fields}${o.button ? `<button type="submit">${escapeHtml(o.button)}</button>` : ""}</form>`;

const line = (cls: string, text: string | undefined) => (text ? `<p class="${cls}">${escapeHtml(text)}</p>` : "");

/** A London reading of an instant the page was told about, or the value as it is when it is not one. */
function when(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  return `${fmtDay(at)}, ${new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" }).format(at)}`;
}

/** The provider's own expiry date, said as a London date when it is one and exactly as it came otherwise. */
function expiry(value: string): string {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short", year: "numeric" }).format(at);
}

/** A transaction's own date words: a day if the provider gave a day, otherwise exactly what it gave. */
function day(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const at = londonTime(value, 12);
  return Number.isNaN(at.getTime()) ? value : fmtDay(at);
}

const money = (amount: string, currency: string) => (currency ? `${amount} ${currency}` : amount);

function ledger(rows: string[][], head: string[], numeric: number[]): string {
  const cls = (i: number, cell: "th" | "td") => {
    const parts = [numeric.includes(i) && cell === "td" ? "num" : numeric.includes(i) && cell === "th" ? "num" : "", cell === "td" && i === 0 && !numeric.includes(0) ? "when" : ""].filter(Boolean);
    return parts.length ? ` class="${parts.join(" ")}"` : "";
  };
  const th = head.map((h, i) => `<th${cls(i, "th")}>${escapeHtml(h)}</th>`).join("");
  const body = rows.map((r) => `<tr>${r.map((cell, i) => `<td${cls(i, "td")}>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("");
  return `<table class="ledger"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`;
}

/* ---------- The states ---------- */

function offPage(view: BankView): string {
  return htmlPage({
    title: "Bank accounts",
    heading: "Bank accounts",
    icon: "bank",
    tone: "alert",
    text: view.off ?? "The bank connector is off.",
    foot: "Nothing is read from any bank while it is off.",
    css: BANK_CSS,
  });
}

function unreadablePage(view: BankView): string {
  return htmlPage({
    title: "Bank connection unreadable",
    heading: "Bank connection unreadable",
    icon: "alert",
    tone: "alert",
    text: view.off,
    body: line("problem", "Nothing is read or written until a fresh connection is made. The existing stored record has been left exactly as it is."),
    foot: "A changed or missing key, or an altered file, stops the connector rather than reading anything.",
    css: BANK_CSS,
  });
}

function startPage(view: BankView): string {
  const body =
    line("notice", view.notice) +
    line("problem", view.failure) +
    // A disconnect lands on this state (there is no connection any more), and its three-part report is
    // the one thing on the page that must not be lost on the way.
    readBlock(view) +
    post(BANK_CONNECT_PATH, hidden("csrf", view.csrf), { button: "Connect to HSBC UK" }) +
    `<section><h2>What happens when you press it</h2><ul class="plain"><li>You are sent to HSBC's own page through Enable Banking to authorise a read-only consent for the accounts you pick next.</li><li>Nothing is read and nothing is stored until you come back, sign in here again if asked, and choose which accounts may be read.</li><li>This connector can never pay, transfer or change anything: it has no such operation.</li><li>No model ever sees any of it, and nothing is read on a schedule.</li></ul></section>`;
  return htmlPage({
    title: "Bank accounts",
    heading: "Bank accounts",
    icon: "bank",
    chip: "HSBC UK personal",
    text: "Balances and a date-bounded transaction list, read when you ask, from the accounts you choose. Read-only.",
    body,
    foot: "This page sits behind your sign-in password. That password is the only proof of who is asking.",
    css: BANK_CSS,
  });
}

function confirmPage(view: BankView): string {
  const body =
    line("notice", view.notice) +
    line("problem", view.failure) +
    post(BANK_START_PATH, hidden("csrf", view.csrf) + hidden("action", view.action ?? ""), { button: "Go to HSBC to authorise" }) +
    `<section><h2>Before you go</h2><dl class="facts"><dt>Bank</dt><dd>${escapeHtml(view.aspsp ?? "HSBC UK")}</dd><dt>Consent</dt><dd>read-only, asked for ${view.days} days</dd><dt>Comes back to</dt><dd>${escapeHtml(view.redirectUrl)}</dd></dl><p class="note">This connect action lasts ten minutes and works once. If you do not finish, nothing was changed and you start again.</p></section>` +
    `<a class="back" href="${BANK_PATH}">Back to the bank page</a>`;
  return htmlPage({
    title: "Connect to HSBC UK",
    heading: "Connect to HSBC UK",
    icon: "bank",
    chip: view.aspsp ?? "HSBC UK",
    text: "The next page is your bank's own. This service never sees your banking password or your one-time code: you authorise it there, and it hands back a read-only token.",
    body,
    css: BANK_CSS,
  });
}

function waitingPage(view: BankView): string {
  const bank = view.waiting?.aspsp ?? view.aspsp ?? "your bank";
  // The bank's own page is followed from a link here, never by redirecting the form that started it:
  // the page's CSP is `form-action 'self'`, which a browser applies to a form submission's redirects
  // too, and the bank's own domain cannot be named in advance. Nothing is fetched by this page itself.
  const leaving = !view.waiting?.parked && Boolean(view.waiting?.url);
  const go = leaving ? `<a class="go" href="${escapeHtml(view.waiting?.url ?? "")}">Continue to ${escapeHtml(bank)}</a>` : "";
  const body =
    line("notice", view.notice) +
    line("problem", view.failure) +
    `<section><h2>${leaving ? "Go to your bank" : "Waiting for the bank"}</h2><dl class="facts"><dt>Bank</dt><dd>${escapeHtml(bank)}</dd><dt>Started</dt><dd>${escapeHtml(when(view.waiting?.startedAt) ?? "just now")}</dd></dl>${go}<p class="note">${leaving ? "That link is your bank's own page, and it is where you authorise a read-only consent. This service never sees your banking password or a one-time code." : "If you are not on your bank's page any more, and it never came back here, nothing was started: cancel below and connect again."}</p></section>` +
    post(BANK_CANCEL_PATH, hidden("csrf", view.csrf), { button: "Cancel this connection", cls: "act quiet" }) +
    `<a class="back" href="${BANK_PATH}">Back to the bank page</a>`;
  return htmlPage({
    title: "Waiting for your bank",
    heading: leaving ? "Go to your bank" : "Waiting for your bank",
    icon: "bank",
    text: leaving
      ? "Nothing has been read yet. Your bank's own page is where you authorise this, and it is one press away."
      : "Your browser has gone to your bank to authorise a read-only consent. This page refreshes nothing and fetches nothing.",
    body,
    foot: "Only a signed-in session here can finish a connection, and a restart of the service forgets a half-finished attempt.",
    css: BANK_CSS,
  });
}

function parkedPage(view: BankView): string {
  const body =
    line("notice", view.notice) +
    line("problem", view.failure) +
    post(BANK_COMPLETE_PATH, hidden("csrf", view.csrf), { button: "Finish connecting" }) +
    post(BANK_CANCEL_PATH, hidden("csrf", view.csrf), { button: "Cancel this connection", cls: "act quiet" }) +
    `<p class="note">The one-time code the bank handed back is held in memory, useable once, and is discarded the moment it is used or this attempt expires.</p>`;
  return htmlPage({
    title: "Finish connecting",
    heading: "Finish connecting",
    icon: "bank",
    tone: "ok",
    chip: view.aspsp ?? "HSBC UK",
    text: "The bank has handed back an authorisation. Press Finish in this signed-in session to make the connection and choose which accounts may be read.",
    body,
    css: BANK_CSS,
  });
}

function readBlock(view: BankView): string {
  if (!view.read) return "";
  if (view.read.kind === "disconnect") {
    const r = view.read.report;
    return `<section><h2>Disconnected</h2>${line("notice", r.local)}${line("problem", r.vendor)}${line("notice", r.bank)}<p class="note">${escapeHtml(r.record)}</p></section>`;
  }
  if (view.read.kind === "balances") {
    const { read } = view.read;
    const rows = read.lines.map((l) => [l.name && l.name !== l.type ? `${l.name}` : l.type, money(l.amount, l.currency)]);
    const table = rows.length ? ledger(rows, ["Balance", "Amount"], [1]) : line("problem", "The provider returned no balances for this account. That is what it said, and nothing here is filled in.");
    return `<section><h2>Balances · ${escapeHtml(read.account)}</h2>${line("notice", `Read from the provider at ${when(read.at) ?? read.at} (London time).`)}${table}<p class="note">These are what the provider returned at that moment. They are shown here and stored nowhere, and they may differ from your banking app.</p><a class="back" href="${BANK_PATH}">Back to the bank page</a></section>`;
  }
  const { read } = view.read;
  const rows = read.lines.map((l) => [day(l.date), l.description, money(l.amount, l.currency)]);
  const table = rows.length
    ? ledger(rows, ["Date", "Description", "Amount"], [2])
    : line("problem", `The provider returned no transactions between ${read.from} and ${read.to}.`);
  const totals = `Read ${read.count} transaction${read.count === 1 ? "" : "s"} over ${read.pages} page${read.pages === 1 ? "" : "s"}, showing ${read.shown}.`;
  const cut = read.truncated ? " The read stopped at this connector's safety bound, so there is more in that range: narrow the dates to see it." : "";
  return `<section><h2>Transactions · ${escapeHtml(read.account)}</h2>${line("notice", `Read from the provider at ${when(read.at) ?? read.at} (London time), for ${read.from} to ${read.to}.`)}${table}<p class="tot">${escapeHtml(totals + cut)}</p><p class="note">Shown here and stored nowhere. Only the accounts you chose are read, and only when you press the button.</p><a class="back" href="${BANK_PATH}">Back to the bank page</a></section>`;
}

function accountCards(view: BankView): string {
  const chosen = (view.accounts ?? []).filter((a) => a.chosen);
  if (!chosen.length) return "";
  return chosen
    .map(
      (a) =>
        `<div class="card"><div class="who">${escapeHtml(a.label)}</div>` +
        post(BANK_BALANCES_PATH, hidden("csrf", view.csrf) + hidden("account", a.handle), { button: "Show balances" }) +
        post(
          BANK_TRANSACTIONS_PATH,
          hidden("csrf", view.csrf) +
            hidden("account", a.handle) +
            `<div class="pair">${field({ label: "From", name: "from", type: "date", value: view.window.from, required: true })}</div><div class="pair">${field({ label: "To", name: "to", type: "date", value: view.window.to, required: true })}</div>`,
          { button: "Show transactions", cls: "act inline" },
        ) +
        `</div>`,
    )
    .join("");
}

function chooserBody(view: BankView): string {
  const accounts = view.accounts ?? [];
  if (!accounts.length) {
    return line("problem", "The provider's session is showing no accounts at all, so there is nothing to choose and nothing is readable. Refresh, or connect again.");
  }
  const boxes = accounts
    .map(
      (a, i) =>
        `<label class="check" for="c-${i}"><input id="c-${i}" type="checkbox" name="account" value="${escapeHtml(a.handle)}"${a.chosen ? " checked" : ""}><span>${escapeHtml(a.label)}</span></label>`,
    )
    .join("");
  return `<p class="note">Only the ones ticked here are ever read. A connection that can see an account is not permission to read it.</p>${post(BANK_ACCOUNTS_PATH, hidden("csrf", view.csrf) + boxes, { button: "Save these accounts" })}<p class="note">Listed by the provider's session at ${escapeHtml(when(view.listingAt) ?? view.listingAt ?? "just now")}.</p>`;
}

const chooser = (view: BankView) => `<section><h2>Which accounts may be read</h2>${chooserBody(view)}</section>`;

function connectedPage(view: BankView): string {
  const c = view.connection;
  const chosen = (view.accounts ?? []).filter((a) => a.chosen).length;
  const facts = `<dl class="facts"><dt>Bank</dt><dd>${escapeHtml(c?.aspsp ?? "HSBC UK")}</dd><dt>Connected</dt><dd>${escapeHtml(when(c?.connectedAt) ?? "—")}</dd><dt>Consent ends</dt><dd>${escapeHtml(c?.accessValidUntil ? expiry(c.accessValidUntil) : "the provider gave no end date")}</dd>${c?.lastReadAt ? `<dt>Last read</dt><dd>${escapeHtml(when(c.lastReadAt) ?? c.lastReadAt)}</dd>` : ""}${c?.scope?.length ? `<dt>Scope</dt><dd>${escapeHtml(c.scope.join(", "))}</dd>` : ""}</dl>`;
  const body =
    line("notice", view.notice) +
    line("problem", view.failure) +
    readBlock(view) +
    `<section><h2>This connection</h2>${facts}${line("note", "Read-only. Nothing here can pay, transfer or change anything, and nothing is read until you press a button.")}</section>` +
    (chosen
      ? `<section><h2>Accounts you can read</h2>${accountCards(view)}${line("note", "The two date boxes use your browser's own date format, and a read covers the whole of both days (London time). The dates it really read are named in the answer.")}</section>`
      : `<section><h2>Accounts you can read</h2>${line("warn", "Nothing is readable yet: you have not chosen an account. A connection is not the same as permission to read an account.")}<h2 style="margin-top:1.2rem">Which accounts may be read</h2>${chooserBody(view)}</section>`) +
    (chosen ? `<details><summary>Change which accounts may be read</summary><div class="in">${chooser(view)}</div></details>` : "") +
    `<details><summary>Refresh the account list, or disconnect</summary><div class="in">${post(BANK_REFRESH_PATH, hidden("csrf", view.csrf), { button: "Refresh from the provider" })}${post(BANK_DISCONNECT_PATH, hidden("csrf", view.csrf), { button: "Disconnect" })}${line("note", "Disconnecting blocks local reads at once, asks the provider to delete its session, and destroys the stored record. It cannot revoke the bank's own consent: that is the bank's record, and the page will tell you what to do about it.")}</div></details>`;
  return htmlPage({
    title: "Bank accounts",
    heading: c?.aspsp ?? "Bank accounts",
    icon: "bank",
    chip: "read-only",
    text: "Balances and a date-bounded transaction list from the accounts you chose, read when you ask.",
    body,
    foot: "Nothing on this page is stored: no balance and no transaction is kept anywhere.",
    css: BANK_CSS,
  });
}

/** The one page builder: the view's state decides what is drawn, and nothing else does. */
export function renderBank(view: BankView): string {
  switch (view.state) {
    case "off":
      return offPage(view);
    case "unreadable":
      return unreadablePage(view);
    case "confirm":
      return confirmPage(view);
    case "waiting":
      return waitingPage(view);
    case "parked":
      return parkedPage(view);
    case "connected":
      return connectedPage(view);
    default:
      return startPage(view);
  }
}

/**
 * One page with a heading and a sentence: the callback's outcome, and nothing else. `body` is markup
 * the caller writes here in this module (a note and a link); everything in `text` and `foot` is escaped
 * by the page builder, and nothing from the bank's query string is ever rendered.
 */
export function bankMessagePage(o: { title: string; heading: string; icon?: "bank" | "alert" | "tick"; tone?: "ok" | "alert"; text: string; body?: string; foot?: string }): string {
  return htmlPage({ title: o.title, heading: o.heading, icon: o.icon ?? "bank", ...(o.tone ? { tone: o.tone } : {}), text: o.text, ...(o.body ? { body: o.body } : {}), ...(o.foot ? { foot: o.foot } : {}), css: BANK_CSS });
}
