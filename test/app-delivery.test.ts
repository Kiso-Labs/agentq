import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentQApp } from "../src/app.ts";
import type { AgentQPaths, Queue, Task } from "../src/core/types.ts";
import { runCommand } from "../src/git/command.ts";

interface DeliveryFixture {
  root: string;
  repo: string;
  app: AgentQApp;
}

interface SuccessfulResult {
  task: Task;
  runId: string;
  baseSha: string;
  resultSha: string;
  resultRef: string;
}

const roots: string[] = [];
const apps: AgentQApp[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) app.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function command(cwd: string, executable: string, args: string[]): Promise<string> {
  const result = await runCommand(executable, args, { cwd });
  if (result.exitCode !== 0) {
    throw new Error(
      `${executable} ${args.join(" ")} failed (${result.exitCode}): ${
        result.stderr.trim() || result.stdout.trim()
      }`,
    );
  }
  return result.stdout.trim();
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return command(cwd, "git", args);
}

async function gitExitCode(cwd: string, ...args: string[]): Promise<number> {
  return (await runCommand("git", args, { cwd })).exitCode;
}

async function commitAll(cwd: string, message: string): Promise<string> {
  await git(cwd, "add", "--all");
  await git(
    cwd,
    "-c",
    "user.name=AgentQ Delivery Tests",
    "-c",
    "user.email=agentq-delivery@example.invalid",
    "commit",
    "-m",
    message,
  );
  return git(cwd, "rev-parse", "HEAD");
}

async function fixture(): Promise<DeliveryFixture> {
  const root = await mkdtemp(join(tmpdir(), "agentq-app-delivery-"));
  roots.push(root);
  const repo = join(root, "repository");
  await mkdir(repo, { recursive: true });
  await git(repo, "init", "--initial-branch=main");
  await writeFile(join(repo, "README.md"), "# Delivery fixture\n", "utf8");
  await commitAll(repo, "Initial fixture");

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
  return { root, repo, app };
}

async function deliveryQueue(
  value: DeliveryFixture,
  input: {
    name?: string;
    approvalCheckpoints?: string[];
    verifyCommands?: string[];
    autoLand?: boolean;
  } = {},
): Promise<Queue> {
  return value.app.createQueue({
    name: input.name ?? "delivery",
    repoPath: value.repo,
    baseRef: "main",
    landStrategy: "merge-train",
    autoLand: input.autoLand,
    approvalCheckpoints: input.approvalCheckpoints,
    verifyCommands: input.verifyCommands,
  });
}

async function createSuccessfulResult(
  value: DeliveryFixture,
  queue: Queue,
  input: {
    title?: string;
    path?: string;
    content?: string;
    approvalCheckpoints?: string[];
    verificationStatus?: "passed" | "failed";
  } = {},
): Promise<SuccessfulResult> {
  const path = input.path ?? "feature.txt";
  const content = input.content ?? "verified feature\n";
  const baseSha = await git(value.repo, "rev-parse", queue.baseRef);
  const task = await value.app.addTask({
    queue: queue.id,
    title: input.title ?? `Implement ${path}`,
    expectedPaths: [path],
    approvalCheckpoints: input.approvalCheckpoints,
  });
  const claim = value.app.store.claimNextTask({ queue: queue.id });
  if (!claim || claim.task.id !== task.id) throw new Error("Expected the task to be claimable");

  const resultWorktree = join(value.root, `result-${claim.run.id}`);
  await git(value.repo, "worktree", "add", "--detach", resultWorktree, baseSha);
  await writeFile(join(resultWorktree, path), content, "utf8");
  const resultSha = await commitAll(resultWorktree, `Implement ${path}`);
  const resultRef = `refs/agentq/results/${task.id}/${claim.run.id}`;
  await git(value.repo, "update-ref", resultRef, resultSha);
  await git(value.repo, "worktree", "remove", "--force", resultWorktree);

  value.app.store.markRunRunning(claim.run.id, {
    baseSha,
    branchName: `agentq/${task.id}`,
    worktreePath: resultWorktree,
  });
  value.app.store.finishRun(claim.run.id, {
    status: "succeeded",
    resultCommitSha: resultSha,
    changedFiles: [path],
    verificationResults: [
      {
        kind: "command",
        status: input.verificationStatus ?? "passed",
        name: "fixture verification",
        command: `test -f ${path}`,
        exitCode: input.verificationStatus === "failed" ? 1 : 0,
      },
    ],
  });

  return {
    task: await value.app.getTask(task.id),
    runId: claim.run.id,
    baseSha,
    resultSha,
    resultRef,
  };
}

describe("AgentQApp delivery", () => {
  test("integrates verified evidence, exposes the train, and lands the canonical local branch", async () => {
    const value = await fixture();
    const queue = await deliveryQueue(value, {
      verifyCommands: ["test -f feature.txt"],
    });
    expect(queue.baseRef).toBe("refs/heads/main");
    const result = await createSuccessfulResult(value, queue);

    expect(result.task).toMatchObject({
      status: "succeeded",
      deliveryStatus: "ready_to_integrate",
      resultCommitSha: result.resultSha,
    });
    const integrated = await value.app.integrateTask(result.task.id);
    expect(integrated).toMatchObject({
      status: "integrated",
      previousTrainSha: result.baseSha,
      changedFiles: [{ path: "feature.txt", kind: "added", tracked: true }],
    });
    if (integrated.status !== "integrated") throw new Error("Expected integration");
    expect(await git(value.repo, "rev-parse", integrated.integratedSha)).toBe(
      integrated.integratedSha,
    );
    expect(await git(value.repo, "show", `${integrated.integratedSha}:feature.txt`)).toBe(
      "verified feature",
    );
    expect(await git(value.repo, "rev-parse", "refs/heads/main")).toBe(result.baseSha);

    const beforeLanding = await value.app.getQueueDelivery(queue.id);
    expect(beforeLanding.queue.id).toBe(queue.id);
    expect(beforeLanding.lane).toMatchObject({
      repoPath: queue.repoPath,
      targetRef: "refs/heads/main",
      headSha: integrated.integratedSha,
      targetBaseSha: result.baseSha,
    });
    expect(beforeLanding.tasks).toEqual([
      expect.objectContaining({
        id: result.task.id,
        deliveryStatus: "integrated",
        integratedSha: integrated.integratedSha,
      }),
    ]);
    expect(beforeLanding.artifacts).toEqual([
      expect.objectContaining({
        taskId: result.task.id,
        runId: result.runId,
        resultSha: result.resultSha,
        resultRef: result.resultRef,
        targetRef: "refs/heads/main",
      }),
    ]);
    expect(beforeLanding.operations).toEqual([
      expect.objectContaining({
        kind: "integrate",
        taskId: result.task.id,
        status: "succeeded",
      }),
    ]);

    const landed = await value.app.landQueue(queue.id);
    expect(landed).toMatchObject({
      status: "landed",
      previousSha: result.baseSha,
      landedSha: integrated.integratedSha,
    });
    expect(await git(value.repo, "rev-parse", "refs/heads/main")).toBe(integrated.integratedSha);
    expect(await readFile(join(value.repo, "feature.txt"), "utf8")).toBe("verified feature\n");

    const afterLanding = await value.app.getQueueDelivery(queue.id);
    expect(afterLanding.lane).toMatchObject({
      headSha: integrated.integratedSha,
      targetBaseSha: integrated.integratedSha,
    });
    expect(afterLanding.tasks).toEqual([
      expect.objectContaining({
        id: result.task.id,
        deliveryStatus: "landed",
        currentPhase: "complete",
        landedSha: integrated.integratedSha,
      }),
    ]);
    expect(new Set(afterLanding.operations.map((operation) => operation.kind))).toEqual(
      new Set(["integrate", "land"]),
    );
  });

  test("repeating integration and landing is idempotent", async () => {
    const value = await fixture();
    const queue = await deliveryQueue(value);
    const result = await createSuccessfulResult(value, queue);

    const firstIntegration = await value.app.integrateTask(result.task.id);
    if (firstIntegration.status !== "integrated") throw new Error("Expected integration");
    const repeatedIntegration = await value.app.integrateTask(result.task.id);
    expect(repeatedIntegration).toEqual({
      status: "already-integrated",
      laneId: firstIntegration.laneId,
      artifactId: firstIntegration.artifactId,
      integratedSha: firstIntegration.integratedSha,
    });

    const firstLanding = await value.app.landQueue(queue.id);
    if (firstLanding.status !== "landed") throw new Error("Expected landing");
    const repeatedLanding = await value.app.landQueue(queue.id);
    expect(repeatedLanding).toEqual({
      status: "already-landed",
      laneId: firstLanding.laneId,
      landedSha: firstLanding.landedSha,
      artifactIds: firstLanding.artifactIds,
    });
    expect(await git(value.repo, "rev-parse", "refs/heads/main")).toBe(firstLanding.landedSha);

    const delivery = await value.app.getQueueDelivery(queue.id);
    expect(delivery.operations.filter((operation) => operation.kind === "integrate")).toHaveLength(
      1,
    );
    expect(delivery.operations.filter((operation) => operation.kind === "land")).toHaveLength(1);
  });

  test("automatically integrates and lands one verified queue result", async () => {
    const value = await fixture();
    const queue = await deliveryQueue(value, {
      autoLand: true,
      verifyCommands: ["test -f automatic.txt"],
    });
    const result = await createSuccessfulResult(value, queue, {
      title: "Automatic delivery",
      path: "automatic.txt",
      content: "automatically landed\n",
    });

    expect(await value.app.processReadyDeliveries({ queue: queue.id })).toBeTrue();
    expect(await value.app.processReadyDeliveries({ queue: queue.id })).toBeFalse();

    const delivery = await value.app.getQueueDelivery(queue.id);
    const deliveredTask = delivery.tasks[0];
    if (!deliveredTask?.landedSha) throw new Error("Expected an automatically landed task");
    expect(delivery.tasks).toEqual([
      expect.objectContaining({
        id: result.task.id,
        deliveryStatus: "landed",
        currentPhase: "complete",
      }),
    ]);
    expect(delivery.lane).toMatchObject({
      targetRef: "refs/heads/main",
      headSha: deliveredTask.landedSha,
      targetBaseSha: deliveredTask.landedSha,
    });
    expect(delivery.operations.filter((operation) => operation.kind === "integrate")).toHaveLength(
      1,
    );
    expect(delivery.operations.filter((operation) => operation.kind === "land")).toHaveLength(1);
    expect(delivery.operations.every((operation) => operation.status === "succeeded")).toBeTrue();
    expect(await git(value.repo, "rev-parse", "refs/heads/main")).toBe(deliveredTask.landedSha);
    expect(await readFile(join(value.repo, "automatic.txt"), "utf8")).toBe(
      "automatically landed\n",
    );
  });

  test("automatic delivery pauses on approvals without spinning and resumes after each decision", async () => {
    const value = await fixture();
    const queue = await deliveryQueue(value, {
      autoLand: true,
      approvalCheckpoints: ["before-integrate", "before-land"],
    });
    const result = await createSuccessfulResult(value, queue, {
      title: "Approval-gated automatic delivery",
      path: "approved.txt",
      content: "approved delivery\n",
    });

    expect(await value.app.processReadyDeliveries({ queue: queue.id })).toBeTrue();
    expect(await value.app.listTaskApprovals(result.task.id)).toEqual([
      expect.objectContaining({
        checkpoint: "before-integrate",
        status: "pending",
      }),
    ]);
    expect(await value.app.processReadyDeliveries({ queue: queue.id })).toBeFalse();
    expect(await value.app.processReadyDeliveries({ queue: queue.id })).toBeFalse();
    expect((await value.app.getQueueDelivery(queue.id)).operations).toEqual([]);
    expect(await git(value.repo, "rev-parse", "refs/heads/main")).toBe(result.baseSha);

    await value.app.approveTaskCheckpoint(result.task.id, "before-integrate", {
      actor: "release-manager",
    });
    expect(await value.app.processReadyDeliveries({ queue: queue.id })).toBeTrue();
    expect(await value.app.listTaskApprovals(result.task.id)).toEqual([
      expect.objectContaining({
        checkpoint: "before-integrate",
        status: "approved",
      }),
      expect.objectContaining({
        checkpoint: "before-land",
        status: "pending",
      }),
    ]);
    expect((await value.app.getTask(result.task.id)).deliveryStatus).toBe("integrated");
    expect(await value.app.processReadyDeliveries({ queue: queue.id })).toBeFalse();
    expect(await value.app.processReadyDeliveries({ queue: queue.id })).toBeFalse();
    expect(await git(value.repo, "rev-parse", "refs/heads/main")).toBe(result.baseSha);

    await value.app.approveTaskCheckpoint(result.task.id, "before-land", {
      actor: "release-manager",
    });
    expect(await value.app.processReadyDeliveries({ queue: queue.id })).toBeTrue();
    expect(await value.app.processReadyDeliveries({ queue: queue.id })).toBeFalse();
    const delivered = await value.app.getQueueDelivery(queue.id);
    expect(delivered.tasks).toEqual([
      expect.objectContaining({
        id: result.task.id,
        deliveryStatus: "landed",
        currentPhase: "complete",
      }),
    ]);
    expect(delivered.operations.filter((operation) => operation.kind === "integrate")).toHaveLength(
      1,
    );
    expect(delivered.operations.filter((operation) => operation.kind === "land")).toHaveLength(1);
    const deliveredTask = delivered.tasks[0];
    if (!deliveredTask?.landedSha) throw new Error("Expected an automatically landed task");
    expect(await git(value.repo, "rev-parse", "refs/heads/main")).toBe(deliveredTask.landedSha);
    expect(await readFile(join(value.repo, "approved.txt"), "utf8")).toBe("approved delivery\n");
  });

  test("a rejected integration approval permanently stops delivery without creating a train", async () => {
    const value = await fixture();
    const queue = await deliveryQueue(value, {
      autoLand: true,
      approvalCheckpoints: ["before-integrate"],
    });
    const result = await createSuccessfulResult(value, queue, {
      title: "Rejected automatic delivery",
      path: "rejected.txt",
      content: "must not land\n",
    });

    expect(await value.app.processReadyDeliveries({ queue: queue.id })).toBeTrue();
    expect(await value.app.listTaskApprovals(result.task.id)).toEqual([
      expect.objectContaining({
        checkpoint: "before-integrate",
        status: "pending",
      }),
    ]);

    const rejection = await value.app.rejectTaskCheckpoint(result.task.id, "before-integrate", {
      actor: "release-manager",
      note: "The release cannot accept this change",
    });
    expect(rejection).toMatchObject({
      checkpoint: "before-integrate",
      status: "rejected",
      actor: "release-manager",
      note: "The release cannot accept this change",
    });
    expect(await value.app.listTaskApprovals(result.task.id)).toEqual([rejection]);
    expect(await value.app.getTask(result.task.id)).toMatchObject({
      status: "failed",
      currentPhase: "complete",
      failureClass: "policy_violation",
      retryDisposition: "stop",
      deliveryStatus: "ready_to_integrate",
    });

    expect(await value.app.processReadyDeliveries({ queue: queue.id })).toBeFalse();
    expect(await value.app.processReadyDeliveries({ queue: queue.id })).toBeFalse();
    let integrationErrorCode: string | undefined;
    try {
      await value.app.integrateTask(result.task.id);
    } catch (error) {
      integrationErrorCode =
        error instanceof Error && "code" in error ? String(error.code) : undefined;
    }
    expect(
      integrationErrorCode === "APPROVAL_REJECTED" ||
        integrationErrorCode === "TASK_RESULT_NOT_VERIFIED",
    ).toBeTrue();

    const delivery = await value.app.getQueueDelivery(queue.id);
    expect(delivery.lane).toBeUndefined();
    expect(delivery.operations).toEqual([]);
    expect(
      await gitExitCode(value.repo, "show-ref", "--verify", `refs/heads/agentq/train/${queue.id}`),
    ).not.toBe(0);
    expect(await git(value.repo, "rev-parse", "refs/heads/main")).toBe(result.baseSha);
    expect(
      await gitExitCode(value.repo, "cat-file", "-e", "refs/heads/main:rejected.txt"),
    ).not.toBe(0);
  });

  test("refuses to integrate a task without successful verified result evidence", async () => {
    const value = await fixture();
    const queue = await deliveryQueue(value);
    const queued = await value.app.addTask({
      queue: queue.id,
      title: "No agent result",
    });

    await expect(value.app.integrateTask(queued.id)).rejects.toMatchObject({
      code: "TASK_RESULT_NOT_VERIFIED",
    });
    expect(await value.app.getQueueDelivery(queue.id)).toMatchObject({
      tasks: [
        expect.objectContaining({
          id: queued.id,
          status: "queued",
          deliveryStatus: "not_started",
        }),
      ],
      artifacts: [],
      operations: [],
    });
    await value.app.deleteTask(queued.id);

    const unverified = await createSuccessfulResult(value, queue, {
      title: "Failed verification",
      path: "unverified.txt",
      verificationStatus: "failed",
    });
    await expect(value.app.integrateTask(unverified.task.id)).rejects.toMatchObject({
      code: "TASK_RESULT_NOT_VERIFIED",
    });
    expect((await value.app.getQueueDelivery(queue.id)).artifacts).toEqual([]);
  });

  test("requires durable approvals immediately before integration and landing", async () => {
    const value = await fixture();
    const queue = await deliveryQueue(value, {
      approvalCheckpoints: ["before-integrate", "before-land"],
    });
    const result = await createSuccessfulResult(value, queue);

    await expect(value.app.integrateTask(result.task.id)).rejects.toMatchObject({
      code: "TASK_APPROVAL_REQUIRED",
    });
    expect(await value.app.listTaskApprovals(result.task.id)).toEqual([
      expect.objectContaining({
        taskId: result.task.id,
        checkpoint: "before-integrate",
        status: "pending",
      }),
    ]);

    await value.app.approveTaskCheckpoint(result.task.id, "before-integrate", {
      actor: "release-manager",
      note: "Verified the candidate",
    });
    const integrated = await value.app.integrateTask(result.task.id);
    expect(integrated.status).toBe("integrated");

    await expect(value.app.landQueue(queue.id)).rejects.toMatchObject({
      code: "TASK_APPROVAL_REQUIRED",
    });
    expect(await value.app.listTaskApprovals(result.task.id)).toEqual([
      expect.objectContaining({
        checkpoint: "before-integrate",
        status: "approved",
        actor: "release-manager",
      }),
      expect.objectContaining({
        checkpoint: "before-land",
        status: "pending",
      }),
    ]);

    await value.app.approveTaskCheckpoint(result.task.id, "before-land", {
      actor: "release-manager",
    });
    expect(await value.app.landQueue(queue.id)).toMatchObject({ status: "landed" });
    expect((await value.app.getTask(result.task.id)).deliveryStatus).toBe("landed");
  });

  test("refuses to land over a dirty checked-out target", async () => {
    const value = await fixture();
    const queue = await deliveryQueue(value);
    const result = await createSuccessfulResult(value, queue);
    const integrated = await value.app.integrateTask(result.task.id);
    if (integrated.status !== "integrated") throw new Error("Expected integration");
    await writeFile(join(value.repo, "local-only.txt"), "do not overwrite\n", "utf8");

    await expect(value.app.landQueue(queue.id)).rejects.toMatchObject({
      code: "LAND_TARGET_DIRTY",
    });
    expect(await git(value.repo, "rev-parse", "refs/heads/main")).toBe(result.baseSha);
    expect((await value.app.getTask(result.task.id)).deliveryStatus).toBe("integrated");

    await unlink(join(value.repo, "local-only.txt"));
    expect(await value.app.landQueue(queue.id)).toMatchObject({
      status: "landed",
      landedSha: integrated.integratedSha,
    });
  });

  test("refuses to land when the target branch has diverged externally", async () => {
    const value = await fixture();
    const queue = await deliveryQueue(value);
    const result = await createSuccessfulResult(value, queue);
    await value.app.integrateTask(result.task.id);
    await writeFile(join(value.repo, "external.txt"), "external target movement\n", "utf8");
    const externalSha = await commitAll(value.repo, "External target movement");

    await expect(value.app.landQueue(queue.id)).rejects.toMatchObject({
      code: "DELIVERY_TARGET_DRIFT",
    });
    expect(await git(value.repo, "rev-parse", "refs/heads/main")).toBe(externalSha);
    const task = await value.app.getTask(result.task.id);
    expect(task.deliveryStatus).toBe("integrated");
    expect(task.landedSha).toBeUndefined();
  });
});
