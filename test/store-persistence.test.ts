import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Queue, Task, TaskArtifact } from "../src/core/types.ts";
import {
  type DeliveryArtifact,
  DeliveryCoordinator,
  type DeliveryLaneKey,
  type IntegrationFailureRecord,
} from "../src/delivery/coordinator.ts";
import { AgentQStoreDeliveryPersistence } from "../src/delivery/store-persistence.ts";
import { runCommand } from "../src/git/command.ts";
import { AgentQStore } from "../src/store/store.ts";

const roots: string[] = [];
const stores: AgentQStore[] = [];

setDefaultTimeout(20_000);

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});

interface Fixture {
  root: string;
  repo: string;
  databasePath: string;
  store: AgentQStore;
  queue: Queue;
  baseSha: string;
  lane: DeliveryLaneKey;
  worktreesRoot: string;
}

interface StoredResult {
  task: Task;
  artifact: TaskArtifact;
  coordinatorArtifact: DeliveryArtifact;
}

async function git(repoPath: string, ...args: string[]): Promise<string> {
  const result = await runCommand("git", ["-C", repoPath, ...args]);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args[0]} failed`);
  }
  return result.stdout.trim();
}

async function commitAll(repoPath: string, message: string): Promise<string> {
  await git(repoPath, "add", "--all");
  await git(
    repoPath,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    message,
  );
  return git(repoPath, "rev-parse", "HEAD");
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "agentq-store-persistence-"));
  roots.push(root);
  const repo = join(root, "repo");
  await runCommand("git", ["init", "-b", "main", repo]);
  await writeFile(join(repo, "README.md"), "initial\n");
  const baseSha = await commitAll(repo, "initial");
  const databasePath = join(root, "agentq.sqlite");
  const store = new AgentQStore(databasePath);
  stores.push(store);
  const queue = store.createQueue({
    name: "delivery",
    repoKey: "repo-key",
    repoPath: repo,
    baseRef: "main",
    landStrategy: "merge-train",
  });
  return {
    root,
    repo,
    databasePath,
    store,
    queue,
    baseSha,
    lane: {
      repoKey: queue.repoKey,
      repoPath: repo,
      targetRef: "refs/heads/main",
      trainRef: "refs/heads/agentq/train/main",
    },
    worktreesRoot: join(root, "delivery-worktrees"),
  };
}

async function createStoredResult(
  context: Fixture,
  suffix: string,
  mutate: () => Promise<void>,
  changedFiles: string[],
  parentRef = context.baseSha,
): Promise<StoredResult> {
  const task = context.store.addTask({
    queue: context.queue.id,
    title: `Result ${suffix}`,
  });
  const claim = context.store.claimNextTask({ queue: context.queue.id });
  if (!claim) throw new Error("Expected task claim");
  context.store.markRunRunning(claim.run.id, {
    baseSha: parentRef,
    branchName: `agentq/${suffix}`,
    worktreePath: join(context.root, `worktree-${suffix}`),
  });

  await git(context.repo, "checkout", "-B", `result-${suffix}`, parentRef);
  await mutate();
  const resultSha = await commitAll(context.repo, `result ${suffix}`);
  const resultRef = `refs/agentq/results/${task.id}/${claim.run.id}`;
  await git(context.repo, "update-ref", resultRef, resultSha);
  await git(context.repo, "checkout", "main");

  const verificationResults = [
    {
      kind: "command" as const,
      status: "passed" as const,
      command: "test -e README.md",
      exitCode: 0,
    },
  ];
  context.store.finishRun(claim.run.id, {
    status: "succeeded",
    resultCommitSha: resultSha,
    changedFiles,
    verificationResults,
  });
  const artifact = context.store.recordTaskArtifact({
    runId: claim.run.id,
    baseSha: parentRef,
    resultSha,
    resultRef,
    changedFiles,
    verificationResults,
  });
  return {
    task: context.store.getTask(task.id) as Task,
    artifact,
    coordinatorArtifact: {
      id: artifact.id,
      taskId: artifact.taskId,
      runId: artifact.runId,
      resultRef: artifact.resultRef,
      resultSha: artifact.resultSha,
    },
  };
}

function persistence(
  store: AgentQStore,
  options: ConstructorParameters<typeof AgentQStoreDeliveryPersistence>[1] = {},
): AgentQStoreDeliveryPersistence {
  return new AgentQStoreDeliveryPersistence(store, {
    heartbeatIntervalMs: false,
    ...options,
  });
}

describe("AgentQStoreDeliveryPersistence", () => {
  test("durably integrates and lands through the real coordinator", async () => {
    const context = await fixture();
    const result = await createStoredResult(
      context,
      "success",
      async () => {
        await mkdir(join(context.repo, "src"));
        await writeFile(join(context.repo, "src", "feature.ts"), "export const ready = true;\n");
      },
      ["src/feature.ts"],
    );
    const adapter = persistence(context.store);
    const coordinator = new DeliveryCoordinator(adapter, {
      worktreesRoot: context.worktreesRoot,
    });

    const integrated = await coordinator.integrate({
      lane: context.lane,
      artifact: result.coordinatorArtifact,
      scopePolicy: {
        allowPathGroups: [["src/**"]],
        deniedPaths: [],
        maxChangedFiles: 1,
      },
      verificationCommands: ["test -f src/feature.ts"],
    });

    expect(integrated.status).toBe("integrated");
    if (integrated.status !== "integrated") throw new Error("Expected integration");
    expect(context.store.getTask(result.task.id)).toMatchObject({
      deliveryStatus: "integrated",
      currentPhase: "land",
      integratedSha: integrated.integratedSha,
    });
    const persistedLane = context.store.getIntegrationLaneForTarget(context.queue.repoKey, "main");
    expect(persistedLane).toMatchObject({
      repoPath: context.repo,
      headSha: integrated.integratedSha,
      generation: 1,
    });
    expect(await adapter.listIntegratedArtifacts(persistedLane?.id ?? "")).toEqual([
      { id: result.artifact.id, integratedSha: integrated.integratedSha },
    ]);
    expect(
      context.store.listDeliveryOperations({
        laneId: persistedLane?.id,
        statuses: ["succeeded"],
      }),
    ).toEqual([
      expect.objectContaining({
        kind: "integrate",
        artifactId: result.artifact.id,
        taskId: result.task.id,
        candidateSha: integrated.integratedSha,
      }),
    ]);

    const landed = await coordinator.land({ lane: context.lane });

    expect(landed.artifactIds).toEqual([result.artifact.id]);
    expect(await git(context.repo, "rev-parse", "main")).toBe(integrated.integratedSha);
    expect(context.store.getTask(result.task.id)).toMatchObject({
      deliveryStatus: "landed",
      currentPhase: "complete",
      landedSha: integrated.integratedSha,
    });
    expect(context.store.getIntegrationLane(persistedLane?.id ?? "")).toMatchObject({
      targetBaseSha: integrated.integratedSha,
      headSha: integrated.integratedSha,
      generation: 2,
    });
    expect(await adapter.listIntegratedArtifacts(persistedLane?.id ?? "")).toEqual([
      { id: result.artifact.id, integratedSha: integrated.integratedSha },
    ]);
  });

  test("maps replay conflicts into durable operation and task failure state", async () => {
    const context = await fixture();
    const result = await createStoredResult(
      context,
      "conflict",
      async () => {
        await writeFile(join(context.repo, "README.md"), "artifact\n");
      },
      ["README.md"],
    );
    await writeFile(join(context.repo, "README.md"), "target\n");
    const targetSha = await commitAll(context.repo, "target change");
    const adapter = persistence(context.store);
    const coordinator = new DeliveryCoordinator(adapter, {
      worktreesRoot: context.worktreesRoot,
    });

    const outcome = await coordinator.integrate({
      lane: context.lane,
      artifact: result.coordinatorArtifact,
    });

    expect(outcome).toMatchObject({
      status: "conflict",
      artifactId: result.artifact.id,
      conflictPaths: ["README.md"],
    });
    expect(context.store.getTask(result.task.id)).toMatchObject({
      deliveryStatus: "ready_to_integrate",
      currentPhase: "integrate",
      failureClass: "integration_conflict",
      retryDisposition: "manual_resolution",
      integrationConflictFiles: ["README.md"],
    });
    const lane = context.store.getIntegrationLaneForTarget(context.queue.repoKey, "main");
    expect(lane?.headSha).toBe(targetSha);
    expect(
      context.store.listDeliveryOperations({
        laneId: lane?.id,
        statuses: ["conflicted"],
      }),
    ).toEqual([
      expect.objectContaining({
        artifactId: result.artifact.id,
        conflictFiles: ["README.md"],
        error: expect.stringContaining("conflicts with the delivery train"),
      }),
    ]);
  });

  test("reclaims an exact expired operation after a process restart and fences the old owner", async () => {
    const context = await fixture();
    const result = await createStoredResult(
      context,
      "restart",
      async () => {
        await writeFile(join(context.repo, "restart.txt"), "restart\n");
      },
      ["restart.txt"],
    );
    let now = new Date("2026-07-24T12:00:00.000Z");
    const first = persistence(context.store, {
      leaseDurationMs: 1_000,
      now: () => now,
    });
    const lane = await first.getOrCreateLane({
      ...context.lane,
      initialSha: context.baseSha,
    });
    expect(
      await first.tryClaimLane({
        laneId: lane.id,
        operationId: "coordinator-a",
        kind: "integrate",
        taskId: result.task.id,
        artifactId: result.artifact.id,
        expectedRevision: lane.revision,
        expectedHeadSha: lane.headSha,
      }),
    ).toBe(true);
    const running = context.store.listDeliveryOperations({
      laneId: lane.id,
      statuses: ["running"],
    })[0];
    expect(running).toMatchObject({ ownerToken: "coordinator-a", fenceToken: 1 });

    context.store.close();
    stores.splice(stores.indexOf(context.store), 1);
    now = new Date("2026-07-24T12:00:01.001Z");
    const restartedStore = new AgentQStore(context.databasePath);
    stores.push(restartedStore);
    const second = persistence(restartedStore, {
      leaseDurationMs: 1_000,
      now: () => now,
    });
    const restartedLane = await second.getOrCreateLane({
      ...context.lane,
      initialSha: context.baseSha,
    });
    expect(
      await second.tryClaimLane({
        laneId: restartedLane.id,
        operationId: "coordinator-b",
        kind: "integrate",
        taskId: result.task.id,
        artifactId: result.artifact.id,
        expectedRevision: restartedLane.revision,
        expectedHeadSha: restartedLane.headSha,
      }),
    ).toBe(true);
    expect(restartedStore.getDeliveryOperation(running?.id ?? "")).toMatchObject({
      ownerToken: "coordinator-b",
      fenceToken: 2,
      status: "running",
    });

    const conflict: IntegrationFailureRecord = {
      artifactId: result.artifact.id,
      laneId: restartedLane.id,
      operationId: "coordinator-b",
      failureClass: "integration_conflict",
      message: "restart conflict",
      conflictPaths: ["restart.txt"],
      changedFiles: [],
      verificationResults: [],
    };
    await second.recordIntegrationFailure(conflict);
    await second.releaseLaneClaim(restartedLane.id, "coordinator-b");

    expect(restartedStore.getDeliveryOperation(running?.id ?? "")).toMatchObject({
      status: "conflicted",
      fenceToken: 2,
      conflictFiles: ["restart.txt"],
    });
    expect(restartedStore.getTask(result.task.id)).toMatchObject({
      failureClass: "integration_conflict",
      retryDisposition: "manual_resolution",
    });
  });

  test("reconciles lanes idempotently and terminalizes abandoned claims on release", async () => {
    const context = await fixture();
    const result = await createStoredResult(
      context,
      "reconcile",
      async () => {
        await writeFile(join(context.repo, "reconcile.txt"), "reconcile\n");
      },
      ["reconcile.txt"],
    );
    const releaseErrors: unknown[] = [];
    const adapter = persistence(context.store, {
      onReleaseError: (error) => releaseErrors.push(error),
    });
    const lane = await adapter.getOrCreateLane({
      ...context.lane,
      initialSha: context.baseSha,
    });
    const reconciledSha = result.artifact.resultSha;

    const reconciled = await adapter.reconcileLaneHead({
      laneId: lane.id,
      expectedRevision: lane.revision,
      expectedHeadSha: lane.headSha,
      actualHeadSha: reconciledSha,
    });
    const idempotent = await adapter.reconcileLaneHead({
      laneId: lane.id,
      expectedRevision: lane.revision,
      expectedHeadSha: lane.headSha,
      actualHeadSha: reconciledSha,
    });

    expect(reconciled).toMatchObject({ headSha: reconciledSha, revision: 1 });
    expect(idempotent).toEqual(reconciled);
    expect(context.store.getIntegrationLane(lane.id)?.generation).toBe(1);
    expect(
      await adapter.tryClaimLane({
        laneId: lane.id,
        operationId: "abandoned-land",
        kind: "land",
        expectedRevision: reconciled?.revision ?? 1,
        expectedHeadSha: reconciledSha,
      }),
    ).toBe(true);

    await adapter.releaseLaneClaim(lane.id, "abandoned-land");

    expect(
      context.store.listDeliveryOperations({
        laneId: lane.id,
        statuses: ["cancelled"],
      }),
    ).toEqual([
      expect.objectContaining({
        kind: "land",
        error: "Delivery coordinator released an unfinished claimed operation",
      }),
    ]);
    expect(releaseErrors).toEqual([]);
  });
});
