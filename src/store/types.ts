import type {
  Provider,
  Queue,
  Run,
  RunStatus,
  Task,
  TaskEvent,
  TaskStatus,
} from "../core/types.ts";

export interface StoreOptions {
  busyTimeoutMs?: number;
}

export type UpdateQueueInput = Partial<
  Pick<
    Queue,
    | "name"
    | "repoKey"
    | "repoPath"
    | "baseRef"
    | "defaultProvider"
    | "concurrency"
    | "maxAttempts"
    | "verifyCommands"
    | "autoCommit"
  >
>;

export type EditTaskInput = Partial<
  Pick<Task, "title" | "instructions" | "acceptanceCriteria" | "provider" | "priority">
>;

export interface TaskFilter {
  queue?: string;
  repoKey?: string;
  status?: TaskStatus | readonly TaskStatus[];
  /** Alias used by CLI callers that construct a list of statuses. */
  statuses?: readonly TaskStatus[];
  provider?: Provider;
  sourceKind?: Task["sourceKind"];
  limit?: number;
  offset?: number;
}

export interface UpdateTaskInput {
  title?: string;
  instructions?: string;
  acceptanceCriteria?: string[];
  provider?: Provider;
  priority?: number;
  status?: TaskStatus;
  sourceKind?: Task["sourceKind"];
  parentTaskId?: string | null;
  idempotencyKey?: string | null;
  currentRunId?: string | null;
  cancelRequestedAt?: string | null;
  completedAt?: string | null;
}

export interface ClaimOptions {
  queue?: string;
  repoKey?: string;
  now?: string;
  ownerToken?: string;
  ownerPid?: number;
  /** Database-wide active-run ceiling shared by concurrent supervisors. */
  maxConcurrency?: number;
}

export interface AddTaskOptions {
  /** Atomically reject a new child when its parent already has this many children. */
  maxChildrenForParent?: number;
}

export interface TaskClaim {
  queue: Queue;
  task: Task;
  run: Run;
  leaseToken?: string;
}

export interface RunFilter {
  taskId?: string;
  queue?: string;
  status?: RunStatus | readonly RunStatus[];
  statuses?: readonly RunStatus[];
  limit?: number;
  offset?: number;
}

export interface UpdateRunInput {
  status?: Extract<RunStatus, "starting" | "running" | "cancelling">;
  baseSha?: string | null;
  branchName?: string | null;
  worktreePath?: string | null;
  providerSessionId?: string | null;
  pid?: number | null;
  processToken?: string | null;
  processStartMarker?: string | null;
  processIdentityPath?: string | null;
  summary?: string | null;
  error?: string | null;
  logPath?: string | null;
}

export interface MarkRunRunningInput extends UpdateRunInput {
  at?: string;
}

export type TerminalRunStatus = Extract<
  RunStatus,
  "succeeded" | "failed" | "interrupted" | "cancelled"
>;

export interface FinishRunInput {
  status: TerminalRunStatus;
  exitCode?: number | null;
  summary?: string | null;
  error?: string | null;
  providerSessionId?: string | null;
  finishedAt?: string;
  /** Requeue without consuming retry budget, used for graceful supervisor shutdown. */
  requeue?: boolean;
}

export interface FinishedRun {
  run: Run;
  task: Task;
}

export interface AppendEventInput {
  taskId: string;
  runId?: string;
  kind: string;
  payload?: Record<string, unknown>;
  createdAt?: string;
}

export interface EventFilter {
  taskId: string;
  runId?: string;
  afterId?: number;
  limit?: number;
}

export interface RecoveryResult {
  recovered: number;
  /** Backwards-compatible descriptive alias for `recovered`. */
  recoveredRuns: number;
  runs: Run[];
  tasks: Task[];
}

export interface FenceStaleRunsInput {
  staleBefore: string;
  ownerToken: string;
  at?: string;
  eligibleRunIds?: readonly string[];
}

export interface StoreCounts {
  queues: number;
  tasks: number;
  runs: number;
  events: number;
}

export type { Queue, Run, Task, TaskEvent };
