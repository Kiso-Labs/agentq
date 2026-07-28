import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentQError } from "../src/core/errors.ts";
import type { Queue, Task, TaskArtifact } from "../src/core/types.ts";
import { AgentQStore } from "../src/store/index.ts";
import { afterEach, beforeEach, describe, expect, test } from "./support/test.ts";

const BASE_SHA = "1".repeat(40);

describe("durable delivery store", () => {
  let directory: string;
  let databasePath: string;
  let stores: AgentQStore[];

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "agentq-delivery-store-"));
    databasePath = join(directory, "agentq.sqlite");
    stores = [];
  });

  afterEach(() => {
    for (const store of stores) store.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function open(): AgentQStore {
    const store = new AgentQStore(databasePath);
    stores.push(store);
    return store;
  }

  function expectCode(action: () => unknown, code: string): void {
    try {
      action();
      throw new Error(`Expected ${code}`);
    } catch (error) {
      expect(error).toBeInstanceOf(AgentQError);
      expect((error as AgentQError).code).toBe(code);
    }
  }

  function successfulArtifact(
    store: AgentQStore,
    queue: Queue,
    suffix: string,
  ): { task: Task; artifact: TaskArtifact } {
    const resultSha = suffix.repeat(40);
    const task = store.addTask({
      queue: queue.id,
      title: `Result ${suffix}`,
      expectedPaths: [`src/${suffix}/**`],
    });
    const claim = store.claimNextTask({ queue: queue.id });
    if (!claim) throw new Error("Expected a task claim");
    store.markRunRunning(claim.run.id, {
      baseSha: BASE_SHA,
      branchName: `agentq/${suffix}`,
      worktreePath: `/tmp/agentq-${suffix}`,
    });
    store.finishRun(claim.run.id, {
      status: "succeeded",
      resultCommitSha: resultSha,
      changedFiles: [`src/${suffix}/index.ts`],
      verificationResults: [
        {
          kind: "command",
          status: "passed",
          name: "tests",
          command: "bun test",
          exitCode: 0,
        },
      ],
    });
    const resultRef = `refs/agentq/results/${task.id}/${claim.run.id}`;
    const artifact = store.recordTaskArtifact({
      runId: claim.run.id,
      baseSha: BASE_SHA,
      resultSha,
      resultRef,
    });
    return { task: store.getTask(task.id) as Task, artifact };
  }

  function integrateArtifact(
    store: AgentQStore,
    laneId: string,
    task: Task,
    artifact: TaskArtifact,
    newHeadSha: string,
  ): void {
    const lane = store.getIntegrationLane(laneId);
    if (!lane) throw new Error("Expected integration lane");
    const operation = store.createDeliveryOperation({
      laneId,
      kind: "integrate",
      taskId: task.id,
      artifactId: artifact.id,
    });
    const claim = store.claimDeliveryOperation({
      operationId: operation.id,
      ownerToken: `integrator-${task.id}`,
    });
    if (!claim) throw new Error("Expected delivery operation claim");
    store.completeIntegration({
      operationId: operation.id,
      leaseToken: claim.leaseToken,
      fenceToken: claim.fenceToken,
      expectedLaneGeneration: lane.generation,
      expectedHeadSha: lane.headSha,
      newHeadSha,
    });
  }

  test("persists canonical immutable evidence and atomically integrates and lands it", () => {
    const store = open();
    const queue = store.createQueue({
      name: "delivery",
      repoKey: "repo-key",
      repoPath: "/repos/product",
      baseRef: "main",
      landStrategy: "merge-train",
    });
    const task = store.addTask({ queue: queue.id, title: "Strict evidence" });
    const claim = store.claimNextTask({ queue: queue.id });
    if (!claim) throw new Error("Expected claim");
    store.markRunRunning(claim.run.id, {
      baseSha: BASE_SHA,
      branchName: "agentq/result",
      worktreePath: "/tmp/agentq-result",
    });
    const resultSha = "2".repeat(40);
    const verificationResults = [
      {
        kind: "command" as const,
        status: "passed" as const,
        command: "bun test",
        exitCode: 0,
      },
    ];
    store.finishRun(claim.run.id, {
      status: "succeeded",
      resultCommitSha: resultSha,
      changedFiles: ["src/result.ts"],
      verificationResults,
    });
    expectCode(
      () =>
        store.recordTaskArtifact({
          runId: claim.run.id,
          baseSha: BASE_SHA,
          resultSha,
          resultRef: "refs/heads/mutable",
        }),
      "TASK_ARTIFACT_RESULT_REF_INVALID",
    );
    expectCode(
      () =>
        store.recordTaskArtifact({
          runId: claim.run.id,
          baseSha: BASE_SHA,
          resultSha,
          resultRef: `refs/agentq/results/${task.id}/${claim.run.id}`,
          changedFiles: ["src/not-the-persisted-result.ts"],
        }),
      "TASK_ARTIFACT_EVIDENCE_MISMATCH",
    );

    const artifact = store.recordTaskArtifact({
      runId: claim.run.id,
      baseSha: BASE_SHA,
      resultSha,
      resultRef: `refs/agentq/results/${task.id}/${claim.run.id}`,
      changedFiles: ["src/result.ts"],
      verificationResults,
    });
    expect(artifact).toMatchObject({
      taskId: task.id,
      runId: claim.run.id,
      repoKey: "repo-key",
      targetRef: "refs/heads/main",
      baseSha: BASE_SHA,
      resultSha,
    });
    expect(
      store.recordTaskArtifact({
        runId: claim.run.id,
        baseSha: BASE_SHA,
        resultSha,
        resultRef: artifact.resultRef,
      }),
    ).toEqual(artifact);
    expectCode(
      () => store.updateRun(claim.run.id, { verificationResults: [] }),
      "RUN_EVIDENCE_IMMUTABLE",
    );

    const lane = store.getOrCreateIntegrationLane({
      repoKey: "repo-key",
      repoPath: "/repos/product",
      targetRef: "main",
      trainRef: "refs/agentq/trains/repo-key/main",
      initialHeadSha: BASE_SHA,
    });
    expect(lane).toMatchObject({
      repoPath: "/repos/product",
      targetRef: "refs/heads/main",
      headSha: BASE_SHA,
      targetBaseSha: BASE_SHA,
      generation: 0,
    });
    expectCode(
      () =>
        store.getOrCreateIntegrationLane({
          repoKey: "repo-key",
          repoPath: "/repos/moved",
          targetRef: "main",
          trainRef: lane.trainRef,
          initialHeadSha: BASE_SHA,
        }),
      "INTEGRATION_LANE_CONFLICT",
    );

    const operation = store.createDeliveryOperation({
      laneId: lane.id,
      kind: "integrate",
      taskId: task.id,
      artifactId: artifact.id,
    });
    expect(
      store.createDeliveryOperation({
        laneId: lane.id,
        kind: "integrate",
        taskId: task.id,
        artifactId: artifact.id,
      }),
    ).toEqual(operation);
    const integrationClaim = store.claimDeliveryOperation({
      ownerToken: "integrator-1",
      laneId: lane.id,
    });
    if (!integrationClaim) throw new Error("Expected integration claim");
    const integratedSha = "3".repeat(40);
    const integrated = store.completeIntegration({
      operationId: integrationClaim.operation.id,
      leaseToken: integrationClaim.leaseToken,
      fenceToken: integrationClaim.fenceToken,
      expectedLaneGeneration: 0,
      expectedHeadSha: BASE_SHA,
      newHeadSha: integratedSha,
    });
    expect(integrated.lane).toMatchObject({ headSha: integratedSha, generation: 1 });
    expect(integrated.task).toMatchObject({
      deliveryStatus: "integrated",
      currentPhase: "land",
      integratedSha,
      integrationConflictFiles: [],
    });
    expect(integrated.operation.status).toBe("succeeded");

    const landOperation = store.createDeliveryOperation({ laneId: lane.id, kind: "land" });
    const landClaim = store.claimDeliveryOperation({
      ownerToken: "lander-1",
      laneId: lane.id,
    });
    expect(landClaim?.operation.id).toBe(landOperation.id);
    if (!landClaim) throw new Error("Expected landing claim");
    const landed = store.completeLanding({
      laneId: lane.id,
      expectedLaneGeneration: 1,
      expectedHeadSha: integratedSha,
      landedSha: integratedSha,
      artifactIds: [artifact.id],
      operationId: landClaim.operation.id,
      leaseToken: landClaim.leaseToken,
      fenceToken: landClaim.fenceToken,
    });
    expect(landed.lane).toMatchObject({
      targetBaseSha: integratedSha,
      headSha: integratedSha,
      generation: 2,
    });
    expect(landed.tasks[0]).toMatchObject({
      id: task.id,
      deliveryStatus: "landed",
      currentPhase: "complete",
      landedSha: integratedSha,
    });
    expect(landed.operation?.status).toBe("succeeded");

    store.updateRun(claim.run.id, { worktreePath: null });
    expect(store.deleteTask(task.id)).toBe(true);
    expect(store.getTaskArtifact(artifact.id)).toBeUndefined();
    expect(store.getDeliveryOperation(operation.id)).toBeUndefined();
  });

  test("refuses artifact creation when persisted verification did not pass", () => {
    const store = open();
    const queue = store.createQueue({
      name: "unverified-artifact",
      repoKey: "repo",
      repoPath: "/repo",
      baseRef: "main",
    });
    const task = store.addTask({ queue: queue.id, title: "Unverified result" });
    const claim = store.claimNextTask({ queue: queue.id });
    if (!claim) throw new Error("Expected claim");
    store.markRunRunning(claim.run.id, {
      baseSha: BASE_SHA,
      branchName: "agentq/unverified",
      worktreePath: "/tmp/agentq-unverified",
    });
    const resultSha = "a".repeat(40);
    store.finishRun(claim.run.id, {
      status: "succeeded",
      resultCommitSha: resultSha,
      verificationResults: [
        {
          kind: "command",
          status: "failed",
          command: "bun test",
          exitCode: 1,
        },
      ],
    });
    expectCode(
      () =>
        store.recordTaskArtifact({
          runId: claim.run.id,
          baseSha: BASE_SHA,
          resultSha,
          resultRef: `refs/agentq/results/${task.id}/${claim.run.id}`,
        }),
      "TASK_ARTIFACT_UNVERIFIED",
    );
  });

  test("fences reclaimed delivery leases and records integration conflicts on the task", () => {
    const store = open();
    const second = open();
    const queue = store.createQueue({
      name: "fencing",
      repoKey: "repo",
      repoPath: "/repo",
      baseRef: "main",
    });
    const { task, artifact } = successfulArtifact(store, queue, "4");
    const lane = store.getOrCreateIntegrationLane({
      repoKey: queue.repoKey,
      repoPath: queue.repoPath,
      targetRef: queue.baseRef,
      trainRef: "refs/agentq/trains/repo/main",
      initialHeadSha: BASE_SHA,
    });
    const operation = store.createDeliveryOperation({
      laneId: lane.id,
      kind: "integrate",
      taskId: task.id,
      artifactId: artifact.id,
    });
    const firstClaim = store.claimDeliveryOperation({
      ownerToken: "worker-a",
      laneId: lane.id,
      now: "2026-07-24T12:00:00.000Z",
      leaseDurationMs: 1_000,
    });
    expect(firstClaim?.operation.id).toBe(operation.id);
    expect(
      second.claimDeliveryOperation({
        ownerToken: "worker-b",
        laneId: lane.id,
        now: "2026-07-24T12:00:00.500Z",
      }),
    ).toBeUndefined();
    const reclaimed = second.claimDeliveryOperation({
      ownerToken: "worker-b",
      laneId: lane.id,
      now: "2026-07-24T12:00:01.001Z",
    });
    expect(reclaimed?.fenceToken).toBe(2);
    if (!firstClaim || !reclaimed) throw new Error("Expected both claims");
    expectCode(
      () =>
        store.finishDeliveryOperation(
          operation.id,
          { status: "failed", error: "stale" },
          firstClaim.leaseToken,
          firstClaim.fenceToken,
        ),
      "DELIVERY_LEASE_LOST",
    );

    const failed = second.recordIntegrationFailure({
      operationId: operation.id,
      leaseToken: reclaimed.leaseToken,
      fenceToken: reclaimed.fenceToken,
      status: "conflicted",
      failureClass: "integration_conflict",
      conflictFiles: ["src/4/index.ts"],
      error: "content conflict",
    });
    expect(failed.operation).toMatchObject({
      status: "conflicted",
      conflictFiles: ["src/4/index.ts"],
    });
    expect(failed.task).toMatchObject({
      deliveryStatus: "ready_to_integrate",
      currentPhase: "integrate",
      failureClass: "integration_conflict",
      retryDisposition: "manual_resolution",
      integrationConflictFiles: ["src/4/index.ts"],
    });

    const retryOperation = store.createDeliveryOperation({
      laneId: lane.id,
      kind: "integrate",
      taskId: task.id,
      artifactId: artifact.id,
    });
    const retryClaim = store.claimDeliveryOperation({
      operationId: retryOperation.id,
      ownerToken: "worker-c",
    });
    if (!retryClaim) throw new Error("Expected integration retry claim");
    const retriedSha = "8".repeat(40);
    const retried = store.completeIntegration({
      operationId: retryOperation.id,
      leaseToken: retryClaim.leaseToken,
      fenceToken: retryClaim.fenceToken,
      expectedLaneGeneration: 0,
      expectedHeadSha: BASE_SHA,
      newHeadSha: retriedSha,
    });
    expect(retried.task.integrationConflictFiles).toEqual([]);
    expect(retried.task.failureClass).toBeUndefined();

    expectCode(
      () =>
        store.advanceIntegrationLaneHead(lane.id, {
          expectedHeadSha: "9".repeat(40),
          newHeadSha: "7".repeat(40),
        }),
      "INTEGRATION_LANE_HEAD_CHANGED",
    );
    const reconciled = store.reconcileIntegrationLaneHead(lane.id, {
      expectedLaneGeneration: 1,
      expectedHeadSha: retriedSha,
      newHeadSha: "9".repeat(40),
    });
    expect(reconciled).toMatchObject({ headSha: "9".repeat(40), generation: 2 });
  });

  test("projects typed integration retries and pins fresh test-regression work to lane head", () => {
    const store = open();
    const queue = store.createQueue({
      name: "typed-delivery-failures",
      repoKey: "repo",
      repoPath: "/repo",
      baseRef: "main",
      maxAttempts: 1,
    });
    const { task, artifact } = successfulArtifact(store, queue, "6");
    const lane = store.getOrCreateIntegrationLane({
      repoKey: queue.repoKey,
      repoPath: queue.repoPath,
      targetRef: queue.baseRef,
      trainRef: "refs/agentq/trains/repo/main",
      initialHeadSha: BASE_SHA,
    });

    const contentionOperation = store.createDeliveryOperation({
      laneId: lane.id,
      kind: "integrate",
      taskId: task.id,
      artifactId: artifact.id,
    });
    const contentionClaim = store.claimDeliveryOperation({
      operationId: contentionOperation.id,
      ownerToken: "contention-worker",
    });
    if (!contentionClaim) throw new Error("Expected contention claim");
    const contention = store.recordIntegrationFailure({
      operationId: contentionOperation.id,
      leaseToken: contentionClaim.leaseToken,
      fenceToken: contentionClaim.fenceToken,
      status: "failed",
      failureClass: "integration_contention",
      error: "lane moved before CAS",
    });
    expect(contention.task).toMatchObject({
      status: "succeeded",
      deliveryStatus: "ready_to_integrate",
      currentPhase: "integrate",
      failureClass: "integration_contention",
      retryDisposition: "retry",
      integrationConflictFiles: [],
    });

    const regressionOperation = store.createDeliveryOperation({
      laneId: lane.id,
      kind: "integrate",
      taskId: task.id,
      artifactId: artifact.id,
    });
    const regressionClaim = store.claimDeliveryOperation({
      operationId: regressionOperation.id,
      ownerToken: "verification-worker",
    });
    if (!regressionClaim) throw new Error("Expected regression claim");
    const regression = store.recordIntegrationFailure({
      operationId: regressionOperation.id,
      leaseToken: regressionClaim.leaseToken,
      fenceToken: regressionClaim.fenceToken,
      status: "failed",
      failureClass: "test_regression",
      error: "merge-train verification failed",
    });
    expect(regression.task).toMatchObject({
      status: "queued",
      currentPhase: "queued",
      deliveryStatus: "implemented",
      failureClass: "test_regression",
      retryDisposition: "return_to_implementation",
      attemptCount: 0,
      createdBaseSha: BASE_SHA,
    });
    expect(regression.task.resumeRunId).toBeUndefined();
    const retry = store.claimNextTask({ queue: queue.id });
    expect(retry?.run).toMatchObject({ phase: "plan", baseSha: BASE_SHA });
    expect(retry?.task.attemptCount).toBe(1);
  });

  test("does not pre-pin an ordinary root claim before base-drift handling", () => {
    const store = open();
    const queue = store.createQueue({
      name: "drift",
      repoKey: "repo",
      repoPath: "/repo",
      baseRef: "main",
    });
    const task = store.addTask({
      queue: queue.id,
      title: "ordinary stale root",
      createdBaseSha: BASE_SHA,
    });
    const claim = store.claimNextTask({ queue: queue.id });
    expect(claim?.task.id).toBe(task.id);
    expect(claim?.run.baseSha).toBeUndefined();
  });

  test("pins a fan-in task to the shared lane head after sequential blocker integrations", () => {
    const store = open();
    const queue = store.createQueue({
      name: "fan-in",
      repoKey: "repo",
      repoPath: "/repo",
      baseRef: "main",
    });
    const lane = store.getOrCreateIntegrationLane({
      repoKey: queue.repoKey,
      repoPath: queue.repoPath,
      targetRef: queue.baseRef,
      trainRef: "refs/agentq/trains/repo/main",
      initialHeadSha: BASE_SHA,
    });
    const first = successfulArtifact(store, queue, "a");
    const firstIntegratedSha = "b".repeat(40);
    integrateArtifact(store, lane.id, first.task, first.artifact, firstIntegratedSha);

    const second = successfulArtifact(store, queue, "c");
    const sharedLaneHead = "d".repeat(40);
    integrateArtifact(store, lane.id, second.task, second.artifact, sharedLaneHead);
    expect(store.getTask(first.task.id)?.integratedSha).toBe(firstIntegratedSha);
    expect(store.getTask(second.task.id)?.integratedSha).toBe(sharedLaneHead);

    const fanIn = store.addTask({
      queue: queue.id,
      title: "Combine both integrated blockers",
      blockedBy: [first.task.id, second.task.id],
    });
    const claim = store.claimNextTask({ queue: queue.id });
    expect(claim?.task.id).toBe(fanIn.id);
    expect(claim?.run.baseSha).toBe(sharedLaneHead);
    expect(
      new Set(claim?.run.dependencySnapshot.map((dependency) => dependency.resultCommitSha)),
    ).toEqual(new Set([first.artifact.resultSha, second.artifact.resultSha]));
    expect(store.getTask(fanIn.id)?.attemptCount).toBe(1);
  });

  test("refuses fan-in blockers integrated into different delivery lanes", () => {
    const store = open();
    const mainQueue = store.createQueue({
      name: "main-work",
      repoKey: "repo",
      repoPath: "/repo",
      baseRef: "main",
    });
    const releaseQueue = store.createQueue({
      name: "release-work",
      repoKey: "repo",
      repoPath: "/repo",
      baseRef: "release",
    });
    const mainLane = store.getOrCreateIntegrationLane({
      repoKey: "repo",
      repoPath: "/repo",
      targetRef: "main",
      trainRef: "refs/agentq/trains/repo/main",
      initialHeadSha: BASE_SHA,
    });
    const releaseLane = store.getOrCreateIntegrationLane({
      repoKey: "repo",
      repoPath: "/repo",
      targetRef: "release",
      trainRef: "refs/agentq/trains/repo/release",
      initialHeadSha: BASE_SHA,
    });
    const mainBlocker = successfulArtifact(store, mainQueue, "e");
    integrateArtifact(store, mainLane.id, mainBlocker.task, mainBlocker.artifact, "f".repeat(40));
    const releaseBlocker = successfulArtifact(store, releaseQueue, "2");
    integrateArtifact(
      store,
      releaseLane.id,
      releaseBlocker.task,
      releaseBlocker.artifact,
      "3".repeat(40),
    );
    const fanIn = store.addTask({
      queue: mainQueue.id,
      title: "Unsafe cross-lane fan-in",
      blockedBy: [mainBlocker.task.id, releaseBlocker.task.id],
    });

    expect(store.claimNextTask({ queue: mainQueue.id })).toBeUndefined();
    expect(store.getTask(fanIn.id)).toMatchObject({
      status: "queued",
      currentPhase: "blocked",
      attemptCount: 0,
    });
  });

  test("permanently stops a task whose integration violates policy", () => {
    const store = open();
    const queue = store.createQueue({
      name: "policy-delivery-failure",
      repoKey: "policy-repo",
      repoPath: "/policy-repo",
      baseRef: "main",
    });
    const { task, artifact } = successfulArtifact(store, queue, "7");
    const lane = store.getOrCreateIntegrationLane({
      repoKey: queue.repoKey,
      repoPath: queue.repoPath,
      targetRef: queue.baseRef,
      trainRef: "refs/agentq/trains/policy-repo/main",
      initialHeadSha: BASE_SHA,
    });
    const operation = store.createDeliveryOperation({
      laneId: lane.id,
      kind: "integrate",
      taskId: task.id,
      artifactId: artifact.id,
    });
    const claim = store.claimDeliveryOperation({
      operationId: operation.id,
      ownerToken: "policy-worker",
    });
    if (!claim) throw new Error("Expected policy claim");
    const failure = store.recordIntegrationFailure({
      operationId: operation.id,
      leaseToken: claim.leaseToken,
      fenceToken: claim.fenceToken,
      status: "failed",
      failureClass: "policy_violation",
      error: "forbidden path entered the candidate",
    });
    expect(failure.task).toMatchObject({
      status: "failed",
      currentPhase: "complete",
      deliveryStatus: "implemented",
      failureClass: "policy_violation",
      retryDisposition: "stop",
      integrationConflictFiles: [],
    });
    expect(store.claimNextTask({ queue: queue.id })).toBeUndefined();
  });

  test("pauses without spending an attempt and waits for every approval checkpoint", () => {
    const store = open();
    const queue = store.createQueue({
      name: "approval",
      repoKey: "repo",
      repoPath: "/repo",
      maxAttempts: 1,
    });
    const task = store.addTask({ queue: queue.id, title: "Needs review" });
    const claim = store.claimNextTask({ queue: queue.id, ownerToken: "supervisor" });
    if (!claim) throw new Error("Expected claim");
    store.markRunRunning(
      claim.run.id,
      {
        baseSha: BASE_SHA,
        branchName: "agentq/approval",
        worktreePath: "/tmp/agentq-approval",
      },
      claim.leaseToken,
    );
    const paused = store.pauseRunForApproval(
      claim.run.id,
      {
        checkpoint: "red-tests",
        planOutput: "Implement only after the tests are approved.",
      },
      claim.leaseToken,
    );
    store.requestTaskApproval({
      taskId: task.id,
      runId: claim.run.id,
      checkpoint: "architecture",
    });
    expect(paused.run).toMatchObject({
      status: "interrupted",
      phase: "implement",
      planOutput: "Implement only after the tests are approved.",
    });
    expect(store.getTask(task.id)).toMatchObject({
      status: "queued",
      currentPhase: "approval",
      attemptCount: 0,
      resumeRunId: claim.run.id,
    });
    expect(store.claimNextTask({ queue: queue.id })).toBeUndefined();

    store.approveTaskCheckpoint(task.id, "red-tests", { actor: "reviewer" });
    expect(store.getTask(task.id)?.currentPhase).toBe("approval");
    expect(store.claimNextTask({ queue: queue.id })).toBeUndefined();
    store.approveTaskCheckpoint(task.id, "architecture", { actor: "architect" });
    expect(store.getTask(task.id)?.currentPhase).toBe("implement");
    const resumed = store.claimNextTask({ queue: queue.id });
    expect(resumed?.run).toMatchObject({
      phase: "implement",
      planOutput: "Implement only after the tests are approved.",
    });
    expect(resumed?.task.attemptCount).toBe(1);
  });

  test("supports pre-run approvals and permanently records rejection decisions", () => {
    const store = open();
    const queue = store.createQueue({
      name: "approval-decisions",
      repoKey: "repo",
      repoPath: "/repo",
      concurrency: 2,
    });
    const approvedTask = store.addTask({ queue: queue.id, title: "Pre-approved" });
    store.requestTaskApproval({
      taskId: approvedTask.id,
      checkpoint: "security",
    });
    expect(store.getTask(approvedTask.id)?.currentPhase).toBe("approval");
    expect(store.claimNextTask({ queue: queue.id })).toBeUndefined();
    store.approveTaskCheckpoint(approvedTask.id, "security", { actor: "security-reviewer" });
    expect(store.getTask(approvedTask.id)?.currentPhase).toBe("queued");
    expect(store.claimNextTask({ queue: queue.id })?.task.id).toBe(approvedTask.id);

    const rejectedTask = store.addTask({ queue: queue.id, title: "Rejected" });
    store.requestTaskApproval({
      taskId: rejectedTask.id,
      checkpoint: "release",
    });
    const rejected = store.rejectTaskCheckpoint(rejectedTask.id, "release", {
      actor: "release-manager",
      note: "Acceptance evidence is incomplete",
    });
    expect(rejected).toMatchObject({
      status: "rejected",
      actor: "release-manager",
      note: "Acceptance evidence is incomplete",
    });
    expect(store.getTask(rejectedTask.id)).toMatchObject({
      status: "failed",
      currentPhase: "complete",
      failureClass: "policy_violation",
      retryDisposition: "stop",
    });
  });

  test("enforces conservative path concurrency without consuming blocked attempts", () => {
    const store = open();
    const queue = store.createQueue({
      name: "scoped",
      repoKey: "repo",
      repoPath: "/repo",
      concurrency: 4,
      fileConcurrency: "enforced",
    });
    const first = store.addTask({
      queue: queue.id,
      title: "first",
      priority: 30,
      expectedPaths: ["src/services/a/**"],
    });
    const overlapping = store.addTask({
      queue: queue.id,
      title: "overlap",
      priority: 20,
      expectedPaths: ["src/services/a/child/**"],
    });
    const independent = store.addTask({
      queue: queue.id,
      title: "independent",
      priority: 10,
      expectedPaths: ["src/services/b/**"],
    });

    expect(store.claimNextTask({ queue: queue.id })?.task.id).toBe(first.id);
    expect(store.claimNextTask({ queue: queue.id })?.task.id).toBe(independent.id);
    expect(store.getTask(overlapping.id)?.attemptCount).toBe(0);
    expect(store.claimNextTask({ queue: queue.id })).toBeUndefined();
  });

  test("serializes file claims and delivery idempotency across concurrent writers", async () => {
    const store = open();
    const queue = store.createQueue({
      name: "concurrent",
      repoKey: "repo",
      repoPath: "/repo",
      concurrency: 8,
      fileConcurrency: "enforced",
    });
    for (const title of ["one", "two"]) {
      store.addTask({
        queue: queue.id,
        title,
        expectedPaths: ["src/shared/**"],
      });
    }
    const storeUrl = new URL("../src/store/index.ts", import.meta.url).href;
    const claimChildren = Array.from({ length: 8 }, () => {
      const source = `
        import { AgentQStore } from ${JSON.stringify(storeUrl)};
        const store = new AgentQStore(${JSON.stringify(databasePath)});
        const claim = store.claimNextTask({ queue: ${JSON.stringify(queue.id)} });
        process.stdout.write(JSON.stringify(claim?.task.id ?? null));
        store.close();
      `;
      return Bun.spawn([process.execPath, "-e", source], { stdout: "pipe", stderr: "pipe" });
    });
    const claimResults = await Promise.all(
      claimChildren.map(async (child) => ({
        exitCode: await child.exited,
        stderr: await new Response(child.stderr).text(),
        taskId: JSON.parse(await new Response(child.stdout).text()) as string | null,
      })),
    );
    expect(claimResults.every((result) => result.exitCode === 0 && result.stderr === "")).toBe(
      true,
    );
    expect(claimResults.filter((result) => result.taskId !== null)).toHaveLength(1);

    const resultQueue = store.createQueue({
      name: "result",
      repoKey: "delivery-repo",
      repoPath: "/delivery-repo",
      baseRef: "main",
    });
    const { task, artifact } = successfulArtifact(store, resultQueue, "5");
    const laneChildren = Array.from({ length: 8 }, () => {
      const source = `
        import { AgentQStore } from ${JSON.stringify(storeUrl)};
        const store = new AgentQStore(${JSON.stringify(databasePath)});
        const lane = store.getOrCreateIntegrationLane({
          repoKey: "delivery-repo",
          repoPath: "/delivery-repo",
          targetRef: "main",
          trainRef: "refs/agentq/trains/delivery-repo/main",
          initialHeadSha: ${JSON.stringify(BASE_SHA)},
        });
        const operation = store.createDeliveryOperation({
          laneId: lane.id,
          kind: "integrate",
          taskId: ${JSON.stringify(task.id)},
          artifactId: ${JSON.stringify(artifact.id)},
        });
        process.stdout.write(JSON.stringify({ laneId: lane.id, operationId: operation.id }));
        store.close();
      `;
      return Bun.spawn([process.execPath, "-e", source], { stdout: "pipe", stderr: "pipe" });
    });
    const laneResults = await Promise.all(
      laneChildren.map(async (child) => ({
        exitCode: await child.exited,
        stderr: await new Response(child.stderr).text(),
        value: JSON.parse(await new Response(child.stdout).text()) as {
          laneId: string;
          operationId: string;
        },
      })),
    );
    expect(laneResults.every((result) => result.exitCode === 0 && result.stderr === "")).toBe(true);
    expect(new Set(laneResults.map((result) => result.value.laneId)).size).toBe(1);
    expect(new Set(laneResults.map((result) => result.value.operationId)).size).toBe(1);
  });

  test("clears queue and task changed-file limits explicitly", () => {
    const store = open();
    const queue = store.createQueue({
      name: "limits",
      repoKey: "repo",
      repoPath: "/repo",
      maxChangedFiles: 10,
    });
    expect(store.updateQueue(queue.id, { maxChangedFiles: null }).maxChangedFiles).toBeUndefined();
    const task = store.addTask({
      queue: queue.id,
      title: "limited",
      maxChangedFiles: 5,
    });
    expect(store.editTask(task.id, { maxChangedFiles: null }).maxChangedFiles).toBeUndefined();
  });
});
