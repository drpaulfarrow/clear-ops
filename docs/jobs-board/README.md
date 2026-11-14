# The jobs board, before and after

`before.png` and `after.png` are the same page at phone width (390 CSS pixels, one viewport wide,
full height), rendered offline from the same fixed set of jobs and the same clock, with no network:
`before.png` from the default branch and `after.png` from the change that made each card say what its
job is. Nothing here is Paul's own data: the jobs, briefs and timings are made up for the picture.

What the change is: every card now carries a description read off the job's own brief
(`src/job-descriptions.ts`), a line saying what that kind of worker and that repository mean
("engineer on the workforce repo: writes the change on a branch and opens a pull request"), a "Now:"
line while a job runs, one line on what a finished job produced, and the longer detail still behind a
plain `<details>` expand control. `before.png` reads "engineer, workforce, c4d3a0, running 12 min",
which needs whoever wrote the job to remember what it was.

Regenerating them needs a checkout with its dependencies installed and Chromium:

1. Write a small script that builds a `Store` in a temporary `DATA_DIR`, creates the jobs you want to
   show, and calls `boardData(...)` then `renderBoard(board, token)` from `src/jobs-board.ts`.
2. Render that HTML in headless Chromium at a 390 pixel viewport and screenshot the full page.
3. For the "before" image, point the same script at a copy of the source with
   `src/jobs-board.ts` taken from the default branch (`git show origin/main:src/jobs-board.ts`).

Nothing on the board is written for the picture: both images come from the real renderer.

## A running card, animating
`running-card.png` is the same page at the same phone width with three jobs running, rendered the same
offline way, after the running card was given a small turning arc and a soft pulse on its badge. Both
are CSS only, on `transform` and `opacity` alone, so nothing on the card moves and no filter, blur or
fetch is involved. The arc turns once every 1.25 seconds and the badge pulses every 2.5 seconds: each
divides the page's ten second refresh exactly (eight turns and four pulses), so the reload restarts
both on the same phase and the seam is invisible. With `prefers-reduced-motion: reduce` both are still
and the badge simply reads "running". `test/jobs-board.test.ts` holds all of that: one card per status
is rendered, only the running one carries the arc, no keyframe animates anything but transform or
opacity, each duration divides the refresh, and the reduced-motion rule is present.

## Health, uptime and how the workers are doing

`health-and-uptime.png` is the top of the same page, at the same phone width, rendered the same
offline way: a fixed set of jobs, a fixed clock (08:09 on 14 November 2026), a day of heartbeats with
two nine minute holes and a restart two hours ago, and four dependency checks, all four answering. It
is a healthy board, which is what the live service shows. The checks are given as a fixed snapshot
here, as every other figure is, and each one reads "answered": a check that has no credential to use
reports itself as off rather than inventing a failure, and reports a refusal only for a token that is
really there and really refused (`test/health.test.ts`; the GitHub check answers "answered" when it is
driven with the service's own installation token). It is clipped at the "Running now" heading, because
that is the new work: the health verdict and the checks, the uptime figures and the day's strip, and
the per-kind figures for the last 24 hours and the last 7 days.

Three pieces, and where each comes from:

- **Health, now** (`src/health.ts`): the verdict and its reasons, built from the runner's own counts
  (`activeWorkers`, `queuePosition`, the store's queue hold, `JobRunner.liveness` for a stalled job)
  and from the last result of each dependency check. The checks run on their own five minute timer
  with a five second cap each, one at a time, never on a page render and never in a way that touches a
  job; each one is a single request whose body is never read, with the key in a header and never in a
  URL, a log, the store or the page. A check that is not configured is "off" with the reason, and a
  check that fails, throws or never answers is one line: the page stays readable with every one broken.
- **Uptime and downtime** (`src/uptime.ts`): a one minute heartbeat appended as one short line to
  `uptime.jsonl` in the data directory, kept 14 days and rewritten only in batches so a beat never
  costs a rewrite. The figures, the 48 half hour strip cells, the recent gaps and the last restart are
  a pure function of the beats and the clock, so every case is tested without a timer. A gap is
  downtime only when the beats stop for more than three intervals (three minutes); the page carries the
  sentence saying so, and that uptime here means the service was recording rather than that the page
  answered from outside.
- **How the workers are doing** (`src/worker-stats.ts`): per kind, over the last 24 hours and the last
  7 days, from the job records alone: finished, done, stopped or failed and why, the queue wait and the
  run time (median and worst), the cache hit share where the records carry token counts, and a cost per
  job only where the store holds a real figure. The Agent SDK's estimate is never shown as one; where
  there is no real figure the page says that in one line. Nothing here reads a brief, an output or a
  transcript.

