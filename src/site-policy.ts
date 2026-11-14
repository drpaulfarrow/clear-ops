/**
 * Where the workforce's browser may act, not just read (src/browse.ts).
 *
 * Reading is allowed on any public site. Acting (anything other than GET, HEAD and OPTIONS: submitting
 * forms, signing in) is allowed on the "act freely" sites below plus any Paul adds in chat, and on any
 * site with a login in the vault (src/vault.ts). Consequential actions (paying, sending, posting,
 * deleting, closing accounts) are refused on every site: the agent reports what it would do instead.
 *
 * Some sites are off limits whatever Paul says in chat (`NEVER_SITES`): money, email, Microsoft and
 * work accounts, password managers, government identity and tax, and the infrastructure the workforce
 * itself runs on. A rule change in chat can only add to or trim the act-freely list; it cannot reach
 * those, and every change is confirmed back to Paul.
 *
 * One exception, Paul's call (14 Nov 2026, "I want this workforce to act as me on some sites of my
 * choosing"): a site in an `unlockable` group (the infrastructure group, GitHub among it) can be
 * unlocked by Paul's own chat message `act as me on <site>`, parsed by the service before any model
 * (src/orchestrator.ts), never by the chief or a worker. On an unlocked site the workforce may store
 * his login, sign in as him and act as him, except on the pages that would let it change its own
 * guardrails or his account (`PROTECTED_PATHS`: settings, security, secrets, tokens, keys, billing,
 * members, apps, branch rules, deleting and transferring), which stay refused to every request. The
 * other groups (money, email, Microsoft, password managers, government) can never be unlocked.
 */

/** A bare lowercase host for a domain or URL Paul or an agent gave: "https://www.Example.com/x" -> "example.com". */
export function normaliseDomain(input: string): string {
  let s = input.trim().toLowerCase();
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = new URL(s).hostname;
  s = s.split("/")[0].split(":")[0].replace(/\.$/, "").replace(/^www\./, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s)) throw new Error(`"${input}" is not a domain name`);
  return s;
}

/** host is the domain or one of its subdomains. */
export function onDomain(host: string, domain: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return h === domain || h.endsWith(`.${domain}`);
}

/** Never signed in to or acted on, whatever is said in chat. Each group says why. */
export const NEVER_SITES: Array<{ why: string; domains: string[]; words?: RegExp; unlockable?: boolean }> = [
  {
    why: "banks, payments, investing and crypto are never automated",
    domains: [
      "paypal.com", "stripe.com", "wise.com", "revolut.com", "monzo.com", "starlingbank.com", "barclays.co.uk", "barclays.com", "hsbc.co.uk", "hsbc.com",
      "lloydsbank.com", "natwest.com", "rbs.co.uk", "santander.co.uk", "nationwide.co.uk", "halifax.co.uk", "tsb.co.uk", "firstdirect.com", "metrobankonline.co.uk",
      "americanexpress.com", "capitalone.co.uk", "chase.co.uk", "chase.com", "klarna.com", "clearpay.co.uk", "coinbase.com", "binance.com", "kraken.com",
      "vanguardinvestor.co.uk", "hl.co.uk", "ajbell.co.uk", "trading212.com", "etoro.com", "freetrade.io", "nutmeg.com", "haspa.de", "sparkasse.de",
    ],
    words: /(^|[.-])(bank|banking|onlinebanking|paypal|pay|wallet|crypto|invest|broker|pension)([.-]|$)/,
  },
  {
    why: "email accounts are never signed in to (the executive assistant has its own narrower access)",
    domains: ["gmail.com", "google.com", "googlemail.com", "outlook.com", "live.com", "hotmail.com", "yahoo.com", "proton.me", "protonmail.com", "icloud.com", "apple.com", "aol.com", "fastmail.com", "zoho.com"],
  },
  {
    why: "Microsoft and work accounts are off limits to the workforce",
    domains: ["microsoft.com", "microsoftonline.com", "office.com", "office365.com", "sharepoint.com", "azure.com", "live.net", "msn.com", "xandr.com", "appnexus.com", "teams.microsoft.com"],
  },
  {
    why: "password managers are never signed in to",
    domains: ["1password.com", "bitwarden.com", "lastpass.com", "dashlane.com", "keepersecurity.com", "nordpass.com", "roboform.com"],
  },
  {
    why: "government identity and tax accounts are never automated",
    domains: ["hmrc.gov.uk", "tax.service.gov.uk", "account.gov.uk", "sign-in.service.gov.uk", "access.service.gov.uk", "gateway.gov.uk", "irs.gov", "login.gov", "elster.de"],
  },
  {
    why: "the workforce never signs in to the infrastructure it runs on unless you unlock the site yourself (act as me on <site>)",
    unlockable: true,
    domains: ["github.com", "fly.io", "openrouter.ai", "anthropic.com", "claude.ai", "godaddy.com", "discord.com", "telegram.org", "aws.amazon.com", "cloudflare.com", "ovhcloud.com", "ovh.com", "brave.com", "exa.ai"],
  },
];

/** Where the sites Paul unlocked with "act as me on <site>" are read from (the store, wired at boot). */
let actAsMeSource: () => string[] = () => [];
export function registerActAsMe(source: () => string[]): void {
  actAsMeSource = source;
}

/** The sites Paul unlocked himself, safely: a broken source unlocks nothing. */
export function actAsMeSites(): string[] {
  try {
    return actAsMeSource().map((d) => d.toLowerCase());
  } catch {
    return [];
  }
}

/** The host is on a site Paul unlocked in an unlockable group. */
export function unlockedForPaul(host: string): boolean {
  const d = host.toLowerCase();
  return actAsMeSites().some((u) => onDomain(d, u)) && NEVER_SITES.some((g) => g.unlockable && g.domains.some((n) => onDomain(d, n)));
}

/** Why a domain is off limits, or undefined when it is not. */
export function neverReason(domain: string): string | undefined {
  const d = domain.toLowerCase();
  const unlocked = actAsMeSites().filter((u) => onDomain(d, u));
  for (const g of NEVER_SITES) {
    if (g.unlockable && unlocked.length) continue;
    if (g.domains.some((n) => onDomain(d, n))) return g.why;
    if (g.words?.test(d)) return g.why;
  }
  return undefined;
}

/**
 * Pages on an unlocked site that stay refused to every request, reading included: the places where a
 * signed-in session could change the workforce's own guardrails or Paul's account rather than do work
 * as him. GitHub's settings, secrets, tokens, branch rules, apps, members, billing and danger zone are
 * all here, and the same words cover the other infrastructure sites.
 */
export const PROTECTED_PATHS =
  /(^|\/)(settings|security|secrets|tokens|personal-access-tokens|keys|ssh|gpg|billing|payment|plan|members|collaborators|access|teams|people|installations|apps|applications|hooks|webhooks|rules|rulesets|branches|protection|environments|runners|admin|danger|delete|transfer|archive|sessions|password|two-factor|2fa|account|organizations\/new|api-keys|credits|deploy-keys)(\/|$)/i;

/** A URL that is a protected page on a site Paul unlocked: refused, whatever the method. */
export function protectedOnUnlocked(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!unlockedForPaul(u.hostname)) return false;
  // GitHub's API spells the same places as /repos/<o>/<r>/<thing> and /user/<thing>: the same words apply.
  return PROTECTED_PATHS.test(u.pathname);
}

/** Paul's own "act as me on <site>": only a site in an unlockable group, confirmed back in plain words. */
export function unlockActAsMe(current: string[], input: string): { sites: string[]; text: string } {
  let d: string;
  try {
    d = normaliseDomain(input);
  } catch {
    return { sites: current, text: `"${input}" is not a site name. Send: act as me on github.com` };
  }
  const group = NEVER_SITES.find((g) => g.domains.some((n) => onDomain(d, n)) || g.words?.test(d));
  if (group && !group.unlockable) return { sites: current, text: `${d} stays off limits: ${group.why}. That one cannot be unlocked.` };
  if (!group)
    return {
      sites: current,
      text: `${d} is not blocked, so nothing to unlock. Add its login on the vault page (ask for the vault link) and agents will sign in and act there as you; paying, sending, posting and deleting still come to you.`,
    };
  const sites = [...new Set([...current, d])].sort();
  return {
    sites,
    text: `Done: agents may now sign in to ${d} as you, with the login you add on the vault page (ask for the vault link if it is not there yet). They can do work there as you, but its settings, security, secrets, tokens, keys, billing, members, apps and branch rules stay out of reach, and paying, posting, publishing and deleting still come to you. Send "stop acting as me on ${d}" to undo it.`,
  };
}

/** Paul's own "stop acting as me on <site>". */
export function lockActAsMe(current: string[], input: string): { sites: string[]; text: string } {
  let d: string;
  try {
    d = normaliseDomain(input);
  } catch {
    return { sites: current, text: `"${input}" is not a site name.` };
  }
  if (!current.includes(d)) return { sites: current, text: `${d} was not unlocked, so nothing changed.` };
  return { sites: current.filter((x) => x !== d), text: `${d} is locked again: agents will not sign in there as you. Its login stays in the vault unused; say remove the login if you want it gone.` };
}

/** "act as me on <site>", "stop acting as me on <site>" or "act as me" (the list): whole message only. */
export function parseActAsMeCommand(text: string): { verb: "unlock" | "lock" | "list"; site?: string } | undefined {
  const t = text.trim();
  let m = t.match(/^act as me on\s+(\S+)$/i);
  if (m) return { verb: "unlock", site: m[1] };
  m = t.match(/^stop acting as me on\s+(\S+)$/i);
  if (m) return { verb: "lock", site: m[1] };
  if (/^act as me\??$/i.test(t)) return { verb: "list" };
  return undefined;
}

/** Sites whose terms forbid automated use: allowed if Paul insists, but he is told the account may be banned. */
export const TERMS_RISK = ["linkedin.com", "facebook.com", "instagram.com", "x.com", "twitter.com", "tiktok.com", "reddit.com", "amazon.co.uk", "amazon.com"];

export function termsWarning(domain: string): string | undefined {
  return TERMS_RISK.some((t) => onDomain(domain, t)) ? `${domain}'s terms forbid automated use; the account could be restricted or banned if it notices` : undefined;
}

/**
 * The starter act-freely list: research, standards and reference sites where filling forms and running
 * searches is low-stakes and nothing is bought, sent or posted. Paul can add or remove any in chat.
 */
export const DEFAULT_ACT_SITES = [
  // Standards bodies and Paul's industry
  "iab.com", "iabtechlab.com", "iabeurope.eu", "prebid.org", "w3.org", "ietf.org", "rfc-editor.org", "networkadvertising.org", "wfanet.org", "ico.org.uk", "edpb.europa.eu", "europa.eu",
  // Research and reference
  "arxiv.org", "semanticscholar.org", "ssrn.com", "researchgate.net", "jstor.org", "pubmed.ncbi.nlm.nih.gov", "nih.gov", "wikipedia.org", "wikidata.org", "archive.org", "oecd.org", "worldbank.org", "statista.com", "ons.gov.uk",
  // Company and market data
  "crunchbase.com", "pitchbook.com", "cbinsights.com", "dealroom.co", "sec.gov", "find-and-update.company-information.service.gov.uk", "opencorporates.com", "similarweb.com", "builtwith.com", "g2.com", "capterra.com", "producthunt.com",
  // Developer documentation and packages
  "npmjs.com", "pypi.org", "developer.mozilla.org", "stackoverflow.com", "readthedocs.io", "docs.rs", "huggingface.co",
  // News and analysis
  "ft.com", "economist.com", "reuters.com", "bloomberg.com", "theguardian.com", "bbc.co.uk", "adexchanger.com", "digiday.com", "pressgazette.co.uk", "theinformation.com", "techcrunch.com", "theverge.com", "wired.com", "axios.com", "mediapost.com",
  // Travel and comparison search (booking itself is a consequential action and is refused)
  "skyscanner.net", "kayak.co.uk", "booking.com", "trainline.com", "nationalrail.co.uk", "tfl.gov.uk", "rightmove.co.uk", "zoopla.co.uk", "autotrader.co.uk", "which.co.uk", "moneysavingexpert.com",
];

/**
 * Words on a button, link or form that make an action consequential. A click or Enter that would
 * trigger one is refused on every site, act-freely and vault sites included.
 */
/**
 * The click that actually places an order or pays. Never pressed by an agent: only the purchase gate
 * (src/purchase.ts) presses it, after Paul approves that exact order.
 */
export const FINAL_ORDER = /\b(place (your )?order|place order|buy now|pay now|pay (£|\$|€)|complete (your )?(order|purchase|payment)|confirm (and pay|order|payment|purchase)|submit (your )?order|order and pay|start (my )?subscription)\b/i;

/**
 * Steps on the way to a checkout that a job allowed to buy may take (they move to the next page; nothing
 * is paid). Anything that also matches FINAL_ORDER is still refused.
 */
export const CHECKOUT_STEP = /\b(proceed to checkout|go to checkout|checkout|check out|continue to (payment|checkout|review)|use this (payment method|card|address)|payment method|review (your )?order)\b/i;

/**
 * True when every consequential word in `words` is checkout vocabulary on a checkout step ("Proceed to
 * checkout", "Continue to payment", "Use this payment method"), and none of it places an order.
 */
export function checkoutStepOnly(words: string): boolean {
  if (FINAL_ORDER.test(words) || !CHECKOUT_STEP.test(words)) return false;
  const all = [...words.matchAll(new RegExp(CONSEQUENTIAL.source, "gi"))].map((m) => m[0].toLowerCase());
  return all.length > 0 && all.every((w) => w === "payment" || w === "checkout" || w === "check out");
}

export const CONSEQUENTIAL = /\b(pay|payment|buy|purchase|order now|place order|place (your )?order|submit (your )?order|complete (your )?(order|purchase)|order and pay|checkout|check out|book now|complete booking|reserve|subscribe|upgrade|donate|transfer|send|post|publish|tweet|share now|reply|comment|delete|remove account|close account|cancel (my )?(account|subscription|membership)|deactivate|unsubscribe|withdraw|apply now|submit application|sign contract|e-?sign|accept offer|confirm (order|payment|booking|purchase))\b/i;

/** A store-like thing holding Paul's own additions and removals. */
export interface SiteRuleStore {
  siteRules(): { added: string[]; removed: string[] };
  setSiteRules(r: { added: string[]; removed: string[] }): void;
}

export class SitePolicy {
  constructor(
    private readonly store: SiteRuleStore,
    private readonly vaultDomains: () => string[] = () => [],
  ) {}

  /** The act-freely list as it stands: defaults, minus Paul's removals, plus his additions. */
  actSites(): string[] {
    const r = this.store.siteRules();
    const set = new Set([...DEFAULT_ACT_SITES.filter((d) => !r.removed.includes(d)), ...r.added]);
    return [...set].filter((d) => !neverReason(d)).sort();
  }

  /** May the browser make a non-GET request to this host? */
  mayAct(host: string): boolean {
    if (neverReason(host)) return false;
    return [...this.actSites(), ...this.vaultDomains()].some((d) => onDomain(host, d));
  }

  /** Paul asked (in chat) to let agents act on a site. */
  allow(input: string): string {
    const d = normaliseDomain(input);
    const never = neverReason(d);
    if (never) return `${d} stays read-only: ${never}. That cannot be changed from chat.`;
    const r = this.store.siteRules();
    this.store.setSiteRules({ added: [...new Set([...r.added, d])].sort(), removed: r.removed.filter((x) => x !== d) });
    const warn = termsWarning(d);
    return `Agents may now act on ${d} (fill forms, run searches, sign in if its login is in the vault). Paying, sending, posting and deleting still need you.${warn ? ` Note: ${warn}.` : ""}`;
  }

  /** Paul asked to make a site read-only again. */
  disallow(input: string): string {
    const d = normaliseDomain(input);
    const r = this.store.siteRules();
    const wasDefault = DEFAULT_ACT_SITES.includes(d);
    this.store.setSiteRules({ added: r.added.filter((x) => x !== d), removed: wasDefault ? [...new Set([...r.removed, d])].sort() : r.removed });
    const inVault = this.vaultDomains().some((v) => onDomain(d, v));
    return `${d} is read-only for agents again.${inVault ? " Its login is still in the vault, which lets agents act there: say remove the login too if you want that gone." : ""}`;
  }

  describe(): string {
    const r = this.store.siteRules();
    return `Agents may act on ${this.actSites().length} sites (${r.added.length} you added, ${r.removed.length} defaults you removed), plus any site with a vault login. Your additions: ${r.added.join(", ") || "none"}. Removed defaults: ${r.removed.join(", ") || "none"}.`;
  }
}
