export const PROVIDERS = ["codex", "claude"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const TASK_STATUSES = [
  "queued",
  "starting",
  "running",
  "cancelling",
  "succeeded",
  "failed",
  "interrupted",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const ACTIVE_TASK_STATUSES = [
  "starting",
  "running",
  "cancelling",
] as const satisfies readonly TaskStatus[];
export const TERMINAL_TASK_STATUSES = [
  "succeeded",
  "failed",
  "interrupted",
  "cancelled",
] as const satisfies readonly TaskStatus[];
export const CANCELLABLE_TASK_STATUSES = [
  "queued",
  "starting",
  "running",
  "cancelling",
] as const satisfies readonly TaskStatus[];
export const RETRYABLE_TASK_STATUSES = [
  "failed",
  "interrupted",
  "cancelled",
] as const satisfies readonly TaskStatus[];
export const MANUALLY_COMPLETABLE_TASK_STATUSES = [
  "queued",
  "failed",
  "interrupted",
  "cancelled",
] as const satisfies readonly TaskStatus[];

const hasTaskStatus = (statuses: readonly TaskStatus[], status: TaskStatus): boolean =>
  statuses.includes(status);

export const isTaskActive = (status: TaskStatus): boolean =>
  hasTaskStatus(ACTIVE_TASK_STATUSES, status);
export const isTaskTerminal = (status: TaskStatus): boolean =>
  hasTaskStatus(TERMINAL_TASK_STATUSES, status);
export const canCancelTask = (status: TaskStatus): boolean =>
  hasTaskStatus(CANCELLABLE_TASK_STATUSES, status);
export const canRetryTask = (status: TaskStatus): boolean =>
  hasTaskStatus(RETRYABLE_TASK_STATUSES, status);
export const canCompleteTaskManually = (status: TaskStatus): boolean =>
  hasTaskStatus(MANUALLY_COMPLETABLE_TASK_STATUSES, status);

export const RUN_STATUSES = [
  "starting",
  "running",
  "cancelling",
  "succeeded",
  "failed",
  "interrupted",
  "cancelled",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export interface Queue {
  id: string;
  name: string;
  repoKey: string;
  repoPath: string;
  baseRef: string;
  defaultProvider: Provider;
  concurrency: number;
  maxAttempts: number;
  verifyCommands: string[];
  autoCommit: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TaskSpecSnapshot {
  title: string;
  instructions: string;
  acceptanceCriteria: string[];
  provider: Provider;
  priority: number;
}

export interface Task {
  id: string;
  queueId: string;
  queueName?: string;
  title: string;
  instructions: string;
  acceptanceCriteria: string[];
  provider: Provider;
  priority: number;
  status: TaskStatus;
  sourceKind: "manual" | "agent" | "api";
  parentTaskId?: string;
  idempotencyKey?: string;
  resumeRunId?: string;
  attemptCount: number;
  currentRunId?: string;
  cancelRequestedAt?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface Run {
  id: string;
  taskId: string;
  attemptNo: number;
  provider: Provider;
  status: RunStatus;
  baseSha?: string;
  branchName?: string;
  worktreePath?: string;
  providerSessionId?: string;
  pid?: number;
  processToken?: string;
  processStartMarker?: string;
  processIdentityPath?: string;
  ownerPid?: number;
  taskSnapshot?: TaskSpecSnapshot;
  startedAt: string;
  heartbeatAt: string;
  finishedAt?: string;
  exitCode?: number;
  summary?: string;
  error?: string;
  logPath?: string;
}

export interface TaskEvent {
  id: number;
  taskId: string;
  runId?: string;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface CreateQueueInput {
  name: string;
  repoKey: string;
  repoPath: string;
  baseRef?: string;
  defaultProvider?: Provider;
  concurrency?: number;
  maxAttempts?: number;
  verifyCommands?: string[];
  autoCommit?: boolean;
}

export interface AddTaskInput {
  queue: string;
  title: string;
  instructions?: string;
  acceptanceCriteria?: string[];
  provider?: Provider;
  priority?: number;
  idempotencyKey?: string;
  sourceKind?: "manual" | "agent" | "api";
  parentTaskId?: string;
}

export type ExecutorEvent =
  | { type: "session"; sessionId: string }
  | { type: "assistant"; text: string; delta?: boolean }
  | { type: "tool"; name: string; state: "started" | "completed" | "failed"; detail?: string }
  | { type: "usage"; inputTokens?: number; outputTokens?: number; costUsd?: number }
  | { type: "diagnostic"; level: "info" | "warning" | "error"; message: string };

export interface ExecutorResult {
  status: "succeeded" | "failed" | "cancelled";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  sessionId?: string;
  summary?: string;
  error?: string;
}

export interface ExecutorRunInput {
  runId: string;
  task: Task;
  queue: Queue;
  cwd: string;
  prompt: string;
  resumeSessionId?: string;
  /** Supervisor-only launch gate used while durable process identity is recorded. */
  deferStart?: boolean;
  signal: AbortSignal;
  env: Record<string, string>;
}

export interface Execution {
  pid: number;
  processIdentity: {
    pid: number;
    token: string;
    startMarker: string;
    path: string;
  };
  events: AsyncIterable<ExecutorEvent>;
  completion: Promise<ExecutorResult>;
  /** Release the gated provider only after its durable run identity is stored. */
  release(): Promise<void>;
  cancel(reason?: string): Promise<void>;
}

export interface ProviderHealth {
  provider: Provider;
  available: boolean;
  binary?: string;
  version?: string;
  message: string;
}

export interface AgentExecutor {
  readonly provider: Provider;
  probe(): Promise<ProviderHealth>;
  start(input: ExecutorRunInput): Promise<Execution>;
}

export interface AgentQPaths {
  stateDir: string;
  databasePath: string;
  logsDir: string;
  worktreesDir: string;
  locksDir: string;
}
