import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AGENT_INTEGRATION_TEXT } from "../core/prompt.ts";

const START = "<!-- agentq:start -->";
const END = "<!-- agentq:end -->";

export type IntegrationTarget = "codex" | "claude" | "all";

export interface IntegrationResult {
  file: string;
  action: "created" | "updated" | "unchanged";
}

function upsertSection(existing: string): { text: string; changed: boolean } {
  const section = `${START}\n${AGENT_INTEGRATION_TEXT.trim()}\n${END}`;
  const start = existing.indexOf(START);
  const end = existing.indexOf(END);

  if (start >= 0 && end >= start) {
    const next = `${existing.slice(0, start)}${section}${existing.slice(end + END.length)}`;
    return { text: next, changed: next !== existing };
  }

  const prefix = existing.trimEnd();
  return { text: `${prefix}${prefix ? "\n\n" : ""}${section}\n`, changed: true };
}

export async function installIntegration(
  repoPath: string,
  target: IntegrationTarget,
): Promise<IntegrationResult[]> {
  const root = resolve(repoPath);
  const files =
    target === "all"
      ? ["AGENTS.md", "CLAUDE.md"]
      : [target === "codex" ? "AGENTS.md" : "CLAUDE.md"];
  const results: IntegrationResult[] = [];

  for (const name of files) {
    const file = join(root, name);
    let existing = "";
    let existed = true;
    try {
      existing = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      existed = false;
    }

    const next = upsertSection(existing);
    if (next.changed) await writeFile(file, next.text, "utf8");
    results.push({
      file,
      action: next.changed ? (existed ? "updated" : "created") : "unchanged",
    });
  }

  return results;
}
