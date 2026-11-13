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

**Where the money figure comes from.** Every figure shown is named for whose it is, and where none
could be read the line says so and shows nothing. Three labels: `provider` (what OpenRouter itself
charged for this job's calls, read per call by the job's cap meter, `src/realcost.ts`; a lower bound
until the provider has priced every call, and the note says so), `anthropic` (Anthropic's own list
price, which *is* the bill when the workforce runs on Anthropic directly), and `unavailable` (nothing
could be read: no cap was counting, or the provider had published nothing, so there is no figure and
the record says exactly that rather than working one out from a price table). The Agent SDK's own
price is kept as an internal `estimateUsd` on every run: it backs the per-run runaway guard and it is
what a later slice compares against, and it is never shown to Paul, under any label, anywhere. A
day's one total figure is still the provider's own from `src/spend.ts`, and where no per-job figure
exists the per-kind split is by tokens, not money.

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
npm run eval                          # recorded mode: no key, no call, nothing spent, label "recorded"
npm run eval -- --live                # the real chief: real spend, the baseline a slice is judged on
npm run eval -- --label caching-1     # name this run, so a later slice compares like with like
EVAL_BUDGET_USD=1 npm run eval -- --live   # stop once the internal estimate passes a dollar
EVAL_TASKS=eval/tasks.v2.json npm run eval
```

Recorded mode is the default, and it is safe by design: every task is answered from the fixture file of
recorded answers (`eval/recorded.v1.json`), so the run needs no model key, makes no network call and
spends nothing. It proves the set, the judge and the accounting, and reports the pass rate and cost of
the recorded answers; those numbers describe the recording, not the live chief, and its output says
so. Only `--live` measures the harness itself.

Live mode talks to the chief exactly as Paul's chat does, so it measures the harness as it really is:
the same system prompt, the same tools, the same cheapest configured tier (the chief defaults to
`haiku`), reading what each task used from the usage the service records (the tokens and the Agent
SDK's internal estimate, which is all there is per task on OpenRouter and is used only to compare one
run with the next). The only addition is one line asking each task to be answered in the reply rather
than delegated to a worker, so there is an answer to judge at all. It needs a model key and it spends
real money, so it is a hand-run tool, never a test: it takes a few minutes and about a dollar at the
default tier for the whole set.

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
