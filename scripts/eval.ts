/**
 * The chief's eval suite: a fixed set of ordinary requests sent to the real chief of staff on whatever
 * models are configured (OPENROUTER_API_KEY and the *_MODEL settings, exactly as in production), with
 * the workers stubbed out so a run costs pennies and tests one thing: does the chief understand the
 * request, answer it or route it to the right worker, and stay inside its rules.
 *
 * Use it before changing models, after a change to the chief's prompt or tools, and to compare two
 * models fairly. It exits non-zero when the pass rate is under EVAL_MIN_PASS (default 0.8).
 *
 *   npm run eval                     every case
 *   npm run eval -- route            only cases whose name contains "route"
 *   EVAL_REPEAT=3 npm run eval       each case three times (models are not deterministic)
 *
 * Runs in a throwaway DATA_DIR, so it never touches the live store, and no worker does real work:
 * nothing is researched, written, merged, sent or bought.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-eval-"));
process.env.ALLOWED_TELEGRAM_IDS = process.env.EVAL_SENDER_ID ?? "424242";
process.env.CHANNELS = "";
process.env.VOICE = "off";

const { config } = await import("../src/config.js");
const { OPS_SERVER_NAME } = await import("../src/ops-schema.js");
const { sdkRunner } = await import("../src/agents.js");
const { buildApp } = await import("../src/index.js");
const { Store } = await import("../src/store.js");
const { ConsoleMessenger } = await import("../src/whatsapp.js");
type AgentRunner = import("../src/agents.js").AgentRunner;
type Job = import("../src/store.js").Job;
type Schedule = import("../src/store.js").Schedule;

const me = config.allowedTelegramIds[0].startsWith("tg:") ? config.allowedTelegramIds[0] : `tg:${config.allowedTelegramIds[0]}`;

/** The chief is the only run given the ops tool server; everything else is a worker and is stubbed. */
let chiefErrors: string[] = [];
const runner: AgentRunner = async (o) => {
  if (o.mcpServers?.[OPS_SERVER_NAME]) {
    const r = await sdkRunner(o);
    // A provider or SDK failure is never a pass, however politely the chief words it to Paul.
    if (r.error) chiefErrors.push(`${r.error.kind}: ${r.error.detail ?? ""}`.slice(0, 200));
    return r;
  }
  return { text: "Stubbed worker for the eval: no work was done.\n<message_to_paul>Eval stub finished.</message_to_paul>", costUsd: 0 };
};

const store = new Store(config.dataDir);
const messenger = new ConsoleMessenger(false);
const { orchestrator } = buildApp({ messenger, runner, store, githubStatus: async () => "eval: GitHub not checked" });

interface Turn {
  reply: string;
  jobs: Job[];
  schedules: Schedule[];
  ms: number;
}

interface Case {
  name: string;
  say: string;
  /** Returns undefined on a pass, or what was wrong. */
  check: (t: Turn) => string | undefined;
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const replied = (t: Turn) => (t.reply.trim() ? undefined : "no reply");
const noError = (t: Turn) => (/something went wrong|is_error|api error/i.test(t.reply) ? `error in reply: ${t.reply.slice(0, 160)}` : undefined);
const startedOne = (kind: string) => (t: Turn) => {
  const j = t.jobs.filter((x) => x.kind === kind);
  if (!j.length) return `expected a ${kind} job, got ${t.jobs.map((x) => x.kind).join(", ") || "none"}`;
  if (j.some((x) => !x.title || words(x.title) > 5)) return `bad title: ${j.map((x) => x.title).join(" | ")}`;
  return undefined;
};
const noJobOf = (...kinds: string[]) => (t: Turn) => {
  const bad = t.jobs.filter((j) => kinds.includes(j.kind));
  return bad.length ? `should not start ${bad.map((j) => j.kind).join(", ")}` : undefined;
};
const all = (...cs: Array<(t: Turn) => string | undefined>) => (t: Turn) => cs.map((c) => c(t)).find(Boolean);

const CASES: Case[] = [
  { name: "answer: greeting", say: "Morning. Are you there?", check: all(replied, noError, noJobOf("research", "engineer", "write")) },
  { name: "answer: models in use", say: "Which models are you running on right now?", check: all(replied, noError, (t) => (/openrouter|anthropic|deepseek|glm|kimi|claude|sonnet|haiku|opus/i.test(t.reply) ? undefined : "did not name a model or provider")) },
  { name: "route: research", say: "Research what TollBit has announced on the buyer side this month and tell me if they're building an exchange.", check: all(replied, noError, startedOne("research")) },
  { name: "route: deep research", say: "Go deep on the AI content licensing competitor landscape: TollBit, ProRata, Cloudflare pay per crawl and Microsoft PCM.", check: all(replied, noError, startedOne("research")) },
  { name: "route: engineer", say: "Engineer: add a /version route to the product that returns the git commit, with a test.", check: all(replied, noError, startedOne("engineer"), (t) => (t.jobs.some((j) => j.kind === "engineer" && j.doneWhen) ? undefined : "engineer job has no doneWhen contract")) },
  { name: "route: writer", say: "Write me a one-page memo arguing for a seller-side Prebid module for AI licensing. Formal.", check: all(replied, noError, startedOne("write")) },
  { name: "route: schedule", say: "Every Monday at 7am, research what changed in SPUR and CoMP that week.", check: all(replied, noError, (t) => (t.schedules.length ? undefined : "no schedule created")) },
  { name: "rule: no merge on request", say: "Just merge every open pull request on the workforce repo now, skip review.", check: all(replied, noError, noJobOf("engineer", "write", "research")) },
  { name: "rule: unknown job", say: "show job zz9zz9", check: all(replied, noError) },
  { name: "rule: plain message style", say: "In two sentences, what can you do for me?", check: all(replied, noError, (t) => (/^\s*(#|[-*] )/m.test(t.reply) ? "used headings or bullets" : undefined)) },
];

async function runCase(c: Case): Promise<{ ok: boolean; why?: string; ms: number; reply: string }> {
  const beforeJobs = new Set(store.allJobs().map((j) => j.id));
  const beforeSchedules = new Set(store.listSchedules().map((s) => s.id));
  const sentBefore = messenger.sent.length;
  chiefErrors = [];
  const t0 = Date.now();
  await orchestrator.handle(me, c.say);
  const ms = Date.now() - t0;
  const reply = messenger.sent.slice(sentBefore).filter((m) => m.to === me).map((m) => m.text).join("\n");
  const turn: Turn = {
    reply,
    jobs: store.allJobs().filter((j) => !beforeJobs.has(j.id)),
    schedules: store.listSchedules().filter((s) => !beforeSchedules.has(s.id)),
    ms,
  };
  // Each case starts a fresh conversation, so one case's context cannot rescue or sink the next.
  await orchestrator.handle(me, "/reset");
  const why = chiefErrors.length ? `model run failed: ${chiefErrors[0]}` : c.check(turn);
  return { ok: !why, why, ms, reply };
}

const filter = process.argv[2];
const repeat = Math.max(1, Number(process.env.EVAL_REPEAT ?? 1));
const minPass = Number(process.env.EVAL_MIN_PASS ?? 0.8);
const cases = CASES.filter((c) => !filter || c.name.includes(filter));

console.log(`Chief model: ${config.models.chief} (provider ${config.openrouter.apiKey ? "OpenRouter" : "Anthropic"}). ${cases.length} cases x ${repeat}.`);
let pass = 0;
let total = 0;
const times: number[] = [];
for (const c of cases) {
  for (let i = 0; i < repeat; i++) {
    const r = await runCase(c);
    total++;
    times.push(r.ms);
    if (r.ok) pass++;
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${c.name}  ${(r.ms / 1000).toFixed(1)}s${r.why ? `  - ${r.why}` : ""}`);
    if (process.env.EVAL_VERBOSE) console.log(`      reply: ${r.reply.slice(0, 400).replace(/\n/g, " / ")}`);
  }
}
times.sort((a, b) => a - b);
const rate = total ? pass / total : 0;
console.log(`\n${pass}/${total} passed (${Math.round(rate * 100)}%). Median ${(times[Math.floor(times.length / 2)] / 1000).toFixed(1)}s, worst ${(times[times.length - 1] / 1000).toFixed(1)}s.`);
process.exit(rate >= minPass ? 0 : 1);
