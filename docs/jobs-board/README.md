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
