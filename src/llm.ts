/**
 * Which model provider the agents talk to. The Agent SDK always speaks Anthropic's Messages API; with
 * OPENROUTER_API_KEY set it is pointed at OpenRouter's Anthropic-compatible endpoint instead, and the
 * model aliases the code uses (haiku, sonnet, opus, fable) are mapped to OpenRouter model ids.
 *
 * Nothing else changes: tools, permissions, prompts and caps are the same whichever provider answers.
 */
import { config } from "./config.js";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api";

export type Provider = "anthropic" | "openrouter";

export const MODEL_ALIASES = ["haiku", "sonnet", "opus", "fable"] as const;
export type ModelAlias = (typeof MODEL_ALIASES)[number];

/** USD per million tokens, the shape the SDK's modelPricing setting takes. */
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Default OpenRouter models for each alias. Every role defaults to "haiku", so out of the box
 * everything runs on the cheapest one. Override with OPENROUTER_HAIKU_MODEL and friends.
 */
export const DEFAULT_OPENROUTER_MODELS: Record<ModelAlias, string> = {
  haiku: "deepseek/deepseek-v4.1-flash",
  sonnet: "z-ai/glm-5.3",
  opus: "moonshotai/kimi-k3.1-pro",
  fable: "moonshotai/kimi-k3.1-pro",
};

/**
 * What the SDK charges each default model at, so total_cost_usd and the per-run caps mean something:
 * without a row the SDK prices an unknown model as a guess at a Claude rate. Rounded UP from the
 * providers' peak list prices (Nov 2026), so the caps err towards stopping early.
 *
 * This table is an ESTIMATE, not the bill: the daily cap counts what OpenRouter says it charged
 * (src/spend.ts), and this is the fallback when that cannot be read. OPENROUTER_PRICES (JSON, model
 * id to Price) adds or replaces rows; set it when you change models.
 */
export const DEFAULT_OPENROUTER_PRICES: Record<string, Price> = {
  "deepseek/deepseek-v4.1-flash": { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0.3 },
  "z-ai/glm-5.3": { input: 1.4, output: 4.4, cacheRead: 0.3, cacheWrite: 1.4 },
  "moonshotai/kimi-k3.1-pro": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2 },
};

/** The OpenRouter id for each alias: OPENROUTER_<ALIAS>_MODEL, else the default. */
export function openrouterModels(): Record<ModelAlias, string> {
  const o = config.openrouter.models;
  return {
    haiku: o.haiku || DEFAULT_OPENROUTER_MODELS.haiku,
    sonnet: o.sonnet || DEFAULT_OPENROUTER_MODELS.sonnet,
    opus: o.opus || DEFAULT_OPENROUTER_MODELS.opus,
    fable: o.fable || o.opus || DEFAULT_OPENROUTER_MODELS.fable,
  };
}

/** Every price row: the defaults, with OPENROUTER_PRICES on top. */
function allPrices(): Record<string, Price> {
  return { ...DEFAULT_OPENROUTER_PRICES, ...parsePrices(config.openrouter.prices) };
}

export function provider(): Provider {
  return config.openrouter.apiKey ? "openrouter" : "anthropic";
}

/** The provider's name for messages to Paul: "the OpenRouter account is out of credit". */
export function providerName(): string {
  return provider() === "openrouter" ? "OpenRouter" : "Anthropic";
}

/** Where Paul tops up credit. */
export function creditUrl(): string {
  return provider() === "openrouter" ? "openrouter.ai/settings/credits" : "console.anthropic.com";
}

/** The secret Paul checks when the key is rejected. */
export function keyName(): string {
  return provider() === "openrouter" ? "OPENROUTER_API_KEY" : "ANTHROPIC_API_KEY";
}

function isAlias(model: string): model is ModelAlias {
  return (MODEL_ALIASES as readonly string[]).includes(model.toLowerCase());
}

/** The model id actually sent: an alias becomes its OpenRouter id; anything else passes through. */
export function resolveModel(model: string): string {
  if (provider() !== "openrouter" || !isAlias(model)) return model;
  return openrouterModels()[model.toLowerCase() as ModelAlias];
}

/**
 * Environment for the SDK subprocess. With OpenRouter: its endpoint, the key as a bearer token, the
 * Anthropic key explicitly empty (OpenRouter's documented setup), every alias the CLI resolves
 * internally (subagents, the small fast model behind WebFetch summaries) mapped too, and no
 * non-essential traffic to Anthropic.
 */
export function llmEnv(): Record<string, string> {
  if (provider() !== "openrouter") return {};
  const m = openrouterModels();
  return {
    ANTHROPIC_BASE_URL: OPENROUTER_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: config.openrouter.apiKey,
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: m.haiku,
    ANTHROPIC_DEFAULT_SONNET_MODEL: m.sonnet,
    ANTHROPIC_DEFAULT_OPUS_MODEL: m.opus,
    ANTHROPIC_SMALL_FAST_MODEL: m.haiku,
    CLAUDE_CODE_SUBAGENT_MODEL: m.haiku,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}

/** Gateway settings removed from a run pinned to Anthropic, whatever set them. */
export const DIRECT_STRIPPED = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "OPENROUTER_API_KEY",
];

/** Variables removed from the worker environment in OpenRouter mode (llmEnv supplies what is needed). */
export const LLM_STRIPPED = ["OPENROUTER_API_KEY", "OPENROUTER_PRICES"];

/** Price rows for the models in use, for the SDK's managed modelPricing setting. */
export function modelPrices(): Record<string, Price> {
  const rows = allPrices();
  const inUse = new Set(Object.values(openrouterModels()));
  return Object.fromEntries(Object.entries(rows).filter(([id]) => inUse.has(id)));
}

/** Models in use with no price row: their cost would be a guess, so the caps would be unreliable. */
export function unpricedModels(): string[] {
  if (provider() !== "openrouter") return [];
  const priced = allPrices();
  return [...new Set(Object.values(openrouterModels()))].filter((id) => !priced[id]);
}

/** Settings handed to the SDK as managed settings, or undefined on Anthropic (list prices apply). */
export function llmManagedSettings(): { modelPricing: { overrides: Record<string, Price> } } | undefined {
  if (provider() !== "openrouter") return undefined;
  return { modelPricing: { overrides: modelPrices() } };
}

/** Parses OPENROUTER_PRICES. Bad rows are dropped (and reported through `warn`) rather than stopping the service. */
export function parsePrices(raw: string | undefined, warn: (m: string) => void = () => undefined): Record<string, Price> {
  if (!raw?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warn("OPENROUTER_PRICES is not valid JSON; ignored.");
    return {};
  }
  const out: Record<string, Price> = {};
  if (!parsed || typeof parsed !== "object") return out;
  for (const [id, row] of Object.entries(parsed as Record<string, unknown>)) {
    const r = row as Partial<Price> | null;
    const ok = r && (["input", "output", "cacheRead", "cacheWrite"] as const).every((k) => typeof r[k] === "number" && r[k]! >= 0 && r[k]! <= 10000);
    if (ok) out[id] = r as Price;
    else warn(`OPENROUTER_PRICES row for ${id} needs input, output, cacheRead and cacheWrite (USD per million tokens); ignored.`);
  }
  return out;
}

/** One start-up log line: the provider, the model per alias, and any model whose cost would be a guess. */
export function modelLine(): string {
  if (provider() !== "openrouter") return "Models: Anthropic API.";
  const m = openrouterModels();
  const bad: string[] = [];
  parsePrices(config.openrouter.prices, (w) => bad.push(w));
  const unpriced = unpricedModels();
  return [
    `Models: OpenRouter (haiku=${m.haiku}, sonnet=${m.sonnet}, opus=${m.opus}).`,
    ...bad,
    ...(process.env.ANTHROPIC_API_KEY ? [`Executive assistant: ${config.models.ea} on Anthropic.`] : ["ANTHROPIC_API_KEY is not set, so executive assistant jobs will fail: they run only on Anthropic."]),
    ...(unpriced.length ? [`No price for ${unpriced.join(", ")}: set OPENROUTER_PRICES or the per-run caps and the estimate fall back to a guess (the daily cap uses OpenRouter's own usage figures).`] : []),
  ].join(" ");
}

/**
 * Which provider and model one job runs on. Paul's call (13 Nov 2026): the executive assistant stays on
 * Claude Sonnet on Anthropic's API directly; follow-up work ("Draft nudge <id>" jobs) and everything
 * else uses the default provider (open models on OpenRouter when its key is set).
 */
export function runRoute(job: { kind: string; title?: string }, specModel: string): { model: string; provider?: "anthropic" } {
  if (job.kind !== "ea") return { model: specModel };
  if (isFollowUpJob(job)) return { model: config.models.worker };
  return { model: config.models.ea, provider: "anthropic" };
}

/** A follow-up job: the drafted nudge for one follow-up, started by `draft nudge <id>`. */
export function isFollowUpJob(job: { kind: string; title?: string }): boolean {
  return job.kind === "ea" && /^Draft nudge \S+$/.test(job.title ?? "");
}

/**
 * What the chief is told about the models, so it can answer "which model are you using?" from the
 * truth rather than from a stale reading of the code.
 */
export function modelNote(): string {
  if (provider() !== "openrouter") {
    const gw = process.env.ANTHROPIC_BASE_URL;
    return `\n\nModels: Anthropic API${gw ? ` through ANTHROPIC_BASE_URL ${gw}` : ""}; the chief, workers, engineers and designer use the aliases ${config.models.chief}, ${config.models.worker}, ${config.models.engineer} and ${config.design.model}; the executive assistant uses ${config.models.ea}.`;
  }
  const m = openrouterModels();
  const alias = (a: string) => (isAlias(a) ? `${a} (${m[a.toLowerCase() as ModelAlias]})` : a);
  return `\n\nModels: OpenRouter (src/llm.ts, OPENROUTER_API_KEY set). The aliases in the config are mapped to OpenRouter models by the code: chief ${alias(config.models.chief)}, workers ${alias(config.models.worker)}, engineers and maintainer ${alias(config.models.engineer)}, designer ${alias(config.design.model)}. The executive assistant runs on ${config.models.ea} on Anthropic's API directly, except "Draft nudge" follow-up jobs, which use the worker model. Claude Code's own background calls are mapped too. Nothing here needs changing to "use OpenRouter"; it already does.`;
}
