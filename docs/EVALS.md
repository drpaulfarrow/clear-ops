# Measuring the workforce: usage figures and the eval set

This is the baseline for the efficiency programme (13 November 2026): what one job costs, in tokens and
in money, and a fixed set of tasks that says whether a change to models, prompts, tools or retrieval
made the workforce better or worse. Every later slice (tiered models, prompt caching, tool discipline,
retrieval as a harness decision) is judged on these two numbers: cost per task, and pass rate.

## 1. What is recorded, and where

Every model call a job makes is recorded with the job itself (`src/telemetry.ts`, stored as
`Job.usage` in `DATA_DIR/state.json`, so it survives a restart):

- the role the call was made under: `chief`, `worker`, `engineer`, `maintainer`, `designer` or
  `assistant` (an `ea` job);
- the model id the provider reported and the provider (`openrouter` or `anthropic`);
- prompt, cached, cache-write and completion tokens, and reasoning tokens where the provider reports
  them;
- latency (the gap since the previous message the SDK produced: an upper bound on the call, since any
  local tool work in between is included);
- the tool calls, and their names, except for the kinds that touch Paul's mail, calendar or uploads,
  where the count is kept and the names are dropped;
- the cost, where a real one exists.

Nothing else is recorded: never a prompt, a brief, an answer, a tool input or a tool result. The
chief's own chat turns are recorded the same way, under the `chief` role, for the current London day
only, so answering Paul costs something measurable too.

**Where the money figure comes from.** One figure about money is ever shown and it is the provider's
(`src/spend.ts`): on OpenRouter, `GET /api/v1/key`, which is cumulative for the whole API key. So on
OpenRouter there is no honest per-call or per-job amount, and the report says exactly that rather than
working one out from a price table. On Anthropic directly the SDK prices each run at Anthropic's own
list price, which *is* the bill there, so a per-job amount is real and is labelled as Anthropic's own
list price. The Agent SDK's own price is kept as an internal `estimateUsd` on every run: it backs the
per-run cap and it is what a later slice compares against, and it is never shown to Paul, under any
label, anywhere.

## 2. What Paul can read

- `/usage` in chat: today's tokens, cache hit rate, cost per kind, the biggest jobs by tokens and the
  top jobs by cost where a real amount exists, the chief's own chat turns for the day, and the money
  line with the words that say whose figure it is (or that there is none). `/usage yesterday`,
  `/usage YYYY-MM-DD` and `/usage job <id>` for one job's own numbers.
- The same thing in his own words: ask the chief ("what did that job cost?", "what has today used?",
  "is caching helping?") and it calls its `usage_report` tool.
- A per-job view: `/usage job <id>` shows the role, provider, models, tokens, cache rate, run time,
  turns, tool calls and the cost with its source, and says when a stopped job's figures are partial.

Both are numbers only. No brief, no output, no file path, no mail, no calendar, no upload.

## 3. Running the eval

The set is `eval/tasks.v1.json`: thirty representative tasks in the workforce's own style, each with
what a correct answer must contain and how it is judged. It covers current facts (SPUR, CoMP, Trusted
Server, Web Bot Auth, TollBit, Prebid's current release), questions about our own repositories, a
job-status question, drafting tasks, retrieval questions whose answers must be cited, a few whose
right answer is "not found", and questions about how the workforce itself behaves.

```bash
npm run eval                          # the baseline set, label "manual"
npm run eval -- --label caching-1     # name this run, so a later slice compares like with like
EVAL_BUDGET_USD=1 npm run eval        # stop once the internal estimate passes a dollar
EVAL_TASKS=eval/tasks.v2.json npm run eval
```

It talks to the chief exactly as Paul's chat does, so it measures the harness as it really is: the same
system prompt, the same tools, the same cheapest configured tier (the chief defaults to `haiku`) and
the same per-run budget cap (`JOB_BUDGET_USD`). The only addition is one line asking each task to be
answered in the reply rather than delegated to a worker, so there is an answer to judge at all. It
needs a model key and it spends real money, so it is a hand-run tool, never a test: it takes a few
minutes and about a dollar at the default tier for the whole set.

Judging is deterministic and free: a task lists strings or patterns a correct answer must contain,
whether it must cite a link, whether the right answer is that the thing was not found, and how long it
may be. No model judges another model's answer, so the same answer always scores the same.

Results land in `<DATA_DIR>/eval/<time>-<label>.json`, owner-only, outside every checkout. Each run
records the label, the set version, the pass rate, per-task pass or fail with the names of the checks
that failed, tokens, cache hit rate, wall time and the internal `estimateUsd` for the run. No answer
text is written down anywhere.

## 4. What a good result looks like

- **Pass rate at or above the baseline**, with the same set version. The first run is the baseline: run
  it before changing anything and keep the file.
- **Cost per task down**, on `estimateUsd` and on tokens, with the same tasks passing. A slice that
  halves the cost and loses two tasks has not worked.
- **Cache hit rate up** as the caching discipline lands: cached input tokens as a share of all input
  tokens. It is 0% until a stable prefix exists, which is expected for the baseline.
- **No regression in the categories that matter most**: `own-repo` and `own-behaviour` say the
  workforce still knows itself, `not-found` says it still refuses to invent, and `retrieval-cited` says
  every external claim still carries a link.
- **Zero unsourced external claims**: every `retrieval-cited` task must pass its citation check. That
  is the programme's stopping condition, not a nicety.

Compare two runs with the summary line each one prints, or diff the two JSON files: `passRate`,
`estimateUsd`, `totals` and `tasks[].failed` are the fields a slice is judged on.
