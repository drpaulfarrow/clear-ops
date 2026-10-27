# clear-ops

The agentic workforce for Clear Exchange, operated by the founder over WhatsApp.

## What this is
A small Node service. WhatsApp messages arrive at `/webhook`, a chief-of-staff agent (Claude Agent SDK) replies, and delegates longer work to worker agents (research, write, engineer, maintain, analyse) that run in the background and message the founder when done. Every agent can read both repositories. Engineers implement on branches and open pull requests. One agent, the maintainer, reviews and merges; it runs automatically after every engineer job. Commands outside that remit need a `YES <id>` reply. Recurring jobs run on cron.

## Self-improvement
The engineer and maintainer may work on this repository (job target "self"). Nothing patches the running process: the maintainer merges to main, `.github/workflows/deploy.yml` runs the tests and deploys, and the Fly health check keeps the old machine serving if the new one fails. Definition of done: engineer, pull request open with green tests; maintainer, merged to main.

## Invariants (enforced by `test/invariants.test.ts`, which may be extended but never removed or weakened)
- Only numbers in `ALLOWED_NUMBERS` get a reply.
- Webhook signatures are verified before any message is parsed.
- Every agent prompt carries the clean-room rule.
- Only the maintainer merges. Engineers cannot merge or push the default branch; nobody force-pushes, rewrites shared history or deletes recursively. Branch protection on `main` (require a pull request and the `ci / test` check) is the hard backstop.
- Agents run headless (`permissionMode: "dontAsk"`); spend is capped on every run.

## Rules for anyone (human or agent) working in this repo
- Clean room: never reference, copy or reconstruct anything from a repository called `comp-exchange` or "Atom", or any Microsoft internal material. Only public standards and general knowledge.
- Engineers open pull requests; the maintainer merges. Anything else that sends, posts, signs or pays goes through `propose_action` and an executor in `src/jobs.ts`.
- Only numbers in `ALLOWED_NUMBERS` are ever answered.
- Keep replies short; they are read on a phone. No em dashes, British English.
- Tests must pass: `npm test`. Typecheck: `npm run build`.

## Layout
- `src/index.ts` Express app and webhook. `buildApp()` takes injectable messenger, runner and store so tests run offline.
- `src/orchestrator.ts` chief-of-staff prompt, its tools (start_job, job_status, get_output, propose_action, schedule_job, list_schedules, cancel_schedule, remember), commands, approval handling.
- `src/agents.ts` Agent SDK runner and the worker specs.
- `src/jobs.ts` background job runner and the approved-action executors.
- `src/scheduler.ts` cron schedules.
- `src/store.ts` JSON state (sessions, jobs, actions, schedules, notes) under `DATA_DIR`.
- `src/whatsapp.ts` Cloud API client, inbound parsing, signature check, chunking.
