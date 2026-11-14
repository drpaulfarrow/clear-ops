/**
 * Retrieval as a harness decision (src/retrieval.ts, slice 5 of Paul's efficiency brief).
 * Everything here runs offline: the decision step is fed canned model replies and the searches and
 * page fetches are fixtures, so the decision, the policy, the budget and the evidence are all tested
 * without a network call.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-retrieval-"));
process.env.OPENROUTER_API_KEY = "or-key-for-retrieval-tests";
process.env.ANTHROPIC_API_KEY = "anthropic-key-for-retrieval-tests";

const { config } = await import("../src/config.js");
const { OPENROUTER_BASE_URL, openrouterModels } = await import("../src/llm.js");
const { Store } = await import("../src/store.js");
const R = await import("../src/retrieval.js");

const BRAVE = "brave-key-retrieval";
const EXA = "exa-key-retrieval";
const NOW = () => new Date("2026-11-14T09:00:00.000Z");

/** The keys are on for these tests: both engines are configured. */
function withKeys() {
  config.search.braveKey = BRAVE;
  config.search.exaKey = EXA;
}

const result = (title: string, url: string, snippet = "snippet") => ({ title, url, snippet });

/** No test here touches the network: a page fetch is canned wherever the test is not about fetching. */
const noFetch = async (url: string) => `canned page text for ${url}`;

/**
 * The fixture set: a request, the canned reply the decision step would give, and what the harness
 * should do with it. No network, so the parse, the local rules and the policy are what is tested.
 */
const FIXTURES: Array<{ name: string; request: string; reply: string; expect: boolean }> = [
  {
    name: "a stale-prone fact (a version and a release date)",
    request: "What is the latest version of Prebid.js, and when was it released?",
    reply: '{"needs_retrieval": true, "engine": "brave", "queries": ["Prebid.js latest version release"], "reason": "versions and dates change"}',
    expect: true,
  },
  {
    name: "a question about our own code",
    request: "What does the retrieval step do in our repository?",
    reply: '{"needs_retrieval": true, "engine": "brave", "queries": ["clear-ops retrieval step"], "reason": "the model would search"}',
    expect: false,
  },
  {
    name: "a drafting request with everything supplied",
    request: "Draft a two-line email to Sam saying half a cent per retrieval works.",
    reply: '{"needs_retrieval": false, "engine": "brave", "queries": [], "reason": "drafting, everything is in the message"}',
    expect: false,
  },
  {
    name: "an obvious no-retrieval case (arithmetic)",
    request: "What is 12 times 12?",
    reply: '{"needs_retrieval": false, "engine": "brave", "queries": [], "reason": "arithmetic"}',
    expect: false,
  },
];

test("the decision step retrieves only when the answer needs outside facts", async () => {
  withKeys();
  for (const f of FIXTURES) {
    let called = 0;
    const outcome = await R.retrieve(f.request, {
      decide: async () => {
        called += 1;
        return R.parseDecision(f.reply);
      },
      search: async () => [result("Source", "https://example.test/a")],
      fetchPage: noFetch,
      now: NOW,
    });
    assert.equal(outcome.record.decision.needsRetrieval, f.expect, `${f.name}: needsRetrieval`);
    // A local rule settles the workforce question and the command without a model call at all.
    if (f.name === "a question about our own code") {
      assert.equal(called, 0, "the local rule must not pay for a model call");
      assert.equal(outcome.record.decision.source, "rule");
      assert.match(outcome.record.decision.reason, /this workforce/);
    } else {
      assert.equal(called, 1, `${f.name}: one short model call`);
    }
  }
});

test("a command, a greeting and a job by id are settled by the local rule, with no model call", async () => {
  withKeys();
  for (const request of ["/jobs", "thanks", "what is the status of job 3fa9c1", "show job 3fa9c1 output", "what's on the board"]) {
    let called = 0;
    const outcome = await R.retrieve(request, {
      decide: async () => {
        called += 1;
        return R.parseDecision('{"needs_retrieval": true, "engine": "brave", "queries": ["x"], "reason": "would search"}');
      },
      now: NOW,
    });
    assert.equal(called, 0, `${request}: no model call`);
    assert.equal(outcome.record.decision.needsRetrieval, false, `${request}: no retrieval`);
    assert.equal(outcome.record.decision.source, "rule");
  }
});

test("the harness budget refuses the fourth search, and says so in the record", async () => {
  withKeys();
  const queries = ["one", "two", "three"];
  let ran = 0;
  const outcome = await R.retrieve("compare the latest prices and releases of three vendors", {
    decide: async () => ({ needsRetrieval: true, engine: "both", queries, reason: "current facts", source: "model" }),
    search: async () => {
      ran += 1;
      return [result(`r${ran}`, `https://example.test/${ran}`)];
    },
    fetchPage: noFetch,
    now: NOW,
  });
  assert.equal(outcome.record.searches.length, config.retrieval.maxSearches, "only the budget's worth of searches ran");
  assert.equal(ran, config.retrieval.maxSearches);
  assert.ok(outcome.record.refusals.some((r) => /budget:.*refused/.test(r)), "the refusal is recorded, not silent");
  assert.match(outcome.evidence, /The harness also refused, within its budget/);
});

test("the second engine is tried once when the first finds nothing", async () => {
  withKeys();
  const seen: string[] = [];
  const outcome = await R.retrieve("What is the latest Prebid.js release?", {
    decide: async () => ({ needsRetrieval: true, engine: "brave", queries: ["Prebid.js latest release"], reason: "a release changes", source: "model" }),
    search: async (engine) => {
      seen.push(engine);
      return engine === "exa" ? [result("Prebid 11.50", "https://github.com/prebid/Prebid.js/releases")] : [];
    },
    fetchPage: noFetch,
    now: NOW,
  });
  assert.deepEqual(seen, ["brave", "exa"], "the other engine runs exactly once");
  assert.equal(outcome.record.searches.length, 2);
  assert.equal(outcome.record.searches[1].retryOf, "brave");
  assert.match(outcome.evidence, /Prebid 11\.50/);
});

test("an empty search is reported as empty, not filled in", async () => {
  withKeys();
  const outcome = await R.retrieve("What did TollBit announce last week?", {
    decide: async () => ({ needsRetrieval: true, engine: "brave", queries: ["TollBit announcement"], reason: "news", source: "model" }),
    search: async () => [],
    now: NOW,
  });
  assert.match(outcome.evidence, /found nothing/);
  assert.match(outcome.evidence, /rather than filling the gap from memory/);
  assert.doesNotMatch(outcome.evidence, /^\s*\d+\.\s/m, "no invented result is listed");
});

test("one source returned by two queries is listed once, not as two agreeing sources", async () => {
  withKeys();
  const outcome = await R.retrieve("Compare the latest Prebid.js release and the latest Prebid Server release.", {
    decide: async () => ({
      needsRetrieval: true,
      engine: "brave",
      queries: ["Prebid.js latest release", "Prebid Server latest release"],
      reason: "releases change",
      source: "model",
    }),
    search: async () => [result("Prebid releases", "https://github.com/prebid/Prebid.js/releases"), result("Prebid", "https://prebid.org")],
    fetchPage: noFetch,
    now: NOW,
  });
  assert.equal(outcome.record.searches.length, 2, "both queries ran");
  const listed = outcome.evidence.match(/https:\/\/github\.com\/prebid\/Prebid\.js\/releases/g) ?? [];
  assert.equal(listed.length, 1, "the shared URL appears once");
  assert.match(outcome.evidence, /2\. Prebid\n   https:\/\/prebid\.org/, "the other result still follows");
});

test("a search that fails is reported as a failure, never as a fact", async () => {
  withKeys();
  const outcome = await R.retrieve("What is the latest Prebid.js release?", {
    decide: async () => ({ needsRetrieval: true, engine: "brave", queries: ["Prebid.js latest release"], reason: "a release changes", source: "model" }),
    search: async () => {
      throw new Error(`Brave search failed: HTTP 401: invalid token ${BRAVE}`);
    },
    now: NOW,
  });
  assert.ok(outcome.record.searches.every((s) => s.error), "the failure is on the record");
  assert.match(outcome.evidence, /search failed/);
  assert.match(outcome.evidence, /say plainly that the search could not be run/);
  assert.ok(!outcome.evidence.includes(BRAVE), "the key is scrubbed");
});

test("a provider failure in the decision step surfaces as a plain message, not an invented fact", async () => {
  withKeys();
  const outcome = await R.retrieve("What is the latest Prebid.js release?", {
    decide: async () => {
      throw new Error(`HTTP 429: ${config.openrouter.apiKey}`);
    },
    now: NOW,
  });
  assert.equal(outcome.record.decision.source, "error");
  assert.match(outcome.record.error ?? "", /429/);
  assert.ok(!(outcome.record.error ?? "").includes(config.openrouter.apiKey), "the key is scrubbed");
  assert.equal(outcome.record.searches.length, 0, "nothing was searched");
  assert.match(outcome.evidence, /could not check whether a web search was needed/);
  assert.match(outcome.evidence, /may be out of date/);
});

test("the decision call is one short, tool-free completion on the cheap tier", async () => {
  withKeys();
  const calls: Array<{ url: string; init: any }> = [];
  const fetcher = async (url: string, init: any) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '{"needs_retrieval": false, "engine": "brave", "queries": [], "reason": "no"}' } }] }),
      text: async () => "",
    };
  };
  const outcome = await R.retrieve("Summarise this paragraph I just wrote about pricing.", { fetcher: fetcher as never, now: NOW });
  assert.equal(outcome.record.decision.needsRetrieval, false);
  assert.equal(calls.length, 1, "exactly one model call");
  assert.equal(calls[0].url, `${OPENROUTER_BASE_URL}/v1/chat/completions`);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${config.openrouter.apiKey}`);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, openrouterModels().haiku, "the cheapest configured model");
  assert.ok(body.max_tokens <= 400, "a short answer");
  assert.equal(body.tools, undefined, "no tool use");
  assert.equal(body.messages.length, 2, "one small system prompt and the request");
  assert.equal(outcome.record.model, "haiku");
});

test("engine policy is code: Brave for news and releases, Exa for entities and lookalikes", () => {
  assert.equal(R.engineFor("latest Prebid.js release version"), "brave");
  assert.equal(R.engineFor("TollBit pricing"), "brave");
  assert.equal(R.engineFor("companies like TollBit"), "exa");
  assert.equal(R.engineFor("who is the CTO of ProRata"), "exa");
  assert.equal(R.engineFor("research papers on content licensing"), "exa");
  // The code's policy wins over the model's proposal, and the override is recorded.
  withKeys();
  const plan = R.planQueries({ needsRetrieval: true, engine: "exa", queries: ["latest Prebid release"], reason: "", source: "model" });
  assert.deepEqual(plan, [{ engine: "brave", query: "latest Prebid release" }]);
});

test("the engine override is recorded when the model's proposal differs from the policy", async () => {
  withKeys();
  const outcome = await R.retrieve("What is the latest Prebid.js release?", {
    decide: async () => ({ needsRetrieval: true, engine: "exa", queries: ["latest Prebid.js release"], reason: "x", source: "model" }),
    search: async () => [result("Prebid", "https://prebid.org")],
    fetchPage: noFetch,
    now: NOW,
  });
  assert.ok(outcome.record.refusals.some((r) => /engine policy/.test(r)));
});

test("a page is fetched only when a figure, a quote or a date matters, and at most twice", async () => {
  withKeys();
  const fetched: string[] = [];
  const decision = { needsRetrieval: true as const, engine: "brave" as const, queries: ["Prebid.js release notes"], reason: "dates", source: "model" as const };
  const outcome = await R.retrieve("What is the latest Prebid.js version and its release date?", {
    decide: async () => decision,
    search: async () => [result("a", "https://example.test/a"), result("b", "https://example.test/b"), result("c", "https://example.test/c")],
    fetchPage: async (url) => {
      fetched.push(url);
      return "the page text";
    },
    now: NOW,
  });
  assert.equal(fetched.length, config.retrieval.maxFetches, "at most two page fetches");
  assert.equal(outcome.record.fetches.length, config.retrieval.maxFetches);
  assert.ok(outcome.record.refusals.some((r) => /page fetches per turn/.test(r)), "the refusal is recorded");
  assert.match(outcome.evidence, /read in full/);

  // No figure, quote or date in the request: nothing is fetched at all.
  const quiet = await R.retrieve("Tell me about TollBit", {
    decide: async () => ({ needsRetrieval: true, engine: "exa", queries: ["TollBit"], reason: "entity", source: "model" }),
    search: async () => [result("TollBit", "https://tollbit.com")],
    fetchPage: async () => {
      throw new Error("must not be fetched");
    },
    now: NOW,
  });
  assert.equal(quiet.record.fetches.length, 0);
});

test("the decision step never runs on a strong model, the designer or the assistant", () => {
  const original = config.retrieval.model;
  try {
    for (const asked of ["sonnet", "opus", "fable", config.models.ea]) {
      config.retrieval.model = asked;
      assert.equal(R.retrievalModel(), "haiku", `${asked} is refused`);
      assert.match(R.retrievalModelNote() ?? "", /cheap tier/);
    }
    config.retrieval.model = "deepseek/deepseek-v4.1-flash";
    assert.equal(R.retrievalModel(), "deepseek/deepseek-v4.1-flash", "a deliberately cheap full id is allowed");
    config.retrieval.model = "";
    assert.equal(R.retrievalModel(), "haiku");
  } finally {
    config.retrieval.model = original;
  }
});

test("the record holds the decision, never the request text", async () => {
  withKeys();
  const secret = "SECRET-MAIL-MARKER";
  const outcome = await R.retrieve(`${secret} what is the latest Prebid.js version?`, {
    decide: async () => ({ needsRetrieval: true, engine: "brave", queries: ["Prebid.js latest version"], reason: "versions change", source: "model" }),
    search: async () => [result("Prebid", "https://prebid.org")],
    fetchPage: noFetch,
    now: NOW,
  });
  const json = JSON.stringify(outcome.record);
  assert.ok(!json.includes(secret), "the request is never stored");
  assert.deepEqual(Object.keys(outcome.record).sort(), ["at", "decision", "fetches", "model", "refusals", "searches"]);
  assert.deepEqual(Object.keys(outcome.record.decision).sort(), ["engine", "needsRetrieval", "queries", "reason", "source"]);
});

test("a decision with no queries retrieves nothing and says why", async () => {
  withKeys();
  const outcome = await R.retrieve("What is the latest Prebid.js release?", {
    decide: async () => ({ needsRetrieval: true, engine: "brave", queries: [], reason: "yes", source: "model" }),
    now: NOW,
  });
  assert.equal(outcome.record.decision.needsRetrieval, false);
  assert.ok(outcome.record.refusals.some((r) => /named no queries/.test(r)));
});

test("with retrieval off, or no engine configured, nothing is searched and it says so", async () => {
  withKeys();
  const off = config.retrieval.enabled;
  try {
    config.retrieval.enabled = false;
    const a = await R.retrieve("What is the latest Prebid.js release?", { now: NOW });
    assert.equal(a.record.decision.needsRetrieval, false);
    assert.match(a.record.decision.reason, /retrieval is off/);
  } finally {
    config.retrieval.enabled = off;
  }
  config.search.braveKey = "";
  config.search.exaKey = "";
  const b = await R.retrieve("What is the latest Prebid.js release?", { now: NOW });
  assert.equal(b.record.decision.needsRetrieval, false);
  assert.match(b.record.decision.reason, /no search engine is configured/);
});

test("the decision is audible while it is made, and silent when a rule settles it", async () => {
  withKeys();
  const said: string[] = [];
  await R.retrieve("What is the latest Prebid.js release?", {
    decide: async () => ({ needsRetrieval: true, engine: "brave", queries: ["Prebid.js latest release"], reason: "a release changes", source: "model" }),
    search: async () => [result("Prebid", "https://prebid.org")],
    fetchPage: noFetch,
    note: (line) => said.push(line),
    now: NOW,
  });
  assert.deepEqual(said, ["Checking whether this needs a search…", "Searching the web: Prebid.js latest release"]);

  // A turn a code rule settles says nothing at all: nothing is being decided or searched.
  const quiet: string[] = [];
  await R.retrieve("/jobs", { note: (line) => quiet.push(line), now: NOW });
  assert.deepEqual(quiet, []);
  // Nor does a turn the model decides needs no search.
  const nothing: string[] = [];
  await R.retrieve("What is 12 times 12?", {
    decide: async () => ({ needsRetrieval: false, engine: "none", queries: [], reason: "arithmetic", source: "model" }),
    note: (line) => nothing.push(line),
    now: NOW,
  });
  assert.deepEqual(nothing, ["Checking whether this needs a search…"]);
});

test("the decision is stored with the turn, bounded, and with the job", async () => {
  withKeys();
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "clear-ops-retrieval-store-")));
  const decision = { needsRetrieval: true as const, engine: "brave" as const, queries: ["q"], reason: "r", source: "model" as const };
  const record = { at: "2026-11-14T09:00:00.000Z", model: "haiku", decision, searches: [{ engine: "brave" as const, query: "q", results: 1, empty: false }], fetches: [], refusals: [] };
  for (let i = 0; i < 25; i += 1) store.recordRetrievalTurn({ ...record, at: `2026-11-14T09:${String(i).padStart(2, "0")}:00.000Z` });
  assert.equal(store.recentRetrievals().length, 20, "bounded");
  assert.equal(store.recentRetrievals()[0].at, "2026-11-14T09:24:00.000Z", "newest first");

  const job = store.createJob("research", "brief", "tg:1");
  store.updateJob(job.id, { retrieval: record });
  assert.deepEqual(store.getJob(job.id)?.retrieval?.decision.queries, ["q"], "the decision is kept with the job");
  // And it survives a reload, like every other job field.
  const again = new Store(store.dir);
  assert.deepEqual(again.getJob(job.id)?.retrieval?.decision.queries, ["q"]);
  assert.equal(again.recentRetrievals().length, 20);
});
