import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { AgentQApp } from "../app.ts";
import { AgentQError, errorMessage } from "../core/errors.ts";
import type { AddTaskInput, Provider, Task } from "../core/types.ts";

const MAX_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_RESPONSE_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CHILDREN_PER_RUN = 16;
const DEFAULT_MAX_DELEGATION_DEPTH = 4;
const MAX_CONFIGURED_LIMIT = 10_000;
const MAX_REQUESTS_PER_DRAIN = 512;
const MAX_MANIFEST_BYTES = 16 * 1024;
const REQUEST_PATTERN = /^request-([a-f0-9]{32})\.json$/;
const RESPONSE_PATTERN = /^response-[a-f0-9]{32}\.json$/;
const OWN_TEMP_PATTERN =
  /^(?:registration\.json|(?:request|response)-[a-f0-9]{32}\.json)\.\d+\.[a-f0-9-]{36}\.tmp$/;
const STAGING_RUN_PATTERN = /^run-[a-f0-9]{64}$/;
const MANAGED_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const REGISTRATION_FILE = "registration.json";

const delegatedTaskSchema = z.object({
  title: z.string().trim().min(1).max(500),
  instructions: z.string().max(500_000).optional(),
  acceptanceCriteria: z.array(z.string().max(10_000)).max(100).optional(),
  provider: z.enum(["codex", "claude"]).optional(),
  priority: z.number().int().min(-1_000_000).max(1_000_000).optional(),
  idempotencyKey: z.string().trim().min(1).max(500).optional(),
});

const requestSchema = z.object({
  version: z.literal(1),
  id: z.string().regex(/^[a-f0-9]{32}$/),
  task: delegatedTaskSchema,
});

const registrationSchema = z.object({
  version: z.literal(1),
  runId: z.string().regex(MANAGED_RUN_ID_PATTERN),
  queue: z.string().min(1).max(500),
  parentTaskId: z.string().min(1).max(500),
});

interface IntakeRegistration {
  runId: string;
  directory: string;
  parentTaskId: string;
  queue: string;
  depth: number;
  stagingDirectory: string;
}

interface IntakeSuccess {
  ok: true;
  task: Task;
}

interface IntakeFailure {
  ok: false;
  code: string;
  error: string;
}

type IntakeResponse = IntakeSuccess | IntakeFailure;

export interface DelegatedTaskIntakeOptions {
  maxChildrenPerRun?: number;
  maxDelegationDepth?: number;
}

/**
 * A narrow file-based bridge used by sandboxed managed agents. Each run receives
 * write access to only its own inbox; the supervisor atomically moves requests
 * into a private staging directory, reads through one bounded file descriptor,
 * and forces queue/parent provenance rather than trusting submitted payloads.
 */
export class DelegatedTaskIntake {
  private readonly registrations = new Map<string, IntakeRegistration>();
  private readonly stagingDirectory: string;
  private readonly maxChildrenPerRun: number;
  private readonly maxDelegationDepth: number;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly app: AgentQApp,
    options: DelegatedTaskIntakeOptions = {},
  ) {
    this.stagingDirectory = join(app.paths.stateDir, "intake-staging");
    this.maxChildrenPerRun = configuredLimit(
      options.maxChildrenPerRun,
      "AGENTQ_MAX_CHILD_TASKS_PER_RUN",
      DEFAULT_MAX_CHILDREN_PER_RUN,
    );
    this.maxDelegationDepth = configuredLimit(
      options.maxDelegationDepth,
      "AGENTQ_MAX_DELEGATION_DEPTH",
      DEFAULT_MAX_DELEGATION_DEPTH,
    );
  }

  async register(runId: string, queue: string, parentTaskId: string): Promise<string> {
    if (!MANAGED_RUN_ID_PATTERN.test(runId)) {
      throw new AgentQError("Managed intake run ID is invalid", "INVALID_INTAKE");
    }
    const directory = join(this.app.paths.stateDir, "intake", runId);
    const runStagingDirectory = this.runStagingDirectory(runId);
    await Promise.all([
      mkdir(directory, { recursive: true, mode: 0o700 }),
      mkdir(this.stagingDirectory, { recursive: true, mode: 0o700 }),
      mkdir(runStagingDirectory, { recursive: true, mode: 0o700 }),
    ]);
    const parent = this.app.store.getTask(parentTaskId);
    if (!parent || parent.queueId !== queue) {
      throw new AgentQError("Managed intake parent does not belong to its queue", "INVALID_INTAKE");
    }
    const registration = {
      runId,
      directory,
      queue,
      parentTaskId,
      depth: this.taskDepth(parentTaskId),
      stagingDirectory: runStagingDirectory,
    } satisfies IntakeRegistration;
    await atomicWrite(
      join(runStagingDirectory, REGISTRATION_FILE),
      JSON.stringify({ version: 1, runId, queue, parentTaskId }),
    );
    this.registrations.set(runId, registration);
    return directory;
  }

  unregister(runId: string): void {
    this.registrations.delete(runId);
  }

  async cleanup(runId: string): Promise<void> {
    await this.serialize(async () => {
      const registration =
        this.registrations.get(runId) ?? (await this.loadDurableRegistration(runId));
      if (!registration) return;

      await this.drainRegistration(registration);
      if (await this.hasPendingRequests(registration)) return;

      this.registrations.delete(runId);
      await removeOwnedEntries(registration.directory, true);
      await rmdir(registration.directory).catch(() => undefined);
      await unlink(join(registration.stagingDirectory, REGISTRATION_FILE)).catch(() => undefined);
      await removeOwnedEntries(registration.stagingDirectory, false);
      await rmdir(registration.stagingDirectory).catch(() => undefined);
    });
  }

  async drain(): Promise<void> {
    await this.serialize(() => this.drainRegistered());
  }

  private async serialize(operation: () => Promise<void>): Promise<void> {
    const result = this.operationTail.then(operation);
    this.operationTail = result.catch(() => undefined);
    await result;
  }

  private taskDepth(taskId: string): number {
    let depth = 0;
    let current = this.app.store.getTask(taskId);
    const seen = new Set<string>();
    while (current?.parentTaskId) {
      if (seen.has(current.id)) {
        throw new AgentQError("Task ancestry contains a cycle", "INVALID_INTAKE");
      }
      seen.add(current.id);
      depth += 1;
      current = this.app.store.getTask(current.parentTaskId);
      if (!current) throw new AgentQError("Task ancestry is incomplete", "INVALID_INTAKE");
    }
    return depth;
  }

  private async drainRegistered(): Promise<void> {
    await mkdir(this.stagingDirectory, { recursive: true, mode: 0o700 });
    for (const registration of await this.allRegistrations()) {
      await this.drainRegistration(registration);
    }
  }

  private async drainRegistration(registration: IntakeRegistration): Promise<void> {
    await mkdir(registration.stagingDirectory, { recursive: true, mode: 0o700 });
    let processed = await this.drainStagedRequests(registration, MAX_REQUESTS_PER_DRAIN);
    if (processed >= MAX_REQUESTS_PER_DRAIN) return;

    const directory = await opendir(registration.directory).catch(() => undefined);
    if (!directory) return;
    for await (const entry of directory) {
      const match = REQUEST_PATTERN.exec(entry.name);
      if (!match) continue;
      const id = match[1];
      if (!id) continue;
      const requestPath = join(registration.directory, entry.name);
      const metadata = await lstat(requestPath).catch(() => undefined);
      if (!metadata?.isFile() || metadata.isSymbolicLink()) continue;

      const stagedPath = join(registration.stagingDirectory, `request-${id}.json`);
      if (await pathExists(stagedPath)) {
        await this.processStagedRequest(registration, id, stagedPath);
      }
      if (!(await this.stageRequest(requestPath, stagedPath, registration, id))) continue;

      processed += 1;
      await this.processStagedRequest(registration, id, stagedPath);
      if (processed >= MAX_REQUESTS_PER_DRAIN) break;
    }
  }

  private async drainStagedRequests(
    registration: IntakeRegistration,
    maximum: number,
  ): Promise<number> {
    const directory = await opendir(registration.stagingDirectory).catch(() => undefined);
    if (!directory) return 0;
    let processed = 0;
    for await (const entry of directory) {
      const match = REQUEST_PATTERN.exec(entry.name);
      if (!match) continue;
      const id = match[1];
      if (!id) continue;
      processed += 1;
      await this.processStagedRequest(
        registration,
        id,
        join(registration.stagingDirectory, entry.name),
      );
      if (processed >= maximum) break;
    }
    return processed;
  }

  private async stageRequest(
    requestPath: string,
    stagedPath: string,
    registration: IntakeRegistration,
    requestId: string,
  ): Promise<boolean> {
    try {
      await link(requestPath, stagedPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EEXIST") return false;
      await this.recordFailure(registration, requestId, error);
      return false;
    }
    await unlink(requestPath).catch((error) => this.recordFailure(registration, requestId, error));
    await syncDirectory(dirname(stagedPath));
    await syncDirectory(dirname(requestPath));
    return true;
  }

  private async processStagedRequest(
    registration: IntakeRegistration,
    id: string,
    stagedPath: string,
  ): Promise<void> {
    let response: IntakeResponse;
    try {
      const raw = await readBoundedRegularFile(stagedPath, MAX_REQUEST_BYTES);
      const parsed = requestSchema.parse(JSON.parse(raw));
      if (parsed.id !== id) {
        throw new AgentQError(
          "Delegated task request ID does not match its filename",
          "INVALID_INTAKE",
        );
      }
      response = { ok: true, task: await this.accept(registration, parsed.id, parsed.task) };
    } catch (error) {
      response = {
        ok: false,
        code: error instanceof AgentQError ? error.code : "INTAKE_FAILED",
        error: errorMessage(error),
      };
    }

    try {
      await atomicWrite(
        join(registration.directory, `response-${id}.json`),
        JSON.stringify(response),
      );
    } catch (error) {
      await this.recordFailure(registration, id, error);
      return;
    }

    await unlink(stagedPath).catch(() => undefined);
    await syncDirectory(registration.stagingDirectory);
  }

  private async accept(
    registration: IntakeRegistration,
    requestId: string,
    taskInput: z.infer<typeof delegatedTaskSchema>,
  ): Promise<Task> {
    if (registration.depth >= this.maxDelegationDepth) {
      throw new AgentQError(
        `Delegation depth limit (${this.maxDelegationDepth}) reached`,
        "DELEGATION_DEPTH_LIMIT",
      );
    }
    const sourceKey = taskInput.idempotencyKey ?? requestId;
    const digest = createHash("sha256")
      .update(`${registration.parentTaskId}\0${sourceKey}`)
      .digest("hex");
    const idempotencyKey = `agent-intake:${digest}`;
    return await this.app.addTask(
      {
        ...taskInput,
        idempotencyKey,
        queue: registration.queue,
        parentTaskId: registration.parentTaskId,
        sourceKind: "agent",
      },
      { maxChildrenForParent: this.maxChildrenPerRun },
    );
  }

  private runStagingDirectory(runId: string): string {
    const key = createHash("sha256").update(runId).digest("hex");
    return join(this.stagingDirectory, `run-${key}`);
  }

  private async allRegistrations(): Promise<IntakeRegistration[]> {
    const registrations = new Map(this.registrations);
    const directory = await opendir(this.stagingDirectory).catch(() => undefined);
    if (!directory) return [...registrations.values()];

    for await (const entry of directory) {
      if (!STAGING_RUN_PATTERN.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
        continue;
      }
      const registration = await this.readRegistrationDirectory(
        join(this.stagingDirectory, entry.name),
      );
      if (registration) registrations.set(registration.runId, registration);
    }
    return [...registrations.values()];
  }

  private async loadDurableRegistration(runId: string): Promise<IntakeRegistration | undefined> {
    if (!MANAGED_RUN_ID_PATTERN.test(runId)) return undefined;
    return await this.readRegistrationDirectory(this.runStagingDirectory(runId));
  }

  private async readRegistrationDirectory(
    runStagingDirectory: string,
  ): Promise<IntakeRegistration | undefined> {
    try {
      const raw = await readBoundedRegularFile(
        join(runStagingDirectory, REGISTRATION_FILE),
        MAX_MANIFEST_BYTES,
      );
      const stored = registrationSchema.parse(JSON.parse(raw));
      if (this.runStagingDirectory(stored.runId) !== runStagingDirectory) return undefined;
      const parent = this.app.store.getTask(stored.parentTaskId);
      if (!parent || parent.queueId !== stored.queue) return undefined;
      return {
        runId: stored.runId,
        directory: join(this.app.paths.stateDir, "intake", stored.runId),
        parentTaskId: stored.parentTaskId,
        queue: stored.queue,
        depth: this.taskDepth(stored.parentTaskId),
        stagingDirectory: runStagingDirectory,
      };
    } catch {
      return undefined;
    }
  }

  private async hasPendingRequests(registration: IntakeRegistration): Promise<boolean> {
    return (
      (await directoryHasMatchingEntry(registration.stagingDirectory, REQUEST_PATTERN)) ||
      (await directoryHasMatchingEntry(registration.directory, REQUEST_PATTERN))
    );
  }

  private async recordFailure(
    registration: IntakeRegistration,
    requestId: string,
    error: unknown,
  ): Promise<void> {
    await Promise.resolve()
      .then(() =>
        this.app.store.appendEvent({
          taskId: registration.parentTaskId,
          kind: "intake.failed",
          payload: { requestId, message: errorMessage(error).slice(0, 16_000) },
        }),
      )
      .catch(() => undefined);
  }
}

export function hasDelegatedTaskIntake(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.AGENTQ_AGENT_CONTEXT === "1" && env.AGENTQ_INTAKE_DIR);
}

export async function submitDelegatedTask(
  input: AddTaskInput,
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<Task> {
  const env = options.env ?? process.env;
  const directory = env.AGENTQ_INTAKE_DIR;
  const runId = env.AGENTQ_RUN_ID?.trim();
  if (!directory || env.AGENTQ_AGENT_CONTEXT !== "1") {
    throw new AgentQError("No managed-agent task intake is available", "INTAKE_UNAVAILABLE");
  }
  if (!runId || runId.length > 500) {
    throw new AgentQError("Managed-agent run identity is unavailable", "INVALID_INTAKE");
  }

  const task = delegatedTaskSchema.parse({
    title: input.title,
    instructions: input.instructions,
    acceptanceCriteria: input.acceptanceCriteria,
    provider: input.provider as Provider | undefined,
    priority: input.priority,
    idempotencyKey: input.idempotencyKey,
  });
  const requestIdentity = task.idempotencyKey
    ? `key\0${task.idempotencyKey}`
    : `task\0${canonicalJson(task)}`;
  const id = createHash("sha256")
    .update(`agentq-intake-v1\0${runId}\0${requestIdentity}`)
    .digest("hex")
    .slice(0, 32);
  const requestPath = join(directory, `request-${id}.json`);
  const responsePath = join(directory, `response-${id}.json`);
  if (!(await pathExists(responsePath))) {
    await atomicCreate(requestPath, JSON.stringify({ version: 1, id, task }));
  }

  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS);
  for (;;) {
    try {
      const response = JSON.parse(await readFile(responsePath, "utf8")) as IntakeResponse;
      if (!response || typeof response !== "object" || typeof response.ok !== "boolean") {
        throw new AgentQError("Supervisor returned an invalid intake response", "INVALID_INTAKE");
      }
      if (!response.ok) {
        throw new AgentQError(response.error, response.code || "INTAKE_FAILED");
      }
      return response.task;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (Date.now() >= deadline) {
      throw new AgentQError(
        "Timed out waiting for the agentq supervisor to accept the delegated task",
        "INTAKE_TIMEOUT",
      );
    }
    await Bun.sleep(100);
  }
}

async function readBoundedRegularFile(path: string, maximum: number): Promise<string> {
  if (process.platform === "win32" || typeof constants.O_NOFOLLOW !== "number") {
    throw new AgentQError(
      "Delegated task intake cannot safely open staged files on this platform",
      "INTAKE_UNSUPPORTED_PLATFORM",
    );
  }
  const noFollow = constants.O_NOFOLLOW;
  const nonBlocking = typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;
  const handle = await open(path, constants.O_RDONLY | noFollow | nonBlocking);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maximum) {
      throw new AgentQError("Delegated task request is invalid or too large", "INVALID_INTAKE");
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maximum + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
      if (total > maximum) {
        throw new AgentQError("Delegated task request is invalid or too large", "INVALID_INTAKE");
      }
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await handle.close();
  }
}

function configuredLimit(
  explicit: number | undefined,
  environmentName: string,
  fallback: number,
): number {
  const raw = explicit ?? Number(process.env[environmentName] ?? fallback);
  if (!Number.isSafeInteger(raw) || raw < 1 || raw > MAX_CONFIGURED_LIMIT) {
    throw new AgentQError(
      `${environmentName} must be an integer between 1 and ${MAX_CONFIGURED_LIMIT}`,
      "INVALID_SUPERVISOR_OPTIONS",
      2,
    );
  }
  return raw;
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeSyncedExclusive(temporary, contents);
  try {
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function atomicCreate(path: string, contents: string): Promise<boolean> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeSyncedExclusive(temporary, contents);
  try {
    await link(temporary, path);
    await syncDirectory(dirname(path));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function writeSyncedExclusive(path: string, contents: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY).catch(() => undefined);
  if (!handle) return;
  try {
    await handle.sync().catch(() => undefined);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function pathExists(path: string): Promise<boolean> {
  return Boolean(await lstat(path).catch(() => undefined));
}

async function directoryHasMatchingEntry(path: string, pattern: RegExp): Promise<boolean> {
  const directory = await opendir(path).catch(() => undefined);
  if (!directory) return false;
  for await (const entry of directory) {
    if (pattern.test(entry.name)) return true;
  }
  return false;
}

async function removeOwnedEntries(path: string, includeResponses: boolean): Promise<void> {
  const directory = await opendir(path).catch(() => undefined);
  if (!directory) return;
  for await (const entry of directory) {
    if (
      !(
        OWN_TEMP_PATTERN.test(entry.name) ||
        (includeResponses && RESPONSE_PATTERN.test(entry.name))
      )
    ) {
      continue;
    }
    await unlink(join(path, entry.name)).catch(() => undefined);
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
