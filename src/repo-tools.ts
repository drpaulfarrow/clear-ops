import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { prepareRepo } from "./bootstrap.js";
import { createRepo, RepoError, redact, type CreateRepoDeps } from "./repos.js";
import type { Store } from "./store.js";

/** The tool server an engineer job gets only when the chief granted it the create_repo permit. */
export const REPO_SERVER = "repos";

/** Added to the brief of an engineer job that holds the permit. */
export const CREATE_REPO_NOTE = `This job holds the create_repo permit: Paul asked in chat for a new repository. You have one extra tool, mcp__${REPO_SERVER}__create_repo, which creates it under Paul's GitHub account (private unless the brief says Paul wants it public), with a README and an initial commit on the default branch, adds it to the repositories the workforce manages and clones it. It is the only way to create a repository: do not use gh repo create or the GitHub API yourself. It never deletes a repository or changes visibility or settings, and you must not push to the default branch of any repository (the new repository's initial commit is made by GitHub). Create the repository once, then do the rest of the brief on a branch in the new checkout the tool returns and open a pull request as usual. If the tool reports that the GitHub token cannot do it, stop and put its message, which says exactly what Paul must change, at the top of your report and in your message to him, in plain words.`;

/**
 * The engineer's create_repo tool. Built only for a job that holds the create_repo permit, so a
 * brief, an email or a job output can never obtain it. Errors come back as plain English with what
 * Paul must change, and never contain the token.
 */
export function repoServer(deps: { store: Pick<Store, "addCreatedRepo">; jobId: string; createDeps?: Partial<CreateRepoDeps> }) {
  const create = (a: { name: string; description?: string; public?: boolean }) => async () => {
    try {
      const r = await createRepo(
        { ...a, jobId: deps.jobId },
        { store: deps.store, fetch: deps.createDeps?.fetch, clone: deps.createDeps?.clone ?? ((slug, dir) => prepareRepo(slug, dir)) },
      );
      return {
        content: [
          {
            type: "text" as const,
            text: `Created ${r.slug} (${r.private ? "private" : "public"}) with a README and an initial commit on ${r.defaultBranch}. It is now a managed repository with alias "${r.alias}", cloned at ${r.dir}. ${r.url}`,
          },
        ],
      };
    } catch (err) {
      const text = err instanceof RepoError ? err.plain : `Could not create the repository: ${redact(err instanceof Error ? err.message : String(err)).slice(0, 300)}`;
      return { content: [{ type: "text" as const, text }], isError: true };
    }
  };
  return createSdkMcpServer({
    name: REPO_SERVER,
    version: "1.0.0",
    tools: [
      tool(
        "create_repo",
        "Create a new GitHub repository under Paul's account, private unless he said public, with a README and an initial commit, and add it to the managed repositories. Returns its alias and checkout path.",
        {
          name: z.string().describe("Repository name: letters, numbers, dots, dashes, underscores."),
          description: z.string().optional().describe("One line for the README and the GitHub description."),
          public: z.boolean().optional().describe("true only when Paul said the repository should be public. Omit for private."),
        },
        (a) => create(a)(),
      ),
    ],
  });
}
