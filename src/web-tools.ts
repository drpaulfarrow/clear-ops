/**
 * Which workers get the service's own search (src/search.ts) and browser (src/browse.ts). Research-type
 * kinds only: never the executive assistant (its inputs are Paul's mail, and a search query or page
 * visit could carry mail content out), the DNS agent, the engineers or the design worker (it has its
 * own sandboxed browser).
 */
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { config } from "./config.js";
import { BROWSE_SERVER, BROWSE_TOOLS, BrowseSession, browseServer, type BrowseDeps } from "./browse.js";
import { SEARCH_SERVER, SEARCH_TOOLS, searchEngines, searchServer, type Fetcher } from "./search.js";
import type { JobKind } from "./store.js";

export const SEARCH_KINDS: JobKind[] = ["research", "write", "ideate", "advisor", "prebid", "cv"];
export const BROWSE_KINDS: JobKind[] = ["research", "ideate", "advisor", "prebid"];

export interface WebTools {
  servers: Record<string, McpServerConfig>;
  allowed: string[];
  /** One paragraph for the worker's prompt, empty when it gets nothing. */
  note: string;
  close: () => Promise<void>;
  /** The job's browser, when it has one: the purchase gate completes an approved order in it. */
  session?: BrowseSession;
}

export function webToolsFor(kind: JobKind, deps: { fetcher?: Fetcher; browse?: BrowseDeps } = {}): WebTools {
  const servers: Record<string, McpServerConfig> = {};
  const allowed: string[] = [];
  const notes: string[] = [];
  let session: BrowseSession | undefined;
  const engines = searchEngines();
  if (SEARCH_KINDS.includes(kind) && engines.length) {
    servers[SEARCH_SERVER] = searchServer(deps.fetcher);
    const tools = SEARCH_TOOLS.filter((t) => engines.includes("brave") || !t.endsWith("__web_search")).filter((t) => engines.includes("exa") || !t.endsWith("__exa_search"));
    allowed.push(...tools);
    notes.push(
      `Search: prefer ${engines.includes("brave") ? "web_search (Brave) for current facts and news" : ""}${engines.length === 2 ? ", and " : ""}${engines.includes("exa") ? "exa_search for finding companies, people, papers and similar pages" : ""} over the built-in WebSearch, which may not work on every model. Open and read a source before citing it.`,
    );
  }
  if (BROWSE_KINDS.includes(kind) && config.browse.enabled) {
    session = new BrowseSession(deps.browse);
    servers[BROWSE_SERVER] = browseServer(session);
    allowed.push(...BROWSE_TOOLS);
    notes.push(
      "Browser: open, read, click, type, back and sign_in drive a real browser. Use it when WebFetch returns an empty or blocked page, or to use a site. You may fill forms and run searches on sites Paul lets agents act on, and sign_in signs in with his stored login (you never see the password). Paying, sending, posting, deleting and the like are refused everywhere: when a task needs one, stop and say exactly what you would do so Paul can decide.",
    );
  }
  return {
    servers,
    allowed,
    note: notes.length ? `\n\nWeb tools:\n${notes.join("\n")}` : "",
    close: async () => {
      await session?.close();
    },
    ...(session ? { session } : {}),
  };
}
