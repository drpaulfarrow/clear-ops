# Plan: split the always-on front door from the workers

Status: proposed, not built (16 Nov 2026). This is the one recommendation from the stability review that changes the infrastructure, so it is written down here for Paul to decide on before an engineer builds it.

## The problem
One `shared-cpu-4x` machine with 4 GB runs everything: the Telegram and Discord gateways, Cleo's live voice, the scheduler, the board, Playwright browsers and up to three coding agents that typecheck and test. Coding agents are bursty and CPU-heavy, and shared cores are throttled under sustained load. On 14 Nov 2026 that load stopped the health check answering and took the service down (`fly.toml`). Voice is the most latency-sensitive thing in the process and shares a CPU with `tsc`, so it stutters when engineers run.

## The change, in three moves
First, a small front-door machine that is always on: the chat gateways, voice, the scheduler, the store, the board and the chief. It never runs a coding agent or a browser, so it stays responsive whatever the workers are doing. A `shared-cpu-1x` with 1 to 2 GB should be enough.

Second, worker machines that start per job and stop when idle. The front door hands a job to a worker over Fly's private network (6PN) with the brief, the permits and a short-lived token, and the worker posts progress and its result back. Fly Machines bill per second while running, so an idle workforce costs close to nothing. A worker gets the same environment and secret stripping as today's subprocess.

Third, the store moves from one JSON file to SQLite on the front door's volume. The front door is then the only writer, and workers never touch it directly.

## What it does not change
The approval gates, the allowlist, the invariants, the models, and what Paul sees in chat stay as they are. The engineer and maintainer flow is unchanged.

## Cost and risk
Compared with the $132/month upgrade, this should cost less: a small always-on machine plus per-second worker time. The risk is the hand-off. A worker that dies mid-job must be noticed (today's liveness watchdog, moved to the front door), and a deploy of the front door must not lose a job a worker is still running. Build it behind a setting (`WORKERS=local|remote`), with `local` as today's behaviour, so it can be switched back in one line.

## Alternative
A Mac mini at home running the same single process gets the same headroom with no code change, but leaves voice and coding agents competing on one machine and makes uptime depend on home power and broadband.
