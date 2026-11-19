/**
 * The web app's Approve button (docs/APP.md, slice 3): how a tap in the signed-in app counts as Paul's
 * own decision at an approval gate.
 *
 * Until 18 Nov 2026 a gate took a decision from one place only: Paul's own chat account, checked
 * against the allowlist by the orchestrator and again by the gate. Paul then chose, twice, to approve
 * from the app with one tap. This is the whole of that second way in, kept as narrow as the first:
 *
 *  - A gate still asks one question, "is this an allowlisted chat account?", and only when the answer
 *    is no does it look here. What it accepts is not a name anyone could type but a grant: a random
 *    string minted for one decision, good for a minute, spent the moment a gate reads it.
 *  - Exactly one place mints a grant: the app's own approval route (src/index.ts), which sits behind the
 *    GitHub sign-in, takes only this site's own script, names one waiting item, and refuses unless the
 *    request carries the fingerprint of the exact text the service showed for that item.
 *  - Nothing a model, a page, an email, a job or a chat message says can produce one. The app's chat
 *    still refuses every typed approval word (src/web-chat.ts).
 *
 * The gates record the decision as made by `APP_APPROVER`, so the record says where it came from.
 */
import { randomBytes } from "node:crypto";

/** Who a decision made in the app is recorded as. */
export const APP_APPROVER = "the web app";
/** How long a grant lasts between the route minting it and a gate spending it. */
export const APP_GRANT_MS = 60_000;

const grants = new Map<string, number>();

/** A single-use grant for one decision. Called by the app's approval route and nowhere else. */
export function mintAppApproval(now: number = Date.now()): string {
  for (const [g, until] of grants) if (until < now) grants.delete(g);
  const grant = `app-grant:${randomBytes(24).toString("hex")}`;
  grants.set(grant, now + APP_GRANT_MS);
  return grant;
}

/** True once, for a grant this process minted that has not expired. Spending it removes it. */
export function spendAppApproval(grant: string, now: number = Date.now()): boolean {
  const until = grants.get(grant);
  if (until === undefined) return false;
  grants.delete(grant);
  return until >= now;
}
