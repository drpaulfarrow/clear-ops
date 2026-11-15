/**
 * Lifting a credit or key hold by itself (Paul's call, 15 Nov 2026: "I don't want to have to hit resume
 * in those scenarios").
 *
 * When a job fails because the provider account is out of credit or the key is refused, the service
 * holds the engineering queues (src/jobs.ts) so queued jobs are not burned one after another. This
 * checks, on a backing-off timer, whether the provider would now really answer: one real request for a
 * single token on the same provider the failed job used, the cheapest thing that fails on no credit
 * (a key check alone would pass on an empty account). When it answers, the runner resumes exactly as
 * /resume does. /resume still works at any time.
 */
import { OPENROUTER_BASE_URL, resolveModel } from "./llm.js";
import { config } from "./config.js";

/** Minutes between checks while a hold lasts: soon at first, then every half hour. */
export const AUTO_RESUME_BACKOFF_MIN = [2, 5, 10, 15, 30];

export type CanaryProvider = "openrouter" | "anthropic";

/** Whether the provider would answer a real request now. Never throws. */
export type Canary = (provider: CanaryProvider) => Promise<{ ok: boolean; detail: string }>;

/** When the next check is due, given when the hold began and how many checks have failed since. */
export function nextCheckAt(lastAt: number, attempts: number): number {
  const mins = AUTO_RESUME_BACKOFF_MIN[Math.min(attempts, AUTO_RESUME_BACKOFF_MIN.length - 1)];
  return lastAt + mins * 60_000;
}

async function bounded(p: Promise<Response>, ms: number): Promise<Response> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("no answer in time")), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/** The real canary: one single-token request on the provider's cheapest configured model. */
export function defaultCanary(fetchImpl: typeof fetch = fetch, timeoutMs = 20_000): Canary {
  return async (provider) => {
    try {
      if (provider === "openrouter") {
        const key = config.openrouter.apiKey;
        if (!key) return { ok: false, detail: "no OpenRouter key is set" };
        const res = await bounded(
          fetchImpl(`${OPENROUTER_BASE_URL}/v1/chat/completions`, {
            method: "POST",
            headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
            body: JSON.stringify({ model: resolveModel("haiku"), max_tokens: 1, messages: [{ role: "user", content: "ok" }] }),
          }),
          timeoutMs,
        );
        return { ok: res.ok, detail: `OpenRouter answered ${res.status}` };
      }
      const key = config.anthropic.apiKey;
      if (!key) return { ok: false, detail: "no Anthropic key is set" };
      const headers = { "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" };
      // The key's own model list names a model it may call; the smallest one is used for the test.
      const list = await bounded(fetchImpl("https://api.anthropic.com/v1/models?limit=50", { headers }), timeoutMs);
      if (!list.ok) return { ok: false, detail: `Anthropic answered ${list.status}` };
      const ids = ((await list.json().catch(() => ({}))) as { data?: Array<{ id?: string }> }).data?.map((m) => m.id ?? "").filter(Boolean) ?? [];
      const model = ids.find((id) => /haiku/i.test(id)) ?? ids[0];
      if (!model) return { ok: false, detail: "Anthropic listed no models" };
      const res = await bounded(
        fetchImpl("https://api.anthropic.com/v1/messages", { method: "POST", headers, body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "ok" }] }) }),
        timeoutMs,
      );
      return { ok: res.ok, detail: `Anthropic answered ${res.status}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  };
}
