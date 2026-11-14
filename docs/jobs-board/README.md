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
