/**
 * The shaped brief and its acceptance IDs (18 Nov 2026).
 *
 * Paul's requests for engineering work arrive informally: "the search is slow on my phone, sort it
 * out", typed or relayed. Before such a request becomes an engineer job, the chief of staff shapes
 * it into a sound brief, and the shaping is visible in the brief itself rather than implied: the
 * requester's own words are kept verbatim, what the request actually says is kept visibly separate
 * from what the chief inferred and from what remains open, and the finish line is the existing
 * doneWhen contract with each acceptance line individually identified.
 *
 * Nothing here is a second contract. Acceptance IDs live inside the doneWhen string the chief
 * already passes on start_job (the ops_v4 tool schema is untouched: only the tool descriptions
 * moved, and descriptions are not part of the pinned wire shape, src/ops-schema.ts), they are kept
 * on the job exactly as before (`Job.doneWhen`, `withContract`'s "Done when:" section in
 * src/jobs.ts), and every consumer of the contract (the engineer, the maintainer, every fix round,
 * which quotes the brief) reads them in the same place it reads the contract today. This module
 * only names the markers, parses them, and enforces the one hard rule: a shaped brief must name its
 * acceptances, so a job can fail against a specific one and Paul can check each.
 */

/** The requester's own words, exactly as they arrived: the marker that makes a brief "shaped". */
export const REQUEST_HEADING = "Request (verbatim):";

/** What the request actually says: the confirmed part of the intent, and the only part settled. */
export const INTENT_HEADING = "Confirmed intent:";

/** What the chief inferred but the requester did not say: proposals to verify, never settled. */
export const ASSUMPTIONS_HEADING = "Assumptions (inferred, not confirmed):";

/** What remains open: questions, not requirements, however strongly they are worded. */
export const UNKNOWNS_HEADING = "Unknowns (open questions):";

/** One acceptance of a contract: its ID ("A1") and the line as written, without the ID. */
export interface Acceptance {
  id: string;
  line: string;
}

/** An acceptance line of a contract: "A1: a new test reproduces the bug and passes after the fix". */
const ACCEPTANCE_LINE = /^[ \t>*`_-]*(A\d{1,3})[ \t]*:[ \t]*(\S.*)$/;

/** The only hard rule of shaping (src/brief.ts): a shaped brief names its acceptances, or nothing starts. */
export const SHAPING_REFUSAL =
  'A shaped brief needs its acceptances individually identified in doneWhen: give each line an ID ("A1: a new test reproduces the bug and passes after the fix", "A2: ..."), taken from what Paul asked for, so the job can fail against a specific one and he can check each. Nothing was started; call start_job again with them.';

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

/** One acceptance verdict from an engineer's report: "ACCEPT A1: met" or "ACCEPT A2: not met: <why>". */
export interface AcceptanceVerdict {
  id: string;
  met: boolean;
  reason?: string;
}

/** Reads the engineer's per-acceptance verdict lines (see the engineer's contract rule, src/agents.ts). */
export function acceptanceVerdicts(report: string): AcceptanceVerdict[] {
  const out: AcceptanceVerdict[] = [];
  for (const m of report.matchAll(/^[ \t>*`_-]*ACCEPT[ \t]+(A\d{1,3})[ \t]*:[ \t]*(met|not[ \t]+met)\b[ \t:.-]*(.*)$/gim)) {
    out.push({ id: m[1].toUpperCase(), met: !/^not/i.test(m[2]), reason: m[3].trim() || undefined });
  }
  return out;
}

/** An acceptance of this job's own contract that its report says is not met. */
export interface UnmetAcceptance {
  id: string;
  reason: string;
}

/**
 * The first acceptance of this contract the report says is not met, or undefined. Only acceptances
 * the job's own doneWhen names count: a verdict against any other ID (a typo, another job's
 * contract quoted in passing) settles nothing here, and a report with no verdict lines at all is
 * one for the maintainer to check, not a failure the service invents.
 */
export function unmetAcceptance(report: string, doneWhen: string | undefined): UnmetAcceptance | undefined {
  const mine = new Set(acceptances(doneWhen).map((a) => a.id));
  for (const v of acceptanceVerdicts(report)) {
    if (!v.met && mine.has(v.id)) return { id: v.id, reason: v.reason ?? "the engineer's report says it is not met" };
  }
  return undefined;
}
