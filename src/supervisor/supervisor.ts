import { randomUUID } from "node:crypto";
import { appendFile, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { AgentQApp } from "../app.ts";
import { AgentQError, errorMessage } from "../core/errors.ts";
import { buildTaskPrompt } from "../core/prompt.ts";
import type { Execution, ExecutorEvent, ExecutorResult, Task } from "../core/types.ts";
import { createExecutorMap } from "../executors/index.ts";
import { DelegatedTaskIntake } from "../intake/delegated-tasks.ts";
import {
  inspectProcessIdentity,
  isProcessAlive,
  isProcessGroupAlive,
  type ProcessIdentity,
  terminateProcessTree,
} from "../process/index.ts";
import type { FinishRunInput, TaskClaim } from "../store/index.ts";

const ACTIVE_RUN_STATUSES = ["starting", "running", "cancelling"] as const;
const MAX_PERSISTED_EVENTS = 10_000;
const MAX_PERSISTED_EVENT_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENCY = 4;
const MAX_GLOBAL_CONCURRENCY = 128;
const DEFAULT_STALE_AFTER_MS = 30_000;
const MIN_HARD_STALE_AFTER_MS = 15 * 60_000;
const HARD_STALE_MULTIPLIER = 20;

export interface SupervisorOptions {
  queue?: string;
  /** Restrict claims to queues owned by one canonical Git repository. */
  repoKey?: string | (() => string | undefined);
  maxConcurrency?: number;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  staleAfterMs?: number;
  hardStaleAfterMs?: number;
}

export interface RunSupervisorOptions {
  once?: boolean;
  signal?: AbortSignal;
}

export class Supervisor {
  private readonly executors = createExecutorMap();
  private readonly intake: DelegatedTaskIntake;
  private readonly active = new Map<
    string,
    { promise: Promise<void>; controller: AbortController; claim: TaskClaim }
  >();
  private readonly ownerPrefix = `${process.pid}-${randomUUID()}`;
  private readonly shutdownRuns = new Set<string>();
  private stopping = false;

  constructor(
    private readonly app: AgentQApp,
    private readonly options: SupervisorOptions = {},
  ) {
    this.intake = new DelegatedTaskIntake(app);
  }

  get activeCount(): number {
    return this.active.size;
  }

  async run(options: RunSupervisorOptions = {}): Promise<void> {
    this.stopping = false;
    const signal = options.signal;
    const maxConcurrency = boundedPositiveInteger(
      this.options.maxConcurrency ??
        Number(process.env.AGENTQ_MAX_CONCURRENCY ?? DEFAULT_MAX_CONCURRENCY),
      "global concurrency",
      MAX_GLOBAL_CONCURRENCY,
    );
    const pollIntervalMs = this.options.pollIntervalMs ?? 400;
    const staleAfterMs = boundedPositiveInteger(
      this.options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS,
      "staleAfterMs",
      Number.MAX_SAFE_INTEGER,
    );
    const defaultHardStaleAfterMs = Math.max(
      MIN_HARD_STALE_AFTER_MS,
      Math.min(Number.MAX_SAFE_INTEGER, staleAfterMs * HARD_STALE_MULTIPLIER),
    );
    const hardStaleAfterMs = boundedPositiveInteger(
      this.options.hardStaleAfterMs ?? defaultHardStaleAfterMs,
      "hardStaleAfterMs",
      Number.MAX_SAFE_INTEGER,
    );
    if (hardStaleAfterMs < staleAfterMs) {
      throw new AgentQError(
        "hardStaleAfterMs must be greater than or equal to staleAfterMs",
        "INVALID_SUPERVISOR_OPTIONS",
        2,
      );
    }
    const recoveryIntervalMs = Math.max(250, Math.min(10_000, Math.floor(staleAfterMs / 3)));
    let nextRecoveryAt = 0;

    const onAbort = () => this.stop("Supervisor stopped");
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      while (!this.stopping && !signal?.aborted) {
        if (Date.now() >= nextRecoveryAt) {
          await this.recoverStaleRuns(staleAfterMs, hardStaleAfterMs);
          nextRecoveryAt = Date.now() + recoveryIntervalMs;
        }
        await this.intake.drain();
        await this.cancelRequestedRuns();
        let claimed = false;

        while (!this.stopping && this.active.size < maxConcurrency) {
          const claim = this.app.store.claimNextTask({
            queue: this.options.queue,
            repoKey:
              typeof this.options.repoKey === "function"
                ? this.options.repoKey()
                : this.options.repoKey,
            ownerToken: `${this.ownerPrefix}-${randomUUID()}`,
            ownerPid: process.pid,
            maxConcurrency,
          });
          if (!claim) break;
          claimed = true;
          const controller = new AbortController();
          const promise = this.executeClaim(claim, controller)
            .catch((error) => {
              try {
                this.app.store.appendEvent({
                  taskId: claim.task.id,
                  runId: claim.run.id,
                  kind: "supervisor.error",
                  payload: { message: errorMessage(error) },
                });
              } catch {
                // The primary lifecycle finalizer already ran; diagnostics are best-effort.
              }
            })
            .finally(() => {
              this.active.delete(claim.run.id);
              this.shutdownRuns.delete(claim.run.id);
              this.app.notify();
            });
          this.active.set(claim.run.id, { promise, controller, claim });
          this.app.notify();
        }

        if (options.once && !claimed && this.active.size === 0) break;
        await Promise.race([
          Bun.sleep(pollIntervalMs),
          ...[...this.active.values()].map(({ promise }) => promise),
        ]);
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (this.active.size > 0 && !this.stopping) {
        this.stop(
          signal?.aborted
            ? String(signal.reason ?? "Supervisor stopped")
            : "Supervisor loop stopped unexpectedly",
        );
      }
      if (this.active.size > 0) {
        await Promise.allSettled([...this.active.values()].map(({ promise }) => promise));
      }
    }
  }

  stop(reason = "Supervisor stopped"): void {
    this.stopping = true;
    for (const [runId, { controller }] of this.active) {
      this.shutdownRuns.add(runId);
      controller.abort(reason);
    }
  }

  private async cancelRequestedRuns(): Promise<void> {
    for (const [runId, active] of this.active) {
      const run = this.app.store.getRun(runId);
      if (!run) continue;
      const task = this.app.store.getTask(run.taskId);
      if (task?.cancelRequestedAt && !active.controller.signal.aborted) {
        this.app.store.updateRun(runId, { status: "cancelling" }, active.claim.leaseToken);
        active.controller.abort("Cancellation requested");
      }
    }
  }

  private async executeClaim(claim: TaskClaim, controller: AbortController): Promise<void> {
    const { queue, task, run } = claim;
    const logPath = join(this.app.paths.logsDir, task.id, `${run.id}.jsonl`);
    let prepared: Awaited<ReturnType<typeof this.app.worktrees.prepare>> | undefined;
    let sessionId: string | undefined;
    let execution: Execution | undefined;
    let intakeRegistered = false;
    let persistedEvents = 0;
    let persistedEventBytes = 0;
    let outputLimitReported = false;
    const heartbeat = setInterval(() => {
      try {
        this.app.store.heartbeatRun(run.id, undefined, claim.leaseToken);
      } catch (error) {
        if (!controller.signal.aborted) controller.abort(error);
      }
    }, this.options.heartbeatIntervalMs ?? 5_000);

    try {
      await mkdir(join(logPath, ".."), { recursive: true, mode: 0o700 });
      await this.log(logPath, { type: "run.claimed", taskId: task.id, runId: run.id });

      const resume = this.resumeContext(claim);
      if (resume) {
        await this.app.worktrees.validateExisting(
          queue.repoPath,
          resume.worktreePath,
          resume.branchName,
          controller.signal,
        );
        prepared = {
          repoRoot: queue.repoPath,
          baseSha: resume.baseSha,
          branchName: resume.branchName,
          worktreePath: resume.worktreePath,
        };
      } else {
        prepared = await this.app.worktrees.prepare(queue, task, run.attemptNo, controller.signal);
      }
      const executor = this.executors.get(task.provider);
      if (!executor) throw new Error(`No executor registered for provider ${task.provider}`);

      const intakeDirectory = await this.intake.register(run.id, queue.id, task.id);
      intakeRegistered = true;
      execution = await executor.start({
        runId: run.id,
        task,
        queue,
        cwd: prepared.worktreePath,
        prompt: buildTaskPrompt(task, queue),
        resumeSessionId: resume?.providerSessionId,
        deferStart: true,
        signal: controller.signal,
        env: this.agentEnvironment(task, run.id, queue.name, intakeDirectory),
      });

      this.app.store.markRunRunning(
        run.id,
        {
          pid: execution.pid,
          processToken: execution.processIdentity.token,
          processStartMarker: execution.processIdentity.startMarker,
          processIdentityPath: execution.processIdentity.path,
          baseSha: prepared.baseSha,
          branchName: prepared.branchName,
          worktreePath: prepared.worktreePath,
          logPath,
        },
        claim.leaseToken,
      );
      await execution.release();
      if (resume) {
        this.app.store.consumeResumeIntent(task.id, run.id, resume.id, claim.leaseToken);
        try {
          this.app.store.appendEvent({
            taskId: task.id,
            runId: run.id,
            kind: "task.resume_consumed",
            payload: { previousRunId: resume.id },
          });
        } catch {
          // Resume intent is already consumed atomically; this event is observability only.
        }
      }
      try {
        this.app.store.appendEvent({
          taskId: task.id,
          runId: run.id,
          kind: "run.started",
          payload: {
            provider: task.provider,
            pid: execution.pid,
            branchName: prepared.branchName,
            worktreePath: prepared.worktreePath,
          },
        });
      } catch {
        // The run row is authoritative if optional event persistence fails.
      }
      this.app.notify();

      const consumeEvents = (async () => {
        for await (const event of execution?.events ?? []) {
          if (event.type === "session") {
            sessionId = event.sessionId;
            this.app.store.updateRun(run.id, { providerSessionId: sessionId }, claim.leaseToken);
          }
          const storedEvent = boundedExecutorEvent(event);
          const eventBytes = Buffer.byteLength(JSON.stringify(storedEvent));
          if (
            persistedEvents >= MAX_PERSISTED_EVENTS ||
            persistedEventBytes + eventBytes > MAX_PERSISTED_EVENT_BYTES
          ) {
            if (!outputLimitReported) {
              outputLimitReported = true;
              await this.persistExecutorEvent(task, run.id, logPath, {
                type: "diagnostic",
                level: "warning",
                message: "Further provider events were omitted after the per-run output limit",
              });
            }
            continue;
          }
          persistedEvents += 1;
          persistedEventBytes += eventBytes;
          await this.persistExecutorEvent(task, run.id, logPath, storedEvent);
        }
      })();

      const guardedEvents = consumeEvents.catch(async (error) => {
        await execution?.cancel("Provider event persistence failed").catch(() => undefined);
        throw error;
      });
      const [result] = await Promise.all([execution.completion, guardedEvents]);
      sessionId = result.sessionId ?? sessionId;
      const terminal = await this.finalizeSuccessfulOrFailed(
        claim,
        prepared,
        result,
        sessionId,
        logPath,
        controller.signal,
      );
      await this.completeClaim(claim, logPath, terminal.input, terminal.payload);
    } catch (error) {
      if (execution)
        await execution.cancel("Run setup or supervision failed").catch(() => undefined);
      const currentTask = this.app.store.getTask(task.id);
      const userCancelled = currentTask?.cancelRequestedAt !== undefined;
      const shuttingDown = this.shutdownRuns.has(run.id) && !userCancelled;
      const message = userCancelled
        ? "Cancellation requested"
        : shuttingDown
          ? String(controller.signal.reason ?? "Supervisor stopped")
          : errorMessage(error);
      await this.completeClaim(
        claim,
        logPath,
        {
          status: userCancelled ? "cancelled" : shuttingDown ? "interrupted" : "failed",
          error: message,
          providerSessionId: sessionId,
          requeue: shuttingDown,
        },
        {
          message,
          worktreePath: prepared?.worktreePath,
          branchName: prepared?.branchName,
        },
      );
    } finally {
      clearInterval(heartbeat);
      if (intakeRegistered) {
        await this.intake.drain().catch(() => undefined);
        await this.intake.cleanup(run.id);
      }
      this.app.notify();
    }
  }

  private async finalizeSuccessfulOrFailed(
    claim: TaskClaim,
    prepared: NonNullable<Awaited<ReturnType<typeof this.app.worktrees.prepare>>>,
    result: ExecutorResult,
    sessionId: string | undefined,
    logPath: string,
    signal: AbortSignal,
  ): Promise<{ input: FinishRunInput; payload: Record<string, unknown> }> {
    const { task, queue, run } = claim;
    if (result.status !== "succeeded") {
      const currentTask = this.app.store.getTask(task.id);
      const userCancelled = currentTask?.cancelRequestedAt !== undefined;
      const shuttingDown = this.shutdownRuns.has(run.id) && !userCancelled;
      return {
        input: {
          status: userCancelled
            ? "cancelled"
            : result.status === "cancelled"
              ? "interrupted"
              : "failed",
          exitCode: result.exitCode,
          summary: result.summary,
          error: result.error,
          providerSessionId: sessionId,
          requeue: shuttingDown,
        },
        payload: { summary: result.summary, message: result.error },
      };
    }

    const verification = await this.app.worktrees.verify(
      prepared.worktreePath,
      queue.verifyCommands,
      signal,
    );
    for (const check of verification) {
      await this.log(logPath, { type: "verification", ...check });
      this.app.store.appendEvent({
        taskId: task.id,
        runId: run.id,
        kind: "verification.completed",
        payload: {
          command: check.command,
          exitCode: check.exitCode,
          stdout: truncate(check.stdout),
          stderr: truncate(check.stderr),
        },
      });
    }
    const failedCheck = verification.find((check) => check.exitCode !== 0);
    if (failedCheck) {
      return {
        input: {
          status: "failed",
          exitCode: failedCheck.exitCode,
          summary: result.summary,
          error: `Verification failed: ${failedCheck.command}`,
          providerSessionId: sessionId,
        },
        payload: { message: `Verification failed: ${failedCheck.command}` },
      };
    }

    const commitSha = queue.autoCommit
      ? await this.app.worktrees.commitChanges(prepared.worktreePath, task)
      : undefined;
    const summary = [
      result.summary,
      `Branch: ${prepared.branchName}`,
      commitSha ? `Commit: ${commitSha}` : undefined,
      `Worktree: ${prepared.worktreePath}`,
    ]
      .filter(Boolean)
      .join("\n");

    return {
      input: {
        status: "succeeded",
        exitCode: result.exitCode,
        summary,
        providerSessionId: sessionId,
      },
      payload: {
        branchName: prepared.branchName,
        worktreePath: prepared.worktreePath,
        commitSha,
      },
    };
  }

  private async persistExecutorEvent(
    task: Task,
    runId: string,
    logPath: string,
    event: ExecutorEvent,
  ): Promise<void> {
    await this.log(logPath, event);
    this.app.store.appendEvent({
      taskId: task.id,
      runId,
      kind: `executor.${event.type}`,
      payload: { ...event },
    });
    this.app.notify();
  }

  private async completeClaim(
    claim: TaskClaim,
    logPath: string,
    input: FinishRunInput,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const finished = this.app.store.finishRun(claim.run.id, input, claim.leaseToken);
    const kind = `run.${finished.run.status}`;
    const terminalPayload = {
      ...payload,
      summary: finished.run.summary,
      message: finished.run.error ?? payload.message,
      taskStatus: finished.task.status,
    };
    await Promise.allSettled([
      Promise.resolve().then(() =>
        this.app.store.appendEvent({
          taskId: claim.task.id,
          runId: claim.run.id,
          kind,
          payload: terminalPayload,
        }),
      ),
      this.log(logPath, { type: kind, ...terminalPayload }),
    ]);
  }

  private async recoverStaleRuns(staleAfterMs: number, hardStaleAfterMs: number): Promise<void> {
    const now = Date.now();
    const cutoff = new Date(now - staleAfterMs).toISOString();
    const hardCutoff = new Date(now - hardStaleAfterMs).toISOString();
    const candidates = this.app.store
      .listRuns({ statuses: ACTIVE_RUN_STATUSES, limit: 10_000 })
      .filter(
        (run) =>
          run.heartbeatAt < cutoff &&
          !this.active.has(run.id) &&
          (run.heartbeatAt < hardCutoff ||
            run.ownerPid === undefined ||
            !isProcessAlive(run.ownerPid)),
      );
    if (candidates.length === 0) return;

    const recoveryToken = `${this.ownerPrefix}-recovery-${randomUUID()}`;
    const fenced = this.app.store.fenceStaleRuns({
      staleBefore: cutoff,
      ownerToken: recoveryToken,
      eligibleRunIds: candidates.map((run) => run.id),
    });
    let finalized = 0;
    await Promise.all(
      fenced.runs.map(async (run) => {
        let cleaned = run.pid === undefined;
        const expectedIdentityPath =
          run.processToken && /^[a-f0-9-]{36}$/.test(run.processToken)
            ? join(this.app.paths.stateDir, "process-identities", `${run.processToken}.json`)
            : undefined;
        const hasTrustedIdentity = Boolean(
          run.processToken &&
            run.processStartMarker &&
            run.processIdentityPath &&
            run.processIdentityPath === expectedIdentityPath,
        );
        const pidAlive = run.pid !== undefined && isProcessAlive(run.pid);
        const groupAlive = run.pid !== undefined && isProcessGroupAlive(run.pid);
        if (!cleaned && !pidAlive && !groupAlive) cleaned = true;
        if (!cleaned && !pidAlive && groupAlive && run.pid) {
          try {
            await terminateProcessTree(run.pid, 5_000);
            cleaned = true;
          } catch (error) {
            await this.recoveryDiagnostic(
              run.taskId,
              run.id,
              `Orphan process-group cleanup failed safely and the task remains fenced: ${errorMessage(error)}`,
            );
          }
        }
        if (!cleaned && pidAlive && !hasTrustedIdentity) {
          await this.recoveryDiagnostic(
            run.taskId,
            run.id,
            "Recovery fenced the run, but cleanup is waiting because it has no process identity",
          );
          return;
        }
        if (!cleaned && pidAlive && run.pid && hasTrustedIdentity) {
          const identity: ProcessIdentity = {
            pid: run.pid,
            token: run.processToken as string,
            startMarker: run.processStartMarker as string,
            path: run.processIdentityPath as string,
          };
          const identityState = await inspectProcessIdentity(identity);
          if (identityState === "mismatch") {
            cleaned = true;
            await this.recoveryDiagnostic(
              run.taskId,
              run.id,
              "The recorded PID belongs to a newer process; it was not signalled",
            );
          } else if (identityState === "matches") {
            try {
              await terminateProcessTree(run.pid, 5_000, identity);
              cleaned = true;
            } catch (error) {
              await this.recoveryDiagnostic(
                run.taskId,
                run.id,
                `Orphan cleanup failed safely and the task remains fenced: ${errorMessage(error)}`,
              );
            }
          } else if (identityState === "dead" && !isProcessGroupAlive(run.pid)) {
            cleaned = true;
          } else {
            await this.recoveryDiagnostic(
              run.taskId,
              run.id,
              "Process identity could not be verified; cleanup remains safely fenced",
            );
          }
        }
        if (!cleaned) return;
        if (run.processIdentityPath === expectedIdentityPath && expectedIdentityPath) {
          await unlink(expectedIdentityPath).catch(() => undefined);
        }

        const finished = this.app.store.finishRun(
          run.id,
          { status: "interrupted", error: "Supervisor heartbeat expired" },
          recoveryToken,
        );
        finalized += 1;
        await Promise.resolve()
          .then(() =>
            this.app.store.appendEvent({
              taskId: run.taskId,
              runId: run.id,
              kind: "run.recovered",
              payload: {
                message: "Previous supervisor lease expired",
                taskStatus: finished.task.status,
              },
            }),
          )
          .catch(() => undefined);
      }),
    );
    if (fenced.recoveredRuns > 0 || finalized > 0) this.app.notify();
  }

  private async recoveryDiagnostic(taskId: string, runId: string, message: string): Promise<void> {
    await Promise.resolve()
      .then(() =>
        this.app.store.appendEvent({
          taskId,
          runId,
          kind: "run.recovery_diagnostic",
          payload: { message: truncate(message) },
        }),
      )
      .catch(() => undefined);
  }

  private agentEnvironment(
    task: Task,
    runId: string,
    queueName: string,
    intakeDirectory: string,
  ): Record<string, string> {
    return {
      AGENTQ_STATE_DIR: this.app.paths.stateDir,
      AGENTQ_QUEUE: queueName,
      AGENTQ_TASK_ID: task.id,
      AGENTQ_RUN_ID: runId,
      AGENTQ_PROVIDER: task.provider,
      AGENTQ_AGENT_CONTEXT: "1",
      AGENTQ_INTAKE_DIR: intakeDirectory,
    };
  }

  private resumeContext(claim: TaskClaim) {
    if (!claim.task.resumeRunId) return undefined;
    const previous = this.app.store.getRun(claim.task.resumeRunId);
    if (
      !previous?.providerSessionId ||
      !previous.worktreePath ||
      !previous.branchName ||
      !previous.baseSha ||
      previous.provider !== claim.task.provider
    ) {
      return undefined;
    }
    return {
      id: previous.id,
      providerSessionId: previous.providerSessionId,
      worktreePath: previous.worktreePath,
      branchName: previous.branchName,
      baseSha: previous.baseSha,
    };
  }

  private async log(path: string, value: Record<string, unknown> | ExecutorEvent): Promise<void> {
    await appendFile(path, `${JSON.stringify({ at: new Date().toISOString(), ...value })}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "a",
    });
  }
}

function truncate(value: string, max = 16_000): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n… output truncated …`;
}

function boundedPositiveInteger(value: number, field: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new AgentQError(
      `${field} must be a positive integer no greater than ${maximum}`,
      "INVALID_SUPERVISOR_OPTIONS",
      2,
    );
  }
  return value;
}

function boundedExecutorEvent(event: ExecutorEvent): ExecutorEvent {
  switch (event.type) {
    case "assistant":
      return { ...event, text: truncate(event.text, 256 * 1024) };
    case "tool":
      return event.detail === undefined
        ? event
        : { ...event, detail: truncate(event.detail, 64 * 1024) };
    case "diagnostic":
      return { ...event, message: truncate(event.message, 64 * 1024) };
    default:
      return event;
  }
}
