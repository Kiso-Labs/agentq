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

export const EXECUTION_PHASES = ["plan", "implement"] as const;
export type ExecutionPhase = (typeof EXECUTION_PHASES)[number];

/**
 * Delivery is deliberately orthogonal to `TaskStatus`: task status describes
 * whether an agent process is runnable, while delivery status describes how
 * far its result has progressed toward the repository's target branch.
 */
export const DELIVERY_STATUSES = [
  "not_started",
  "implemented",
  "verified",
  "ready_to_integrate",
  "integrated",
  "landed",
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const CURRENT_PHASES = [
  "queued",
  "blocked",
  "plan",
  "red_test",
  "approval",
  "implement",
  "verify",
  "integrate",
  "land",
  "complete",
] as const;
export type CurrentPhase = (typeof CURRENT_PHASES)[number];

export const FAILURE_CLASSES = [
  "transient_infrastructure",
  "stale_base",
  "test_regression",
  "blocked_dependency",
  "file_conflict",
  "policy_violation",
  "integration_conflict",
  "integration_contention",
  "agent_failure",
  "cancelled",
  "unknown",
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

export const RETRY_DISPOSITIONS = [
  "retry",
  "rebase_and_retry",
  "return_to_implementation",
  "wait",
  "stop",
  "manual_resolution",
] as const;
export type RetryDisposition = (typeof RETRY_DISPOSITIONS)[number];

export const LAND_STRATEGIES = ["none", "stack", "merge-train"] as const;
export type LandStrategy = (typeof LAND_STRATEGIES)[number];

export const BASE_DRIFT_POLICIES = ["rebase", "replan", "fail"] as const;
export type BaseDriftPolicy = (typeof BASE_DRIFT_POLICIES)[number];

export const FILE_CONCURRENCY_MODES = ["off", "advisory", "enforced"] as const;
export type FileConcurrencyMode = (typeof FILE_CONCURRENCY_MODES)[number];

export const VERIFICATION_GATE_KINDS = [
  "command",
  "allowed_paths",
  "denied_paths",
  "max_changed_files",
  "clean_worktree",
] as const;
export type VerificationGateKind = (typeof VERIFICATION_GATE_KINDS)[number];

export const VERIFICATION_STATUSES = ["pending", "passed", "failed", "skipped"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const DELIVERY_OPERATION_KINDS = ["integrate", "land"] as const;
export type DeliveryOperationKind = (typeof DELIVERY_OPERATION_KINDS)[number];

export const DELIVERY_OPERATION_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "conflicted",
  "cancelled",
] as const;
export type DeliveryOperationStatus = (typeof DELIVERY_OPERATION_STATUSES)[number];

export const APPROVAL_STATUSES = ["pending", "approved", "rejected"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export interface VerificationResult {
  kind: VerificationGateKind;
  status: VerificationStatus;
  name?: string;
  command?: string;
  exitCode?: number;
  summary?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
}

/** Immutable evidence from a blocker used to construct a dependent attempt. */
export interface TaskDependencySnapshot {
  taskId: string;
  runId: string;
  resultCommitSha: string;
  deliveryStatus: DeliveryStatus;
  integratedSha?: string;
  landedSha?: string;
}

export interface TaskDependency {
  taskId: string;
  blockerTaskId: string;
  createdAt: string;
}

/**
 * Immutable, durable evidence produced by one successful agent run.
 *
 * A result ref names the canonical commit even after worktree cleanup, while
 * the verification and changed-file snapshots make later integration
 * decisions independent from mutable task rows.
 */
export interface TaskArtifact {
  id: string;
  taskId: string;
  runId: string;
  repoKey: string;
  targetRef: string;
  baseSha: string;
  resultSha: string;
  resultRef: string;
  changedFiles: string[];
  verificationResults: VerificationResult[];
  createdAt: string;
}

export interface RecordTaskArtifactInput {
  runId: string;
  baseSha: string;
  resultSha: string;
  resultRef: string;
  changedFiles?: string[];
  verificationResults?: VerificationResult[];
  createdAt?: string;
}

/** A repository/target-scoped, serialized merge-train cursor. */
export interface IntegrationLane {
  id: string;
  repoKey: string;
  repoPath: string;
  targetRef: string;
  trainRef: string;
  targetBaseSha: string;
  headSha: string;
  generation: number;
  createdAt: string;
  updatedAt: string;
}

export interface GetOrCreateIntegrationLaneInput {
  repoKey: string;
  repoPath: string;
  targetRef: string;
  trainRef: string;
  initialHeadSha: string;
  createdAt?: string;
}

export interface AdvanceIntegrationLaneInput {
  expectedHeadSha: string;
  newHeadSha: string;
  updatedAt?: string;
}

/**
 * Persisted integration or landing intent. `fenceToken` increases on every
 * lease acquisition so a stale process can never finish a reclaimed operation.
 */
export interface DeliveryOperation {
  id: string;
  laneId: string;
  taskId?: string;
  artifactId?: string;
  kind: DeliveryOperationKind;
  status: DeliveryOperationStatus;
  ownerToken?: string;
  fenceToken: number;
  expectedHeadSha?: string;
  candidateSha?: string;
  conflictFiles: string[];
  error?: string;
  createdAt: string;
  startedAt?: string;
  heartbeatAt?: string;
  leaseExpiresAt?: string;
  finishedAt?: string;
}

export interface DeliveryOperationClaim {
  operation: DeliveryOperation;
  leaseToken: string;
  fenceToken: number;
}

export interface CreateDeliveryOperationInput {
  laneId: string;
  kind: DeliveryOperationKind;
  taskId?: string;
  artifactId?: string;
  createdAt?: string;
}

export interface ClaimDeliveryOperationInput {
  ownerToken: string;
  operationId?: string;
  laneId?: string;
  now?: string;
  leaseDurationMs?: number;
}

export interface FinishDeliveryOperationInput {
  status: Extract<DeliveryOperationStatus, "succeeded" | "failed" | "conflicted" | "cancelled">;
  candidateSha?: string;
  conflictFiles?: string[];
  error?: string;
  finishedAt?: string;
}

export interface CompleteIntegrationInput {
  operationId: string;
  leaseToken: string;
  fenceToken: number;
  expectedLaneGeneration: number;
  expectedHeadSha: string;
  newHeadSha: string;
  integrationBranch?: string;
  completedAt?: string;
}

export interface RecordIntegrationFailureInput {
  operationId: string;
  leaseToken: string;
  fenceToken: number;
  status: Extract<DeliveryOperationStatus, "failed" | "conflicted">;
  failureClass: Extract<
    FailureClass,
    "integration_conflict" | "integration_contention" | "policy_violation" | "test_regression"
  >;
  conflictFiles?: string[];
  error: string;
  finishedAt?: string;
}

export interface CompleteLandingInput {
  laneId: string;
  expectedLaneGeneration: number;
  expectedHeadSha: string;
  landedSha: string;
  artifactIds: string[];
  operationId?: string;
  leaseToken?: string;
  fenceToken?: number;
  completedAt?: string;
}

/** Durable human approval state for one named task checkpoint. */
export interface TaskApproval {
  taskId: string;
  checkpoint: string;
  status: ApprovalStatus;
  runId?: string;
  requestedAt: string;
  decidedAt?: string;
  actor?: string;
  note?: string;
}

export interface RequestTaskApprovalInput {
  taskId: string;
  checkpoint: string;
  runId?: string;
  requestedAt?: string;
}

export interface DecideTaskApprovalInput {
  actor?: string;
  note?: string;
  decidedAt?: string;
}

export interface PauseRunForApprovalInput {
  checkpoint: string;
  planOutput?: string;
  planSessionId?: string;
  requestedAt?: string;
}

export interface QueueWorkflowSnapshot {
  planModel: string;
  planInstructions: string;
  implementModel: string;
  implementInstructions: string;
  allowedPaths?: string[];
  deniedPaths?: string[];
  maxChangedFiles?: number;
  verifyCommands?: string[];
  approvalCheckpoints?: string[];
  baseDriftPolicy?: BaseDriftPolicy;
  landStrategy?: LandStrategy;
  autoLand?: boolean;
  fileConcurrency?: FileConcurrencyMode;
}

export interface Queue {
  id: string;
  name: string;
  repoKey: string;
  repoPath: string;
  baseRef: string;
  defaultProvider: Provider;
  planModel: string;
  planInstructions: string;
  implementModel: string;
  implementInstructions: string;
  concurrency: number;
  maxAttempts: number;
  verifyCommands: string[];
  autoCommit: boolean;
  allowedPaths: string[];
  deniedPaths: string[];
  maxChangedFiles?: number;
  approvalCheckpoints: string[];
  baseDriftPolicy: BaseDriftPolicy;
  landStrategy: LandStrategy;
  autoLand: boolean;
  fileConcurrency: FileConcurrencyMode;
  createdAt: string;
  updatedAt: string;
}

export interface TaskSpecSnapshot {
  title: string;
  instructions: string;
  acceptanceCriteria: string[];
  provider: Provider;
  priority: number;
  /** Optional on legacy snapshots created before structured task specs. */
  objective?: string;
  invariants?: string[];
  handoffRequirements?: string[];
  blockedBy?: string[];
  expectedPaths?: string[];
  allowedPaths?: string[];
  deniedPaths?: string[];
  maxChangedFiles?: number;
  verifyCommands?: string[];
  approvalCheckpoints?: string[];
  baseDriftPolicy?: BaseDriftPolicy;
  landStrategy?: LandStrategy;
  createdBaseSha?: string;
  dependencies?: TaskDependencySnapshot[];
  /** Immutable queue workflow captured when this attempt is claimed. */
  workflow?: QueueWorkflowSnapshot;
}

export interface Task {
  id: string;
  queueId: string;
  queueName?: string;
  title: string;
  instructions: string;
  acceptanceCriteria: string[];
  objective: string;
  invariants: string[];
  handoffRequirements: string[];
  blockedBy: string[];
  expectedPaths: string[];
  allowedPaths: string[];
  deniedPaths: string[];
  maxChangedFiles?: number;
  verifyCommands: string[];
  approvalCheckpoints: string[];
  baseDriftPolicy: BaseDriftPolicy;
  landStrategy: LandStrategy;
  createdBaseSha?: string;
  provider: Provider;
  priority: number;
  status: TaskStatus;
  currentPhase: CurrentPhase;
  deliveryStatus: DeliveryStatus;
  blockedReason?: string;
  failureClass?: FailureClass;
  failureReason?: string;
  retryDisposition?: RetryDisposition;
  resultRunId?: string;
  resultCommitSha?: string;
  changedFiles: string[];
  verificationResults: VerificationResult[];
  integrationBranch?: string;
  integrationConflictFiles: string[];
  integratedSha?: string;
  landedSha?: string;
  integratedAt?: string;
  landedAt?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
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
  phase: ExecutionPhase;
  baseSha?: string;
  branchName?: string;
  worktreePath?: string;
  providerSessionId?: string;
  planSessionId?: string;
  planOutput?: string;
  pid?: number;
  processToken?: string;
  processStartMarker?: string;
  processIdentityPath?: string;
  ownerPid?: number;
  taskSnapshot?: TaskSpecSnapshot;
  dependencySnapshot: TaskDependencySnapshot[];
  resultCommitSha?: string;
  changedFiles: string[];
  verificationResults: VerificationResult[];
  failureClass?: FailureClass;
  retryDisposition?: RetryDisposition;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
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
  planModel?: string;
  planInstructions?: string;
  implementModel?: string;
  implementInstructions?: string;
  concurrency?: number;
  maxAttempts?: number;
  verifyCommands?: string[];
  autoCommit?: boolean;
  allowedPaths?: string[];
  deniedPaths?: string[];
  maxChangedFiles?: number;
  approvalCheckpoints?: string[];
  baseDriftPolicy?: BaseDriftPolicy;
  landStrategy?: LandStrategy;
  autoLand?: boolean;
  fileConcurrency?: FileConcurrencyMode;
}

export interface AddTaskInput {
  queue: string;
  title: string;
  instructions?: string;
  acceptanceCriteria?: string[];
  objective?: string;
  invariants?: string[];
  handoffRequirements?: string[];
  blockedBy?: string[];
  expectedPaths?: string[];
  allowedPaths?: string[];
  deniedPaths?: string[];
  maxChangedFiles?: number;
  verifyCommands?: string[];
  approvalCheckpoints?: string[];
  baseDriftPolicy?: BaseDriftPolicy;
  landStrategy?: LandStrategy;
  createdBaseSha?: string;
  provider?: Provider;
  priority?: number;
  idempotencyKey?: string;
  sourceKind?: "manual" | "agent" | "api";
  parentTaskId?: string;
}

export type ExecutorEvent =
  | { type: "session"; sessionId: string }
  | { type: "assistant"; text: string; delta?: boolean }
  | {
      type: "tool";
      toolId?: string;
      name: string;
      state: "started" | "completed" | "failed";
      detail?: string;
      output?: string;
      exitCode?: number;
    }
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
  phase: ExecutionPhase;
  /** Empty means use the provider CLI's configured default model. */
  model?: string;
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
