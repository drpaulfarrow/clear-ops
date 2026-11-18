/**
 * The pull request report shape the engineer and the maintainer are held to (18 Nov 2026). It is
 * guidance in the two worker prompts only: nothing in the job runner parses, requires, blocks or
 * fails a report over any part of it, and no gate is added anywhere. A report that says a condition
 * is not met, or names an item as unrun, is a finished report like any other; the merge judgement
 * stays with the maintainer and the founder, never the runner.
 *
 * The shape assumes and composes with the acceptance-ID contract the chief's shaping settles
 * (pull 108): a shaped brief's finish line carries fail-able acceptance IDs (A1, A2, ...) that
 * serve as review evidence, and each ID is mapped to its evidence here. Where a finish line carries
 * no IDs, each line is mapped in its own words instead, so this guidance holds with or without that
 * change. Nothing is imported from it: the two rules below are self-contained prompt text.
 */

/**
 * The engineer's rule: what its report and the pull request description carry. The shape is
 * deliberately proportional: the first paragraph says a small change earns a short report, so the
 * rule demands evidence, never boilerplate.
 */
export const PR_REPORT_RULE_ENGINEER = `The pull request report. Your report, and the pull request description it is written from, are the evidence a merge is weighed on, not a file list. Give both this shape, and scale every part to the size and risk of the change: a small, low-risk change gets a short report, a few sentences per part, and that is the correct outcome rather than a failing; a change that touches stored data, permissions, money or a shared boundary earns the full detail; and where a part does not apply, one line saying so ("not applicable, no stored-data change") beats padding it out. The parts:
1. Purpose: the problem, who has it, and what changes for them.
2. System delta: what changes in the world when this merges: behaviour, responsibilities, stored data, dependencies, any external effects. File names come underneath as support, never as the substance.
3. Acceptance evidence: one entry per acceptance condition in the brief's "Done when:" line, by its ID where the line carries one and otherwise in its own words, each entry giving the expected result, the actual result, and a link to the test, command or check that evidences it. A fix's entry includes the test you saw fail first. Name every gap rather than papering over it: a condition with no evidence is said to have none, an item you did not run is named as unrun with the reason and stays unrun, and a condition that is not met is said not to be met. Never invent a fail-before you did not see, never claim a live success you did not observe.
4. Test relevance: why exactly these tests support the stated outcomes, and what they do not cover. Say plainly what remains untested.
5. Revision and integration: the branch's exact head commit and the base it grew from, whether it is up to date with the current default branch (bring it up to date before finishing if not, as above), and any conflicts.
6. Commands and environment: the commands you ran (tests, typecheck, build) and anything unusual about the environment they ran in.
7. Baseline failures: every failure you saw, stated against the baseline: which were already failing before your change (the environment's known failures) and which are yours.
8. Findings: anything found on the way that a reviewer or the founder should know: surprises, shortcuts, unresolved questions.
9. Risk, recovery and release unknowns: who or what could be affected if this is wrong; how the change is stopped or undone, answering separately for code, stored data and any external effects; and what remains unknown or unverified at release, said as unknown rather than smoothed over.`;

/**
 * The maintainer's rule: the review checks each acceptance condition by its ID and judges whether
 * the evidence holds, and its own report records that judgement. The last sentence states the
 * no-gate rule in the prompt itself, so neither worker expects the runner to enforce any of it.
 */
export const PR_REPORT_RULE_MAINTAINER = `The review is an evidence decision and your report is its record; scale it to the pull request, short for a small change and full where the risk is. Check each acceptance condition in the task's "Done when:" line, by its ID where the line carries one and otherwise in its own words, against the diff and the tests: read the test the report names, confirm it asserts what the condition says and, for a fix, that it would have failed before the change, and where that is cheap, run it against the default branch yourself. In your report, say for each condition whether it is met and whether its evidence holds: the expected result, what you actually checked, and a link to the test or run that shows it. A condition whose evidence does not support it (a test that would have passed before the change, an expected result the diff does not deliver, an item presented as run that the report itself says was unrun) is a blocking issue like any other: name the ID and what is missing. An honestly reported unrun or not-met item is never a reason to reject the report itself: weigh it, say what verifying it would take, and let the merge decision turn on whether the condition is actually satisfied. Nothing in the runner enforces any of this, by design; the report is judged by you and the founder, never failed by the system.`;
