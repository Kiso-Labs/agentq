import { randomUUID } from "node:crypto";
import { appendFile, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { AgentQApp } from "../app.ts";
import { AgentQError, errorMessage } from "../core/errors.ts";
import { buildImplementationPrompt, buildPlanningPrompt } from "../core/prompt.ts";
import { evaluateScopePolicy, resolveEffectiveScopePolicy } from "../core/scope-policy.ts";
import type {
  ExecutionPhase,
  ExecutorEvent,
  ExecutorResult,
  Queue,
  Task,
  VerificationResult,
} from "../core/types.ts";
import { createExecutorMap } from "../executors/index.ts";
import { ensureImmutableResultRef, snapshotChangedFiles } from "../git/delivery.ts";
import type { PreparedWorktree } from "../git/worktrees.ts";
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

interface EventBudget {
  events: number;
  bytes: number;
  limitReported: boolean;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

function approvalBoundary(checkpoint: string): "implement" | "integrate" | "land" {
  const normalized = checkpoint.trim().toLowerCase().replaceAll("_", "-").replaceAll(" ", "-");
  if (normalized === "before-land" || normalized === "land" || normalized === "after-integrate") {
    return "land";
  }
  if (
    normalized === "before-integrate" ||
    normalized === "integrate" ||
    normalized === "after-verify"
  ) {
    return "integrate";
  }
  return "implement";
}

function uniqueCheckpoints(queue: Queue, task: Task): string[] {
  return [
    ...new Set(
      [...queue.approvalCheckpoints, ...task.approvalCheckpoints]
        .map((checkpoint) => checkpoint.trim())
        .filter(Boolean),
    ),
  ];
}

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
    let prepared: PreparedWorktree | undefined;
    let intakeRegistered = false;
    let activePhase: ExecutionPhase = run.phase;
    let phaseFinished = false;
    const eventBudget: EventBudget = {
      events: 0,
      bytes: 0,
      limitReported: false,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
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
      if (task.resumeRunId && !resume) {
        throw new AgentQError(
          "The retained stage can no longer be resumed safely",
          "RUN_NOT_RESUMABLE",
        );
      }
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
        let effectiveBaseSha = run.baseSha;
        if (!effectiveBaseSha) {
          const currentBaseSha = await this.app.worktrees.resolveBase(
            queue,
            queue.baseRef,
            controller.signal,
          );
          const createdBaseSha = run.taskSnapshot?.createdBaseSha ?? task.createdBaseSha;
          if (createdBaseSha && createdBaseSha !== currentBaseSha) {
            const driftPolicy = run.taskSnapshot?.baseDriftPolicy ?? task.baseDriftPolicy;
            const driftPayload = {
              createdBaseSha,
              currentBaseSha,
              policy: driftPolicy,
            };
            this.app.store.appendEvent({
              taskId: task.id,
              runId: run.id,
              kind: "base.drift_detected",
              payload: driftPayload,
            });
            await this.log(logPath, { type: "base.drift_detected", ...driftPayload });
            if (driftPolicy === "fail") {
              await this.completeClaim(
                claim,
                logPath,
                {
                  status: "failed",
                  error: `Task base ${createdBaseSha} is stale; ${queue.baseRef} is now ${currentBaseSha}`,
                  failureClass: "stale_base",
                  retryDisposition: "stop",
                },
                driftPayload,
              );
              return;
            }
          }
          effectiveBaseSha = currentBaseSha;
        }
        prepared = await this.app.worktrees.prepare(
          queue,
          task,
          run.attemptNo,
          controller.signal,
          effectiveBaseSha,
        );
      }
      // Persist the retained workspace before either provider starts. This
      // keeps a saved implementation handoff resumable even if intake or
      // process startup fails before a provider session is emitted.
      this.app.store.updateRun(
        run.id,
        {
          baseSha: prepared.baseSha,
          branchName: prepared.branchName,
          worktreePath: prepared.worktreePath,
          logPath,
        },
        claim.leaseToken,
      );
      const workflow = run.taskSnapshot?.workflow ?? {
        planModel: queue.planModel,
        planInstructions: queue.planInstructions,
        implementModel: queue.implementModel,
        implementInstructions: queue.implementInstructions,
      };
      const executionQueue: Queue = { ...queue, ...workflow };
      const executionTask: Task = run.taskSnapshot
        ? {
            ...task,
            title: run.taskSnapshot.title,
            instructions: run.taskSnapshot.instructions,
            acceptanceCriteria: [...run.taskSnapshot.acceptanceCriteria],
            objective: run.taskSnapshot.objective ?? task.objective,
            invariants: [...(run.taskSnapshot.invariants ?? task.invariants)],
            handoffRequirements: [
              ...(run.taskSnapshot.handoffRequirements ?? task.handoffRequirements),
            ],
            blockedBy: [...(run.taskSnapshot.blockedBy ?? task.blockedBy)],
            expectedPaths: [...(run.taskSnapshot.expectedPaths ?? task.expectedPaths)],
            allowedPaths: [...(run.taskSnapshot.allowedPaths ?? task.allowedPaths)],
            deniedPaths: [...(run.taskSnapshot.deniedPaths ?? task.deniedPaths)],
            ...(run.taskSnapshot.maxChangedFiles === undefined
              ? {}
              : { maxChangedFiles: run.taskSnapshot.maxChangedFiles }),
            verifyCommands: [...(run.taskSnapshot.verifyCommands ?? task.verifyCommands)],
            approvalCheckpoints: [
              ...(run.taskSnapshot.approvalCheckpoints ?? task.approvalCheckpoints),
            ],
            baseDriftPolicy: run.taskSnapshot.baseDriftPolicy ?? task.baseDriftPolicy,
            landStrategy: run.taskSnapshot.landStrategy ?? task.landStrategy,
            ...(run.taskSnapshot.createdBaseSha === undefined
              ? {}
              : { createdBaseSha: run.taskSnapshot.createdBaseSha }),
            provider: run.taskSnapshot.provider,
            priority: run.taskSnapshot.priority,
          }
        : task;
      let resumeConsumed = false;
      let runStarted = false;
      const consumeResume = async () => {
        if (!resume || resumeConsumed) return;
        this.app.store.consumeResumeIntent(task.id, run.id, resume.id, claim.leaseToken);
        resumeConsumed = true;
        try {
          this.app.store.appendEvent({
            taskId: task.id,
            runId: run.id,
            kind: "task.resume_consumed",
            payload: { previousRunId: resume.id, phase: activePhase },
          });
        } catch {
          // Resume intent is already consumed atomically; this event is observability only.
        }
      };

      let planOutput = run.planOutput;
      if (run.phase === "plan") {
        activePhase = "plan";
        phaseFinished = false;
        const planned = await this.executeProviderPhase({
          claim,
          prepared,
          task: executionTask,
          queue: executionQueue,
          phase: "plan",
          model: workflow.planModel,
          prompt: buildPlanningPrompt(executionTask, executionQueue),
          resumeSessionId: resume?.phase === "plan" ? resume.sessionId : undefined,
          logPath,
          signal: controller.signal,
          eventBudget,
          emitRunStarted: !runStarted,
          onReleased: consumeResume,
        });
        runStarted = true;
        if (planned.result.status !== "succeeded") {
          await this.workflowPhase(claim, logPath, "plan", "failed", {
            model: workflow.planModel,
            message: planned.result.error,
          });
          phaseFinished = true;
          const terminal = await this.finalizeSuccessfulOrFailed(
            claim,
            prepared,
            executionTask,
            executionQueue,
            planned.result,
            undefined,
            logPath,
            controller.signal,
            eventBudget,
          );
          await this.completeClaim(claim, logPath, terminal.input, terminal.payload);
          return;
        }
        planOutput = planned.result.summary?.trim();
        if (!planOutput) {
          throw new AgentQError(
            "Planning agent completed without a usable implementation handoff",
            "EMPTY_PLAN_OUTPUT",
          );
        }
        await this.app.worktrees.assertUnchanged(
          prepared.worktreePath,
          prepared.baseSha,
          controller.signal,
        );
        this.app.store.advanceRunToImplementation(
          run.id,
          { planOutput, ...(planned.sessionId ? { planSessionId: planned.sessionId } : {}) },
          claim.leaseToken,
        );
        await this.workflowPhase(claim, logPath, "plan", "completed", {
          model: workflow.planModel,
          summary: truncate(planOutput),
        });
        phaseFinished = true;

        const pendingApprovals = uniqueCheckpoints(executionQueue, executionTask).filter(
          (checkpoint) =>
            approvalBoundary(checkpoint) === "implement" &&
            this.app.store.getTaskApproval(task.id, checkpoint)?.status !== "approved",
        );
        if (pendingApprovals.length > 0) {
          controller.signal.throwIfAborted();
          const [firstCheckpoint, ...additionalCheckpoints] = pendingApprovals;
          if (!firstCheckpoint) {
            throw new AgentQError("Approval checkpoint resolution failed", "APPROVAL_INVALID");
          }
          this.app.store.pauseRunForApproval(
            run.id,
            {
              checkpoint: firstCheckpoint,
              planOutput,
              ...(planned.sessionId ? { planSessionId: planned.sessionId } : {}),
            },
            claim.leaseToken,
          );
          for (const checkpoint of additionalCheckpoints) {
            this.app.store.requestTaskApproval({
              taskId: task.id,
              runId: run.id,
              checkpoint,
            });
            this.app.store.appendEvent({
              taskId: task.id,
              runId: run.id,
              kind: "task.approval_requested",
              payload: { checkpoint },
            });
          }
          await this.log(logPath, {
            type: "task.approval_requested",
            checkpoints: pendingApprovals,
          });
          return;
        }
      }

      if (!planOutput?.trim()) {
        throw new AgentQError(
          "Implementation cannot start without a durable planner handoff",
          "EMPTY_PLAN_OUTPUT",
        );
      }
      planOutput = planOutput.trim();
      activePhase = "implement";
      phaseFinished = false;
      const intakeDirectory = await this.intake.register(run.id, queue.id, task.id);
      intakeRegistered = true;
      const implemented = await this.executeProviderPhase({
        claim,
        prepared,
        task: executionTask,
        queue: executionQueue,
        phase: "implement",
        model: workflow.implementModel,
        prompt: buildImplementationPrompt(executionTask, executionQueue, planOutput),
        resumeSessionId: resume?.phase === "implement" ? resume.sessionId : undefined,
        intakeDirectory,
        logPath,
        signal: controller.signal,
        eventBudget,
        emitRunStarted: !runStarted,
        onReleased: consumeResume,
      });
      if (implemented.result.status !== "succeeded") {
        await this.workflowPhase(claim, logPath, "implement", "failed", {
          model: workflow.implementModel,
          summary: implemented.result.summary,
          message: implemented.result.error,
        });
        phaseFinished = true;
        const terminal = await this.finalizeSuccessfulOrFailed(
          claim,
          prepared,
          executionTask,
          executionQueue,
          implemented.result,
          implemented.sessionId,
          logPath,
          controller.signal,
          eventBudget,
        );
        await this.completeClaim(claim, logPath, terminal.input, terminal.payload);
        return;
      }
      await this.workflowPhase(claim, logPath, "implement", "completed", {
        model: workflow.implementModel,
        summary: implemented.result.summary,
      });
      phaseFinished = true;
      const terminal = await this.finalizeSuccessfulOrFailed(
        claim,
        prepared,
        executionTask,
        executionQueue,
        implemented.result,
        implemented.sessionId,
        logPath,
        controller.signal,
        eventBudget,
      );
      await this.completeClaim(claim, logPath, terminal.input, terminal.payload);
    } catch (error) {
      const currentTask = this.app.store.getTask(task.id);
      const userCancelled = currentTask?.cancelRequestedAt !== undefined;
      const shuttingDown = this.shutdownRuns.has(run.id) && !userCancelled;
      const message = userCancelled
        ? "Cancellation requested"
        : shuttingDown
          ? String(controller.signal.reason ?? "Supervisor stopped")
          : errorMessage(error);
      if (!phaseFinished) {
        await this.workflowPhase(claim, logPath, activePhase, "failed", { message }).catch(
          () => undefined,
        );
      }
      const persistedRun = this.app.store.getRun(run.id);
      await this.completeClaim(
        claim,
        logPath,
        {
          status: userCancelled ? "cancelled" : shuttingDown ? "interrupted" : "failed",
          error: message,
          providerSessionId:
            activePhase === "implement" ? persistedRun?.providerSessionId : undefined,
          requeue: shuttingDown,
          inputTokens: eventBudget.inputTokens,
          outputTokens: eventBudget.outputTokens,
          costUsd: eventBudget.costUsd,
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

  private async executeProviderPhase(input: {
    claim: TaskClaim;
    prepared: PreparedWorktree;
    task: Task;
    queue: Queue;
    phase: ExecutionPhase;
    model: string;
    prompt: string;
    resumeSessionId?: string;
    intakeDirectory?: string;
    logPath: string;
    signal: AbortSignal;
    eventBudget: EventBudget;
    emitRunStarted: boolean;
    onReleased(): Promise<void>;
  }): Promise<{ result: ExecutorResult; sessionId?: string }> {
    const { claim, prepared, task, queue, phase, logPath } = input;
    const executor = this.executors.get(task.provider);
    if (!executor) throw new Error(`No executor registered for provider ${task.provider}`);
    let execution: Awaited<ReturnType<typeof executor.start>> | undefined;
    let sessionId = input.resumeSessionId;
    try {
      execution = await executor.start({
        runId: claim.run.id,
        task,
        queue,
        cwd: prepared.worktreePath,
        prompt: input.prompt,
        phase,
        model: input.model,
        ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
        deferStart: true,
        signal: input.signal,
        env: this.agentEnvironment(task, claim.run.id, queue.name, phase, input.intakeDirectory),
      });
      const markedRun = this.app.store.markRunRunning(
        claim.run.id,
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
      const currentTask = this.app.store.getTask(task.id);
      const currentRun = this.app.store.getRun(claim.run.id);
      if (
        markedRun.status === "cancelling" ||
        currentRun?.status === "cancelling" ||
        currentTask?.cancelRequestedAt ||
        input.signal.aborted
      ) {
        await execution.cancel("Cancellation requested before provider release");
        throw new AgentQError(
          "Run was cancelled before the provider process was released",
          "RUN_CANCELLING",
        );
      }
      await execution.release();
      await input.onReleased();
      await this.workflowPhase(claim, logPath, phase, "started", {
        provider: task.provider,
        model: input.model,
        pid: execution.pid,
      });
      if (input.emitRunStarted) {
        try {
          this.app.store.appendEvent({
            taskId: task.id,
            runId: claim.run.id,
            kind: "run.started",
            payload: {
              provider: task.provider,
              phase,
              model: input.model,
              pid: execution.pid,
              branchName: prepared.branchName,
              worktreePath: prepared.worktreePath,
            },
          });
        } catch {
          // The run row is authoritative if optional event persistence fails.
        }
      }
      this.app.notify();

      const activeExecution = execution;
      const consumeEvents = (async () => {
        for await (const event of activeExecution.events) {
          if (event.type === "session") {
            sessionId = event.sessionId;
            this.app.store.updateRun(
              claim.run.id,
              phase === "plan" ? { planSessionId: sessionId } : { providerSessionId: sessionId },
              claim.leaseToken,
            );
          }
          if (event.type === "usage") {
            if (Number.isSafeInteger(event.inputTokens) && (event.inputTokens ?? 0) >= 0) {
              input.eventBudget.inputTokens += event.inputTokens ?? 0;
            }
            if (Number.isSafeInteger(event.outputTokens) && (event.outputTokens ?? 0) >= 0) {
              input.eventBudget.outputTokens += event.outputTokens ?? 0;
            }
            if (
              event.costUsd !== undefined &&
              Number.isFinite(event.costUsd) &&
              event.costUsd >= 0
            ) {
              input.eventBudget.costUsd += event.costUsd;
            }
          }
          const storedEvent = boundedExecutorEvent(event);
          const eventBytes = Buffer.byteLength(JSON.stringify(storedEvent));
          if (
            input.eventBudget.events >= MAX_PERSISTED_EVENTS ||
            input.eventBudget.bytes + eventBytes > MAX_PERSISTED_EVENT_BYTES
          ) {
            if (!input.eventBudget.limitReported) {
              input.eventBudget.limitReported = true;
              await this.persistExecutorEvent(task, claim.run.id, logPath, phase, {
                type: "diagnostic",
                level: "warning",
                message: "Further provider events were omitted after the per-run output limit",
              });
            }
            continue;
          }
          input.eventBudget.events += 1;
          input.eventBudget.bytes += eventBytes;
          await this.persistExecutorEvent(task, claim.run.id, logPath, phase, storedEvent);
        }
      })();
      const guardedEvents = consumeEvents.catch(async (error) => {
        await activeExecution.cancel("Provider event persistence failed").catch(() => undefined);
        throw error;
      });
      const [result] = await Promise.all([activeExecution.completion, guardedEvents]);
      sessionId = result.sessionId ?? sessionId;
      if (sessionId) {
        this.app.store.updateRun(
          claim.run.id,
          phase === "plan" ? { planSessionId: sessionId } : { providerSessionId: sessionId },
          claim.leaseToken,
        );
      }
      return { result, ...(sessionId ? { sessionId } : {}) };
    } catch (error) {
      await execution?.cancel("Run setup or supervision failed").catch(() => undefined);
      throw error;
    }
  }

  private async finalizeSuccessfulOrFailed(
    claim: TaskClaim,
    prepared: NonNullable<Awaited<ReturnType<typeof this.app.worktrees.prepare>>>,
    task: Task,
    queue: Queue,
    result: ExecutorResult,
    sessionId: string | undefined,
    logPath: string,
    signal: AbortSignal,
    eventBudget: EventBudget,
  ): Promise<{ input: FinishRunInput; payload: Record<string, unknown> }> {
    const { run } = claim;
    const usage = {
      inputTokens: eventBudget.inputTokens,
      outputTokens: eventBudget.outputTokens,
      costUsd: eventBudget.costUsd,
    };
    if (result.status !== "succeeded") {
      const currentTask = this.app.store.getTask(task.id);
      const userCancelled = currentTask?.cancelRequestedAt !== undefined;
      const shuttingDown = this.shutdownRuns.has(run.id) && !userCancelled;
      const partialChanges = await snapshotChangedFiles(prepared.worktreePath, prepared.baseSha, {
        signal,
      }).catch(() => undefined);
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
          failureClass: userCancelled
            ? "cancelled"
            : shuttingDown || result.status === "cancelled"
              ? "transient_infrastructure"
              : "agent_failure",
          changedFiles: partialChanges?.files.map((file) => file.path) ?? [],
          ...usage,
        },
        payload: { summary: result.summary, message: result.error },
      };
    }

    this.app.store.updateTask(task.id, {
      currentPhase: "verify",
      deliveryStatus: "implemented",
    });
    const changed = await snapshotChangedFiles(prepared.worktreePath, prepared.baseSha, {
      signal,
    });
    const changedPaths = changed.files.map((file) => file.path);
    const policyPaths = changed.files.flatMap((file) =>
      file.previousPath ? [file.previousPath, file.path] : [file.path],
    );
    const effectivePolicy = resolveEffectiveScopePolicy(queue, task);
    const policy = evaluateScopePolicy(effectivePolicy, policyPaths);
    const verificationResults: VerificationResult[] = [];
    const policyFinishedAt = new Date().toISOString();
    const addPolicyResult = (
      kind: Extract<
        VerificationResult["kind"],
        "allowed_paths" | "denied_paths" | "max_changed_files"
      >,
      enabled: boolean,
      violationCodes: readonly string[],
    ) => {
      if (!enabled) return;
      const violations = policy.violations.filter((violation) =>
        violationCodes.includes(violation.code),
      );
      verificationResults.push({
        kind,
        status: violations.length > 0 ? "failed" : "passed",
        summary:
          violations.length > 0
            ? violations.map((violation) => violation.message).join("; ")
            : "Scope policy passed",
        finishedAt: policyFinishedAt,
      });
    };
    addPolicyResult("allowed_paths", effectivePolicy.allowPathGroups.length > 0, [
      "outside_allowed_paths",
      "invalid_changed_path",
    ]);
    addPolicyResult("denied_paths", effectivePolicy.deniedPaths.length > 0, [
      "denied_path",
      "invalid_changed_path",
    ]);
    addPolicyResult("max_changed_files", effectivePolicy.maxChangedFiles !== undefined, [
      "max_changed_files",
    ]);
    await this.log(logPath, {
      type: "policy.completed",
      passed: policy.passed,
      changedFiles: changed.files,
      violations: policy.violations,
    });
    this.app.store.appendEvent({
      taskId: task.id,
      runId: run.id,
      kind: "policy.completed",
      payload: {
        passed: policy.passed,
        changedFiles: changed.files,
        violations: policy.violations,
      },
    });
    if (!policy.passed) {
      const message = policy.violations.map((violation) => violation.message).join("; ");
      return {
        input: {
          status: "failed",
          summary: result.summary,
          error: `Scope policy failed: ${message}`,
          providerSessionId: sessionId,
          failureClass: "policy_violation",
          retryDisposition: "stop",
          changedFiles: changedPaths,
          verificationResults,
          ...usage,
        },
        payload: { message: `Scope policy failed: ${message}`, violations: policy.violations },
      };
    }

    const commands = [...queue.verifyCommands, ...task.verifyCommands];
    const verification = await this.app.worktrees.verify(prepared.worktreePath, commands, signal);
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
      verificationResults.push({
        kind: "command",
        status: check.exitCode === 0 ? "passed" : "failed",
        command: check.command,
        exitCode: check.exitCode,
        summary: truncate(check.stderr || check.stdout),
        finishedAt: new Date().toISOString(),
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
          failureClass: "test_regression",
          retryDisposition: "return_to_implementation",
          changedFiles: changedPaths,
          verificationResults,
          ...usage,
        },
        payload: { message: `Verification failed: ${failedCheck.command}` },
      };
    }

    this.app.store.updateTask(task.id, { deliveryStatus: "verified" });
    // A dependency edge is an executable Git relationship, not just metadata.
    // Even when queue auto-commit is disabled, blockers must publish an
    // immutable commit that their dependents can use as an exact base.
    const requiresResult =
      queue.autoCommit ||
      task.landStrategy !== "none" ||
      this.app.store.listTaskDependents(task.id).length > 0;
    const commitSha = requiresResult
      ? await this.app.worktrees.canonicalizeResult(
          prepared.worktreePath,
          prepared.baseSha,
          task,
          signal,
        )
      : undefined;
    if (!commitSha && requiresResult) {
      const message =
        task.landStrategy !== "none"
          ? "A stack or merge-train task must produce a repository change"
          : "A task with dependents must produce a repository change";
      return {
        input: {
          status: "failed",
          summary: result.summary,
          error: message,
          providerSessionId: sessionId,
          failureClass: "policy_violation",
          retryDisposition: "stop",
          changedFiles: changedPaths,
          verificationResults,
          ...usage,
        },
        payload: { message },
      };
    }
    const resultRef = commitSha
      ? (
          await ensureImmutableResultRef(
            prepared.repoRoot,
            `refs/agentq/results/${task.id}/${run.id}`,
            commitSha,
            { signal },
          )
        ).refName
      : undefined;
    if (commitSha) {
      verificationResults.push({
        kind: "clean_worktree",
        status: "passed",
        summary: "Canonical result commit created with a clean worktree",
        finishedAt: new Date().toISOString(),
      });
    }
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
        resultCommitSha: commitSha,
        changedFiles: changedPaths,
        verificationResults,
        ...usage,
      },
      payload: {
        branchName: prepared.branchName,
        worktreePath: prepared.worktreePath,
        commitSha,
        resultRef,
        changedFiles: changed.files,
      },
    };
  }

  private async persistExecutorEvent(
    task: Task,
    runId: string,
    logPath: string,
    phase: ExecutionPhase,
    event: ExecutorEvent,
  ): Promise<void> {
    await this.log(logPath, { ...event, phase });
    this.app.store.appendEvent({
      taskId: task.id,
      runId,
      kind: `executor.${event.type}`,
      payload: { ...event, phase },
    });
    this.app.notify();
  }

  private async workflowPhase(
    claim: TaskClaim,
    logPath: string,
    phase: ExecutionPhase,
    state: "started" | "completed" | "failed",
    payload: Record<string, unknown>,
  ): Promise<void> {
    const eventPayload = { phase, state, ...payload };
    this.app.store.appendEvent({
      taskId: claim.task.id,
      runId: claim.run.id,
      kind: "workflow.phase",
      payload: eventPayload,
    });
    await this.log(logPath, { type: "workflow.phase", ...eventPayload });
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
    phase: ExecutionPhase,
    intakeDirectory?: string,
  ): Record<string, string> {
    return {
      AGENTQ_STATE_DIR: this.app.paths.stateDir,
      AGENTQ_QUEUE: queueName,
      AGENTQ_TASK_ID: task.id,
      AGENTQ_RUN_ID: runId,
      AGENTQ_PROVIDER: task.provider,
      AGENTQ_STAGE: phase,
      AGENTQ_AGENT_CONTEXT: "1",
      ...(intakeDirectory ? { AGENTQ_INTAKE_DIR: intakeDirectory } : {}),
    };
  }

  private resumeContext(claim: TaskClaim) {
    if (!claim.task.resumeRunId) return undefined;
    const previous = this.app.store.getRun(claim.task.resumeRunId);
    const sessionId =
      previous?.phase === "plan" ? previous.planSessionId : previous?.providerSessionId;
    const resumableStage =
      previous?.phase === "plan" ? previous.planSessionId : previous?.planOutput;
    if (
      !previous ||
      !resumableStage ||
      !previous.worktreePath ||
      !previous.branchName ||
      !previous.baseSha ||
      previous.provider !== claim.task.provider
    ) {
      return undefined;
    }
    return {
      id: previous.id,
      phase: previous.phase,
      sessionId,
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
      return {
        ...event,
        ...(event.detail === undefined ? {} : { detail: truncate(event.detail, 64 * 1024) }),
        ...(event.output === undefined ? {} : { output: truncate(event.output, 64 * 1024) }),
      };
    case "diagnostic":
      return { ...event, message: truncate(event.message, 64 * 1024) };
    default:
      return event;
  }
}
