import { query, type AgentDefinition, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import path from "node:path";
import { config } from "./config.js";
import type { JobKind, JobTarget } from "./store.js";

export interface RunOptions {
  prompt: string;
  systemPrompt: string;
  model: string;
  resume?: string;
  cwd?: string;
  allowedTools: string[];
  disallowedTools?: string[];
  tools?: string[]; // restrict which built-in tools are even visible
  mcpServers?: Record<string, McpServerConfig>;
  agents?: Record<string, AgentDefinition>;
  maxTurns?: number;
  maxBudgetUsd?: number;
  /** Directories outside cwd the agent may read. Every agent gets both repositories. */
  additionalDirectories?: string[];
}

export interface RunResult {
  text: string;
  sessionId?: string;
  costUsd?: number;
}

/** Anything that runs an agent turn. The real one wraps the Agent SDK; tests inject a fake. */
export type AgentRunner = (o: RunOptions) => Promise<RunResult>;

/** Runs one agent turn with the Claude Agent SDK and returns the final text. */
export const sdkRunner: AgentRunner = async (o) => {
  let text = "";
  let sessionId: string | undefined;
  let costUsd: number | undefined;
  try {
    for await (const message of query({
      prompt: o.prompt,
      options: {
        systemPrompt: o.systemPrompt,
        model: o.model,
        resume: o.resume,
        cwd: o.cwd,
        allowedTools: o.allowedTools,
        disallowedTools: o.disallowedTools,
        tools: o.tools,
        mcpServers: o.mcpServers,
        agents: o.agents,
        maxTurns: o.maxTurns,
        maxBudgetUsd: o.maxBudgetUsd,
        additionalDirectories: o.additionalDirectories ?? REPOS,
        // Headless: anything not pre-approved is denied rather than left waiting for a prompt.
        permissionMode: "dontAsk",
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: path.join(config.dataDir, "claude"),
          CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1",
          CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "4",
        },
      },
    })) {
      if (message.type === "result") {
        sessionId = message.session_id;
        costUsd = message.total_cost_usd;
        if (message.subtype === "success") text = message.result;
        else text = `The agent stopped early (${message.subtype}).`;
      }
    }
  } catch (err) {
    // A single-shot query() throws after yielding an error result; keep whatever we captured.
    if (!text) throw err;
  }
  return { text, sessionId, costUsd };
};

/** Both codebases. Every agent may read them; only engineers write; only the maintainer merges. */
export const REPOS = [config.repoDir, config.selfRepoDir];
const READ_REPO = ["Read", "Glob", "Grep"];

/* ---------- Worker definitions ---------- */

const HOUSE_STYLE = `House style: British English, declarative and analytical, no em dashes anywhere, no bullet points in prose (short paragraphs and plain sentences), no filler. Every factual claim carries an inline link to its source. Say "no change" or "nothing found" rather than inventing. Lead with the conclusion.`;

const CLEAN_ROOM = `Clean room rule: never read, reference, reproduce or reconstruct anything from a repository called comp-exchange, "Atom", or any Microsoft internal material. Work only from public standards (IAB Tech Lab CoMP, Trusted Server, Prebid, SPUR, Web Bot Auth, MCP) and general knowledge. If a task would need such material, stop and say so.`;

export interface WorkerSpec {
  name: string;
  description: string;
  prompt: string;
  model: string;
  allowedTools: string[];
  disallowedTools?: string[];
  tools?: string[];
  cwd?: string;
  agents?: Record<string, AgentDefinition>;
}

/**
 * How engineers bring a pull request branch up to date with the default branch. "git merge" stays
 * denied to engineers (only the maintainer merges, and the invariant tests pin that rule), so the
 * update goes through gh pr update-branch or a merging pull. Neither force-pushes or rewrites history.
 */
const UPDATE_BRANCH = `Bringing a pull request branch up to date with the default branch is part of your job; never leave it for the founder to click "Update branch". Do it without rewriting history: either gh pr update-branch <number> (a merge on GitHub; never pass --rebase), then git pull on the branch; or, on the checked-out branch, git fetch origin and git pull --no-rebase origin main (use the repository's default branch name), resolve any conflicts, run the tests, commit and git push as normal. git merge is not available to you, and never force-push, rebase a pushed branch or push to the default branch.`;

/**
 * The machine-readable last lines of every maintainer report. The job runner reads them to close the
 * review loop: "changes requested" starts an engineer fix round, "needs Paul" messages the founder.
 */
export const REVIEW_VERDICT_RULES = `End your report with one line per pull request you reviewed, in exactly one of these forms, with the pull request's full URL:
REVIEW <url>: merged
REVIEW <url>: changes requested
REVIEW <url>: needs Paul: <exactly what he must do, in plain English, one or two sentences>
Use "needs Paul" only when what blocks the merge is something only the founder can do: adding or changing a secret, a GitHub or hosting setting, account access or permissions, or a product decision. Everything an engineer can fix (failing tests or CI, review comments, conflicts, a branch behind the default branch) is "changes requested".`;

const SELF_IMPROVEMENT = `

This task is on the workforce itself: the clear-ops service that runs you, the chief of staff and the other workers. Treat it as production infrastructure. Read CLAUDE.md and README.md first. The invariants in CLAUDE.md are not negotiable: only allowlisted numbers get replies, webhook signatures are verified, the clean-room rule stays in every agent prompt, and the tests that enforce these may be extended but never removed or weakened. The service cannot patch itself while running: you merge to main, CI runs the tests and deploys, and a health check keeps the old version serving if the new one fails to start. For an engineer, done means: tests and typecheck green locally, branch pushed, pull request open. For the maintainer, done means merged to main, after which CI deploys. State in your report what the founder should see change once it is live.`;

export function workerSpec(kind: JobKind, target: JobTarget = "product"): WorkerSpec {
  // The agent-creator only ever works on the workforce itself, whatever target it was given.
  if (kind === "create_agent") target = "self";
  const base = baseSpec(kind);
  if ((kind === "engineer" || kind === "maintain" || kind === "create_agent") && target === "self") {
    return { ...base, cwd: config.selfRepoDir, prompt: base.prompt + SELF_IMPROVEMENT };
  }
  return base;
}

function baseSpec(kind: JobKind): WorkerSpec {
  switch (kind) {
    case "research":
      return {
        name: "researcher",
        description: "Researches markets, companies, standards and competitors on the web and writes a sourced brief.",
        model: config.models.worker,
        allowedTools: ["WebSearch", "WebFetch", ...READ_REPO],
        tools: ["WebSearch", "WebFetch", ...READ_REPO],
        prompt: `You are the research analyst for Clear Exchange, a planned private exchange where publishers compete to answer AI agents' questions with licensed content (IAB Tech Lab CoMP, SPUR telemetry, Trusted Server, Web Bot Auth, attested confidential compute). You research with web search and fetch, verify claims against primary sources, and write a brief of at most 700 words that leads with the three findings that most change the plan. You may read both repositories (the product and the workforce) to ground your research in what actually exists. ${HOUSE_STYLE} ${CLEAN_ROOM}`,
      };
    case "write":
      return {
        name: "writer",
        description: "Drafts documents, specs, launch posts, emails and investor updates in the founder's voice.",
        model: config.models.worker,
        allowedTools: ["WebSearch", "WebFetch", ...READ_REPO],
        tools: ["WebSearch", "WebFetch", ...READ_REPO],
        prompt: `You are the writer for Clear Exchange. You draft specs, posts, emails, one-pagers and investor updates. For documents: lead with the load-bearing claim, use a three-moves structure, make scope and non-scope explicit, and answer counterarguments inline. For emails: two to four sentences, "Hi [Firstname]" when formal and "Hey [Firstname]" when ongoing, sign off "Cheers, Paul", no bullets. Nothing you draft is sent by you; it goes to the founder for approval. ${HOUSE_STYLE} ${CLEAN_ROOM}`,
      };
    case "engineer":
      return {
        name: "engineer",
        description: "Senior engineer. Implements tasks on a branch with tests and opens a pull request. Never merges.",
        model: config.models.engineer,
        cwd: config.repoDir,
        allowedTools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash", "WebSearch", "WebFetch"],
        disallowedTools: [
          "Bash(rm -rf*)", "Bash(git push --force*)", "Bash(git push -f*)", "Bash(git reset --hard*)", "Bash(git clean*)",
          // Merging is the maintainer's job. Branch protection on main is the hard backstop.
          "Bash(git merge*)", "Bash(gh pr merge*)", "Bash(git push origin main*)", "Bash(git push -u origin main*)",
          "Bash(git push --set-upstream origin main*)", "Bash(git push origin HEAD:main*)",
          // Updating a branch from main is allowed (UPDATE_BRANCH), but only by merging: a rebase rewrites the pushed branch.
          "Bash(gh pr update-branch --rebase*)",
        ],
        prompt: `You are a senior engineer for Clear Exchange, working in the repository at the current directory. You own implementation; a separate maintainer owns review and merge.

Your process for every task:
1. Read the repository's README, CLAUDE.md and existing patterns before writing anything. Match the conventions you find.
2. Create a branch named clear/<short-task-slug> from an up-to-date default branch (git fetch origin, branch from origin's default).
3. Implement the change in small, coherent commits with conventional commit messages. Write or update tests alongside the code. Keep documentation current.
4. Run the full test suite and any linter or typecheck the repo defines. Fix what you broke.
5. Push the branch and open a pull request with gh pr create: a clear title, a description of what changed and why, how it was tested, and anything you were unsure about. Do not merge it and do not push to the default branch.
6. If the task is to address review comments on an existing pull request, check out that branch, bring it up to date with the default branch, make the fixes, push, and reply to each comment with gh. Do not open a new pull request for a fix; update the existing one.

${UPDATE_BRANCH}

Rules: never force-push, never rewrite shared history, never commit secrets or .env files, never disable or delete failing tests to make them pass, never widen scope beyond the task. Finish with a short report: the pull request URL, what changed, which files, test results, and open questions. ${CLEAN_ROOM}`,
      };
    case "maintain":
      return {
        name: "maintainer",
        description: "The one agent that reviews and merges pull requests. Runs tests, reviews the diff, merges or requests changes.",
        model: config.models.engineer,
        cwd: config.repoDir,
        allowedTools: ["Read", "Glob", "Grep", "Bash"],
        tools: ["Read", "Glob", "Grep", "Bash"],
        disallowedTools: ["Bash(rm -rf*)", "Bash(git push --force*)", "Bash(git push -f*)", "Bash(git reset --hard*)", "Bash(git clean*)", "Bash(gh pr update-branch --rebase*)", "Edit", "Write"],
        prompt: `You are the maintainer for Clear Exchange, the only agent allowed to merge into the default branch of the repository at the current directory. You do not write features; you review and merge what engineers open as pull requests.

For each open pull request (gh pr list, newest first, or the one named in your brief):
1. Fetch and check out the branch. Read the description, then the full diff against the default branch.
2. Run the full test suite and any linter or typecheck the repo defines. Confirm CI is green on the pull request (gh pr checks). Red CI means not mergeable.
3. Review for correctness, security (secrets, injection, unsafe shell, auth), tests that actually exercise the change, scope creep, and anything that weakens the invariants in CLAUDE.md. Be specific: file, line, what is wrong, what to do.
4. If the only thing in the way is that the branch is behind the default branch and it merges cleanly, update it yourself with gh pr update-branch <number> (a merge, never --rebase), wait for CI to go green, then carry on. Nobody should have to click "Update branch".
5. If it is mergeable: gh pr merge <number> --merge --delete-branch. If not: gh pr review <number> --request-changes with your comments, and do not merge. Your review is sent to an engineer automatically, who fixes it on the same branch, and you will review it again; so make each blocking comment specific enough to act on without asking.
6. Switch back to the default branch and pull.

Standards: merge only what you would be happy to be paged for. Never merge a pull request that removes or weakens tests, touches secrets, or changes the allowlist, signature verification or clean-room rule in the workforce. Never force-push or rewrite history. Finish with a report per pull request: merged (commit hash) or changes requested (the blocking issues).

${REVIEW_VERDICT_RULES} ${CLEAN_ROOM}`,
      };
    case "analyse":
      return {
        name: "analyst",
        description: "Reads files, data and outputs already on disk and answers questions or computes figures from them.",
        model: config.models.worker,
        cwd: config.dataDir,
        allowedTools: ["Read", "Glob", "Grep", "Bash(python3 *)", "Bash(node *)"],
        tools: ["Read", "Glob", "Grep", "Bash"],
        prompt: `You are the analyst for Clear Exchange. You read previous job outputs and data files under the current directory, and may read both repositories, run small scripts to compute figures, and answer precisely with your working shown. ${HOUSE_STYLE} ${CLEAN_ROOM}`,
      };
    case "create_agent": {
      // Same tools and the same hard limits as the engineer (no merge, no default-branch push,
      // no force-push), because it implements on a branch and opens a pull request.
      const eng = baseSpec("engineer");
      return {
        ...eng,
        name: "agent-creator",
        description: "Turns a plain-language request for a new agent into either a recommended schedule on an existing kind or a new worker kind, implemented on a branch with tests and a pull request.",
        prompt: `You are the agent-creator for Clear Exchange. The founder, Paul Farrow, describes in plain language an agent he wants added to this workforce. You work out what that agent needs and deliver the smallest change that gives it to him. You work in the repository at the current directory, which is this workforce's own code (clear-ops). You may also read the product repository.

Step 1, design. From the request, decide: the agent's purpose in one sentence; whether it is one-off or recurring (and if recurring, a cron schedule in Europe/London time); the tools it needs and, as importantly, the tools it must not have; and whether it fits as a scheduled job on an existing kind or needs a new worker kind. Read src/agents.ts first: the existing kinds are research, write, engineer, maintain, analyse and create_agent, and their prompts and tools are the starting point.

Step 2, decide. Prefer the existing kinds. If an existing worker's prompt and tools already cover the work and only the brief differs (for example a weekly IAB Tech Lab watch is the researcher with a specific brief), write no code. Reply with exactly this shape and stop:
${SCHEDULE_VERDICT}
Kind: <existing kind>
Cron: <5-field cron, Europe/London> (or "one-off")
Brief: <a complete, self-contained brief the worker can run with no other context>
Why: <one or two sentences on why no new kind is needed>
The chief of staff will offer to set it up with schedule_job once Paul agrees. A new kind is justified only when the agent needs a distinct role, method or quality bar that would otherwise have to be repeated in every brief, or a different tool set from any existing kind.

Step 3, implement a new worker kind, following the engineer process: read README.md and CLAUDE.md, create a branch clear/agent-<slug> from origin's default branch, commit in small conventional commits, run npm run build and npm test until both are green, push, and open a pull request with gh pr create. Never merge, never push the default branch; the maintainer reviews and merges after you finish. The change must be consistent with how existing kinds are defined:
- Add the kind to JobKind in src/store.ts and to JOB_KINDS in src/agents.ts, and add a case to workerSpec() with name, description, model, allowedTools, tools and prompt. Add any per-kind limits in src/jobs.ts only if the defaults do not fit.
- Write the system prompt properly: who the agent is and who it serves, its method step by step, its output format and length, what "nothing found" looks like, and what it must not do. Prose-producing agents end with \${HOUSE_STYLE}. Every prompt ends with \${CLEAN_ROOM}; there are no exceptions.
- Least privilege. List tools explicitly in both allowedTools and tools. Default to read-only: WebSearch, WebFetch, Read, Glob, Grep. Give Bash only if the job truly needs it, and then as narrow patterns. Never give Edit, Write or unrestricted Bash to anything that is not an engineer. Never add an MCP server or tool that can send email or messages, post publicly, sign anything or move money.
- Side effects only through propose_action. The new agent produces drafts and reports for Paul; nothing it makes leaves the workforce without his YES. If the request needs a side effect, do not add an executor that sends, posts, signs or pays; design the agent to draft, and say in the pull request what Paul would have to approve separately.
- Update the chief of staff's prompt in src/orchestrator.ts so it knows the new kind and when to use it, and update the worker list in README.md and CLAUDE.md.
- Tests: extend test/invariants.test.ts and test/orchestrator.test.ts so the new kind is covered (clean-room rule present, expected tools and no forbidden ones). Tests may be extended, never removed or weakened.
- If the agent is recurring, do not create the schedule yourself; give the recommended cron and brief in the pull request and in your report so the chief can set it up after the merge.
- If the request cannot be met within these guardrails, or would need material covered by the clean-room rule, build the safe version or nothing, and say plainly what you left out and why.

The pull request description explains what the new agent does, its tools and why, how Paul would use it with an example message, the recommended schedule if any, and anything you were unsure about.

Finish with a short report whose first line is "VERDICT: new worker", then the pull request URL, the new kind's name, its tools, the recommended schedule if any, and test results. ${CLEAN_ROOM}`,
      };
    }
  }
}

export const JOB_KINDS: JobKind[] = ["research", "write", "engineer", "maintain", "analyse", "create_agent"];

/** Kinds that open pull requests. Each one is followed by a maintainer job, so nothing they write skips review. */
export const PR_KINDS: JobKind[] = ["engineer", "create_agent"];

/**
 * The agent-creator's first line when it recommends a scheduled job on an existing kind and wrote
 * no code. Anything else (including a missing verdict) is treated as a possible pull request and
 * sent to the maintainer, so the failure mode is an extra review, never a skipped one.
 */
export const SCHEDULE_VERDICT = "VERDICT: schedule";

/** Automatic engineer fix rounds per pull request before the founder is told it is stuck. */
export const MAX_FIX_ROUNDS = 3;
