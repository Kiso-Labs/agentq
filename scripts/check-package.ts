import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBinary, resolveCommandInvocation } from "../src/process/resolve-binary.ts";

interface PackResult {
  files?: { path?: string }[];
}

const cache = await mkdtemp(join(tmpdir(), "agentq-npm-cache-"));
try {
  const npm = resolveBinary({ name: "npm", envVar: "AGENTQ_NPM_BIN", from: import.meta.dir });
  if (!npm) throw new Error("npm is required to verify the package contents");
  const invocation = resolveCommandInvocation(npm, [
    "pack",
    "--json",
    "--dry-run",
    "--ignore-scripts",
  ]);
  const child = Bun.spawn([invocation.command, ...invocation.args], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, npm_config_cache: cache },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr || stdout || `npm pack exited ${exitCode}`);
  const result = (JSON.parse(stdout) as PackResult[])[0];
  const files = new Set(result?.files?.flatMap((file) => (file.path ? [file.path] : [])) ?? []);
  const required = [
    "LICENSE",
    "README.md",
    "dist/agentq",
    "dist/agentq.map",
    "docs/architecture.md",
    "docs/releasing.md",
    "docs/security.md",
    "package.json",
  ];
  for (const path of required) {
    if (!files.has(path)) throw new Error(`npm package is missing required file: ${path}`);
  }
  for (const path of files) {
    if (path.startsWith("src/") || path.startsWith("test/")) {
      throw new Error(`npm package unexpectedly contains development source: ${path}`);
    }
  }
  console.log(`npm package contents verified (${files.size} files)`);
} finally {
  await rm(cache, { recursive: true, force: true });
}
