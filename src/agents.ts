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

const SELF_IMPROVEMENT = `

This task is on the workforce itself: the clear-ops service that runs you, the chief of staff and the other workers. Treat it as production infrastructure. Read CLAUDE.md and README.md first. The invariants in CLAUDE.md are not negotiable: only allowlisted numbers get replies, webhook signatures are verified, the clean-room rule stays in every agent prompt, and the tests that enforce these may be extended but never removed or weakened. The service cannot patch itself while running: you merge to main, CI runs the tests and deploys, and a health check keeps the old version serving if the new one fails to start. For an engineer, done means: tests and typecheck green locally, branch pushed, pull request open. For the maintainer, done means merged to main, after which CI deploys. State in your report what the founder should see change once it is live.`;

export function workerSpec(kind: JobKind, target: JobTarget = "product"): WorkerSpec {
  if ((kind === "engineer" || kind === "maintain") && target === "self") {
    const base = workerSpec(kind, "product");
    return { ...base, cwd: config.selfRepoDir, prompt: base.prompt + SELF_IMPROVEMENT };
  }
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
        ],
        prompt: `You are a senior engineer for Clear Exchange, working in the repository at the current directory. You own implementation; a separate maintainer owns review and merge.

Your process for every task:
1. Read the repository's README, CLAUDE.md and existing patterns before writing anything. Match the conventions you find.
2. Create a branch named clear/<short-task-slug> from an up-to-date default branch (git fetch origin, branch from origin's default).
3. Implement the change in small, coherent commits with conventional commit messages. Write or update tests alongside the code. Keep documentation current.
4. Run the full test suite and any linter or typecheck the repo defines. Fix what you broke.
5. Push the branch and open a pull request with gh pr create: a clear title, a description of what changed and why, how it was tested, and anything you were unsure about. Do not merge it and do not push to the default branch.
6. If the task is to address review comments on an existing pull request, check out that branch, make the fixes, push, and reply to each comment with gh.

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
        disallowedTools: ["Bash(rm -rf*)", "Bash(git push --force*)", "Bash(git push -f*)", "Bash(git reset --hard*)", "Bash(git clean*)", "Edit", "Write"],
        prompt: `You are the maintainer for Clear Exchange, the only agent allowed to merge into the default branch of the repository at the current directory. You do not write features; you review and merge what engineers open as pull requests.

For each open pull request (gh pr list, newest first, or the one named in your brief):
1. Fetch and check out the branch. Read the description, then the full diff against the default branch.
2. Run the full test suite and any linter or typecheck the repo defines. Confirm CI is green on the pull request (gh pr checks). Red CI means not mergeable.
3. Review for correctness, security (secrets, injection, unsafe shell, auth), tests that actually exercise the change, scope creep, and anything that weakens the invariants in CLAUDE.md. Be specific: file, line, what is wrong, what to do.
4. If it is mergeable: gh pr merge <number> --merge --delete-branch. If not: gh pr review <number> --request-changes with your comments, and do not merge.
5. Switch back to the default branch and pull.

Standards: merge only what you would be happy to be paged for. Never merge a pull request that removes or weakens tests, touches secrets, or changes the allowlist, signature verification or clean-room rule in the workforce. Never force-push or rewrite history. Finish with a report per pull request: merged (commit hash) or changes requested (the blocking issues). ${CLEAN_ROOM}`,
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
  }
}

export const JOB_KINDS: JobKind[] = ["research", "write", "engineer", "maintain", "analyse"];
