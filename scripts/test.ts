const testFiles = [
  "test/process.test.ts",
  "test/executors.test.ts",
  "test/store.test.ts",
  "test/intake.test.ts",
  "test/worktrees.test.ts",
  "test/repository.test.ts",
  "test/app.test.ts",
  "test/ui.test.tsx",
  "test/instructions.test.ts",
  "test/supervisor.test.ts",
  "test/cli.test.ts",
] as const;

for (const file of testFiles) {
  const child = Bun.spawn([process.execPath, "test", file, "--max-concurrency=4"], {
    cwd: `${import.meta.dir}/..`,
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) process.exit(exitCode);
}
