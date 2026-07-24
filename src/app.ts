import { spawn } from "node:child_process";
import { access, chmod, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AgentQError, errorMessage } from "./core/errors.ts";
import { resolvePaths } from "./core/paths.ts";
import { resolveEffectiveScopePolicy } from "./core/scope-policy.ts";
import {
  type AddTaskInput,
  type AgentQPaths,
  type CreateQueueInput,
  canCancelTask,
  canRetryTask,
  type DeliveryOperation,
  type IntegrationLane,
  isTaskTerminal,
  type Provider,
  type ProviderHealth,
  type Queue,
  type Run,
  type Task,
  type TaskApproval,
  type TaskArtifact,
  type TaskEvent,
} from "./core/types.ts";
import {
  DeliveryCoordinator,
  type DeliveryLaneKey,
  type IntegrationOutcome,
  type LandingOutcome,
} from "./delivery/coordinator.ts";
import { AgentQStoreDeliveryPersistence } from "./delivery/store-persistence.ts";
import { createExecutorMap } from "./executors/index.ts";
import { runCommand, runGit } from "./git/command.ts";
import {
  findRepositoryContext,
  type RepositoryContext,
  resolveRepositoryContext,
} from "./git/repository.ts";
import { WorktreeManager } from "./git/worktrees.ts";
import {
  type IntegrationResult,
  type IntegrationTarget,
  installIntegration as writeIntegration,
} from "./integrations/instructions.ts";
import { resolveCommandInvocation } from "./process/index.ts";
import { AgentQStore } from "./store/index.ts";
import type { EditTaskInput } from "./store/types.ts";
import type { UiContext, UiController, UiQueuePatch } from "./ui/types.ts";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  remediation?: string;
}

export type TaskIntegrationOutcome =
  | IntegrationOutcome
  | {
      readonly status: "already-integrated";
      readonly laneId: string;
      readonly artifactId: string;
      readonly integratedSha: string;
    };

export type QueueLandingOutcome =
  | LandingOutcome
  | {
      readonly status: "already-landed";
      readonly laneId: string;
      readonly landedSha: string;
      readonly artifactIds: readonly string[];
    };

export interface QueueDeliverySnapshot {
  queue: Queue;
  lane?: IntegrationLane;
  tasks: Task[];
  artifacts: TaskArtifact[];
  operations: DeliveryOperation[];
}

export class AgentQApp implements UiController {
  readonly paths: AgentQPaths;
  readonly store: AgentQStore;
  readonly worktrees: WorktreeManager;
  readonly delivery: DeliveryCoordinator;
  private readonly listeners = new Set<() => void>();
  private readonly deliveryRetryAt = new Map<string, number>();
  private readonly deliveryRetryCount = new Map<string, number>();
  private scope?: RepositoryContext;
  private showAllRepositories = false;

  private constructor(paths: AgentQPaths, store: AgentQStore) {
    this.paths = paths;
    this.store = store;
    this.worktrees = new WorktreeManager(paths);
    this.delivery = new DeliveryCoordinator(new AgentQStoreDeliveryPersistence(store), {
      worktreesRoot: join(paths.worktreesDir, "delivery"),
    });
  }

  static async create(paths: AgentQPaths = resolvePaths()): Promise<AgentQApp> {
    await Promise.all(
      [
        paths.stateDir,
        dirname(paths.databasePath),
        paths.logsDir,
        paths.worktreesDir,
        paths.locksDir,
        join(paths.stateDir, "intake"),
        join(paths.stateDir, "intake-staging"),
        join(paths.stateDir, "process-identities"),
      ].map(ensurePrivateDirectory),
    );
    return new AgentQApp(paths, new AgentQStore(paths.databasePath));
  }

  close(): void {
    this.store.close();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A UI subscriber cannot be allowed to break scheduler state transitions.
      }
    }
  }

  get repositoryContext(): RepositoryContext | undefined {
    return this.scope;
  }

  get allRepositories(): boolean {
    return this.showAllRepositories || !this.scope;
  }

  get activeRepositoryKey(): string | undefined {
    return this.allRepositories ? undefined : this.scope?.repoKey;
  }

  async setRepositoryScope(scope?: RepositoryContext): Promise<void> {
    this.scope = scope;
    this.showAllRepositories = !scope;
    if (scope) await this.adoptLegacyRepositoryKeys();
    this.notify();
  }

  uiContext(): UiContext {
    const all = this.allRepositories;
    return {
      label: all ? "all repositories" : `${this.scope?.displayName} · ${this.scope?.rootPath}`,
      ...(this.scope ? { repositoryPath: this.scope.rootPath } : {}),
      all,
      canToggle: Boolean(this.scope),
    };
  }

  setAllRepositories(all: boolean): void {
    if (!all && !this.scope) {
      throw new AgentQError(
        "Cannot switch to repository-only queues outside a Git repository",
        "REPOSITORY_SCOPE_UNAVAILABLE",
        2,
      );
    }
    this.showAllRepositories = all;
    this.notify();
  }

  async createQueue(
    input: Omit<CreateQueueInput, "repoKey"> & { repoKey?: string },
  ): Promise<Queue> {
    const repository = await resolveRepositoryContext(input.repoPath);
    await this.adoptLegacyRepositoryKeys();
    const repoPath = repository.rootPath;
    let baseRef = input.baseRef;
    if (!baseRef) {
      const branch = await runGit(repoPath, ["symbolic-ref", "--quiet", "--short", "HEAD"], {
        allowFailure: true,
      });
      baseRef = branch.stdout.trim() || "HEAD";
    }
    const landStrategy = input.landStrategy ?? "none";
    const autoLand = input.autoLand ?? false;
    if (autoLand && landStrategy === "none") {
      throw new AgentQError(
        "Auto-land requires --land-strategy stack or merge-train",
        "INVALID_LAND_CONFIGURATION",
        2,
      );
    }
    if (landStrategy !== "none") {
      baseRef = await canonicalLocalBranchRef(repoPath, baseRef);
    }
    await runGit(repoPath, ["rev-parse", "--verify", `${baseRef}^{commit}`]);
    const queue = this.store.createQueue({
      ...input,
      repoPath,
      repoKey: repository.repoKey,
      baseRef,
    });
    this.notify();
    return queue;
  }

  async listQueues(options: { all?: boolean } = {}): Promise<Queue[]> {
    return this.store.listQueues(options.all ? undefined : this.activeRepositoryKey);
  }

  async getQueue(idOrName: string, options: { all?: boolean } = {}): Promise<Queue> {
    const queue = this.store.getQueue(idOrName, options.all ? undefined : this.activeRepositoryKey);
    if (!queue) throw new AgentQError(`Queue not found: ${idOrName}`, "QUEUE_NOT_FOUND");
    return queue;
  }

  async updateQueue(idOrName: string, patch: UiQueuePatch): Promise<Queue> {
    const queue = await this.getQueue(idOrName);
    const landStrategy = patch.landStrategy ?? queue.landStrategy;
    const autoLand = patch.autoLand ?? queue.autoLand;
    if (autoLand && landStrategy === "none") {
      throw new AgentQError(
        "Auto-land requires a stack or merge-train land strategy",
        "INVALID_LAND_CONFIGURATION",
        2,
      );
    }
    let baseRef = patch.baseRef ?? queue.baseRef;
    if (landStrategy !== "none") {
      baseRef = await canonicalLocalBranchRef(queue.repoPath, baseRef);
    }
    if (patch.baseRef !== undefined || baseRef !== queue.baseRef) {
      await runGit(queue.repoPath, ["rev-parse", "--verify", `${baseRef}^{commit}`]);
    }
    const updated = this.store.updateQueue(queue.id, {
      ...patch,
      ...(baseRef === queue.baseRef ? {} : { baseRef }),
    });
    this.notify();
    return updated;
  }

  async deleteQueue(idOrName: string): Promise<void> {
    const queue = await this.getQueue(idOrName);
    const removed = this.store.deleteQueueCascade(queue.id);
    if (!removed) {
      throw new AgentQError(`Queue not found: ${idOrName}`, "QUEUE_NOT_FOUND");
    }
    this.notify();
    await this.removeTaskLogs(removed.taskIds);
  }

  async addTask(
    input: AddTaskInput,
    options: { maxChildrenForParent?: number } = {},
  ): Promise<Task> {
    const parentTaskId = input.parentTaskId ?? process.env.AGENTQ_TASK_ID;
    const sourceKind = input.sourceKind ?? (parentTaskId ? "agent" : "manual");
    const queue = input.queue || process.env.AGENTQ_QUEUE;
    if (!queue) throw new AgentQError("A queue is required", "QUEUE_REQUIRED");
    const resolvedQueue = await this.getQueue(queue);
    if ((input.landStrategy ?? resolvedQueue.landStrategy) !== "none") {
      await canonicalLocalBranchRef(resolvedQueue.repoPath, resolvedQueue.baseRef);
    }
    const createdBaseSha = await this.worktrees.resolveBase(
      resolvedQueue,
      input.createdBaseSha ?? resolvedQueue.baseRef,
    );

    const task = this.store.addTask(
      {
        ...input,
        queue: resolvedQueue.id,
        parentTaskId,
        sourceKind,
        createdBaseSha,
      },
      options,
    );
    this.notify();
    return task;
  }

  async getTask(id: string): Promise<Task> {
    const task = this.store.getTask(id);
    if (!task) throw new AgentQError(`Task not found: ${id}`, "TASK_NOT_FOUND");
    return task;
  }

  async listTasks(queueId?: string, options: { all?: boolean } = {}): Promise<Task[]> {
    const repoKey = options.all ? undefined : this.activeRepositoryKey;
    const queue = queueId
      ? await this.getQueue(queueId, options.all ? { all: true } : {})
      : undefined;
    return this.store.listTasks({
      ...(queue ? { queue: queue.id } : {}),
      ...(repoKey ? { repoKey } : {}),
    });
  }

  async editTask(taskId: string, patch: EditTaskInput, expectedUpdatedAt?: string): Promise<Task> {
    const task = this.store.editTask(taskId, patch, expectedUpdatedAt);
    this.notify();
    return task;
  }

  async deleteTask(taskId: string): Promise<void> {
    if (!this.store.deleteTask(taskId)) {
      throw new AgentQError(`Task not found: ${taskId}`, "TASK_NOT_FOUND");
    }
    this.notify();
    await this.removeTaskLogs([taskId]);
  }

  private async removeTaskLogs(taskIds: readonly string[]): Promise<void> {
    const logPaths = taskIds.map((taskId) => join(this.paths.logsDir, taskId));
    const results = await Promise.allSettled(
      logPaths.map((path) =>
        rm(path, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 50,
        }),
      ),
    );
    const failedPaths = results.flatMap((result, index) =>
      result.status === "rejected" && logPaths[index] ? [logPaths[index]] : [],
    );
    if (failedPaths.length > 0) {
      const displayed = failedPaths.slice(0, 3).join(", ");
      const remainder = failedPaths.length > 3 ? ` and ${failedPaths.length - 3} more` : "";
      throw new AgentQError(
        `The task or queue was deleted, but agentq could not remove local logs at ${displayed}${remainder}. Remove those paths manually.`,
        "LOG_CLEANUP_FAILED",
      );
    }
  }

  async listEvents(
    taskId: string,
    options?: { afterId?: number; limit?: number },
  ): Promise<TaskEvent[]> {
    return this.store.listEvents({ taskId, afterId: options?.afterId, limit: options?.limit });
  }

  async listRuns(taskId: string): Promise<Run[]> {
    await this.getTask(taskId);
    return this.store.listRuns({ taskId });
  }

  async listTaskApprovals(taskId: string): Promise<TaskApproval[]> {
    await this.getTask(taskId);
    return this.store.listTaskApprovals(taskId);
  }

  async approveTaskCheckpoint(
    taskId: string,
    checkpoint: string,
    input: { actor?: string; note?: string } = {},
  ): Promise<TaskApproval> {
    await this.getTask(taskId);
    const approval = this.store.approveTaskCheckpoint(taskId, checkpoint, input);
    this.notify();
    return approval;
  }

  async rejectTaskCheckpoint(
    taskId: string,
    checkpoint: string,
    input: { actor?: string; note?: string } = {},
  ): Promise<TaskApproval> {
    await this.getTask(taskId);
    const approval = this.store.rejectTaskCheckpoint(taskId, checkpoint, input);
    this.notify();
    return approval;
  }

  async integrateTask(taskId: string, signal?: AbortSignal): Promise<TaskIntegrationOutcome> {
    const task = await this.getTask(taskId);
    const queue = this.store.getQueue(task.queueId);
    if (!queue) {
      throw new AgentQError(`Queue not found: ${task.queueId}`, "QUEUE_NOT_FOUND");
    }
    if (
      task.status !== "succeeded" ||
      !task.resultRunId ||
      !task.resultCommitSha ||
      !["ready_to_integrate", "integrated", "landed"].includes(task.deliveryStatus)
    ) {
      throw new AgentQError(
        `Task ${task.id} does not have a verified immutable result`,
        "TASK_RESULT_NOT_VERIFIED",
      );
    }

    const run = this.store.getRun(task.resultRunId);
    if (
      !run?.baseSha ||
      run.resultCommitSha !== task.resultCommitSha ||
      run.verificationResults.some((result) => result.status !== "passed")
    ) {
      throw new AgentQError(
        `Task ${task.id} result evidence is incomplete`,
        "TASK_RESULT_NOT_VERIFIED",
      );
    }
    const artifact = this.store.recordTaskArtifact({
      runId: run.id,
      baseSha: run.baseSha,
      resultSha: task.resultCommitSha,
      resultRef: `refs/agentq/results/${task.id}/${run.id}`,
    });
    const laneKey = await deliveryLaneKey(queue);
    const existingLane = this.store.getIntegrationLaneForTarget(queue.repoKey, laneKey.targetRef);
    if (
      (task.deliveryStatus === "integrated" || task.deliveryStatus === "landed") &&
      task.integratedSha &&
      existingLane
    ) {
      return {
        status: "already-integrated",
        laneId: existingLane.id,
        artifactId: artifact.id,
        integratedSha: task.integratedSha,
      };
    }

    this.requireDeliveryApprovals(task, queue, "integrate");
    let outcome: IntegrationOutcome;
    try {
      outcome = await this.delivery.integrate({
        lane: laneKey,
        artifact: {
          id: artifact.id,
          taskId: artifact.taskId,
          runId: artifact.runId,
          resultRef: artifact.resultRef,
          resultSha: artifact.resultSha,
        },
        scopePolicy: resolveEffectiveScopePolicy(queue, task),
        verificationCommands: [...queue.verifyCommands, ...task.verifyCommands],
        signal,
      });
    } catch (error) {
      this.recordAutomaticDeliveryError(task, error, "integrate");
      this.notify();
      throw error;
    }
    this.store.appendEvent({
      taskId: task.id,
      runId: run.id,
      kind: `task.integration_${outcome.status.replaceAll("-", "_")}`,
      payload: { ...outcome },
    });
    this.notify();
    return outcome;
  }

  async landQueue(queueIdOrName: string, signal?: AbortSignal): Promise<QueueLandingOutcome> {
    const queue = await this.getQueue(queueIdOrName);
    const laneKey = await deliveryLaneKey(queue);
    const lane = this.store.getIntegrationLaneForTarget(queue.repoKey, laneKey.targetRef);
    if (!lane) {
      throw new AgentQError(
        `Queue ${queue.name} has no verified integration train to land`,
        "QUEUE_NOT_READY_TO_LAND",
      );
    }

    const tasks = this.store.listTasks({ queue: queue.id });
    const integratedTasks = tasks.filter((task) => task.deliveryStatus === "integrated");
    if (integratedTasks.length === 0 && lane.headSha === lane.targetBaseSha) {
      return {
        status: "already-landed",
        laneId: lane.id,
        landedSha: lane.targetBaseSha,
        artifactIds: tasks
          .filter((task) => task.deliveryStatus === "landed")
          .flatMap((task) => this.store.listTaskArtifacts(task.id).map((artifact) => artifact.id)),
      };
    }
    if (integratedTasks.length === 0) {
      throw new AgentQError(
        `Queue ${queue.name} has no integrated task results ready to land`,
        "QUEUE_NOT_READY_TO_LAND",
      );
    }

    const pending = integratedTasks.flatMap((task) =>
      this.requestMissingDeliveryApprovals(task, queue, "land").map(
        (checkpoint) => `${task.id}:${checkpoint}`,
      ),
    );
    if (pending.length > 0) {
      this.notify();
      throw new AgentQError(
        `Landing is waiting for approval: ${pending.join(", ")}`,
        "TASK_APPROVAL_REQUIRED",
      );
    }

    let outcome: LandingOutcome;
    try {
      outcome = await this.delivery.land({ lane: laneKey, signal });
    } catch (error) {
      for (const task of integratedTasks) {
        this.recordAutomaticDeliveryError(task, error, "land");
      }
      this.notify();
      throw error;
    }
    const artifactTasks = new Map(
      this.store
        .listTasks({ queue: queue.id })
        .flatMap((task) =>
          this.store.listTaskArtifacts(task.id).map((artifact) => [artifact.id, task]),
        ),
    );
    for (const artifactId of outcome.artifactIds) {
      const task = artifactTasks.get(artifactId);
      if (!task) continue;
      this.store.appendEvent({
        taskId: task.id,
        runId: task.resultRunId,
        kind: "task.landed",
        payload: {
          laneId: outcome.laneId,
          landedSha: outcome.landedSha,
          targetRef: laneKey.targetRef,
        },
      });
    }
    this.notify();
    return outcome;
  }

  async getQueueDelivery(queueIdOrName: string): Promise<QueueDeliverySnapshot> {
    const queue = await this.getQueue(queueIdOrName);
    const tasks = this.store.listTasks({ queue: queue.id });
    const artifacts = tasks.flatMap((task) => this.store.listTaskArtifacts(task.id));
    const lane = this.store.getIntegrationLaneForTarget(queue.repoKey, queue.baseRef);
    return {
      queue,
      ...(lane ? { lane } : {}),
      tasks,
      artifacts,
      operations: lane ? this.store.listDeliveryOperations({ laneId: lane.id }) : [],
    };
  }

  async processReadyDeliveries(
    options: { queue?: string; repoKey?: string; signal?: AbortSignal } = {},
  ): Promise<boolean> {
    const selectedQueue = options.queue
      ? this.store.getQueue(options.queue, options.repoKey)
      : undefined;
    const queues = selectedQueue ? [selectedQueue] : this.store.listQueues(options.repoKey);
    let processed = false;

    for (const queue of queues) {
      options.signal?.throwIfAborted();
      const tasks = this.store.listTasks({ queue: queue.id });
      const ready = tasks.filter(
        (task) =>
          task.status === "succeeded" &&
          task.deliveryStatus === "ready_to_integrate" &&
          task.landStrategy !== "none" &&
          task.currentPhase !== "approval" &&
          task.retryDisposition !== "wait" &&
          task.retryDisposition !== "manual_resolution" &&
          task.retryDisposition !== "stop" &&
          this.deliveryRetryReady(task.id),
      );
      for (const task of ready) {
        processed = true;
        try {
          const outcome = await this.integrateTask(task.id, options.signal);
          if (outcome.status === "contended") this.deferDeliveryRetry(task.id);
          else this.clearDeliveryRetry(task.id);
        } catch (error) {
          if (error instanceof AgentQError && error.code === "TASK_APPROVAL_REQUIRED") continue;
          this.recordAutomaticDeliveryError(task, error);
        }
      }

      const integrated = this.store
        .listTasks({ queue: queue.id })
        .filter((task) => task.deliveryStatus === "integrated");
      if (
        queue.autoLand &&
        integrated.length > 0 &&
        integrated.every(
          (task) =>
            task.currentPhase !== "approval" &&
            task.retryDisposition !== "wait" &&
            task.retryDisposition !== "manual_resolution" &&
            task.retryDisposition !== "stop",
        ) &&
        this.deliveryRetryReady(`land:${queue.id}`)
      ) {
        processed = true;
        try {
          await this.landQueue(queue.id, options.signal);
          this.clearDeliveryRetry(`land:${queue.id}`);
        } catch (error) {
          if (error instanceof AgentQError && error.code === "TASK_APPROVAL_REQUIRED") continue;
          this.deferDeliveryRetry(`land:${queue.id}`);
          for (const task of this.store
            .listTasks({ queue: queue.id })
            .filter((candidate) => candidate.deliveryStatus === "integrated")) {
            this.store.appendEvent({
              taskId: task.id,
              runId: task.resultRunId,
              kind: "task.landing_error",
              payload: { message: errorMessage(error) },
            });
          }
        }
      }
    }
    if (processed) this.notify();
    return processed;
  }

  async cancelTask(taskId: string): Promise<void> {
    const task = await this.getTask(taskId);
    if (!canCancelTask(task.status)) {
      throw new AgentQError(
        `Cannot cancel task ${taskId} because it is already ${task.status}`,
        "TASK_NOT_CANCELLABLE",
      );
    }
    this.store.requestCancellation(taskId);
    this.notify();
  }

  async retryTask(taskId: string): Promise<void> {
    const task = await this.getTask(taskId);
    if (!canRetryTask(task.status)) {
      throw new AgentQError(
        `Cannot retry task ${taskId} while it is ${task.status}`,
        "TASK_NOT_RETRYABLE",
      );
    }
    this.store.requeueTask(taskId);
    this.notify();
  }

  async resumeTask(taskId: string): Promise<void> {
    const initialTask = await this.getTask(taskId);
    const queue = this.store.getQueue(initialTask.queueId);
    if (!queue) {
      throw new AgentQError(`Queue not found: ${initialTask.queueId}`, "QUEUE_NOT_FOUND");
    }

    await this.worktrees.withRepositoryLock(queue.repoPath, async () => {
      const task = await this.getTask(taskId);
      // Resume is deliberately pinned to the newest attempt. Falling back to
      // an older session can discard a newer durable planner handoff.
      const previous = this.store.listRuns({ taskId, limit: 1 })[0];
      const resumableStage =
        previous?.phase === "plan" ? previous.planSessionId : previous?.planOutput;
      if (
        !previous ||
        previous.provider !== task.provider ||
        !resumableStage ||
        !previous.worktreePath ||
        !previous.branchName ||
        !previous.baseSha
      ) {
        throw new AgentQError(
          "The latest attempt has no resumable stage and retained worktree",
          "RUN_NOT_RESUMABLE",
        );
      }
      try {
        await access(previous.worktreePath);
      } catch {
        throw new AgentQError(
          `The retained worktree no longer exists: ${previous.worktreePath}`,
          "WORKTREE_NOT_FOUND",
        );
      }
      this.store.requeueTask(taskId, undefined, previous.id);
      this.store.appendEvent({
        taskId,
        kind: "task.resume_requested",
        payload: { previousRunId: previous.id },
      });
    });
    this.notify();
  }

  async completeManualTask(taskId: string, summary = "Completed manually"): Promise<void> {
    this.store.completeTaskManually(taskId, summary);
    this.notify();
  }

  async cleanTask(
    taskId: string,
    options: { force?: boolean } = {},
  ): Promise<{ taskId: string; removedWorktree: string }> {
    const initialTask = await this.getTask(taskId);
    const queue = this.store.getQueue(initialTask.queueId);
    if (!queue) {
      throw new AgentQError(`Queue not found: ${initialTask.queueId}`, "QUEUE_NOT_FOUND");
    }
    const force = options.force ?? false;
    const result = await this.worktrees.withRepositoryLock(
      queue.repoPath,
      async ({ removeWorktree }) => {
        const task = await this.getTask(taskId);
        if (!isTaskTerminal(task.status)) {
          throw new AgentQError(
            `Cannot clean task ${taskId} while it is ${task.status}; cancel queued work first`,
            "TASK_ACTIVE",
          );
        }
        const run = this.store.listRuns({ taskId }).find((candidate) => candidate.worktreePath);
        if (!run?.worktreePath) {
          throw new AgentQError(`Task ${taskId} has no retained worktree`, "WORKTREE_NOT_FOUND");
        }
        await removeWorktree(run.worktreePath, force);
        this.store.recordWorktreeRemoval(run.id, run.worktreePath, force);
        return { taskId, removedWorktree: run.worktreePath };
      },
    );
    this.notify();
    return result;
  }

  async loginProvider(provider: Provider): Promise<void> {
    const executor = createExecutorMap().get(provider);
    if (!executor) {
      throw new AgentQError(`Unsupported provider: ${provider}`, "PROVIDER_UNSUPPORTED", 2);
    }
    const health = await executor.probe();
    if (!health.available || !health.binary) {
      throw new AgentQError(
        `${provider === "codex" ? "Codex" : "Claude Code"} CLI is unavailable: ${health.message}`,
        "PROVIDER_UNAVAILABLE",
        2,
      );
    }

    const providerArgs = provider === "codex" ? ["login"] : ["auth", "login"];
    const invocation = resolveCommandInvocation(health.binary, providerArgs);
    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(invocation.command, invocation.args, {
        env: process.env,
        stdio: "inherit",
        windowsHide: false,
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (signal) {
          reject(
            new AgentQError(
              `${provider} login was interrupted by ${signal}`,
              "PROVIDER_LOGIN_INTERRUPTED",
            ),
          );
          return;
        }
        resolve(code ?? 1);
      });
    });
    if (exitCode !== 0) {
      throw new AgentQError(
        `${provider} login exited with code ${exitCode}`,
        "PROVIDER_LOGIN_FAILED",
        exitCode,
      );
    }
    this.notify();
  }

  async installIntegration(
    target: IntegrationTarget,
    repoPath?: string,
  ): Promise<IntegrationResult[]> {
    const requestedPath = repoPath ?? this.scope?.rootPath;
    if (!requestedPath) {
      throw new AgentQError(
        "A Git repository path is required outside a repository",
        "REPOSITORY_REQUIRED",
        2,
      );
    }
    const repository = await resolveRepositoryContext(requestedPath);
    return writeIntegration(repository.rootPath, target);
  }

  async doctor(): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];
    const git = await runCommand("git", ["--version"]).catch((error) => ({
      exitCode: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    }));
    checks.push({
      name: "Git",
      ok: git.exitCode === 0,
      detail: git.exitCode === 0 ? git.stdout.trim() : git.stderr.trim(),
      remediation: git.exitCode === 0 ? undefined : "Install Git and ensure it is on PATH.",
    });

    const executors = createExecutorMap();
    const providerChecks = await Promise.all(
      [...executors.values()].map((executor) => executor.probe()),
    );
    for (const health of providerChecks) {
      checks.push(providerHealthCheck(health));
      if (health.available && health.binary) {
        try {
          checks.push(await providerAuthCheck(health));
        } catch (error) {
          checks.push({
            name: `${health.provider === "codex" ? "Codex" : "Claude"} authentication`,
            ok: false,
            detail: errorMessage(error),
            remediation: `Run: agentq provider login ${health.provider}`,
          });
        }
      }
    }
    checks.push({
      name: "State database",
      ok: true,
      detail: this.paths.databasePath,
    });
    checks.push({
      name: "Parallel isolation",
      ok: git.exitCode === 0,
      detail: "Each attempt uses a dedicated Git branch and worktree.",
    });
    return checks;
  }

  private requireDeliveryApprovals(task: Task, queue: Queue, boundary: "integrate" | "land"): void {
    const pending = this.requestMissingDeliveryApprovals(task, queue, boundary);
    if (pending.length === 0) return;
    this.notify();
    throw new AgentQError(
      `Task ${task.id} is waiting for approval: ${pending.join(", ")}`,
      "TASK_APPROVAL_REQUIRED",
    );
  }

  private requestMissingDeliveryApprovals(
    task: Task,
    queue: Queue,
    boundary: "integrate" | "land",
  ): string[] {
    const checkpoints = [
      ...new Set([...queue.approvalCheckpoints, ...task.approvalCheckpoints]),
    ].filter((checkpoint) => deliveryApprovalBoundary(checkpoint) === boundary);
    const pending: string[] = [];
    for (const checkpoint of checkpoints) {
      const existing = this.store.getTaskApproval(task.id, checkpoint);
      if (existing?.status === "rejected") {
        throw new AgentQError(
          `Approval checkpoint ${checkpoint} was rejected for task ${task.id}`,
          "APPROVAL_REJECTED",
        );
      }
      if (existing?.status === "approved") continue;
      pending.push(checkpoint);
      if (existing) continue;
      this.store.requestTaskApproval({
        taskId: task.id,
        checkpoint,
        ...(task.resultRunId ? { runId: task.resultRunId } : {}),
      });
      this.store.appendEvent({
        taskId: task.id,
        runId: task.resultRunId,
        kind: "task.approval_requested",
        payload: { checkpoint, boundary },
      });
    }
    return pending;
  }

  private deliveryRetryReady(key: string): boolean {
    return (this.deliveryRetryAt.get(key) ?? 0) <= Date.now();
  }

  private deferDeliveryRetry(key: string): void {
    const attempt = Math.min(8, (this.deliveryRetryCount.get(key) ?? 0) + 1);
    this.deliveryRetryCount.set(key, attempt);
    this.deliveryRetryAt.set(key, Date.now() + Math.min(30_000, 250 * 2 ** (attempt - 1)));
  }

  private clearDeliveryRetry(key: string): void {
    this.deliveryRetryAt.delete(key);
    this.deliveryRetryCount.delete(key);
  }

  private recordAutomaticDeliveryError(
    task: Task,
    error: unknown,
    phase: "integrate" | "land" = "integrate",
  ): void {
    const message = errorMessage(error);
    const code = error instanceof AgentQError ? error.code : undefined;
    const manual = new Set([
      "DELIVERY_TARGET_DRIFT",
      "DELIVERY_LANE_DIVERGED",
      "DELIVERY_LANE_MISMATCH",
      "DELIVERY_LANDING_PERSISTENCE_DIVERGED",
      "LAND_TARGET_DIRTY",
      "LAND_TARGET_DIVERGED",
      "INVALID_LAND_TARGET",
    ]).has(code ?? "");
    const latest = this.store.getTask(task.id);
    const failureClass = manual
      ? code === "DELIVERY_TARGET_DRIFT" || code === "DELIVERY_LANE_DIVERGED"
        ? "stale_base"
        : "file_conflict"
      : "transient_infrastructure";
    const retryDisposition = manual ? "manual_resolution" : "retry";
    if (
      latest?.currentPhase === phase &&
      latest.failureClass === failureClass &&
      latest.failureReason === message &&
      latest.retryDisposition === retryDisposition
    ) {
      if (manual) this.clearDeliveryRetry(task.id);
      else this.deferDeliveryRetry(task.id);
      return;
    }
    this.store.updateTask(task.id, {
      currentPhase: phase,
      failureClass,
      failureReason: message,
      retryDisposition,
    });
    this.store.appendEvent({
      taskId: task.id,
      runId: task.resultRunId,
      kind: `task.${phase}_error`,
      payload: { message, code },
    });
    if (manual) this.clearDeliveryRetry(task.id);
    else this.deferDeliveryRetry(task.id);
  }

  private async adoptLegacyRepositoryKeys(): Promise<void> {
    const legacyQueues = this.store
      .listQueues()
      .filter((queue) => queue.repoKey === queue.repoPath);
    for (const queue of legacyQueues) {
      const repository = await findRepositoryContext(queue.repoPath);
      if (!repository || repository.repoKey === queue.repoKey) continue;
      this.store.updateQueue(queue.id, { repoKey: repository.repoKey });
    }
  }
}

async function deliveryLaneKey(queue: Queue): Promise<DeliveryLaneKey> {
  return {
    repoKey: queue.repoKey,
    repoPath: queue.repoPath,
    targetRef: await canonicalLocalBranchRef(queue.repoPath, queue.baseRef),
    trainRef: `refs/heads/agentq/train/${queue.id}`,
  };
}

function deliveryApprovalBoundary(checkpoint: string): "implement" | "integrate" | "land" {
  const normalized = checkpoint
    .trim()
    .toLowerCase()
    .replaceAll(/[\s_]+/g, "-");
  if (["before-land", "land", "after-integrate"].includes(normalized)) return "land";
  if (["before-integrate", "integrate", "after-verify"].includes(normalized)) {
    return "integrate";
  }
  return "implement";
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(path, 0o700);
}

async function canonicalLocalBranchRef(repoPath: string, ref: string): Promise<string> {
  const resolved = await runGit(repoPath, ["rev-parse", "--symbolic-full-name", "--verify", ref], {
    allowFailure: true,
  });
  const fullRef = resolved.stdout.trim();
  if (resolved.exitCode !== 0 || !fullRef.startsWith("refs/heads/") || fullRef.includes("\n")) {
    throw new AgentQError(
      `Landing requires a local branch target; ${ref} is not a local branch`,
      "INVALID_LAND_TARGET",
      2,
    );
  }
  return fullRef;
}

async function providerAuthCheck(health: ProviderHealth): Promise<DoctorCheck> {
  if (!health.binary) {
    return {
      name: `${health.provider} authentication`,
      ok: false,
      detail: "Provider binary is missing",
    };
  }
  if (health.provider === "codex") {
    const result = await runCommand(health.binary, ["login", "status"]);
    const detail = `${result.stdout}\n${result.stderr}`.trim();
    const ok = result.exitCode === 0 && /logged in/i.test(detail);
    return {
      name: "Codex authentication",
      ok,
      detail: detail || "Not authenticated",
      remediation: ok ? undefined : "Run: agentq provider login codex",
    };
  }

  const result = await runCommand(health.binary, ["auth", "status", "--json"]);
  let loggedIn = false;
  try {
    loggedIn = Boolean((JSON.parse(result.stdout) as { loggedIn?: boolean }).loggedIn);
  } catch {
    loggedIn = false;
  }
  return {
    name: "Claude authentication",
    ok: result.exitCode === 0 && loggedIn,
    detail: loggedIn ? "Authenticated" : result.stderr.trim() || "Not authenticated",
    remediation: loggedIn ? undefined : "Run: agentq provider login claude",
  };
}

function providerHealthCheck(health: ProviderHealth): DoctorCheck {
  const label = health.provider === "codex" ? "Codex CLI" : "Claude Code CLI";
  return {
    name: label,
    ok: health.available,
    detail: health.version ? `${health.version} (${health.binary})` : health.message,
    remediation: health.available
      ? undefined
      : health.provider === "codex"
        ? "Reinstall agentq or set AGENTQ_CODEX_BIN to a working Codex executable."
        : "Reinstall agentq or set AGENTQ_CLAUDE_BIN to a working Claude executable.",
  };
}
