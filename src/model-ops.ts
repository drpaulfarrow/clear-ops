/**
 * The model decisions themselves: reading OpenRouter's public model list, the checks a model must
 * pass before the workforce runs on it, applying and reverting a catalogue change at run time, the
 * chief's view of the catalogue, and the once-a-day check.
 *
 * What is read is public: GET https://openrouter.ai/api/v1/models, no key, no other endpoint. It
 * says what a model costs (per-token strings, USD), whether it supports tools (its
 * supported_parameters) and how much context it takes. It says nothing about how well a model
 * works, and this file never invents that: what it calls a candidate is price, tool support and
 * context length only, and the report says so plainly.
 *
 * Since 22 Nov 2026 the daily check acts on what it finds, on Paul's say: for the cheapest tier a
 * role runs on, it looks a cheaper candidate up with the service's own search and moves the tier
 * only when published benchmarks report the candidate level or ahead of the model in force
 * (src/model-evidence.ts). No information means no move, a free model is never a candidate, and Paul
 * hears only when a move was made. The move is an ordinary recorded change (by "model-check"), with
 * the benchmarks as its reason, and model_revert undoes it; a model a change was reverted from is
 * never taken up again. Every other change stays the chief's decision (model_apply,
 * src/orchestrator.ts), recorded in the catalogue with its reason (src/catalogue.ts), and every change
 * can be undone without a deploy. The availability move that happens without a decision is the
 * previous-model fallback, in two halves for the same record: the daily check moves a tier whose model
 * has left OpenRouter's list back to the model the catalogue kept for it, and a run that OpenRouter
 * refuses because its model no longer exists is retried at once on that same recorded model
 * (engageRunFallback, called from the job runner in src/jobs.ts), so a withdrawn model does not kill
 * a job waiting for the next check. A role change records the role's own previous tier or model the
 * same way (catalogue.roleFallbacks), and a refused run of that role is retried on it by moving the
 * role back, never the whole tier, so a role-only decision protects its runs exactly as a tier
 * change protects the tier's. Both moves are recorded like any change and Paul is told.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { MODEL_ALIASES, OPENROUTER_BASE_URL, modelPrices, openrouterModels, priceOf, provider, type ModelAlias } from "./llm.js";
import { applyCatalogueRoles, CATALOGUE_ROLES, isAliasName, isRoleName, MAX_CATALOGUE_CHANGES, readCatalogue, recordChange, writeCatalogue, type Catalogue, type CatalogueChange, type CatalogueRole, type PriceRow } from "./catalogue.js";
import { londonYmd } from "./london.js";
import { benchmarkEvidence, rowWords, type EvidenceVerdict } from "./model-evidence.js";
import { searchEngines } from "./search.js";
import type { Store } from "./store.js";

/** The public model list. No credential is sent: the endpoint needs none. */
export const MODELS_URL = `${OPENROUTER_BASE_URL}/v1/models`;
/** How long one read of the model list may take. */
export const MODELS_TIMEOUT_MS = 15_000;
/** How often the service looks whether the daily check is due. */
export const MODEL_WATCH_TICK_MS = 30 * 60_000;
/** A model is a candidate only when it is this much cheaper on both input and output. */
export const RECOMMEND_FRACTION = 0.2;
/** How many candidates one day's check looks up, cheapest first. */
export const MAX_CANDIDATES_PER_CHECK = 3;
/** How long a candidate the evidence did not support is left before it is looked up again. */
export const EVIDENCE_RECHECK_DAYS = 7;
/** How long the check leaves a tier alone after moving it, so a move has time to show how it runs. */
export const SWITCH_COOLDOWN_DAYS = 7;
const DAY_MS = 24 * 60 * 60_000;

/** True for a model that costs nothing: a free variant is rate-limited for the whole account, so it is never a candidate. */
export const isFreeModel = (m: LiveModel): boolean => /:free$/i.test(m.id) || m.input === 0 || m.output === 0;

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
      // exact and nudged up (by a millionth) where it is not, so a cap never runs late. Only a real
      // number or a non-empty numeric string is a price: null and "" are unreadable (Number() would
      // read both as zero, and a free-looking model is worse than an unpriced one), and anything else
      // is too, so the model is refused as unpriced rather than accepted for nothing.
      const perM = (v: unknown): number | undefined => {
        if (v === null || v === undefined) return undefined;
        if (typeof v === "string") {
          if (!v.trim()) return undefined;
        } else if (typeof v !== "number") {
          return undefined;
        }
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

/**
 * The old price for a change: the row in force when there is one, else the model's own row on the live
 * list just fetched. A role or tier on a model no configured row covers (a direct provider id the deploy
 * set, a hand-edited catalogue) still records what it cost rather than pretending the price is unknown,
 * because the live list is what priced it while it ran.
 */
function leavingPrice(list: LiveModel[], id: string): PriceRow | undefined {
  const configured = priceOf(id);
  if (configured) return configured;
  const live = list.find((m) => m.id === id && m.input !== undefined && m.output !== undefined);
  return live ? priceRow(live) : undefined;
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
 * The deploy's own variable that pins a tier, if any. Fable is pinned by the opus variable as well:
 * with fable itself unset, a deploy-set OPENROUTER_OPUS_MODEL wins over the catalogue (src/llm.ts
 * openrouterModels), so a fable change under it would record without ever taking effect.
 */
function deployPin(alias: ModelAlias): string | undefined {
  if (config.openrouter.models[alias]) return `OPENROUTER_${alias.toUpperCase()}_MODEL`;
  if (alias === "fable" && config.openrouter.models.opus) return "OPENROUTER_OPUS_MODEL";
  return undefined;
}

/** The OpenRouter model id a value in force stands for: a tier alias resolves, a direct id passes through. */
function modelOf(tier: string): string {
  return isAliasName(tier) ? openrouterModels()[tier] : tier;
}

/** The "was X at $a in and $b out, N% less in and M% less out" tail shared by both apply paths. */
function priceTail(from: string, fromPrice: PriceRow | undefined, toPrice: PriceRow): string {
  if (!fromPrice) return `, was ${from}.`;
  const was = `, was ${from} at $${fromPrice.input.toFixed(2)}/M in and $${fromPrice.output.toFixed(2)}/M out`;
  if (fromPrice.input <= 0 || fromPrice.output <= 0) return `${was}.`;
  const inPct = Math.round((1 - toPrice.input / fromPrice.input) * 100);
  const outPct = Math.round((1 - toPrice.output / fromPrice.output) * 100);
  if (inPct === 0 && outPct === 0) return `${was}, the same price.`;
  if (inPct > 0 && outPct > 0) return `${was}, ${inPct}% less in and ${outPct}% less out.`;
  if (inPct < 0 && outPct < 0) return `${was}, ${-inPct}% more in and ${-outPct}% more out.`;
  return `${was}.`;
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
    const pin = deployPin(alias);
    if (pin) throw new ModelCheckError(`${pin} is set in the deploy, so the catalogue cannot change that tier.`);
    const list = await fetchLiveModels({ fetch: deps.fetch });
    const checked = liveCheck(list, model);
    if (!checked.ok) throw new ModelCheckError(checked.reason);
    const from = openrouterModels()[alias];
    const fromPrice = leavingPrice(list, from);
    const toPrice = priceRow(checked.model);
    const catalogue = clone(readCatalogue(dir));
    catalogue.aliases = { ...(catalogue.aliases ?? {}), [alias]: model };
    catalogue.prices = { ...(catalogue.prices ?? {}), [model]: toPrice };
    // The model being left becomes the tier's fallback: if the new one later leaves OpenRouter's
    // list, the daily check can move the tier back without a decision or a deploy (catalogue.fallbacks).
    if (from !== model) catalogue.fallbacks = { ...(catalogue.fallbacks ?? {}), [alias]: from };
    writeCatalogue(dir, catalogue);
    recordChange(dir, { at, by, kind: "alias", target: alias, from, to: model, why, ...(fromPrice ? { fromPrice } : {}), toPrice });
    deps.store && applyCatalogueRoles(deps.store, dir);
    return `The ${alias} tier now runs on ${model} at $${toPrice.input.toFixed(2)}/M in and $${toPrice.output.toFixed(2)}/M out${priceTail(from, fromPrice, toPrice)} Recorded: "${why}". It applies to the next run, not to one already going.`;
  }

  if (change.role !== undefined && change.to !== undefined && change.alias === undefined) {
    const role = change.role as CatalogueRole;
    if (!isRoleName(role)) throw new ModelCheckError(`"${change.role}" is not a role the catalogue covers (${CATALOGUE_ROLES.join(", ")}; the executive assistant is never changed here).`);
    const to = change.to as ModelAlias;
    if (!isAliasName(to)) throw new ModelCheckError(`"${change.to}" is not one of the tiers (${MODEL_ALIASES.join(", ")}).`);
    if (appPinned(deps, role)) throw new ModelCheckError(`Paul has set the ${role}'s model himself in the web app's Spend page, so the catalogue cannot change it here.`);
    const from = roleTier(role);
    // The destination is checked like any other change: what the role would actually run on is the
    // tier's resolved model, and an unknown, withdrawn, tool-less or unpriced one is refused before
    // anything is written, exactly as for a tier change.
    const toModel = openrouterModels()[to];
    const list = await fetchLiveModels({ fetch: deps.fetch });
    const checked = liveCheck(list, toModel);
    if (!checked.ok) throw new ModelCheckError(checked.reason);
    const fromPrice = leavingPrice(list, modelOf(from));
    const toPrice = priceRow(checked.model);
    const catalogue = clone(readCatalogue(dir));
    catalogue.roles = { ...(catalogue.roles ?? {}), [role]: to };
    catalogue.prices = { ...(catalogue.prices ?? {}), [toModel]: toPrice };
    // The tier (or direct model id) the role leaves becomes its own fallback: if the role's new model
    // is later withdrawn, a refused run of this role is retried on it without a decision or a deploy
    // (catalogue.roleFallbacks, engageRunFallback), so a role-only decision is as protected as a tier one.
    if (from !== to) catalogue.roleFallbacks = { ...(catalogue.roleFallbacks ?? {}), [role]: from };
    writeCatalogue(dir, catalogue);
    recordChange(dir, { at, by, kind: "role", target: role, from, to, why, ...(fromPrice ? { fromPrice } : {}), toPrice });
    deps.store && applyCatalogueRoles(deps.store, dir);
    return `${role} now runs on the ${to} tier (${toModel}) at $${toPrice.input.toFixed(2)}/M in and $${toPrice.output.toFixed(2)}/M out${priceTail(from, fromPrice, toPrice)} Recorded: "${why}". It applies to the next run, not to one already going.`;
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
  // A fallback record is the check's own availability move, never a decision to undo: reverting one
  // would put a model that has left OpenRouter's list back in force.
  const candidates = (catalogue.changes ?? []).filter((c) => c.kind !== "fallback" && !c.isRevert && !c.reverted && (target === undefined || c.target === target));
  const entry = candidates.at(-1) as CatalogueChange | undefined;
  if (!entry) throw new ModelCheckError(`There is no model change to revert${target !== undefined ? ` for ${target}` : ""}.`);

  if (entry.kind === "alias") {
    const alias = entry.target as ModelAlias;
    const pin = deployPin(alias);
    if (pin) throw new ModelCheckError(`${pin} is set in the deploy, so the catalogue cannot change that tier.`);
    catalogue.aliases = { ...(catalogue.aliases ?? {}), [alias]: entry.from };
    if (entry.fromPrice) catalogue.prices = { ...(catalogue.prices ?? {}), [entry.from]: entry.fromPrice };
    if (entry.to !== entry.from) catalogue.fallbacks = { ...(catalogue.fallbacks ?? {}), [alias]: entry.to };
  } else {
    const role = entry.target as CatalogueRole;
    if (appPinned(deps, role)) throw new ModelCheckError(`Paul has set the ${role}'s model himself in the web app's Spend page, so the catalogue cannot change it here.`);
    // The recorded `from` is what the role ran on before the change: a tier, or a full provider model
    // id the deploy itself set (CHIEF_MODEL and friends take ids as well as tiers). A tier goes back
    // as a catalogue overlay; a direct id is restored by removing the overlay, so the deployed value
    // shows through again exactly as it did before the change. The tier the role is taken off becomes
    // its fallback, exactly as the model a tier is taken off becomes the tier's.
    const roles = { ...(catalogue.roles ?? {}) };
    if (isAliasName(entry.from)) roles[role] = entry.from;
    else delete roles[role];
    if (Object.keys(roles).length) catalogue.roles = roles;
    else delete catalogue.roles;
    if (entry.to !== entry.from) catalogue.roleFallbacks = { ...(catalogue.roleFallbacks ?? {}), [role]: entry.to };
  }
  entry.reverted = at;
  catalogue.changes = [...(catalogue.changes ?? []), { at, by: deps.by ?? "chief", kind: entry.kind, target: entry.target, from: entry.to, to: entry.from, why: `Reverted: ${entry.why}`, ...(entry.toPrice ? { fromPrice: entry.toPrice } : {}), ...(entry.fromPrice ? { toPrice: entry.fromPrice } : {}), isRevert: true }].slice(-MAX_CATALOGUE_CHANGES);
  writeCatalogue(dir, catalogue);
  deps.store && applyCatalogueRoles(deps.store, dir);
  const what = entry.kind === "alias" ? `The ${entry.target} tier` : `${entry.target}`;
  const price = cheaperPercent(entry.toPrice, entry.fromPrice);
  return `${what} is back on ${entry.from} (${entry.to} before${price}). Reverted: "${entry.why}". It applies to the next run, not to one already going.`;
}

const ROLE_LABELS: Record<CatalogueRole, string> = { chief: "chief", worker: "workers", engineer: "engineers", maintainer: "maintainer", designer: "designer" };

/** What a runtime fallback moved: the tier, the model OpenRouter refused and the previous model now in force. */
export interface EngagedFallback {
  alias: ModelAlias;
  from: string;
  to: string;
  /** The role whose recorded previous tier/model the run is retried on, when the fallback undoes a role change. */
  role?: CatalogueRole;
  /**
   * What the retried run must be started on: the role's restored tier or direct model id. Unset for a
   * tier fallback, where the run keeps its alias and the catalogue now resolves it to the previous
   * model; a role fallback moves the role, not the tier, so the run must be pointed at the new value.
   */
  retryOn?: string;
}

/** Run-failure text that means the provider no longer offers the model the run was on. */
const WITHDRAWN_MODEL =
  /not a valid model|model (?:does not exist|not found|has been (?:disabled|deprecated|retired|removed|discontinued)|is (?:no longer|not) available)|no (?:allowed providers|endpoints|compatible providers) (?:are )?(?:available|found)/i;

/**
 * True when a run failure is the provider saying the model the run was on no longer exists: the 404
 * "not a valid model" shape and OpenRouter's "no allowed providers are available". A run that ends any
 * other way (no credit, a rejected key, rate limits, overload, a crash) is never a withdrawal.
 */
export function isWithdrawnModelFailure(failure: { kind: string; detail: string }): boolean {
  return failure.kind === "api" && WITHDRAWN_MODEL.test(failure.detail);
}

/**
 * The runtime half of the availability fallback: a run whose model OpenRouter refused because it no
 * longer offers it is retried on the recorded previous model at once, rather than waiting for the
 * next daily check. A role change keeps its own record (catalogue.roleFallbacks), and for a run of
 * that role it wins: the role's overlay is moved back to the tier (or direct model id) it ran on
 * before, never the whole tier, because the decision the fallback undoes is the role change. Without
 * one the tier's own recorded fallback (catalogue.fallbacks) engages as before, moving the alias for
 * every role on it. Either way engaging spends the fallback (so the retry can never loop), records
 * the move like any change (by "runtime-fallback") and marks the decision it superseded undone,
 * exactly as the daily check's own engage does. No live check happens here: the run itself has just
 * proved OpenRouter refuses the model, and the retry immediately proves or disproves the fallback.
 * Undefined when the role fallback does not cover this run, the deploy pins the tier, no fallback is
 * recorded, or the fallback is what the run already started on; the caller then lets the job fail as
 * it did before.
 */
export function engageRunFallback(alias: ModelAlias, dir: string = config.dataDir, detail = "", role?: CatalogueRole, store?: Pick<Store, "settings">): EngagedFallback | undefined {
  const catalogue = clone(readCatalogue(dir));
  // The role's own recorded previous tier, engaged only when the role's catalogue overlay is what
  // put this run on the failed tier (a run Paul's own app setting, the deploy or a pinned model id
  // started is not the catalogue's to move) and Paul has not taken the role over himself.
  if (role && catalogue.roles?.[role] === alias && !appPinned({ store }, role)) {
    const fb = catalogue.roleFallbacks?.[role];
    if (fb && fb !== alias) {
      const from = openrouterModels()[alias];
      const to = modelOf(fb);
      const at = new Date().toISOString();
      const roles = { ...(catalogue.roles ?? {}) };
      if (isAliasName(fb)) roles[role] = fb;
      else delete roles[role];
      if (Object.keys(roles).length) catalogue.roles = roles;
      else delete catalogue.roles;
      const roleFbs = { ...(catalogue.roleFallbacks ?? {}) };
      delete roleFbs[role];
      if (Object.keys(roleFbs).length) catalogue.roleFallbacks = roleFbs;
      else delete catalogue.roleFallbacks;
      const fromPrice = priceOf(from);
      const toPrice = priceOf(to);
      const why = `${from} was refused by OpenRouter mid-run${detail ? ` (${detail.slice(0, 200).trim()})` : ""}; the role fell back to its recorded previous ${isAliasName(fb) ? `tier ${fb}` : "model"} automatically and the run was retried on it.`;
      catalogue.changes = [
        ...(catalogue.changes ?? []),
        { at, by: "runtime-fallback", kind: "fallback", target: role, from, to, why, ...(fromPrice ? { fromPrice } : {}), ...(toPrice ? { toPrice } : {}) } as CatalogueChange,
      ];
      // The role change that put the vanished model in place is undone by this fallback, and is marked
      // so neither model_revert nor a later fallback treats it as still in force.
      const superseded = [...(catalogue.changes ?? [])].reverse().find((c) => c.kind === "role" && !c.isRevert && !c.reverted && c.target === role && c.to === alias);
      if (superseded) superseded.reverted = at;
      catalogue.changes = (catalogue.changes ?? []).slice(-MAX_CATALOGUE_CHANGES);
      writeCatalogue(dir, catalogue);
      store && applyCatalogueRoles(store, dir);
      return { alias, from, to, role, retryOn: fb };
    }
  }
  if (deployPin(alias)) return undefined;
  const from = openrouterModels()[alias];
  const to = catalogue.fallbacks?.[alias];
  if (!to || to === from) return undefined;
  const at = new Date().toISOString();
  catalogue.aliases = { ...(catalogue.aliases ?? {}), [alias]: to };
  const fallbacks = { ...(catalogue.fallbacks ?? {}) };
  delete fallbacks[alias];
  if (Object.keys(fallbacks).length) catalogue.fallbacks = fallbacks;
  else delete catalogue.fallbacks;
  const fromPrice = priceOf(from);
  const toPrice = priceOf(to);
  const why = `${from} was refused by OpenRouter mid-run${detail ? ` (${detail.slice(0, 200).trim()})` : ""}; the tier fell back to its recorded previous model automatically and the run was retried on it.`;
  catalogue.changes = [
    ...(catalogue.changes ?? []),
    { at, by: "runtime-fallback", kind: "fallback", target: alias, from, to, why, ...(fromPrice ? { fromPrice } : {}), ...(toPrice ? { toPrice } : {}) } as CatalogueChange,
  ];
  // The change that put the vanished model in place is undone by this fallback, and is marked so
  // neither model_revert nor a later fallback treats it as still in force.
  const superseded = [...(catalogue.changes ?? [])].reverse().find((c) => c.kind === "alias" && !c.isRevert && !c.reverted && c.target === alias && c.to === from);
  if (superseded) superseded.reverted = at;
  catalogue.changes = (catalogue.changes ?? []).slice(-MAX_CATALOGUE_CHANGES);
  writeCatalogue(dir, catalogue);
  return { alias, from, to };
}

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
    // Fable is pinned by the opus variable as well as its own (src/llm.ts), so the pin named here is
    // the one actually in force, not always the tier's own.
    const pin = deployPin(alias);
    const source = pin ? `the deploy's own ${pin}` : cat.aliases?.[alias] ? "the catalogue" : "the code default";
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
  /** Paul's chat address, the one the check messages when it has moved a tier or a model is broken. */
  to?: string;
  warn?: (m: string) => void;
  /**
   * The benchmark lookup for one candidate against the model in force. Defaults to the service's own
   * search and one reading call (src/model-evidence.ts), and to "no" when no search engine is set.
   */
  evidence?: (candidate: LiveModel, current: LiveModel) => Promise<EvidenceVerdict>;
}

/** A tier the check moved on benchmark evidence. */
export interface AppliedSwitch {
  alias: ModelAlias;
  from: string;
  to: string;
  fromPrice?: PriceRow;
  toPrice: PriceRow;
  verdict: EvidenceVerdict;
}

/** What the check did about one candidate, for the report. */
interface CandidateNote {
  model: string;
  /** The lookup's verdict, when one ran today. */
  verdict?: EvidenceVerdict;
  /** Why no lookup ran, or why a supported move was not made. */
  note?: string;
}

export interface ModelCheckOutcome {
  ran: boolean;
  /** True when a cheaper candidate exists for the cheapest tier in use, whether or not it was taken up. */
  recommend: boolean;
  /** The move the check made today on benchmark evidence, if any. */
  applied?: AppliedSwitch;
  /** True when a model in force failed its check. */
  flagged: boolean;
  /** The availability fallbacks the check engaged: one tier's model had left OpenRouter's list. */
  engaged: Array<{ alias: string; from: string; to: string }>;
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

/**
 * The better-value alternatives for one model, tier-backed or a direct provider id: tool-capable,
 * priced (a free variant is not one: its request limits are the account's, not the model's), at least
 * RECOMMEND_FRACTION cheaper on both input and output, and with no smaller context.
 */
function alternativesFor(list: LiveModel[], model: string, price: PriceRow | undefined, contextLength: number | undefined): LiveModel[] {
  if (!price || price.input <= 0 || price.output <= 0) return [];
  return list
    .filter(
      (m) =>
        m.tools &&
        m.input !== undefined &&
        m.output !== undefined &&
        !isFreeModel(m) &&
        m.input <= price.input * (1 - RECOMMEND_FRACTION) &&
        m.output <= price.output * (1 - RECOMMEND_FRACTION) &&
        (m.contextLength === undefined || contextLength === undefined || m.contextLength >= contextLength) &&
        m.id !== model,
    )
    .sort((a, b) => a.output! - b.output! || a.input! - b.input!);
}

function verdicts(list: LiveModel[]): TierVerdict[] {
  return MODEL_ALIASES.map((alias) => {
    const model = openrouterModels()[alias];
    const check = liveCheck(list, model);
    const price = check.ok ? priceRow(check.model) : currentPrice(model);
    const alternatives = check.ok ? alternativesFor(list, model, price, check.model.contextLength) : [];
    return { alias, model, check, price, alternatives };
  });
}

/** What one role's check found: the tier it runs on when it is one, else its direct provider model. */
interface RoleVerdict {
  role: CatalogueRole;
  tier: string;
  model: string;
  check: LiveCheck;
  price?: PriceRow;
  alternatives: LiveModel[];
  /** The tier the role runs on, when its setting is a tier rather than a direct model id. */
  alias?: ModelAlias;
}

/** The per-role verdicts, so a role on a direct provider model id is verified and analysed like any other. */
function roleVerdicts(list: LiveModel[], byAlias: Map<ModelAlias, TierVerdict>): RoleVerdict[] {
  return CATALOGUE_ROLES.map((role) => {
    const tier = roleTier(role);
    if (isAliasName(tier)) {
      const v = byAlias.get(tier)!;
      return { role, tier, model: v.model, check: v.check, price: v.price, alternatives: v.alternatives, alias: tier };
    }
    const check = liveCheck(list, tier);
    const price = check.ok ? priceRow(check.model) : currentPrice(tier);
    const alternatives = check.ok ? alternativesFor(list, tier, price, check.model.contextLength) : [];
    return { role, tier, model: tier, check, price, alternatives };
  });
}

const priceWords = (p: PriceRow) => `$${p.input.toFixed(2)}/M in and $${p.output.toFixed(2)}/M out`;

/**
 * The daily check: verifies every model in force, writes the report of offers and better-value
 * alternatives per role, and for the cheapest tier in use looks its cheaper candidates up and moves
 * the tier when published benchmarks support it (see the header). Paul is messaged only when a tier
 * was moved, a fallback engaged or a model in force failed its check.
 */
export class ModelWatch {
  private timer?: NodeJS.Timeout;
  private readonly warn: (m: string) => void;

  /**
   * The cheapest tier a role actually runs on, which is the one bought on price. A stronger tier is
   * bought for strength, so the check reports its cheaper alternatives but looks candidates up, and
   * moves, only for the cheapest tier in use, and never trades a strong tier down. A tier no role runs
   * on is never moved, however cheap its alternatives: moving the workforce onto it would be a
   * decision about roles, not a saving on the tier they use.
   */
  private cheapestTier(tiers: TierVerdict[]): TierVerdict | undefined {
    const inUse = new Set(CATALOGUE_ROLES.map((r) => roleTier(r)).filter(isAliasName));
    const priced = tiers.filter((t) => inUse.has(t.alias) && t.price && t.price.input > 0);
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
    if (!force && !this.due(at)) return { ran: false, recommend: false, flagged: false, engaged: [], summary: "not due" };
    let list: LiveModel[];
    try {
      list = await fetchLiveModels({ fetch: this.opts.fetch, url: this.opts.url, timeoutMs: this.opts.timeoutMs });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.warn(`${reason} The check will try again later; nothing was changed.`);
      return { ran: false, recommend: false, flagged: false, engaged: [], summary: reason };
    }
    const today = londonYmd(at);
    const dir = this.opts.dataDir ?? config.dataDir;
    const tiers = verdicts(list);
    const flagged = tiers.some((t) => !t.check.ok);
    // The one change the check makes itself: a tier whose model has left OpenRouter's list goes back
    // to the previous model the catalogue kept, recorded and told, so the jobs on it survive (src/model-ops.ts header).
    const engaged = this.engageFallbacks(dir, list, tiers, at);
    // The report and the recommendation are computed on what is in force now the fallbacks are.
    const fresh = engaged.length ? verdicts(list) : tiers;
    const cheapest = this.cheapestTier(fresh);
    const recommend = (cheapest?.alternatives.length ?? 0) > 0;
    // The one decision the check takes itself: a cheaper candidate for the cheapest tier in use is
    // looked up, and taken up only when published benchmarks support it. Not on a day a fallback
    // engaged: that day's news is the fallback, and the tier has only just changed.
    const looked = this.opts.store?.settings().modelWatch?.looked ?? {};
    const { applied, notes } = cheapest && recommend && !engaged.length ? await this.consider(cheapest, list, dir, at, today, looked) : { applied: undefined, notes: [] as CandidateNote[] };
    // The report describes what is in force once any move has been made.
    const after = applied ? verdicts(list) : fresh;
    const report = this.report(today, at, new Map(after.map((t) => [t.alias, t])), applied ? this.cheapestTier(after) : cheapest, list, engaged, notes, applied);
    const reportDir = path.join(dir, "model-watch");
    fs.mkdirSync(reportDir, { recursive: true });
    const reportPath = path.join(reportDir, `${today}.md`);
    fs.writeFileSync(reportPath, report);
    const kept = Object.fromEntries(Object.entries(looked).filter(([, ymd]) => at.getTime() - Date.parse(ymd) < 30 * DAY_MS));
    this.opts.store?.setSetting("modelWatch", { ymd: today, at: at.toISOString(), ...(Object.keys(kept).length ? { looked: kept } : {}) });
    // Paul hears only when something happened: a tier was moved, or a model in force is broken. A day
    // with both says both. A cheaper candidate the evidence did not support is in the report and no message.
    const texts = [...(applied ? [this.movedMessage(today, applied, reportDir)] : []), ...(flagged ? [this.message(today, fresh, reportPath, engaged)] : [])];
    for (const text of this.opts.messenger && this.opts.to ? texts : []) {
      await this.opts.messenger!.send(this.opts.to!, text).catch((err) => this.warn(`Paul could not be told (${err instanceof Error ? err.message : String(err)}).`));
    }
    return {
      ran: true,
      recommend,
      ...(applied ? { applied } : {}),
      flagged,
      engaged,
      reportPath,
      summary: engaged.length
        ? `fell back to the previous model for ${engaged.map((e) => e.alias).join(", ")}`
        : applied
          ? `moved the ${applied.alias} tier to ${applied.to} on benchmark evidence`
          : flagged
            ? "a model failed its check"
            : recommend
              ? "a cheaper candidate exists, and the evidence did not support a move"
              : "all models verified, nothing cheaper to consider",
    };
  }

  /**
   * Looks the tier's cheaper candidates up, cheapest first, and moves the tier to the first one the
   * published benchmarks support. Nothing here trusts price alone: a candidate with no evidence, or
   * with evidence against it, is left, and is not looked up again for EVIDENCE_RECHECK_DAYS. A tier
   * the deploy pins, or one this check moved within SWITCH_COOLDOWN_DAYS, is not looked at; a model a
   * recorded change was reverted from (Paul undid it, or it left the list) is never taken up again.
   * `looked` is the record of what was looked up when, updated in place.
   */
  private async consider(tier: TierVerdict, list: LiveModel[], dir: string, at: Date, today: string, looked: Record<string, string>): Promise<{ applied?: AppliedSwitch; notes: CandidateNote[] }> {
    const notes: CandidateNote[] = [];
    if (!tier.check.ok) return { notes };
    const current = tier.check.model;
    const pin = deployPin(tier.alias);
    if (pin) return { notes: [{ model: tier.alternatives[0]!.id, note: `${pin} is set in the deploy, so the check cannot move the ${tier.alias} tier and looked nothing up.` }] };
    const changes = readCatalogue(dir).changes ?? [];
    const own = changes.filter((c) => c.by === "model-check" && c.kind === "alias" && c.target === tier.alias && !c.reverted).at(-1);
    if (own && at.getTime() - Date.parse(own.at) < SWITCH_COOLDOWN_DAYS * DAY_MS) {
      return { notes: [{ model: tier.alternatives[0]!.id, note: `The check moved the ${tier.alias} tier on ${own.at.slice(0, 10)}, and leaves it alone for ${SWITCH_COOLDOWN_DAYS} days after a move.` }] };
    }
    const undone = new Set(changes.filter((c) => c.kind === "alias" && c.target === tier.alias && c.reverted).map((c) => c.to));
    const evidence =
      this.opts.evidence ??
      ((candidate: LiveModel, inForce: LiveModel) =>
        searchEngines().length && config.openrouter.apiKey
          ? benchmarkEvidence(candidate, inForce)
          : Promise.resolve<EvidenceVerdict>({ ok: false, reason: "no search engine is configured, so there is nothing to look benchmarks up with.", rows: [], searches: [] }));
    let lookups = 0;
    for (const candidate of tier.alternatives) {
      if (undone.has(candidate.id)) {
        notes.push({ model: candidate.id, note: "A change to this model was undone before, so it is not taken up again." });
        continue;
      }
      const key = `${candidate.id}>${current.id}`;
      const last = looked[key];
      if (last && at.getTime() - Date.parse(last) < EVIDENCE_RECHECK_DAYS * DAY_MS) {
        notes.push({ model: candidate.id, note: `Looked up on ${last} and not supported; it is looked up again after ${EVIDENCE_RECHECK_DAYS} days.` });
        continue;
      }
      if (lookups >= MAX_CANDIDATES_PER_CHECK) break;
      lookups += 1;
      let verdict: EvidenceVerdict;
      try {
        verdict = await evidence(candidate, current);
      } catch (err) {
        verdict = { ok: false, reason: `the lookup failed (${err instanceof Error ? err.message : String(err)}).`, rows: [], searches: [] };
      }
      looked[key] = today;
      if (!verdict.ok) {
        notes.push({ model: candidate.id, verdict });
        continue;
      }
      // The recorded reason is read by the chief (the models view), so it carries the numbers and not
      // the benchmarks' names, which are text from the web: those stay in the report and Paul's message.
      const scores = verdict.rows.slice(0, 6).map((r) => `${r.candidate} against ${r.current}`).join(", ");
      const why = `The daily check moved the tier on benchmark evidence: against ${current.id}, level or ahead on all ${verdict.rows.length} published benchmarks that report both models (${scores}). Names and sources are in the model report for ${today}.`;
      try {
        await applyModelChange({ store: this.opts.store, dataDir: dir, fetch: this.opts.fetch, now: () => at, by: "model-check" }, { alias: tier.alias, model: candidate.id, why });
      } catch (err) {
        notes.push({ model: candidate.id, verdict, note: `The evidence supported it, and the move was refused: ${err instanceof Error ? err.message : String(err)}` });
        continue;
      }
      delete looked[key];
      notes.push({ model: candidate.id, verdict });
      return { applied: { alias: tier.alias, from: current.id, to: candidate.id, ...(tier.price ? { fromPrice: tier.price } : {}), toPrice: priceRow(candidate), verdict }, notes };
    }
    return { notes };
  }

  /**
   * Engages the recorded previous-model fallback for every tier whose model has left OpenRouter's
   * list: the tier is moved back to the model it ran on before (which must itself still verify), the
   * move is recorded like any change, the decision it superseded is marked undone, and the fallback
   * is spent, so the check never re-engages what it already engaged. A tier the deploy pins is left
   * alone: the catalogue cannot speak for the deploy's own variable. A model still on the list that
   * fails its check another way (no longer tool-capable, no readable price) is NOT withdrawn from:
   * its real reason is reported with the check's findings, and moving the tier off it is the chief's
   * recorded decision, not the check's.
   */
  private engageFallbacks(dir: string, list: LiveModel[], tiers: TierVerdict[], at: Date): Array<{ alias: string; from: string; to: string }> {
    const catalogue = clone(readCatalogue(dir));
    const fallbacks = { ...(catalogue.fallbacks ?? {}) };
    const engaged: Array<{ alias: string; from: string; to: string }> = [];
    for (const t of tiers) {
      // Only absence from the list is a withdrawal; anything else the model still on the list is wrong
      // about has its real reason reported below, and stays a decision.
      if (t.check.ok || list.some((m) => m.id === t.model) || deployPin(t.alias)) continue;
      const fb = fallbacks[t.alias];
      if (!fb || fb === t.model) continue;
      const fbCheck = liveCheck(list, fb);
      if (!fbCheck.ok) continue;
      const toPrice = priceRow(fbCheck.model);
      const fromPrice = currentPrice(t.model);
      catalogue.aliases = { ...(catalogue.aliases ?? {}), [t.alias]: fb };
      catalogue.prices = { ...(catalogue.prices ?? {}), [fb]: toPrice };
      delete fallbacks[t.alias];
      const record: CatalogueChange = {
        at: at.toISOString(),
        by: "model-check",
        kind: "fallback",
        target: t.alias,
        from: t.model,
        to: fb,
        why: `${t.model} has left OpenRouter's model list; the tier fell back to its previous model automatically.`,
        ...(fromPrice ? { fromPrice } : {}),
        toPrice,
      };
      catalogue.changes = [...(catalogue.changes ?? []), record];
      // The change that put the vanished model in place is undone by the fallback, and is marked so
      // neither model_revert nor a later fallback treats it as still in force.
      const superseded = [...(catalogue.changes ?? [])].reverse().find((c) => c.kind === "alias" && !c.isRevert && !c.reverted && c.target === t.alias && c.to === t.model);
      if (superseded) superseded.reverted = record.at;
      engaged.push({ alias: t.alias, from: t.model, to: fb });
    }
    if (!engaged.length) return engaged;
    if (Object.keys(fallbacks).length) catalogue.fallbacks = fallbacks;
    else delete catalogue.fallbacks;
    catalogue.changes = (catalogue.changes ?? []).slice(-MAX_CATALOGUE_CHANGES);
    writeCatalogue(dir, catalogue);
    this.opts.store && applyCatalogueRoles(this.opts.store, dir);
    return engaged;
  }

  /** The report, one file per London day, with the plain statement of what OpenRouter's list does not say. */
  private report(today: string, at: Date, byAlias: Map<ModelAlias, TierVerdict>, cheapest: TierVerdict | undefined, list: LiveModel[], engaged: Array<{ alias: string; from: string; to: string }>, notes: CandidateNote[] = [], applied?: AppliedSwitch): string {
    const lines: string[] = [];
    lines.push(`# Model check — ${today}`);
    lines.push("");
    lines.push(`Prices are USD per million tokens, read from OpenRouter's public model list (${MODELS_URL}) at ${at.toISOString()}. It states each model's price, whether it supports tools and its context length. OpenRouter's public model list carries no performance or quality measure, so nothing in the lists below ranks models by how well they work: they are price, tool support and context length only. For the cheapest tier in use the check looks its cheaper candidates up with the service's own web search, and moves the tier only when at least two published benchmarks report both models and the candidate is level or ahead on each. No information means no move, and a free model is never a candidate.`);
    lines.push("");
    if (engaged.length) {
      lines.push(`## Fallbacks engaged today`);
      for (const e of engaged) {
        lines.push(`- ${e.from} has left OpenRouter's model list, so the ${e.alias} tier was moved back to its previous model ${e.to} automatically (recorded below). A run that OpenRouter refuses because its model has vanished is retried on the tier's recorded previous model at once (src/jobs.ts), so jobs on the tier do not wait for this check; runs that failed some other way before it ran are not retried here. Tell the chief if you want a different model.`);
      }
      lines.push("");
    }
    lines.push(`## Roles`);
    for (const v of roleVerdicts(list, byAlias)) {
      const head = v.price ? ` — verified: tools, ${priceWords(v.price)}` : "";
      const bad = !v.check.ok ? ` — NOT VERIFIED: ${v.check.reason}` : "";
      lines.push(`- ${ROLE_LABELS[v.role]}: ${v.tier} → ${v.model}${bad || head}`);
      if (!v.check.ok) continue;
      if (!v.alternatives.length) {
        lines.push(`  No cheaper tool-capable alternative today.`);
        continue;
      }
      const best = v.alternatives[0]!;
      const bp = priceRow(best);
      const context = best.contextLength !== undefined && v.check.ok && v.check.model.contextLength !== undefined ? `, context ${best.contextLength} ≥ ${v.check.model.contextLength}` : "";
      if (v.alias !== undefined && cheapest?.alias === v.alias) {
        lines.push(`  Cheaper candidate: ${best.id} at ${priceWords(bp)}${context}, tool-capable, at least 20% cheaper on both input and output. Taken up only on benchmark evidence (below).`);
      } else if (v.alias !== undefined) {
        lines.push(`  Cheaper on price alone: ${best.id} at ${priceWords(bp)}${context}, tool-capable. Listed, not recommended: this tier is bought for strength, which the list cannot measure.`);
      } else {
        lines.push(`  Cheaper on price alone: ${best.id} at ${priceWords(bp)}${context}, tool-capable. Listed, not recommended: this role's model is a direct provider id the deploy or Paul set, and moving it is the chief's recorded decision, not the check's.`);
      }
    }
    if (applied || notes.length) {
      lines.push("");
      lines.push(`## Benchmark evidence`);
      if (applied) lines.push(`The ${applied.alias} tier was moved from ${applied.from} to ${applied.to} today: ${applied.verdict.reason}`);
      for (const n of notes) {
        lines.push(`- ${n.model}: ${n.verdict ? `${n.verdict.ok ? "supported" : "not supported"}, ${n.verdict.reason}` : ""}${n.verdict && n.note ? " " : ""}${n.note ?? ""}`);
        for (const s of n.verdict?.searches ?? []) lines.push(`  Searched ${s.engine} for "${s.query}": ${s.error ? `failed (${s.error})` : `${s.results} results`}.`);
        for (const r of n.verdict?.rows ?? []) lines.push(`  ${r.benchmark}: ${r.candidate} (${r.candidateUrl}) against ${r.current} (${r.currentUrl}).`);
      }
    }
    lines.push("");
    lines.push(`## Offers — the cheapest tool-capable models on the list today (price only; the list carries no performance or quality measure)`);
    for (const m of list.filter((m) => m.tools && m.input !== undefined && m.output !== undefined).sort((a, b) => a.output! - b.output! || a.input! - b.input!).slice(0, 8)) {
      lines.push(`- ${m.id} — $${m.input!.toFixed(2)}/M in, $${m.output!.toFixed(2)}/M out${m.contextLength !== undefined ? `, context ${m.contextLength}` : ""}${isFreeModel(m) ? " (free: rate-limited for the whole account, never a candidate)" : ""}`);
    }
    const changes = readCatalogue(this.opts.dataDir).changes ?? [];
    if (changes.length) {
      lines.push("");
      lines.push(`## The catalogue's own record (newest last)`);
      for (const c of changes.slice(-10)) lines.push(`- ${c.at} ${c.kind} ${c.target}: ${c.from} → ${c.to} — "${c.why}"${c.reverted ? ` (reverted ${c.reverted})` : ""}`);
    }
    lines.push("");
    lines.push(engaged.length
      ? `The only change made by this check was the fallback above, recorded like any change. Every other change is the chief's recorded decision (model_apply), which Paul can undo with model_revert.`
      : applied
        ? `The only change made by this check was the move above, recorded like any change with the benchmarks as its reason. Paul can undo it with model_revert, and a model a change was undone from is never taken up again.`
        : `Nothing was changed by this check. It moves a tier only on benchmark evidence; any other change is the chief's recorded decision (model_apply), which Paul can undo with model_revert.`);
    return `${lines.join("\n")}\n`;
  }

  /** What Paul is told when the check has moved a tier. Three or four sentences, no more. */
  private movedMessage(today: string, a: AppliedSwitch, reportDir: string): string {
    const onIt = CATALOGUE_ROLES.filter((r) => roleTier(r) === a.alias).map((r) => ROLE_LABELS[r]);
    const price = a.fromPrice ? `, which costs ${priceWords(a.toPrice)} instead of ${priceWords(a.fromPrice)}` : `, which costs ${priceWords(a.toPrice)}`;
    const rows = a.verdict.rows;
    const shown = rows.slice(0, 3).map(rowWords).join(", ");
    return `Model check for ${today}: the ${a.alias} tier, which ${onIt.join(" and ")} run${onIt.length === 1 ? "s" : ""} on, was moved from ${a.from} to ${a.to}${price}. Published benchmarks put the new model level or ahead on all ${rows.length} that report both: ${shown}${rows.length > 3 ? " and more" : ""}. The sources are in today's report under ${reportDir}. Tell Marlo to revert the ${a.alias} tier if you want the old model back.`;
  }

  /** What Paul is told when a fallback engaged or a model in force failed its check. Three or four sentences, no more. */
  private message(today: string, tiers: TierVerdict[], reportPath: string, engaged: Array<{ alias: string; from: string; to: string }>): string {
    const roles = CATALOGUE_ROLES.map((r) => ({ role: r, tier: roleTier(r) })).filter((r) => isAliasName(r.tier));
    const broken = tiers.flatMap((t) => (t.check.ok ? [] : [{ alias: t.alias, model: t.model, reason: t.check.reason }]));
    if (engaged.length) {
      const e = engaged[0]!;
      const onIt = roles.filter((r) => r.tier === e.alias).map((r) => ROLE_LABELS[r.role]);
      return `Model check for ${today}: ${e.from} has left OpenRouter's model list, so the ${e.alias} tier (which ${onIt.join(" and ")} run${onIt.length === 1 ? "s" : ""} on) was moved back to its previous model ${e.to}, recorded like any change; a run that hits ${e.from} is retried on ${e.to} at once, so jobs on the tier did not wait for this check. The full report is at ${reportPath}. Tell Marlo if you want a different model; nothing else has changed.`;
    }
    const b = broken[0]!;
    // A recorded fallback is engaged only for a model that has left the list. One still on the list but
    // failing its check (tool-less, unpriced) is reported with its real reason and left for the chief:
    // the message says so rather than claiming there is nothing to fall back on.
    const cat = readCatalogue(this.opts.dataDir ?? config.dataDir);
    const fb = cat.fallbacks?.[b.alias];
    // A role on the tier may keep its own recorded previous tier (a role change's fallback), which the
    // job runner retries a refused run on at once: the message claims that protection where it exists
    // and never claims there is nothing to fall back on while a role has something recorded.
    const roleCovered = CATALOGUE_ROLES.some((r) => cat.roles?.[r] === b.alias && cat.roleFallbacks?.[r] !== undefined);
    const fbLine = fb
      ? `It is still on OpenRouter's model list, so its recorded previous model was not engaged automatically; moving off it stays the chief's recorded decision, and runs on it keep failing until then.`
      : roleCovered
        ? `Runs on it are retried on the role's recorded previous tier at once, so a job does not die waiting for a decision; moving the role off this model is still the chief's recorded decision.`
        : `There is no previous model to fall back on, so runs on it will fail until it is changed.`;
    return `Model check for ${today}: ${b.model} ${broken.length === 1 ? "has" : "and others have"} failed the check (${b.reason}). ${fbLine} The full report is at ${reportPath}. Tell Marlo which model to move to; nothing has changed yet.`;
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
