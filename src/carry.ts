/**
 * Merge and carry (Paul, 22 Nov 2026): a review holds a pull request back only for a blocking finding.
 * Everything smaller the maintainer writes down as a "CARRY <url>: ..." line and merges anyway, and
 * the service hands those lines to the next engineer job on the same repository, to fix in the pull
 * request it was going to open anyway. Nothing is sent round again, and nothing waits on Paul, for a
 * finding that does not stop the work being used.
 *
 * Before this, every finding an engineer could fix was "changes requested": with fix rounds on, that
 * was a new engineer session and another review for a naming point; with them off (21 Nov), it was a
 * stop and a message to Paul. Either way the work stalled on things that did not matter yet.
 *
 * The findings are held in the store (settings.carried), one list for the whole workforce, each with
 * the repository it belongs to. A finding is handed to one job at a time: the job that takes it is
 * recorded on it, and it is dropped when that job's pull request has been reviewed (the maintainer
 * checks the carried findings it was given and writes a new CARRY line for one that was not fixed),
 * or freed again when that job failed or opened no pull request.
 */
import type { Job, JobTarget } from "./store.js";

/** The heading the carried findings sit under in an engineer's brief, and that the maintainer looks for. */
export const CARRIED_HEADING = "Carried from review:";
/** How many findings are held for one repository. Past it the oldest go: a list nobody works through is noise. */
export const CARRY_MAX_PER_REPO = 30;
/** How many are handed to one engineer job, oldest first, so they never outweigh the task itself. */
export const CARRY_PER_JOB = 10;
export const CARRY_TEXT_MAX = 400;

/** One finding the maintainer carried instead of blocking on. */
export interface CarriedFinding {
  id: string;
  /** The repository it belongs to, as a job's target. */
  target: JobTarget;
  /** The pull request it was found on. */
  pr: string;
  text: string;
  at: string;
  /** The review job that wrote it. */
  review: string;
  /** The engineer job it has been handed to, while that job has it. */
  takenBy?: string;
}

/** What the maintainer is told. test/carry.test.ts pins that its prompt carries this. */
export const MERGE_AND_CARRY_RULE = `Blocking or carried (Paul, 22 Nov 2026): a pull request is held back only by a blocking finding, and work is never sent round again, or put to Paul, for anything less. A finding is blocking only when it is one of these: the build, the typecheck, the tests or CI fail; the change does not do what its task asked, or a line of the finish line above is unmet; it breaks something that worked before; it is a security problem, or a way to lose or corrupt data; it removes or weakens tests; or it is something the Standards below say is never merged. Every other finding is carried: naming, structure, duplication, a missing test for an edge case, an unclear message or comment, documentation, a tidier way to do the same thing. Do not request changes for a carried finding, and do not hold a merge for one. Give your verdict as if the carried findings were not there, and write each one near the end of your report, just above the REVIEW line, as one line in exactly this form: CARRY <the pull request's full URL>: <file or area>: <what is wrong and what to do, in one sentence>. The service hands those lines to the next engineer who works on this repository, to fix in that pull request, so write each one so that it can be acted on without reading this review. If the task you are reviewing lists findings under "${CARRIED_HEADING}", check each of them: one that was not fixed is carried again with a new CARRY line, and is never blocking. When you do request changes, mark only the blocking findings as blocking and still give your CARRY lines: the engineer fixes those in the same push.`;

/** What the chief is told, so that held findings are not started as jobs or put to Paul (fixLoopNote, src/orchestrator.ts). */
export const CARRY_NOTE = `The maintainer holds a pull request back only for a blocking finding (a failing build or test, the task not done, something broken, a security or data-loss problem). Smaller findings it merges with and writes down, and the service itself hands them to the next engineer job on that repository to fix in its pull request. So when a job's message says findings are held for the next engineer job, that is finished business: do not start a job for them, and do not put them to Paul as something to decide.`;

/** Reads the maintainer's "CARRY <url>: ..." lines. */
export function parseCarryLines(report: string): Array<{ pr: string; text: string }> {
  const out: Array<{ pr: string; text: string }> = [];
  for (const m of (report ?? "").matchAll(/^[ \t>*`_-]*CARRY[ \t]+<?(https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+)>?[ \t]*:[ \t]*(.+)$/gim)) {
    const text = m[2]!.replace(/[*`_]+$/, "").replace(/\s+/g, " ").trim().slice(0, CARRY_TEXT_MAX);
    if (text) out.push({ pr: m[1]!, text });
  }
  return out;
}

/** "#12" for a pull request's address. */
const prNumber = (url: string): string => `#${url.match(/\/pull\/(\d+)/)?.[1] ?? "?"}`;

/** The section an engineer's brief gains, and the maintainer reviewing it sees. Empty when there is nothing carried. */
export function carriedSection(items: Array<Pick<CarriedFinding, "pr" | "text">> | undefined): string {
  if (!items?.length) return "";
  return [
    "",
    "",
    CARRIED_HEADING,
    "These were found when earlier work on this repository was reviewed, and it was merged with them still to do. Fix each one in this same pull request, alongside your task, and say in your report which you fixed. They are small: do not let them widen your task, and if one turns out to be wrong or large, say so in your report and leave it.",
    ...items.map((i) => `- (from ${prNumber(i.pr)}) ${i.text}`),
  ].join("\n");
}

/**
 * True when a held finding can be handed to a job: nobody has it, or the job that took it failed, or
 * finished without a pull request. A job that is running or queued, or that has a pull request, still
 * has it: the review of that pull request is what settles it.
 */
export function carriedFree(item: CarriedFinding, jobOf: (id: string) => Pick<Job, "status" | "pr"> | undefined): boolean {
  if (!item.takenBy) return true;
  const job = jobOf(item.takenBy);
  return !job || job.status === "failed" || (job.status === "done" && !job.pr);
}
