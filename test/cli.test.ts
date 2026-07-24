import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentQStore } from "../src/store/index.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
  );
});

const projectRoot = join(import.meta.dir, "..");
const cliEntry = join(projectRoot, "src", "cli.tsx");

async function cli(
  stateDir: string,
  args: string[],
  stdin?: string,
  cwd = projectRoot,
  env: NodeJS.ProcessEnv = {},
) {
  const process = Bun.spawn({
    cmd: [Bun.which("bun") ?? "bun", cliEntry, "--state-dir", stateDir, ...args],
    cwd,
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...globalThis.process.env, NO_COLOR: "1", ...env },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    process.stdout.text(),
    process.stderr.text(),
    process.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function git(cwd: string, args: string[]): Promise<void> {
  const process = Bun.spawn({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  const [stderr, exitCode] = await Promise.all([process.stderr.text(), process.exited]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
}

async function repository(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  await git(root, ["init", "--initial-branch=main"]);
  await git(root, ["config", "user.name", "AgentQ Tests"]);
  await git(root, ["config", "user.email", "agentq@example.invalid"]);
  await writeFile(join(root, "README.md"), "# fixture\n");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "Initial fixture"]);
  return root;
}

describe("agentq CLI", () => {
  test("creates a queue and accepts idempotent JSON tasks", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentq-cli-"));
    roots.push(stateDir);
    const repository = join(import.meta.dir, "..");
    const created = await cli(stateDir, [
      "queue",
      "create",
      "cli",
      "--repo",
      repository,
      "--plan-model",
      "gpt-planner",
      "--plan-instructions",
      "Inspect repository conventions first.",
      "--implement-model",
      "gpt-builder",
      "--implement-instructions",
      "Keep the change focused.",
      "--json",
    ]);
    expect(created.exitCode).toBe(0);
    expect(JSON.parse(created.stdout)).toMatchObject({
      name: "cli",
      planModel: "gpt-planner",
      planInstructions: "Inspect repository conventions first.",
      implementModel: "gpt-builder",
      implementInstructions: "Keep the change focused.",
    });

    const input = JSON.stringify({
      queue: "cli",
      title: "JSON task",
      instructions: "Exercise the machine interface",
      provider: "claude",
      idempotencyKey: "cli-json-task",
    });
    const first = await cli(stateDir, ["task", "add", "--stdin-json"], input);
    const duplicate = await cli(stateDir, ["task", "add", "--stdin-json"], input);
    expect(first.exitCode).toBe(0);
    expect(JSON.parse(duplicate.stdout).id).toBe(JSON.parse(first.stdout).id);

    const listed = await cli(stateDir, ["task", "list", "--json"]);
    expect(listed.exitCode).toBe(0);
    expect(JSON.parse(listed.stdout)).toHaveLength(1);
  });

  test("creates a queue with structured policy and delivery defaults", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentq-cli-structured-queue-"));
    roots.push(stateDir);
    const repositoryRoot = await repository("agentq-structured-queue-repo-");

    const result = await cli(
      stateDir,
      [
        "queue",
        "create",
        "governed",
        "--allow-path",
        "src/**",
        "--allow-path",
        "test/**",
        "--deny-path",
        "src/generated/**",
        "--max-changed-files",
        "25",
        "--checkpoint",
        "after-plan",
        "--base-drift",
        "rebase",
        "--land-strategy",
        "stack",
        "--auto-land",
        "--file-concurrency",
        "enforced",
        "--json",
      ],
      undefined,
      repositoryRoot,
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      name: "governed",
      allowedPaths: ["src/**", "test/**"],
      deniedPaths: ["src/generated/**"],
      maxChangedFiles: 25,
      approvalCheckpoints: ["after-plan"],
      baseDriftPolicy: "rebase",
      landStrategy: "stack",
      autoLand: true,
      fileConcurrency: "enforced",
    });
  });

  test("returns a script-friendly error for invalid JSON", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentq-cli-error-"));
    roots.push(stateDir);
    const result = await cli(stateDir, ["task", "add", "--stdin-json"], "not-json");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Invalid task JSON");
  });

  test("accepts structured task fields through JSON stdin", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentq-cli-structured-json-"));
    roots.push(stateDir);
    await cli(stateDir, ["queue", "create", "json-spec", "--repo", projectRoot, "--json"]);

    const result = await cli(
      stateDir,
      ["task", "add", "--stdin-json"],
      JSON.stringify({
        queue: "json-spec",
        title: "JSON structured task",
        objective: "Exercise the complete machine-readable task contract",
        invariants: ["Preserve JSON compatibility"],
        handoffRequirements: ["Report changed files"],
        expectedPaths: ["src/**"],
        allowedPaths: ["src/**", "test/**"],
        deniedPaths: ["src/generated/**"],
        maxChangedFiles: 12,
        verifyCommands: ["bun test"],
        approvalCheckpoints: ["after-plan"],
        baseDriftPolicy: "rebase",
        landStrategy: "merge-train",
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      objective: "Exercise the complete machine-readable task contract",
      invariants: ["Preserve JSON compatibility"],
      handoffRequirements: ["Report changed files"],
      expectedPaths: ["src/**"],
      allowedPaths: ["src/**", "test/**"],
      deniedPaths: ["src/generated/**"],
      maxChangedFiles: 12,
      verifyCommands: ["bun test"],
      approvalCheckpoints: ["after-plan"],
      baseDriftPolicy: "rebase",
      landStrategy: "merge-train",
    });
  });

  test("fails closed when a managed planning agent has no child-task intake", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentq-cli-plan-intake-"));
    roots.push(stateDir);
    await cli(stateDir, ["queue", "create", "plan", "--repo", projectRoot, "--json"]);

    const result = await cli(
      stateDir,
      ["task", "add", "--queue", "plan", "--title", "Planner child", "--json"],
      undefined,
      projectRoot,
      {
        AGENTQ_AGENT_CONTEXT: "1",
        AGENTQ_STAGE: "plan",
        AGENTQ_RUN_ID: "run-plan",
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No managed-agent task intake is available");
    const listed = await cli(stateDir, ["task", "list", "--json"]);
    expect(JSON.parse(listed.stdout)).toEqual([]);
  });

  test("sanitizes an untrusted queue reference in supervisor startup output", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentq-cli-run-output-"));
    roots.push(stateDir);
    const queueRef = "missing\u001b]0;owned\u0007queue";

    const result = await cli(stateDir, ["run", queueRef, "--once"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("agentq supervisor started for missingqueue");
    expect(result.stdout).not.toContain("\u001b");
  });

  test("accepts the documented --title form for manual tasks", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentq-cli-title-"));
    roots.push(stateDir);
    const repository = join(import.meta.dir, "..");
    await cli(stateDir, ["queue", "create", "docs", "--repo", repository, "--json"]);

    const result = await cli(stateDir, [
      "task",
      "add",
      "--queue",
      "docs",
      "--title",
      "Fix expired-session redirects",
      "--instructions",
      "Reproduce the redirect loop and add a regression test",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      queueName: "docs",
      title: "Fix expired-session redirects",
      instructions: "Reproduce the redirect loop and add a regression test",
    });
  });

  test("accepts a complete structured task specification from repeatable flags", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentq-cli-structured-task-"));
    roots.push(stateDir);
    const repositoryRoot = await repository("agentq-structured-task-repo-");
    await cli(stateDir, ["queue", "create", "delivery", "--json"], undefined, repositoryRoot);
    const blockerResult = await cli(
      stateDir,
      ["task", "add", "Prepare service boundary", "--queue", "delivery", "--json"],
      undefined,
      repositoryRoot,
    );
    const blockerId = (JSON.parse(blockerResult.stdout) as { id: string }).id;

    const result = await cli(
      stateDir,
      [
        "task",
        "add",
        "Restore bounded retries",
        "--queue",
        "delivery",
        "--objective",
        "Restore bounded retries without changing API behavior",
        "--blocked-by",
        blockerId,
        "--invariant",
        "Existing response schemas remain unchanged",
        "--invariant",
        "Retries remain bounded",
        "--allow-path",
        "src/services/**",
        "--deny-path",
        "src/api/**",
        "--expected-path",
        "src/services/retry.ts",
        "--max-changed-files",
        "20",
        "--verify",
        "bun test test/services.test.ts",
        "--checkpoint",
        "after-plan",
        "--base-drift",
        "replan",
        "--land-strategy",
        "stack",
        "--handoff",
        "Document the retry guarantees",
        "--json",
      ],
      undefined,
      repositoryRoot,
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      title: "Restore bounded retries",
      objective: "Restore bounded retries without changing API behavior",
      blockedBy: [blockerId],
      invariants: ["Existing response schemas remain unchanged", "Retries remain bounded"],
      allowedPaths: ["src/services/**"],
      deniedPaths: ["src/api/**"],
      expectedPaths: ["src/services/retry.ts"],
      maxChangedFiles: 20,
      verifyCommands: ["bun test test/services.test.ts"],
      approvalCheckpoints: ["after-plan"],
      baseDriftPolicy: "replan",
      landStrategy: "stack",
      handoffRequirements: ["Document the retry guarantees"],
    });
  });

  test("returns JSON for automation mutations and sanitizes only human output", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentq-cli-mutations-"));
    roots.push(stateDir);
    const repository = join(import.meta.dir, "..");
    await cli(stateDir, ["queue", "create", "work", "--repo", repository, "--json"]);
    await cli(stateDir, ["queue", "create", "empty", "--repo", repository, "--json"]);

    const title = "safe\u001b]0;owned\u0007title";
    const added = await cli(
      stateDir,
      ["task", "add", "--stdin-json"],
      JSON.stringify({ queue: "work", title }),
    );
    const task = JSON.parse(added.stdout) as { id: string; title: string };
    expect(task.title).toBe(title);

    const humanList = await cli(stateDir, ["task", "list"]);
    expect(humanList.stdout).not.toContain("\u001b");
    expect(humanList.stdout).toContain("safetitle");
    const jsonList = await cli(stateDir, ["task", "list", "--json"]);
    expect((JSON.parse(jsonList.stdout) as { title: string }[])[0]?.title).toBe(title);

    const cancelled = await cli(stateDir, ["task", "cancel", task.id, "--json"]);
    expect(JSON.parse(cancelled.stdout).status).toBe("cancelled");
    const retried = await cli(stateDir, ["task", "retry", task.id, "--json"]);
    expect(JSON.parse(retried.stdout).status).toBe("queued");
    const completed = await cli(stateDir, ["task", "complete", task.id, "--json"]);
    expect(JSON.parse(completed.stdout).status).toBe("succeeded");

    const removed = await cli(stateDir, ["queue", "remove", "empty", "--yes", "--json"]);
    expect(JSON.parse(removed.stdout)).toEqual({ removed: true, queue: "empty" });
  });

  test("requires confirmation before deleting terminal task history through the CLI", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentq-cli-task-delete-"));
    roots.push(stateDir);
    await cli(stateDir, ["queue", "create", "work", "--repo", projectRoot, "--json"]);
    const added = await cli(stateDir, ["task", "add", "Delete me", "--queue", "work", "--json"]);
    const taskId = (JSON.parse(added.stdout) as { id: string }).id;
    const store = new AgentQStore(join(stateDir, "agentq.sqlite"));
    try {
      const claim = store.claimNextTask({ queue: "work" });
      if (!claim) throw new Error("Expected task claim");
      store.appendEvent({
        taskId,
        runId: claim.run.id,
        kind: "assistant",
        payload: { text: "done" },
      });
      store.finishRun(claim.run.id, { status: "succeeded", exitCode: 0 });
    } finally {
      store.close();
    }

    const unconfirmed = await cli(stateDir, ["task", "remove", taskId, "--json"]);
    expect(unconfirmed.exitCode).toBe(2);
    expect(unconfirmed.stderr).toContain("Task removal requires --yes");

    const removed = await cli(stateDir, ["task", "remove", taskId, "--yes", "--json"]);
    expect(JSON.parse(removed.stdout)).toEqual({ removed: true, task: taskId });
  });

  test("cascades inactive task history when deleting a queue through the CLI", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentq-cli-queue-delete-"));
    roots.push(stateDir);
    await cli(stateDir, ["queue", "create", "work", "--repo", projectRoot, "--json"]);
    const added = await cli(stateDir, ["task", "add", "Cascade me", "--queue", "work", "--json"]);
    const taskId = (JSON.parse(added.stdout) as { id: string }).id;

    const removed = await cli(stateDir, ["queue", "remove", "work", "--yes", "--json"]);
    expect(JSON.parse(removed.stdout)).toEqual({ removed: true, queue: "work" });
    const missingTask = await cli(stateDir, ["task", "show", taskId, "--json"]);
    expect(missingTask.exitCode).toBe(1);
    expect(missingTask.stderr).toContain("Task not found");
  });

  test("renders human task logs as an activity transcript and keeps JSON Lines raw", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentq-cli-logs-"));
    roots.push(stateDir);
    await cli(stateDir, ["queue", "create", "logs", "--repo", projectRoot, "--json"]);
    const added = await cli(stateDir, [
      "task",
      "add",
      "Render task activity",
      "--queue",
      "logs",
      "--json",
    ]);
    const taskId = (JSON.parse(added.stdout) as { id: string }).id;
    const store = new AgentQStore(join(stateDir, "agentq.sqlite"));
    const claim = store.claimNextTask({ queue: "logs" });
    if (!claim) throw new Error("Expected task claim");
    const implementationSummary = "Finished the transcript renderer.";
    const terminalSummary = `${implementationSummary}\n\nBranch: agentq/logs/render-activity\nCommit: abc123\nWorktree: /tmp/agentq-logs`;

    try {
      store.appendEvent({
        taskId,
        runId: claim.run.id,
        kind: "executor.tool",
        payload: {
          type: "tool",
          toolId: "tool-1",
          name: "command",
          state: "started",
          detail: '/bin/zsh -lc "bun test test/activity.test.ts"',
        },
      });
      store.appendEvent({
        taskId,
        runId: claim.run.id,
        kind: "executor.tool",
        payload: {
          type: "tool",
          toolId: "tool-1",
          name: "command",
          state: "completed",
          output: "2 pass\n0 fail",
        },
      });
      store.appendEvent({
        taskId,
        runId: claim.run.id,
        kind: "executor.assistant",
        payload: { type: "assistant", phase: "implement", text: implementationSummary },
      });
      store.appendEvent({
        taskId,
        runId: claim.run.id,
        kind: "run.succeeded",
        payload: {
          summary: terminalSummary,
          branchName: "agentq/logs/render-activity",
          commitSha: "abc123",
          worktreePath: "/tmp/agentq-logs",
        },
      });
    } finally {
      store.close();
    }

    const humanLogs = await cli(stateDir, ["task", "logs", taskId]);
    expect(humanLogs.exitCode).toBe(0);
    expect(humanLogs.stdout).toContain("• Ran bun test test/activity.test.ts");
    expect(humanLogs.stdout).toContain("  └ 2 pass … +1 lines");
    expect(humanLogs.stdout).toContain(`• ${implementationSummary}`);
    expect(humanLogs.stdout).toContain("✓ Run succeeded");
    expect(humanLogs.stdout).toContain("  └ Branch: agentq/logs/render-activity");
    expect(humanLogs.stdout).toContain("    Commit: abc123");
    expect(humanLogs.stdout).toContain("    Worktree: /tmp/agentq-logs");
    expect(humanLogs.stdout).not.toContain("executor.tool");
    expect(humanLogs.stdout).not.toContain(terminalSummary);

    const jsonLogs = await cli(stateDir, ["task", "logs", taskId, "--json"]);
    expect(jsonLogs.exitCode).toBe(0);
    const rawEvents = jsonLogs.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string; payload: Record<string, unknown> });
    expect(rawEvents.some((entry) => entry.kind === "executor.tool")).toBe(true);
    expect(rawEvents.find((entry) => entry.kind === "run.succeeded")?.payload.summary).toBe(
      terminalSummary,
    );
  });

  test("edits every mutable queue field without changing repository identity", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentq-cli-queue-edit-"));
    roots.push(stateDir);
    const repositoryRoot = await repository("agentq-queue-edit-repo-");
    await git(repositoryRoot, ["branch", "release"]);
    const created = await cli(
      stateDir,
      ["queue", "create", "configurable", "--verify", "bun test", "--json"],
      undefined,
      repositoryRoot,
    );
    const original = JSON.parse(created.stdout) as { repoKey: string; repoPath: string };

    const edited = await cli(
      stateDir,
      [
        "queue",
        "edit",
        "configurable",
        "--name",
        "delivery",
        "--base",
        "release",
        "--provider",
        "claude",
        "--concurrency",
        "5",
        "--max-attempts",
        "7",
        "--plan-model",
        "claude-haiku",
        "--plan-instructions",
        "Map exact files and tests.",
        "--implement-model",
        "claude-sonnet",
        "--implement-instructions",
        "Preserve compatibility.",
        "--verify",
        "bun run lint",
        "--verify",
        "bun test",
        "--allow-path",
        "src/**",
        "--deny-path",
        "src/generated/**",
        "--max-changed-files",
        "11",
        "--checkpoint",
        "after-plan",
        "--base-drift",
        "fail",
        "--land-strategy",
        "merge-train",
        "--auto-land",
        "--file-concurrency",
        "advisory",
        "--no-auto-commit",
        "--json",
      ],
      undefined,
      repositoryRoot,
    );

    expect(edited.exitCode).toBe(0);
    expect(JSON.parse(edited.stdout)).toMatchObject({
      name: "delivery",
      baseRef: "release",
      defaultProvider: "claude",
      concurrency: 5,
      maxAttempts: 7,
      planModel: "claude-haiku",
      planInstructions: "Map exact files and tests.",
      implementModel: "claude-sonnet",
      implementInstructions: "Preserve compatibility.",
      verifyCommands: ["bun run lint", "bun test"],
      allowedPaths: ["src/**"],
      deniedPaths: ["src/generated/**"],
      maxChangedFiles: 11,
      approvalCheckpoints: ["after-plan"],
      baseDriftPolicy: "fail",
      landStrategy: "merge-train",
      autoLand: true,
      fileConcurrency: "advisory",
      autoCommit: false,
      repoKey: original.repoKey,
      repoPath: original.repoPath,
    });

    const reset = await cli(
      stateDir,
      [
        "queue",
        "edit",
        "delivery",
        "--clear-plan-model",
        "--clear-plan-instructions",
        "--clear-implement-model",
        "--clear-implement-instructions",
        "--clear-verify",
        "--clear-allowed-paths",
        "--clear-denied-paths",
        "--clear-checkpoints",
        "--no-auto-land",
        "--file-concurrency",
        "off",
        "--auto-commit",
        "--json",
      ],
      undefined,
      repositoryRoot,
    );
    expect(JSON.parse(reset.stdout)).toMatchObject({
      planModel: "",
      planInstructions: "",
      implementModel: "",
      implementInstructions: "",
      verifyCommands: [],
      allowedPaths: [],
      deniedPaths: [],
      maxChangedFiles: 11,
      approvalCheckpoints: [],
      autoLand: false,
      fileConcurrency: "off",
      autoCommit: true,
    });

    const conflicting = await cli(
      stateDir,
      ["queue", "edit", "delivery", "--verify", "bun test", "--clear-verify"],
      undefined,
      repositoryRoot,
    );
    expect(conflicting.exitCode).toBe(2);
    expect(conflicting.stderr).toContain("either --verify or --clear-verify");

    const workflowConflicts = [
      ["--plan-model", "gpt-planner", "--clear-plan-model"],
      ["--plan-instructions", "Inspect first.", "--clear-plan-instructions"],
      ["--implement-model", "gpt-builder", "--clear-implement-model"],
      ["--implement-instructions", "Keep it focused.", "--clear-implement-instructions"],
    ] as const;
    for (const [setOption, value, clearOption] of workflowConflicts) {
      const result = await cli(
        stateDir,
        ["queue", "edit", "delivery", setOption, value, clearOption],
        undefined,
        repositoryRoot,
      );
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain(`either ${setOption} or ${clearOption}`);
    }

    const empty = await cli(stateDir, ["queue", "edit", "delivery"], undefined, repositoryRoot);
    expect(empty.exitCode).toBe(2);
    expect(empty.stderr).toContain("at least one queue field");
  });

  test("scopes duplicate queue names and task lists to the current repository", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentq-cli-repo-scope-"));
    roots.push(stateDir);
    const firstRepo = await repository("agentq-repo-first-");
    const secondRepo = await repository("agentq-repo-second-");

    const firstQueue = await cli(
      stateDir,
      ["queue", "create", "main", "--json"],
      undefined,
      firstRepo,
    );
    const secondQueue = await cli(
      stateDir,
      ["queue", "create", "main", "--json"],
      undefined,
      secondRepo,
    );
    expect(firstQueue.exitCode).toBe(0);
    expect(secondQueue.exitCode).toBe(0);
    expect(JSON.parse(firstQueue.stdout).id).not.toBe(JSON.parse(secondQueue.stdout).id);

    const duplicate = await cli(
      stateDir,
      ["queue", "create", "MAIN", "--json"],
      undefined,
      firstRepo,
    );
    expect(duplicate.exitCode).toBe(1);
    expect(duplicate.stderr).toContain("already exists");

    await cli(
      stateDir,
      ["task", "add", "First repo task", "--queue", "main"],
      undefined,
      firstRepo,
    );
    await cli(
      stateDir,
      ["task", "add", "Second repo task", "--queue", "main"],
      undefined,
      secondRepo,
    );

    const firstQueues = await cli(stateDir, ["queue", "list", "--json"], undefined, firstRepo);
    const secondQueues = await cli(stateDir, ["queue", "list", "--json"], undefined, secondRepo);
    const allQueues = await cli(
      stateDir,
      ["queue", "list", "--all", "--json"],
      undefined,
      firstRepo,
    );
    expect(JSON.parse(firstQueues.stdout)).toHaveLength(1);
    expect(JSON.parse(firstQueues.stdout)[0].repoPath).toBe(await realpath(firstRepo));
    expect(JSON.parse(secondQueues.stdout)).toHaveLength(1);
    expect(JSON.parse(secondQueues.stdout)[0].repoPath).toBe(await realpath(secondRepo));
    expect(JSON.parse(allQueues.stdout)).toHaveLength(2);

    const firstTasks = await cli(stateDir, ["task", "list", "--json"], undefined, firstRepo);
    const secondTasks = await cli(stateDir, ["task", "list", "--json"], undefined, secondRepo);
    const allTasks = await cli(stateDir, ["task", "list", "--all", "--json"], undefined, firstRepo);
    expect(JSON.parse(firstTasks.stdout).map((item: { title: string }) => item.title)).toEqual([
      "First repo task",
    ]);
    expect(JSON.parse(secondTasks.stdout).map((item: { title: string }) => item.title)).toEqual([
      "Second repo task",
    ]);
    expect(
      JSON.parse(allTasks.stdout)
        .map((item: { title: string }) => item.title)
        .sort(),
    ).toEqual(["First repo task", "Second repo task"]);
  }, 15_000);

  test("edits task fields from the CLI and records the new task revision", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentq-cli-edit-"));
    roots.push(stateDir);
    const repositoryRoot = await repository("agentq-edit-repo-");
    await cli(stateDir, ["queue", "create", "edit", "--json"], undefined, repositoryRoot);
    const added = await cli(
      stateDir,
      ["task", "add", "Original", "--queue", "edit", "--json"],
      undefined,
      repositoryRoot,
    );
    const taskId = JSON.parse(added.stdout).id as string;

    const edited = await cli(
      stateDir,
      [
        "task",
        "edit",
        taskId,
        "--title",
        "Revised",
        "--instructions",
        "Use the revised implementation plan",
        "--priority",
        "7",
        "--provider",
        "claude",
        "--accept",
        "Tests pass",
        "--accept",
        "Docs updated",
        "--json",
      ],
      undefined,
      repositoryRoot,
    );

    expect(edited.exitCode).toBe(0);
    expect(JSON.parse(edited.stdout)).toMatchObject({
      title: "Revised",
      instructions: "Use the revised implementation plan",
      provider: "claude",
      priority: 7,
      acceptanceCriteria: ["Tests pass", "Docs updated"],
    });
    const cleared = await cli(
      stateDir,
      ["task", "edit", taskId, "--clear-acceptance", "--json"],
      undefined,
      repositoryRoot,
    );
    expect(JSON.parse(cleared.stdout).acceptanceCriteria).toEqual([]);
    const shown = await cli(
      stateDir,
      ["task", "show", taskId, "--json"],
      undefined,
      repositoryRoot,
    );
    expect(
      JSON.parse(shown.stdout).events.filter(
        (event: { kind: string }) => event.kind === "task.edited",
      ),
    ).toHaveLength(2);
  });

  test("replaces and clears structured task specification fields", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentq-cli-structured-edit-"));
    roots.push(stateDir);
    const repositoryRoot = await repository("agentq-structured-edit-repo-");
    await cli(stateDir, ["queue", "create", "edit", "--json"], undefined, repositoryRoot);
    const blockerResult = await cli(
      stateDir,
      ["task", "add", "Blocker", "--queue", "edit", "--json"],
      undefined,
      repositoryRoot,
    );
    const blockerId = (JSON.parse(blockerResult.stdout) as { id: string }).id;
    const taskResult = await cli(
      stateDir,
      ["task", "add", "Structured edit", "--queue", "edit", "--json"],
      undefined,
      repositoryRoot,
    );
    const taskId = (JSON.parse(taskResult.stdout) as { id: string }).id;

    const edited = await cli(
      stateDir,
      [
        "task",
        "edit",
        taskId,
        "--objective",
        "Implement the reviewed structured specification",
        "--blocked-by",
        blockerId,
        "--invariant",
        "Preserve compatibility",
        "--allow-path",
        "src/**",
        "--deny-path",
        "src/generated/**",
        "--expected-path",
        "src/worker.ts",
        "--max-changed-files",
        "9",
        "--verify",
        "bun test",
        "--checkpoint",
        "after-plan",
        "--base-drift",
        "fail",
        "--land-strategy",
        "merge-train",
        "--handoff",
        "Report verification evidence",
        "--json",
      ],
      undefined,
      repositoryRoot,
    );
    expect(edited.exitCode).toBe(0);
    expect(JSON.parse(edited.stdout)).toMatchObject({
      objective: "Implement the reviewed structured specification",
      blockedBy: [blockerId],
      invariants: ["Preserve compatibility"],
      allowedPaths: ["src/**"],
      deniedPaths: ["src/generated/**"],
      expectedPaths: ["src/worker.ts"],
      maxChangedFiles: 9,
      verifyCommands: ["bun test"],
      approvalCheckpoints: ["after-plan"],
      baseDriftPolicy: "fail",
      landStrategy: "merge-train",
      handoffRequirements: ["Report verification evidence"],
    });

    const cleared = await cli(
      stateDir,
      [
        "task",
        "edit",
        taskId,
        "--clear-blockers",
        "--clear-invariants",
        "--clear-allowed-paths",
        "--clear-denied-paths",
        "--clear-expected-paths",
        "--clear-verify",
        "--clear-checkpoints",
        "--clear-handoff",
        "--json",
      ],
      undefined,
      repositoryRoot,
    );
    expect(cleared.exitCode).toBe(0);
    expect(JSON.parse(cleared.stdout)).toMatchObject({
      blockedBy: [],
      invariants: [],
      allowedPaths: [],
      deniedPaths: [],
      expectedPaths: [],
      verifyCommands: [],
      approvalCheckpoints: [],
      handoffRequirements: [],
    });
    expect(JSON.parse(cleared.stdout).maxChangedFiles).toBe(9);
  });

  test("renders a stable repository task dependency graph with an optional queue filter", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentq-cli-task-graph-"));
    roots.push(stateDir);
    const repositoryRoot = await repository("agentq-task-graph-repo-");
    await cli(stateDir, ["queue", "create", "graph", "--json"], undefined, repositoryRoot);
    await cli(stateDir, ["queue", "create", "other", "--json"], undefined, repositoryRoot);
    const blocker = JSON.parse(
      (
        await cli(
          stateDir,
          ["task", "add", "Foundation", "--queue", "graph", "--json"],
          undefined,
          repositoryRoot,
        )
      ).stdout,
    ) as { id: string };
    const dependent = JSON.parse(
      (
        await cli(
          stateDir,
          ["task", "add", "Dependent", "--queue", "graph", "--blocked-by", blocker.id, "--json"],
          undefined,
          repositoryRoot,
        )
      ).stdout,
    ) as { id: string };
    await cli(
      stateDir,
      ["task", "add", "Unrelated", "--queue", "other", "--json"],
      undefined,
      repositoryRoot,
    );

    const result = await cli(
      stateDir,
      ["task", "graph", "--queue", "graph", "--json"],
      undefined,
      repositoryRoot,
    );

    expect(result.exitCode).toBe(0);
    const graph = JSON.parse(result.stdout) as {
      nodes: { id: string; title: string }[];
      edges: { from: string; to: string }[];
    };
    expect(graph.nodes.map(({ id }) => id)).toEqual([blocker.id, dependent.id].sort());
    expect(graph.edges).toEqual([{ from: blocker.id, to: dependent.id }]);
  });
});
