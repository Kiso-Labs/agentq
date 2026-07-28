import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentQApp } from "../src/app.ts";
import type { AgentQError } from "../src/core/errors.ts";
import type { AgentQPaths, Queue, Task } from "../src/core/types.ts";
import { runCommand } from "../src/git/command.ts";
import { resolveRepositoryContext } from "../src/git/repository.ts";
import { afterEach, describe, expect, test } from "./support/test.ts";

interface Fixture {
  root: string;
  firstRepo: string;
  secondRepo: string;
  app: AgentQApp;
}

const roots: string[] = [];
const apps: AgentQApp[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) app.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await runCommand("git", ["-C", cwd, ...args]);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
}

async function repository(path: string, marker: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await git(path, ["init", "--initial-branch=main"]);
  await writeFile(join(path, "README.md"), `# ${marker}\n`, "utf8");
  await git(path, ["add", "README.md"]);
  await git(path, [
    "-c",
    "user.name=AgentQ Tests",
    "-c",
    "user.email=agentq@example.invalid",
    "commit",
    "-m",
    "Initial fixture",
  ]);
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "agentq-app-"));
  roots.push(root);
  const firstRepo = join(root, "first");
  const secondRepo = join(root, "second");
  await Promise.all([
    repository(firstRepo, "first repository"),
    repository(secondRepo, "second repository"),
  ]);

  const stateDir = join(root, "state");
  const paths: AgentQPaths = {
    stateDir,
    databasePath: join(stateDir, "agentq.sqlite"),
    logsDir: join(stateDir, "logs"),
    worktreesDir: join(stateDir, "worktrees"),
    locksDir: join(stateDir, "locks"),
  };
  const app = await AgentQApp.create(paths);
  apps.push(app);
  return { root, firstRepo, secondRepo, app };
}

async function queuesInBothRepositories(value: Fixture, name = "main") {
  const first = await value.app.createQueue({ name, repoPath: value.firstRepo });
  const second = await value.app.createQueue({ name, repoPath: value.secondRepo });
  return { first, second };
}

async function failedRun(
  app: AgentQApp,
  queue: Queue,
  task: Task,
  details: { worktreePath: string; providerSessionId?: string },
) {
  const claim = app.store.claimNextTask({ queue: queue.id });
  if (!claim) throw new Error("Expected the task to be claimable");
  app.store.updateRun(claim.run.id, {
    baseSha: "0123456789abcdef",
    branchName: `agentq/${task.id}`,
    worktreePath: details.worktreePath,
    planSessionId: details.providerSessionId,
  });
  app.store.finishRun(claim.run.id, { status: "failed", exitCode: 1 });
  return claim.run.id;
}

describe("AgentQApp", () => {
  test("switches between canonical repository scope and an explicit all-repository view", async () => {
    const value = await fixture();
    const { first, second } = await queuesInBothRepositories(value);
    const firstTask = value.app.store.addTask({ queue: first.id, title: "First task" });
    const secondTask = value.app.store.addTask({ queue: second.id, title: "Second task" });
    const firstContext = await resolveRepositoryContext(value.firstRepo);

    await value.app.setRepositoryScope(firstContext);

    expect(value.app.allRepositories).toBeFalse();
    expect(value.app.activeRepositoryKey).toBe(firstContext.repoKey);
    expect(value.app.uiContext()).toEqual({
      label: `${firstContext.displayName} · ${firstContext.rootPath}`,
      repositoryPath: firstContext.rootPath,
      all: false,
      canToggle: true,
    });
    expect((await value.app.listQueues()).map((queue) => queue.id)).toEqual([first.id]);
    expect((await value.app.listTasks()).map((task) => task.id)).toEqual([firstTask.id]);
    await expect(value.app.getQueue(second.id)).rejects.toMatchObject({
      code: "QUEUE_NOT_FOUND",
    } satisfies Partial<AgentQError>);

    value.app.setAllRepositories(true);
    expect(value.app.allRepositories).toBeTrue();
    expect(value.app.activeRepositoryKey).toBeUndefined();
    expect(value.app.uiContext()).toMatchObject({
      label: "all repositories",
      repositoryPath: firstContext.rootPath,
      all: true,
      canToggle: true,
    });
    expect(new Set((await value.app.listQueues()).map((queue) => queue.id))).toEqual(
      new Set([first.id, second.id]),
    );
    expect(new Set((await value.app.listTasks()).map((task) => task.id))).toEqual(
      new Set([firstTask.id, secondTask.id]),
    );

    value.app.setAllRepositories(false);
    expect((await value.app.listQueues()).map((queue) => queue.id)).toEqual([first.id]);
  });

  test("allows duplicate queue names across repositories while keeping scoped resolution safe", async () => {
    const value = await fixture();
    const { first, second } = await queuesInBothRepositories(value, "work");
    await value.app.setRepositoryScope(await resolveRepositoryContext(value.firstRepo));

    expect((await value.app.getQueue("WORK")).id).toBe(first.id);
    await expect(value.app.getQueue(second.id)).rejects.toMatchObject({
      code: "QUEUE_NOT_FOUND",
    } satisfies Partial<AgentQError>);
    await expect(
      value.app.createQueue({ name: "WoRk", repoPath: value.firstRepo }),
    ).rejects.toMatchObject({ code: "QUEUE_EXISTS" } satisfies Partial<AgentQError>);

    value.app.setAllRepositories(true);
    await expect(value.app.getQueue("work")).rejects.toMatchObject({
      code: "QUEUE_AMBIGUOUS",
    } satisfies Partial<AgentQError>);
    expect((await value.app.getQueue(second.id)).id).toBe(second.id);
  });

  test("validates queue base refs before persisting edits and deletes only scoped queues", async () => {
    const value = await fixture();
    const { first, second } = await queuesInBothRepositories(value);
    await git(value.firstRepo, ["branch", "release"]);
    await value.app.setRepositoryScope(await resolveRepositoryContext(value.firstRepo));

    const notifications: string[] = [];
    const unsubscribe = value.app.subscribe(() => notifications.push("changed"));
    const updated = await value.app.updateQueue(first.id, {
      name: "primary",
      baseRef: "release",
      defaultProvider: "claude",
      concurrency: 4,
      maxAttempts: 5,
      verifyCommands: ["bun test"],
      autoCommit: false,
    });
    expect(updated).toMatchObject({
      id: first.id,
      name: "primary",
      repoPath: first.repoPath,
      repoKey: first.repoKey,
      baseRef: "release",
      defaultProvider: "claude",
      concurrency: 4,
      maxAttempts: 5,
      verifyCommands: ["bun test"],
      autoCommit: false,
    });
    expect(notifications).toHaveLength(1);

    await expect(value.app.updateQueue(first.id, { baseRef: "missing-ref" })).rejects.toMatchObject(
      {
        code: "GIT_COMMAND_FAILED",
      } satisfies Partial<AgentQError>,
    );
    expect((await value.app.getQueue(first.id)).baseRef).toBe("release");
    expect(notifications).toHaveLength(1);
    await expect(value.app.updateQueue(second.id, { name: "hidden" })).rejects.toMatchObject({
      code: "QUEUE_NOT_FOUND",
    } satisfies Partial<AgentQError>);

    await value.app.deleteQueue(first.id);
    expect(notifications).toHaveLength(2);
    await expect(value.app.getQueue(first.id)).rejects.toMatchObject({
      code: "QUEUE_NOT_FOUND",
    } satisfies Partial<AgentQError>);
    expect(value.app.store.getQueue(second.id)?.name).toBe("main");
    unsubscribe();
  });

  test("deletes an inactive task while refusing to delete active work", async () => {
    const value = await fixture();
    const queue = await value.app.createQueue({ name: "delete-tasks", repoPath: value.firstRepo });
    const removable = await value.app.addTask({ queue: queue.id, title: "Remove me" });
    const claim = value.app.store.claimNextTask({ queue: queue.id });
    if (!claim || claim.task.id !== removable.id) throw new Error("Expected the first task claim");
    value.app.store.finishRun(claim.run.id, { status: "cancelled" });
    const active = await value.app.addTask({ queue: queue.id, title: "Keep active work" });
    const activeClaim = value.app.store.claimNextTask({ queue: queue.id });
    if (!activeClaim || activeClaim.task.id !== active.id) throw new Error("Expected active claim");

    const notifications: string[] = [];
    const unsubscribe = value.app.subscribe(() => notifications.push("changed"));
    const taskLogDirectory = join(value.app.paths.logsDir, removable.id);
    await mkdir(taskLogDirectory, { recursive: true });
    await writeFile(join(taskLogDirectory, "run.jsonl"), "log\n");

    await value.app.deleteTask(removable.id);
    await expect(value.app.getTask(removable.id)).rejects.toMatchObject({
      code: "TASK_NOT_FOUND",
    } satisfies Partial<AgentQError>);
    await expect(access(taskLogDirectory)).rejects.toBeDefined();
    expect(notifications).toHaveLength(1);

    await expect(value.app.deleteTask(active.id)).rejects.toMatchObject({
      code: "TASK_ACTIVE",
    } satisfies Partial<AgentQError>);
    expect((await value.app.getTask(active.id)).status).toBe("starting");
    expect(notifications).toHaveLength(1);
    unsubscribe();
  });

  test("deletes a queue with inactive task history while refusing active work", async () => {
    const value = await fixture();
    const removableQueue = await value.app.createQueue({
      name: "delete-queue",
      repoPath: value.firstRepo,
    });
    const removableTask = await value.app.addTask({
      queue: removableQueue.id,
      title: "Delete my history",
    });
    const completedClaim = value.app.store.claimNextTask({ queue: removableQueue.id });
    if (!completedClaim) throw new Error("Expected completed claim");
    value.app.store.appendEvent({
      taskId: removableTask.id,
      runId: completedClaim.run.id,
      kind: "assistant",
      payload: { text: "finished" },
    });
    value.app.store.finishRun(completedClaim.run.id, { status: "succeeded", exitCode: 0 });
    const taskLogDirectory = join(value.app.paths.logsDir, removableTask.id);
    await mkdir(taskLogDirectory, { recursive: true });
    await writeFile(join(taskLogDirectory, `${completedClaim.run.id}.jsonl`), "log\n");

    await value.app.deleteQueue(removableQueue.id);
    await expect(value.app.getQueue(removableQueue.id)).rejects.toMatchObject({
      code: "QUEUE_NOT_FOUND",
    } satisfies Partial<AgentQError>);
    await expect(value.app.getTask(removableTask.id)).rejects.toMatchObject({
      code: "TASK_NOT_FOUND",
    } satisfies Partial<AgentQError>);
    expect(value.app.store.getRun(completedClaim.run.id)).toBeUndefined();
    expect(value.app.store.listEvents({ taskId: removableTask.id })).toEqual([]);
    await expect(access(taskLogDirectory)).rejects.toBeDefined();

    const activeQueue = await value.app.createQueue({
      name: "active-queue",
      repoPath: value.firstRepo,
    });
    const activeTask = await value.app.addTask({ queue: activeQueue.id, title: "Still running" });
    const activeClaim = value.app.store.claimNextTask({ queue: activeQueue.id });
    if (!activeClaim) throw new Error("Expected active claim");

    await expect(value.app.deleteQueue(activeQueue.id)).rejects.toMatchObject({
      code: "QUEUE_HAS_ACTIVE_TASKS",
    } satisfies Partial<AgentQError>);
    expect((await value.app.getQueue(activeQueue.id)).id).toBe(activeQueue.id);
    expect((await value.app.getTask(activeTask.id)).status).toBe("starting");
  });

  test("requires retained worktrees to be cleaned before task or queue deletion", async () => {
    const value = await fixture();
    const queue = await value.app.createQueue({ name: "retained", repoPath: value.firstRepo });
    const task = await value.app.addTask({ queue: queue.id, title: "Keep my worktree" });
    const retained = join(value.root, "retained-delete-guard");
    await mkdir(retained);
    await failedRun(value.app, queue, task, { worktreePath: retained });

    await expect(value.app.deleteTask(task.id)).rejects.toMatchObject({
      code: "TASK_HAS_WORKTREE",
    } satisfies Partial<AgentQError>);
    await expect(value.app.deleteQueue(queue.id)).rejects.toMatchObject({
      code: "QUEUE_HAS_WORKTREES",
    } satisfies Partial<AgentQError>);
    expect((await value.app.getTask(task.id)).id).toBe(task.id);
    expect((await value.app.getQueue(queue.id)).id).toBe(queue.id);
    await access(retained);
  });

  test("reports partial deletion when local log cleanup fails", async () => {
    const value = await fixture();
    const queue = await value.app.createQueue({ name: "log-cleanup", repoPath: value.firstRepo });
    const task = await value.app.addTask({ queue: queue.id, title: "Keep cleanup observable" });
    const notifications: string[] = [];
    const unsubscribe = value.app.subscribe(() => notifications.push("changed"));
    await rm(value.app.paths.logsDir, { recursive: true, force: true });
    await writeFile(value.app.paths.logsDir, "not a directory");

    await expect(value.app.deleteTask(task.id)).rejects.toMatchObject({
      code: "LOG_CLEANUP_FAILED",
      message: expect.stringContaining("was deleted"),
    } satisfies Partial<AgentQError>);
    await expect(value.app.getTask(task.id)).rejects.toMatchObject({
      code: "TASK_NOT_FOUND",
    } satisfies Partial<AgentQError>);
    expect(notifications).toHaveLength(1);
    unsubscribe();
  });

  test("lists run history and resumes only a session from the task's current provider", async () => {
    const value = await fixture();
    const queue = await value.app.createQueue({
      name: "runs",
      repoPath: value.firstRepo,
      maxAttempts: 1,
    });
    const task = await value.app.addTask({ queue: queue.id, title: "Resume safely" });
    const retained = join(value.root, "retained-session");
    await mkdir(retained);
    const runId = await failedRun(value.app, queue, task, {
      worktreePath: retained,
      providerSessionId: "codex-session",
    });

    expect((await value.app.listRuns(task.id)).map((run) => run.id)).toEqual([runId]);
    await expect(value.app.listRuns("missing-task")).rejects.toMatchObject({
      code: "TASK_NOT_FOUND",
    } satisfies Partial<AgentQError>);

    await value.app.resumeTask(task.id);
    expect(await value.app.getTask(task.id)).toMatchObject({
      status: "queued",
      resumeRunId: runId,
    });
    await value.app.completeManualTask(task.id);

    const mismatched = await value.app.addTask({
      queue: queue.id,
      title: "Do not cross providers",
      provider: "codex",
    });
    const otherPath = join(value.root, "other-retained-session");
    await mkdir(otherPath);
    await failedRun(value.app, queue, mismatched, {
      worktreePath: otherPath,
      providerSessionId: "old-codex-session",
    });
    const current = await value.app.getTask(mismatched.id);
    await value.app.editTask(mismatched.id, { provider: "claude" }, current.updatedAt);
    await expect(value.app.resumeTask(mismatched.id)).rejects.toMatchObject({
      code: "RUN_NOT_RESUMABLE",
    } satisfies Partial<AgentQError>);
    expect((await value.app.getTask(mismatched.id)).status).toBe("failed");
  });

  test("resumes the latest saved implementation plan without requiring a provider session", async () => {
    const value = await fixture();
    const queue = await value.app.createQueue({
      name: "saved-plan",
      repoPath: value.firstRepo,
      maxAttempts: 1,
    });
    const task = await value.app.addTask({ queue: queue.id, title: "Continue saved plan" });
    const retained = join(value.root, "saved-plan-worktree");
    await mkdir(retained);
    const claim = value.app.store.claimNextTask({ queue: queue.id, ownerToken: "planner-owner" });
    if (!claim) throw new Error("Expected claim");
    value.app.store.markRunRunning(
      claim.run.id,
      {
        baseSha: "0123456789abcdef",
        branchName: `agentq/${task.id}`,
        worktreePath: retained,
        planSessionId: "completed-planner",
      },
      claim.leaseToken,
    );
    value.app.store.advanceRunToImplementation(
      claim.run.id,
      { planOutput: "Edit src/saved.ts and run the focused test." },
      claim.leaseToken,
    );
    value.app.store.finishRun(
      claim.run.id,
      { status: "failed", error: "Implementation process did not start" },
      claim.leaseToken,
    );

    await value.app.resumeTask(task.id);
    expect(await value.app.getTask(task.id)).toMatchObject({
      status: "queued",
      resumeRunId: claim.run.id,
    });
  });

  test("never falls back to an older resumable attempt", async () => {
    const value = await fixture();
    const queue = await value.app.createQueue({
      name: "latest-only",
      repoPath: value.firstRepo,
      maxAttempts: 1,
    });
    const task = await value.app.addTask({ queue: queue.id, title: "Use latest attempt only" });
    const olderPath = join(value.root, "older-resumable");
    await mkdir(olderPath);
    await failedRun(value.app, queue, task, {
      worktreePath: olderPath,
      providerSessionId: "older-plan-session",
    });

    value.app.store.requeueTask(task.id);
    const newest = value.app.store.claimNextTask({ queue: queue.id });
    if (!newest) throw new Error("Expected newest claim");
    const newestPath = join(value.root, "newest-unresumable");
    await mkdir(newestPath);
    value.app.store.updateRun(newest.run.id, {
      baseSha: "fedcba9876543210",
      branchName: `agentq/${task.id}-newest`,
      worktreePath: newestPath,
    });
    value.app.store.finishRun(newest.run.id, { status: "failed", error: "No planner session" });

    await expect(value.app.resumeTask(task.id)).rejects.toMatchObject({
      code: "RUN_NOT_RESUMABLE",
    } satisfies Partial<AgentQError>);
    expect((await value.app.getTask(task.id)).status).toBe("failed");
  });

  test("cancels, retries, and manually completes a task through the service", async () => {
    const value = await fixture();
    const queue = await value.app.createQueue({ name: "lifecycle", repoPath: value.firstRepo });
    const task = await value.app.addTask({ queue: queue.id, title: "Lifecycle" });

    await value.app.cancelTask(task.id);
    expect((await value.app.getTask(task.id)).status).toBe("cancelled");
    await value.app.retryTask(task.id);
    expect((await value.app.getTask(task.id)).status).toBe("queued");
    await value.app.completeManualTask(task.id, "Verified manually");
    expect((await value.app.getTask(task.id)).status).toBe("succeeded");
    expect((await value.app.listEvents(task.id)).at(-1)).toMatchObject({
      kind: "manual.completed",
      payload: { summary: "Verified manually" },
    });
  });

  test("does not let a stale retry overwrite concurrent manual completion", async () => {
    const value = await fixture();
    const queue = await value.app.createQueue({ name: "retry-race", repoPath: value.firstRepo });
    const task = await value.app.addTask({ queue: queue.id, title: "Completion wins" });
    await value.app.cancelTask(task.id);

    // retryTask yields after reading the retryable state. Manual completion then
    // commits synchronously before the stale retry continuation can requeue it.
    const retrying = value.app.retryTask(task.id);
    await value.app.completeManualTask(task.id, "Completed by another operator");

    await expect(retrying).rejects.toMatchObject({
      code: "TASK_NOT_RETRYABLE",
    } satisfies Partial<AgentQError>);
    expect((await value.app.getTask(task.id)).status).toBe("succeeded");
  });

  test("installs both agent integrations into the canonical repository root", async () => {
    const value = await fixture();
    const context = await resolveRepositoryContext(value.firstRepo);
    await value.app.setRepositoryScope(context);

    const results = await value.app.installIntegration("all");
    expect(results.map((result) => result.action)).toEqual(["created", "created"]);
    expect(results.map((result) => result.file)).toEqual([
      join(context.rootPath, "AGENTS.md"),
      join(context.rootPath, "CLAUDE.md"),
    ]);
    expect(await readFile(join(value.firstRepo, "AGENTS.md"), "utf8")).toContain(
      "<!-- agentq:start -->",
    );

    const repeated = await value.app.installIntegration("all", value.firstRepo);
    expect(repeated.map((result) => result.action)).toEqual(["unchanged", "unchanged"]);
  });

  test("rejects cleaning active tasks and tasks without a retained worktree", async () => {
    const value = await fixture();
    const queue = await value.app.createQueue({ name: "clean", repoPath: value.firstRepo });
    const queued = await value.app.addTask({ queue: queue.id, title: "No worktree" });

    await value.app.cancelTask(queued.id);
    await expect(value.app.cleanTask(queued.id)).rejects.toMatchObject({
      code: "WORKTREE_NOT_FOUND",
    } satisfies Partial<AgentQError>);
    await value.app.retryTask(queued.id);
    const claim = value.app.store.claimNextTask({ queue: queue.id });
    if (!claim) throw new Error("Expected the task to be claimable");
    await expect(value.app.cleanTask(queued.id)).rejects.toMatchObject({
      code: "TASK_ACTIVE",
    } satisfies Partial<AgentQError>);
  });

  test("removes a retained worktree and clears its retained-path metadata", async () => {
    const value = await fixture();
    const queue = await value.app.createQueue({
      name: "retained",
      repoPath: value.firstRepo,
      maxAttempts: 1,
    });
    const task = await value.app.addTask({ queue: queue.id, title: "Clean retained work" });
    const claim = value.app.store.claimNextTask({ queue: queue.id });
    if (!claim) throw new Error("Expected the task to be claimable");
    const prepared = await value.app.worktrees.prepare(queue, claim.task, claim.run.attemptNo);
    value.app.store.updateRun(claim.run.id, prepared);
    value.app.store.finishRun(claim.run.id, { status: "failed", exitCode: 1 });

    const cleaned = await value.app.cleanTask(task.id);
    expect(cleaned).toEqual({ taskId: task.id, removedWorktree: prepared.worktreePath });
    await expect(access(prepared.worktreePath)).rejects.toBeDefined();
    expect((await value.app.listRuns(task.id))[0]?.worktreePath).toBeUndefined();
    await expect(value.app.cleanTask(task.id)).rejects.toMatchObject({
      code: "WORKTREE_NOT_FOUND",
    } satisfies Partial<AgentQError>);
    expect((await value.app.listEvents(task.id)).at(-1)).toMatchObject({
      kind: "task.worktree_removed",
      payload: { worktreePath: prepared.worktreePath, force: false },
    });
  });

  test("reconciles a retained path when Git already removed the worktree", async () => {
    const value = await fixture();
    const queue = await value.app.createQueue({
      name: "reconcile-retained",
      repoPath: value.firstRepo,
      maxAttempts: 1,
    });
    const task = await value.app.addTask({ queue: queue.id, title: "Reconcile retained work" });
    const claim = value.app.store.claimNextTask({ queue: queue.id });
    if (!claim) throw new Error("Expected the task to be claimable");
    const prepared = await value.app.worktrees.prepare(queue, claim.task, claim.run.attemptNo);
    value.app.store.updateRun(claim.run.id, prepared);
    value.app.store.finishRun(claim.run.id, { status: "failed", exitCode: 1 });

    // Simulate a crash after Git removes the worktree but before AgentQ clears
    // the retained SQLite path.
    await value.app.worktrees.remove(queue.repoPath, prepared.worktreePath);
    expect((await value.app.listRuns(task.id))[0]?.worktreePath).toBe(prepared.worktreePath);

    const reconciled = await value.app.cleanTask(task.id);
    expect(reconciled).toEqual({
      taskId: task.id,
      removedWorktree: prepared.worktreePath,
    });
    expect((await value.app.listRuns(task.id))[0]?.worktreePath).toBeUndefined();
    expect((await value.app.listEvents(task.id)).at(-1)).toMatchObject({
      kind: "task.worktree_removed",
      payload: { worktreePath: prepared.worktreePath, force: false },
    });
  });

  test("refuses to reconcile a missing path outside the managed worktree root", async () => {
    const value = await fixture();
    const queue = await value.app.createQueue({
      name: "outside-retained",
      repoPath: value.firstRepo,
      maxAttempts: 1,
    });
    const task = await value.app.addTask({ queue: queue.id, title: "Keep cleanup contained" });
    const outsidePath = join(value.root, "outside-missing-worktree");
    await failedRun(value.app, queue, task, { worktreePath: outsidePath });

    await expect(value.app.cleanTask(task.id)).rejects.toMatchObject({
      code: "INVALID_WORKTREE",
    } satisfies Partial<AgentQError>);
    expect((await value.app.listRuns(task.id))[0]?.worktreePath).toBe(outsidePath);
  });

  test("serializes cleanup against a concurrent session resume", async () => {
    const value = await fixture();
    const queue = await value.app.createQueue({
      name: "clean-resume-race",
      repoPath: value.firstRepo,
      maxAttempts: 1,
    });
    const task = await value.app.addTask({ queue: queue.id, title: "Keep resumed worktree" });
    const claim = value.app.store.claimNextTask({ queue: queue.id });
    if (!claim) throw new Error("Expected the task to be claimable");
    const prepared = await value.app.worktrees.prepare(queue, claim.task, claim.run.attemptNo);
    value.app.store.updateRun(claim.run.id, {
      ...prepared,
      planSessionId: "retained-session",
    });
    value.app.store.finishRun(claim.run.id, { status: "failed", exitCode: 1 });

    const outcomes = await Promise.allSettled([
      value.app.cleanTask(task.id),
      value.app.resumeTask(task.id),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
  });

  test("does not expose a foreign queue's tasks through a scoped queue id", async () => {
    const value = await fixture();
    const { second } = await queuesInBothRepositories(value);
    value.app.store.addTask({ queue: second.id, title: "Foreign task" });
    await value.app.setRepositoryScope(await resolveRepositoryContext(value.firstRepo));

    await expect(value.app.listTasks(second.id)).rejects.toMatchObject({
      code: "QUEUE_NOT_FOUND",
    } satisfies Partial<AgentQError>);
  });
});
