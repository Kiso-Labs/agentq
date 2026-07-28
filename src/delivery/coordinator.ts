import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentQError } from "../core/errors.ts";
import {
  type EffectiveScopePolicy,
  evaluateScopePolicy,
  type ScopePolicyEvaluation,
} from "../core/scope-policy.ts";
import type { VerificationGateKind, VerificationStatus } from "../core/types.ts";
import { runCommand, runGit } from "../git/command.ts";
import {
  advanceTrainRef,
  type ChangedFile,
  fastForwardLand,
  isAncestor,
  releaseReplayCandidate,
  replayResultCommit,
  resolveCommit,
  snapshotChangedFiles,
} from "../git/delivery.ts";

export interface DeliveryLaneKey {
  readonly repoKey: string;
  readonly repoPath: string;
  readonly targetRef: string;
  readonly trainRef: string;
}

/**
 * The durable lane record. `headSha` is the verified train head while
 * `landedSha` is the last target commit acknowledged by persistence.
 */
export interface DeliveryLane extends DeliveryLaneKey {
  readonly id: string;
  readonly headSha: string;
  readonly landedSha: string;
  readonly revision: number;
}

export interface DeliveryArtifact {
  readonly id: string;
  readonly taskId: string;
  readonly runId: string;
  readonly resultRef: string;
  readonly resultSha: string;
}

export interface IntegratedArtifact {
  readonly id: string;
  readonly integratedSha: string;
}

export type DeliveryFailureClass =
  | "integration_conflict"
  | "integration_contention"
  | "policy_violation"
  | "test_regression";

export interface DeliveryVerificationResult {
  readonly kind: VerificationGateKind;
  readonly status: VerificationStatus;
  readonly name?: string;
  readonly command?: string;
  readonly exitCode?: number;
  readonly summary?: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
}

export interface LaneClaimInput {
  readonly laneId: string;
  readonly operationId: string;
  readonly kind: "integrate" | "land";
  readonly taskId?: string;
  readonly artifactId?: string;
  readonly expectedRevision: number;
  readonly expectedHeadSha: string;
}

export interface IntegrationFailureRecord {
  readonly artifactId: string;
  readonly laneId: string;
  readonly operationId: string;
  readonly failureClass: DeliveryFailureClass;
  readonly message: string;
  readonly conflictPaths: readonly string[];
  readonly changedFiles: readonly ChangedFile[];
  readonly scopeEvaluation?: ScopePolicyEvaluation;
  readonly verificationResults: readonly DeliveryVerificationResult[];
}

export interface CompleteIntegrationInput {
  readonly artifactId: string;
  readonly laneId: string;
  readonly operationId: string;
  readonly expectedRevision: number;
  readonly expectedHeadSha: string;
  readonly integratedSha: string;
  readonly changedFiles: readonly ChangedFile[];
  readonly scopeEvaluation: ScopePolicyEvaluation;
  readonly verificationResults: readonly DeliveryVerificationResult[];
}

export interface CompleteLandingInput {
  readonly laneId: string;
  readonly operationId: string;
  readonly expectedRevision: number;
  readonly expectedHeadSha: string;
  readonly expectedLandedSha: string;
  readonly landedSha: string;
  readonly artifactIds: readonly string[];
}

export interface ReconcileLaneHeadInput {
  readonly laneId: string;
  readonly expectedRevision: number;
  readonly expectedHeadSha: string;
  readonly actualHeadSha: string;
}

export interface ReconcileLandingInput {
  readonly laneId: string;
  readonly expectedRevision: number;
  readonly expectedHeadSha: string;
  readonly expectedLandedSha: string;
  readonly actualLandedSha: string;
  readonly artifactIds: readonly string[];
}

/**
 * Persistence is deliberately storage-agnostic. Implementations must make
 * `tryClaimLane`, both reconciliation methods, `completeIntegration`, and
 * `completeLanding` atomic CAS operations. Git refs are the crash-recovery
 * source of truth: reconciliation may only move persistence forward to commits
 * whose ancestry the coordinator already validated. Landing reconciliation
 * must update the lane and every listed artifact in one transaction. A valid
 * claim serializes writers for one lane. Completion must clear that claim in
 * the same transaction as the lane/artifact update.
 */
export interface DeliveryPersistence {
  getOrCreateLane(input: DeliveryLaneKey & { initialSha: string }): Promise<DeliveryLane>;
  reconcileLaneHead(input: ReconcileLaneHeadInput): Promise<DeliveryLane | undefined>;
  reconcileLanding(input: ReconcileLandingInput): Promise<DeliveryLane | undefined>;
  tryClaimLane(input: LaneClaimInput): Promise<boolean>;
  completeIntegration(input: CompleteIntegrationInput): Promise<boolean>;
  completeLanding(input: CompleteLandingInput): Promise<boolean>;
  releaseLaneClaim(laneId: string, operationId: string): Promise<void>;
  recordIntegrationFailure(input: IntegrationFailureRecord): Promise<void>;
  listIntegratedArtifacts(laneId: string): Promise<readonly IntegratedArtifact[]>;
}

export interface IntegrateArtifactInput {
  readonly lane: DeliveryLaneKey;
  readonly artifact: DeliveryArtifact;
  readonly scopePolicy?: EffectiveScopePolicy;
  readonly verificationCommands?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface LandLaneInput {
  readonly lane: DeliveryLaneKey;
  readonly signal?: AbortSignal;
}

export type IntegrationOutcome =
  | {
      readonly status: "integrated";
      readonly laneId: string;
      readonly artifactId: string;
      readonly previousTrainSha: string;
      readonly integratedSha: string;
      readonly changedFiles: readonly ChangedFile[];
      readonly scopeEvaluation: ScopePolicyEvaluation;
      readonly verificationResults: readonly DeliveryVerificationResult[];
    }
  | {
      readonly status: "conflict";
      readonly laneId: string;
      readonly artifactId: string;
      readonly conflictPaths: readonly string[];
    }
  | {
      readonly status: "verification-failed";
      readonly laneId: string;
      readonly artifactId: string;
      readonly failureClass: "policy_violation" | "test_regression";
      readonly changedFiles: readonly ChangedFile[];
      readonly scopeEvaluation: ScopePolicyEvaluation;
      readonly verificationResults: readonly DeliveryVerificationResult[];
    }
  | {
      readonly status: "contended";
      readonly laneId: string;
      readonly artifactId: string;
      readonly message: string;
    };

export interface LandingOutcome {
  readonly status: "landed";
  readonly laneId: string;
  readonly previousSha: string;
  readonly landedSha: string;
  readonly artifactIds: readonly string[];
  readonly checkedOutWorktree?: string;
}

export interface DeliveryCoordinatorOptions {
  readonly worktreesRoot?: string;
  readonly now?: () => Date;
  readonly createOperationId?: () => string;
}

interface CandidateVerification {
  readonly changedFiles: readonly ChangedFile[];
  readonly scopeEvaluation: ScopePolicyEvaluation;
  readonly verificationResults: readonly DeliveryVerificationResult[];
  readonly passed: boolean;
  readonly failureClass?: "policy_violation" | "test_regression";
}

interface LoadedLane {
  readonly lane: DeliveryLane;
  readonly reconciledFromSha?: string;
  readonly reconciledArtifactIds: readonly string[];
}

const EMPTY_SCOPE_POLICY: EffectiveScopePolicy = {
  allowPathGroups: [],
  deniedPaths: [],
};

function errorCode(error: unknown): string | undefined {
  return error instanceof AgentQError ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function scopeGate(
  kind: Extract<VerificationGateKind, "allowed_paths" | "denied_paths" | "max_changed_files">,
  passed: boolean,
  summary: string,
  at: string,
): DeliveryVerificationResult {
  return {
    kind,
    status: passed ? "passed" : "failed",
    summary,
    startedAt: at,
    finishedAt: at,
    durationMs: 0,
  };
}

function commandShell(command: string): readonly [string, string[]] {
  return process.platform === "win32"
    ? [process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command]]
    : ["/bin/sh", ["-lc", command]];
}

async function optionalCommit(
  repoPath: string,
  ref: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    return await resolveCommit(repoPath, ref, { signal });
  } catch (error) {
    if (errorCode(error) === "COMMIT_NOT_FOUND") return undefined;
    throw error;
  }
}

async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  await runGit(repoPath, ["worktree", "remove", "--force", worktreePath], {
    allowFailure: true,
    maxOutputBytes: 1024 * 1024,
  });
  await rm(worktreePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  await runGit(repoPath, ["worktree", "prune", "--expire", "now"], {
    allowFailure: true,
    maxOutputBytes: 1024 * 1024,
  });
}

export class DeliveryCoordinator {
  readonly #persistence: DeliveryPersistence;
  readonly #worktreesRoot: string;
  readonly #now: () => Date;
  readonly #createOperationId: () => string;

  constructor(persistence: DeliveryPersistence, options: DeliveryCoordinatorOptions = {}) {
    this.#persistence = persistence;
    this.#worktreesRoot =
      options.worktreesRoot ?? join(tmpdir(), "agentq-delivery-coordinator-worktrees");
    this.#now = options.now ?? (() => new Date());
    this.#createOperationId = options.createOperationId ?? randomUUID;
  }

  async integrate(input: IntegrateArtifactInput): Promise<IntegrationOutcome> {
    input.signal?.throwIfAborted();
    const loaded = await this.#loadAndValidateLane(input.lane, input.signal);
    const lane = loaded.lane;
    const operationId = this.#createOperationId();
    const claimed = await this.#persistence.tryClaimLane({
      laneId: lane.id,
      operationId,
      kind: "integrate",
      taskId: input.artifact.taskId,
      artifactId: input.artifact.id,
      expectedRevision: lane.revision,
      expectedHeadSha: lane.headSha,
    });
    if (!claimed) {
      const message = `Delivery lane ${lane.id} changed before artifact ${input.artifact.id} could be claimed`;
      await this.#recordFailure({
        artifactId: input.artifact.id,
        laneId: lane.id,
        operationId,
        failureClass: "integration_contention",
        message,
      });
      return {
        status: "contended",
        laneId: lane.id,
        artifactId: input.artifact.id,
        message,
      };
    }

    let candidateRef: string | undefined;
    let candidateSha: string | undefined;
    try {
      await this.#assertImmutableArtifact(input.lane.repoPath, input.artifact, input.signal);
      const replay = await replayResultCommit(
        input.lane.repoPath,
        input.artifact.resultRef,
        input.lane.trainRef,
        this.#worktreesRoot,
        { signal: input.signal },
      );
      if (replay.status === "conflict") {
        const message = `Result ${input.artifact.resultSha} conflicts with the delivery train`;
        await this.#recordFailure({
          artifactId: input.artifact.id,
          laneId: lane.id,
          operationId,
          failureClass: "integration_conflict",
          message,
          conflictPaths: replay.conflictPaths,
        });
        return {
          status: "conflict",
          laneId: lane.id,
          artifactId: input.artifact.id,
          conflictPaths: replay.conflictPaths,
        };
      }

      candidateSha = replay.candidateSha;
      candidateRef = replay.status === "applied" ? replay.candidateRef : undefined;
      const verification = await this.#verifyCandidate(
        input.lane.repoPath,
        replay.status === "already-applied" && loaded.reconciledFromSha
          ? loaded.reconciledFromSha
          : lane.headSha,
        candidateSha,
        input.scopePolicy ?? EMPTY_SCOPE_POLICY,
        input.verificationCommands ?? [],
        input.signal,
      );
      if (!verification.passed) {
        const failureClass = verification.failureClass ?? "test_regression";
        const message =
          failureClass === "policy_violation"
            ? "The replay candidate violates its authoritative path policy"
            : "The replay candidate failed mandatory verification";
        await this.#recordFailure({
          artifactId: input.artifact.id,
          laneId: lane.id,
          operationId,
          failureClass,
          message,
          changedFiles: verification.changedFiles,
          scopeEvaluation: verification.scopeEvaluation,
          verificationResults: verification.verificationResults,
        });
        return {
          status: "verification-failed",
          laneId: lane.id,
          artifactId: input.artifact.id,
          failureClass,
          changedFiles: verification.changedFiles,
          scopeEvaluation: verification.scopeEvaluation,
          verificationResults: verification.verificationResults,
        };
      }

      await this.#assertImmutableArtifact(input.lane.repoPath, input.artifact, input.signal);
      try {
        await advanceTrainRef(
          input.lane.repoPath,
          input.lane.trainRef,
          candidateSha,
          lane.headSha,
          { signal: input.signal },
        );
      } catch (error) {
        if (errorCode(error) !== "TRAIN_REF_CONFLICT") throw error;
        const message = errorMessage(error);
        await this.#recordFailure({
          artifactId: input.artifact.id,
          laneId: lane.id,
          operationId,
          failureClass: "integration_contention",
          message,
          changedFiles: verification.changedFiles,
          scopeEvaluation: verification.scopeEvaluation,
          verificationResults: verification.verificationResults,
        });
        return {
          status: "contended",
          laneId: lane.id,
          artifactId: input.artifact.id,
          message,
        };
      }

      const completed = await this.#persistence.completeIntegration({
        artifactId: input.artifact.id,
        laneId: lane.id,
        operationId,
        expectedRevision: lane.revision,
        expectedHeadSha: lane.headSha,
        integratedSha: candidateSha,
        changedFiles: verification.changedFiles,
        scopeEvaluation: verification.scopeEvaluation,
        verificationResults: verification.verificationResults,
      });
      if (!completed) {
        const message =
          `Git train ${input.lane.trainRef} advanced to ${candidateSha}, but delivery lane ` +
          `${lane.id} lost its persistent compare-and-swap; the next operation will reconcile`;
        await this.#recordFailure({
          artifactId: input.artifact.id,
          laneId: lane.id,
          operationId,
          failureClass: "integration_contention",
          message,
          changedFiles: verification.changedFiles,
          scopeEvaluation: verification.scopeEvaluation,
          verificationResults: verification.verificationResults,
        });
        return {
          status: "contended",
          laneId: lane.id,
          artifactId: input.artifact.id,
          message,
        };
      }

      return {
        status: "integrated",
        laneId: lane.id,
        artifactId: input.artifact.id,
        previousTrainSha: lane.headSha,
        integratedSha: candidateSha,
        changedFiles: verification.changedFiles,
        scopeEvaluation: verification.scopeEvaluation,
        verificationResults: verification.verificationResults,
      };
    } finally {
      try {
        if (candidateRef && candidateSha) {
          await releaseReplayCandidate(input.lane.repoPath, candidateRef, candidateSha);
        }
      } finally {
        await this.#persistence.releaseLaneClaim(lane.id, operationId);
      }
    }
  }

  async land(input: LandLaneInput): Promise<LandingOutcome> {
    input.signal?.throwIfAborted();
    const loaded = await this.#loadAndValidateLane(input.lane, input.signal);
    const lane = loaded.lane;
    const operationId = this.#createOperationId();
    const claimed = await this.#persistence.tryClaimLane({
      laneId: lane.id,
      operationId,
      kind: "land",
      expectedRevision: lane.revision,
      expectedHeadSha: lane.headSha,
    });
    if (!claimed) {
      throw new AgentQError(
        `Delivery lane ${lane.id} changed before landing could be claimed`,
        "DELIVERY_LANE_CONTENDED",
      );
    }

    try {
      const integrated = await this.#persistence.listIntegratedArtifacts(lane.id);
      const reachableIds: string[] = [];
      for (const artifact of integrated) {
        if (
          await isAncestor(input.lane.repoPath, artifact.integratedSha, lane.headSha, {
            signal: input.signal,
          })
        ) {
          reachableIds.push(artifact.id);
        }
      }

      const landed = await fastForwardLand(
        input.lane.repoPath,
        input.lane.targetRef,
        lane.headSha,
        lane.landedSha,
        { signal: input.signal },
      );
      const completed = await this.#persistence.completeLanding({
        laneId: lane.id,
        operationId,
        expectedRevision: lane.revision,
        expectedHeadSha: lane.headSha,
        expectedLandedSha: lane.landedSha,
        landedSha: landed.sha,
        artifactIds: reachableIds,
      });
      if (!completed) {
        throw new AgentQError(
          `Git target ${input.lane.targetRef} landed at ${landed.sha}, but persistence lost its compare-and-swap`,
          "DELIVERY_LANDING_PERSISTENCE_DIVERGED",
        );
      }
      return {
        status: "landed",
        laneId: lane.id,
        previousSha: landed.previousSha,
        landedSha: landed.sha,
        artifactIds: [...new Set([...loaded.reconciledArtifactIds, ...reachableIds])],
        ...(landed.checkedOutWorktree ? { checkedOutWorktree: landed.checkedOutWorktree } : {}),
      };
    } finally {
      await this.#persistence.releaseLaneClaim(lane.id, operationId);
    }
  }

  async #loadAndValidateLane(key: DeliveryLaneKey, signal?: AbortSignal): Promise<LoadedLane> {
    const targetSha = await resolveCommit(key.repoPath, key.targetRef, { signal });
    let lane = await this.#persistence.getOrCreateLane({ ...key, initialSha: targetSha });
    if (
      lane.repoKey !== key.repoKey ||
      lane.repoPath !== key.repoPath ||
      lane.targetRef !== key.targetRef ||
      lane.trainRef !== key.trainRef
    ) {
      throw new AgentQError(
        `Persistent delivery lane ${lane.id} does not match the requested repository and refs`,
        "DELIVERY_LANE_MISMATCH",
      );
    }
    let reconciledArtifactIds: readonly string[] = [];
    if (targetSha !== lane.landedSha) {
      const isForward = await isAncestor(key.repoPath, lane.landedSha, targetSha, { signal });
      const isOnVerifiedTrain =
        isForward && (await isAncestor(key.repoPath, targetSha, lane.headSha, { signal }));
      if (!isOnVerifiedTrain) {
        throw new AgentQError(
          `Landing target ${key.targetRef} drifted from ${lane.landedSha} to ${targetSha}`,
          "DELIVERY_TARGET_DRIFT",
        );
      }
      const integrated = await this.#persistence.listIntegratedArtifacts(lane.id);
      const reachableIds: string[] = [];
      for (const artifact of integrated) {
        if (await isAncestor(key.repoPath, artifact.integratedSha, targetSha, { signal })) {
          reachableIds.push(artifact.id);
        }
      }
      const reconciled = await this.#persistence.reconcileLanding({
        laneId: lane.id,
        expectedRevision: lane.revision,
        expectedHeadSha: lane.headSha,
        expectedLandedSha: lane.landedSha,
        actualLandedSha: targetSha,
        artifactIds: reachableIds,
      });
      if (!reconciled) {
        throw new AgentQError(
          `Delivery lane ${lane.id} changed while reconciling landing target ${key.targetRef}`,
          "DELIVERY_LANE_CONTENDED",
        );
      }
      lane = reconciled;
      reconciledArtifactIds = reachableIds;
    }

    const trainSha = await optionalCommit(key.repoPath, key.trainRef, signal);
    let reconciledFromSha: string | undefined;
    if (trainSha === undefined) {
      try {
        await advanceTrainRef(key.repoPath, key.trainRef, lane.headSha, null, { signal });
      } catch (error) {
        if (errorCode(error) !== "TRAIN_REF_CONFLICT") throw error;
        const racedSha = await resolveCommit(key.repoPath, key.trainRef, { signal });
        if (racedSha !== lane.headSha) throw error;
      }
    } else if (trainSha !== lane.headSha) {
      if (await isAncestor(key.repoPath, lane.headSha, trainSha, { signal })) {
        reconciledFromSha = lane.headSha;
        const reconciled = await this.#persistence.reconcileLaneHead({
          laneId: lane.id,
          expectedRevision: lane.revision,
          expectedHeadSha: lane.headSha,
          actualHeadSha: trainSha,
        });
        if (!reconciled) {
          throw new AgentQError(
            `Delivery lane ${lane.id} changed while reconciling Git train ${key.trainRef}`,
            "DELIVERY_LANE_CONTENDED",
          );
        }
        lane = reconciled;
      } else {
        throw new AgentQError(
          `Git train ${key.trainRef} is not a forward descendant of persisted head ${lane.headSha}`,
          "DELIVERY_LANE_DIVERGED",
        );
      }
    }
    return {
      lane,
      reconciledArtifactIds,
      ...(reconciledFromSha ? { reconciledFromSha } : {}),
    };
  }

  async #assertImmutableArtifact(
    repoPath: string,
    artifact: DeliveryArtifact,
    signal?: AbortSignal,
  ): Promise<void> {
    const actualSha = await resolveCommit(repoPath, artifact.resultRef, { signal });
    if (actualSha !== artifact.resultSha) {
      throw new AgentQError(
        `Immutable result ref ${artifact.resultRef} changed from ${artifact.resultSha} to ${actualSha}`,
        "RESULT_REF_IMMUTABLE",
      );
    }
  }

  async #verifyCandidate(
    repoPath: string,
    baseSha: string,
    candidateSha: string,
    scopePolicy: EffectiveScopePolicy,
    commands: readonly string[],
    signal?: AbortSignal,
  ): Promise<CandidateVerification> {
    await mkdir(this.#worktreesRoot, { recursive: true, mode: 0o700 });
    const worktreePath = await mkdtemp(join(this.#worktreesRoot, "verify-"));
    await rm(worktreePath, { recursive: true, force: true });
    const hooksPath = await mkdtemp(join(this.#worktreesRoot, "empty-hooks-"));
    try {
      await runGit(
        repoPath,
        [
          "-c",
          `core.hooksPath=${hooksPath}`,
          "worktree",
          "add",
          "--detach",
          worktreePath,
          candidateSha,
        ],
        { signal, maxOutputBytes: 1024 * 1024 },
      );
      const snapshot = await snapshotChangedFiles(worktreePath, baseSha, { signal });
      if (snapshot.headSha !== candidateSha) {
        throw new AgentQError(
          `Verification worktree resolved ${snapshot.headSha}, expected ${candidateSha}`,
          "DELIVERY_CANDIDATE_CHANGED",
        );
      }
      const changedFiles = snapshot.files;
      const scopeEvaluation = evaluateScopePolicy(
        scopePolicy,
        changedFiles.flatMap((file) =>
          file.previousPath ? [file.previousPath, file.path] : [file.path],
        ),
      );
      const at = this.#now().toISOString();
      const verificationResults: DeliveryVerificationResult[] = [];
      const deniedViolations = scopeEvaluation.violations.filter(
        (violation) =>
          violation.code === "denied_path" || violation.code === "invalid_changed_path",
      );
      const allowedViolations = scopeEvaluation.violations.filter(
        (violation) => violation.code === "outside_allowed_paths",
      );
      const maximumViolations = scopeEvaluation.violations.filter(
        (violation) => violation.code === "max_changed_files",
      );
      verificationResults.push(
        scopeGate(
          "allowed_paths",
          allowedViolations.length === 0,
          allowedViolations.map((violation) => violation.message).join("; ") ||
            "All changed paths satisfy the allowed path policy",
          at,
        ),
        scopeGate(
          "denied_paths",
          deniedViolations.length === 0,
          deniedViolations.map((violation) => violation.message).join("; ") ||
            "No changed path is denied",
          at,
        ),
        scopeGate(
          "max_changed_files",
          maximumViolations.length === 0,
          maximumViolations.map((violation) => violation.message).join("; ") ||
            `${changedFiles.length} changed file(s) satisfy the configured limit`,
          at,
        ),
      );

      if (!scopeEvaluation.passed) {
        return {
          changedFiles,
          scopeEvaluation,
          verificationResults,
          passed: false,
          failureClass: "policy_violation",
        };
      }

      let commandsPassed = true;
      for (const command of commands) {
        const startedAt = this.#now();
        const [shell, args] = commandShell(command);
        const result = await runCommand(shell, args, {
          cwd: worktreePath,
          signal,
          env: { ...process.env, CI: "1", GIT_TERMINAL_PROMPT: "0" },
          maxOutputBytes: 8 * 1024 * 1024,
          killProcessTree: true,
        });
        const finishedAt = this.#now();
        verificationResults.push({
          kind: "command",
          status: result.exitCode === 0 ? "passed" : "failed",
          command,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          summary:
            result.exitCode === 0
              ? `Command passed: ${command}`
              : `Command failed with exit code ${result.exitCode}: ${command}`,
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
        });
        if (result.exitCode !== 0) {
          commandsPassed = false;
          break;
        }
      }

      const cleanStartedAt = this.#now();
      const clean = await runGit(
        worktreePath,
        ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        {
          signal,
          maxOutputBytes: 8 * 1024 * 1024,
        },
      );
      const cleanFinishedAt = this.#now();
      const isClean = clean.stdout.length === 0;
      verificationResults.push({
        kind: "clean_worktree",
        status: isClean ? "passed" : "failed",
        summary: isClean
          ? "Verification left the replay candidate clean"
          : "Verification modified the replay candidate worktree",
        startedAt: cleanStartedAt.toISOString(),
        finishedAt: cleanFinishedAt.toISOString(),
        durationMs: Math.max(0, cleanFinishedAt.getTime() - cleanStartedAt.getTime()),
      });
      return {
        changedFiles,
        scopeEvaluation,
        verificationResults,
        passed: commandsPassed && isClean,
        ...(!commandsPassed || !isClean ? { failureClass: "test_regression" as const } : {}),
      };
    } finally {
      await removeWorktree(repoPath, worktreePath);
      await rm(hooksPath, { recursive: true, force: true });
      try {
        if ((await readdir(this.#worktreesRoot)).length === 0) {
          await rm(this.#worktreesRoot, { recursive: false });
        }
      } catch {
        // Concurrent delivery operations may still own this shared directory.
      }
    }
  }

  async #recordFailure(
    input: Omit<
      IntegrationFailureRecord,
      "conflictPaths" | "changedFiles" | "verificationResults"
    > & {
      readonly conflictPaths?: readonly string[];
      readonly changedFiles?: readonly ChangedFile[];
      readonly verificationResults?: readonly DeliveryVerificationResult[];
    },
  ): Promise<void> {
    await this.#persistence.recordIntegrationFailure({
      ...input,
      conflictPaths: input.conflictPaths ?? [],
      changedFiles: input.changedFiles ?? [],
      verificationResults: input.verificationResults ?? [],
    });
  }
}
