import { AgentQError } from "../core/errors.ts";
import type { DeliveryOperationClaim, IntegrationLane } from "../core/types.ts";
import type { AgentQStore } from "../store/store.ts";
import type {
  CompleteIntegrationInput,
  CompleteLandingInput,
  DeliveryLane,
  DeliveryLaneKey,
  DeliveryPersistence,
  IntegratedArtifact,
  IntegrationFailureRecord,
  LaneClaimInput,
  ReconcileLandingInput,
  ReconcileLaneHeadInput,
} from "./coordinator.ts";

export interface AgentQStoreDeliveryPersistenceOptions {
  readonly leaseDurationMs?: number;
  readonly heartbeatIntervalMs?: number | false;
  readonly now?: () => Date | string;
  readonly onReleaseError?: (error: unknown) => void;
}

interface RetainedClaim {
  readonly coordinatorOperationId: string;
  readonly storeOperationId: string;
  readonly laneId: string;
  readonly kind: "integrate" | "land";
  readonly leaseToken: string;
  readonly fenceToken: number;
  heartbeat?: ReturnType<typeof setInterval>;
  heartbeatError?: unknown;
}

const CAS_ERROR_CODES = new Set(["DELIVERY_LEASE_LOST", "INTEGRATION_LANE_HEAD_CHANGED"]);

function isAgentQErrorCode(error: unknown, codes: ReadonlySet<string>): boolean {
  return error instanceof AgentQError && codes.has(error.code);
}

function finitePositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AgentQError(`${field} must be a positive integer`, "INVALID_INPUT", 2);
  }
  return value;
}

function timestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new AgentQError(
      "Delivery persistence clock returned an invalid date",
      "INVALID_INPUT",
      2,
    );
  }
  return date.toISOString();
}

function mapLane(lane: IntegrationLane): DeliveryLane {
  return {
    id: lane.id,
    repoKey: lane.repoKey,
    repoPath: lane.repoPath,
    targetRef: lane.targetRef,
    trainRef: lane.trainRef,
    headSha: lane.headSha,
    landedSha: lane.targetBaseSha,
    revision: lane.generation,
  };
}

function assertLaneIdentity(lane: IntegrationLane, key: DeliveryLaneKey): void {
  if (
    lane.repoKey !== key.repoKey ||
    lane.repoPath !== key.repoPath ||
    lane.targetRef !== key.targetRef ||
    lane.trainRef !== key.trainRef
  ) {
    throw new AgentQError(
      `Integration lane ${lane.id} does not match the requested repository and refs`,
      "DELIVERY_LANE_MISMATCH",
    );
  }
}

/**
 * Durable coordinator persistence backed by AgentQStore.
 *
 * The adapter retains only lease credentials in memory. Lane, artifact,
 * operation, failure, and landing state remain durable in SQLite, so a new
 * adapter instance can reclaim an expired operation after a process restart.
 */
export class AgentQStoreDeliveryPersistence implements DeliveryPersistence {
  readonly #store: AgentQStore;
  readonly #leaseDurationMs: number;
  readonly #heartbeatIntervalMs: number | false;
  readonly #now: () => Date | string;
  readonly #onReleaseError?: (error: unknown) => void;
  readonly #claims = new Map<string, RetainedClaim>();

  constructor(store: AgentQStore, options: AgentQStoreDeliveryPersistenceOptions = {}) {
    this.#store = store;
    this.#leaseDurationMs = finitePositiveInteger(
      options.leaseDurationMs ?? 30_000,
      "leaseDurationMs",
    );
    this.#heartbeatIntervalMs =
      options.heartbeatIntervalMs === false
        ? false
        : finitePositiveInteger(
            options.heartbeatIntervalMs ?? Math.max(1, Math.floor(this.#leaseDurationMs / 3)),
            "heartbeatIntervalMs",
          );
    this.#now = options.now ?? (() => new Date());
    this.#onReleaseError = options.onReleaseError;
  }

  async getOrCreateLane(input: DeliveryLaneKey & { initialSha: string }): Promise<DeliveryLane> {
    const lane = this.#store.getOrCreateIntegrationLane({
      repoKey: input.repoKey,
      repoPath: input.repoPath,
      targetRef: input.targetRef,
      trainRef: input.trainRef,
      initialHeadSha: input.initialSha,
      createdAt: this.#timestamp(),
    });
    assertLaneIdentity(lane, input);
    return mapLane(lane);
  }

  async reconcileLaneHead(input: ReconcileLaneHeadInput): Promise<DeliveryLane | undefined> {
    const current = this.#store.getIntegrationLane(input.laneId);
    if (!current) return undefined;
    if (current.headSha === input.actualHeadSha) return mapLane(current);
    if (
      current.generation !== input.expectedRevision ||
      current.headSha !== input.expectedHeadSha
    ) {
      return undefined;
    }
    try {
      return mapLane(
        this.#store.reconcileIntegrationLaneHead(current.id, {
          expectedLaneGeneration: input.expectedRevision,
          expectedHeadSha: input.expectedHeadSha,
          newHeadSha: input.actualHeadSha,
          updatedAt: this.#timestamp(),
        }),
      );
    } catch (error) {
      if (!isAgentQErrorCode(error, CAS_ERROR_CODES)) throw error;
      const raced = this.#store.getIntegrationLane(input.laneId);
      return raced?.headSha === input.actualHeadSha ? mapLane(raced) : undefined;
    }
  }

  async reconcileLanding(input: ReconcileLandingInput): Promise<DeliveryLane | undefined> {
    let lane = this.#store.getIntegrationLane(input.laneId);
    if (!lane) return undefined;
    if (input.actualLandedSha !== lane.headSha) return undefined;
    if (lane.targetBaseSha !== input.actualLandedSha) {
      if (
        lane.generation !== input.expectedRevision ||
        lane.headSha !== input.expectedHeadSha ||
        lane.targetBaseSha !== input.expectedLandedSha
      ) {
        return undefined;
      }
    }

    const needsArtifactUpdate = this.#artifactsNeedLanding(lane, input.artifactIds);
    if (lane.targetBaseSha === input.actualLandedSha && !needsArtifactUpdate) {
      return mapLane(lane);
    }

    try {
      const completed = this.#store.completeLanding({
        laneId: lane.id,
        expectedLaneGeneration: lane.generation,
        expectedHeadSha: lane.headSha,
        landedSha: input.actualLandedSha,
        artifactIds: [...input.artifactIds],
        completedAt: this.#timestamp(),
      });
      return mapLane(completed.lane);
    } catch (error) {
      if (!isAgentQErrorCode(error, CAS_ERROR_CODES)) throw error;
      lane = this.#store.getIntegrationLane(input.laneId);
      if (!lane || lane.targetBaseSha !== input.actualLandedSha) return undefined;
      if (this.#artifactsNeedLanding(lane, input.artifactIds)) return undefined;
      return mapLane(lane);
    }
  }

  async tryClaimLane(input: LaneClaimInput): Promise<boolean> {
    if (this.#claims.has(input.operationId)) return false;
    const lane = this.#store.getIntegrationLane(input.laneId);
    if (
      !lane ||
      lane.generation !== input.expectedRevision ||
      lane.headSha !== input.expectedHeadSha
    ) {
      return false;
    }
    if (input.kind === "integrate" && (!input.taskId || !input.artifactId)) {
      throw new AgentQError(
        "An integration claim requires its task and artifact",
        "INVALID_DELIVERY_OPERATION",
        2,
      );
    }
    if (input.kind === "land" && (input.taskId !== undefined || input.artifactId !== undefined)) {
      throw new AgentQError(
        "A landing claim cannot name a task or artifact",
        "INVALID_DELIVERY_OPERATION",
        2,
      );
    }

    const operation = this.#store.createDeliveryOperation({
      laneId: lane.id,
      kind: input.kind,
      ...(input.kind === "integrate"
        ? { taskId: input.taskId as string, artifactId: input.artifactId as string }
        : {}),
      createdAt: this.#timestamp(),
    });
    const claim = this.#store.claimDeliveryOperation({
      operationId: operation.id,
      ownerToken: input.operationId,
      laneId: lane.id,
      now: this.#timestamp(),
      leaseDurationMs: this.#leaseDurationMs,
    });
    if (!claim) return false;
    this.#assertClaimMatches(input, claim);

    const retained: RetainedClaim = {
      coordinatorOperationId: input.operationId,
      storeOperationId: claim.operation.id,
      laneId: lane.id,
      kind: input.kind,
      leaseToken: claim.leaseToken,
      fenceToken: claim.fenceToken,
    };
    this.#claims.set(input.operationId, retained);
    this.#startHeartbeat(retained);
    return true;
  }

  async completeIntegration(input: CompleteIntegrationInput): Promise<boolean> {
    const claim = this.#claim(input.operationId, "integrate");
    if (claim.laneId !== input.laneId) return false;
    if (claim.heartbeatError) {
      if (isAgentQErrorCode(claim.heartbeatError, CAS_ERROR_CODES)) return false;
      throw claim.heartbeatError;
    }
    try {
      this.#store.completeIntegration({
        operationId: claim.storeOperationId,
        leaseToken: claim.leaseToken,
        fenceToken: claim.fenceToken,
        expectedLaneGeneration: input.expectedRevision,
        expectedHeadSha: input.expectedHeadSha,
        newHeadSha: input.integratedSha,
        integrationBranch: this.#store.getIntegrationLane(input.laneId)?.trainRef,
        completedAt: this.#timestamp(),
      });
      this.#stopHeartbeat(claim);
      return true;
    } catch (error) {
      if (!isAgentQErrorCode(error, CAS_ERROR_CODES)) throw error;
      this.#stopHeartbeat(claim);
      return false;
    }
  }

  async completeLanding(input: CompleteLandingInput): Promise<boolean> {
    const claim = this.#claim(input.operationId, "land");
    if (claim.laneId !== input.laneId) return false;
    if (claim.heartbeatError) {
      if (isAgentQErrorCode(claim.heartbeatError, CAS_ERROR_CODES)) return false;
      throw claim.heartbeatError;
    }
    const lane = this.#store.getIntegrationLane(input.laneId);
    if (
      !lane ||
      lane.generation !== input.expectedRevision ||
      lane.headSha !== input.expectedHeadSha ||
      lane.targetBaseSha !== input.expectedLandedSha ||
      input.landedSha !== input.expectedHeadSha
    ) {
      return false;
    }
    try {
      this.#store.completeLanding({
        laneId: input.laneId,
        expectedLaneGeneration: input.expectedRevision,
        expectedHeadSha: input.expectedHeadSha,
        landedSha: input.landedSha,
        artifactIds: [...input.artifactIds],
        operationId: claim.storeOperationId,
        leaseToken: claim.leaseToken,
        fenceToken: claim.fenceToken,
        completedAt: this.#timestamp(),
      });
      this.#stopHeartbeat(claim);
      return true;
    } catch (error) {
      if (!isAgentQErrorCode(error, CAS_ERROR_CODES)) throw error;
      this.#stopHeartbeat(claim);
      return false;
    }
  }

  async releaseLaneClaim(laneId: string, operationId: string): Promise<void> {
    const claim = this.#claims.get(operationId);
    if (!claim || claim.laneId !== laneId) return;
    this.#stopHeartbeat(claim);
    try {
      const operation = this.#store.getDeliveryOperation(claim.storeOperationId);
      if (operation?.status === "running") {
        this.#store.finishDeliveryOperation(
          operation.id,
          {
            status: "cancelled",
            error: "Delivery coordinator released an unfinished claimed operation",
            finishedAt: this.#timestamp(),
          },
          claim.leaseToken,
          claim.fenceToken,
        );
      }
    } catch (error) {
      try {
        this.#onReleaseError?.(error);
      } catch {
        // Release is called from coordinator finally blocks and must not mask the original error.
      }
    } finally {
      this.#claims.delete(operationId);
    }
  }

  async recordIntegrationFailure(input: IntegrationFailureRecord): Promise<void> {
    const claim = this.#claims.get(input.operationId);
    if (!claim) {
      if (input.failureClass === "integration_contention") return;
      throw new AgentQError(
        `Delivery operation ${input.operationId} is not claimed by this process`,
        "DELIVERY_CLAIM_NOT_HELD",
      );
    }
    if (claim.kind !== "integrate") {
      throw new AgentQError(
        `Delivery operation ${input.operationId} is not an integration`,
        "INVALID_DELIVERY_OPERATION",
      );
    }
    const operation = this.#store.getDeliveryOperation(claim.storeOperationId);
    if (claim.laneId !== input.laneId || operation?.artifactId !== input.artifactId) {
      throw new AgentQError(
        `Delivery operation ${input.operationId} does not match integration failure ${input.artifactId}`,
        "DELIVERY_CLAIM_MISMATCH",
      );
    }
    this.#stopHeartbeat(claim);
    const status = input.failureClass === "integration_conflict" ? "conflicted" : "failed";
    try {
      this.#store.recordIntegrationFailure({
        operationId: claim.storeOperationId,
        leaseToken: claim.leaseToken,
        fenceToken: claim.fenceToken,
        status,
        failureClass: input.failureClass,
        conflictFiles: [...input.conflictPaths],
        error: input.message,
        finishedAt: this.#timestamp(),
      });
    } catch (error) {
      if (isAgentQErrorCode(error, new Set(["DELIVERY_LEASE_LOST"]))) return;
      throw error;
    }
  }

  async listIntegratedArtifacts(laneId: string): Promise<readonly IntegratedArtifact[]> {
    const lane = this.#store.getIntegrationLane(laneId);
    if (!lane) return [];
    const artifacts = new Map<string, IntegratedArtifact>();
    for (const operation of this.#store.listDeliveryOperations({
      laneId,
      statuses: ["succeeded"],
    })) {
      if (operation.kind !== "integrate" || !operation.artifactId || !operation.taskId) continue;
      const [artifact, task] = [
        this.#store.getTaskArtifact(operation.artifactId),
        this.#store.getTask(operation.taskId),
      ];
      if (
        !artifact ||
        !task ||
        artifact.taskId !== task.id ||
        artifact.repoKey !== lane.repoKey ||
        artifact.targetRef !== lane.targetRef ||
        (task.deliveryStatus !== "integrated" && task.deliveryStatus !== "landed") ||
        !task.integratedSha
      ) {
        continue;
      }
      artifacts.set(artifact.id, { id: artifact.id, integratedSha: task.integratedSha });
    }
    return [...artifacts.values()];
  }

  #timestamp(): string {
    return timestamp(this.#now());
  }

  #artifactsNeedLanding(lane: IntegrationLane, artifactIds: readonly string[]): boolean {
    let needsLanding = false;
    for (const artifactId of artifactIds) {
      const artifact = this.#store.getTaskArtifact(artifactId);
      const task = artifact ? this.#store.getTask(artifact.taskId) : undefined;
      if (
        !artifact ||
        !task ||
        artifact.repoKey !== lane.repoKey ||
        artifact.targetRef !== lane.targetRef ||
        !task.integratedSha ||
        (task.deliveryStatus !== "integrated" && task.deliveryStatus !== "landed")
      ) {
        throw new AgentQError(
          `Artifact ${artifactId} is not integrated into lane ${lane.id}`,
          "DELIVERY_ARTIFACT_LANE_MISMATCH",
        );
      }
      if (task.deliveryStatus === "integrated") needsLanding = true;
    }
    return needsLanding;
  }

  #claim(operationId: string, kind: "integrate" | "land"): RetainedClaim {
    const claim = this.#claims.get(operationId);
    if (!claim) {
      throw new AgentQError(
        `Delivery operation ${operationId} is not claimed by this process`,
        "DELIVERY_CLAIM_NOT_HELD",
      );
    }
    if (claim.kind !== kind) {
      throw new AgentQError(
        `Delivery operation ${operationId} is not a ${kind} operation`,
        "INVALID_DELIVERY_OPERATION",
      );
    }
    return claim;
  }

  #assertClaimMatches(input: LaneClaimInput, claim: DeliveryOperationClaim): void {
    const operation = claim.operation;
    if (
      operation.laneId !== input.laneId ||
      operation.kind !== input.kind ||
      operation.expectedHeadSha !== input.expectedHeadSha ||
      (input.kind === "integrate" &&
        (operation.taskId !== input.taskId || operation.artifactId !== input.artifactId))
    ) {
      try {
        this.#store.finishDeliveryOperation(
          operation.id,
          {
            status: "cancelled",
            error: "Claimed delivery operation did not match the coordinator request",
            finishedAt: this.#timestamp(),
          },
          claim.leaseToken,
          claim.fenceToken,
        );
      } catch {
        // The mismatch remains the actionable error.
      }
      throw new AgentQError(
        `Claimed delivery operation ${operation.id} does not match the coordinator request`,
        "DELIVERY_CLAIM_MISMATCH",
      );
    }
  }

  #startHeartbeat(claim: RetainedClaim): void {
    if (this.#heartbeatIntervalMs === false) return;
    const interval = this.#heartbeatIntervalMs;
    claim.heartbeat = setInterval(() => {
      if (claim.heartbeatError) return;
      try {
        this.#store.heartbeatDeliveryOperation(
          claim.storeOperationId,
          claim.leaseToken,
          claim.fenceToken,
          {
            at: this.#timestamp(),
            leaseDurationMs: this.#leaseDurationMs,
          },
        );
      } catch (error) {
        claim.heartbeatError = error;
        this.#stopHeartbeat(claim);
      }
    }, interval);
    claim.heartbeat.unref?.();
  }

  #stopHeartbeat(claim: RetainedClaim): void {
    if (claim.heartbeat) clearInterval(claim.heartbeat);
    claim.heartbeat = undefined;
  }
}
