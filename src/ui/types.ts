import type { QueueLandingOutcome, TaskIntegrationOutcome } from "../app.ts";
import type {
  AddTaskInput,
  CreateQueueInput,
  DeliveryOperation,
  IntegrationLane,
  Provider,
  Queue,
  Run,
  Task,
  TaskApproval,
  TaskArtifact,
  TaskEvent,
} from "../core/types.ts";
import type { IntegrationResult, IntegrationTarget } from "../integrations/instructions.ts";

export interface ListEventOptions {
  afterId?: number;
  limit?: number;
}

export type UiTaskPatch = Partial<
  Omit<
    Pick<
      Task,
      | "title"
      | "instructions"
      | "acceptanceCriteria"
      | "objective"
      | "invariants"
      | "handoffRequirements"
      | "blockedBy"
      | "expectedPaths"
      | "allowedPaths"
      | "deniedPaths"
      | "maxChangedFiles"
      | "verifyCommands"
      | "approvalCheckpoints"
      | "baseDriftPolicy"
      | "landStrategy"
      | "provider"
      | "priority"
    >,
    "maxChangedFiles"
  >
> & { maxChangedFiles?: number | null };

export type UiCreateQueueInput = Omit<CreateQueueInput, "repoKey">;

export type UiQueuePatch = Partial<
  Omit<
    Pick<
      Queue,
      | "name"
      | "baseRef"
      | "defaultProvider"
      | "planModel"
      | "planInstructions"
      | "implementModel"
      | "implementInstructions"
      | "concurrency"
      | "maxAttempts"
      | "verifyCommands"
      | "autoCommit"
      | "allowedPaths"
      | "deniedPaths"
      | "maxChangedFiles"
      | "approvalCheckpoints"
      | "baseDriftPolicy"
      | "landStrategy"
      | "autoLand"
      | "fileConcurrency"
    >,
    "maxChangedFiles"
  >
> & { maxChangedFiles?: number | null };

export interface UiDoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  remediation?: string;
}

export interface UiContext {
  label: string;
  repositoryPath?: string;
  all: boolean;
  canToggle: boolean;
}

export interface UiCleanResult {
  taskId: string;
  removedWorktree: string;
}

export interface UiQueueDelivery {
  queue: Queue;
  lane?: IntegrationLane;
  tasks: Task[];
  artifacts: TaskArtifact[];
  operations: DeliveryOperation[];
}

/**
 * Narrow control-plane surface consumed by the TUI.
 *
 * `subscribe` is an invalidation signal, not a second source of state. The UI
 * always rebuilds a coherent snapshot through the list methods and falls back
 * to polling when a controller has no push source.
 */
export interface UiController {
  listQueues(): Promise<Queue[]>;
  listTasks(queueId?: string): Promise<Task[]>;
  listRuns(taskId: string): Promise<Run[]>;
  listEvents(taskId: string, options?: ListEventOptions): Promise<TaskEvent[]>;
  listTaskApprovals(taskId: string): Promise<TaskApproval[]>;
  approveTaskCheckpoint(
    taskId: string,
    checkpoint: string,
    input?: { actor?: string; note?: string },
  ): Promise<TaskApproval>;
  rejectTaskCheckpoint(
    taskId: string,
    checkpoint: string,
    input?: { actor?: string; note?: string },
  ): Promise<TaskApproval>;
  integrateTask(taskId: string, signal?: AbortSignal): Promise<TaskIntegrationOutcome>;
  landQueue(queueIdOrName: string, signal?: AbortSignal): Promise<QueueLandingOutcome>;
  getQueueDelivery(queueIdOrName: string): Promise<UiQueueDelivery>;
  createQueue(input: UiCreateQueueInput): Promise<Queue>;
  updateQueue(queueId: string, patch: UiQueuePatch): Promise<Queue>;
  deleteQueue(queueId: string): Promise<void>;
  addTask(input: AddTaskInput): Promise<Task>;
  editTask(taskId: string, patch: UiTaskPatch, expectedUpdatedAt: string): Promise<Task>;
  deleteTask(taskId: string): Promise<void>;
  cancelTask(taskId: string): Promise<void>;
  retryTask(taskId: string): Promise<void>;
  resumeTask(taskId: string): Promise<void>;
  completeManualTask(taskId: string): Promise<void>;
  cleanTask(taskId: string, options?: { force?: boolean }): Promise<UiCleanResult>;
  doctor(): Promise<UiDoctorCheck[]>;
  loginProvider(provider: Provider): Promise<void>;
  installIntegration(target: IntegrationTarget, repoPath?: string): Promise<IntegrationResult[]>;
  uiContext(): UiContext | Promise<UiContext>;
  setAllRepositories(all: boolean): void | Promise<void>;
  subscribe?(listener: () => void): () => void;
}

export interface AgentqAppProps {
  controller: UiController;
  dimensions?: { columns: number; rows: number };
  pollIntervalMs?: number;
  scopeLabel?: string;
  onExit?: () => void;
}
