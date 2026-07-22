import { spawn } from "node:child_process";
import { access, chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AgentQError, errorMessage } from "./core/errors.ts";
import { resolvePaths } from "./core/paths.ts";
import {
  type AddTaskInput,
  type AgentQPaths,
  type CreateQueueInput,
  canCancelTask,
  canRetryTask,
  isTaskTerminal,
  type Provider,
  type ProviderHealth,
  type Queue,
  type Run,
  type Task,
  type TaskEvent,
} from "./core/types.ts";
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

export class AgentQApp implements UiController {
  readonly paths: AgentQPaths;
  readonly store: AgentQStore;
  readonly worktrees: WorktreeManager;
  private readonly listeners = new Set<() => void>();
  private scope?: RepositoryContext;
  private showAllRepositories = false;

  private constructor(paths: AgentQPaths, store: AgentQStore) {
    this.paths = paths;
    this.store = store;
    this.worktrees = new WorktreeManager(paths);
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
    if (patch.baseRef !== undefined) {
      await runGit(queue.repoPath, ["rev-parse", "--verify", `${patch.baseRef}^{commit}`]);
    }
    const updated = this.store.updateQueue(queue.id, patch);
    this.notify();
    return updated;
  }

  async deleteQueue(idOrName: string): Promise<void> {
    const queue = await this.getQueue(idOrName);
    if (!this.store.deleteQueue(queue.id)) {
      throw new AgentQError(`Queue not found: ${idOrName}`, "QUEUE_NOT_FOUND");
    }
    this.notify();
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

    const task = this.store.addTask(
      {
        ...input,
        queue: resolvedQueue.id,
        parentTaskId,
        sourceKind,
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

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(path, 0o700);
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
