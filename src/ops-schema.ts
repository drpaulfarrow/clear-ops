import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Store } from "./store.js";

/**
 * The chief's ops tools ride an in-process MCP server whose namespace is versioned by schema.
 *
 * Why: a resumed Agent SDK session (pinned 0.3.311) reuses the tool schemas it has already recorded
 * for an MCP server name it knows, so rebuilding the server each turn is not enough. Verified against
 * a loopback fake of the Messages API with the real CLI (`test/chief-schema-resume.test.ts`): resuming
 * a session with a freshly built server under the SAME name keeps advertising the old schema on the
 * wire (a parameter added in a deploy is invisible to every existing conversation, which is how
 * `reviewOnly` went missing), while a NEW name is registered fresh, the current schema is advertised,
 * and the session id and history are retained. `reconnectMcpServer` cannot see SDK servers and
 * `setMcpServers` remove/re-add does not refresh them, so the namespace name is the one lever that
 * works. `allowedTools` and the status-line prefix (`src/status.ts`) must match the name.
 *
 * The rule for anyone changing the chief's ops tools: any change to a tool's parameters (a new
 * argument, a changed type or enum, a new tool) is a schema change. Bump `OPS_SCHEMA_VERSION` in the
 * same pull request, which renames the namespace and so re-registers every resumed session with the
 * current schema. The fail-closed guard below pins the advertised shape per namespace in the store at
 * boot: if the shape changes without the version bump, the service refuses to run rather than serve
 * resumed sessions a stale schema, so the mistake is caught at deploy (the health check keeps the
 * previous version serving) instead of as a silent incident.
 */

/** Schema version of the chief's ops tools. 1 was the unversioned "ops" namespace (before 17 Nov 2026). */
export const OPS_SCHEMA_VERSION = 2;

/** The chief's ops MCP namespace: stable for an unchanged schema, new on every schema change. */
export const OPS_SERVER_NAME = OPS_SCHEMA_VERSION <= 1 ? "ops" : `ops_v${OPS_SCHEMA_VERSION}`;

/** allowedTools entry matching every tool of the chief's ops server. */
export const OPS_TOOLS = `mcp__${OPS_SERVER_NAME}__*`;

/** Matches a chief ops tool name under any schema version, past (`mcp__ops__x`) or present (`mcp__ops_v2__x`). */
export const OPS_TOOL_NAME = /^mcp__ops(?:_v\d+)?__/;

/** One tool as the model meets it: its name and its input schema with all descriptions stripped (they carry runtime text, e.g. the managed repository list) and its keys sorted, so two listings of the same schema compare equal. */
export interface OpsToolShape {
  name: string;
  schema: unknown;
}

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== "description")
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, v]) => [key, canonical(v)]),
    );
  }
  return value;
};

/**
 * The shapes a server would advertise on the wire, read the way the CLI reads them: a real MCP client
 * over a linked in-memory transport, the same wiring the Agent SDK gives an in-process server. Only a
 * throwaway probe server is ever connected here (the orchestrator builds one for the guard); the
 * server a chief turn actually gets is never touched.
 */
export async function opsToolShapes(server: McpSdkServerConfigWithInstance): Promise<OpsToolShape[]> {
  const client = new Client({ name: "clear-ops-schema-check", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const listed = await client.listTools();
    return listed.tools.map((t) => ({ name: t.name, schema: canonical(t.inputSchema) }));
  } finally {
    await client.close();
  }
}

/**
 * The fail-closed guard, run once at boot (`Orchestrator` starts it; `src/index.ts` awaits it before
 * listening). The first boot under a namespace pins its advertised shape in the store; every later
 * boot under the same namespace must advertise exactly that shape. A schema change without a version
 * bump therefore fails the boot closed, with the fix named, instead of silently advertising the old
 * schema to every resumed chief session.
 */
export async function guardOpsSchema(namespace: string, buildServer: () => McpSdkServerConfigWithInstance, store: Store): Promise<void> {
  const shapes = await opsToolShapes(buildServer());
  const pinned = store.opsSchema(namespace);
  if (!pinned) {
    store.pinOpsSchema(namespace, shapes);
    return;
  }
  // Compared by tool name, not listing order, so a reorder in the MCP layer is never mistaken for a
  // schema change (and a genuine change is still caught whatever order it is listed in).
  const byName = (a: OpsToolShape, b: OpsToolShape) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const same = JSON.stringify([...pinned].sort(byName)) === JSON.stringify([...shapes].sort(byName));
  if (!same) {
    throw new Error(
      `The chief's ops tool schema changed without a schema-version bump: namespace "${namespace}" is pinned in the store with a different shape, so resumed sessions would keep being advertised the old schema. Bump OPS_SCHEMA_VERSION in src/ops-schema.ts (which renames the namespace, so every resumed session is re-registered with the current schema) and deploy again.`,
    );
  }
}
