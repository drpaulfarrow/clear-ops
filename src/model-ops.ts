/**
 * The model decisions themselves: reading OpenRouter's public model list, the checks a model must
 * pass before the workforce runs on it, applying and reverting a catalogue change at run time, the
 * chief's view of the catalogue, and the once-a-day check.
 *
 * What is read is public: GET https://openrouter.ai/api/v1/models, no key, no other endpoint. It
 * says what a model costs (per-token strings, USD), whether it supports tools (its
 * supported_parameters) and how much context it takes. It says nothing about how well a model
 * works, and this file never invents that: a recommendation is price, tool support and context
 * length only, and every report and message says so plainly.
 *
 * The daily check never changes a model. It verifies every model in force, writes a report of
 * offers and better-value alternatives per role with its reasoning, and messages Paul only when it
 * recommends a change or a model has gone missing. Applying is the chief's decision (model_apply,
 * src/orchestrator.ts), recorded in the catalogue with its reason (src/catalogue.ts), and every
 * change can be undone without a deploy.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { MODEL_ALIASES, OPENROUTER_BASE_URL, modelPrices, openrouterModels, provider, type ModelAlias } from "./llm.js";
import { applyCatalogueRoles, CATALOGUE_ROLES, isAliasName, isRoleName, MAX_CATALOGUE_CHANGES, readCatalogue, recordChange, writeCatalogue, type Catalogue, type CatalogueChange, type CatalogueRole, type PriceRow } from "./catalogue.js";
import { londonYmd } from "./london.js";
import type { Store } from "./store.js";

/** The public model list. No credential is sent: the endpoint needs none. */
export const MODELS_URL = `${OPENROUTER_BASE_URL}/v1/models`;
/** How long one read of the model list may take. */
export const MODELS_TIMEOUT_MS = 15_000;
/** How often the service looks whether the daily check is due. */
export const MODEL_WATCH_TICK_MS = 30 * 60_000;
/** A change is recommended only when the alternative is this much cheaper on both input and output. */
export const RECOMMEND_FRACTION = 0.2;

/** A refusal in plain words: the model was not changed. */
export class ModelCheckError extends Error {}

/** One model as OpenRouter's public list describes it. Prices are USD per million tokens. */
export interface LiveModel {
  id: string;
  name: string;
  contextLength?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  tools: boolean;
}

export interface LiveModelsOptions {
  fetch?: typeof fetch;
  url?: string;
  timeoutMs?: number;
}

/** OpenRouter's public model list, parsed to what this file needs. Throws plain-word errors. */
export async function fetchLiveModels(options: LiveModelsOptions = {}): Promise<LiveModel[]> {
  const url = options.url ?? MODELS_URL;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? MODELS_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { method: "GET", headers: { Accept: "application/json" }, signal: controller.signal });
    if (!res.ok) throw new ModelCheckError(`OpenRouter returned ${res.status} on its model list.`);
    const body = (await res.json()) as { data?: unknown };
    if (!Array.isArray(body?.data)) throw new ModelCheckError("OpenRouter's model list reply was not a list.");
    return body.data.flatMap((raw): LiveModel[] => {
      if (!raw || typeof raw !== "object") return [];
      const m = raw as Record<string, unknown>;
      if (typeof m.id !== "string" || !m.id.includes("/")) return [];
      const params = Array.isArray(m.supported_parameters) ? m.supported_parameters.filter((p): p is string => typeof p === "string") : [];
      const pricing = m.pricing && typeof m.pricing === "object" ? (m.pricing as Record<string, unknown>) : {};
      // Per-token strings become USD per million tokens, kept exact where the provider's own figure is
      // exact and nudged up (by a millionth) where it is not, so a cap never runs late.
      const perM = (v: unknown): number | undefined => {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) return undefined;
        const exact = n * 1_000_000;
        const rounded = Math.round(exact * 1_000_000) / 1_000_000;
        return rounded < exact ? rounded + 1e-6 : rounded;
      };
      const input = perM(pricing.prompt);
      const output = perM(pricing.completion);
      return [
        {
          id: m.id,
          name: typeof m.name === "string" ? m.name : m.id,
          ...(typeof m.context_length === "number" && m.context_length > 0 ? { contextLength: m.context_length } : {}),
          ...(input !== undefined ? { input } : {}),
          ...(output !== undefined ? { output } : {}),
          ...(perM(pricing.cache_read) !== undefined ? { cacheRead: perM(pricing.cache_read) } : {}),
          ...(perM(pricing.cache_write) !== undefined ? { cacheWrite: perM(pricing.cache_write) } : {}),
          tools: params.includes("tools"),
        },
      ];
    });
  } catch (err) {
    if (err instanceof ModelCheckError) throw err;
    throw new ModelCheckError(`OpenRouter's model list could not be read (${err instanceof Error ? err.message : String(err)}).`);
  } finally {
    clearTimeout(timer);
  }
}

/** What the workforce needs of a model: exists, tool-capable, priced. Anything else is a refusal. */
export type LiveCheck = { ok: true; model: LiveModel } | { ok: false; reason: string };

export function liveCheck(list: LiveModel[], id: string): LiveCheck {
  const found = list.find((m) => m.id === id);
  if (!found) return { ok: false, reason: `"${id}" is not on OpenRouter's model list.` };
  if (!found.tools) return { ok: false, reason: `"${id}" does not support tools on OpenRouter, so the workforce cannot run on it.` };
  if (found.input === undefined || found.output === undefined) return { ok: false, reason: `"${id}" carries no readable price on OpenRouter.` };
  return { ok: true, model: found };
}

/** A catalogue price row from a live model, with unknown cache prices assumed to cost as much as input. */
export function priceRow(m: LiveModel): PriceRow {
  const input = m.input ?? 0;
  const output = m.output ?? 0;
  return { input, output, cacheRead: m.cacheRead ?? input, cacheWrite: m.cacheWrite ?? input };
}

/** The price row in force for a model id, whatever set it (defaults, the catalogue, OPENROUTER_PRICES). */
export function currentPrice(id: string): PriceRow | undefined {
  return modelPrices()[id];
}

export interface ModelOpsDeps {
  store?: Pick<Store, "settings">;
  dataDir?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Who applied the change, recorded with it. */
  by?: string;
}

const clone = (cat: Catalogue): Catalogue => JSON.parse(JSON.stringify(cat)) as Catalogue;

function roleTier(role: CatalogueRole): string {
  return role === "designer" ? config.design.model : config.models[role];
}

/** Paul's own app setting outranks the catalogue (src/live-settings.ts), so it cannot be moved from here. */
function appPinned(deps: ModelOpsDeps, role: CatalogueRole): boolean {
  return deps.store?.settings().live?.models?.[role as "chief" | "worker" | "engineer" | "maintainer"] !== undefined;
}

/**
 * Applies one model decision, after checking it against OpenRouter's live list, and records it.
 * Either a tier and a model (what the tier maps to), or a role and a tier (which tier the role runs
 * on). Throws ModelCheckError with the plain reason and changes nothing when the check fails.
 */
export async function applyModelChange(deps: ModelOpsDeps, change: { alias?: string; model?: string; role?: string; to?: string; why?: string }): Promise<string> {
  const why = (change.why ?? "").trim();
  if (!why) throw new ModelCheckError("A model change needs a reason, recorded with the change; say why in `why`.");
  const dir = deps.dataDir ?? config.dataDir;
  const at = (deps.now ?? (() => new Date()))().toISOString();
  const by = deps.by ?? "chief";

  if (change.alias !== undefined && change.model !== undefined && change.role === undefined) {
    const alias = change.alias as ModelAlias;
    if (!isAliasName(alias)) throw new ModelCheckError(`"${change.alias}" is not one of the tiers (${MODEL_ALIASES.join(", ")}).`);
    const model = change.model.trim();
    if (config.openrouter.models[alias]) throw new ModelCheckError(`OPENROUTER_${alias.toUpperCase()}_MODEL is set in the deploy, so the catalogue cannot change that tier.`);
    const list = await fetchLiveModels({ fetch: deps.fetch });
    const checked = liveCheck(list, model);
    if (!checked.ok) throw new ModelCheckError(checked.reason);
    const from = openrouterModels()[alias];
    const fromPrice = currentPrice(from);
    const toPrice = priceRow(checked.model);
    const catalogue = clone(readCatalogue(dir));
    catalogue.aliases = { ...(catalogue.aliases ?? {}), [alias]: model };
    catalogue.prices = { ...(catalogue.prices ?? {}), [model]: toPrice };
    writeCatalogue(dir, catalogue);
    recordChange(dir, { at, by, kind: "alias", target: alias, from, to: model, why, ...(fromPrice ? { fromPrice } : {}), toPrice });
    deps.store && applyCatalogueRoles(deps.store, dir);
    const delta =
      fromPrice && fromPrice.input > 0 && fromPrice.output > 0
        ? ` ${Math.round((1 - toPrice.input / fromPrice.input) * 100)}% less in and ${Math.round((1 - toPrice.output / fromPrice.output) * 100)}% less out.`
        : "";
    const was = fromPrice ? `, was ${from} at $${fromPrice.input.toFixed(2)}/M in and $${fromPrice.output.toFixed(2)}/M out.${delta}` : `, was ${from}.`;
    return `The ${alias} tier now runs on ${model} at $${toPrice.input.toFixed(2)}/M in and $${toPrice.output.toFixed(2)}/M out${was} Recorded: "${why}". It applies to the next run, not to one already going.`;
  }

  if (change.role !== undefined && change.to !== undefined && change.alias === undefined) {
    const role = change.role as CatalogueRole;
    if (!isRoleName(role)) throw new ModelCheckError(`"${change.role}" is not a role the catalogue covers (${CATALOGUE_ROLES.join(", ")}; the executive assistant is never changed here).`);
    const to = change.to as ModelAlias;
    if (!isAliasName(to)) throw new ModelCheckError(`"${change.to}" is not one of the tiers (${MODEL_ALIASES.join(", ")}).`);
    if (appPinned(deps, role)) throw new ModelCheckError(`Paul has set the ${role}'s model himself in the web app's Spend page, so the catalogue cannot change it here.`);
    const from = roleTier(role);
    const catalogue = clone(readCatalogue(dir));
    catalogue.roles = { ...(catalogue.roles ?? {}), [role]: to };
    writeCatalogue(dir, catalogue);
    recordChange(dir, { at, by, kind: "role", target: role, from, to, why });
    deps.store && applyCatalogueRoles(deps.store, dir);
    return `${role} now runs on the ${to} tier (${openrouterModels()[to]}). Recorded: "${why}". It applies to the next run, not to one already going.`;
  }

  throw new ModelCheckError("Give either a tier and a model, or a role and a tier.");
}

/** How much cheaper one price row is than another, in plain words, or "" when either is unknown. */
function cheaperPercent(from: PriceRow | undefined, to: PriceRow | undefined): string {
  if (!from || !to || from.input <= 0 || from.output <= 0) return "";
  const inPct = Math.round((1 - to.input / from.input) * 100);
  const outPct = Math.round((1 - to.output / from.output) * 100);
  return inPct <= 0 || outPct <= 0 ? "" : ` at least ${Math.min(inPct, outPct)}% cheaper on both`;
}

/**
 * Undoes the most recent applied change (or the most recent one for a tier or a role): restores what
 * it ran on before, including the price row, without a deploy. The revert itself is recorded.
 */
export async function revertModelChange(deps: ModelOpsDeps, which: { alias?: string; role?: string } = {}): Promise<string> {
  const dir = deps.dataDir ?? config.dataDir;
  const at = (deps.now ?? (() => new Date()))().toISOString();
  const catalogue = clone(readCatalogue(dir));
  const target = which.alias ?? which.role;
  const candidates = (catalogue.changes ?? []).filter((c) => !c.isRevert && !c.reverted && (target === undefined || c.target === target));
  const entry = candidates.at(-1) as CatalogueChange | undefined;
  if (!entry) throw new ModelCheckError(`There is no model change to revert${target !== undefined ? ` for ${target}` : ""}.`);

  if (entry.kind === "alias") {
    const alias = entry.target as ModelAlias;
    if (config.openrouter.models[alias]) throw new ModelCheckError(`OPENROUTER_${alias.toUpperCase()}_MODEL is set in the deploy, so the catalogue cannot change that tier.`);
    catalogue.aliases = { ...(catalogue.aliases ?? {}), [alias]: entry.from };
    if (entry.fromPrice) catalogue.prices = { ...(catalogue.prices ?? {}), [entry.from]: entry.fromPrice };
  } else {
    const role = entry.target as CatalogueRole;
    if (!isAliasName(entry.from)) throw new ModelCheckError(`The recorded tier for ${role} cannot be restored; set it again with model_apply.`);
    if (appPinned(deps, role)) throw new ModelCheckError(`Paul has set the ${role}'s model himself in the web app's Spend page, so the catalogue cannot change it here.`);
    catalogue.roles = { ...(catalogue.roles ?? {}), [role]: entry.from };
  }
  entry.reverted = at;
  catalogue.changes = [...(catalogue.changes ?? []), { at, by: deps.by ?? "chief", kind: entry.kind, target: entry.target, from: entry.to, to: entry.from, why: `Reverted: ${entry.why}`, ...(entry.toPrice ? { fromPrice: entry.toPrice } : {}), ...(entry.fromPrice ? { toPrice: entry.fromPrice } : {}), isRevert: true }].slice(-MAX_CATALOGUE_CHANGES);
  writeCatalogue(dir, catalogue);
  deps.store && applyCatalogueRoles(deps.store, dir);
  const what = entry.kind === "alias" ? `The ${entry.target} tier` : `${entry.target}`;
  const price = entry.kind === "alias" ? cheaperPercent(entry.toPrice, entry.fromPrice) : "";
  return `${what} is back on ${entry.from} (${entry.to} before${price}). Reverted: "${entry.why}". It applies to the next run, not to one already going.`;
}

const ROLE_LABELS: Record<CatalogueRole, string> = { chief: "chief", worker: "workers", engineer: "engineers", maintainer: "maintainer", designer: "designer" };

/** The catalogue as the chief reads it: what every role runs on, what it costs, and the recent changes. */
export function catalogueView(store?: Pick<Store, "settings">): string {
  const lines: string[] = [];
  if (provider() !== "openrouter") {
    lines.push(`Provider: Anthropic's API; the OpenRouter catalogue is not in force. The executive assistant runs on ${config.models.ea}.`);
    return lines.join("\n");
  }
  const cat = readCatalogue();
  const prices = modelPrices();
  const models = openrouterModels();
  lines.push(`Provider: OpenRouter. Tiers (the deploy's own variable, then the catalogue, then the code default):`);
  for (const alias of MODEL_ALIASES) {
    const model = models[alias];
    const source = config.openrouter.models[alias] ? "the deploy's own OPENROUTER_" + alias.toUpperCase() + "_MODEL" : cat.aliases?.[alias] ? "the catalogue" : "the code default";
    const p = prices[model];
    lines.push(`- ${alias} → ${model} (${p ? `$${p.input.toFixed(2)}/M in, $${p.output.toFixed(2)}/M out` : "no price row: caps would be a guess"}) — ${source}.`);
  }
  lines.push(`Roles (Paul's own app setting, then the catalogue, then the deploy's own variable):`);
  for (const role of CATALOGUE_ROLES) {
    const tier = roleTier(role);
    const appSet = store?.settings().live?.models?.[role as "chief" | "worker" | "engineer" | "maintainer"];
    const source = appSet ? "Paul's own app setting" : cat.roles?.[role] ? "the catalogue" : "the deploy's own variable";
    const model = isAliasName(tier) ? models[tier] : tier;
    const p = prices[model];
    lines.push(`- ${ROLE_LABELS[role]}: ${tier} → ${model}${p ? ` ($${p.input.toFixed(2)}/M in, $${p.output.toFixed(2)}/M out)` : ""} — ${source}.`);
  }
  const changes = cat.changes ?? [];
  if (changes.length) {
    lines.push(`Recorded changes, newest last:`);
    for (const c of changes.slice(-10)) {
      const price = c.toPrice && c.fromPrice ? ` ($${c.fromPrice.input.toFixed(2)}/${c.fromPrice.output.toFixed(2)} → $${c.toPrice.input.toFixed(2)}/${c.toPrice.output.toFixed(2)})` : "";
      lines.push(`- ${c.at} ${c.kind} ${c.target}: ${c.from} → ${c.to}${price} — "${c.why}"${c.reverted ? ` (reverted ${c.reverted})` : ""}`);
    }
  } else lines.push(`No model change has been applied from the catalogue.`);
  lines.push(`The executive assistant runs on ${config.models.ea} on Anthropic's API directly and is never changed here.`);
  return lines.join("\n");
}

export interface ModelWatchOptions {
  store?: Pick<Store, "settings" | "setSetting">;
  dataDir?: string;
  fetch?: typeof fetch;
  url?: string;
  timeoutMs?: number;
  now?: () => Date;
  /** The London hour the check runs at, past which it is due. Defaults to config.modelCheck.hour. */
  hour?: number;
  intervalMs?: number;
  messenger?: { send: (to: string, text: string) => Promise<unknown> };
  /** Paul's chat address, the one the check messages when it recommends a change. */
  to?: string;
  warn?: (m: string) => void;
}

export interface ModelCheckOutcome {
  ran: boolean;
  /** True when the report recommends at least one change. */
  recommend: boolean;
  /** True when a model in force failed its check. */
  flagged: boolean;
  reportPath?: string;
  summary: string;
}

/** The London hour of an instant, 0-23. */
function londonHour(at: Date): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "numeric", hour12: false }).format(at));
}

/** What one tier's check found. */
interface TierVerdict {
  alias: ModelAlias;
  model: string;
  check: LiveCheck;
  price?: PriceRow;
  /** Tool-capable models at least RECOMMEND_FRACTION cheaper on both axes, context no smaller. */
  alternatives: LiveModel[];
}

function verdicts(list: LiveModel[]): TierVerdict[] {
  return MODEL_ALIASES.map((alias) => {
    const model = openrouterModels()[alias];
    const check = liveCheck(list, model);
    const price = check.ok ? priceRow(check.model) : currentPrice(model);
    const alternatives =
      check.ok && price && price.input > 0 && price.output > 0
        ? list
            .filter((m) => m.tools && m.input !== undefined && m.output !== undefined && m.input <= price.input * (1 - RECOMMEND_FRACTION) && m.output <= price.output * (1 - RECOMMEND_FRACTION) && (m.contextLength === undefined || check.model.contextLength === undefined || m.contextLength >= check.model.contextLength) && m.id !== model)
            .sort((a, b) => (a.output! - b.output!) || (a.input! - b.input!))
        : [];
    return { alias, model, check, price, alternatives };
  });
}

const priceWords = (p: PriceRow) => `$${p.input.toFixed(2)}/M in and $${p.output.toFixed(2)}/M out`;

/**
 * The daily check: verifies every model in force, writes the report of offers and better-value
 * alternatives per role with its recommendation and reasoning, and messages Paul only when there is
 * one. No model is changed here, ever; applying stays the chief's recorded decision.
 */
export class ModelWatch {
  private timer?: NodeJS.Timeout;
  private readonly warn: (m: string) => void;

  /**
   * The cheapest tier in use, which is the one bought on price. A stronger tier is bought for
   * strength, and OpenRouter's public list cannot measure that, so the check reports its cheaper
   * alternatives but recommends only for the cheapest tier, and never nags to trade a strong tier
   * down on price alone.
   */
  private cheapestTier(tiers: TierVerdict[]): TierVerdict | undefined {
    const priced = tiers.filter((t) => t.price && t.price.input > 0);
    return priced.sort((a, b) => a.price!.output - b.price!.output)[0];
  }

  constructor(private readonly opts: ModelWatchOptions = {}) {
    this.warn = opts.warn ?? ((m) => console.warn(`model-check: ${m}`));
  }

  /** True when today's check has not run and the London hour has passed. */
  due(at: Date = new Date((this.opts.now ?? (() => new Date()))())): boolean {
    if (!config.modelCheck.enabled) return false;
    if (provider() !== "openrouter") return false;
    const ymd = londonYmd(at);
    if (this.opts.store?.settings().modelWatch?.ymd === ymd) return false;
    return londonHour(at) >= (this.opts.hour ?? config.modelCheck.hour);
  }

  /** Runs the check when it is due (or always with force). Never throws. */
  async run(force = false): Promise<ModelCheckOutcome> {
    const at = new Date((this.opts.now ?? (() => new Date()))());
    if (!force && !this.due(at)) return { ran: false, recommend: false, flagged: false, summary: "not due" };
    let list: LiveModel[];
    try {
      list = await fetchLiveModels({ fetch: this.opts.fetch, url: this.opts.url, timeoutMs: this.opts.timeoutMs });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.warn(`${reason} The check will try again later; nothing was changed.`);
      return { ran: false, recommend: false, flagged: false, summary: reason };
    }
    const today = londonYmd(at);
    const tiers = verdicts(list);
    const byAlias = new Map(tiers.map((t) => [t.alias, t]));
    const cheapest = this.cheapestTier(tiers);
    const recommend = (cheapest?.alternatives.length ?? 0) > 0;
    const flagged = tiers.some((t) => !t.check.ok);
    const report = this.report(today, at, tiers, byAlias, cheapest, list);
    const dir = this.opts.dataDir ?? config.dataDir;
    const reportDir = path.join(dir, "model-watch");
    fs.mkdirSync(reportDir, { recursive: true });
    const reportPath = path.join(reportDir, `${today}.md`);
    fs.writeFileSync(reportPath, report);
    this.opts.store?.setSetting("modelWatch", { ymd: today, at: at.toISOString() });
    if ((recommend || flagged) && this.opts.messenger && this.opts.to) {
      const text = this.message(today, tiers, cheapest, reportPath);
      await this.opts.messenger.send(this.opts.to, text).catch((err) => this.warn(`Paul could not be told (${err instanceof Error ? err.message : String(err)}).`));
    }
    return {
      ran: true,
      recommend,
      flagged,
      reportPath,
      summary: recommend ? "recommends a change" : flagged ? "a model failed its check" : "all models verified, nothing to recommend",
    };
  }

  /** The report, one file per London day, with the plain statement of what OpenRouter's list does not say. */
  private report(today: string, at: Date, tiers: TierVerdict[], byAlias: Map<ModelAlias, TierVerdict>, cheapest: TierVerdict | undefined, list: LiveModel[]): string {
    const lines: string[] = [];
    lines.push(`# Model check — ${today}`);
    lines.push("");
    lines.push(`Prices are USD per million tokens, read from OpenRouter's public model list (${MODELS_URL}) at ${at.toISOString()}. It states each model's price, whether it supports tools and its context length. OpenRouter's public model list carries no performance or quality measure, so nothing here ranks models by how well they work: a recommendation is price, tool support and context length only, and how good a model actually is stays Paul's and the chief's judgement.`);
    lines.push("");
    lines.push(`## Roles`);
    for (const role of CATALOGUE_ROLES) {
      const tier = roleTier(role);
      const v = isAliasName(tier) ? byAlias.get(tier as ModelAlias) : undefined;
      const model = isAliasName(tier) ? v?.model ?? openrouterModels()[tier] : tier;
      const own = !isAliasName(tier) ? liveCheck(list, tier) : undefined;
      const check = v ? v.check : own!;
      const price = v?.price ?? currentPrice(model);
      const head = price ? ` — verified: tools, ${priceWords(price)}` : "";
      const bad = !check.ok ? ` — NOT VERIFIED: ${check.reason}` : "";
      lines.push(`- ${ROLE_LABELS[role]}: ${tier} → ${model}${bad || head}${v?.check.ok && v.alternatives.length ? `.` : ``}`);
      if (v?.check.ok && v.alternatives.length) {
        const best = v.alternatives[0]!;
        const bp = priceRow(best);
        const context = best.contextLength !== undefined && v.check.model.contextLength !== undefined ? `, context ${best.contextLength} ≥ ${v.check.model.contextLength}` : "";
        if (cheapest?.alias === v.alias) {
          lines.push(`  Better value: ${best.id} at ${priceWords(bp)}${context}, tool-capable, at least 20% cheaper on both input and output. RECOMMENDED for the ${v.alias} tier.`);
        } else {
          lines.push(`  Cheaper on price alone: ${best.id} at ${priceWords(bp)}${context}, tool-capable. Listed, not recommended: this tier is bought for strength, which the list cannot measure.`);
        }
      } else if (v?.check.ok) {
        lines.push(`  No cheaper tool-capable alternative today.`);
      }
    }
    lines.push("");
    lines.push(`## Offers — the cheapest tool-capable models on the list today (price only; the list carries no performance or quality measure)`);
    for (const m of list.filter((m) => m.tools && m.input !== undefined && m.output !== undefined).sort((a, b) => a.output! - b.output! || a.input! - b.input!).slice(0, 8)) {
      lines.push(`- ${m.id} — $${m.input!.toFixed(2)}/M in, $${m.output!.toFixed(2)}/M out${m.contextLength !== undefined ? `, context ${m.contextLength}` : ""}`);
    }
    const changes = readCatalogue(this.opts.dataDir).changes ?? [];
    if (changes.length) {
      lines.push("");
      lines.push(`## The catalogue's own record (newest last)`);
      for (const c of changes.slice(-10)) lines.push(`- ${c.at} ${c.kind} ${c.target}: ${c.from} → ${c.to} — "${c.why}"${c.reverted ? ` (reverted ${c.reverted})` : ""}`);
    }
    lines.push("");
    lines.push(`Nothing was changed by this check. Applying a change is the chief's recorded decision (model_apply), which Paul can undo with model_revert.`);
    return `${lines.join("\n")}\n`;
  }

  /** What Paul is told, only when there is something to decide. Three or four sentences, no more. */
  private message(today: string, tiers: TierVerdict[], cheapest: TierVerdict | undefined, reportPath: string): string {
    const roles = CATALOGUE_ROLES.map((r) => ({ role: r, tier: roleTier(r) })).filter((r) => isAliasName(r.tier));
    const broken = tiers.flatMap((t) => (t.check.ok ? [] : [{ model: t.model, reason: t.check.reason }]));
    if (cheapest?.alternatives.length) {
      const best = cheapest.alternatives[0]!;
      const onIt = roles.filter((r) => r.tier === cheapest.alias).map((r) => ROLE_LABELS[r.role]);
      const oldPrice = cheapest.price;
      const bp = priceRow(best);
      return `Model check for ${today}: the ${cheapest.alias} tier, which ${onIt.join(" and ")} run${onIt.length === 1 ? "s" : ""} on, could move to ${best.id} at $${bp.input.toFixed(2)}/M in and $${bp.output.toFixed(2)}/M out${oldPrice ? `, instead of ${cheapest.model} at $${oldPrice.input.toFixed(2)}/M in and $${oldPrice.output.toFixed(2)}/M out` : ""}, at least 20% cheaper on both and tool-capable. The list says prices and tools only, not how well a model works. The full report is at ${reportPath}. Tell Marlo to apply it if you want it; nothing has changed yet.`;
    }
    const b = broken[0]!;
    return `Model check for ${today}: ${b.model} ${broken.length === 1 ? "has" : "and others have"} failed the check (${b.reason}). Everything still runs; the full report is at ${reportPath}. Tell Marlo if you want a change; nothing has changed yet.`;
  }

  /** Starts the timer. Ticks are unref'd, so the check never holds the process open. */
  start(): NodeJS.Timeout | undefined {
    if (!config.modelCheck.enabled) return undefined;
    const tick = () => {
      if (this.due()) void this.run().catch((err) => this.warn(`${err instanceof Error ? err.message : String(err)}`));
    };
    this.timer = setInterval(tick, this.opts.intervalMs ?? MODEL_WATCH_TICK_MS);
    this.timer.unref();
    tick();
    return this.timer;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
