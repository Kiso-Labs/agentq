import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { AgentQError, errorMessage } from "../core/errors.ts";
import { isoNow, makeId } from "../core/paths.ts";
import {
  type AddTaskInput,
  type CreateQueueInput,
  canCompleteTaskManually,
  canRetryTask,
  isTaskActive,
  PROVIDERS,
  type Queue,
  RUN_STATUSES,
  type Run,
  type RunStatus,
  TASK_STATUSES,
  type Task,
  type TaskEvent,
  type TaskSpecSnapshot,
  type TaskStatus,
} from "../core/types.ts";
import { migrate } from "./migrations.ts";
import { selectAll, selectOne } from "./sqlite.ts";
import type {
  AddTaskOptions,
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

interface QueueRow {
  id: unknown;
  name: unknown;
  repo_key: unknown;
  repo_path: unknown;
  base_ref: unknown;
  default_provider: unknown;
  concurrency: unknown;
  max_attempts: unknown;
  verify_commands: unknown;
  auto_commit: unknown;
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
  provider: unknown;
  priority: unknown;
  status: unknown;
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
  base_sha: unknown;
  branch_name: unknown;
  worktree_path: unknown;
  provider_session_id: unknown;
  pid: unknown;
  process_token: unknown;
  process_start_marker: unknown;
  process_identity_path: unknown;
  owner_token: unknown;
  owner_pid: unknown;
  task_snapshot: unknown;
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
  q.concurrency,
  q.max_attempts,
  q.verify_commands,
  q.auto_commit,
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
  t.provider,
  t.priority,
  t.status,
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
  r.base_sha,
  r.branch_name,
  r.worktree_path,
  r.provider_session_id,
  r.pid,
  r.process_token,
  r.process_start_marker,
  r.process_identity_path,
  r.owner_token,
  r.owner_pid,
  r.task_snapshot,
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

function taskSpecSnapshot(
  value: unknown,
  entity: string,
  id: string,
  column: string,
): TaskSpecSnapshot | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = jsonObject(value, entity, id, column);
  const acceptanceCriteria = parsed.acceptanceCriteria;
  if (
    !Array.isArray(acceptanceCriteria) ||
    !acceptanceCriteria.every((item) => typeof item === "string")
  ) {
    return corrupt(entity, id, column, "a task specification snapshot");
  }
  return {
    title: stringValue(parsed.title, entity, id, `${column}.title`),
    instructions: stringValue(parsed.instructions, entity, id, `${column}.instructions`),
    acceptanceCriteria: [...acceptanceCriteria],
    provider: enumValue(parsed.provider, PROVIDERS, entity, id, `${column}.provider`),
    priority: integerValue(parsed.priority, entity, id, `${column}.priority`),
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
  return {
    id,
    name: stringValue(row.name, "queue", id, "name"),
    repoKey: stringValue(row.repo_key, "queue", id, "repo_key"),
    repoPath: stringValue(row.repo_path, "queue", id, "repo_path"),
    baseRef: stringValue(row.base_ref, "queue", id, "base_ref"),
    defaultProvider: enumValue(row.default_provider, PROVIDERS, "queue", id, "default_provider"),
    concurrency: integerValue(row.concurrency, "queue", id, "concurrency"),
    maxAttempts: integerValue(row.max_attempts, "queue", id, "max_attempts"),
    verifyCommands: jsonStringArray(row.verify_commands, "queue", id, "verify_commands"),
    autoCommit: booleanValue(row.auto_commit, "queue", id, "auto_commit"),
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
  return {
    id,
    queueId: stringValue(row.queue_id, "task", id, "queue_id"),
    ...(row.queue_name === undefined || row.queue_name === null
      ? {}
      : { queueName: stringValue(row.queue_name, "task", id, "queue_name") }),
    title: stringValue(row.title, "task", id, "title"),
    instructions: stringValue(row.instructions, "task", id, "instructions"),
    acceptanceCriteria: jsonStringArray(row.acceptance_criteria, "task", id, "acceptance_criteria"),
    provider: enumValue(row.provider, PROVIDERS, "task", id, "provider"),
    priority: integerValue(row.priority, "task", id, "priority"),
    status: enumValue(row.status, TASK_STATUSES, "task", id, "status"),
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
    ...optional("baseSha", optionalString(row.base_sha, "run", id, "base_sha")),
    ...optional("branchName", optionalString(row.branch_name, "run", id, "branch_name")),
    ...optional("worktreePath", optionalString(row.worktree_path, "run", id, "worktree_path")),
    ...optional(
      "providerSessionId",
      optionalString(row.provider_session_id, "run", id, "provider_session_id"),
    ),
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

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new AgentQError(`${field} cannot be empty`, "INVALID_INPUT", 2);
  return normalized;
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
    const concurrency = integerInput(input.concurrency ?? 1, "concurrency", 1);
    const maxAttempts = integerInput(input.maxAttempts ?? 3, "maxAttempts", 1);
    const verifyCommands = stringArrayInput(input.verifyCommands ?? [], "verifyCommands");
    const now = isoNow();

    try {
      this.#database.run(
        `
          INSERT INTO queues(
            id, name, repo_key, repo_path, base_ref, default_provider, concurrency,
            max_attempts, verify_commands, auto_commit, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          id,
          name,
          repoKey,
          repoPath,
          baseRef,
          defaultProvider,
          concurrency,
          maxAttempts,
          JSON.stringify(verifyCommands),
          input.autoCommit === true ? 1 : 0,
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
    if (patch.defaultProvider !== undefined) set("default_provider", patch.defaultProvider);
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
      const priority = integerInput(input.priority ?? 0, "priority");

      try {
        this.#database.run(
          `
            INSERT INTO tasks(
              id, queue_id, title, instructions, acceptance_criteria, provider,
              priority, status, source_kind, parent_task_id, idempotency_key,
              attempt_count, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, 0, ?, ?)
          `,
          [
            id,
            queue.id,
            title,
            input.instructions ?? "",
            JSON.stringify(acceptanceCriteria),
            input.provider ?? queue.defaultProvider,
            priority,
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

      return this.#requireTask(id);
    });

    return add.immediate();
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
    if (fields.length === 0) {
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

      const changed = this.#database.run(
        `
          DELETE FROM tasks
          WHERE id = ?
            AND current_run_id IS NULL
            AND status NOT IN ('starting', 'running', 'cancelling')
        `,
        [id],
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
        if (
          resumeRun.taskId !== task.id ||
          resumeRun.provider !== task.provider ||
          !resumeRun.providerSessionId ||
          !resumeRun.worktreePath
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

      const candidate = selectOne<TaskRow, Binding[]>(
        this.#database,
        `
          SELECT ${TASK_COLUMNS}
          FROM tasks t
          JOIN queues q ON q.id = t.queue_id
          WHERE t.status = 'queued'
            AND t.cancel_requested_at IS NULL
            AND t.attempt_count < q.max_attempts
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
          LIMIT 1
        `,
        bindings,
      );

      if (!candidate) return undefined;

      const task = mapTask(candidate);
      const queue = this.#requireQueue(task.queueId);
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
      const snapshot: TaskSpecSnapshot = {
        title: task.title,
        instructions: task.instructions,
        acceptanceCriteria: [...task.acceptanceCriteria],
        provider: task.provider,
        priority: task.priority,
      };

      this.#database.run(
        `
          INSERT INTO runs(
            id, task_id, attempt_no, provider, status, owner_token, owner_pid,
            task_snapshot, started_at, heartbeat_at
          ) VALUES (?, ?, ?, ?, 'starting', ?, ?, ?, ?, ?)
        `,
        [
          runId,
          task.id,
          attemptNo,
          task.provider,
          ownerToken,
          ownerPid,
          JSON.stringify(snapshot),
          now,
          now,
        ],
      );

      const changed = this.#database.run(
        `
          UPDATE tasks
          SET status = 'starting', attempt_count = ?, current_run_id = ?, updated_at = ?
          WHERE id = ? AND status = 'queued'
        `,
        [attemptCount, runId, now, task.id],
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

    return selectAll<RunRow, Binding[]>(
      this.#database,
      `
        SELECT ${RUN_COLUMNS}
        FROM runs r
        ${join}
        ${clause}
        ORDER BY r.started_at DESC, r.id DESC
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
    this.#assertRunLease(id, leaseToken);
    const fields: string[] = [];
    const values: Binding[] = [];
    const set = (column: string, value: Binding) => {
      fields.push(`${column} = ?`);
      values.push(value);
    };

    if (patch.status !== undefined) {
      set("status", patch.status);
    }
    if (patch.baseSha !== undefined) set("base_sha", patch.baseSha);
    if (patch.branchName !== undefined) set("branch_name", patch.branchName);
    if (patch.worktreePath !== undefined) set("worktree_path", patch.worktreePath);
    if (patch.providerSessionId !== undefined) {
      set("provider_session_id", patch.providerSessionId);
    }
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

    if (fields.length === 0) return this.#requireRun(id);
    values.push(id);
    if (leaseToken !== undefined) values.push(leaseToken);
    const activeCondition =
      patch.status === undefined ? "" : " AND status IN ('starting', 'running', 'cancelling')";
    const leaseCondition = leaseToken === undefined ? "" : " AND owner_token = ?";
    const changed = this.#database.run(
      `UPDATE runs SET ${fields.join(", ")} WHERE id = ?${activeCondition}${leaseCondition}`,
      values,
    ).changes;

    if (changed === 0) {
      const run = this.#requireRun(id);
      if (patch.status !== undefined) {
        throw new AgentQError(`Run ${id} is already terminal`, "RUN_NOT_ACTIVE");
      }
      return run;
    }

    return this.#requireRun(id);
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
            UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?
          `,
          [status, at, task.id],
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

      this.#database.run(
        `
          UPDATE runs
          SET status = ?, heartbeat_at = ?, finished_at = ?, exit_code = ?,
              summary = ?, error = ?, provider_session_id = COALESCE(?, provider_session_id)
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
      } else if (input.requeue || task.attemptCount < queue.maxAttempts) {
        taskStatus = "queued";
        completedAt = null;
      } else {
        taskStatus = runStatus === "failed" ? "failed" : "interrupted";
        completedAt = finishedAt;
      }

      const restoredAttemptCount = input.requeue
        ? Math.max(0, task.attemptCount - 1)
        : task.attemptCount;
      this.#database.run(
        `
          UPDATE tasks
          SET status = ?, attempt_count = ?, current_run_id = NULL, completed_at = ?,
              resume_run_id = CASE WHEN ? = 1 THEN NULL ELSE resume_run_id END,
              updated_at = ?
          WHERE id = ? AND current_run_id = ?
        `,
        [
          taskStatus,
          restoredAttemptCount,
          completedAt,
          taskStatus === "queued" ? 0 : 1,
          finishedAt,
          task.id,
          id,
        ],
      );

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
    return selectAll<EventRow, Binding[]>(
      this.#database,
      `
        SELECT ${EVENT_COLUMNS}
        FROM task_events e
        WHERE ${where.join(" AND ")}
        ORDER BY e.id
        LIMIT ?
      `,
      values,
    ).map(mapEvent);
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
}

export function openStore(databasePath: string, options?: StoreOptions): AgentQStore {
  return new AgentQStore(databasePath, options);
}
