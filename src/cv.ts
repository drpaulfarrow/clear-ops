/**
 * The CV agent's one tool of its own: saving Markdown files (the facts file, the master CV, tailored
 * versions, bios) into a private folder on the data volume. They hold personal data, so the folder is
 * never inside a git checkout, is owner-only, takes plain text only, and nothing can be written outside it.
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { config } from "./config.js";

export const CV_SERVER = "cv";
export const CV_TOOLS = [`mcp__${CV_SERVER}__save_cv_file`];
export const cvDir = () => path.join(config.dataDir, "cv");

/** A file name for save_cv_file: one level, Markdown or plain text. */
export function checkCvName(name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(md|txt)$/i.test(name) || name.includes("..")) {
    throw new Error("CV file names are one plain file name ending .md or .txt, for example facts.md, master-cv.md or cv-advisory-2026-11.md");
  }
  return name;
}

/** Writes a CV document into the private CV folder, nowhere else. Overwrites a file of the same name. */
export function saveCvFile(name: string, content: string): string {
  checkCvName(name);
  if (Buffer.byteLength(content) > 200_000) throw new Error("CV files are capped at 200 KB");
  const dir = cvDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const root = path.resolve(dir);
  const p = path.resolve(root, name);
  if (!p.startsWith(root + path.sep)) throw new Error(`${name} is outside the CV folder`);
  fs.writeFileSync(p, content, { mode: 0o600 });
  fs.chmodSync(p, 0o600);
  return p;
}

export function cvServer() {
  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
  return createSdkMcpServer({
    name: CV_SERVER,
    version: "1.0.0",
    tools: [
      tool(
        "save_cv_file",
        `Save a CV document (facts file, master CV, tailored CV, LinkedIn summary, bio) as Markdown or plain text in Paul's private CV folder, ${cvDir()}. One plain file name; nothing outside the folder; the same name overwrites the old version.`,
        { name: z.string(), content: z.string() },
        async ({ name, content }) => {
          try {
            return text(`Saved ${saveCvFile(name, content)}`);
          } catch (err) {
            return { ...text(`Not saved: ${err instanceof Error ? err.message : String(err)}`), isError: true };
          }
        },
      ),
    ],
  });
}
