/**
 * The advisor's one tool of its own: saving slide-ready Markdown (Marp format, which converts to PPTX or PDF)
 * and one-pagers into a private folder on the data volume. The folder is never inside a git checkout, is
 * owner-only, takes plain text only, and nothing can be written outside it.
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { config } from "./config.js";

export const DECK_SERVER = "decks";
export const DECK_TOOLS = [`mcp__${DECK_SERVER}__save_deck_file`];
export const deckDir = () => path.join(config.dataDir, "decks");

/** A file name for save_deck_file: one level, Markdown or plain text. */
export function checkDeckName(name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(md|txt)$/i.test(name) || name.includes("..")) {
    throw new Error("Deck file names are one plain file name ending .md or .txt, for example deck-investor-2026-11.md or one-pager-publisher.md");
  }
  return name;
}

/** Writes a deck or one-pager into the private CV folder, nowhere else. Overwrites a file of the same name. */
export function saveDeckFile(name: string, content: string): string {
  checkDeckName(name);
  if (Buffer.byteLength(content) > 200_000) throw new Error("Deck files are capped at 200 KB");
  const dir = deckDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const root = path.resolve(dir);
  const p = path.resolve(root, name);
  if (!p.startsWith(root + path.sep)) throw new Error(`${name} is outside the decks folder`);
  fs.writeFileSync(p, content, { mode: 0o600 });
  fs.chmodSync(p, 0o600);
  return p;
}

export function deckServer() {
  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
  return createSdkMcpServer({
    name: DECK_SERVER,
    version: "1.0.0",
    tools: [
      tool(
        "save_deck_file",
        `Save a deck (slide-ready Marp Markdown) or a one-pager as Markdown or plain text in Paul's private decks folder, ${deckDir()}. One plain file name; nothing outside the folder; the same name overwrites the old version.`,
        { name: z.string(), content: z.string() },
        async ({ name, content }) => {
          try {
            return text(`Saved ${saveDeckFile(name, content)}`);
          } catch (err) {
            return { ...text(`Not saved: ${err instanceof Error ? err.message : String(err)}`), isError: true };
          }
        },
      ),
    ],
  });
}
