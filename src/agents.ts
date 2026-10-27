import { query, type AgentDefinition, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import path from "node:path";
import { config } from "./config.js";
import type { JobKind } from "./store.js";

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
}

export function workerSpec(kind: JobKind): WorkerSpec {
  switch (kind) {
    case "research":
      return {
        name: "researcher",
        description: "Researches markets, companies, standards and competitors on the web and writes a sourced brief.",
        model: config.models.worker,
        allowedTools: ["WebSearch", "WebFetch"],
        tools: ["WebSearch", "WebFetch"],
        prompt: `You are the research analyst for Clear Exchange, a planned private exchange where publishers compete to answer AI agents' questions with licensed content (IAB Tech Lab CoMP, SPUR telemetry, Trusted Server, Web Bot Auth, attested confidential compute). You research with web search and fetch, verify claims against primary sources, and write a brief of at most 700 words that leads with the three findings that most change the plan. ${HOUSE_STYLE} ${CLEAN_ROOM}`,
      };
    case "write":
      return {
        name: "writer",
        description: "Drafts documents, specs, launch posts, emails and investor updates in the founder's voice.",
        model: config.models.worker,
        allowedTools: ["WebSearch", "WebFetch"],
        tools: ["WebSearch", "WebFetch"],
        prompt: `You are the writer for Clear Exchange. You draft specs, posts, emails, one-pagers and investor updates. For documents: lead with the load-bearing claim, use a three-moves structure, make scope and non-scope explicit, and answer counterarguments inline. For emails: two to four sentences, "Hi [Firstname]" when formal and "Hey [Firstname]" when ongoing, sign off "Cheers, Paul", no bullets. Nothing you draft is sent by you; it goes to the founder for approval. ${HOUSE_STYLE} ${CLEAN_ROOM}`,
      };
    case "engineer":
      return {
        name: "engineer",
        description: "Implements scoped engineering tasks in the Clear Exchange repository on a branch, with tests.",
        model: config.models.engineer,
        cwd: config.repoDir,
        allowedTools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"],
        disallowedTools: ["Bash(git push*)", "Bash(rm -rf*)", "Bash(curl*)", "Bash(wget*)", "WebFetch", "WebSearch"],
        prompt: `You are the engineer for Clear Exchange, working in the repository at the current directory. For each task: create a branch named clear/<short-task-slug> from the default branch, implement the change with tests, run the tests, and commit with a clear message. Never push; the founder approves pushes. Finish with a short report: what changed, which files, test results, and anything you were unsure about. Keep changes small and reviewable. ${CLEAN_ROOM}`,
      };
    case "analyse":
      return {
        name: "analyst",
        description: "Reads files, data and outputs already on disk and answers questions or computes figures from them.",
        model: config.models.worker,
        cwd: config.dataDir,
        allowedTools: ["Read", "Glob", "Grep", "Bash(python3 *)", "Bash(node *)"],
        tools: ["Read", "Glob", "Grep", "Bash"],
        prompt: `You are the analyst for Clear Exchange. You read previous job outputs and data files under the current directory, run small scripts to compute figures, and answer precisely with your working shown. ${HOUSE_STYLE} ${CLEAN_ROOM}`,
      };
  }
}

export const JOB_KINDS: JobKind[] = ["research", "write", "engineer", "analyse"];
