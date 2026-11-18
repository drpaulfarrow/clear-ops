/**
 * The shaped brief and its acceptance IDs (18 Nov 2026).
 *
 * Paul's requests for engineering work arrive informally: "the search is slow on my phone, sort it
 * out", typed or relayed. Before such a request becomes an engineer job, the chief of staff shapes
 * it into a sound brief, and the shaping is visible in the brief itself rather than implied: the
 * requester's own words are kept verbatim, what the request actually says is kept visibly separate
 * from what the chief inferred and from what remains open, the brief says what evidence the outcome
 * needs and what could go wrong and how to recover it, and for a refactor that unchanged behaviour
 * is the acceptance baseline. This module names the markers and parses them, so the chief's prompt,
 * the tool descriptions, the tests and the eval all speak the same vocabulary.
 *
 * Nothing here is a second contract, and nothing here is a gate. Acceptance IDs live inside the
 * doneWhen string the chief already passes on start_job (the ops_v4 tool schema is untouched: only
 * the tool descriptions moved, and descriptions are not part of the pinned wire shape,
 * src/ops-schema.ts) and are kept on the job exactly as before (`Job.doneWhen`, `withContract`'s
 * "Done when:" section in src/jobs.ts). They are review evidence, nothing more: the engineer
 * reports against each ID (the engineer's contract rule, src/agents.ts) and the maintainer checks
 * each one by ID during review, inside the review loop exactly as it is. The requirement to give a
 * shaped brief's acceptances their IDs is shaping guidance in the chief's prompt, not a rule any
 * code enforces: the runner never refuses a brief over them and never inspects a report for them.
 */

/** The requester's own words, exactly as they arrived: the marker that makes a brief "shaped". */
export const REQUEST_HEADING = "Request (verbatim):";

/** What the request actually says: the confirmed part of the intent, and the only part settled. */
export const INTENT_HEADING = "Confirmed intent:";

/** What the chief inferred but the requester did not say: proposals to verify, never settled. */
export const ASSUMPTIONS_HEADING = "Assumptions (inferred, not confirmed):";

/** What remains open: questions, not requirements, however strongly they are worded. */
export const UNKNOWNS_HEADING = "Unknowns (open questions):";

/** What proof the outcome needs: the tests, checks or numbers that would show it worked. */
export const EVIDENCE_HEADING = "Evidence expected:";

/** What could go wrong, and how the change is undone or recovered if it does. */
export const RISKS_HEADING = "Risks and recovery:";

/** One acceptance of a contract: its ID ("A1") and the line as written, without the ID. */
export interface Acceptance {
  id: string;
  line: string;
}

/** An acceptance line of a contract: "A1: a new test reproduces the bug and passes after the fix". */
const ACCEPTANCE_LINE = /^[ \t>*`_-]*(A\d{1,3})[ \t]*:[ \t]*(\S.*)$/;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether a brief is a shaped one: it carries the requester's own words under {@link REQUEST_HEADING}. */
export function isShapedBrief(brief: string): boolean {
  return new RegExp(`^[ \\t>*\`_-]*${escape(REQUEST_HEADING)}`, "m").test(brief);
}

/**
 * The individually identified acceptances of a contract: every doneWhen line that carries an
 * acceptance ID, in order, first occurrence of an ID winning. Lines without an ID are the contract's
 * lines as they have always been (checked whole by the engineer and the maintainer); they simply
 * cannot be named by an ID, so they are not listed here.
 */
export function acceptances(doneWhen: string | undefined): Acceptance[] {
  if (!doneWhen?.trim()) return [];
  const out: Acceptance[] = [];
  const seen = new Set<string>();
  for (const raw of doneWhen.split("\n")) {
    const m = raw.match(ACCEPTANCE_LINE);
    if (!m) continue;
    const id = m[1].toUpperCase();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, line: m[2].trim() });
  }
  return out;
}

/** Whether a contract has at least one individually identified acceptance ("A1:", "A2:", ...). */
export function hasAcceptanceIds(doneWhen: string | undefined): boolean {
  return acceptances(doneWhen).length > 0;
}
