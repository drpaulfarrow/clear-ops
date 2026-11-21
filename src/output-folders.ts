import type { Job } from "./store.js";

/**
 * Which folder a finished job's output goes into in the outputs repository, and which outputs are
 * never copied there. Pure functions over strings: nothing here reads a file.
 */

/** Kinds whose outputs hold Paul's mail, calendar or personal documents, and an output with no job record cannot be classified: never copied. */
export const EXCLUDED_KINDS = new Set(["ea", "cv", "unknown"]);

const FOLDERS: Record<string, string> = {
  design: "designs",
  research: "research",
  analyse: "research",
  ideate: "ideas",
  advisor: "advice",
  prebid: "advice",
  engineer: "engineering",
  create_agent: "engineering",
  maintain: "reviews",
  dns: "ops",
};

/** A research job whose title says it is a design document belongs with the designs. */
const DESIGN_TITLE = /\b(design|spec|specification|architecture|brand)\b/i;

/** Text that shows an output was derived from a file Paul uploaded (a contacts export and the like). */
const UPLOAD_MARKERS = [/\/data\/up(?:loads)\b/i, /\bConnections\.csv\b/i, /\bconnections export\b/i];

/** Why an output made from a file Paul uploaded is never copied: the one withheld reason the signed-in app still shows him (src/reports.ts). */
export const FROM_UPLOAD = "derived from a file Paul uploaded";

export type Verdict = { folder: string } | { excluded: string };

export function classify(job: Pick<Job, "kind" | "title" | "brief" | "docSnapshot">, text: string): Verdict {
  if (EXCLUDED_KINDS.has(job.kind)) return { excluded: `${job.kind} outputs are not copied` };
  // A job that read a private Google Doc snapshot Paul bound to it (src/doc-reader.ts): the document's
  // words can reach its output, so the output is never mirrored to the public outputs repository.
  if (job.docSnapshot) return { excluded: "bound to a private Google Doc snapshot" };
  // Code work (engineer, create_agent, maintain) talks about the uploads feature without holding anyone's data.
  const code = job.kind === "engineer" || job.kind === "create_agent" || job.kind === "maintain";
  const hay = `${job.brief ?? ""}\n${text}`;
  if (!code && UPLOAD_MARKERS.some((m) => m.test(hay))) return { excluded: FROM_UPLOAD };
  if (job.kind === "research" && DESIGN_TITLE.test(job.title ?? "")) return { folder: "designs" };
  return { folder: FOLDERS[job.kind] ?? "other" };
}

export const FOLDER_ORDER = ["designs", "research", "advice", "ideas", "engineering", "reviews", "ops", "other"];
