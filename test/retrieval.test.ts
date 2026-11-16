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
  // The results themselves, before the page text below them, list the shared URL once.
  const listed = outcome.evidence.split(/\nPage /)[0];
  assert.equal((listed.match(/https:\/\/github\.com\/prebid\/Prebid\.js\/releases/g) ?? []).length, 1, "the shared URL is listed once");
  assert.match(listed, /2\. Prebid\n   https:\/\/prebid\.org/, "the other result still follows");
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
    // The fallback search runs when the decision step fails (see below); here it also fails, so the
    // honest block is what the answer gets.
    search: async () => {
      throw new Error("Brave search failed: HTTP 503");
    },
    now: NOW,
  });
  assert.equal(outcome.record.decision.source, "error");
  assert.match(outcome.record.error ?? "", /429/);
  assert.ok(!(outcome.record.error ?? "").includes(config.openrouter.apiKey), "the key is scrubbed");
  assert.equal(outcome.record.searches.length, 1, "the fallback search was tried once");
  assert.equal(outcome.record.searches[0].engine, "brave");
  assert.match(outcome.evidence, /could not check whether a web search was needed/);
  assert.match(outcome.evidence, /failed too/);
  assert.match(outcome.evidence, /may be out of date/);
});

test("the decision call is one short, tool-free completion on the cheap tier, asked for structured output", async () => {
  withKeys();
  R.resetSchemaSupport();
  const calls: Array<{ url: string; init: any }> = [];
  const fetcher = async (url: string, init: any) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '{"needs_retrieval": false, "engine": "brave", "queries": [], "reason": "no"}' }, finish_reason: "stop" }] }),
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
  // The provider is asked to enforce the shape rather than the prompt asking politely for it.
  assert.equal(body.response_format.type, "json_schema");
  assert.equal(body.response_format.json_schema.strict, true);
  assert.deepEqual(body.response_format.json_schema.schema.required, ["needs_retrieval", "engine", "queries", "reason"]);
  assert.equal(body.response_format.json_schema.schema.properties.needs_retrieval.type, "boolean");
  assert.ok(body.response_format.json_schema.schema.properties.queries.maxItems <= config.retrieval.maxSearches + 1, "the schema's ceiling matches the budget");
  // Reasoning is turned off, because reasoning tokens are counted inside max_tokens: a reasoning model
  // (the default tier is one) can otherwise spend the whole decision reply thinking and come back empty
  // with finish_reason "length", which is exactly the failure this change fixes (research rank 1).
  assert.deepEqual(body.reasoning, { enabled: false }, "the structured attempt does not reason");
  // And it is routed only to an endpoint that really takes the schema, rather than one that treats it as
  // a strong hint (research rank 2).
  assert.deepEqual(body.provider, { require_parameters: true }, "the call is routed to an endpoint that supports the schema");
  assert.equal(outcome.record.diagnostic, undefined, "an ordinary turn's record is exactly what it always was");
});

test("a provider that refuses the schema is retried without it, and the refusal is remembered", async () => {
  withKeys();
  R.resetSchemaSupport();
  const calls: Array<{ url: string; init: any }> = [];
  // First call: the provider rejects the structured-output request (a 4xx). Second: a plain completion
  // whose reply is chatty (a preamble and a fence), which the tolerant parse must still read.
  const fetcher = async (url: string, init: any) => {
    calls.push({ url, init });
    if (calls.length === 1) {
      return { ok: false, status: 400, json: async () => ({}), text: async () => '{"error":{"message":"response_format json_schema is not supported for this model"}}' };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'Sure.```json\n{"needs_retrieval": true, "engine": "brave", "queries": ["Prebid.js latest release"], "reason": "a release changes"}\n```Hope that helps.' }, finish_reason: "stop" }],
      }),
      text: async () => "",
    };
  };
  const outcome = await R.retrieve("What is the latest Prebid.js release?", {
    fetcher: fetcher as never,
    search: async () => [result("Prebid", "https://prebid.org")],
    fetchPage: noFetch,
    now: NOW,
  });
  assert.equal(outcome.record.decision.needsRetrieval, true, "the retry's answer is used");
  assert.deepEqual(outcome.record.decision.queries, ["Prebid.js latest release"]);
  assert.equal(calls.length, 2, "one retry, then stop");
  assert.ok(JSON.parse(calls[0].init.body).response_format, "the first attempt asked for structured output");
  assert.equal(JSON.parse(calls[1].init.body).response_format, undefined, "the retry does not");
  assert.equal(JSON.parse(calls[1].init.body).reasoning, undefined, "the plain fallback is left exactly as it was");
  assert.equal(JSON.parse(calls[1].init.body).provider, undefined, "and carries no routing constraint");
  assert.ok(JSON.parse(calls[1].init.body).max_tokens > JSON.parse(calls[0].init.body).max_tokens, "the retry is given more room than the cap that may have cut it off");
  assert.equal(outcome.record.decision.source, "model", "a retried decision is still the model's");
  const diag = outcome.record.diagnostic;
  assert.ok(diag, "the retry is on the record");
  assert.equal(diag.attempts, 2);
  assert.equal(diag.retried, true);
  assert.equal(diag.structured, true);
  assert.equal(diag.status, 400);
  assert.match(diag.firstError ?? "", /400/);
  assert.ok(!JSON.stringify(diag).includes("Sure"), "the diagnostic holds the shape of the failure, never the reply");

  // The refusal is remembered: the next turn does not pay for it again.
  const again: Array<{ url: string; init: any }> = [];
  const fetcher2 = async (url: string, init: any) => {
    again.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '{"needs_retrieval": false, "engine": "brave", "queries": [], "reason": "no"}' }, finish_reason: "stop" }] }),
      text: async () => "",
    };
  };
  await R.retrieve("Summarise this note.", { fetcher: fetcher2 as never, now: NOW });
  assert.equal(again.length, 1);
  assert.equal(JSON.parse(again[0].init.body).response_format, undefined, "the schema is not asked for again");
  assert.equal(JSON.parse(again[0].init.body).reasoning, undefined, "nor the reasoning control that goes with it");
  assert.equal(JSON.parse(again[0].init.body).provider, undefined, "nor the routing constraint");
  R.resetSchemaSupport();
});

test("a timeout, a 5xx or an unparseable reply is retried once and then given up on", async () => {
  withKeys();
  R.resetSchemaSupport();
  // Twice unusable: the decision fails, and the record carries the shape of the failure.
  const calls: string[] = [];
  const bad = async (url: string, init: any) => {
    calls.push(init.body);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "I think a search would be a good idea." }, finish_reason: "stop" }] }), text: async () => "" };
  };
  const outcome = await R.retrieve("What is the latest Prebid.js release?", {
    fetcher: bad as never,
    search: async () => [result("Prebid", "https://prebid.org")],
    fetchPage: noFetch,
    now: NOW,
  });
  assert.equal(calls.length, 2, "retried exactly once, then stopped");
  const diag = outcome.record.diagnostic;
  assert.ok(diag, "the failure is diagnosable");
  assert.equal(diag.attempts, 2);
  assert.equal(diag.chars, "I think a search would be a good idea.".length, "how long the reply was");
  assert.equal(diag.hadBrace, false, "no brace in it");
  assert.equal(diag.finishReason, "stop");
  assert.ok(!JSON.stringify(outcome.record).includes("good idea"), "never the reply itself");
  assert.match(outcome.record.error ?? "", /did not return JSON/);

  // A 5xx on the first attempt, a good reply on the retry: the turn is decided by the model.
  calls.length = 0;
  let n = 0;
  const flaky = async (url: string, init: any) => {
    calls.push(init.body);
    n += 1;
    if (n === 1) return { ok: false, status: 503, json: async () => ({}), text: async () => "unavailable" };
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '{"needs_retrieval": true, "engine": "brave", "queries": ["Prebid.js release"], "reason": "a release changes"}' }, finish_reason: "stop" }] }),
      text: async () => "",
    };
  };
  const second = await R.retrieve("What is the latest Prebid.js release?", {
    fetcher: flaky as never,
    search: async () => [result("Prebid", "https://prebid.org")],
    fetchPage: noFetch,
    now: NOW,
  });
  assert.equal(calls.length, 2);
  assert.equal(second.record.decision.needsRetrieval, true);
  assert.equal(second.record.diagnostic?.status, 503);
  assert.equal(second.record.error, undefined, "a flake the retry fixed is not an error on the record");
  R.resetSchemaSupport();
});

test("a reply cut off at the token cap is a failure, never an empty decision", async () => {
  withKeys();
  R.resetSchemaSupport();
  let n = 0;
  const fetcher = async () => {
    n += 1;
    // Both attempts come back with the cap hit and nothing written: no decision, and it says so.
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "" }, finish_reason: "length" }] }), text: async () => "" };
  };
  const outcome = await R.retrieve("What is the latest Prebid.js release?", {
    fetcher: fetcher as never,
    search: async () => [],
    now: NOW,
  });
  assert.equal(n, 2);
  assert.equal(outcome.record.decision.needsRetrieval, true, "the fallback retrieved rather than deciding nothing");
  assert.match(outcome.record.error ?? "", /token cap/);
  assert.equal(outcome.record.diagnostic?.finishReason, "length");
  assert.equal(outcome.record.diagnostic?.hadBrace, false);
  assert.match(outcome.evidence, /could not check whether a web search was needed/);
  R.resetSchemaSupport();
});

test("when the decision fails, the service fails open and searches the request itself", async () => {
  withKeys();
  const asked: Array<{ engine: string; query: string }> = [];
  const outcome = await R.retrieve("What is the latest version of Prebid.js and when was it released?", {
    decide: async () => {
      throw new Error("the decision call failed: ETIMEDOUT");
    },
    search: async (engine, query) => {
      asked.push({ engine, query });
      return [result("Prebid.js releases", "https://github.com/prebid/Prebid.js/releases")];
    },
    fetchPage: noFetch,
    note: () => undefined,
    now: NOW,
  });
  assert.deepEqual(asked, [{ engine: "brave", query: "What is the latest version of Prebid.js and when was it released" }], "one search, built from the request itself, within the budget");
  assert.equal(outcome.record.decision.source, "error");
  assert.equal(outcome.record.decision.needsRetrieval, true, "the fallback retrieved");
  assert.deepEqual(outcome.record.decision.queries, ["What is the latest version of Prebid.js and when was it released"]);
  assert.equal(outcome.record.searches.length, 1, "the search is a normal search record");
  assert.equal(outcome.record.searches[0].engine, "brave");
  assert.equal(outcome.record.searches[0].results, 1);
  assert.equal(outcome.record.error, "the decision call failed: ETIMEDOUT", "the failure is still on the record");
  assert.match(outcome.evidence, /Web evidence the service retrieved/);
  assert.match(outcome.evidence, /could not check whether a web search was needed/);
  assert.match(outcome.evidence, /one search built from the request itself/, "the fallback is explained, not hidden");
  assert.match(outcome.evidence, /https:\/\/github\.com\/prebid\/Prebid\.js\/releases/);
  assert.match(outcome.evidence, /Cite a URL from the evidence above/, "the evidence is still fenced and cited");
  assert.doesNotMatch(outcome.evidence, /may be out of date/, "no hedging when a search did run");
});

test("the honest block is kept only when the fallback search also fails or finds nothing", async () => {
  withKeys();
  // The fallback found nothing.
  const said: string[] = [];
  const empty = await R.retrieve("What did TollBit announce last week?", {
    decide: async () => {
      throw new Error("HTTP 500: upstream");
    },
    search: async () => [],
    note: (line) => said.push(line),
    now: NOW,
  });
  assert.equal(empty.record.searches.length, 1);
  assert.equal(empty.record.searches[0].empty, true);
  assert.match(empty.evidence, /could not check whether a web search was needed/);
  assert.match(empty.evidence, /found nothing/);
  assert.match(empty.evidence, /may be out of date/);
  assert.deepEqual(said, ["Checking whether this needs a search…", 'Searching the web: What did TollBit announce last week']);

  // The fallback search itself errored.
  const failed = await R.retrieve("What did TollBit announce last week?", {
    decide: async () => {
      throw new Error("HTTP 500: upstream");
    },
    search: async () => {
      throw new Error(`Brave failed: HTTP 401 ${BRAVE}`);
    },
    now: NOW,
  });
  assert.match(failed.evidence, /failed too/);
  assert.match(failed.evidence, /may be out of date/);
  assert.ok(!failed.evidence.includes(BRAVE), "the key is scrubbed");

  // And a request with nothing searchable in it is not searched at all.
  const blank = await R.retrieve("   ", {
    decide: async () => {
      throw new Error("boom");
    },
    search: async () => {
      throw new Error("must not be called");
    },
    now: NOW,
  });
  assert.equal(blank.record.searches.length, 0);
  assert.match(blank.evidence, /could not check whether a web search was needed/);
});

test("the fallback query is the request itself, shortened, not a query invented by anyone", () => {
  assert.equal(R.fallbackQuery("What is the latest Prebid.js release?"), "What is the latest Prebid.js release");
  assert.equal(R.fallbackQuery("  Please   find   the TollBit pricing page  "), "the TollBit pricing page");
  assert.equal(R.fallbackQuery("<b>Prebid</b> news"), "Prebid news");
  assert.equal(R.fallbackQuery("x".repeat(500)).length, 200, "capped");
  assert.equal(R.fallbackQuery("   "), "", "nothing to search for");
});

test("the fallback query is the task, unwrapped from the harness's own wrappers", () => {
  // A chat turn arrives as the uploads note and then Paul's own message: the message is the request.
  assert.equal(
    R.fallbackQuery("Saved Connections.csv (1.2 MB).\n\nPaul's message: find the latest TollBit pricing page"),
    "the latest TollBit pricing page",
  );
  // A voice note's transcript comes with the wrapper that says so, and its own quoting.
  assert.equal(
    R.fallbackQuery('Paul\'s message (transcribed from his voice note, so it may mishear names and numbers, but it is what he said): "what changed in SPUR this week"'),
    "what changed in SPUR this week",
  );
  // A voice request from Discord arrives with the voice channel's own prefix.
  assert.equal(R.fallbackQuery("Voice request from Paul in the ClearOps server: Prebid 10 release notes"), "Prebid 10 release notes");
  // A generated brief ends with the report it is fixing: machinery, not the task.
  assert.equal(
    R.fallbackQuery("Fix the pricing copy\n\nEngineer's report:\nI changed three files and opened PR #12."),
    "Fix the pricing copy",
  );
  // A fix-round brief carries the task it is fixing, and then the review of it: the task is the subject.
  assert.equal(
    R.fallbackQuery(
      "Address the maintainer's review on the existing pull request https://github.com/x/y/pull/9 (automatic fix round 1 of 3).\n\nOriginal task:\nResearch SPUR's latest moves\n\nMaintainer's review (job a7a31a):\n# Maintainer review\nTwo things block the merge.",
    ),
    "Research SPUR's latest moves",
  );
  // A scheduled run's brief names the schedule at the end.
  assert.equal(R.fallbackQuery("Check what changed at IAB Tech Lab\n\n(This is the scheduled run 8518b3.)"), "Check what changed at IAB Tech Lab");
});

test("the fallback search obeys the same engine policy as every other query", async () => {
  withKeys();
  const asked: Array<{ engine: string; query: string }> = [];
  const outcome = await R.retrieve("Who are the competitors to TollBit, and what do they charge?", {
    decide: async () => {
      throw new Error("HTTP 500: upstream");
    },
    search: async (engine, query) => {
      asked.push({ engine, query });
      return [result("TollBit alternatives", "https://example.test/tollbit")];
    },
    fetchPage: noFetch,
    now: NOW,
  });
  assert.equal(asked.length, 1, "one search, still inside the budget");
  assert.equal(asked[0].engine, "exa", "an entity question goes to Exa, not always Brave");
  assert.equal(outcome.record.searches[0].engine, "exa");
  assert.equal(outcome.record.decision.engine, "exa", "the record says which engine really ran");
  assert.equal(outcome.record.decision.source, "error", "and that it was the fallback, not the model");
  assert.match(outcome.evidence, /one search built from the request itself/);
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
