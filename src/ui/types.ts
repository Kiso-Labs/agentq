import type { AddTaskInput, Queue, Task, TaskEvent } from "../core/types.ts";

export interface ListEventOptions {
  afterId?: number;
  limit?: number;
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
  listEvents(taskId: string, options?: ListEventOptions): Promise<TaskEvent[]>;
  addTask(input: AddTaskInput): Promise<Task>;
  cancelTask(taskId: string): Promise<void>;
  retryTask(taskId: string): Promise<void>;
  completeManualTask(taskId: string): Promise<void>;
  subscribe?(listener: () => void): () => void;
}

export interface AgentqAppProps {
  controller: UiController;
  dimensions?: { columns: number; rows: number };
  pollIntervalMs?: number;
  onExit?: () => void;
}
