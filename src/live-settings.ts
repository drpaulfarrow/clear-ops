/**
 * The few settings Paul changes from the web app's Spend page (docs/APP.md): the daily cap, the
 * per-job caps, and which model each role runs on.
 *
 * These were deploy-time only (`fly.toml`), so trimming spend meant a pull request and a redeploy.
 * Paul asked to change them from the app. What he sets is kept in the store and laid over the deploy's
 * own values: the rest of the service goes on reading `config` exactly as before and simply finds the
 * new value there. Clearing a setting puts the deploy's own value back.
 *
 * What keeps it narrow:
 *  - Seven settings and no more: three caps and four roles' models. Nothing here reaches a secret, a
 *    provider, an allowlist, a gate or the executive assistant, which always runs on Claude.
 *  - A cap is a plain amount within fixed bounds. A model is one of the four aliases the deploy already
 *    maps to a model (src/llm.ts), never a free-text model id.
 *  - Only the app's own route writes it (`POST /app/api/settings`), signed in and from this site's own
 *    script. No agent, command word or chat message can.
 *  - `config` is touched only for a setting that has been changed here, so a deploy with nothing set
 *    behaves exactly as it did.
 */
import { config } from "./config.js";
import { MODEL_ALIASES, openrouterModels, provider, type ModelAlias } from "./llm.js";
import type { Settings, Store } from "./store.js";

export const LIVE_CAPS = ["dailyBudgetUsd", "engineerBudgetUsd", "jobBudgetUsd"] as const;
export type LiveCap = (typeof LIVE_CAPS)[number];
export const LIVE_ROLES = ["chief", "worker", "engineer", "maintainer"] as const;
export type LiveRole = (typeof LIVE_ROLES)[number];
/** The least and the most a cap may be set to from the app, in USD. */
export const LIVE_CAP_MIN = 0.5;
export const LIVE_CAP_MAX = 500;

type Live = NonNullable<Settings["live"]>;

/** What `config` held before the app first changed each setting, so clearing one puts that back. */
const deployed: { caps: Partial<Record<LiveCap, number | undefined>>; models: Partial<Record<LiveRole, string>> } = { caps: {}, models: {} };
const capTouched = new Set<LiveCap>();

const isAlias = (v: unknown): v is ModelAlias => typeof v === "string" && (MODEL_ALIASES as readonly string[]).includes(v);

/** A cap as the app may set it: a finite amount within the bounds, to the cent. */
function capValue(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  const cents = Math.round(v * 100) / 100;
  return cents >= LIVE_CAP_MIN && cents <= LIVE_CAP_MAX ? cents : undefined;
}

/** What the store holds, with anything malformed dropped. */
function stored(store: Pick<Store, "settings">): Live {
  const raw = store.settings().live ?? {};
  const out: Live = {};
  for (const cap of LIVE_CAPS) {
    const v = capValue(raw[cap]);
    if (v !== undefined) out[cap] = v;
  }
  const models: NonNullable<Live["models"]> = {};
  for (const role of LIVE_ROLES) if (isAlias(raw.models?.[role])) models[role] = raw.models![role];
  if (Object.keys(models).length) out.models = models;
  return out;
}

/** Lays what the store holds over `config`. Called at start-up and after every change. */
export function applyLive(store: Pick<Store, "settings">): void {
  const live = stored(store);
  for (const cap of LIVE_CAPS) {
    if (live[cap] !== undefined) {
      if (!capTouched.has(cap)) {
        deployed.caps[cap] = config[cap];
        capTouched.add(cap);
      }
      config[cap] = live[cap];
    } else if (capTouched.has(cap)) {
      config[cap] = deployed.caps[cap];
      capTouched.delete(cap);
    }
  }
  for (const role of LIVE_ROLES) {
    const set = live.models?.[role];
    if (set !== undefined) {
      if (!(role in deployed.models)) deployed.models[role] = config.models[role];
      config.models[role] = set;
    } else if (role in deployed.models) {
      config.models[role] = deployed.models[role]!;
      delete deployed.models[role];
    }
  }
}

/** A refusal in words for Paul. */
export class LiveSettingError extends Error {}

/**
 * One change from the app: a cap to an amount, a role to an alias, or either back to the deploy's own
 * (`null`). Returns what to tell Paul. Throws for anything else, and nothing is changed.
 */
export function setLive(store: Pick<Store, "settings" | "setSetting">, key: unknown, value: unknown): string {
  const live = stored(store);
  if (typeof key === "string" && (LIVE_CAPS as readonly string[]).includes(key)) {
    const cap = key as LiveCap;
    if (value === null) delete live[cap];
    else {
      const v = capValue(value);
      if (v === undefined) throw new LiveSettingError(`A cap is an amount between $${LIVE_CAP_MIN.toFixed(2)} and $${LIVE_CAP_MAX.toFixed(2)}.`);
      live[cap] = v;
    }
    store.setSetting("live", live);
    applyLive(store);
    const now = config[cap];
    const amount = now === undefined ? "off" : `$${now.toFixed(2)}`;
    return value === null ? `${CAP_NAMES[cap]} is back to the deploy's own setting: ${amount}.` : `${CAP_NAMES[cap]} is now ${amount}. Changed from the app.`;
  }
  const role = typeof key === "string" && key.startsWith("model:") ? key.slice(6) : "";
  if ((LIVE_ROLES as readonly string[]).includes(role)) {
    const models = { ...(live.models ?? {}) };
    if (value === null) delete models[role as LiveRole];
    else {
      if (!isAlias(value) || !liveModelChoices().some((c) => c.alias === value)) throw new LiveSettingError("That is not one of the models this deploy has.");
      models[role as LiveRole] = value;
    }
    if (Object.keys(models).length) live.models = models;
    else delete live.models;
    store.setSetting("live", live);
    applyLive(store);
    const now = config.models[role as LiveRole];
    const verb = role === "worker" || role === "engineer" ? "run" : "runs";
    return value === null
      ? `${ROLE_NAMES[role as LiveRole]} ${verb === "run" ? "are" : "is"} back on the deploy's own model: ${modelWords(now)}. It applies to the next run.`
      : `${ROLE_NAMES[role as LiveRole]} now ${verb} on ${modelWords(now)}. Changed from the app. It applies to the next run, not to one already going.`;
  }
  throw new LiveSettingError("There is no such setting.");
}

const CAP_NAMES: Record<LiveCap, string> = { dailyBudgetUsd: "The daily cap", engineerBudgetUsd: "The cap on one engineering or review job", jobBudgetUsd: "The cap on any other job" };
const ROLE_NAMES: Record<LiveRole, string> = { chief: "The chief", worker: "Researchers and other workers", engineer: "Engineers", maintainer: "The maintainer" };

/** An alias with the model it stands for on this deploy: "haiku (deepseek/deepseek-v4.1-flash)". */
function modelWords(alias: string): string {
  if (provider() !== "openrouter" || !isAlias(alias)) return alias;
  return `${alias} (${openrouterModels()[alias]})`;
}

/** The models a role may be put on: the aliases, each with what it is on this deploy. */
export function liveModelChoices(): Array<{ alias: ModelAlias; model: string }> {
  const open = provider() === "openrouter" ? openrouterModels() : undefined;
  const seen = new Set<string>();
  return MODEL_ALIASES.flatMap((alias) => {
    const model = open ? open[alias] : alias;
    // Two aliases for the same model are one choice (fable falls back to opus when it is not set).
    if (!model || seen.has(model)) return [];
    seen.add(model);
    return [{ alias, model }];
  });
}

export interface LiveView {
  caps: Array<{ key: LiveCap; name: string; usd?: number; changed: boolean; min: number; max: number }>;
  roles: Array<{ key: string; name: string; alias: string; model: string; changed: boolean }>;
  choices: Array<{ alias: string; model: string }>;
}

/** What the Spend page shows of the settings: each one's value now, and whether the app changed it. */
export function liveView(store: Pick<Store, "settings">): LiveView {
  const live = stored(store);
  const open = provider() === "openrouter" ? openrouterModels() : undefined;
  return {
    caps: LIVE_CAPS.map((key) => ({ key, name: CAP_NAMES[key], ...(config[key] !== undefined ? { usd: config[key] } : {}), changed: live[key] !== undefined, min: LIVE_CAP_MIN, max: LIVE_CAP_MAX })),
    roles: LIVE_ROLES.map((role) => {
      const alias = config.models[role];
      return { key: `model:${role}`, name: ROLE_NAMES[role], alias, model: open && isAlias(alias) ? open[alias] : alias, changed: live.models?.[role] !== undefined };
    }),
    choices: liveModelChoices(),
  };
}
