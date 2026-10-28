# clear-ops

The agentic workforce for Clear Exchange, operated by the founder from Telegram, Discord or WhatsApp, any or all at once.

## What this is
A small Node service. Messages arrive from Telegram (long polling, `src/telegram.ts`), Discord (gateway, `src/discord.ts`; each job gets a thread) or WhatsApp (`/webhook`), and replies go back to the conversation they came from through `src/channels.ts`. Jobs interrupted by a restart are re-queued on boot. a chief-of-staff agent (Claude Agent SDK) replies, and delegates longer work to worker agents (research, write, engineer, maintain, analyse, create_agent, design) that run in the background and message the founder when done. Every agent can read both repositories. Engineers implement on branches and open pull requests. One agent, the maintainer, reviews and merges; it runs automatically after every engineer job and every agent-creator job that may have opened a pull request. The agent-creator (`create_agent`) turns a plain-language request for a new agent into a recommended schedule on an existing kind or a new worker kind on a pull request against this repository. Only one engineering job (engineer or create_agent) runs per repository at a time, product and self counted separately; further ones queue in FIFO order in the store (`waitingFor`, `queuePos`) and start when the holder finishes, including across restarts. The maintainer and other kinds never queue. The review loop closes itself: when the maintainer's review of an engineer's or agent-creator's pull request ends `REVIEW <url>: changes requested`, the job runner starts an engineer fix round on the same pull request (queued like any engineering job, re-reviewed as usual), up to `MAX_FIX_ROUNDS` (3); after that, or on `REVIEW <url>: needs Paul: ...`, the founder is messaged once with what he must do. Engineers and the maintainer update branches from main with `gh pr update-branch` or `git pull --no-rebase origin main`, never by force. The design worker (`design`) screenshots the live site and branches with headless Chromium (`src/design.ts`), critiques them as buyer personas and writes brand work and specs; it writes no production code. The design loop (`start_job` with `loop: true`) closes itself the same way: a design report ending `DESIGN: spec ready` starts an engineer job on the product (queued and reviewed as usual); when the maintainer merges it, the next design round starts once the product's deploy is live; up to `MAX_DESIGN_ROUNDS` (3) implemented rounds, then a closing critique. `DESIGN: no high-impact issues` ends it early; `DESIGN: needs Paul: ...` pauses it, sends him the images, and `start_job` with `continueLoop` carries on. Commands outside that remit need a `YES <id>` reply. Recurring jobs run on cron.

## Self-improvement
The engineer and maintainer may work on this repository (job target "self"). Nothing patches the running process: the maintainer merges to main, `.github/workflows/deploy.yml` runs the tests and deploys, and the Fly health check keeps the old machine serving if the new one fails. Definition of done: engineer, pull request open with green tests; maintainer, merged to main.

## Invariants (enforced by `test/invariants.test.ts`, which may be extended but never removed or weakened)
- Only senders in `ALLOWED_TELEGRAM_IDS`, `ALLOWED_DISCORD_IDS` or `ALLOWED_NUMBERS` get a reply (`isAllowed` in `src/config.ts`), and every listener checks before handling.
- WhatsApp webhook signatures are verified before any message is parsed.
- Every agent prompt carries the clean-room rule, including every kind added to `JOB_KINDS` later. Only engineering kinds (engineer, create_agent) get Edit, Write or unrestricted Bash.
- Only the maintainer merges. Engineers cannot merge or push the default branch; nobody force-pushes, rewrites shared history or deletes recursively. Branch protection on `main` (require a pull request and the `ci / test` check) is the hard backstop.
- The design worker gets only read-only tools plus its own `screenshot` (public http(s) only, no file:// or private addresses) and `save_asset` (its own folder only). The design loop builds only through engineer jobs and is capped.
- Agents run headless (`permissionMode: "dontAsk"`); spend is capped on every run.

## Rules for anyone (human or agent) working in this repo
- Clean room: never reference, copy or reconstruct anything from a repository called `comp-exchange` or "Atom", or any Microsoft internal material. Only public standards and general knowledge.
- Engineers open pull requests; the maintainer merges. Anything else that sends, posts, signs or pays goes through `propose_action` and an executor in `src/jobs.ts`.
- Only allowlisted senders are ever answered.
- Keep replies short; they are read on a phone. No em dashes, British English.
- Tests must pass: `npm test`. Typecheck: `npm run build`.

## Layout
- `src/index.ts` Express app and webhook. `buildApp()` takes injectable messenger, runner and store so tests run offline.
- `src/status.ts` what the founder sees while the chief works: a typing indicator and one status line edited in place from the chief's tool calls (`describeToolUse`), removed when the reply lands. Falls back to one "Working on it." where a channel can neither edit nor type.
- `src/orchestrator.ts` chief-of-staff prompt, its tools (start_job, job_status, get_output, propose_action, schedule_job, list_schedules, cancel_schedule, remember), commands, approval handling.
- `src/agents.ts` Agent SDK runner and the worker specs.
- `src/jobs.ts` background job runner and the approved-action executors.
- `src/scheduler.ts` cron schedules.
- `src/store.ts` JSON state (sessions, jobs, actions, schedules, notes) under `DATA_DIR`.
- `src/telegram.ts` Bot API client and long-polling receiver.
- `src/discord.ts` gateway listener, messenger and job threads. `src/channels.ts` routes by address prefix.
- `src/design.ts` the design worker's screenshot and asset tools, URL guard, branch preview, the `DESIGN:` and `IMAGE:` report lines, and the wait for the product deploy.
- `src/whatsapp.ts` Cloud API client, inbound parsing, signature check, chunking.
