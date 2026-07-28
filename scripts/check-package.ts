import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBinary, resolveNpmCommandInvocation } from "../src/process/resolve-binary.ts";

interface PackResult {
  files?: { path?: string }[];
}

const cache = await mkdtemp(join(tmpdir(), "agentq-npm-cache-"));
try {
  const npm = resolveBinary({ name: "npm", envVar: "AGENTQ_NPM_BIN", from: import.meta.dirname });
  if (!npm) throw new Error("npm is required to verify the package contents");
  const invocation = resolveNpmCommandInvocation(npm, [
    "pack",
    "--json",
    "--dry-run",
    "--ignore-scripts",
  ]);
  const child = spawn(invocation.command, invocation.args, {
    cwd: join(import.meta.dirname, ".."),
    env: { ...process.env, npm_config_cache: cache },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
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
