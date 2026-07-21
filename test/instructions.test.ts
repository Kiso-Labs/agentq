import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installIntegration } from "../src/integrations/instructions.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("integration installation preserves content and is idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentq-integration-"));
  roots.push(root);
  await writeFile(join(root, "AGENTS.md"), "# Existing\n");

  expect((await installIntegration(root, "codex"))[0]?.action).toBe("updated");
  const once = await readFile(join(root, "AGENTS.md"), "utf8");
  expect(once).toContain("# Existing");
  expect(once).toContain("<!-- agentq:start -->");
  expect((await installIntegration(root, "codex"))[0]?.action).toBe("unchanged");
  expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(once);
});
