import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { AgentQError, errorMessage } from "../core/errors.ts";
import { isoNow, makeId } from "../core/paths.ts";
import { normalizeScopePattern, scopePatternSetsMayOverlap } from "../core/scope-policy.ts";
import {
  type AddTaskInput,
  type AdvanceIntegrationLaneInput,
  APPROVAL_STATUSES,
  BASE_DRIFT_POLICIES,
  type ClaimDeliveryOperationInput,
  type CompleteIntegrationInput,
  type CompleteLandingInput,
  type CreateDeliveryOperationInput,
  type CreateQueueInput,
  CURRENT_PHASES,
  canCompleteTaskManually,
  canRetryTask,
  DELIVERY_OPERATION_KINDS,
  DELIVERY_OPERATION_STATUSES,
  DELIVERY_STATUSES,
  type DecideTaskApprovalInput,
  type DeliveryOperation,
  type DeliveryOperationClaim,
  EXECUTION_PHASES,
  FAILURE_CLASSES,
  type FailureClass,
  FILE_CONCURRENCY_MODES,
  type FinishDeliveryOperationInput,
  type GetOrCreateIntegrationLaneInput,
  type IntegrationLane,
  isTaskActive,
  LAND_STRATEGIES,
  type PauseRunForApprovalInput,
  PROVIDERS,
  type Queue,
  type QueueWorkflowSnapshot,
  RETRY_DISPOSITIONS,
  type RecordIntegrationFailureInput,
  type RecordTaskArtifactInput,
  type RequestTaskApprovalInput,
  type RetryDisposition,
  RUN_STATUSES,
  type Run,
  type RunStatus,
  TASK_STATUSES,
  type Task,
  type TaskApproval,
  type TaskArtifact,
  type TaskDependencySnapshot,
  type TaskEvent,
  type TaskSpecSnapshot,
  type TaskStatus,
  VERIFICATION_GATE_KINDS,
  VERIFICATION_STATUSES,
  type VerificationResult,
} from "../core/types.ts";
import { migrate } from "./migrations.ts";
import { selectAll, selectOne } from "./sqlite.ts";
import type {
  AddTaskOptions,
  AdvanceRunToImplementationInput,
  AppendEventInput,
  ClaimOptions,
  EditTaskInput,
  EventFilter,
  FenceStaleRunsInput,
  FinishedRun,
  FinishRunInput,
  MarkRunRunningInput,
  RecoveryResult,
  RunFilter,
  StoreCounts,
  StoreOptions,
  TaskClaim,
  TaskFilter,
  UpdateQueueInput,
  UpdateRunInput,
  UpdateTaskInput,
} from "./types.ts";

type Binding = string | number | null;

const ACTIVE_RUN_STATUSES = ["starting", "running", "cancelling"] as const;
const TERMINAL_TASK_STATUSES = ["succeeded", "failed", "interrupted", "cancelled"] as const;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const DEFAULT_LIST_LIMIT = 1_000;
const MAX_LIST_LIMIT = 10_000;
const MAX_PLAN_OUTPUT_LENGTH = 262_144;

function retryDispositionFor(failureClass: FailureClass): RetryDisposition {
  switch (failureClass) {
    case "transient_infrastructure":
    case "agent_failure":
    case "unknown":
    case "integration_contention":
      return "retry";
    case "stale_base":
      return "rebase_and_retry";
    case "test_regression":
      return "return_to_implementation";
    case "blocked_dependency":
      return "wait";
    case "file_conflict":
    case "integration_conflict":
      return "manual_resolution";
    case "policy_violation":
    case "cancelled":
      return "stop";
  }
}

function spendsAttempt(failureClass: FailureClass): boolean {
  return ![
    "transient_infrastructure",
    "stale_base",
    "blocked_dependency",
    "integration_conflict",
    "integration_contention",
  ].includes(failureClass);
}

interface QueueRow {
  id: unknown;
  name: unknown;
  repo_key: unknown;
  repo_path: unknown;
  base_ref: unknown;
  default_provider: unknown;
  plan_model: unknown;
  plan_instructions: unknown;
  implement_model: unknown;
  implement_instructions: unknown;
  concurrency: unknown;
  max_attempts: unknown;
  verify_commands: unknown;
  auto_commit: unknown;
  allowed_paths: unknown;
  denied_paths: unknown;
  max_changed_files: unknown;
  approval_checkpoints: unknown;
  base_drift_policy: unknown;
  land_strategy: unknown;
  auto_land: unknown;
  file_concurrency: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface TaskRow {
  id: unknown;
  queue_id: unknown;
  queue_name?: unknown;
  title: unknown;
  instructions: unknown;
  acceptance_criteria: unknown;
  objective: unknown;
  invariants: unknown;
  handoff_requirements: unknown;
  blocked_by: unknown;
  expected_paths: unknown;
  allowed_paths: unknown;
  denied_paths: unknown;
  max_changed_files: unknown;
  verify_commands: unknown;
  approval_checkpoints: unknown;
  base_drift_policy: unknown;
  land_strategy: unknown;
  created_base_sha: unknown;
  provider: unknown;
  priority: unknown;
  status: unknown;
  current_phase: unknown;
  delivery_status: unknown;
  blocked_reason: unknown;
  failure_class: unknown;
  failure_reason: unknown;
  retry_disposition: unknown;
  result_run_id: unknown;
  result_commit_sha: unknown;
  changed_files: unknown;
  verification_results: unknown;
  integration_branch: unknown;
  integration_conflict_files: unknown;
  integrated_sha: unknown;
  landed_sha: unknown;
  integrated_at: unknown;
  landed_at: unknown;
  input_tokens: unknown;
  output_tokens: unknown;
  cost_usd: unknown;
  source_kind: unknown;
  parent_task_id: unknown;
  idempotency_key: unknown;
  resume_run_id: unknown;
  attempt_count: unknown;
  current_run_id: unknown;
  cancel_requested_at: unknown;
  created_at: unknown;
  updated_at: unknown;
  completed_at: unknown;
}

interface RunRow {
  id: unknown;
  task_id: unknown;
  attempt_no: unknown;
  provider: unknown;
  status: unknown;
  phase: unknown;
  base_sha: unknown;
  branch_name: unknown;
  worktree_path: unknown;
  provider_session_id: unknown;
  plan_session_id: unknown;
  plan_output: unknown;
  pid: unknown;
  process_token: unknown;
  process_start_marker: unknown;
  process_identity_path: unknown;
  owner_token: unknown;
  owner_pid: unknown;
  task_snapshot: unknown;
  dependency_snapshot: unknown;
  result_commit_sha: unknown;
  changed_files: unknown;
  verification_results: unknown;
  failure_class: unknown;
  retry_disposition: unknown;
  input_tokens: unknown;
  output_tokens: unknown;
  cost_usd: unknown;
  started_at: unknown;
  heartbeat_at: unknown;
  finished_at: unknown;
  exit_code: unknown;
  summary: unknown;
  error: unknown;
  log_path: unknown;
}

interface EventRow {
  id: unknown;
  task_id: unknown;
  run_id: unknown;
  kind: unknown;
  payload: unknown;
  created_at: unknown;
}

interface TaskArtifactRow {
  id: unknown;
  task_id: unknown;
  run_id: unknown;
  repo_key: unknown;
  target_ref: unknown;
  base_sha: unknown;
  result_sha: unknown;
  result_ref: unknown;
  changed_files: unknown;
  verification_results: unknown;
  created_at: unknown;
}

interface IntegrationLaneRow {
  id: unknown;
  repo_key: unknown;
  repo_path: unknown;
  target_ref: unknown;
  train_ref: unknown;
  target_base_sha: unknown;
  head_sha: unknown;
  generation: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface DeliveryOperationRow {
  id: unknown;
  lane_id: unknown;
  task_id: unknown;
  artifact_id: unknown;
  kind: unknown;
  status: unknown;
  owner_token: unknown;
  fence_token: unknown;
  expected_head_sha: unknown;
  candidate_sha: unknown;
  conflict_files: unknown;
  error: unknown;
  created_at: unknown;
  started_at: unknown;
  heartbeat_at: unknown;
  lease_expires_at: unknown;
  finished_at: unknown;
}

interface TaskApprovalRow {
  task_id: unknown;
  checkpoint: unknown;
  status: unknown;
  run_id: unknown;
  requested_at: unknown;
  decided_at: unknown;
  actor: unknown;
  note: unknown;
}

interface ActiveFileScopeRow {
  task_id: unknown;
  expected_paths: unknown;
  allowed_paths: unknown;
  queue_allowed_paths: unknown;
  file_concurrency: unknown;
}

interface CountRow {
  count: unknown;
}

const QUEUE_COLUMNS = `
  q.id,
  q.name,
  q.repo_key,
  q.repo_path,
  q.base_ref,
  q.default_provider,
  q.plan_model,
  q.plan_instructions,
  q.implement_model,
  q.implement_instructions,
  q.concurrency,
  q.max_attempts,
  q.verify_commands,
  q.auto_commit,
  q.allowed_paths,
  q.denied_paths,
  q.max_changed_files,
  q.approval_checkpoints,
  q.base_drift_policy,
  q.land_strategy,
  q.auto_land,
  q.file_concurrency,
  q.created_at,
  q.updated_at
`;

const TASK_COLUMNS = `
  t.id,
  t.queue_id,
  q.name AS queue_name,
  t.title,
  t.instructions,
  t.acceptance_criteria,
  t.objective,
  t.invariants,
  t.handoff_requirements,
  COALESCE((
    SELECT json_group_array(blocker_task_id)
    FROM (
      SELECT d.blocker_task_id
      FROM task_dependencies d
      WHERE d.task_id = t.id
      ORDER BY d.blocker_task_id
    )
  ), '[]') AS blocked_by,
  t.expected_paths,
  t.allowed_paths,
  t.denied_paths,
  t.max_changed_files,
  t.verify_commands,
  t.approval_checkpoints,
  t.base_drift_policy,
  t.land_strategy,
  t.created_base_sha,
  t.provider,
  t.priority,
  t.status,
  t.current_phase,
  t.delivery_status,
  t.blocked_reason,
  COALESCE(t.delivery_failure_class, t.failure_class) AS failure_class,
  t.failure_reason,
  t.retry_disposition,
  t.result_run_id,
  t.result_commit_sha,
  t.changed_files,
  t.verification_results,
  t.integration_branch,
  t.integration_conflict_files,
  t.integrated_sha,
  t.landed_sha,
  t.integrated_at,
  t.landed_at,
  t.input_tokens,
  t.output_tokens,
  t.cost_usd,
  t.source_kind,
  t.parent_task_id,
  t.idempotency_key,
  t.resume_run_id,
  t.attempt_count,
  t.current_run_id,
  t.cancel_requested_at,
  t.created_at,
  t.updated_at,
  t.completed_at
`;

const RUN_COLUMNS = `
  r.id,
  r.task_id,
  r.attempt_no,
  r.provider,
  r.status,
  r.phase,
  r.base_sha,
  r.branch_name,
  r.worktree_path,
  r.provider_session_id,
  r.plan_session_id,
  r.plan_output,
  r.pid,
  r.process_token,
  r.process_start_marker,
  r.process_identity_path,
  r.owner_token,
  r.owner_pid,
  r.task_snapshot,
  r.dependency_snapshot,
  r.result_commit_sha,
  r.changed_files,
  r.verification_results,
  COALESCE(r.delivery_failure_class, r.failure_class) AS failure_class,
  r.retry_disposition,
  r.input_tokens,
  r.output_tokens,
  r.cost_usd,
  r.started_at,
  r.heartbeat_at,
  r.finished_at,
  r.exit_code,
  r.summary,
  r.error,
  r.log_path
`;

const EVENT_COLUMNS = `
  e.id,
  e.task_id,
  e.run_id,
  e.kind,
  e.payload,
  e.created_at
`;

const TASK_ARTIFACT_COLUMNS = `
  a.id,
  a.task_id,
  a.run_id,
  a.repo_key,
  a.target_ref,
  a.base_sha,
  a.result_sha,
  a.result_ref,
  a.changed_files,
  a.verification_results,
  a.created_at
`;

const INTEGRATION_LANE_COLUMNS = `
  lane.id,
  lane.repo_key,
  lane.repo_path,
  lane.target_ref,
  lane.train_ref,
  lane.target_base_sha,
  lane.head_sha,
  lane.generation,
  lane.created_at,
  lane.updated_at
`;

const DELIVERY_OPERATION_COLUMNS = `
  operation.id,
  operation.lane_id,
  operation.task_id,
  operation.artifact_id,
  operation.kind,
  operation.status,
  operation.owner_token,
  operation.fence_token,
  operation.expected_head_sha,
  operation.candidate_sha,
  operation.conflict_files,
  operation.error,
  operation.created_at,
  operation.started_at,
  operation.heartbeat_at,
  operation.lease_expires_at,
  operation.finished_at
`;

const TASK_APPROVAL_COLUMNS = `
  approval.task_id,
  approval.checkpoint,
  approval.status,
  approval.run_id,
  approval.requested_at,
  approval.decided_at,
  approval.actor,
  approval.note
`;

function corrupt(entity: string, id: string, column: string, expected: string): never {
  throw new AgentQError(
    `Corrupt ${entity} ${id}: ${column} must be ${expected}`,
    "CORRUPT_DATABASE",
  );
}

function rowId(row: { id: unknown }, entity: string): string {
  return typeof row.id === "string" ? row.id : corrupt(entity, "<unknown>", "id", "text");
}

function stringValue(value: unknown, entity: string, id: string, column: string): string {
  return typeof value === "string" ? value : corrupt(entity, id, column, "text");
}

function optionalString(
  value: unknown,
  entity: string,
  id: string,
  column: string,
): string | undefined {
  if (value === null || value === undefined) return undefined;
  return stringValue(value, entity, id, column);
}

function integerValue(value: unknown, entity: string, id: string, column: string): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number)) {
    return corrupt(entity, id, column, "a safe integer");
  }
  return number;
}

function optionalInteger(
  value: unknown,
  entity: string,
  id: string,
  column: string,
): number | undefined {
  if (value === null || value === undefined) return undefined;
  return integerValue(value, entity, id, column);
}

function booleanValue(value: unknown, entity: string, id: string, column: string): boolean {
  const number = integerValue(value, entity, id, column);
  if (number !== 0 && number !== 1) return corrupt(entity, id, column, "0 or 1");
  return number === 1;
}

function jsonStringArray(value: unknown, entity: string, id: string, column: string): string[] {
  const json = stringValue(value, entity, id, column);
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
      return corrupt(entity, id, column, "a JSON string array");
    }
    return parsed;
  } catch (error) {
    if (error instanceof AgentQError) throw error;
    return corrupt(entity, id, column, "valid JSON");
  }
}

function jsonObject(
  value: unknown,
  entity: string,
  id: string,
  column: string,
): Record<string, unknown> {
  const json = stringValue(value, entity, id, column);
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return corrupt(entity, id, column, "a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AgentQError) throw error;
    return corrupt(entity, id, column, "valid JSON");
  }
}

function finiteNumberValue(value: unknown, entity: string, id: string, column: string): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number)) {
    return corrupt(entity, id, column, "a finite number");
  }
  return number;
}

function parsedStringArray(value: unknown, entity: string, id: string, column: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return corrupt(entity, id, column, "a string array");
  }
  return [...value];
}

function jsonArray(value: unknown, entity: string, id: string, column: string): unknown[] {
  const json = stringValue(value, entity, id, column);
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return corrupt(entity, id, column, "a JSON array");
    return parsed;
  } catch (error) {
    if (error instanceof AgentQError) throw error;
    return corrupt(entity, id, column, "valid JSON");
  }
}

function verificationResults(
  value: unknown,
  entity: string,
  id: string,
  column: string,
): VerificationResult[] {
  return jsonArray(value, entity, id, column).map((item, index) => {
    const itemColumn = `${column}[${index}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return corrupt(entity, id, itemColumn, "a verification result object");
    }
    const row = item as Record<string, unknown>;
    const optionalText = (key: keyof VerificationResult): string | undefined =>
      row[key] === undefined
        ? undefined
        : stringValue(row[key], entity, id, `${itemColumn}.${key}`);
    const optionalCount = (key: "exitCode" | "durationMs"): number | undefined =>
      row[key] === undefined
        ? undefined
        : integerValue(row[key], entity, id, `${itemColumn}.${key}`);
    const name = optionalText("name");
    const command = optionalText("command");
    const summary = optionalText("summary");
    const startedAt = optionalText("startedAt");
    const finishedAt = optionalText("finishedAt");
    const exitCode = optionalCount("exitCode");
    const durationMs = optionalCount("durationMs");
    return {
      kind: enumValue(row.kind, VERIFICATION_GATE_KINDS, entity, id, `${itemColumn}.kind`),
      status: enumValue(row.status, VERIFICATION_STATUSES, entity, id, `${itemColumn}.status`),
      ...(name === undefined ? {} : { name }),
      ...(command === undefined ? {} : { command }),
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(summary === undefined ? {} : { summary }),
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(finishedAt === undefined ? {} : { finishedAt }),
      ...(durationMs === undefined ? {} : { durationMs }),
    };
  });
}

function dependencySnapshots(
  value: unknown,
  entity: string,
  id: string,
  column: string,
): TaskDependencySnapshot[] {
  return jsonArray(value, entity, id, column).map((item, index) => {
    const itemColumn = `${column}[${index}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return corrupt(entity, id, itemColumn, "a dependency snapshot object");
    }
    const row = item as Record<string, unknown>;
    const integratedSha =
      row.integratedSha === undefined
        ? undefined
        : stringValue(row.integratedSha, entity, id, `${itemColumn}.integratedSha`);
    const landedSha =
      row.landedSha === undefined
        ? undefined
        : stringValue(row.landedSha, entity, id, `${itemColumn}.landedSha`);
    return {
      taskId: stringValue(row.taskId, entity, id, `${itemColumn}.taskId`),
      runId: stringValue(row.runId, entity, id, `${itemColumn}.runId`),
      resultCommitSha: stringValue(
        row.resultCommitSha,
        entity,
        id,
        `${itemColumn}.resultCommitSha`,
      ),
      deliveryStatus: enumValue(
        row.deliveryStatus,
        DELIVERY_STATUSES,
        entity,
        id,
        `${itemColumn}.deliveryStatus`,
      ),
      ...(integratedSha === undefined ? {} : { integratedSha }),
      ...(landedSha === undefined ? {} : { landedSha }),
    };
  });
}

function taskSpecSnapshot(
  value: unknown,
  entity: string,
  id: string,
  column: string,
): TaskSpecSnapshot | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = jsonObject(value, entity, id, column);
  const acceptanceCriteria = parsedStringArray(
    parsed.acceptanceCriteria,
    entity,
    id,
    `${column}.acceptanceCriteria`,
  );
  let workflow: QueueWorkflowSnapshot | undefined;
  if (parsed.workflow !== undefined) {
    if (!parsed.workflow || typeof parsed.workflow !== "object" || Array.isArray(parsed.workflow)) {
      return corrupt(entity, id, `${column}.workflow`, "a queue workflow snapshot");
    }
    const value = parsed.workflow as Record<string, unknown>;
    const workflowAllowedPaths =
      value.allowedPaths === undefined
        ? undefined
        : parsedStringArray(value.allowedPaths, entity, id, `${column}.workflow.allowedPaths`);
    const workflowDeniedPaths =
      value.deniedPaths === undefined
        ? undefined
        : parsedStringArray(value.deniedPaths, entity, id, `${column}.workflow.deniedPaths`);
    const workflowMaxChangedFiles =
      value.maxChangedFiles === undefined
        ? undefined
        : integerValue(value.maxChangedFiles, entity, id, `${column}.workflow.maxChangedFiles`);
    const workflowVerifyCommands =
      value.verifyCommands === undefined
        ? undefined
        : parsedStringArray(value.verifyCommands, entity, id, `${column}.workflow.verifyCommands`);
    const workflowApprovalCheckpoints =
      value.approvalCheckpoints === undefined
        ? undefined
        : parsedStringArray(
            value.approvalCheckpoints,
            entity,
            id,
            `${column}.workflow.approvalCheckpoints`,
          );
    const workflowBaseDriftPolicy =
      value.baseDriftPolicy === undefined
        ? undefined
        : enumValue(
            value.baseDriftPolicy,
            BASE_DRIFT_POLICIES,
            entity,
            id,
            `${column}.workflow.baseDriftPolicy`,
          );
    const workflowLandStrategy =
      value.landStrategy === undefined
        ? undefined
        : enumValue(
            value.landStrategy,
            LAND_STRATEGIES,
            entity,
            id,
            `${column}.workflow.landStrategy`,
          );
    const workflowFileConcurrency =
      value.fileConcurrency === undefined
        ? undefined
        : enumValue(
            value.fileConcurrency,
            FILE_CONCURRENCY_MODES,
            entity,
            id,
            `${column}.workflow.fileConcurrency`,
          );
    let workflowAutoLand: boolean | undefined;
    if (value.autoLand !== undefined) {
      if (typeof value.autoLand !== "boolean") {
        return corrupt(entity, id, `${column}.workflow.autoLand`, "a boolean");
      }
      workflowAutoLand = value.autoLand;
    }
    workflow = {
      planModel: stringValue(value.planModel, entity, id, `${column}.workflow.planModel`),
      planInstructions: stringValue(
        value.planInstructions,
        entity,
        id,
        `${column}.workflow.planInstructions`,
      ),
      implementModel: stringValue(
        value.implementModel,
        entity,
        id,
        `${column}.workflow.implementModel`,
      ),
      implementInstructions: stringValue(
        value.implementInstructions,
        entity,
        id,
        `${column}.workflow.implementInstructions`,
      ),
      ...(workflowAllowedPaths === undefined ? {} : { allowedPaths: workflowAllowedPaths }),
      ...(workflowDeniedPaths === undefined ? {} : { deniedPaths: workflowDeniedPaths }),
      ...(workflowMaxChangedFiles === undefined
        ? {}
        : { maxChangedFiles: workflowMaxChangedFiles }),
      ...(workflowVerifyCommands === undefined ? {} : { verifyCommands: workflowVerifyCommands }),
      ...(workflowApprovalCheckpoints === undefined
        ? {}
        : { approvalCheckpoints: workflowApprovalCheckpoints }),
      ...(workflowBaseDriftPolicy === undefined
        ? {}
        : { baseDriftPolicy: workflowBaseDriftPolicy }),
      ...(workflowLandStrategy === undefined ? {} : { landStrategy: workflowLandStrategy }),
      ...(workflowAutoLand === undefined ? {} : { autoLand: workflowAutoLand }),
      ...(workflowFileConcurrency === undefined
        ? {}
        : { fileConcurrency: workflowFileConcurrency }),
    };
  }
  const optionalText = (key: keyof TaskSpecSnapshot): string | undefined =>
    parsed[key] === undefined
      ? undefined
      : stringValue(parsed[key], entity, id, `${column}.${String(key)}`);
  const optionalArray = (key: keyof TaskSpecSnapshot): string[] | undefined =>
    parsed[key] === undefined
      ? undefined
      : parsedStringArray(parsed[key], entity, id, `${column}.${String(key)}`);
  const objective = optionalText("objective");
  const invariants = optionalArray("invariants");
  const handoffRequirements = optionalArray("handoffRequirements");
  const blockedBy = optionalArray("blockedBy");
  const expectedPaths = optionalArray("expectedPaths");
  const allowedPaths = optionalArray("allowedPaths");
  const deniedPaths = optionalArray("deniedPaths");
  const verifyCommands = optionalArray("verifyCommands");
  const approvalCheckpoints = optionalArray("approvalCheckpoints");
  const createdBaseSha = optionalText("createdBaseSha");
  const maxChangedFiles =
    parsed.maxChangedFiles === undefined
      ? undefined
      : integerValue(parsed.maxChangedFiles, entity, id, `${column}.maxChangedFiles`);
  const baseDriftPolicy =
    parsed.baseDriftPolicy === undefined
      ? undefined
      : enumValue(
          parsed.baseDriftPolicy,
          BASE_DRIFT_POLICIES,
          entity,
          id,
          `${column}.baseDriftPolicy`,
        );
  const landStrategy =
    parsed.landStrategy === undefined
      ? undefined
      : enumValue(parsed.landStrategy, LAND_STRATEGIES, entity, id, `${column}.landStrategy`);
  const dependencies =
    parsed.dependencies === undefined
      ? undefined
      : dependencySnapshots(
          JSON.stringify(parsed.dependencies),
          entity,
          id,
          `${column}.dependencies`,
        );
  return {
    title: stringValue(parsed.title, entity, id, `${column}.title`),
    instructions: stringValue(parsed.instructions, entity, id, `${column}.instructions`),
    acceptanceCriteria: [...acceptanceCriteria],
    provider: enumValue(parsed.provider, PROVIDERS, entity, id, `${column}.provider`),
    priority: integerValue(parsed.priority, entity, id, `${column}.priority`),
    ...(objective === undefined ? {} : { objective }),
    ...(invariants === undefined ? {} : { invariants }),
    ...(handoffRequirements === undefined ? {} : { handoffRequirements }),
    ...(blockedBy === undefined ? {} : { blockedBy }),
    ...(expectedPaths === undefined ? {} : { expectedPaths }),
    ...(allowedPaths === undefined ? {} : { allowedPaths }),
    ...(deniedPaths === undefined ? {} : { deniedPaths }),
    ...(maxChangedFiles === undefined ? {} : { maxChangedFiles }),
    ...(verifyCommands === undefined ? {} : { verifyCommands }),
    ...(approvalCheckpoints === undefined ? {} : { approvalCheckpoints }),
    ...(baseDriftPolicy === undefined ? {} : { baseDriftPolicy }),
    ...(landStrategy === undefined ? {} : { landStrategy }),
    ...(createdBaseSha === undefined ? {} : { createdBaseSha }),
    ...(dependencies === undefined ? {} : { dependencies }),
    ...(workflow === undefined ? {} : { workflow }),
  };
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  entity: string,
  id: string,
  column: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    return corrupt(entity, id, column, `one of ${allowed.join(", ")}`);
  }
  return value;
}

function mapQueue(row: QueueRow): Queue {
  const id = rowId(row, "queue");
  const maxChangedFiles = optionalInteger(row.max_changed_files, "queue", id, "max_changed_files");
  return {
    id,
    name: stringValue(row.name, "queue", id, "name"),
    repoKey: stringValue(row.repo_key, "queue", id, "repo_key"),
    repoPath: stringValue(row.repo_path, "queue", id, "repo_path"),
    baseRef: stringValue(row.base_ref, "queue", id, "base_ref"),
    defaultProvider: enumValue(row.default_provider, PROVIDERS, "queue", id, "default_provider"),
    planModel: stringValue(row.plan_model, "queue", id, "plan_model"),
    planInstructions: stringValue(row.plan_instructions, "queue", id, "plan_instructions"),
    implementModel: stringValue(row.implement_model, "queue", id, "implement_model"),
    implementInstructions: stringValue(
      row.implement_instructions,
      "queue",
      id,
      "implement_instructions",
    ),
    concurrency: integerValue(row.concurrency, "queue", id, "concurrency"),
    maxAttempts: integerValue(row.max_attempts, "queue", id, "max_attempts"),
    verifyCommands: jsonStringArray(row.verify_commands, "queue", id, "verify_commands"),
    autoCommit: booleanValue(row.auto_commit, "queue", id, "auto_commit"),
    allowedPaths: jsonStringArray(row.allowed_paths, "queue", id, "allowed_paths"),
    deniedPaths: jsonStringArray(row.denied_paths, "queue", id, "denied_paths"),
    ...(maxChangedFiles === undefined ? {} : { maxChangedFiles }),
    approvalCheckpoints: jsonStringArray(
      row.approval_checkpoints,
      "queue",
      id,
      "approval_checkpoints",
    ),
    baseDriftPolicy: enumValue(
      row.base_drift_policy,
      BASE_DRIFT_POLICIES,
      "queue",
      id,
      "base_drift_policy",
    ),
    landStrategy: enumValue(row.land_strategy, LAND_STRATEGIES, "queue", id, "land_strategy"),
    autoLand: booleanValue(row.auto_land, "queue", id, "auto_land"),
    fileConcurrency: enumValue(
      row.file_concurrency,
      FILE_CONCURRENCY_MODES,
      "queue",
      id,
      "file_concurrency",
    ),
    createdAt: stringValue(row.created_at, "queue", id, "created_at"),
    updatedAt: stringValue(row.updated_at, "queue", id, "updated_at"),
  };
}

function mapTask(row: TaskRow): Task {
  const id = rowId(row, "task");
  const parentTaskId = optionalString(row.parent_task_id, "task", id, "parent_task_id");
  const idempotencyKey = optionalString(row.idempotency_key, "task", id, "idempotency_key");
  const currentRunId = optionalString(row.current_run_id, "task", id, "current_run_id");
  const resumeRunId = optionalString(row.resume_run_id, "task", id, "resume_run_id");
  const cancelRequestedAt = optionalString(
    row.cancel_requested_at,
    "task",
    id,
    "cancel_requested_at",
  );
  const completedAt = optionalString(row.completed_at, "task", id, "completed_at");
  const maxChangedFiles = optionalInteger(row.max_changed_files, "task", id, "max_changed_files");
  const createdBaseSha = optionalString(row.created_base_sha, "task", id, "created_base_sha");
  const blockedReason = optionalString(row.blocked_reason, "task", id, "blocked_reason");
  const failureClass =
    row.failure_class === null || row.failure_class === undefined
      ? undefined
      : enumValue(row.failure_class, FAILURE_CLASSES, "task", id, "failure_class");
  const failureReason = optionalString(row.failure_reason, "task", id, "failure_reason");
  const retryDisposition =
    row.retry_disposition === null || row.retry_disposition === undefined
      ? undefined
      : enumValue(row.retry_disposition, RETRY_DISPOSITIONS, "task", id, "retry_disposition");
  const resultRunId = optionalString(row.result_run_id, "task", id, "result_run_id");
  const resultCommitSha = optionalString(row.result_commit_sha, "task", id, "result_commit_sha");
  const integrationBranch = optionalString(
    row.integration_branch,
    "task",
    id,
    "integration_branch",
  );
  const integratedSha = optionalString(row.integrated_sha, "task", id, "integrated_sha");
  const landedSha = optionalString(row.landed_sha, "task", id, "landed_sha");
  const integratedAt = optionalString(row.integrated_at, "task", id, "integrated_at");
  const landedAt = optionalString(row.landed_at, "task", id, "landed_at");
  return {
    id,
    queueId: stringValue(row.queue_id, "task", id, "queue_id"),
    ...(row.queue_name === undefined || row.queue_name === null
      ? {}
      : { queueName: stringValue(row.queue_name, "task", id, "queue_name") }),
    title: stringValue(row.title, "task", id, "title"),
    instructions: stringValue(row.instructions, "task", id, "instructions"),
    acceptanceCriteria: jsonStringArray(row.acceptance_criteria, "task", id, "acceptance_criteria"),
    objective: stringValue(row.objective, "task", id, "objective"),
    invariants: jsonStringArray(row.invariants, "task", id, "invariants"),
    handoffRequirements: jsonStringArray(
      row.handoff_requirements,
      "task",
      id,
      "handoff_requirements",
    ),
    blockedBy: jsonStringArray(row.blocked_by, "task", id, "blocked_by"),
    expectedPaths: jsonStringArray(row.expected_paths, "task", id, "expected_paths"),
    allowedPaths: jsonStringArray(row.allowed_paths, "task", id, "allowed_paths"),
    deniedPaths: jsonStringArray(row.denied_paths, "task", id, "denied_paths"),
    ...(maxChangedFiles === undefined ? {} : { maxChangedFiles }),
    verifyCommands: jsonStringArray(row.verify_commands, "task", id, "verify_commands"),
    approvalCheckpoints: jsonStringArray(
      row.approval_checkpoints,
      "task",
      id,
      "approval_checkpoints",
    ),
    baseDriftPolicy: enumValue(
      row.base_drift_policy,
      BASE_DRIFT_POLICIES,
      "task",
      id,
      "base_drift_policy",
    ),
    landStrategy: enumValue(row.land_strategy, LAND_STRATEGIES, "task", id, "land_strategy"),
    ...(createdBaseSha === undefined ? {} : { createdBaseSha }),
    provider: enumValue(row.provider, PROVIDERS, "task", id, "provider"),
    priority: integerValue(row.priority, "task", id, "priority"),
    status: enumValue(row.status, TASK_STATUSES, "task", id, "status"),
    currentPhase: enumValue(row.current_phase, CURRENT_PHASES, "task", id, "current_phase"),
    deliveryStatus: enumValue(
      row.delivery_status,
      DELIVERY_STATUSES,
      "task",
      id,
      "delivery_status",
    ),
    ...(blockedReason === undefined ? {} : { blockedReason }),
    ...(failureClass === undefined ? {} : { failureClass }),
    ...(failureReason === undefined ? {} : { failureReason }),
    ...(retryDisposition === undefined ? {} : { retryDisposition }),
    ...(resultRunId === undefined ? {} : { resultRunId }),
    ...(resultCommitSha === undefined ? {} : { resultCommitSha }),
    changedFiles: jsonStringArray(row.changed_files, "task", id, "changed_files"),
    verificationResults: verificationResults(
      row.verification_results,
      "task",
      id,
      "verification_results",
    ),
    ...(integrationBranch === undefined ? {} : { integrationBranch }),
    integrationConflictFiles: jsonStringArray(
      row.integration_conflict_files,
      "task",
      id,
      "integration_conflict_files",
    ),
    ...(integratedSha === undefined ? {} : { integratedSha }),
    ...(landedSha === undefined ? {} : { landedSha }),
    ...(integratedAt === undefined ? {} : { integratedAt }),
    ...(landedAt === undefined ? {} : { landedAt }),
    inputTokens: integerValue(row.input_tokens, "task", id, "input_tokens"),
    outputTokens: integerValue(row.output_tokens, "task", id, "output_tokens"),
    costUsd: finiteNumberValue(row.cost_usd, "task", id, "cost_usd"),
    sourceKind: enumValue(
      row.source_kind,
      ["manual", "agent", "api"] as const,
      "task",
      id,
      "source_kind",
    ),
    ...(parentTaskId === undefined ? {} : { parentTaskId }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    ...(resumeRunId === undefined ? {} : { resumeRunId }),
    attemptCount: integerValue(row.attempt_count, "task", id, "attempt_count"),
    ...(currentRunId === undefined ? {} : { currentRunId }),
    ...(cancelRequestedAt === undefined ? {} : { cancelRequestedAt }),
    createdAt: stringValue(row.created_at, "task", id, "created_at"),
    updatedAt: stringValue(row.updated_at, "task", id, "updated_at"),
    ...(completedAt === undefined ? {} : { completedAt }),
  };
}

function mapRun(row: RunRow): Run {
  const id = rowId(row, "run");
  const snapshot = taskSpecSnapshot(row.task_snapshot, "run", id, "task_snapshot");
  const failureClass =
    row.failure_class === null || row.failure_class === undefined
      ? undefined
      : enumValue(row.failure_class, FAILURE_CLASSES, "run", id, "failure_class");
  const retryDisposition =
    row.retry_disposition === null || row.retry_disposition === undefined
      ? undefined
      : enumValue(row.retry_disposition, RETRY_DISPOSITIONS, "run", id, "retry_disposition");
  const optional = <K extends keyof Run>(
    key: K,
    value: Run[K] | undefined,
  ): Partial<Pick<Run, K>> => (value === undefined ? {} : ({ [key]: value } as Pick<Run, K>));

  return {
    id,
    taskId: stringValue(row.task_id, "run", id, "task_id"),
    attemptNo: integerValue(row.attempt_no, "run", id, "attempt_no"),
    provider: enumValue(row.provider, PROVIDERS, "run", id, "provider"),
    status: enumValue(row.status, RUN_STATUSES, "run", id, "status"),
    phase: enumValue(row.phase, EXECUTION_PHASES, "run", id, "phase"),
    ...optional("baseSha", optionalString(row.base_sha, "run", id, "base_sha")),
    ...optional("branchName", optionalString(row.branch_name, "run", id, "branch_name")),
    ...optional("worktreePath", optionalString(row.worktree_path, "run", id, "worktree_path")),
    ...optional(
      "providerSessionId",
      optionalString(row.provider_session_id, "run", id, "provider_session_id"),
    ),
    ...optional("planSessionId", optionalString(row.plan_session_id, "run", id, "plan_session_id")),
    ...optional("planOutput", optionalString(row.plan_output, "run", id, "plan_output")),
    ...optional("pid", optionalInteger(row.pid, "run", id, "pid")),
    ...optional("processToken", optionalString(row.process_token, "run", id, "process_token")),
    ...optional(
      "processStartMarker",
      optionalString(row.process_start_marker, "run", id, "process_start_marker"),
    ),
    ...optional(
      "processIdentityPath",
      optionalString(row.process_identity_path, "run", id, "process_identity_path"),
    ),
    ...optional("ownerPid", optionalInteger(row.owner_pid, "run", id, "owner_pid")),
    ...optional("taskSnapshot", snapshot),
    dependencySnapshot: dependencySnapshots(
      row.dependency_snapshot,
      "run",
      id,
      "dependency_snapshot",
    ),
    ...optional(
      "resultCommitSha",
      optionalString(row.result_commit_sha, "run", id, "result_commit_sha"),
    ),
    changedFiles: jsonStringArray(row.changed_files, "run", id, "changed_files"),
    verificationResults: verificationResults(
      row.verification_results,
      "run",
      id,
      "verification_results",
    ),
    ...optional("failureClass", failureClass),
    ...optional("retryDisposition", retryDisposition),
    inputTokens: integerValue(row.input_tokens, "run", id, "input_tokens"),
    outputTokens: integerValue(row.output_tokens, "run", id, "output_tokens"),
    costUsd: finiteNumberValue(row.cost_usd, "run", id, "cost_usd"),
    startedAt: stringValue(row.started_at, "run", id, "started_at"),
    heartbeatAt: stringValue(row.heartbeat_at, "run", id, "heartbeat_at"),
    ...optional("finishedAt", optionalString(row.finished_at, "run", id, "finished_at")),
    ...optional("exitCode", optionalInteger(row.exit_code, "run", id, "exit_code")),
    ...optional("summary", optionalString(row.summary, "run", id, "summary")),
    ...optional("error", optionalString(row.error, "run", id, "error")),
    ...optional("logPath", optionalString(row.log_path, "run", id, "log_path")),
  };
}

function mapEvent(row: EventRow): TaskEvent {
  const numericId = integerValue(row.id, "event", "<unknown>", "id");
  const id = String(numericId);
  const runId = optionalString(row.run_id, "event", id, "run_id");
  return {
    id: numericId,
    taskId: stringValue(row.task_id, "event", id, "task_id"),
    ...(runId === undefined ? {} : { runId }),
    kind: stringValue(row.kind, "event", id, "kind"),
    payload: jsonObject(row.payload, "event", id, "payload"),
    createdAt: stringValue(row.created_at, "event", id, "created_at"),
  };
}

function mapTaskArtifact(row: TaskArtifactRow): TaskArtifact {
  const id = rowId(row, "task artifact");
  return {
    id,
    taskId: stringValue(row.task_id, "task artifact", id, "task_id"),
    runId: stringValue(row.run_id, "task artifact", id, "run_id"),
    repoKey: stringValue(row.repo_key, "task artifact", id, "repo_key"),
    targetRef: stringValue(row.target_ref, "task artifact", id, "target_ref"),
    baseSha: stringValue(row.base_sha, "task artifact", id, "base_sha"),
    resultSha: stringValue(row.result_sha, "task artifact", id, "result_sha"),
    resultRef: stringValue(row.result_ref, "task artifact", id, "result_ref"),
    changedFiles: jsonStringArray(row.changed_files, "task artifact", id, "changed_files"),
    verificationResults: verificationResults(
      row.verification_results,
      "task artifact",
      id,
      "verification_results",
    ),
    createdAt: stringValue(row.created_at, "task artifact", id, "created_at"),
  };
}

function mapIntegrationLane(row: IntegrationLaneRow): IntegrationLane {
  const id = rowId(row, "integration lane");
  return {
    id,
    repoKey: stringValue(row.repo_key, "integration lane", id, "repo_key"),
    repoPath: stringValue(row.repo_path, "integration lane", id, "repo_path"),
    targetRef: stringValue(row.target_ref, "integration lane", id, "target_ref"),
    trainRef: stringValue(row.train_ref, "integration lane", id, "train_ref"),
    targetBaseSha: stringValue(row.target_base_sha, "integration lane", id, "target_base_sha"),
    headSha: stringValue(row.head_sha, "integration lane", id, "head_sha"),
    generation: integerValue(row.generation, "integration lane", id, "generation"),
    createdAt: stringValue(row.created_at, "integration lane", id, "created_at"),
    updatedAt: stringValue(row.updated_at, "integration lane", id, "updated_at"),
  };
}

function mapDeliveryOperation(row: DeliveryOperationRow): DeliveryOperation {
  const id = rowId(row, "delivery operation");
  const optional = <K extends keyof DeliveryOperation>(
    key: K,
    value: DeliveryOperation[K] | undefined,
  ): Partial<Pick<DeliveryOperation, K>> =>
    value === undefined ? {} : ({ [key]: value } as Pick<DeliveryOperation, K>);
  return {
    id,
    laneId: stringValue(row.lane_id, "delivery operation", id, "lane_id"),
    ...optional("taskId", optionalString(row.task_id, "delivery operation", id, "task_id")),
    ...optional(
      "artifactId",
      optionalString(row.artifact_id, "delivery operation", id, "artifact_id"),
    ),
    kind: enumValue(row.kind, DELIVERY_OPERATION_KINDS, "delivery operation", id, "kind"),
    status: enumValue(row.status, DELIVERY_OPERATION_STATUSES, "delivery operation", id, "status"),
    ...optional(
      "ownerToken",
      optionalString(row.owner_token, "delivery operation", id, "owner_token"),
    ),
    fenceToken: integerValue(row.fence_token, "delivery operation", id, "fence_token"),
    ...optional(
      "expectedHeadSha",
      optionalString(row.expected_head_sha, "delivery operation", id, "expected_head_sha"),
    ),
    ...optional(
      "candidateSha",
      optionalString(row.candidate_sha, "delivery operation", id, "candidate_sha"),
    ),
    conflictFiles: jsonStringArray(row.conflict_files, "delivery operation", id, "conflict_files"),
    ...optional("error", optionalString(row.error, "delivery operation", id, "error")),
    createdAt: stringValue(row.created_at, "delivery operation", id, "created_at"),
    ...optional(
      "startedAt",
      optionalString(row.started_at, "delivery operation", id, "started_at"),
    ),
    ...optional(
      "heartbeatAt",
      optionalString(row.heartbeat_at, "delivery operation", id, "heartbeat_at"),
    ),
    ...optional(
      "leaseExpiresAt",
      optionalString(row.lease_expires_at, "delivery operation", id, "lease_expires_at"),
    ),
    ...optional(
      "finishedAt",
      optionalString(row.finished_at, "delivery operation", id, "finished_at"),
    ),
  };
}

function mapTaskApproval(row: TaskApprovalRow): TaskApproval {
  const taskId = stringValue(row.task_id, "task approval", "<unknown>", "task_id");
  const checkpoint = stringValue(row.checkpoint, "task approval", taskId, "checkpoint");
  const optional = <K extends keyof TaskApproval>(
    key: K,
    value: TaskApproval[K] | undefined,
  ): Partial<Pick<TaskApproval, K>> =>
    value === undefined ? {} : ({ [key]: value } as Pick<TaskApproval, K>);
  return {
    taskId,
    checkpoint,
    status: enumValue(
      row.status,
      APPROVAL_STATUSES,
      "task approval",
      `${taskId}:${checkpoint}`,
      "status",
    ),
    ...optional("runId", optionalString(row.run_id, "task approval", taskId, "run_id")),
    requestedAt: stringValue(row.requested_at, "task approval", taskId, "requested_at"),
    ...optional("decidedAt", optionalString(row.decided_at, "task approval", taskId, "decided_at")),
    ...optional("actor", optionalString(row.actor, "task approval", taskId, "actor")),
    ...optional("note", optionalString(row.note, "task approval", taskId, "note")),
  };
}

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new AgentQError(`${field} cannot be empty`, "INVALID_INPUT", 2);
  return normalized;
}

function canonicalTargetRef(value: string): string {
  const input = nonEmpty(value, "targetRef");
  const ref = input.startsWith("refs/heads/") ? input : `refs/heads/${input}`;
  const branch = ref.slice("refs/heads/".length);
  const invalid =
    !branch ||
    branch.startsWith(".") ||
    branch.startsWith("-") ||
    branch === "@" ||
    branch.endsWith(".") ||
    branch.endsWith("/") ||
    branch.includes("..") ||
    branch.includes("@{") ||
    branch.includes("//") ||
    branch.includes("\\") ||
    [...branch].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 32 || code === 127;
    }) ||
    ["~", "^", ":", "?", "*", "["].some((character) => branch.includes(character)) ||
    branch
      .split("/")
      .some((segment) => !segment || segment.startsWith(".") || segment.endsWith(".lock"));
  if (invalid) {
    throw new AgentQError(
      `targetRef ${JSON.stringify(value)} is not a safe local branch ref`,
      "INVALID_TARGET_REF",
      2,
    );
  }
  return ref;
}

function integerInput(value: number, field: string, minimum?: number): number {
  if (!Number.isSafeInteger(value) || (minimum !== undefined && value < minimum)) {
    throw new AgentQError(
      `${field} must be a safe integer${minimum === undefined ? "" : ` greater than or equal to ${minimum}`}`,
      "INVALID_INPUT",
      2,
    );
  }
  return value;
}

function stringArrayInput(value: readonly string[], field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new AgentQError(`${field} must be an array of strings`, "INVALID_INPUT", 2);
  }
  return [...value];
}

function scopePatternArrayInput(value: readonly string[], field: string): string[] {
  return [
    ...new Set(stringArrayInput(value, field).map((pattern) => normalizeScopePattern(pattern))),
  ];
}

function timestamp(value: string | undefined, field = "timestamp"): string {
  if (value === undefined) return isoNow();
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new AgentQError(`${field} must be a valid timestamp`, "INVALID_INPUT", 2);
  }
  return new Date(milliseconds).toISOString();
}

function nextUpdatedAt(previous: string): string {
  const now = isoNow();
  const previousMilliseconds = Date.parse(previous);
  const nowMilliseconds = Date.parse(now);
  if (Number.isFinite(previousMilliseconds) && nowMilliseconds <= previousMilliseconds) {
    return new Date(previousMilliseconds + 1).toISOString();
  }
  return now;
}

function pagination(limit: number | undefined, offset: number | undefined): [number, number] {
  const normalizedLimit = integerInput(limit ?? DEFAULT_LIST_LIMIT, "limit", 1);
  if (normalizedLimit > MAX_LIST_LIMIT) {
    throw new AgentQError(`limit cannot exceed ${MAX_LIST_LIMIT}`, "INVALID_INPUT", 2);
  }
  return [normalizedLimit, integerInput(offset ?? 0, "offset", 0)];
}

function statusValues<T extends string>(status: T | readonly T[] | undefined, field: string): T[] {
  if (status === undefined) return [];
  const values = Array.isArray(status) ? [...status] : [status as T];
  if (values.length === 0) {
    throw new AgentQError(`${field} cannot be an empty array`, "INVALID_INPUT", 2);
  }
  return values;
}

function constraint(error: unknown, message: string, code: string): never {
  const raw = error as { code?: unknown };
  if (typeof raw.code === "string" && raw.code.startsWith("SQLITE_CONSTRAINT")) {
    throw new AgentQError(message, code);
  }
  throw error;
}

function sqliteBusy(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return (
    (typeof code === "string" && code.startsWith("SQLITE_BUSY")) ||
    /database is (?:locked|busy)/i.test(errorMessage(error))
  );
}

function initializeDatabase(database: Database, busyTimeoutMs: number): void {
  database.run(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  const deadline = Date.now() + busyTimeoutMs;
  let retryDelayMs = 2;

  while (true) {
    try {
      database.run("PRAGMA foreign_keys = ON");
      database.run("PRAGMA journal_mode = WAL");
      database.run("PRAGMA synchronous = NORMAL");
      database.run("PRAGMA wal_autocheckpoint = 1000");
      migrate(database);
      return;
    } catch (error) {
      const remainingMs = deadline - Date.now();
      if (!sqliteBusy(error) || remainingMs <= 0) throw error;
      Bun.sleepSync(Math.min(retryDelayMs, remainingMs));
      retryDelayMs = Math.min(retryDelayMs * 2, 50);
    }
  }
}

export class AgentQStore {
  readonly databasePath: string;
  readonly #database: Database;
  #closed = false;

  constructor(databasePath: string, options: StoreOptions = {}) {
    this.databasePath = databasePath;
    const busyTimeoutMs = integerInput(
      options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
      "busyTimeoutMs",
      0,
    );

    if (databasePath !== ":memory:" && databasePath !== "") {
      mkdirSync(dirname(databasePath), { recursive: true });
    }

    const database = new Database(databasePath, {
      create: true,
      readwrite: true,
      safeIntegers: false,
      strict: true,
    });
    this.#database = database;
    if (databasePath !== ":memory:" && databasePath !== "" && process.platform !== "win32") {
      chmodSync(databasePath, 0o600);
    }

    try {
      initializeDatabase(database, busyTimeoutMs);
    } catch (error) {
      database.close();
      this.#closed = true;
      throw error;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close(true);
    this.#closed = true;
  }

  [Symbol.dispose](): void {
    this.close();
  }

  createQueue(input: CreateQueueInput): Queue {
    const id = makeId("queue");
    const name = nonEmpty(input.name, "queue name");
    const repoKey = nonEmpty(input.repoKey, "repoKey");
    const repoPath = nonEmpty(input.repoPath, "repoPath");
    const baseRef = nonEmpty(input.baseRef ?? "HEAD", "baseRef");
    const defaultProvider = input.defaultProvider ?? "codex";
    const planModel = input.planModel?.trim() ?? "";
    const planInstructions = input.planInstructions?.trim() ?? "";
    const implementModel = input.implementModel?.trim() ?? "";
    const implementInstructions = input.implementInstructions?.trim() ?? "";
    const concurrency = integerInput(input.concurrency ?? 1, "concurrency", 1);
    const maxAttempts = integerInput(input.maxAttempts ?? 3, "maxAttempts", 1);
    const verifyCommands = stringArrayInput(input.verifyCommands ?? [], "verifyCommands");
    const allowedPaths = scopePatternArrayInput(input.allowedPaths ?? [], "allowedPaths");
    const deniedPaths = scopePatternArrayInput(input.deniedPaths ?? [], "deniedPaths");
    const maxChangedFiles =
      input.maxChangedFiles === undefined
        ? null
        : integerInput(input.maxChangedFiles, "maxChangedFiles", 1);
    const approvalCheckpoints = stringArrayInput(
      input.approvalCheckpoints ?? [],
      "approvalCheckpoints",
    );
    const now = isoNow();

    try {
      this.#database.run(
        `
          INSERT INTO queues(
            id, name, repo_key, repo_path, base_ref, default_provider, concurrency,
            plan_model, plan_instructions, implement_model, implement_instructions,
            max_attempts, verify_commands, auto_commit, allowed_paths, denied_paths,
            max_changed_files, approval_checkpoints, base_drift_policy, land_strategy,
            auto_land, file_concurrency, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          id,
          name,
          repoKey,
          repoPath,
          baseRef,
          defaultProvider,
          concurrency,
          planModel,
          planInstructions,
          implementModel,
          implementInstructions,
          maxAttempts,
          JSON.stringify(verifyCommands),
          input.autoCommit === true ? 1 : 0,
          JSON.stringify(allowedPaths),
          JSON.stringify(deniedPaths),
          maxChangedFiles,
          JSON.stringify(approvalCheckpoints),
          input.baseDriftPolicy ?? "replan",
          input.landStrategy ?? "none",
          input.autoLand === true ? 1 : 0,
          input.fileConcurrency ?? "off",
          now,
          now,
        ],
      );
    } catch (error) {
      constraint(
        error,
        `A queue named "${name}" already exists in repository ${repoKey}`,
        "QUEUE_EXISTS",
      );
    }

    return this.#requireQueue(id);
  }

  getQueue(idOrName: string, repoKey?: string): Queue | undefined {
    const scope = repoKey === undefined ? undefined : nonEmpty(repoKey, "repoKey");
    const byId = selectOne<QueueRow, [string]>(
      this.#database,
      `SELECT ${QUEUE_COLUMNS} FROM queues q WHERE q.id = ?`,
      [idOrName],
    );
    if (byId) {
      const queue = mapQueue(byId);
      return scope === undefined || queue.repoKey === scope ? queue : undefined;
    }

    const bindings: string[] = [idOrName];
    const scopeClause = scope === undefined ? "" : "AND q.repo_key = ?";
    if (scope !== undefined) bindings.push(scope);
    const matches = selectAll<QueueRow, string[]>(
      this.#database,
      `
        SELECT ${QUEUE_COLUMNS}
        FROM queues q
        WHERE q.name = ? COLLATE NOCASE ${scopeClause}
        ORDER BY q.id
        LIMIT 2
      `,
      bindings,
    );
    if (matches.length > 1) {
      throw new AgentQError(
        `Queue name "${idOrName}" exists in multiple repositories; specify a repository scope or queue id`,
        "QUEUE_AMBIGUOUS",
        2,
      );
    }
    return matches[0] ? mapQueue(matches[0]) : undefined;
  }

  listQueues(repoKey?: string): Queue[] {
    const scope = repoKey === undefined ? undefined : nonEmpty(repoKey, "repoKey");
    const where = scope === undefined ? "" : "WHERE q.repo_key = ?";
    const bindings = scope === undefined ? [] : [scope];
    return selectAll<QueueRow, string[]>(
      this.#database,
      `SELECT ${QUEUE_COLUMNS}
         FROM queues q
         ${where}
         ORDER BY q.name COLLATE NOCASE, q.id`,
      bindings,
    ).map(mapQueue);
  }

  updateQueue(idOrName: string, patch: UpdateQueueInput, repoKey?: string): Queue {
    const queue = this.#requireQueue(idOrName, repoKey);
    const fields: string[] = [];
    const values: Binding[] = [];

    const set = (column: string, value: Binding) => {
      fields.push(`${column} = ?`);
      values.push(value);
    };

    if (patch.name !== undefined) set("name", nonEmpty(patch.name, "queue name"));
    if (patch.repoKey !== undefined) set("repo_key", nonEmpty(patch.repoKey, "repoKey"));
    if (patch.repoPath !== undefined) set("repo_path", nonEmpty(patch.repoPath, "repoPath"));
    if (patch.baseRef !== undefined) set("base_ref", nonEmpty(patch.baseRef, "baseRef"));
    if (patch.defaultProvider !== undefined) {
      set("default_provider", patch.defaultProvider);
      if (patch.defaultProvider !== queue.defaultProvider) {
        // Model identifiers are provider-specific. A provider switch without an
        // explicit replacement must fall back to the new provider's defaults.
        if (patch.planModel === undefined) set("plan_model", "");
        if (patch.implementModel === undefined) set("implement_model", "");
      }
    }
    if (patch.planModel !== undefined) set("plan_model", patch.planModel.trim());
    if (patch.planInstructions !== undefined) {
      set("plan_instructions", patch.planInstructions.trim());
    }
    if (patch.implementModel !== undefined) set("implement_model", patch.implementModel.trim());
    if (patch.implementInstructions !== undefined) {
      set("implement_instructions", patch.implementInstructions.trim());
    }
    if (patch.concurrency !== undefined) {
      set("concurrency", integerInput(patch.concurrency, "concurrency", 1));
    }
    if (patch.maxAttempts !== undefined) {
      set("max_attempts", integerInput(patch.maxAttempts, "maxAttempts", 1));
    }
    if (patch.verifyCommands !== undefined) {
      set(
        "verify_commands",
        JSON.stringify(stringArrayInput(patch.verifyCommands, "verifyCommands")),
      );
    }
    if (patch.autoCommit !== undefined) set("auto_commit", patch.autoCommit ? 1 : 0);
    if (patch.allowedPaths !== undefined) {
      set(
        "allowed_paths",
        JSON.stringify(scopePatternArrayInput(patch.allowedPaths, "allowedPaths")),
      );
    }
    if (patch.deniedPaths !== undefined) {
      set("denied_paths", JSON.stringify(scopePatternArrayInput(patch.deniedPaths, "deniedPaths")));
    }
    if (patch.maxChangedFiles !== undefined) {
      set(
        "max_changed_files",
        patch.maxChangedFiles === null
          ? null
          : integerInput(patch.maxChangedFiles, "maxChangedFiles", 1),
      );
    }
    if (patch.approvalCheckpoints !== undefined) {
      set(
        "approval_checkpoints",
        JSON.stringify(stringArrayInput(patch.approvalCheckpoints, "approvalCheckpoints")),
      );
    }
    if (patch.baseDriftPolicy !== undefined) set("base_drift_policy", patch.baseDriftPolicy);
    if (patch.landStrategy !== undefined) set("land_strategy", patch.landStrategy);
    if (patch.autoLand !== undefined) set("auto_land", patch.autoLand ? 1 : 0);
    if (patch.fileConcurrency !== undefined) set("file_concurrency", patch.fileConcurrency);

    if (fields.length === 0) return queue;

    set("updated_at", isoNow());
    values.push(queue.id);

    try {
      this.#database.run(`UPDATE queues SET ${fields.join(", ")} WHERE id = ?`, values);
    } catch (error) {
      constraint(
        error,
        `A queue named "${patch.name ?? queue.name}" already exists in that repository`,
        "QUEUE_EXISTS",
      );
    }

    return this.#requireQueue(queue.id);
  }

  deleteQueue(idOrName: string, repoKey?: string): boolean {
    const remove = this.#database.transaction(() => {
      const queue = this.getQueue(idOrName, repoKey);
      if (!queue) return false;

      const task = selectOne<{ id: string }, [string]>(
        this.#database,
        "SELECT id FROM tasks WHERE queue_id = ? LIMIT 1",
        [queue.id],
      );
      if (task) {
        throw new AgentQError(
          `Cannot delete queue ${queue.name} because it contains tasks`,
          "QUEUE_NOT_EMPTY",
        );
      }

      return this.#database.run("DELETE FROM queues WHERE id = ?", [queue.id]).changes > 0;
    });

    return remove.immediate();
  }

  deleteQueueCascade(
    idOrName: string,
    repoKey?: string,
  ): { queue: Queue; taskIds: string[] } | undefined {
    const remove = this.#database.transaction(() => {
      const queue = this.getQueue(idOrName, repoKey);
      if (!queue) return undefined;

      const activeTask = selectOne<{ id: string }, [string]>(
        this.#database,
        `
          SELECT t.id
          FROM tasks t
          WHERE t.queue_id = ?
            AND (
              t.current_run_id IS NOT NULL
              OR t.status IN ('starting', 'running', 'cancelling')
              OR EXISTS (
                SELECT 1
                FROM runs r
                WHERE r.task_id = t.id
                  AND r.status IN ('starting', 'running', 'cancelling')
              )
            )
          LIMIT 1
        `,
        [queue.id],
      );
      if (activeTask) {
        throw new AgentQError(
          `Cannot delete queue ${queue.name} while task ${activeTask.id} is active`,
          "QUEUE_HAS_ACTIVE_TASKS",
        );
      }

      const retainedWorktree = selectOne<{ task_id: string }, [string]>(
        this.#database,
        `
          SELECT r.task_id
          FROM runs r
          JOIN tasks t ON t.id = r.task_id
          WHERE t.queue_id = ? AND r.worktree_path IS NOT NULL
          LIMIT 1
        `,
        [queue.id],
      );
      if (retainedWorktree) {
        throw new AgentQError(
          `Clean retained worktrees before deleting queue ${queue.name}`,
          "QUEUE_HAS_WORKTREES",
        );
      }

      const taskIds = selectAll<{ id: string }, [string]>(
        this.#database,
        "SELECT id FROM tasks WHERE queue_id = ? ORDER BY id",
        [queue.id],
      ).map(({ id }) => id);
      const externalDependent = selectOne<{ task_id: string }, [string, string]>(
        this.#database,
        `
          SELECT dependency.task_id
          FROM task_dependencies dependency
          JOIN tasks blocker ON blocker.id = dependency.blocker_task_id
          JOIN tasks dependent ON dependent.id = dependency.task_id
          WHERE blocker.queue_id = ? AND dependent.queue_id <> ?
          LIMIT 1
        `,
        [queue.id, queue.id],
      );
      if (externalDependent) {
        throw new AgentQError(
          `Delete dependent task ${externalDependent.task_id} before deleting queue ${queue.name}`,
          "QUEUE_HAS_DEPENDENTS",
        );
      }
      this.#database.run(
        `
          DELETE FROM task_dependencies
          WHERE task_id IN (SELECT id FROM tasks WHERE queue_id = ?)
        `,
        [queue.id],
      );
      const changed = this.#database.run("DELETE FROM queues WHERE id = ?", [queue.id]).changes;
      if (changed < 1) {
        throw new AgentQError(`Queue changed while being deleted: ${queue.name}`, "QUEUE_CHANGED");
      }
      return { queue, taskIds };
    });

    return remove.immediate();
  }

  addTask(input: AddTaskInput, options: AddTaskOptions = {}): Task {
    const add = this.#database.transaction(() => {
      const queue = this.#requireQueue(input.queue);
      const idempotencyKey =
        input.idempotencyKey === undefined
          ? undefined
          : nonEmpty(input.idempotencyKey, "idempotencyKey");

      if (idempotencyKey !== undefined) {
        const existing = selectOne<TaskRow, [string, string]>(
          this.#database,
          `
            SELECT ${TASK_COLUMNS}
            FROM tasks t
            JOIN queues q ON q.id = t.queue_id
            WHERE t.queue_id = ? AND t.idempotency_key = ?
          `,
          [queue.id, idempotencyKey],
        );
        if (existing) return mapTask(existing);
      }

      if (input.parentTaskId !== undefined) {
        const parent = this.getTask(input.parentTaskId);
        if (!parent) {
          throw new AgentQError(`Task ${input.parentTaskId} does not exist`, "TASK_NOT_FOUND");
        }
        if (parent.queueId !== queue.id) {
          throw new AgentQError(
            "A delegated task must use the same queue as its parent",
            "PARENT_QUEUE_MISMATCH",
          );
        }
        if (options.maxChildrenForParent !== undefined) {
          const maximum = integerInput(options.maxChildrenForParent, "maxChildrenForParent", 1);
          const children = selectOne<CountRow, [string]>(
            this.#database,
            "SELECT COUNT(*) AS count FROM tasks WHERE parent_task_id = ?",
            [parent.id],
          );
          if (
            integerValue(children?.count, "tasks", parent.id, "delegated child count") >= maximum
          ) {
            throw new AgentQError(
              `Per-parent delegated task limit (${maximum}) reached`,
              "DELEGATION_CHILD_LIMIT",
            );
          }
        }
      } else if (options.maxChildrenForParent !== undefined) {
        throw new AgentQError("maxChildrenForParent requires parentTaskId", "INVALID_TASK", 2);
      }

      const id = makeId("task");
      const now = isoNow();
      const title = nonEmpty(input.title, "task title");
      const acceptanceCriteria = stringArrayInput(
        input.acceptanceCriteria ?? [],
        "acceptanceCriteria",
      );
      const objective =
        input.objective === undefined ? title : nonEmpty(input.objective, "objective");
      const invariants = stringArrayInput(input.invariants ?? [], "invariants");
      const handoffRequirements = stringArrayInput(
        input.handoffRequirements ?? [],
        "handoffRequirements",
      );
      const expectedPaths = scopePatternArrayInput(input.expectedPaths ?? [], "expectedPaths");
      const allowedPaths = scopePatternArrayInput(input.allowedPaths ?? [], "allowedPaths");
      const deniedPaths = scopePatternArrayInput(input.deniedPaths ?? [], "deniedPaths");
      const maxChangedFiles =
        input.maxChangedFiles === undefined
          ? null
          : integerInput(input.maxChangedFiles, "maxChangedFiles", 1);
      const verifyCommands = stringArrayInput(input.verifyCommands ?? [], "verifyCommands");
      const approvalCheckpoints = stringArrayInput(
        input.approvalCheckpoints ?? [],
        "approvalCheckpoints",
      );
      const blockedBy = [...new Set(stringArrayInput(input.blockedBy ?? [], "blockedBy"))].sort();
      const priority = integerInput(input.priority ?? 0, "priority");

      try {
        this.#database.run(
          `
            INSERT INTO tasks(
              id, queue_id, title, instructions, acceptance_criteria, objective,
              invariants, handoff_requirements, expected_paths, allowed_paths, denied_paths,
              max_changed_files, verify_commands, approval_checkpoints, base_drift_policy,
              land_strategy, created_base_sha, provider, priority, status, current_phase,
              source_kind, parent_task_id, idempotency_key, attempt_count, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, 0, ?, ?)
          `,
          [
            id,
            queue.id,
            title,
            input.instructions ?? "",
            JSON.stringify(acceptanceCriteria),
            objective,
            JSON.stringify(invariants),
            JSON.stringify(handoffRequirements),
            JSON.stringify(expectedPaths),
            JSON.stringify(allowedPaths),
            JSON.stringify(deniedPaths),
            maxChangedFiles,
            JSON.stringify(verifyCommands),
            JSON.stringify(approvalCheckpoints),
            input.baseDriftPolicy ?? queue.baseDriftPolicy,
            input.landStrategy ?? queue.landStrategy,
            input.createdBaseSha ?? null,
            input.provider ?? queue.defaultProvider,
            priority,
            blockedBy.length > 0 ? "blocked" : "queued",
            input.sourceKind ?? "manual",
            input.parentTaskId ?? null,
            idempotencyKey ?? null,
            now,
            now,
          ],
        );
      } catch (error) {
        constraint(
          error,
          "Task could not be added because a referenced value is invalid",
          "INVALID_TASK",
        );
      }

      this.#replaceTaskDependencies(id, blockedBy, now);
      return this.#requireTask(id);
    });

    return add.immediate();
  }

  listTaskDependencies(id: string): Task[] {
    this.#requireTask(id);
    return selectAll<TaskRow, [string]>(
      this.#database,
      `
        SELECT ${TASK_COLUMNS}
        FROM task_dependencies dependency
        JOIN tasks t ON t.id = dependency.blocker_task_id
        JOIN queues q ON q.id = t.queue_id
        WHERE dependency.task_id = ?
        ORDER BY dependency.created_at, t.id
      `,
      [id],
    ).map(mapTask);
  }

  listTaskDependents(id: string): Task[] {
    this.#requireTask(id);
    return selectAll<TaskRow, [string]>(
      this.#database,
      `
        SELECT ${TASK_COLUMNS}
        FROM task_dependencies dependency
        JOIN tasks t ON t.id = dependency.task_id
        JOIN queues q ON q.id = t.queue_id
        WHERE dependency.blocker_task_id = ?
        ORDER BY dependency.created_at, t.id
      `,
      [id],
    ).map(mapTask);
  }

  getTask(id: string): Task | undefined {
    const row = selectOne<TaskRow, [string]>(
      this.#database,
      `
        SELECT ${TASK_COLUMNS}
        FROM tasks t
        JOIN queues q ON q.id = t.queue_id
        WHERE t.id = ?
      `,
      [id],
    );
    return row ? mapTask(row) : undefined;
  }

  listTasks(filter: TaskFilter = {}): Task[] {
    const where: string[] = [];
    const values: Binding[] = [];

    if (filter.queue !== undefined) {
      where.push("t.queue_id = ?");
      values.push(this.#requireQueue(filter.queue, filter.repoKey).id);
    }
    if (filter.repoKey !== undefined) {
      where.push("q.repo_key = ?");
      values.push(nonEmpty(filter.repoKey, "repoKey"));
    }
    if (filter.status !== undefined && filter.statuses !== undefined) {
      throw new AgentQError("Use either status or statuses, not both", "INVALID_INPUT", 2);
    }
    const statuses = statusValues(filter.status ?? filter.statuses, "status");
    if (statuses.length > 0) {
      where.push(`t.status IN (${statuses.map(() => "?").join(", ")})`);
      values.push(...statuses);
    }
    if (filter.provider !== undefined) {
      where.push("t.provider = ?");
      values.push(filter.provider);
    }
    if (filter.sourceKind !== undefined) {
      where.push("t.source_kind = ?");
      values.push(filter.sourceKind);
    }

    const [limit, offset] = pagination(filter.limit, filter.offset);
    values.push(limit, offset);
    const clause = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;

    return selectAll<TaskRow, Binding[]>(
      this.#database,
      `
        SELECT ${TASK_COLUMNS}
        FROM tasks t
        JOIN queues q ON q.id = t.queue_id
        ${clause}
        ORDER BY t.priority DESC, t.created_at, t.id
        LIMIT ? OFFSET ?
      `,
      values,
    ).map(mapTask);
  }

  updateTask(id: string, patch: UpdateTaskInput): Task {
    this.#requireTask(id);
    const fields: string[] = [];
    const values: Binding[] = [];
    const set = (column: string, value: Binding) => {
      fields.push(`${column} = ?`);
      values.push(value);
    };

    if (patch.title !== undefined) set("title", nonEmpty(patch.title, "task title"));
    if (patch.instructions !== undefined) set("instructions", patch.instructions);
    if (patch.acceptanceCriteria !== undefined) {
      set(
        "acceptance_criteria",
        JSON.stringify(stringArrayInput(patch.acceptanceCriteria, "acceptanceCriteria")),
      );
    }
    if (patch.provider !== undefined) set("provider", patch.provider);
    if (patch.priority !== undefined) set("priority", integerInput(patch.priority, "priority"));
    if (patch.status !== undefined) set("status", patch.status);
    if (patch.sourceKind !== undefined) set("source_kind", patch.sourceKind);
    if (patch.parentTaskId !== undefined) set("parent_task_id", patch.parentTaskId);
    if (patch.idempotencyKey !== undefined) {
      set(
        "idempotency_key",
        patch.idempotencyKey === null ? null : nonEmpty(patch.idempotencyKey, "idempotencyKey"),
      );
    }
    if (patch.currentRunId !== undefined) set("current_run_id", patch.currentRunId);
    if (patch.cancelRequestedAt !== undefined) {
      set("cancel_requested_at", patch.cancelRequestedAt);
    }
    if (patch.completedAt !== undefined) set("completed_at", patch.completedAt);
    if (patch.currentPhase !== undefined) set("current_phase", patch.currentPhase);
    if (patch.deliveryStatus !== undefined) set("delivery_status", patch.deliveryStatus);
    if (patch.blockedReason !== undefined) set("blocked_reason", patch.blockedReason);
    if (patch.failureClass !== undefined) {
      if (patch.failureClass === "integration_contention") {
        set("failure_class", null);
        set("delivery_failure_class", patch.failureClass);
      } else {
        set("failure_class", patch.failureClass);
        set("delivery_failure_class", null);
      }
    }
    if (patch.failureReason !== undefined) set("failure_reason", patch.failureReason);
    if (patch.retryDisposition !== undefined) {
      set("retry_disposition", patch.retryDisposition);
    }
    if (patch.resultRunId !== undefined) set("result_run_id", patch.resultRunId);
    if (patch.resultCommitSha !== undefined) set("result_commit_sha", patch.resultCommitSha);
    if (patch.changedFiles !== undefined) {
      set("changed_files", JSON.stringify(stringArrayInput(patch.changedFiles, "changedFiles")));
    }
    if (patch.verificationResults !== undefined) {
      set(
        "verification_results",
        JSON.stringify(
          verificationResults(
            JSON.stringify(patch.verificationResults),
            "task",
            id,
            "verificationResults",
          ),
        ),
      );
    }
    if (patch.integrationBranch !== undefined) {
      set("integration_branch", patch.integrationBranch);
    }
    if (patch.integratedSha !== undefined) set("integrated_sha", patch.integratedSha);
    if (patch.landedSha !== undefined) set("landed_sha", patch.landedSha);
    if (patch.integratedAt !== undefined) set("integrated_at", patch.integratedAt);
    if (patch.landedAt !== undefined) set("landed_at", patch.landedAt);
    if (patch.inputTokens !== undefined) {
      set("input_tokens", integerInput(patch.inputTokens, "inputTokens", 0));
    }
    if (patch.outputTokens !== undefined) {
      set("output_tokens", integerInput(patch.outputTokens, "outputTokens", 0));
    }
    if (patch.costUsd !== undefined) {
      if (!Number.isFinite(patch.costUsd) || patch.costUsd < 0) {
        throw new AgentQError("costUsd must be non-negative", "INVALID_INPUT", 2);
      }
      set("cost_usd", patch.costUsd);
    }

    if (fields.length === 0) return this.#requireTask(id);

    set("updated_at", isoNow());
    values.push(id);
    try {
      this.#database.run(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`, values);
    } catch (error) {
      constraint(
        error,
        "Task update violates a uniqueness or reference constraint",
        "INVALID_TASK",
      );
    }
    return this.#requireTask(id);
  }

  editTask(id: string, patch: EditTaskInput, expectedUpdatedAt?: string): Task {
    const fields: string[] = [];
    const values: Binding[] = [];
    const editedFields: string[] = [];
    const set = (field: string, column: string, value: Binding) => {
      editedFields.push(field);
      fields.push(`${column} = ?`);
      values.push(value);
    };

    if (patch.title !== undefined) set("title", "title", nonEmpty(patch.title, "task title"));
    if (patch.instructions !== undefined) {
      set("instructions", "instructions", patch.instructions);
    }
    if (patch.acceptanceCriteria !== undefined) {
      set(
        "acceptanceCriteria",
        "acceptance_criteria",
        JSON.stringify(stringArrayInput(patch.acceptanceCriteria, "acceptanceCriteria")),
      );
    }
    if (patch.objective !== undefined) {
      set("objective", "objective", nonEmpty(patch.objective, "objective"));
    }
    for (const [field, column] of [
      ["invariants", "invariants"],
      ["handoffRequirements", "handoff_requirements"],
      ["expectedPaths", "expected_paths"],
      ["allowedPaths", "allowed_paths"],
      ["deniedPaths", "denied_paths"],
      ["verifyCommands", "verify_commands"],
      ["approvalCheckpoints", "approval_checkpoints"],
    ] as const) {
      const value = patch[field];
      if (value !== undefined) {
        const checked =
          field === "expectedPaths" || field === "allowedPaths" || field === "deniedPaths"
            ? scopePatternArrayInput(value, field)
            : stringArrayInput(value, field);
        set(field, column, JSON.stringify(checked));
      }
    }
    if (patch.maxChangedFiles !== undefined) {
      set(
        "maxChangedFiles",
        "max_changed_files",
        patch.maxChangedFiles === null
          ? null
          : integerInput(patch.maxChangedFiles, "maxChangedFiles", 1),
      );
    }
    if (patch.baseDriftPolicy !== undefined) {
      set("baseDriftPolicy", "base_drift_policy", patch.baseDriftPolicy);
    }
    if (patch.landStrategy !== undefined) {
      set("landStrategy", "land_strategy", patch.landStrategy);
    }
    if (patch.createdBaseSha !== undefined) {
      set("createdBaseSha", "created_base_sha", nonEmpty(patch.createdBaseSha, "createdBaseSha"));
    }
    if (patch.provider !== undefined) {
      // A queued resume is provider-specific. Preserve it only when an edit
      // keeps the provider unchanged; switching providers must start fresh.
      fields.push("resume_run_id = CASE WHEN provider = ? THEN resume_run_id ELSE NULL END");
      values.push(patch.provider);
      set("provider", "provider", patch.provider);
    }
    if (patch.priority !== undefined) {
      set("priority", "priority", integerInput(patch.priority, "priority"));
    }
    const hasDependencyPatch = patch.blockedBy !== undefined;
    if (fields.length === 0 && !hasDependencyPatch) {
      throw new AgentQError("A task edit must change at least one field", "INVALID_INPUT", 2);
    }
    const expected =
      expectedUpdatedAt === undefined
        ? undefined
        : nonEmpty(expectedUpdatedAt, "expectedUpdatedAt");

    const edit = this.#database.transaction(() => {
      const before = this.#requireTask(id);
      const editedAt = nextUpdatedAt(before.updatedAt);
      const updateFields = [...fields, "updated_at = ?"];
      const bindings: Binding[] = [...values, editedAt, id];
      const versionClause = expected === undefined ? "" : "AND updated_at = ?";
      if (expected !== undefined) bindings.push(expected);

      let changed: number;
      try {
        changed = this.#database.run(
          `
            UPDATE tasks
            SET ${updateFields.join(", ")}
            WHERE id = ?
              AND current_run_id IS NULL
              AND status IN ('queued', 'failed', 'interrupted', 'cancelled')
              ${versionClause}
          `,
          bindings,
        ).changes;
      } catch (error) {
        constraint(error, "Task edit contains an invalid value", "INVALID_TASK");
      }

      if (changed !== 1) {
        const current = this.#requireTask(id);
        if (
          current.currentRunId ||
          !["queued", "failed", "interrupted", "cancelled"].includes(current.status)
        ) {
          throw new AgentQError(
            `Task ${id} cannot be edited while it is ${current.status}`,
            "TASK_NOT_EDITABLE",
          );
        }
        throw new AgentQError(
          `Task ${id} changed after editing began; reload it and try again`,
          "TASK_EDIT_CONFLICT",
        );
      }

      if (patch.blockedBy !== undefined) {
        editedFields.push("blockedBy");
        this.#replaceTaskDependencies(id, patch.blockedBy, editedAt);
      }
      this.appendEvent({
        taskId: id,
        kind: "task.edited",
        payload: { fields: editedFields, previousUpdatedAt: before.updatedAt },
        createdAt: editedAt,
      });
      return this.#requireTask(id);
    });

    return edit.immediate();
  }

  completeTaskManually(id: string, summary: string, at?: string): Task {
    const complete = this.#database.transaction(() => {
      const task = this.#requireTask(id);
      if (!canCompleteTaskManually(task.status) || task.currentRunId) {
        if (isTaskActive(task.status) || task.currentRunId) {
          throw new AgentQError(
            "Cancel the running task before completing it manually",
            "TASK_IS_RUNNING",
          );
        }
        throw new AgentQError(`Task ${id} is already complete`, "TASK_ALREADY_COMPLETE");
      }

      const completedAt = timestamp(at, "manual completion timestamp");
      const changed = this.#database.run(
        `
          UPDATE tasks
          SET status = 'succeeded', completed_at = ?, cancel_requested_at = NULL,
              current_phase = 'complete', delivery_status = 'verified',
              failure_class = NULL, failure_reason = NULL, retry_disposition = NULL,
              updated_at = ?
          WHERE id = ?
            AND current_run_id IS NULL
            AND status IN ('queued', 'failed', 'interrupted', 'cancelled')
        `,
        [completedAt, completedAt, id],
      ).changes;
      if (changed !== 1) {
        throw new AgentQError(
          "Cancel the running task before completing it manually",
          "TASK_IS_RUNNING",
        );
      }
      this.appendEvent({
        taskId: id,
        kind: "manual.completed",
        payload: { summary },
        createdAt: completedAt,
      });
      return this.#requireTask(id);
    });
    return complete.immediate();
  }

  deleteTask(id: string): boolean {
    const remove = this.#database.transaction(() => {
      const task = this.getTask(id);
      if (!task) return false;
      if (task.currentRunId || ["starting", "running", "cancelling"].includes(task.status)) {
        throw new AgentQError(`Cannot delete active task ${id}`, "TASK_ACTIVE");
      }

      const activeRun = selectOne<{ id: string }, [string]>(
        this.#database,
        `
          SELECT id
          FROM runs
          WHERE task_id = ? AND status IN ('starting', 'running', 'cancelling')
          LIMIT 1
        `,
        [id],
      );
      if (activeRun) {
        throw new AgentQError(`Cannot delete active task ${id}`, "TASK_ACTIVE");
      }

      const retainedWorktree = selectOne<{ id: string }, [string]>(
        this.#database,
        "SELECT id FROM runs WHERE task_id = ? AND worktree_path IS NOT NULL LIMIT 1",
        [id],
      );
      if (retainedWorktree) {
        throw new AgentQError(
          `Clean retained worktrees before deleting task ${id}`,
          "TASK_HAS_WORKTREE",
        );
      }

      const dependentTask = selectOne<{ id: string }, [string]>(
        this.#database,
        "SELECT id FROM tasks WHERE parent_task_id = ? LIMIT 1",
        [id],
      );
      if (dependentTask) {
        throw new AgentQError(
          `Delete dependent task ${dependentTask.id} before deleting parent task ${id}`,
          "TASK_HAS_CHILDREN",
        );
      }

      const graphDependent = selectOne<{ task_id: string }, [string]>(
        this.#database,
        "SELECT task_id FROM task_dependencies WHERE blocker_task_id = ? LIMIT 1",
        [id],
      );
      if (graphDependent) {
        throw new AgentQError(
          `Delete dependent task ${graphDependent.task_id} before deleting blocker task ${id}`,
          "TASK_HAS_DEPENDENTS",
        );
      }

      const changed = this.#database.run(
        `
          DELETE FROM tasks
          WHERE id = ?
            AND current_run_id IS NULL
            AND status NOT IN ('starting', 'running', 'cancelling')
            AND NOT EXISTS (
              SELECT 1
              FROM runs
              WHERE task_id = ? AND status IN ('starting', 'running', 'cancelling')
            )
            AND NOT EXISTS (
              SELECT 1 FROM runs WHERE task_id = ? AND worktree_path IS NOT NULL
            )
            AND NOT EXISTS (
              SELECT 1 FROM tasks child WHERE child.parent_task_id = ?
            )
            AND NOT EXISTS (
              SELECT 1 FROM task_dependencies dependency WHERE dependency.blocker_task_id = ?
            )
        `,
        [id, id, id, id, id],
      ).changes;
      // Bun reports cascaded run/event deletions in `changes`, so only zero
      // means the guarded task row was not removed.
      if (changed < 1) {
        throw new AgentQError(`Cannot delete active task ${id}`, "TASK_ACTIVE");
      }
      return true;
    });

    return remove.immediate();
  }

  requestCancellation(id: string, at?: string): Task {
    const cancel = this.#database.transaction(() => {
      const task = this.#requireTask(id);
      if (TERMINAL_TASK_STATUSES.includes(task.status as (typeof TERMINAL_TASK_STATUSES)[number])) {
        return task;
      }

      const requestedAt = timestamp(at, "cancellation timestamp");
      if (task.status === "queued") {
        this.#database.run(
          `
            UPDATE tasks
            SET status = 'cancelled', cancel_requested_at = ?, completed_at = ?, updated_at = ?
            WHERE id = ?
          `,
          [requestedAt, requestedAt, requestedAt, id],
        );
      } else {
        this.#database.run(
          `
            UPDATE tasks
            SET status = 'cancelling', cancel_requested_at = ?, updated_at = ?
            WHERE id = ?
          `,
          [requestedAt, requestedAt, id],
        );
        if (task.currentRunId) {
          this.#database.run(
            `
              UPDATE runs
              SET status = 'cancelling'
              WHERE id = ? AND status IN ('starting', 'running', 'cancelling')
            `,
            [task.currentRunId],
          );
        }
      }
      return this.#requireTask(id);
    });
    return cancel.immediate();
  }

  requeueTask(id: string, at?: string, resumeRunId: string | null = null): Task {
    const requeue = this.#database.transaction(() => {
      const task = this.#requireTask(id);
      const canRequeue =
        resumeRunId === null ? canRetryTask(task.status) : !isTaskActive(task.status);
      if (!canRequeue || task.currentRunId) {
        throw new AgentQError(
          `Cannot requeue task ${id} while it is ${task.status}`,
          "TASK_NOT_RETRYABLE",
        );
      }
      if (resumeRunId !== null) {
        const resumeRun = this.#requireRun(resumeRunId);
        const hasResumableStage =
          resumeRun.phase === "plan"
            ? Boolean(resumeRun.planSessionId)
            : Boolean(resumeRun.planOutput);
        if (
          resumeRun.taskId !== task.id ||
          resumeRun.provider !== task.provider ||
          !hasResumableStage ||
          !resumeRun.worktreePath ||
          !resumeRun.branchName ||
          !resumeRun.baseSha
        ) {
          throw new AgentQError(`Run ${resumeRunId} cannot be resumed`, "RUN_NOT_RESUMABLE");
        }
      }
      const updatedAt = timestamp(at, "requeue timestamp");
      this.#database.run(
        `
          UPDATE tasks
          SET status = 'queued', attempt_count = 0, current_run_id = NULL,
              cancel_requested_at = NULL, completed_at = NULL, resume_run_id = ?, updated_at = ?
          WHERE id = ?
        `,
        [resumeRunId, updatedAt, id],
      );
      return this.#requireTask(id);
    });
    return requeue.immediate();
  }

  consumeResumeIntent(
    taskId: string,
    currentRunId: string,
    resumeRunId: string,
    leaseToken?: string,
  ): Task {
    const consume = this.#database.transaction(() => {
      this.#assertRunLease(currentRunId, leaseToken);
      const changed = this.#database.run(
        `
          UPDATE tasks
          SET resume_run_id = NULL, updated_at = ?
          WHERE id = ? AND current_run_id = ? AND resume_run_id = ?
        `,
        [isoNow(), taskId, currentRunId, resumeRunId],
      ).changes;
      if (changed !== 1) {
        throw new AgentQError(
          `Resume intent for task ${taskId} is no longer active`,
          "RESUME_LOST",
        );
      }
      return this.#requireTask(taskId);
    });
    return consume.immediate();
  }

  claimNextTask(options: ClaimOptions = {}): TaskClaim | undefined {
    const claim = this.#database.transaction(() => {
      const repoKey =
        options.repoKey === undefined ? undefined : nonEmpty(options.repoKey, "repoKey");
      const queueId =
        options.queue === undefined ? undefined : this.#requireQueue(options.queue, repoKey).id;
      const now = timestamp(options.now, "claim timestamp");
      const queueClause = queueId === undefined ? "" : "AND t.queue_id = ?";
      const repoClause = repoKey === undefined ? "" : "AND q.repo_key = ?";
      const bindings: Binding[] = [];
      if (queueId !== undefined) bindings.push(queueId);
      if (repoKey !== undefined) bindings.push(repoKey);
      const maxConcurrency =
        options.maxConcurrency === undefined
          ? undefined
          : integerInput(options.maxConcurrency, "maxConcurrency", 1);
      const globalClause =
        maxConcurrency === undefined
          ? ""
          : `AND (
              SELECT COUNT(*)
              FROM runs global_active_run
              WHERE global_active_run.status IN ('starting', 'running', 'cancelling')
            ) < ?`;
      if (maxConcurrency !== undefined) bindings.push(maxConcurrency);

      const candidates = selectAll<TaskRow, Binding[]>(
        this.#database,
        `
          SELECT ${TASK_COLUMNS}
          FROM tasks t
          JOIN queues q ON q.id = t.queue_id
          WHERE t.status = 'queued'
            AND t.cancel_requested_at IS NULL
            AND t.attempt_count < q.max_attempts
            AND NOT EXISTS (
              SELECT 1
              FROM task_approvals approval
              WHERE approval.task_id = t.id
                AND approval.status = 'pending'
            )
            AND NOT EXISTS (
              SELECT 1
              FROM task_dependencies dependency
              JOIN tasks blocker ON blocker.id = dependency.blocker_task_id
              WHERE dependency.task_id = t.id
                AND (
                  blocker.status <> 'succeeded'
                  OR blocker.delivery_status NOT IN (
                    'ready_to_integrate', 'integrated', 'landed'
                  )
                  OR blocker.result_run_id IS NULL
                  OR blocker.result_commit_sha IS NULL
                )
            )
            AND (
              (SELECT COUNT(*) FROM task_dependencies dependency WHERE dependency.task_id = t.id)
                <= 1
              OR (
                NOT EXISTS (
                  SELECT 1
                  FROM task_dependencies dependency
                  JOIN tasks blocker ON blocker.id = dependency.blocker_task_id
                  WHERE dependency.task_id = t.id
                    AND COALESCE(blocker.landed_sha, blocker.integrated_sha) IS NULL
                )
                AND (
                  SELECT COUNT(DISTINCT COALESCE(blocker.landed_sha, blocker.integrated_sha))
                  FROM task_dependencies dependency
                  JOIN tasks blocker ON blocker.id = dependency.blocker_task_id
                  WHERE dependency.task_id = t.id
                ) = 1
              )
            )
            ${queueClause}
            ${repoClause}
            ${globalClause}
            AND (
              SELECT COUNT(*)
              FROM runs active_run
              JOIN tasks active_task ON active_task.id = active_run.task_id
              WHERE active_task.queue_id = t.queue_id
                AND active_run.status IN ('starting', 'running', 'cancelling')
            ) < q.concurrency
          ORDER BY t.priority DESC, t.created_at, t.id
        `,
        bindings,
      );
      const candidate = candidates.find((row) => {
        const candidateTask = mapTask(row);
        const candidateQueue = this.#requireQueue(candidateTask.queueId);
        return this.#fileConcurrencyAllows(candidateTask, candidateQueue);
      });

      if (!candidate) return undefined;

      const task = mapTask(candidate);
      const queue = this.#requireQueue(task.queueId);
      const dependencyTasks = this.listTaskDependencies(task.id);
      const dependencySnapshot: TaskDependencySnapshot[] = dependencyTasks.map((blocker) => {
        if (!blocker.resultRunId || !blocker.resultCommitSha) {
          throw new AgentQError(
            `Task ${task.id} was claimed before blocker ${blocker.id} produced a result`,
            "CLAIM_DEPENDENCY_CONFLICT",
          );
        }
        return {
          taskId: blocker.id,
          runId: blocker.resultRunId,
          resultCommitSha: blocker.resultCommitSha,
          deliveryStatus: blocker.deliveryStatus,
          ...(blocker.integratedSha === undefined ? {} : { integratedSha: blocker.integratedSha }),
          ...(blocker.landedSha === undefined ? {} : { landedSha: blocker.landedSha }),
        };
      });
      const dependencyBaseSha =
        dependencySnapshot.length === 1
          ? dependencySnapshot[0]?.resultCommitSha
          : dependencySnapshot.length > 1
            ? (dependencySnapshot[0]?.landedSha ?? dependencySnapshot[0]?.integratedSha)
            : undefined;
      const claimBaseSha =
        dependencyBaseSha ??
        (task.failureClass === "test_regression" &&
        task.retryDisposition === "return_to_implementation"
          ? task.createdBaseSha
          : undefined);
      // attempt_count is the retry budget for the current enqueue cycle and is
      // reset by an explicit retry. Run attempt numbers are permanent history,
      // so derive them from prior runs to preserve the unique (task, attempt)
      // invariant across manual retries and session resumes.
      const attemptNo =
        selectOne<{ next_attempt: number }, [string]>(
          this.#database,
          `
            SELECT COALESCE(MAX(attempt_no), 0) + 1 AS next_attempt
            FROM runs
            WHERE task_id = ?
          `,
          [task.id],
        )?.next_attempt ?? 1;
      const attemptCount = task.attemptCount + 1;
      const runId = makeId("run");
      const ownerToken =
        options.ownerToken === undefined ? null : nonEmpty(options.ownerToken, "ownerToken");
      const ownerPid =
        options.ownerPid === undefined ? null : integerInput(options.ownerPid, "ownerPid", 1);
      const useConfiguredModels = task.provider === queue.defaultProvider;
      const currentSnapshot: TaskSpecSnapshot = {
        title: task.title,
        instructions: task.instructions,
        acceptanceCriteria: [...task.acceptanceCriteria],
        objective: task.objective,
        invariants: [...task.invariants],
        handoffRequirements: [...task.handoffRequirements],
        blockedBy: [...task.blockedBy],
        expectedPaths: [...task.expectedPaths],
        allowedPaths: [...task.allowedPaths],
        deniedPaths: [...task.deniedPaths],
        ...(task.maxChangedFiles === undefined ? {} : { maxChangedFiles: task.maxChangedFiles }),
        verifyCommands: [...task.verifyCommands],
        approvalCheckpoints: [...task.approvalCheckpoints],
        baseDriftPolicy: task.baseDriftPolicy,
        landStrategy: task.landStrategy,
        ...(task.createdBaseSha === undefined ? {} : { createdBaseSha: task.createdBaseSha }),
        dependencies: dependencySnapshot,
        provider: task.provider,
        priority: task.priority,
        workflow: {
          planModel: useConfiguredModels ? queue.planModel : "",
          planInstructions: queue.planInstructions,
          implementModel: useConfiguredModels ? queue.implementModel : "",
          implementInstructions: queue.implementInstructions,
          allowedPaths: [...queue.allowedPaths],
          deniedPaths: [...queue.deniedPaths],
          ...(queue.maxChangedFiles === undefined
            ? {}
            : { maxChangedFiles: queue.maxChangedFiles }),
          verifyCommands: [...queue.verifyCommands],
          approvalCheckpoints: [...queue.approvalCheckpoints],
          baseDriftPolicy: queue.baseDriftPolicy,
          landStrategy: queue.landStrategy,
          autoLand: queue.autoLand,
          fileConcurrency: queue.fileConcurrency,
        },
      };
      const resumeCandidate = task.resumeRunId ? this.#requireRun(task.resumeRunId) : undefined;
      const resumedRun =
        resumeCandidate &&
        resumeCandidate.taskId === task.id &&
        resumeCandidate.provider === task.provider &&
        resumeCandidate.worktreePath &&
        resumeCandidate.branchName &&
        resumeCandidate.baseSha &&
        resumeCandidate.taskSnapshot?.workflow &&
        (resumeCandidate.phase === "plan"
          ? resumeCandidate.planSessionId
          : resumeCandidate.planOutput)
          ? resumeCandidate
          : undefined;
      const snapshot = resumedRun?.taskSnapshot ?? currentSnapshot;
      const phase = resumedRun?.phase ?? "plan";
      const planOutput = resumedRun?.planOutput ?? null;
      const planSessionId = resumedRun?.planSessionId ?? null;

      this.#database.run(
        `
          INSERT INTO runs(
            id, task_id, attempt_no, provider, status, phase, owner_token, owner_pid,
            task_snapshot, dependency_snapshot, base_sha, plan_output, plan_session_id,
            started_at, heartbeat_at
          ) VALUES (?, ?, ?, ?, 'starting', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          runId,
          task.id,
          attemptNo,
          task.provider,
          phase,
          ownerToken,
          ownerPid,
          JSON.stringify(snapshot),
          JSON.stringify(dependencySnapshot),
          claimBaseSha ?? null,
          planOutput,
          planSessionId,
          now,
          now,
        ],
      );

      const changed = this.#database.run(
        `
          UPDATE tasks
          SET status = 'starting', attempt_count = ?, current_run_id = ?,
              resume_run_id = ?, current_phase = ?, blocked_reason = NULL, updated_at = ?
          WHERE id = ? AND status = 'queued'
        `,
        [
          attemptCount,
          runId,
          resumedRun?.id ?? null,
          phase === "plan" ? "plan" : "implement",
          now,
          task.id,
        ],
      ).changes;

      if (changed !== 1) {
        throw new AgentQError(`Task ${task.id} could not be claimed`, "CLAIM_CONFLICT");
      }

      return {
        queue,
        task: this.#requireTask(task.id),
        run: this.#requireRun(runId),
        ...(ownerToken === null ? {} : { leaseToken: ownerToken }),
      };
    });

    return claim.immediate();
  }

  getRun(id: string): Run | undefined {
    const row = selectOne<RunRow, [string]>(
      this.#database,
      `SELECT ${RUN_COLUMNS} FROM runs r WHERE r.id = ?`,
      [id],
    );
    return row ? mapRun(row) : undefined;
  }

  listRuns(filter: RunFilter = {}): Run[] {
    const where: string[] = [];
    const values: Binding[] = [];
    let join = "";

    if (filter.taskId !== undefined) {
      where.push("r.task_id = ?");
      values.push(filter.taskId);
    }
    if (filter.queue !== undefined) {
      join = "JOIN tasks run_task ON run_task.id = r.task_id";
      where.push("run_task.queue_id = ?");
      values.push(this.#requireQueue(filter.queue).id);
    }
    if (filter.status !== undefined && filter.statuses !== undefined) {
      throw new AgentQError("Use either status or statuses, not both", "INVALID_INPUT", 2);
    }
    const statuses = statusValues(filter.status ?? filter.statuses, "status");
    if (statuses.length > 0) {
      where.push(`r.status IN (${statuses.map(() => "?").join(", ")})`);
      values.push(...statuses);
    }
    const [limit, offset] = pagination(filter.limit, filter.offset);
    values.push(limit, offset);
    const clause = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
    const orderBy =
      filter.taskId === undefined
        ? "r.started_at DESC, r.attempt_no DESC, r.id DESC"
        : "r.attempt_no DESC, r.started_at DESC, r.id DESC";

    return selectAll<RunRow, Binding[]>(
      this.#database,
      `
        SELECT ${RUN_COLUMNS}
        FROM runs r
        ${join}
        ${clause}
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?
      `,
      values,
    ).map(mapRun);
  }

  recordWorktreeRemoval(
    runId: string,
    expectedWorktreePath: string,
    force = false,
    at?: string,
  ): Run {
    const record = this.#database.transaction(() => {
      const run = this.#requireRun(runId);
      const worktreePath = nonEmpty(expectedWorktreePath, "worktreePath");
      if (!run.worktreePath) return run;
      if (run.worktreePath !== worktreePath) {
        throw new AgentQError(`Run ${runId} retained a different worktree`, "WORKTREE_CHANGED");
      }

      const removedAt = timestamp(at, "worktree removal timestamp");
      const changed = this.#database.run(
        `
          UPDATE runs
          SET worktree_path = NULL
          WHERE id = ? AND worktree_path = ?
        `,
        [runId, worktreePath],
      ).changes;
      if (changed !== 1) {
        throw new AgentQError(
          `Run ${runId} worktree changed before cleanup completed`,
          "WORKTREE_CHANGED",
        );
      }

      const task = this.#requireTask(run.taskId);
      this.#database.run(
        `
          UPDATE tasks
          SET resume_run_id = NULL, updated_at = ?
          WHERE id = ? AND resume_run_id = ?
        `,
        [nextUpdatedAt(task.updatedAt), task.id, run.id],
      );
      this.appendEvent({
        taskId: run.taskId,
        runId,
        kind: "task.worktree_removed",
        payload: { worktreePath, force },
        createdAt: removedAt,
      });
      return this.#requireRun(runId);
    });
    return record.immediate();
  }

  updateRun(id: string, patch: UpdateRunInput, leaseToken?: string): Run {
    const update = this.#database.transaction(() => {
      // Keep the lease check and guarded write under one IMMEDIATE lock so a
      // fenced supervisor can never report a metadata update as successful.
      this.#assertRunLease(id, leaseToken);
      const evidenceMutation =
        patch.resultCommitSha !== undefined ||
        patch.changedFiles !== undefined ||
        patch.verificationResults !== undefined ||
        patch.failureClass !== undefined ||
        patch.retryDisposition !== undefined ||
        patch.inputTokens !== undefined ||
        patch.outputTokens !== undefined ||
        patch.costUsd !== undefined;
      const current = this.#requireRun(id);
      if (
        evidenceMutation &&
        !ACTIVE_RUN_STATUSES.includes(current.status as (typeof ACTIVE_RUN_STATUSES)[number])
      ) {
        throw new AgentQError(
          `Run ${id} result evidence is immutable after completion`,
          "RUN_EVIDENCE_IMMUTABLE",
        );
      }
      const fields: string[] = [];
      const values: Binding[] = [];
      const set = (column: string, value: Binding) => {
        fields.push(`${column} = ?`);
        values.push(value);
      };

      if (patch.status !== undefined) set("status", patch.status);
      if (patch.baseSha !== undefined) set("base_sha", patch.baseSha);
      if (patch.branchName !== undefined) set("branch_name", patch.branchName);
      if (patch.worktreePath !== undefined) set("worktree_path", patch.worktreePath);
      if (patch.providerSessionId !== undefined) {
        set("provider_session_id", patch.providerSessionId);
      }
      if (patch.planSessionId !== undefined) set("plan_session_id", patch.planSessionId);
      if (patch.pid !== undefined) {
        set("pid", patch.pid === null ? null : integerInput(patch.pid, "pid", 1));
      }
      if (patch.processToken !== undefined) set("process_token", patch.processToken);
      if (patch.processStartMarker !== undefined) {
        set("process_start_marker", patch.processStartMarker);
      }
      if (patch.processIdentityPath !== undefined) {
        set("process_identity_path", patch.processIdentityPath);
      }
      if (patch.summary !== undefined) set("summary", patch.summary);
      if (patch.error !== undefined) set("error", patch.error);
      if (patch.logPath !== undefined) set("log_path", patch.logPath);
      if (patch.resultCommitSha !== undefined) {
        set("result_commit_sha", patch.resultCommitSha);
      }
      if (patch.changedFiles !== undefined) {
        set("changed_files", JSON.stringify(stringArrayInput(patch.changedFiles, "changedFiles")));
      }
      if (patch.verificationResults !== undefined) {
        set(
          "verification_results",
          JSON.stringify(
            verificationResults(
              JSON.stringify(patch.verificationResults),
              "run",
              id,
              "verificationResults",
            ),
          ),
        );
      }
      if (patch.failureClass !== undefined) {
        if (patch.failureClass === "integration_contention") {
          set("failure_class", null);
          set("delivery_failure_class", patch.failureClass);
        } else {
          set("failure_class", patch.failureClass);
          set("delivery_failure_class", null);
        }
      }
      if (patch.retryDisposition !== undefined) {
        set("retry_disposition", patch.retryDisposition);
      }
      if (patch.inputTokens !== undefined) {
        set("input_tokens", integerInput(patch.inputTokens, "inputTokens", 0));
      }
      if (patch.outputTokens !== undefined) {
        set("output_tokens", integerInput(patch.outputTokens, "outputTokens", 0));
      }
      if (patch.costUsd !== undefined) {
        if (!Number.isFinite(patch.costUsd) || patch.costUsd < 0) {
          throw new AgentQError("costUsd must be non-negative", "INVALID_INPUT", 2);
        }
        set("cost_usd", patch.costUsd);
      }

      if (fields.length === 0) return this.#requireRun(id);
      values.push(id);
      if (leaseToken !== undefined) values.push(leaseToken);
      const activeCondition =
        patch.status === undefined && !evidenceMutation
          ? ""
          : " AND status IN ('starting', 'running', 'cancelling')";
      const leaseCondition = leaseToken === undefined ? "" : " AND owner_token = ?";
      const changed = this.#database.run(
        `UPDATE runs SET ${fields.join(", ")} WHERE id = ?${activeCondition}${leaseCondition}`,
        values,
      ).changes;

      if (changed !== 1) {
        if (leaseToken !== undefined) {
          throw new AgentQError(`Run ${id} lease was lost`, "RUN_LEASE_LOST");
        }
        throw new AgentQError(`Run ${id} is already terminal`, "RUN_NOT_ACTIVE");
      }

      return this.#requireRun(id);
    });
    return update.immediate();
  }

  markRunRunning(id: string, input: MarkRunRunningInput = {}, leaseToken?: string): Run {
    const mark = this.#database.transaction(() => {
      this.#assertRunLease(id, leaseToken);
      const run = this.#requireRun(id);
      if (!ACTIVE_RUN_STATUSES.includes(run.status as (typeof ACTIVE_RUN_STATUSES)[number])) {
        throw new AgentQError(`Run ${id} is already terminal`, "RUN_NOT_ACTIVE");
      }
      const task = this.#requireTask(run.taskId);
      const at = timestamp(input.at, "run timestamp");
      const status: RunStatus =
        run.status === "cancelling" || task.cancelRequestedAt ? "cancelling" : "running";

      const fields = ["status = ?", "heartbeat_at = ?"];
      const values: Binding[] = [status, at];
      const optionalFields: [keyof UpdateRunInput, string][] = [
        ["baseSha", "base_sha"],
        ["branchName", "branch_name"],
        ["worktreePath", "worktree_path"],
        ["providerSessionId", "provider_session_id"],
        ["planSessionId", "plan_session_id"],
        ["pid", "pid"],
        ["processToken", "process_token"],
        ["processStartMarker", "process_start_marker"],
        ["processIdentityPath", "process_identity_path"],
        ["summary", "summary"],
        ["error", "error"],
        ["logPath", "log_path"],
      ];
      for (const [key, column] of optionalFields) {
        const value = input[key];
        if (value !== undefined) {
          fields.push(`${column} = ?`);
          values.push(value as Binding);
        }
      }
      values.push(id);
      if (leaseToken !== undefined) values.push(leaseToken);
      const leaseCondition = leaseToken === undefined ? "" : " AND owner_token = ?";
      const changed = this.#database.run(
        `UPDATE runs SET ${fields.join(", ")} WHERE id = ? AND status IN ('starting', 'running', 'cancelling')${leaseCondition}`,
        values,
      ).changes;
      if (changed !== 1) throw new AgentQError(`Run ${id} lease was lost`, "RUN_LEASE_LOST");

      if (task.currentRunId === id) {
        this.#database.run(
          `
            UPDATE tasks
            SET status = ?, current_phase = ?, updated_at = ?
            WHERE id = ?
          `,
          [status, run.phase === "plan" ? "plan" : "implement", at, task.id],
        );
      }
      return this.#requireRun(id);
    });
    return mark.immediate();
  }

  heartbeatRun(id: string, at?: string, leaseToken?: string): Run {
    const heartbeatAt = timestamp(at, "heartbeat timestamp");
    const bindings: Binding[] = [heartbeatAt, id];
    if (leaseToken !== undefined) bindings.push(leaseToken);
    const leaseCondition = leaseToken === undefined ? "" : " AND owner_token = ?";
    const changes = this.#database.run(
      `
        UPDATE runs
        SET heartbeat_at = ?
        WHERE id = ? AND status IN ('starting', 'running', 'cancelling')
          ${leaseCondition}
      `,
      bindings,
    ).changes;
    if (changes === 0) {
      const run = this.getRun(id);
      if (!run) throw new AgentQError(`Run ${id} does not exist`, "RUN_NOT_FOUND");
      throw new AgentQError(`Run ${id} is already terminal`, "RUN_NOT_ACTIVE");
    }
    return this.#requireRun(id);
  }

  advanceRunToImplementation(
    id: string,
    input: AdvanceRunToImplementationInput,
    leaseToken?: string,
  ): Run {
    const advance = this.#database.transaction(() => {
      this.#assertRunLease(id, leaseToken);
      const run = this.#requireRun(id);
      if (!ACTIVE_RUN_STATUSES.includes(run.status as (typeof ACTIVE_RUN_STATUSES)[number])) {
        throw new AgentQError(`Run ${id} is already terminal`, "RUN_NOT_ACTIVE");
      }
      const task = this.#requireTask(run.taskId);
      if (run.status === "cancelling" || task.cancelRequestedAt) {
        throw new AgentQError(`Run ${id} is being cancelled`, "RUN_CANCELLING");
      }
      if (run.phase !== "plan") {
        throw new AgentQError(`Run ${id} is already in implementation`, "RUN_PHASE_CHANGED");
      }
      const planOutput = nonEmpty(input.planOutput, "planOutput");
      if (planOutput.length > MAX_PLAN_OUTPUT_LENGTH) {
        throw new AgentQError(
          `planOutput cannot exceed ${MAX_PLAN_OUTPUT_LENGTH} characters`,
          "INVALID_INPUT",
          2,
        );
      }
      const planSessionId = input.planSessionId?.trim() || null;
      const bindings: Binding[] = [planOutput, planSessionId, isoNow(), id];
      if (leaseToken !== undefined) bindings.push(leaseToken);
      const leaseCondition = leaseToken === undefined ? "" : " AND owner_token = ?";
      const changed = this.#database.run(
        `
          UPDATE runs
          SET phase = 'implement', plan_output = ?,
              plan_session_id = COALESCE(?, plan_session_id),
              provider_session_id = NULL, pid = NULL, process_token = NULL,
              process_start_marker = NULL, process_identity_path = NULL,
              heartbeat_at = ?
          WHERE id = ? AND phase = 'plan'
            AND status IN ('starting', 'running')${leaseCondition}
        `,
        bindings,
      ).changes;
      if (changed !== 1) {
        throw new AgentQError(`Run ${id} phase or lease changed`, "RUN_PHASE_CHANGED");
      }
      this.#database.run(
        `
          UPDATE tasks
          SET current_phase = 'implement', updated_at = ?
          WHERE id = ? AND current_run_id = ?
        `,
        [isoNow(), task.id, id],
      );
      return this.#requireRun(id);
    });
    return advance.immediate();
  }

  finishRun(id: string, input: FinishRunInput, leaseToken?: string): FinishedRun {
    const finish = this.#database.transaction(() => {
      const run = this.#requireRun(id);
      const task = this.#requireTask(run.taskId);
      if (!ACTIVE_RUN_STATUSES.includes(run.status as (typeof ACTIVE_RUN_STATUSES)[number])) {
        return { run, task };
      }
      this.#assertRunLease(id, leaseToken);

      const queue = this.#requireQueue(task.queueId);
      const finishedAt = timestamp(input.finishedAt, "finishedAt");
      const wasCancelled = input.status === "cancelled" || task.cancelRequestedAt !== undefined;
      const runStatus: RunStatus = wasCancelled ? "cancelled" : input.status;
      const failureClass: FailureClass | undefined =
        runStatus === "succeeded"
          ? undefined
          : (input.failureClass ??
            (wasCancelled
              ? "cancelled"
              : runStatus === "failed"
                ? "agent_failure"
                : "transient_infrastructure"));
      const retryDisposition =
        failureClass === undefined
          ? undefined
          : (input.retryDisposition ?? retryDispositionFor(failureClass));
      const changedFiles = stringArrayInput(input.changedFiles ?? [], "changedFiles");
      const checkedVerificationResults = verificationResults(
        JSON.stringify(input.verificationResults ?? []),
        "run",
        id,
        "verificationResults",
      );
      const inputTokens = integerInput(input.inputTokens ?? 0, "inputTokens", 0);
      const outputTokens = integerInput(input.outputTokens ?? 0, "outputTokens", 0);
      const costUsd = finiteNumberValue(input.costUsd ?? 0, "run", id, "costUsd");
      if (costUsd < 0) {
        throw new AgentQError("costUsd must be non-negative", "INVALID_INPUT", 2);
      }

      this.#database.run(
        `
          UPDATE runs
          SET status = ?, heartbeat_at = ?, finished_at = ?, exit_code = ?,
              summary = ?, error = ?, provider_session_id = COALESCE(?, provider_session_id),
              result_commit_sha = ?, changed_files = ?, verification_results = ?,
              failure_class = ?, delivery_failure_class = ?,
              retry_disposition = ?, input_tokens = ?,
              output_tokens = ?, cost_usd = ?
          WHERE id = ?
        `,
        [
          runStatus,
          finishedAt,
          finishedAt,
          input.exitCode ?? null,
          input.summary ?? null,
          input.error ?? null,
          input.providerSessionId ?? null,
          input.resultCommitSha ?? null,
          JSON.stringify(changedFiles),
          JSON.stringify(checkedVerificationResults),
          failureClass === "integration_contention" ? null : (failureClass ?? null),
          failureClass === "integration_contention" ? failureClass : null,
          retryDisposition ?? null,
          inputTokens,
          outputTokens,
          costUsd,
          id,
        ],
      );

      let taskStatus: TaskStatus;
      let completedAt: string | null;
      if (wasCancelled) {
        taskStatus = "cancelled";
        completedAt = finishedAt;
      } else if (runStatus === "succeeded") {
        taskStatus = "succeeded";
        completedAt = finishedAt;
      } else if (retryDisposition === "stop" || retryDisposition === "manual_resolution") {
        taskStatus = runStatus === "failed" ? "failed" : "interrupted";
        completedAt = finishedAt;
      } else if (
        input.requeue ||
        (failureClass !== undefined && !spendsAttempt(failureClass)) ||
        task.attemptCount < queue.maxAttempts
      ) {
        taskStatus = "queued";
        completedAt = null;
      } else {
        taskStatus = runStatus === "failed" ? "failed" : "interrupted";
        completedAt = finishedAt;
      }

      const restoredAttemptCount =
        input.requeue || (failureClass !== undefined && !spendsAttempt(failureClass))
          ? Math.max(0, task.attemptCount - 1)
          : task.attemptCount;
      const deliveryStatus =
        runStatus === "succeeded"
          ? input.resultCommitSha
            ? "ready_to_integrate"
            : "verified"
          : failureClass === "test_regression" ||
              failureClass === "policy_violation" ||
              failureClass === "file_conflict"
            ? "implemented"
            : task.deliveryStatus;
      const currentPhase =
        taskStatus === "queued"
          ? failureClass === "test_regression"
            ? "implement"
            : task.blockedBy.length > 0
              ? "blocked"
              : "queued"
          : "complete";
      this.#database.run(
        `
          UPDATE tasks
          SET status = ?, attempt_count = ?, current_run_id = NULL, completed_at = ?,
              resume_run_id = CASE
                WHEN ? = 1 THEN ?
                WHEN ? = 1 THEN NULL
                ELSE resume_run_id
              END,
              current_phase = ?, delivery_status = ?, failure_class = ?,
              delivery_failure_class = ?,
              failure_reason = ?, retry_disposition = ?, result_run_id = ?,
              result_commit_sha = ?, changed_files = ?, verification_results = ?,
              input_tokens = input_tokens + ?, output_tokens = output_tokens + ?,
              cost_usd = cost_usd + ?, updated_at = ?
          WHERE id = ? AND current_run_id = ?
        `,
        [
          taskStatus,
          restoredAttemptCount,
          completedAt,
          taskStatus === "queued" && failureClass === "test_regression" ? 1 : 0,
          taskStatus === "queued" && failureClass === "test_regression" ? id : null,
          taskStatus === "queued" ? 0 : 1,
          currentPhase,
          deliveryStatus,
          failureClass === "integration_contention" ? null : (failureClass ?? null),
          failureClass === "integration_contention" ? failureClass : null,
          runStatus === "succeeded" ? null : (input.error ?? null),
          retryDisposition ?? null,
          runStatus === "succeeded" && input.resultCommitSha ? id : null,
          runStatus === "succeeded" ? (input.resultCommitSha ?? null) : null,
          JSON.stringify(changedFiles),
          JSON.stringify(checkedVerificationResults),
          inputTokens,
          outputTokens,
          costUsd,
          finishedAt,
          task.id,
          id,
        ],
      );

      if (runStatus === "succeeded" && input.resultCommitSha) {
        this.#database.run(
          `
            UPDATE tasks
            SET current_phase = 'queued', blocked_reason = NULL, updated_at = ?
            WHERE status = 'queued'
              AND current_phase = 'blocked'
              AND id IN (
                SELECT dependency.task_id
                FROM task_dependencies dependency
                WHERE dependency.blocker_task_id = ?
              )
              AND NOT EXISTS (
                SELECT 1
                FROM task_dependencies dependency
                JOIN tasks blocker ON blocker.id = dependency.blocker_task_id
                WHERE dependency.task_id = tasks.id
                  AND (
                    blocker.status <> 'succeeded'
                    OR blocker.delivery_status NOT IN (
                      'ready_to_integrate', 'integrated', 'landed'
                    )
                    OR blocker.result_run_id IS NULL
                    OR blocker.result_commit_sha IS NULL
                  )
              )
          `,
          [finishedAt, task.id],
        );
      }

      return { run: this.#requireRun(id), task: this.#requireTask(task.id) };
    });
    return finish.immediate();
  }

  deleteRun(id: string): boolean {
    const run = this.getRun(id);
    if (!run) return false;
    if (ACTIVE_RUN_STATUSES.includes(run.status as (typeof ACTIVE_RUN_STATUSES)[number])) {
      throw new AgentQError(`Cannot delete active run ${id}`, "RUN_ACTIVE");
    }
    return this.#database.run("DELETE FROM runs WHERE id = ?", [id]).changes > 0;
  }

  /**
   * Atomically revoke stale supervisor leases without making their tasks
   * claimable. Callers terminate the fenced provider tree, then finish the run
   * with the returned owner token. This prevents a replacement agent from
   * starting while orphan cleanup is still in progress.
   */
  fenceStaleRuns(input: FenceStaleRunsInput): RecoveryResult {
    const cutoff = timestamp(input.staleBefore, "staleBefore");
    const fencedAt = timestamp(input.at, "recovery fence timestamp");
    const ownerToken = nonEmpty(input.ownerToken, "ownerToken");
    if (input.eligibleRunIds?.length === 0) {
      return { recovered: 0, recoveredRuns: 0, runs: [], tasks: [] };
    }
    const fence = this.#database.transaction(() => {
      const eligibleClause = input.eligibleRunIds
        ? `AND r.id IN (${input.eligibleRunIds.map(() => "?").join(", ")})`
        : "";
      const bindings: Binding[] = [cutoff, ...(input.eligibleRunIds ?? [])];
      const candidates = selectAll<RunRow, Binding[]>(
        this.#database,
        `
          SELECT ${RUN_COLUMNS}
          FROM runs r
          WHERE r.status IN ('starting', 'running', 'cancelling')
            AND r.heartbeat_at < ?
            ${eligibleClause}
          ORDER BY r.heartbeat_at, r.id
        `,
        bindings,
      ).map(mapRun);

      const runIds: string[] = [];
      const taskIds = new Set<string>();
      for (const run of candidates) {
        const changed = this.#database.run(
          `
            UPDATE runs
            SET status = 'cancelling', owner_token = ?, owner_pid = NULL,
                heartbeat_at = ?, error = COALESCE(error, 'Supervisor heartbeat expired')
            WHERE id = ? AND status IN ('starting', 'running', 'cancelling')
              AND heartbeat_at < ?
          `,
          [ownerToken, fencedAt, run.id, cutoff],
        ).changes;
        if (changed !== 1) continue;
        this.#database.run(
          `
            UPDATE tasks SET status = 'cancelling', updated_at = ?
            WHERE id = ? AND current_run_id = ?
          `,
          [fencedAt, run.taskId, run.id],
        );
        runIds.push(run.id);
        taskIds.add(run.taskId);
      }

      return {
        recovered: runIds.length,
        recoveredRuns: runIds.length,
        runs: runIds.map((id) => this.#requireRun(id)),
        tasks: [...taskIds].map((id) => this.#requireTask(id)),
      };
    });
    return fence.immediate();
  }

  recoverStaleRuns(
    staleBefore: string,
    now?: string,
    eligibleRunIds?: readonly string[],
  ): RecoveryResult {
    const cutoff = timestamp(staleBefore, "staleBefore");
    const recoveredAt = timestamp(now, "recovery timestamp");
    if (eligibleRunIds?.length === 0) {
      return { recovered: 0, recoveredRuns: 0, runs: [], tasks: [] };
    }
    const recover = this.#database.transaction(() => {
      const eligibleClause = eligibleRunIds
        ? `AND r.id IN (${eligibleRunIds.map(() => "?").join(", ")})`
        : "";
      const bindings: Binding[] = [cutoff, ...(eligibleRunIds ?? [])];
      const staleRuns = selectAll<RunRow, Binding[]>(
        this.#database,
        `
          SELECT ${RUN_COLUMNS}
          FROM runs r
          WHERE r.status IN ('starting', 'running', 'cancelling')
            AND r.heartbeat_at < ?
            ${eligibleClause}
          ORDER BY r.heartbeat_at, r.id
        `,
        bindings,
      ).map(mapRun);

      const runIds: string[] = [];
      const taskIds = new Set<string>();
      for (const run of staleRuns) {
        const task = this.#requireTask(run.taskId);
        const queue = this.#requireQueue(task.queueId);
        const cancelled = task.cancelRequestedAt !== undefined;
        const runStatus: RunStatus = cancelled ? "cancelled" : "interrupted";

        this.#database.run(
          `
            UPDATE runs
            SET status = ?, heartbeat_at = ?, finished_at = ?,
                error = COALESCE(error, 'Supervisor heartbeat expired')
            WHERE id = ? AND status IN ('starting', 'running', 'cancelling')
          `,
          [runStatus, recoveredAt, recoveredAt, run.id],
        );

        if (task.currentRunId === run.id) {
          let taskStatus: TaskStatus;
          let completedAt: string | null;
          if (cancelled) {
            taskStatus = "cancelled";
            completedAt = recoveredAt;
          } else if (task.attemptCount < queue.maxAttempts) {
            taskStatus = "queued";
            completedAt = null;
          } else {
            taskStatus = "interrupted";
            completedAt = recoveredAt;
          }
          this.#database.run(
            `
              UPDATE tasks
              SET status = ?, current_run_id = NULL, completed_at = ?, updated_at = ?
              WHERE id = ? AND current_run_id = ?
            `,
            [taskStatus, completedAt, recoveredAt, task.id, run.id],
          );
          taskIds.add(task.id);
        }
        runIds.push(run.id);
      }

      return {
        recovered: runIds.length,
        recoveredRuns: runIds.length,
        runs: runIds.map((id) => this.#requireRun(id)),
        tasks: [...taskIds].map((id) => this.#requireTask(id)),
      };
    });
    return recover.immediate();
  }

  appendEvent(input: AppendEventInput): TaskEvent {
    this.#requireTask(input.taskId);
    if (input.runId !== undefined) {
      const run = this.#requireRun(input.runId);
      if (run.taskId !== input.taskId) {
        throw new AgentQError(
          `Run ${input.runId} does not belong to task ${input.taskId}`,
          "INVALID_EVENT",
        );
      }
    }
    const kind = nonEmpty(input.kind, "event kind");
    let payload: string;
    try {
      payload = JSON.stringify(input.payload ?? {});
    } catch (error) {
      throw new AgentQError(
        `Event payload is not JSON serializable: ${errorMessage(error)}`,
        "INVALID_EVENT",
        2,
      );
    }
    const createdAt = timestamp(input.createdAt, "event timestamp");
    const result = this.#database.run(
      `
        INSERT INTO task_events(task_id, run_id, kind, payload, created_at)
        VALUES (?, ?, ?, ?, ?)
      `,
      [input.taskId, input.runId ?? null, kind, payload, createdAt],
    );
    const id = integerValue(result.lastInsertRowid, "event", "<new>", "id");
    return this.#requireEvent(id);
  }

  listEvents(filter: EventFilter): TaskEvent[] {
    const where = ["e.task_id = ?"];
    const values: Binding[] = [filter.taskId];
    if (filter.runId !== undefined) {
      where.push("e.run_id = ?");
      values.push(filter.runId);
    }
    if (filter.afterId !== undefined) {
      where.push("e.id > ?");
      values.push(integerInput(filter.afterId, "afterId", 0));
    }
    const [limit] = pagination(filter.limit, 0);
    values.push(limit);
    const direction = filter.afterId === undefined ? "DESC" : "ASC";
    const events = selectAll<EventRow, Binding[]>(
      this.#database,
      `
        SELECT ${EVENT_COLUMNS}
        FROM task_events e
        WHERE ${where.join(" AND ")}
        ORDER BY e.id ${direction}
        LIMIT ?
      `,
      values,
    ).map(mapEvent);
    return filter.afterId === undefined ? events.reverse() : events;
  }

  deleteEvents(filter: EventFilter): number {
    const where = ["task_id = ?"];
    const values: Binding[] = [filter.taskId];
    if (filter.runId !== undefined) {
      where.push("run_id = ?");
      values.push(filter.runId);
    }
    if (filter.afterId !== undefined) {
      where.push("id > ?");
      values.push(integerInput(filter.afterId, "afterId", 0));
    }
    return this.#database.run(`DELETE FROM task_events WHERE ${where.join(" AND ")}`, values)
      .changes;
  }

  recordTaskArtifact(input: RecordTaskArtifactInput): TaskArtifact {
    const record = this.#database.transaction(() => {
      const runId = nonEmpty(input.runId, "runId");
      const run = this.#requireRun(runId);
      const task = this.#requireTask(run.taskId);
      const queue = this.#requireQueue(task.queueId);
      const baseSha = nonEmpty(input.baseSha, "baseSha");
      const resultSha = nonEmpty(input.resultSha, "resultSha");
      const resultRef = nonEmpty(input.resultRef, "resultRef");
      const targetRef = canonicalTargetRef(queue.baseRef);
      const expectedResultRef = `refs/agentq/results/${task.id}/${run.id}`;
      if (resultRef !== expectedResultRef) {
        throw new AgentQError(
          `Artifact result ref must be ${expectedResultRef}`,
          "TASK_ARTIFACT_RESULT_REF_INVALID",
          2,
        );
      }

      if (
        run.status !== "succeeded" ||
        task.status !== "succeeded" ||
        !run.baseSha ||
        run.baseSha !== baseSha ||
        run.resultCommitSha !== resultSha ||
        task.resultRunId !== run.id ||
        task.resultCommitSha !== resultSha
      ) {
        throw new AgentQError(
          `Run ${run.id} does not have matching successful result evidence`,
          "TASK_ARTIFACT_EVIDENCE_MISMATCH",
        );
      }
      if (run.verificationResults.some((result) => result.status !== "passed")) {
        throw new AgentQError(
          `Run ${run.id} contains verification that did not pass`,
          "TASK_ARTIFACT_UNVERIFIED",
        );
      }

      const changedFiles =
        input.changedFiles === undefined
          ? [...run.changedFiles]
          : stringArrayInput(input.changedFiles, "changedFiles");
      const checkedVerificationResults =
        input.verificationResults === undefined
          ? [...run.verificationResults]
          : verificationResults(
              JSON.stringify(input.verificationResults),
              "task artifact",
              run.id,
              "verificationResults",
            );
      if (
        JSON.stringify(changedFiles) !== JSON.stringify(run.changedFiles) ||
        JSON.stringify(checkedVerificationResults) !== JSON.stringify(run.verificationResults)
      ) {
        throw new AgentQError(
          `Artifact evidence for run ${run.id} differs from the persisted run`,
          "TASK_ARTIFACT_EVIDENCE_MISMATCH",
        );
      }

      const existing = this.getTaskArtifactByRun(run.id);
      if (existing) {
        if (
          existing.taskId !== task.id ||
          existing.repoKey !== queue.repoKey ||
          existing.targetRef !== targetRef ||
          existing.baseSha !== baseSha ||
          existing.resultSha !== resultSha ||
          existing.resultRef !== resultRef ||
          JSON.stringify(existing.changedFiles) !== JSON.stringify(changedFiles) ||
          JSON.stringify(existing.verificationResults) !==
            JSON.stringify(checkedVerificationResults)
        ) {
          throw new AgentQError(
            `Artifact for run ${run.id} is immutable`,
            "TASK_ARTIFACT_IMMUTABLE",
          );
        }
        return existing;
      }

      const id = makeId("artifact");
      try {
        this.#database.run(
          `
            INSERT INTO task_artifacts(
              id, task_id, run_id, repo_key, target_ref, base_sha, result_sha,
              result_ref, changed_files, verification_results, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            id,
            task.id,
            run.id,
            queue.repoKey,
            targetRef,
            baseSha,
            resultSha,
            resultRef,
            JSON.stringify(changedFiles),
            JSON.stringify(checkedVerificationResults),
            timestamp(input.createdAt, "artifact createdAt"),
          ],
        );
      } catch (error) {
        constraint(
          error,
          `Artifact evidence for run ${run.id} or ref ${resultRef} already exists`,
          "TASK_ARTIFACT_CONFLICT",
        );
      }
      return this.#requireTaskArtifact(id);
    });
    return record.immediate();
  }

  getTaskArtifact(id: string): TaskArtifact | undefined {
    const row = selectOne<TaskArtifactRow, [string]>(
      this.#database,
      `SELECT ${TASK_ARTIFACT_COLUMNS} FROM task_artifacts a WHERE a.id = ?`,
      [id],
    );
    return row ? mapTaskArtifact(row) : undefined;
  }

  getTaskArtifactByRun(runId: string): TaskArtifact | undefined {
    const row = selectOne<TaskArtifactRow, [string]>(
      this.#database,
      `SELECT ${TASK_ARTIFACT_COLUMNS} FROM task_artifacts a WHERE a.run_id = ?`,
      [runId],
    );
    return row ? mapTaskArtifact(row) : undefined;
  }

  listTaskArtifacts(taskId: string): TaskArtifact[] {
    this.#requireTask(taskId);
    return selectAll<TaskArtifactRow, [string]>(
      this.#database,
      `
        SELECT ${TASK_ARTIFACT_COLUMNS}
        FROM task_artifacts a
        WHERE a.task_id = ?
        ORDER BY a.created_at, a.id
      `,
      [taskId],
    ).map(mapTaskArtifact);
  }

  getIntegrationLane(id: string): IntegrationLane | undefined {
    const row = selectOne<IntegrationLaneRow, [string]>(
      this.#database,
      `SELECT ${INTEGRATION_LANE_COLUMNS} FROM integration_lanes lane WHERE lane.id = ?`,
      [id],
    );
    return row ? mapIntegrationLane(row) : undefined;
  }

  getIntegrationLaneForTarget(repoKey: string, targetRef: string): IntegrationLane | undefined {
    const row = selectOne<IntegrationLaneRow, [string, string]>(
      this.#database,
      `
        SELECT ${INTEGRATION_LANE_COLUMNS}
        FROM integration_lanes lane
        WHERE lane.repo_key = ? AND lane.target_ref = ?
      `,
      [nonEmpty(repoKey, "repoKey"), canonicalTargetRef(targetRef)],
    );
    return row ? mapIntegrationLane(row) : undefined;
  }

  getOrCreateIntegrationLane(input: GetOrCreateIntegrationLaneInput): IntegrationLane {
    const create = this.#database.transaction(() => {
      const repoKey = nonEmpty(input.repoKey, "repoKey");
      const repoPath = nonEmpty(input.repoPath, "repoPath");
      const targetRef = canonicalTargetRef(input.targetRef);
      const trainRef = nonEmpty(input.trainRef, "trainRef");
      const initialHeadSha = nonEmpty(input.initialHeadSha, "initialHeadSha");
      const existing = this.getIntegrationLaneForTarget(repoKey, targetRef);
      if (existing) {
        if (existing.repoPath !== repoPath || existing.trainRef !== trainRef) {
          throw new AgentQError(
            `Integration lane ${existing.id} is already bound to ${existing.repoPath} and ${existing.trainRef}`,
            "INTEGRATION_LANE_CONFLICT",
          );
        }
        return existing;
      }

      const id = makeId("lane");
      const createdAt = timestamp(input.createdAt, "lane createdAt");
      try {
        this.#database.run(
          `
            INSERT INTO integration_lanes(
              id, repo_key, repo_path, target_ref, train_ref, target_base_sha, head_sha,
              generation, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
          `,
          [
            id,
            repoKey,
            repoPath,
            targetRef,
            trainRef,
            initialHeadSha,
            initialHeadSha,
            createdAt,
            createdAt,
          ],
        );
      } catch (error) {
        constraint(
          error,
          `An integration lane already owns ${repoKey}:${targetRef} or ${trainRef}`,
          "INTEGRATION_LANE_CONFLICT",
        );
      }
      return this.#requireIntegrationLane(id);
    });
    return create.immediate();
  }

  advanceIntegrationLaneHead(id: string, input: AdvanceIntegrationLaneInput): IntegrationLane {
    const advance = this.#database.transaction(() => {
      const lane = this.#requireIntegrationLane(id);
      const expectedHeadSha = nonEmpty(input.expectedHeadSha, "expectedHeadSha");
      const newHeadSha = nonEmpty(input.newHeadSha, "newHeadSha");
      if (lane.headSha === newHeadSha) return lane;
      if (lane.headSha !== expectedHeadSha) {
        throw new AgentQError(
          `Integration lane ${id} advanced from ${expectedHeadSha} to ${lane.headSha}`,
          "INTEGRATION_LANE_HEAD_CHANGED",
        );
      }
      const changed = this.#database.run(
        `
          UPDATE integration_lanes
          SET head_sha = ?, generation = generation + 1, updated_at = ?
          WHERE id = ? AND head_sha = ? AND generation = ?
        `,
        [
          newHeadSha,
          timestamp(input.updatedAt, "lane updatedAt"),
          id,
          expectedHeadSha,
          lane.generation,
        ],
      ).changes;
      if (changed !== 1) {
        throw new AgentQError(
          `Integration lane ${id} changed before its head could advance`,
          "INTEGRATION_LANE_HEAD_CHANGED",
        );
      }
      return this.#requireIntegrationLane(id);
    });
    return advance.immediate();
  }

  createDeliveryOperation(input: CreateDeliveryOperationInput): DeliveryOperation {
    const create = this.#database.transaction(() => {
      const lane = this.#requireIntegrationLane(nonEmpty(input.laneId, "laneId"));
      const kind = enumValue(
        input.kind,
        DELIVERY_OPERATION_KINDS,
        "delivery operation",
        "<new>",
        "kind",
      );
      let taskId: string | null = null;
      let artifactId: string | null = null;
      let existing: DeliveryOperation | undefined;

      if (kind === "integrate") {
        taskId = nonEmpty(input.taskId ?? "", "taskId");
        artifactId = nonEmpty(input.artifactId ?? "", "artifactId");
        const task = this.#requireTask(taskId);
        const artifact = this.#requireTaskArtifact(artifactId);
        if (
          artifact.taskId !== task.id ||
          artifact.repoKey !== lane.repoKey ||
          artifact.targetRef !== lane.targetRef ||
          task.status !== "succeeded" ||
          task.resultRunId !== artifact.runId ||
          task.resultCommitSha !== artifact.resultSha
        ) {
          throw new AgentQError(
            `Artifact ${artifact.id} does not belong to lane ${lane.id}`,
            "DELIVERY_ARTIFACT_LANE_MISMATCH",
          );
        }
        const existingRow = selectOne<DeliveryOperationRow, [string]>(
          this.#database,
          `
            SELECT ${DELIVERY_OPERATION_COLUMNS}
            FROM delivery_operations operation
            WHERE operation.artifact_id = ?
              AND operation.kind = 'integrate'
              AND operation.status IN ('queued', 'running')
            LIMIT 1
          `,
          [artifact.id],
        );
        existing = existingRow ? mapDeliveryOperation(existingRow) : undefined;
      } else {
        if (input.taskId !== undefined || input.artifactId !== undefined) {
          throw new AgentQError(
            "Landing operations are lane-scoped and cannot name a task or artifact",
            "INVALID_DELIVERY_OPERATION",
            2,
          );
        }
        const existingRow = selectOne<DeliveryOperationRow, [string]>(
          this.#database,
          `
            SELECT ${DELIVERY_OPERATION_COLUMNS}
            FROM delivery_operations operation
            WHERE operation.lane_id = ?
              AND operation.kind = 'land'
              AND operation.status IN ('queued', 'running')
            LIMIT 1
          `,
          [lane.id],
        );
        existing = existingRow ? mapDeliveryOperation(existingRow) : undefined;
      }
      if (existing) return existing;

      const id = makeId("delivery");
      try {
        this.#database.run(
          `
            INSERT INTO delivery_operations(
              id, lane_id, task_id, artifact_id, kind, status, conflict_files, created_at
            ) VALUES (?, ?, ?, ?, ?, 'queued', '[]', ?)
          `,
          [
            id,
            lane.id,
            taskId,
            artifactId,
            kind,
            timestamp(input.createdAt, "delivery operation createdAt"),
          ],
        );
      } catch (error) {
        constraint(
          error,
          "A nonterminal delivery operation already exists for this result",
          "DELIVERY_OPERATION_EXISTS",
        );
      }
      return this.#requireDeliveryOperation(id);
    });
    return create.immediate();
  }

  getDeliveryOperation(id: string): DeliveryOperation | undefined {
    const row = selectOne<DeliveryOperationRow, [string]>(
      this.#database,
      `
        SELECT ${DELIVERY_OPERATION_COLUMNS}
        FROM delivery_operations operation
        WHERE operation.id = ?
      `,
      [id],
    );
    return row ? mapDeliveryOperation(row) : undefined;
  }

  listDeliveryOperations(
    filter: {
      laneId?: string;
      taskId?: string;
      statuses?: readonly DeliveryOperation["status"][];
    } = {},
  ): DeliveryOperation[] {
    const where: string[] = [];
    const bindings: Binding[] = [];
    if (filter.laneId !== undefined) {
      where.push("operation.lane_id = ?");
      bindings.push(nonEmpty(filter.laneId, "laneId"));
    }
    if (filter.taskId !== undefined) {
      where.push("operation.task_id = ?");
      bindings.push(nonEmpty(filter.taskId, "taskId"));
    }
    if (filter.statuses !== undefined) {
      if (filter.statuses.length === 0) {
        throw new AgentQError("statuses cannot be empty", "INVALID_INPUT", 2);
      }
      const statuses = filter.statuses.map((status, index) =>
        enumValue(
          status,
          DELIVERY_OPERATION_STATUSES,
          "delivery operation filter",
          String(index),
          "status",
        ),
      );
      where.push(`operation.status IN (${statuses.map(() => "?").join(", ")})`);
      bindings.push(...statuses);
    }
    return selectAll<DeliveryOperationRow, Binding[]>(
      this.#database,
      `
        SELECT ${DELIVERY_OPERATION_COLUMNS}
        FROM delivery_operations operation
        ${where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`}
        ORDER BY operation.created_at, operation.id
      `,
      bindings,
    ).map(mapDeliveryOperation);
  }

  claimDeliveryOperation(input: ClaimDeliveryOperationInput): DeliveryOperationClaim | undefined {
    const claim = this.#database.transaction(() => {
      const ownerToken = nonEmpty(input.ownerToken, "ownerToken");
      const now = timestamp(input.now, "delivery lease timestamp");
      const leaseDurationMs = integerInput(input.leaseDurationMs ?? 30_000, "leaseDurationMs", 1);
      const leaseExpiresAt = new Date(Date.parse(now) + leaseDurationMs).toISOString();
      const laneClause = input.laneId === undefined ? "" : "AND operation.lane_id = ?";
      const operationClause = input.operationId === undefined ? "" : "AND operation.id = ?";
      const bindings: Binding[] = [now];
      const requestedOperation =
        input.operationId === undefined
          ? undefined
          : this.#requireDeliveryOperation(input.operationId);
      if (input.laneId !== undefined) {
        const requestedLane = this.#requireIntegrationLane(input.laneId);
        if (requestedOperation && requestedOperation.laneId !== requestedLane.id) {
          throw new AgentQError(
            `Delivery operation ${requestedOperation.id} does not belong to lane ${requestedLane.id}`,
            "INVALID_DELIVERY_OPERATION",
            2,
          );
        }
        bindings.push(requestedLane.id);
      }
      if (requestedOperation) bindings.push(requestedOperation.id);
      const candidate = selectOne<DeliveryOperationRow, Binding[]>(
        this.#database,
        `
          SELECT ${DELIVERY_OPERATION_COLUMNS}
          FROM delivery_operations operation
          WHERE (
              (
                operation.status = 'queued'
                AND NOT EXISTS (
                  SELECT 1
                  FROM delivery_operations active
                  WHERE active.lane_id = operation.lane_id
                    AND active.status = 'running'
                )
              )
              OR (
                operation.status = 'running'
                AND operation.lease_expires_at <= ?
              )
            )
            ${laneClause}
            ${operationClause}
          ORDER BY
            CASE WHEN operation.status = 'running' THEN 0 ELSE 1 END,
            operation.created_at,
            operation.id
          LIMIT 1
        `,
        bindings,
      );
      if (!candidate) return undefined;

      const operation = mapDeliveryOperation(candidate);
      const lane = this.#requireIntegrationLane(operation.laneId);
      const changed = this.#database.run(
        `
          UPDATE delivery_operations
          SET status = 'running', owner_token = ?, fence_token = fence_token + 1,
              expected_head_sha = ?, candidate_sha = NULL, conflict_files = '[]',
              error = NULL, started_at = COALESCE(started_at, ?), heartbeat_at = ?,
              lease_expires_at = ?, finished_at = NULL
          WHERE id = ? AND fence_token = ?
            AND (
              status = 'queued'
              OR (status = 'running' AND lease_expires_at <= ?)
            )
        `,
        [
          ownerToken,
          lane.headSha,
          now,
          now,
          leaseExpiresAt,
          operation.id,
          operation.fenceToken,
          now,
        ],
      ).changes;
      if (changed !== 1) {
        throw new AgentQError(
          `Delivery operation ${operation.id} changed before it could be claimed`,
          "DELIVERY_CLAIM_CONFLICT",
        );
      }
      const claimed = this.#requireDeliveryOperation(operation.id);
      return {
        operation: claimed,
        leaseToken: ownerToken,
        fenceToken: claimed.fenceToken,
      };
    });
    return claim.immediate();
  }

  heartbeatDeliveryOperation(
    id: string,
    leaseToken: string,
    fenceToken: number,
    input: { at?: string; leaseDurationMs?: number } = {},
  ): DeliveryOperation {
    const now = timestamp(input.at, "delivery heartbeat timestamp");
    const leaseDurationMs = integerInput(input.leaseDurationMs ?? 30_000, "leaseDurationMs", 1);
    const leaseExpiresAt = new Date(Date.parse(now) + leaseDurationMs).toISOString();
    const changed = this.#database.run(
      `
        UPDATE delivery_operations
        SET heartbeat_at = ?, lease_expires_at = ?
        WHERE id = ? AND status = 'running' AND owner_token = ? AND fence_token = ?
      `,
      [
        now,
        leaseExpiresAt,
        nonEmpty(id, "delivery operation id"),
        nonEmpty(leaseToken, "leaseToken"),
        integerInput(fenceToken, "fenceToken", 1),
      ],
    ).changes;
    if (changed !== 1) {
      throw new AgentQError(`Delivery operation ${id} lease was lost`, "DELIVERY_LEASE_LOST");
    }
    return this.#requireDeliveryOperation(id);
  }

  finishDeliveryOperation(
    id: string,
    input: FinishDeliveryOperationInput,
    leaseToken: string,
    fenceToken: number,
  ): DeliveryOperation {
    const status = enumValue(
      input.status,
      ["succeeded", "failed", "conflicted", "cancelled"] as const,
      "delivery operation",
      id,
      "status",
    );
    const conflictFiles = stringArrayInput(input.conflictFiles ?? [], "conflictFiles");
    if (status === "conflicted" && conflictFiles.length === 0) {
      throw new AgentQError(
        "A conflicted delivery operation must record conflict files",
        "INVALID_DELIVERY_OPERATION",
        2,
      );
    }
    const finishedAt = timestamp(input.finishedAt, "delivery operation finishedAt");
    const changed = this.#database.run(
      `
        UPDATE delivery_operations
        SET status = ?, candidate_sha = ?, conflict_files = ?, error = ?,
            heartbeat_at = ?, lease_expires_at = NULL, finished_at = ?
        WHERE id = ? AND status = 'running' AND owner_token = ? AND fence_token = ?
      `,
      [
        status,
        input.candidateSha === undefined ? null : nonEmpty(input.candidateSha, "candidateSha"),
        JSON.stringify(conflictFiles),
        input.error ?? null,
        finishedAt,
        finishedAt,
        nonEmpty(id, "delivery operation id"),
        nonEmpty(leaseToken, "leaseToken"),
        integerInput(fenceToken, "fenceToken", 1),
      ],
    ).changes;
    if (changed !== 1) {
      throw new AgentQError(`Delivery operation ${id} lease was lost`, "DELIVERY_LEASE_LOST");
    }
    return this.#requireDeliveryOperation(id);
  }

  completeIntegration(input: CompleteIntegrationInput): {
    lane: IntegrationLane;
    task: Task;
    operation: DeliveryOperation;
  } {
    const complete = this.#database.transaction(() => {
      const operation = this.#requireClaimedDeliveryOperation(
        input.operationId,
        input.leaseToken,
        input.fenceToken,
        "integrate",
      );
      if (!operation.artifactId || !operation.taskId) {
        throw new AgentQError(
          `Integration operation ${operation.id} has no artifact task`,
          "CORRUPT_DATABASE",
        );
      }
      const artifact = this.#requireTaskArtifact(operation.artifactId);
      const task = this.#requireTask(operation.taskId);
      const lane = this.#requireIntegrationLane(operation.laneId);
      const expectedHeadSha = nonEmpty(input.expectedHeadSha, "expectedHeadSha");
      const newHeadSha = nonEmpty(input.newHeadSha, "newHeadSha");
      const expectedGeneration = integerInput(
        input.expectedLaneGeneration,
        "expectedLaneGeneration",
        0,
      );
      if (
        artifact.taskId !== task.id ||
        artifact.repoKey !== lane.repoKey ||
        artifact.targetRef !== lane.targetRef ||
        operation.expectedHeadSha !== expectedHeadSha ||
        lane.headSha !== expectedHeadSha ||
        lane.generation !== expectedGeneration
      ) {
        throw new AgentQError(
          `Integration lane ${lane.id} changed before ${operation.id} completed`,
          "INTEGRATION_LANE_HEAD_CHANGED",
        );
      }
      const completedAt = timestamp(input.completedAt, "integration completedAt");
      const laneChanged = this.#database.run(
        `
          UPDATE integration_lanes
          SET head_sha = ?, generation = generation + 1, updated_at = ?
          WHERE id = ? AND head_sha = ? AND generation = ?
        `,
        [newHeadSha, completedAt, lane.id, expectedHeadSha, expectedGeneration],
      ).changes;
      if (laneChanged !== 1) {
        throw new AgentQError(
          `Integration lane ${lane.id} changed before its head could advance`,
          "INTEGRATION_LANE_HEAD_CHANGED",
        );
      }
      const taskChanged = this.#database.run(
        `
          UPDATE tasks
          SET delivery_status = 'integrated', current_phase = 'land',
              integration_branch = ?, integrated_sha = ?, integrated_at = ?,
              integration_conflict_files = '[]', failure_class = NULL,
              delivery_failure_class = NULL, failure_reason = NULL,
              retry_disposition = NULL, updated_at = ?
          WHERE id = ? AND result_run_id = ? AND result_commit_sha = ?
            AND status = 'succeeded'
        `,
        [
          input.integrationBranch?.trim() || lane.trainRef,
          newHeadSha,
          completedAt,
          completedAt,
          task.id,
          artifact.runId,
          artifact.resultSha,
        ],
      ).changes;
      if (taskChanged !== 1) {
        throw new AgentQError(
          `Task ${task.id} result changed before integration completed`,
          "TASK_STATE_CHANGED",
        );
      }
      const operationChanged = this.#database.run(
        `
          UPDATE delivery_operations
          SET status = 'succeeded', candidate_sha = ?, conflict_files = '[]',
              error = NULL, heartbeat_at = ?, lease_expires_at = NULL, finished_at = ?
          WHERE id = ? AND status = 'running' AND owner_token = ? AND fence_token = ?
        `,
        [newHeadSha, completedAt, completedAt, operation.id, input.leaseToken, input.fenceToken],
      ).changes;
      if (operationChanged !== 1) {
        throw new AgentQError(
          `Delivery operation ${operation.id} lease was lost`,
          "DELIVERY_LEASE_LOST",
        );
      }
      return {
        lane: this.#requireIntegrationLane(lane.id),
        task: this.#requireTask(task.id),
        operation: this.#requireDeliveryOperation(operation.id),
      };
    });
    return complete.immediate();
  }

  recordIntegrationFailure(input: RecordIntegrationFailureInput): {
    task: Task;
    operation: DeliveryOperation;
  } {
    const record = this.#database.transaction(() => {
      const operation = this.#requireClaimedDeliveryOperation(
        input.operationId,
        input.leaseToken,
        input.fenceToken,
        "integrate",
      );
      if (!operation.taskId || !operation.artifactId) {
        throw new AgentQError(
          `Integration operation ${operation.id} has no artifact task`,
          "CORRUPT_DATABASE",
        );
      }
      const artifact = this.#requireTaskArtifact(operation.artifactId);
      const task = this.#requireTask(operation.taskId);
      const lane = this.#requireIntegrationLane(operation.laneId);
      if (artifact.taskId !== task.id) {
        throw new AgentQError(
          `Integration operation ${operation.id} artifact no longer matches its task`,
          "DELIVERY_ARTIFACT_LANE_MISMATCH",
        );
      }
      const status = enumValue(
        input.status,
        ["failed", "conflicted"] as const,
        "delivery operation",
        operation.id,
        "status",
      );
      const failureClass = enumValue(
        input.failureClass,
        [
          "integration_conflict",
          "integration_contention",
          "policy_violation",
          "test_regression",
        ] as const,
        "delivery operation",
        operation.id,
        "failureClass",
      );
      const expectedStatus = failureClass === "integration_conflict" ? "conflicted" : "failed";
      if (status !== expectedStatus) {
        throw new AgentQError(
          `${failureClass} must finish its delivery operation as ${expectedStatus}`,
          "INVALID_DELIVERY_OPERATION",
          2,
        );
      }
      const suppliedConflictFiles = stringArrayInput(input.conflictFiles ?? [], "conflictFiles");
      if (failureClass === "integration_conflict" && suppliedConflictFiles.length === 0) {
        throw new AgentQError(
          "A conflicted integration must record conflict files",
          "INVALID_DELIVERY_OPERATION",
          2,
        );
      }
      const conflictFiles = failureClass === "integration_conflict" ? suppliedConflictFiles : [];
      const error = nonEmpty(input.error, "error");
      const finishedAt = timestamp(input.finishedAt, "integration failure finishedAt");
      const operationChanged = this.#database.run(
        `
          UPDATE delivery_operations
          SET status = ?, conflict_files = ?, error = ?, heartbeat_at = ?,
              lease_expires_at = NULL, finished_at = ?
          WHERE id = ? AND status = 'running' AND owner_token = ? AND fence_token = ?
        `,
        [
          status,
          JSON.stringify(conflictFiles),
          error,
          finishedAt,
          finishedAt,
          operation.id,
          input.leaseToken,
          input.fenceToken,
        ],
      ).changes;
      if (operationChanged !== 1) {
        throw new AgentQError(
          `Delivery operation ${operation.id} lease was lost`,
          "DELIVERY_LEASE_LOST",
        );
      }
      let taskChanged: number;
      if (failureClass === "test_regression") {
        taskChanged = this.#database.run(
          `
            UPDATE tasks
            SET status = 'queued', attempt_count = CASE
                  WHEN attempt_count > 0 THEN attempt_count - 1
                  ELSE 0
                END,
                current_phase = 'queued', delivery_status = 'implemented',
                current_run_id = NULL, resume_run_id = NULL, completed_at = NULL,
                created_base_sha = ?, result_run_id = NULL, result_commit_sha = NULL,
                integration_conflict_files = '[]', failure_class = NULL,
                delivery_failure_class = 'test_regression', failure_reason = ?,
                retry_disposition = 'return_to_implementation', updated_at = ?
            WHERE id = ? AND status = 'succeeded'
          `,
          [lane.headSha, error, finishedAt, task.id],
        ).changes;
      } else if (failureClass === "policy_violation") {
        taskChanged = this.#database.run(
          `
            UPDATE tasks
            SET status = 'failed', current_phase = 'complete',
                delivery_status = 'implemented', resume_run_id = NULL,
                completed_at = ?, integration_conflict_files = '[]',
                failure_class = NULL, delivery_failure_class = 'policy_violation',
                failure_reason = ?, retry_disposition = 'stop', updated_at = ?
            WHERE id = ? AND status = 'succeeded'
          `,
          [finishedAt, error, finishedAt, task.id],
        ).changes;
      } else {
        taskChanged = this.#database.run(
          `
            UPDATE tasks
            SET delivery_status = 'ready_to_integrate', current_phase = 'integrate',
                integration_conflict_files = ?, failure_class = NULL,
                delivery_failure_class = ?, failure_reason = ?,
                retry_disposition = ?, updated_at = ?
            WHERE id = ? AND status = 'succeeded'
          `,
          [
            JSON.stringify(conflictFiles),
            failureClass,
            error,
            failureClass === "integration_conflict" ? "manual_resolution" : "retry",
            finishedAt,
            task.id,
          ],
        ).changes;
      }
      if (taskChanged !== 1) {
        throw new AgentQError(
          `Task ${task.id} changed before integration failure was stored`,
          "TASK_STATE_CHANGED",
        );
      }
      return {
        task: this.#requireTask(task.id),
        operation: this.#requireDeliveryOperation(operation.id),
      };
    });
    return record.immediate();
  }

  completeLanding(input: CompleteLandingInput): {
    lane: IntegrationLane;
    tasks: Task[];
    operation?: DeliveryOperation;
  } {
    const complete = this.#database.transaction(() => {
      const lane = this.#requireIntegrationLane(nonEmpty(input.laneId, "laneId"));
      const expectedHeadSha = nonEmpty(input.expectedHeadSha, "expectedHeadSha");
      const landedSha = nonEmpty(input.landedSha, "landedSha");
      const expectedGeneration = integerInput(
        input.expectedLaneGeneration,
        "expectedLaneGeneration",
        0,
      );
      if (
        lane.headSha !== expectedHeadSha ||
        landedSha !== expectedHeadSha ||
        lane.generation !== expectedGeneration
      ) {
        throw new AgentQError(
          `Landing cursor for lane ${lane.id} does not match its train head`,
          "INTEGRATION_LANE_HEAD_CHANGED",
        );
      }
      let operation: DeliveryOperation | undefined;
      if (input.operationId !== undefined) {
        if (input.leaseToken === undefined || input.fenceToken === undefined) {
          throw new AgentQError(
            "Completing a claimed landing operation requires its lease and fence token",
            "INVALID_DELIVERY_OPERATION",
            2,
          );
        }
        operation = this.#requireClaimedDeliveryOperation(
          input.operationId,
          input.leaseToken,
          input.fenceToken,
          "land",
        );
        if (operation.laneId !== lane.id || operation.expectedHeadSha !== expectedHeadSha) {
          throw new AgentQError(
            `Landing operation ${operation.id} does not match lane ${lane.id}`,
            "INTEGRATION_LANE_HEAD_CHANGED",
          );
        }
      }
      const artifactIds = [
        ...new Set(
          stringArrayInput(input.artifactIds, "artifactIds").map((id) =>
            nonEmpty(id, "artifactId"),
          ),
        ),
      ];
      const taskIds: string[] = [];
      for (const artifactId of artifactIds) {
        const artifact = this.#requireTaskArtifact(artifactId);
        const task = this.#requireTask(artifact.taskId);
        if (
          artifact.repoKey !== lane.repoKey ||
          artifact.targetRef !== lane.targetRef ||
          !task.integratedSha
        ) {
          throw new AgentQError(
            `Artifact ${artifact.id} is not integrated into lane ${lane.id}`,
            "DELIVERY_ARTIFACT_LANE_MISMATCH",
          );
        }
        taskIds.push(task.id);
      }

      const completedAt = timestamp(input.completedAt, "landing completedAt");
      const laneChanged = this.#database.run(
        `
          UPDATE integration_lanes
          SET target_base_sha = ?, generation = generation + 1, updated_at = ?
          WHERE id = ? AND head_sha = ? AND generation = ?
        `,
        [landedSha, completedAt, lane.id, expectedHeadSha, expectedGeneration],
      ).changes;
      if (laneChanged !== 1) {
        throw new AgentQError(
          `Landing cursor for lane ${lane.id} changed concurrently`,
          "INTEGRATION_LANE_HEAD_CHANGED",
        );
      }
      for (const taskId of taskIds) {
        this.#database.run(
          `
            UPDATE tasks
            SET delivery_status = 'landed', current_phase = 'complete',
                landed_sha = integrated_sha, landed_at = ?,
                integration_conflict_files = '[]', failure_class = NULL,
                delivery_failure_class = NULL, failure_reason = NULL,
                retry_disposition = NULL, updated_at = ?
            WHERE id = ? AND delivery_status = 'integrated'
          `,
          [completedAt, completedAt, taskId],
        );
      }
      if (operation) {
        const operationChanged = this.#database.run(
          `
            UPDATE delivery_operations
            SET status = 'succeeded', candidate_sha = ?, conflict_files = '[]',
                error = NULL, heartbeat_at = ?, lease_expires_at = NULL, finished_at = ?
            WHERE id = ? AND status = 'running' AND owner_token = ? AND fence_token = ?
          `,
          [
            landedSha,
            completedAt,
            completedAt,
            operation.id,
            input.leaseToken as string,
            input.fenceToken as number,
          ],
        ).changes;
        if (operationChanged !== 1) {
          throw new AgentQError(
            `Delivery operation ${operation.id} lease was lost`,
            "DELIVERY_LEASE_LOST",
          );
        }
      }
      return {
        lane: this.#requireIntegrationLane(lane.id),
        tasks: taskIds.map((taskId) => this.#requireTask(taskId)),
        ...(operation === undefined
          ? {}
          : { operation: this.#requireDeliveryOperation(operation.id) }),
      };
    });
    return complete.immediate();
  }

  reconcileIntegrationLaneHead(
    id: string,
    input: AdvanceIntegrationLaneInput & { expectedLaneGeneration: number },
  ): IntegrationLane {
    const reconcile = this.#database.transaction(() => {
      const lane = this.#requireIntegrationLane(id);
      const expectedGeneration = integerInput(
        input.expectedLaneGeneration,
        "expectedLaneGeneration",
        0,
      );
      const expectedHeadSha = nonEmpty(input.expectedHeadSha, "expectedHeadSha");
      const newHeadSha = nonEmpty(input.newHeadSha, "newHeadSha");
      if (
        lane.generation !== expectedGeneration ||
        (lane.headSha !== expectedHeadSha && lane.headSha !== newHeadSha)
      ) {
        throw new AgentQError(
          `Integration lane ${lane.id} changed before reconciliation`,
          "INTEGRATION_LANE_HEAD_CHANGED",
        );
      }
      if (lane.headSha === newHeadSha) return lane;
      const changed = this.#database.run(
        `
          UPDATE integration_lanes
          SET head_sha = ?, generation = generation + 1, updated_at = ?
          WHERE id = ? AND head_sha = ? AND generation = ?
        `,
        [
          newHeadSha,
          timestamp(input.updatedAt, "lane reconciliation updatedAt"),
          lane.id,
          expectedHeadSha,
          expectedGeneration,
        ],
      ).changes;
      if (changed !== 1) {
        throw new AgentQError(
          `Integration lane ${lane.id} changed before reconciliation`,
          "INTEGRATION_LANE_HEAD_CHANGED",
        );
      }
      return this.#requireIntegrationLane(lane.id);
    });
    return reconcile.immediate();
  }

  requestTaskApproval(input: RequestTaskApprovalInput): TaskApproval {
    const request = this.#database.transaction(() => {
      const task = this.#requireTask(nonEmpty(input.taskId, "taskId"));
      const checkpoint = nonEmpty(input.checkpoint, "checkpoint");
      let runId: string | null = null;
      if (input.runId !== undefined) {
        const run = this.#requireRun(nonEmpty(input.runId, "runId"));
        if (run.taskId !== task.id) {
          throw new AgentQError(
            `Run ${run.id} does not belong to task ${task.id}`,
            "APPROVAL_RUN_MISMATCH",
          );
        }
        runId = run.id;
      }
      const existing = this.getTaskApproval(task.id, checkpoint);
      if (existing && existing.status !== "pending") return existing;
      const requestedAt = timestamp(input.requestedAt, "approval requestedAt");
      this.#database.run(
        `
          INSERT INTO task_approvals(
            task_id, checkpoint, status, run_id, requested_at,
            decided_at, actor, note
          ) VALUES (?, ?, 'pending', ?, ?, NULL, NULL, NULL)
          ON CONFLICT(task_id, checkpoint) DO UPDATE SET
            run_id = excluded.run_id,
            requested_at = excluded.requested_at,
            decided_at = NULL,
            actor = NULL,
            note = NULL
          WHERE task_approvals.status = 'pending'
        `,
        [task.id, checkpoint, runId, requestedAt],
      );
      if (task.status === "queued") {
        this.#database.run(
          `
            UPDATE tasks
            SET current_phase = 'approval', blocked_reason = ?,
                failure_class = 'blocked_dependency', failure_reason = ?,
                retry_disposition = 'wait', updated_at = ?
            WHERE id = ? AND status = 'queued'
          `,
          [
            `Waiting for approval: ${checkpoint}`,
            `Approval checkpoint ${checkpoint} is pending`,
            requestedAt,
            task.id,
          ],
        );
      } else if (
        task.status === "succeeded" &&
        (task.deliveryStatus === "ready_to_integrate" || task.deliveryStatus === "integrated")
      ) {
        this.#database.run(
          `
            UPDATE tasks
            SET current_phase = 'approval', blocked_reason = ?,
                failure_class = 'blocked_dependency', failure_reason = ?,
                retry_disposition = 'wait', updated_at = ?
            WHERE id = ? AND status = 'succeeded'
          `,
          [
            `Waiting for approval: ${checkpoint}`,
            `Approval checkpoint ${checkpoint} is pending`,
            requestedAt,
            task.id,
          ],
        );
      }
      return this.#requireTaskApproval(task.id, checkpoint);
    });
    return request.immediate();
  }

  getTaskApproval(taskId: string, checkpoint: string): TaskApproval | undefined {
    const row = selectOne<TaskApprovalRow, [string, string]>(
      this.#database,
      `
        SELECT ${TASK_APPROVAL_COLUMNS}
        FROM task_approvals approval
        WHERE approval.task_id = ? AND approval.checkpoint = ?
      `,
      [taskId, checkpoint],
    );
    return row ? mapTaskApproval(row) : undefined;
  }

  listTaskApprovals(taskId: string): TaskApproval[] {
    this.#requireTask(taskId);
    return selectAll<TaskApprovalRow, [string]>(
      this.#database,
      `
        SELECT ${TASK_APPROVAL_COLUMNS}
        FROM task_approvals approval
        WHERE approval.task_id = ?
        ORDER BY approval.requested_at, approval.checkpoint
      `,
      [taskId],
    ).map(mapTaskApproval);
  }

  pauseRunForApproval(
    id: string,
    input: PauseRunForApprovalInput,
    leaseToken?: string,
  ): { run: Run; task: Task; approval: TaskApproval } {
    const pause = this.#database.transaction(() => {
      const run = this.#requireRun(id);
      const task = this.#requireTask(run.taskId);
      if (!ACTIVE_RUN_STATUSES.includes(run.status as (typeof ACTIVE_RUN_STATUSES)[number])) {
        throw new AgentQError(`Run ${id} is already terminal`, "RUN_NOT_ACTIVE");
      }
      this.#assertRunLease(id, leaseToken);
      if (!run.worktreePath || !run.branchName || !run.baseSha) {
        throw new AgentQError(
          `Run ${id} cannot resume because its durable worktree metadata is incomplete`,
          "RUN_NOT_RESUMABLE",
        );
      }
      const checkpoint = nonEmpty(input.checkpoint, "checkpoint");
      const existing = this.getTaskApproval(task.id, checkpoint);
      if (existing?.status === "approved") {
        throw new AgentQError(
          `Approval checkpoint ${checkpoint} is already approved`,
          "APPROVAL_ALREADY_DECIDED",
        );
      }
      if (existing?.status === "rejected") {
        throw new AgentQError(
          `Approval checkpoint ${checkpoint} was rejected`,
          "APPROVAL_REJECTED",
        );
      }

      const requestedAt = timestamp(input.requestedAt, "approval requestedAt");
      const planOutput =
        input.planOutput === undefined ? run.planOutput : nonEmpty(input.planOutput, "planOutput");
      if (!planOutput) {
        throw new AgentQError(
          `Run ${id} must persist a planner handoff before approval`,
          "RUN_NOT_RESUMABLE",
        );
      }
      if (planOutput.length > MAX_PLAN_OUTPUT_LENGTH) {
        throw new AgentQError(
          `planOutput cannot exceed ${MAX_PLAN_OUTPUT_LENGTH} characters`,
          "INVALID_INPUT",
          2,
        );
      }
      const planSessionId = input.planSessionId?.trim() || run.planSessionId || null;

      this.#database.run(
        `
          INSERT INTO task_approvals(
            task_id, checkpoint, status, run_id, requested_at,
            decided_at, actor, note
          ) VALUES (?, ?, 'pending', ?, ?, NULL, NULL, NULL)
          ON CONFLICT(task_id, checkpoint) DO UPDATE SET
            status = 'pending',
            run_id = excluded.run_id,
            requested_at = excluded.requested_at,
            decided_at = NULL,
            actor = NULL,
            note = NULL
          WHERE task_approvals.status = 'pending'
        `,
        [task.id, checkpoint, run.id, requestedAt],
      );

      const bindings: Binding[] = [
        planOutput,
        planSessionId,
        requestedAt,
        requestedAt,
        `Waiting for approval: ${checkpoint}`,
        id,
      ];
      if (leaseToken !== undefined) bindings.push(leaseToken);
      const leaseCondition = leaseToken === undefined ? "" : " AND owner_token = ?";
      const changed = this.#database.run(
        `
          UPDATE runs
          SET status = 'interrupted', phase = 'implement', plan_output = ?,
              plan_session_id = COALESCE(?, plan_session_id),
              heartbeat_at = ?, finished_at = ?, error = ?,
              failure_class = 'blocked_dependency', retry_disposition = 'wait'
          WHERE id = ? AND status IN ('starting', 'running', 'cancelling')
            ${leaseCondition}
        `,
        bindings,
      ).changes;
      if (changed !== 1) {
        throw new AgentQError(`Run ${id} lease was lost`, "RUN_LEASE_LOST");
      }

      const taskChanged = this.#database.run(
        `
          UPDATE tasks
          SET status = 'queued', attempt_count = CASE
                WHEN attempt_count > 0 THEN attempt_count - 1
                ELSE 0
              END,
              current_run_id = NULL, resume_run_id = ?, current_phase = 'approval',
              blocked_reason = ?, failure_class = 'blocked_dependency',
              failure_reason = ?, retry_disposition = 'wait',
              completed_at = NULL, updated_at = ?
          WHERE id = ? AND current_run_id = ?
        `,
        [
          run.id,
          `Waiting for approval: ${checkpoint}`,
          `Approval checkpoint ${checkpoint} is pending`,
          requestedAt,
          task.id,
          run.id,
        ],
      ).changes;
      if (taskChanged !== 1) {
        throw new AgentQError(
          `Task ${task.id} changed before approval could be requested`,
          "TASK_STATE_CHANGED",
        );
      }
      this.appendEvent({
        taskId: task.id,
        runId: run.id,
        kind: "task.approval_requested",
        payload: { checkpoint },
        createdAt: requestedAt,
      });
      return {
        run: this.#requireRun(run.id),
        task: this.#requireTask(task.id),
        approval: this.#requireTaskApproval(task.id, checkpoint),
      };
    });
    return pause.immediate();
  }

  approveTaskCheckpoint(
    taskId: string,
    checkpoint: string,
    input: DecideTaskApprovalInput = {},
  ): TaskApproval {
    return this.#decideTaskCheckpoint(taskId, checkpoint, "approved", input);
  }

  rejectTaskCheckpoint(
    taskId: string,
    checkpoint: string,
    input: DecideTaskApprovalInput = {},
  ): TaskApproval {
    return this.#decideTaskCheckpoint(taskId, checkpoint, "rejected", input);
  }

  counts(): StoreCounts {
    const count = (table: "queues" | "tasks" | "runs" | "task_events") => {
      const row = selectOne<CountRow, []>(
        this.#database,
        `SELECT COUNT(*) AS count FROM ${table}`,
        [],
      );
      if (!row) throw new AgentQError(`Could not count ${table}`, "DATABASE_ERROR");
      return integerValue(row.count, table, "<count>", "count");
    };
    return {
      queues: count("queues"),
      tasks: count("tasks"),
      runs: count("runs"),
      events: count("task_events"),
    };
  }

  #requireQueue(idOrName: string, repoKey?: string): Queue {
    const queue = this.getQueue(idOrName, repoKey);
    if (!queue) throw new AgentQError(`Queue ${idOrName} does not exist`, "QUEUE_NOT_FOUND");
    return queue;
  }

  #requireTask(id: string): Task {
    const task = this.getTask(id);
    if (!task) throw new AgentQError(`Task ${id} does not exist`, "TASK_NOT_FOUND");
    return task;
  }

  #requireRun(id: string): Run {
    const run = this.getRun(id);
    if (!run) throw new AgentQError(`Run ${id} does not exist`, "RUN_NOT_FOUND");
    return run;
  }

  #requireTaskArtifact(id: string): TaskArtifact {
    const artifact = this.getTaskArtifact(id);
    if (!artifact) {
      throw new AgentQError(`Task artifact ${id} does not exist`, "TASK_ARTIFACT_NOT_FOUND");
    }
    return artifact;
  }

  #requireIntegrationLane(id: string): IntegrationLane {
    const lane = this.getIntegrationLane(id);
    if (!lane) {
      throw new AgentQError(`Integration lane ${id} does not exist`, "INTEGRATION_LANE_NOT_FOUND");
    }
    return lane;
  }

  #requireDeliveryOperation(id: string): DeliveryOperation {
    const operation = this.getDeliveryOperation(id);
    if (!operation) {
      throw new AgentQError(
        `Delivery operation ${id} does not exist`,
        "DELIVERY_OPERATION_NOT_FOUND",
      );
    }
    return operation;
  }

  #requireClaimedDeliveryOperation(
    id: string,
    leaseToken: string,
    fenceToken: number,
    kind: DeliveryOperation["kind"],
  ): DeliveryOperation {
    const operation = this.#requireDeliveryOperation(nonEmpty(id, "operationId"));
    if (
      operation.kind !== kind ||
      operation.status !== "running" ||
      operation.ownerToken !== nonEmpty(leaseToken, "leaseToken") ||
      operation.fenceToken !== integerInput(fenceToken, "fenceToken", 1)
    ) {
      throw new AgentQError(
        `Delivery operation ${operation.id} lease was lost`,
        "DELIVERY_LEASE_LOST",
      );
    }
    return operation;
  }

  #requireTaskApproval(taskId: string, checkpoint: string): TaskApproval {
    const approval = this.getTaskApproval(taskId, checkpoint);
    if (!approval) {
      throw new AgentQError(
        `Approval checkpoint ${checkpoint} does not exist for task ${taskId}`,
        "APPROVAL_NOT_FOUND",
      );
    }
    return approval;
  }

  #decideTaskCheckpoint(
    taskId: string,
    checkpoint: string,
    decision: Extract<TaskApproval["status"], "approved" | "rejected">,
    input: DecideTaskApprovalInput,
  ): TaskApproval {
    const decide = this.#database.transaction(() => {
      const task = this.#requireTask(nonEmpty(taskId, "taskId"));
      const checkedCheckpoint = nonEmpty(checkpoint, "checkpoint");
      const approval = this.#requireTaskApproval(task.id, checkedCheckpoint);
      if (approval.status === decision) return approval;
      if (approval.status !== "pending") {
        throw new AgentQError(
          `Approval checkpoint ${checkedCheckpoint} is already ${approval.status}`,
          "APPROVAL_ALREADY_DECIDED",
        );
      }
      const decidedAt = timestamp(input.decidedAt, "approval decidedAt");
      const actor = input.actor === undefined ? null : nonEmpty(input.actor, "actor");
      const note = input.note?.trim() || null;
      const changed = this.#database.run(
        `
          UPDATE task_approvals
          SET status = ?, decided_at = ?, actor = ?, note = ?
          WHERE task_id = ? AND checkpoint = ? AND status = 'pending'
        `,
        [decision, decidedAt, actor, note, task.id, checkedCheckpoint],
      ).changes;
      if (changed !== 1) {
        throw new AgentQError(
          `Approval checkpoint ${checkedCheckpoint} changed before the decision was stored`,
          "APPROVAL_DECISION_CONFLICT",
        );
      }

      const pendingApprovals =
        decision === "approved"
          ? integerValue(
              selectOne<CountRow, [string]>(
                this.#database,
                `
                  SELECT COUNT(*) AS count
                  FROM task_approvals
                  WHERE task_id = ? AND status = 'pending'
                `,
                [task.id],
              )?.count,
              "task approvals",
              task.id,
              "pending count",
            )
          : 0;
      let taskChanged: number;
      if (task.status === "queued") {
        taskChanged =
          decision === "approved"
            ? this.#database.run(
                `
                  UPDATE tasks
                  SET current_phase = ?,
                      blocked_reason = ?,
                      failure_class = ?,
                      failure_reason = ?,
                      retry_disposition = ?,
                      updated_at = ?
                  WHERE id = ? AND status = 'queued'
                    AND current_phase = 'approval'
                `,
                [
                  pendingApprovals > 0 ? "approval" : task.resumeRunId ? "implement" : "queued",
                  pendingApprovals > 0
                    ? `Waiting for ${pendingApprovals} approval checkpoint${pendingApprovals === 1 ? "" : "s"}`
                    : null,
                  pendingApprovals > 0 ? "blocked_dependency" : null,
                  pendingApprovals > 0 ? "One or more approval checkpoints are pending" : null,
                  pendingApprovals > 0 ? "wait" : null,
                  decidedAt,
                  task.id,
                ],
              ).changes
            : this.#database.run(
                `
                  UPDATE tasks
                  SET status = 'failed', current_phase = 'complete',
                      blocked_reason = NULL, failure_class = 'policy_violation',
                      failure_reason = ?, retry_disposition = 'stop',
                      resume_run_id = NULL, completed_at = ?, updated_at = ?
                  WHERE id = ? AND status = 'queued' AND current_phase = 'approval'
                `,
                [
                  note
                    ? `Approval checkpoint ${checkedCheckpoint} rejected: ${note}`
                    : `Approval checkpoint ${checkedCheckpoint} rejected`,
                  decidedAt,
                  decidedAt,
                  task.id,
                ],
              ).changes;
      } else if (task.status === "succeeded") {
        const resumedPhase = task.deliveryStatus === "integrated" ? "land" : "integrate";
        taskChanged =
          decision === "approved"
            ? this.#database.run(
                `
                  UPDATE tasks
                  SET current_phase = ?, blocked_reason = ?,
                      failure_class = ?, failure_reason = ?,
                      retry_disposition = ?, updated_at = ?
                  WHERE id = ? AND status = 'succeeded'
                    AND current_phase = 'approval'
                `,
                [
                  pendingApprovals > 0 ? "approval" : resumedPhase,
                  pendingApprovals > 0
                    ? `Waiting for ${pendingApprovals} approval checkpoint${pendingApprovals === 1 ? "" : "s"}`
                    : null,
                  pendingApprovals > 0 ? "blocked_dependency" : null,
                  pendingApprovals > 0 ? "One or more approval checkpoints are pending" : null,
                  pendingApprovals > 0 ? "wait" : null,
                  decidedAt,
                  task.id,
                ],
              ).changes
            : this.#database.run(
                `
                  UPDATE tasks
                  SET status = 'failed', current_phase = 'complete',
                      blocked_reason = NULL, failure_class = 'policy_violation',
                      failure_reason = ?, retry_disposition = 'stop',
                      completed_at = ?, updated_at = ?
                  WHERE id = ? AND status = 'succeeded'
                    AND current_phase = 'approval'
                `,
                [
                  note
                    ? `Approval checkpoint ${checkedCheckpoint} rejected: ${note}`
                    : `Approval checkpoint ${checkedCheckpoint} rejected`,
                  decidedAt,
                  decidedAt,
                  task.id,
                ],
              ).changes;
      } else {
        taskChanged = 0;
      }
      if (taskChanged !== 1) {
        throw new AgentQError(
          `Task ${task.id} is no longer waiting at ${checkedCheckpoint}`,
          "TASK_STATE_CHANGED",
        );
      }
      this.appendEvent({
        taskId: task.id,
        kind: `task.approval_${decision}`,
        payload: {
          checkpoint: checkedCheckpoint,
          ...(actor === null ? {} : { actor }),
          ...(note === null ? {} : { note }),
        },
        createdAt: decidedAt,
      });
      return this.#requireTaskApproval(task.id, checkedCheckpoint);
    });
    return decide.immediate();
  }

  #fileConcurrencyAllows(task: Task, queue: Queue): boolean {
    const activeScopes = selectAll<ActiveFileScopeRow, [string, string]>(
      this.#database,
      `
        SELECT active_task.id AS task_id,
               active_task.expected_paths,
               active_task.allowed_paths,
               active_queue.allowed_paths AS queue_allowed_paths,
               active_queue.file_concurrency
        FROM runs active_run
        JOIN tasks active_task ON active_task.id = active_run.task_id
        JOIN queues active_queue ON active_queue.id = active_task.queue_id
        WHERE active_queue.repo_key = ?
          AND active_task.id <> ?
          AND active_run.status IN ('starting', 'running', 'cancelling')
      `,
      [queue.repoKey, task.id],
    );
    const taskScope =
      task.expectedPaths.length > 0
        ? task.expectedPaths
        : task.allowedPaths.length > 0
          ? task.allowedPaths
          : queue.allowedPaths;

    return !activeScopes.some((row) => {
      const activeTaskId = stringValue(row.task_id, "active file scope", "<unknown>", "task_id");
      const activeMode = enumValue(
        row.file_concurrency,
        FILE_CONCURRENCY_MODES,
        "active file scope",
        activeTaskId,
        "file_concurrency",
      );
      if (queue.fileConcurrency !== "enforced" && activeMode !== "enforced") return false;
      const expectedPaths = jsonStringArray(
        row.expected_paths,
        "active file scope",
        activeTaskId,
        "expected_paths",
      );
      const allowedPaths = jsonStringArray(
        row.allowed_paths,
        "active file scope",
        activeTaskId,
        "allowed_paths",
      );
      const queueAllowedPaths = jsonStringArray(
        row.queue_allowed_paths,
        "active file scope",
        activeTaskId,
        "queue_allowed_paths",
      );
      const activeScope =
        expectedPaths.length > 0
          ? expectedPaths
          : allowedPaths.length > 0
            ? allowedPaths
            : queueAllowedPaths;
      return scopePatternSetsMayOverlap(taskScope, activeScope);
    });
  }

  #assertRunLease(id: string, leaseToken?: string): void {
    if (leaseToken === undefined) return;
    const row = selectOne<{ owner_token: unknown }, [string]>(
      this.#database,
      "SELECT owner_token FROM runs WHERE id = ?",
      [id],
    );
    if (!row) throw new AgentQError(`Run ${id} does not exist`, "RUN_NOT_FOUND");
    if (row.owner_token !== leaseToken) {
      throw new AgentQError(`Run ${id} is owned by another supervisor`, "RUN_LEASE_LOST");
    }
  }

  #requireEvent(id: number): TaskEvent {
    const row = selectOne<EventRow, [number]>(
      this.#database,
      `SELECT ${EVENT_COLUMNS} FROM task_events e WHERE e.id = ?`,
      [id],
    );
    if (!row) throw new AgentQError(`Event ${id} does not exist`, "EVENT_NOT_FOUND");
    return mapEvent(row);
  }

  #replaceTaskDependencies(taskId: string, blockerIds: readonly string[], at: string): void {
    const task = this.#requireTask(taskId);
    const queue = this.#requireQueue(task.queueId);
    const normalized = [
      ...new Set(stringArrayInput(blockerIds, "blockedBy").map((id) => nonEmpty(id, "blockedBy"))),
    ].sort();
    if (normalized.includes(taskId)) {
      throw new AgentQError("A task cannot block itself", "TASK_DEPENDENCY_SELF", 2);
    }

    const blockers = normalized.map((blockerId) => {
      const blocker = this.getTask(blockerId);
      if (!blocker) {
        throw new AgentQError(`Task ${blockerId} does not exist`, "TASK_NOT_FOUND", 2);
      }
      const blockerQueue = this.#requireQueue(blocker.queueId);
      if (blockerQueue.repoKey !== queue.repoKey) {
        throw new AgentQError(
          `Task ${blockerId} belongs to a different repository`,
          "TASK_DEPENDENCY_REPOSITORY_MISMATCH",
          2,
        );
      }
      return blocker;
    });

    this.#database.run("DELETE FROM task_dependencies WHERE task_id = ?", [taskId]);
    for (const blocker of blockers) {
      this.#database.run(
        `
          INSERT INTO task_dependencies(task_id, blocker_task_id, created_at)
          VALUES (?, ?, ?)
        `,
        [taskId, blocker.id, at],
      );
    }

    const cycle = selectOne<{ id: string }, [string, string]>(
      this.#database,
      `
        WITH RECURSIVE ancestors(id) AS (
          SELECT blocker_task_id
          FROM task_dependencies
          WHERE task_id = ?
          UNION
          SELECT dependency.blocker_task_id
          FROM task_dependencies dependency
          JOIN ancestors ON dependency.task_id = ancestors.id
        )
        SELECT id
        FROM ancestors
        WHERE id = ?
        LIMIT 1
      `,
      [taskId, taskId],
    );
    if (cycle) {
      throw new AgentQError(
        `Task dependency would create a cycle involving ${taskId}`,
        "TASK_DEPENDENCY_CYCLE",
        2,
      );
    }

    this.#database.run(
      `
        UPDATE tasks
        SET current_phase = CASE
              WHEN status = 'queued' AND ? > 0 THEN 'blocked'
              WHEN status = 'queued' AND current_phase = 'blocked' THEN 'queued'
              ELSE current_phase
            END,
            blocked_reason = CASE
              WHEN status <> 'queued' THEN blocked_reason
              WHEN ? > 0 THEN ?
              ELSE NULL
            END
        WHERE id = ?
      `,
      [
        normalized.length,
        normalized.length,
        normalized.length === 1
          ? `Waiting for blocker ${normalized[0]}`
          : `Waiting for ${normalized.length} blockers`,
        taskId,
      ],
    );
  }
}

export function openStore(databasePath: string, options?: StoreOptions): AgentQStore {
  return new AgentQStore(databasePath, options);
}
