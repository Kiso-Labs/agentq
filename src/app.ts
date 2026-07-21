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
  type ProviderHealth,
  type Queue,
  type Task,
  type TaskEvent,
} from "./core/types.ts";
import { createExecutorMap } from "./executors/index.ts";
import { runCommand, runGit } from "./git/command.ts";
import { WorktreeManager } from "./git/worktrees.ts";
import { AgentQStore } from "./store/index.ts";
import type { UiController } from "./ui/types.ts";

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

  async createQueue(input: CreateQueueInput): Promise<Queue> {
    const repoPath = await this.worktrees.resolveRepo(input.repoPath);
    let baseRef = input.baseRef;
    if (!baseRef) {
      const branch = await runGit(repoPath, ["symbolic-ref", "--quiet", "--short", "HEAD"], {
        allowFailure: true,
      });
      baseRef = branch.stdout.trim() || "HEAD";
    }
    await runGit(repoPath, ["rev-parse", "--verify", `${baseRef}^{commit}`]);
    const queue = this.store.createQueue({ ...input, repoPath, baseRef });
    this.notify();
    return queue;
  }

  async listQueues(): Promise<Queue[]> {
    return this.store.listQueues();
  }

  async getQueue(idOrName: string): Promise<Queue> {
    const queue = this.store.getQueue(idOrName);
    if (!queue) throw new AgentQError(`Queue not found: ${idOrName}`, "QUEUE_NOT_FOUND");
    return queue;
  }

  async deleteQueue(idOrName: string): Promise<void> {
    if (!this.store.deleteQueue(idOrName)) {
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

    const task = this.store.addTask(
      {
        ...input,
        queue,
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

  async listTasks(queueId?: string): Promise<Task[]> {
    return this.store.listTasks(queueId ? { queue: queueId } : undefined);
  }

  async listEvents(
    taskId: string,
    options?: { afterId?: number; limit?: number },
  ): Promise<TaskEvent[]> {
    return this.store.listEvents({ taskId, afterId: options?.afterId, limit: options?.limit });
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
    await this.getTask(taskId);
    const previous = this.store
      .listRuns({ taskId })
      .find((run) => run.providerSessionId && run.worktreePath && run.branchName && run.baseSha);
    if (!previous?.providerSessionId || !previous.worktreePath) {
      throw new AgentQError(
        "No resumable provider session and worktree were retained for this task",
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
    this.notify();
  }

  async completeManualTask(taskId: string, summary = "Completed manually"): Promise<void> {
    this.store.completeTaskManually(taskId, summary);
    this.notify();
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
