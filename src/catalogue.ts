/**
 * The persisted model catalogue: which OpenRouter model each tier (haiku, sonnet, opus, fable) maps
 * to, what those models cost, and which tier each role runs on, kept as JSON on the data volume so a
 * model decision can be applied and reverted at run time, without a pull request or a redeploy.
 *
 * Precedence, the same everywhere:
 *  - a tier's model: the deploy's own variable (OPENROUTER_HAIKU_MODEL and friends), then the
 *    catalogue, then the code default (src/llm.ts);
 *  - a model's price: the deploy's own OPENROUTER_PRICES row, then the catalogue row, then the code
 *    default;
 *  - a role's tier: Paul's own app setting (src/live-settings.ts, the Spend page), then the
 *    catalogue, then the deploy's own CHIEF_MODEL and friends.
 *
 * With no file, or a file that cannot be read, the workforce behaves exactly as it did: the catalogue
 * reads as empty and every chain falls through to what the deploy already says. Nothing here ever
 * touches the executive assistant (it runs on Claude on Anthropic's API directly, whatever this
 * file says), a secret, a cap or a key.
 *
 * What is applied is recorded (role, from, to, when, why, prices, so a price delta can be shown), the
 * log is bounded, and every change can be undone from the file without a deploy (src/model-ops.ts).
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import type { Store } from "./store.js";

/** The tiers the code's aliases stand for (src/llm.ts MODEL_ALIASES, repeated so this file has no import cycle). */
export const CATALOGUE_ALIASES = ["haiku", "sonnet", "opus", "fable"] as const;
export type AliasName = (typeof CATALOGUE_ALIASES)[number];

/** The roles whose model the catalogue may move. The executive assistant is never one. */
export const CATALOGUE_ROLES = ["chief", "worker", "engineer", "maintainer", "designer"] as const;
export type CatalogueRole = (typeof CATALOGUE_ROLES)[number];

/** USD per million tokens, the same shape the SDK's modelPricing takes (src/llm.ts Price). */
export interface PriceRow {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** One applied change, as recorded in the catalogue. A revert restores `from` (and `fromPrice`). */
export interface CatalogueChange {
  /** When it was applied, ISO. */
  at: string;
  /** Who applied it: "chief" (a model_apply tool call). */
  by: string;
  kind: "alias" | "role";
  /** The tier (an alias change) or the role (a role change). */
  target: string;
  from: string;
  to: string;
  /** The recorded reason, in plain words. */
  why: string;
  fromPrice?: PriceRow;
  toPrice?: PriceRow;
  /** True when this entry records a revert rather than a fresh change, so it is never a revert candidate. */
  isRevert?: boolean;
  /** When a later revert undid this change, ISO. */
  reverted?: string;
}

export interface Catalogue {
  version: 1;
  /** A tier's OpenRouter model id, over the code default, under the deploy's own variable. */
  aliases?: Partial<Record<AliasName, string>>;
  /** Price rows for models in use, over the code defaults, under OPENROUTER_PRICES. */
  prices?: Record<string, PriceRow>;
  /** A role's tier, under Paul's own app setting (src/live-settings.ts). */
  roles?: Partial<Record<CatalogueRole, AliasName>>;
  /** Every applied change, newest last, bounded. */
  changes?: CatalogueChange[];
}

/** How many change records are kept. Older ones are dropped, so the file cannot grow without bound. */
export const MAX_CATALOGUE_CHANGES = 30;

export const isAliasName = (v: unknown): v is AliasName => typeof v === "string" && (CATALOGUE_ALIASES as readonly string[]).includes(v);
export const isRoleName = (v: unknown): v is CatalogueRole => typeof v === "string" && (CATALOGUE_ROLES as readonly string[]).includes(v);

export const catalogueFile = (dataDir: string = config.dataDir): string => path.join(dataDir, "model-catalogue.json");

/** A price row as the catalogue keeps it: four finite, non-negative numbers. */
function priceRow(v: unknown): PriceRow | undefined {
  if (!v || typeof v !== "object") return undefined;
  const r = v as Partial<PriceRow>;
  const ok = (["input", "output", "cacheRead", "cacheWrite"] as const).every((k) => typeof r[k] === "number" && Number.isFinite(r[k]!) && r[k]! >= 0 && r[k]! <= 100_000);
  return ok ? { input: r.input!, output: r.output!, cacheRead: r.cacheRead!, cacheWrite: r.cacheWrite! } : undefined;
}

/** What the file holds, with anything malformed dropped rather than trusted. */
function kept(raw: unknown): Catalogue {
  const out: Catalogue = { version: 1 };
  if (!raw || typeof raw !== "object") return out;
  const file = raw as Partial<Catalogue> & Record<string, unknown>;
  if (file.version !== 1) return out;
  if (file.aliases && typeof file.aliases === "object") {
    const aliases: Partial<Record<AliasName, string>> = {};
    for (const [k, v] of Object.entries(file.aliases)) if (isAliasName(k) && typeof v === "string" && v.includes("/")) aliases[k] = v;
    if (Object.keys(aliases).length) out.aliases = aliases;
  }
  if (file.prices && typeof file.prices === "object") {
    const prices: Record<string, PriceRow> = {};
    for (const [id, v] of Object.entries(file.prices as Record<string, unknown>)) {
      const row = priceRow(v);
      if (row && id.includes("/")) prices[id] = row;
    }
    if (Object.keys(prices).length) out.prices = prices;
  }
  if (file.roles && typeof file.roles === "object") {
    const roles: Partial<Record<CatalogueRole, AliasName>> = {};
    for (const [k, v] of Object.entries(file.roles)) if (isRoleName(k) && isAliasName(v)) roles[k] = v;
    if (Object.keys(roles).length) out.roles = roles;
  }
  if (Array.isArray(file.changes)) {
    const changes = file.changes.filter(
      (c): c is CatalogueChange =>
        !!c && typeof c === "object" && typeof (c as CatalogueChange).at === "string" && (c as CatalogueChange).at !== "" &&
        ((c as CatalogueChange).kind === "alias" || (c as CatalogueChange).kind === "role") &&
        typeof (c as CatalogueChange).target === "string" && typeof (c as CatalogueChange).from === "string" && typeof (c as CatalogueChange).to === "string" && typeof (c as CatalogueChange).why === "string" && (c as CatalogueChange).why !== "",
    );
    if (changes.length) out.changes = changes.slice(-MAX_CATALOGUE_CHANGES);
  }
  return out;
}

/** The read cache, by directory, invalidated by the file's own modification time. */
const cache = new Map<string, { mtimeMs: number; size: number; catalogue: Catalogue }>();

/**
 * The catalogue as it stands. A file that is missing reads as empty (the deploy's own behaviour); a
 * file that cannot be parsed reads as empty too and is reported once, so a corrupt file can never
 * stop the workforce, only cost it the decisions it held.
 */
export function readCatalogue(dataDir: string = config.dataDir, warn: (m: string) => void = () => undefined): Catalogue {
  const file = catalogueFile(dataDir);
  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(file);
  } catch {
    cache.delete(dataDir);
    return { version: 1 };
  }
  const held = cache.get(dataDir);
  if (held && held.mtimeMs === stat.mtimeMs && held.size === stat.size) return held.catalogue;
  let catalogue: Catalogue;
  try {
    catalogue = kept(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    warn(`model-catalogue.json could not be read; the deploy's own models are in force.`);
    catalogue = { version: 1 };
  }
  cache.set(dataDir, { mtimeMs: stat.mtimeMs, size: stat.size, catalogue });
  return catalogue;
}

/** Writes the catalogue, whole, and keeps the read cache truthful. */
export function writeCatalogue(dataDir: string, catalogue: Catalogue): void {
  const file = catalogueFile(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = `${JSON.stringify(catalogue, null, 2)}\n`;
  fs.writeFileSync(file, body);
  let mtimeMs = 0;
  let size = body.length;
  try {
    const stat = fs.statSync(file);
    mtimeMs = stat.mtimeMs;
    size = stat.size;
  } catch {
    // The write above succeeded; only the cache refresh needs the stat.
  }
  // The cache holds the validated copy, the same shape a later read of the file would produce.
  cache.set(dataDir, { mtimeMs, size, catalogue: kept(catalogue) });
}

/** Records one applied change, trimming the log to its bound. */
export function recordChange(dataDir: string, entry: CatalogueChange): Catalogue {
  const catalogue = readCatalogue(dataDir);
  catalogue.changes = [...(catalogue.changes ?? []), entry].slice(-MAX_CATALOGUE_CHANGES);
  writeCatalogue(dataDir, catalogue);
  return catalogue;
}

/**
 * What `config` held for each role before anything here touched it: the deploy's own values, read
 * once at start-up so the overlay can be re-run as often as it likes and always lands somewhere
 * well-defined.
 */
const deployedRoles: Record<CatalogueRole, string> = {
  chief: config.models.chief,
  worker: config.models.worker,
  engineer: config.models.engineer,
  maintainer: config.models.maintainer,
  designer: config.design.model,
};

/** The role's own app setting (src/live-settings.ts), which always outranks the catalogue. */
function appSet(store: Pick<Store, "settings">, role: CatalogueRole): boolean {
  const models = store.settings().live?.models;
  return role !== "designer" && models?.[role] !== undefined;
}

/**
 * Lays the catalogue's role tiers over `config`, under Paul's own app setting. Call at start-up
 * (after `applyLive`), after every applied change and after every app setting change, and the rest of
 * the service goes on reading `config` exactly as before (the same trick as src/live-settings.ts).
 * A role the catalogue does not mention is put back to the deploy's own tier, so this is idempotent.
 */
export function applyCatalogueRoles(store: Pick<Store, "settings">, dataDir: string = config.dataDir): void {
  const roles = readCatalogue(dataDir).roles ?? {};
  for (const role of CATALOGUE_ROLES) {
    if (appSet(store, role)) continue;
    const value = roles[role] ?? deployedRoles[role];
    if (role === "designer") config.design.model = value;
    else config.models[role as Exclude<CatalogueRole, "designer">] = value;
  }
}
