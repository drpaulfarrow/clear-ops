import { randomBytes } from "node:crypto";
import { redact } from "./repos.js";
import type { Job, Store } from "./store.js";

/**
 * A project space of Paul's own (docs/APP.md): a name, a chat of its own, and optionally some of the
 * managed repositories. It is not a repository itself; every managed repository already has a space
 * made for it automatically.
 *
 * What belongs to one: the jobs on its repositories, and any job started from its chat. Nothing is
 * moved or copied: a space is a way of looking at the same jobs, so removing one removes its chat and
 * leaves every job where it was.
 *
 * It grants nothing. A space cannot name a repository the service does not already manage, its name is
 * Paul's own words and is treated as that (tidied, cut short, redacted), and its chat is one of the
 * app's own conversations like any other (src/web-chat.ts).
 */
export interface OwnSpace {
  /** Made here, at random: "own-" and eight hex digits, so it can never be mistaken for one he typed. */
  id: string;
  name: string;
  /** Aliases of managed repositories. May be empty. */
  repos: string[];
  createdAt: string;
}

export const SPACES_MAX = 20;
export const SPACE_NAME_MAX = 48;
export const SPACE_REPOS_MAX = 8;
export const OWN_SPACE_ID = /^own-[a-f0-9]{8}$/;

/** Why a space could not be made or changed, in words for Paul. */
export class SpaceError extends Error {}

/** A space's name from what was typed: its first line, tidied, redacted and cut short. Empty when nothing is left. */
export function spaceName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const line = redact(raw).split("\n").find((l) => l.trim())?.replace(/\s+/g, " ").trim() ?? "";
  return line.length > SPACE_NAME_MAX ? `${line.slice(0, SPACE_NAME_MAX - 1).trimEnd()}…` : line;
}

/** The repositories asked for, each one the service manages and each once; undefined when the list is anything else. */
export function spaceRepos(raw: unknown, managed: readonly string[]): string[] | undefined {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > SPACE_REPOS_MAX) return undefined;
  const out: string[] = [];
  for (const r of raw) {
    if (typeof r !== "string" || !managed.includes(r)) return undefined;
    if (!out.includes(r)) out.push(r);
  }
  return out;
}

/** The address of a space's chat (the same shape a repository's space has). */
export const ownSpaceAddress = (id: string): string => `web:space:${id}`;

/** Whether a job belongs to a space of Paul's own: it is on one of its repositories, or was started from its chat. */
export function inOwnSpace(space: OwnSpace, job: Pick<Job, "replyTo" | "requestedBy">, repository: string): boolean {
  return space.repos.includes(repository) || (job.replyTo ?? job.requestedBy) === ownSpaceAddress(space.id);
}

function checked(store: Pick<Store, "spaces">, o: { name?: unknown; repos?: unknown }, managed: ReadonlyArray<{ alias: string; name: string }>, self?: string): { name: string; repos: string[] } {
  const name = spaceName(o.name);
  if (!name) throw new SpaceError("A space needs a name.");
  const taken = [...managed.map((m) => m.name), ...store.spaces().filter((s) => s.id !== self).map((s) => s.name)];
  if (taken.some((t) => t.toLowerCase() === name.toLowerCase())) throw new SpaceError("There is already a space with that name.");
  const repos = spaceRepos(o.repos, managed.map((m) => m.alias));
  if (!repos) throw new SpaceError(`A space takes up to ${SPACE_REPOS_MAX} of the repositories ClearOps manages.`);
  return { name, repos };
}

/** Makes a space. `managed` is every repository the service manages, with the name its own space goes by. */
export function createSpace(store: Pick<Store, "spaces" | "setSpaces">, o: { name?: unknown; repos?: unknown }, managed: ReadonlyArray<{ alias: string; name: string }>, now: number = Date.now()): OwnSpace {
  const all = store.spaces();
  if (all.length >= SPACES_MAX) throw new SpaceError(`There are already ${SPACES_MAX} spaces of your own. Remove one first.`);
  const { name, repos } = checked(store, o, managed);
  let id = `own-${randomBytes(4).toString("hex")}`;
  while (all.some((s) => s.id === id) || managed.some((m) => m.alias === id)) id = `own-${randomBytes(4).toString("hex")}`;
  const made: OwnSpace = { id, name, repos, createdAt: new Date(now).toISOString() };
  store.setSpaces([...all, made]);
  return made;
}

/** Renames a space or changes its repositories. Undefined when there is no such space. */
export function updateSpace(store: Pick<Store, "spaces" | "setSpaces">, id: unknown, o: { name?: unknown; repos?: unknown }, managed: ReadonlyArray<{ alias: string; name: string }>): OwnSpace | undefined {
  const all = store.spaces();
  const was = all.find((s) => s.id === id);
  if (!was) return undefined;
  const next: OwnSpace = { ...was, ...checked(store, o, managed, was.id) };
  store.setSpaces(all.map((s) => (s.id === was.id ? next : s)));
  return next;
}

/** Removes a space. Its jobs are untouched: they were never its own. Undefined when there is no such space. */
export function removeSpace(store: Pick<Store, "spaces" | "setSpaces">, id: unknown): OwnSpace | undefined {
  const all = store.spaces();
  const was = all.find((s) => s.id === id);
  if (!was) return undefined;
  store.setSpaces(all.filter((s) => s.id !== was.id));
  return was;
}
