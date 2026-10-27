# clear-ops

The agentic workforce for Clear Exchange, operated by the founder over WhatsApp.

## What this is
A small Node service. WhatsApp messages arrive at `/webhook`, a chief-of-staff agent (Claude Agent SDK) replies, and delegates longer work to worker agents (research, write, engineer, analyse) that run in the background and message the founder when done. The engineer is autonomous: it branches, tests, has a reviewer agent check the diff, merges and pushes. Commands outside that remit need a `YES <id>` reply. Recurring jobs run on cron.

## Rules for anyone (human or agent) working in this repo
- Clean room: never reference, copy or reconstruct anything from a repository called `comp-exchange` or "Atom", or any Microsoft internal material. Only public standards and general knowledge.
- The engineer may merge and push to its own repository. Anything else that sends, posts, signs or pays goes through `propose_action` and an executor in `src/jobs.ts`.
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
