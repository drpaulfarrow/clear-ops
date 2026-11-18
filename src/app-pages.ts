/**
 * The web app's pages and files (docs/APP.md): the shell the app runs in, its sign-in page, and the
 * short list of static files it is made of.
 *
 * The app is the first page here that runs script, so its policy is written for that and nothing more:
 * script, styles and fonts from this service only, requests to this service only, no inline script or
 * style, no frames, no form posted anywhere else. The files are fixed at build time (`public/app` and
 * three open-licensed fonts from the npm packages), named in one table, and hold no data: everything
 * the app shows arrives from the signed-in JSON routes.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_AUTH_START_PATH, APP_PATH } from "./app-auth.js";
import { escapeHtml } from "./page-style.js";

export const APP_ASSETS_PATH = `${APP_PATH}/assets`;

export const APP_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self' data:; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/** The project root: one up from src/ when run from source, one up from dist/ when built. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const font = (pkg: string, file: string) => path.join(ROOT, "node_modules", "@fontsource-variable", pkg, "files", file);

/** Every file the app may be served, by the name in its address. Nothing outside this table is read. */
const ASSETS: Record<string, { file: string; type: string }> = {
  "app.css": { file: path.join(ROOT, "public", "app", "app.css"), type: "text/css; charset=utf-8" },
  "app.js": { file: path.join(ROOT, "public", "app", "app.js"), type: "text/javascript; charset=utf-8" },
  "inter.woff2": { file: font("inter", "inter-latin-wght-normal.woff2"), type: "font/woff2" },
  "space-grotesk.woff2": { file: font("space-grotesk", "space-grotesk-latin-wght-normal.woff2"), type: "font/woff2" },
  "jetbrains-mono.woff2": { file: font("jetbrains-mono", "jetbrains-mono-latin-wght-normal.woff2"), type: "font/woff2" },
};

const cache = new Map<string, Buffer>();

/** One of the app's files, or undefined for any other name. Kept in memory once read in production. */
export function appAsset(name: string): { body: Buffer; type: string } | undefined {
  const asset = Object.hasOwn(ASSETS, name) ? ASSETS[name] : undefined;
  if (!asset) return undefined;
  const cached = cache.get(name);
  if (cached) return { body: cached, type: asset.type };
  let body: Buffer;
  try {
    body = fs.readFileSync(asset.file);
  } catch {
    return undefined;
  }
  if (process.env.NODE_ENV === "production") cache.set(name, body);
  return { body, type: asset.type };
}

const head = (title: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">` +
  `<meta name="theme-color" content="#0B0E13"><meta name="color-scheme" content="dark"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>` +
  `<link rel="stylesheet" href="${APP_ASSETS_PATH}/app.css"></head>`;

/** The page the app runs in: an empty frame and one script. Everything else is fetched once signed in. */
export function appShell(): string {
  return `${head("ClearOps")}<body><div id="app"><p class="boot">Loading ClearOps.</p></div><script type="module" src="${APP_ASSETS_PATH}/app.js"></script></body></html>`;
}

const mark = `<div class="mark" aria-hidden="true"><i></i><i></i></div>`;

/** The sign-in page: one button that goes to GitHub, and one plain sentence on who gets in. */
export function appSignInPage(o: { enabled: boolean; login: string; error?: string }): string {
  const body = o.enabled
    ? `<p class="lede">Sign in with the GitHub account <strong>${escapeHtml(o.login)}</strong>. Nobody else gets in.</p>` +
      (o.error ? `<p class="refused" role="alert">${escapeHtml(o.error)}</p>` : "") +
      `<a class="btn primary big" href="${APP_AUTH_START_PATH}">Sign in with GitHub</a>` +
      `<p class="fine">GitHub is asked only who you are. No access to your repositories is requested.</p>`
    : `<p class="lede">The app is not switched on yet.</p><p class="fine">It needs a GitHub OAuth app and two secrets. The steps are in docs/APP.md in the clear-ops repository.</p>`;
  return `${head("Sign in to ClearOps")}<body><main class="signin"><div class="brand">${mark}<span>ClearOps</span></div><h1>Sign in</h1>${body}</main></body></html>`;
}
