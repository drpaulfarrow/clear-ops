/**
 * The house style for the service's own browser pages: the vault's one-time login and card pages and
 * what they say back afterwards. Paul's call, 13 Nov 2026: calm, editorial, built for a phone, in the
 * spirit of the page he sent (a warm off-white page, one narrow centred column, a rounded icon above a
 * serif heading, generously rounded fields, one full-width button at the bottom). Nothing from that
 * page's product is used here: no name, wordmark, logo, icon or exact colour, and none of its words.
 *
 * Everything is inline and nothing is fetched. The pages these serve are sent with
 * `default-src 'none'; style-src 'unsafe-inline'`, so the stylesheet is one `<style>` element, the
 * icons are inline SVG in the document itself, and there is no script, font, image or CDN reference
 * anywhere. A page renders identically with JavaScript switched off.
 *
 * Two things this module never does: it echoes nothing but what a caller passes it, and it never sees a
 * secret (a password or a card number is never passed in and never rendered). `text` and `foot` are
 * plain words and are escaped here; `body` is markup the caller has already escaped.
 */

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The icon in the tile above the heading: a padlock, a card, a tick or a warning. */
export type PageIcon = "lock" | "card" | "tick" | "alert";

const icon = (paths: string, size = 26): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

const PADLOCK = `<path d="M7.5 10.5V8a4.5 4.5 0 0 1 9 0v2.5"/><rect x="4.8" y="10.5" width="14.4" height="9.7" rx="2.6"/><path d="M12 14.2v2.2"/>`;

const ICONS: Record<PageIcon, string> = {
  lock: icon(PADLOCK),
  card: icon(`<rect x="3" y="5.8" width="18" height="12.4" rx="2.6"/><path d="M3 10.2h18"/><path d="M6.6 14.6h3.4"/>`),
  tick: icon(`<circle cx="12" cy="12" r="9"/><path d="M8.1 12.3l2.7 2.7 5.1-5.6"/>`),
  alert: icon(`<circle cx="12" cy="12" r="9"/><path d="M12 7.4v5.4"/><path d="M12 16.3v.1"/>`),
};

/** The small padlock beside a password label. */
const MINOR_PADLOCK = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PADLOCK}</svg>`;

/**
 * One stylesheet for every page: warm off-white, one narrow column, a system serif for the heading and
 * the system sans for everything else, generous tap targets, and nothing that needs a network round
 * trip. Phone first: the column is one full width on a phone and centres in a narrow measure above it.
 */
const STYLE = `:root{--bg:#faf7f2;--card:#fff;--ink:#221e1a;--muted:#6e665e;--line:#e8e0d5;--tile:#f2ece2;--accent:#33443c;--accent-ink:#fbfaf8}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:1rem;line-height:1.5}
main{max-width:26rem;margin:0 auto;padding:2.5rem 1.25rem 4rem}
.tile{width:56px;height:56px;border-radius:16px;background:var(--tile);color:#4a423a;display:flex;align-items:center;justify-content:center;margin:0 auto 1.3rem}
.tile.ok{background:#e8efe9;color:var(--accent)}
.tile.alert{background:#f7eddd;color:#8a5a20}
h1{font-family:ui-serif,"Iowan Old Style","Palatino Linotype",Palatino,Georgia,"Times New Roman",serif;font-weight:500;font-size:1.75rem;line-height:1.2;letter-spacing:-.01em;text-align:center;margin:0}
.chip{display:block;width:fit-content;max-width:100%;margin:.75rem auto 0;background:var(--tile);color:#4a423a;font-size:.85rem;font-weight:500;padding:.3rem .7rem;border-radius:9px;overflow-wrap:anywhere}
.text{color:var(--muted);font-size:.95rem;text-align:center;margin:.9rem 0 0;overflow-wrap:anywhere}
form{margin-top:2.1rem}
label{display:block;font-size:.85rem;font-weight:500;color:#4a423a;margin:1.15rem 0 .4rem}
label:first-of-type{margin-top:0}
label .lock{display:inline-block;vertical-align:-2px;margin-right:.4rem}
input{display:block;width:100%;font:inherit;font-size:1rem;color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:12px;padding:.85rem .9rem;-webkit-appearance:none;appearance:none}
input::placeholder{color:#a9a096}
input:focus{outline:none;border-color:#b3a99b;box-shadow:0 0 0 3px rgba(51,68,60,.18)}
button{display:block;width:100%;font:inherit;font-size:1rem;font-weight:600;color:var(--accent-ink);background:var(--accent);border:0;border-radius:12px;padding:1.05rem;margin-top:2.1rem;cursor:pointer}
button:hover{background:#2b3933}
.hint{color:var(--muted);font-size:.85rem;margin:.55rem 0 0}
.foot{color:var(--muted);font-size:.85rem;text-align:center;margin:1.5rem 0 0}
@media (min-width:30rem){main{padding-top:4rem}h1{font-size:1.9rem}}`;

export interface PageOptions {
  /** The document title; the heading too, unless `heading` says otherwise. */
  title: string;
  heading?: string;
  /** The icon in the rounded tile above the heading. Nothing is drawn without one. */
  icon?: PageIcon;
  /** The tile's tone: quiet by default, `ok` for a confirmation, `alert` for a refusal or an expiry. */
  tone?: "ok" | "alert";
  /** A small chip under the heading: usually the site a login belongs to. */
  chip?: string;
  /** A sentence of plain words under the heading. Escaped here. */
  text?: string;
  /** The page's own markup (a form, a list). The caller escapes everything in it. */
  body?: string;
  /** A quiet closing line, such as "You can close this tab." Escaped here. */
  foot?: string;
}

/** One page: icon, heading, optional chip and sentence, the caller's markup, a quiet closing line. */
export function htmlPage(o: PageOptions): string {
  const heading = o.heading ?? o.title;
  const tile = o.icon ? `<div class="tile${o.tone ? ` ${o.tone}` : ""}">${ICONS[o.icon]}</div>` : "";
  const chip = o.chip ? `<span class="chip">${escapeHtml(o.chip)}</span>` : "";
  const text = o.text ? `<p class="text">${escapeHtml(o.text)}</p>` : "";
  const foot = o.foot ? `<p class="foot">${escapeHtml(o.foot)}</p>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(o.title)}</title><style>${STYLE}</style></head><body><main>${tile}<h1>${escapeHtml(heading)}</h1>${chip}${text}${o.body ?? ""}${foot}</main></body></html>`;
}

export interface FieldOptions {
  /** The words above the field. Escaped here. */
  label: string;
  /** The form field's name, which is also its id. */
  name: string;
  type?: string;
  /** A value to fill in, such as the site the link already names. Escaped here. */
  value?: string;
  placeholder?: string;
  required?: boolean;
  /** Any further attributes, as markup (autocomplete, inputmode). The caller escapes anything in them. */
  attrs?: string;
  /** The small padlock beside the label, as the password field has. */
  lock?: boolean;
  /** One quiet line under the field. Escaped here. */
  hint?: string;
}

/** A labelled field: the label above, one generously rounded input below. */
export function field(o: FieldOptions): string {
  const attrs = [
    o.required ? "required" : "",
    o.placeholder ? `placeholder="${escapeHtml(o.placeholder)}"` : "",
    o.value ? `value="${escapeHtml(o.value)}"` : "",
    o.attrs ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  const lock = o.lock ? `<span class="lock">${MINOR_PADLOCK}</span>` : "";
  const hint = o.hint ? `<p class="hint">${escapeHtml(o.hint)}</p>` : "";
  return `<label for="f-${o.name}">${lock}${escapeHtml(o.label)}</label><input id="f-${o.name}" name="${o.name}" type="${o.type ?? "text"}" ${attrs}>${hint}`;
}

/** A page with nothing but a heading and a sentence: a one-time link that was used, wrong or expired. */
export function expiredPage(text: string, foot?: string): string {
  return htmlPage({ title: "Link expired", heading: "Link expired", icon: "alert", tone: "alert", text, foot });
}
