import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import type { AddTaskInput, Queue, Task, TaskEvent } from "../src/core/types.ts";
import { AgentqApp } from "../src/ui/app.tsx";
import { sanitizeTerminalText } from "../src/ui/sanitize.ts";
import type { UiController } from "../src/ui/types.ts";

const NOW = "2026-07-21T12:00:00.000Z";

const queue = (overrides: Partial<Queue> = {}): Queue => ({
  id: "queue-main",
  name: "main",
  repoPath: "/code/agentq",
  baseRef: "main",
  defaultProvider: "codex",
  concurrency: 3,
  maxAttempts: 2,
  verifyCommands: [],
  autoCommit: true,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const task = (overrides: Partial<Task> = {}): Task => ({
  id: "task-1",
  queueId: "queue-main",
  queueName: "main",
  title: "Fix session redirect",
  instructions: "Reproduce the expired-session redirect and add a regression test.",
  acceptanceCriteria: [],
  provider: "codex",
  priority: 0,
  status: "running",
  sourceKind: "manual",
  attemptCount: 1,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const event = (overrides: Partial<TaskEvent> = {}): TaskEvent => ({
  id: 1,
  taskId: "task-1",
  runId: "run-1",
  kind: "assistant",
  payload: { text: "Running the focused regression test" },
  createdAt: NOW,
  ...overrides,
});

const createController = (overrides: Partial<UiController> = {}): UiController => ({
  listQueues: mock(async () => [queue()]),
  listTasks: mock(async () => [task()]),
  listEvents: mock(async () => [event()]),
  addTask: mock(async (input: AddTaskInput) => task({ title: input.title })),
  cancelTask: mock(async () => undefined),
  retryTask: mock(async () => undefined),
  completeManualTask: mock(async () => undefined),
  ...overrides,
});

const settle = async () => {
  await Bun.sleep(80);
};

afterEach(() => {
  cleanup();
});

describe("AgentqApp", () => {
  test("renders a branded dashboard with queue, task, details, and live activity", async () => {
    const view = render(
      <AgentqApp controller={createController()} dimensions={{ columns: 128, rows: 30 }} />,
    );

    expect(view.lastFrame()).toContain("Loading workspace");
    await settle();

    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("AGENTQ");
    expect(frame).toContain("QUEUES");
    expect(frame).toContain("TASKS");
    expect(frame).toContain("DETAILS / LIVE LOG");
    expect(frame).toContain("Fix session redirect");
    expect(frame).toContain("Running the focused regression test");
  });

  test("counts cancelling tasks as active queue work", async () => {
    const controller = createController({
      listTasks: mock(async () => [task({ status: "cancelling" })]),
    });
    const view = render(
      <AgentqApp controller={controller} dimensions={{ columns: 128, rows: 30 }} />,
    );
    await settle();

    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("1 active");
    expect(frame).toContain("1/3");
    expect(frame).toContain("STOPPING");
  });

  test("uses tab and arrows to navigate a narrow one-pane layout", async () => {
    const second = task({ id: "task-2", title: "Ship resilient cancellation", status: "queued" });
    const controller = createController({
      listTasks: mock(async () => [task(), second]),
      listEvents: mock(async (taskId) =>
        taskId === second.id
          ? [event({ id: 2, taskId: second.id, payload: { text: "Second task selected" } })]
          : [event()],
      ),
    });
    const view = render(
      <AgentqApp controller={controller} dimensions={{ columns: 60, rows: 22 }} />,
    );
    await settle();

    expect(view.lastFrame()).toContain("QUEUES");
    expect(view.lastFrame()).not.toContain("DETAILS / LIVE LOG");

    view.stdin.write("\t");
    await settle();
    expect(view.lastFrame()).toContain("TASKS");

    view.stdin.write("\u001B[B");
    await settle();
    view.stdin.write("\t");
    await settle();

    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("DETAILS / LIVE LOG");
    expect(frame).toContain("Ship resilient cancellation");
    expect(frame).toContain("Second task selected");
  });

  test("adds a task with the selected queue, provider, title, and instructions", async () => {
    const addTask = mock(async (input: AddTaskInput) =>
      task({ id: "task-new", title: input.title, provider: input.provider ?? "codex" }),
    );
    const controller = createController({ addTask });
    const view = render(
      <AgentqApp controller={controller} dimensions={{ columns: 90, rows: 28 }} />,
    );
    await settle();

    view.stdin.write("a");
    await settle();
    expect(view.lastFrame()).toContain("ADD TASK");
    expect(view.lastFrame()).toContain("Queue");
    expect(view.lastFrame()).toContain("Provider");
    expect(view.lastFrame()).toContain("Title");
    expect(view.lastFrame()).toContain("Instructions");

    view.stdin.write("\t");
    await settle();
    view.stdin.write("\u001B[C");
    await settle();
    view.stdin.write("\t");
    await settle();
    view.stdin.write("Build a durable queue view");
    await settle();
    view.stdin.write("\t");
    await settle();
    view.stdin.write("Show reconnect-safe live output");
    await settle();
    view.stdin.write("\r");
    await settle();

    expect(addTask).toHaveBeenCalledTimes(1);
    expect(addTask.mock.calls[0]?.[0]).toEqual({
      queue: "main",
      provider: "claude",
      title: "Build a durable queue view",
      instructions: "Show reconnect-safe live output",
      sourceKind: "manual",
    });
    expect(view.lastFrame()).toContain("Added task-new");
  });

  test("requires confirmation before cancelling an active task", async () => {
    const cancelTask = mock(async () => undefined);
    const completeManualTask = mock(async () => undefined);
    const view = render(
      <AgentqApp
        controller={createController({ cancelTask, completeManualTask })}
        dimensions={{ columns: 90, rows: 24 }}
      />,
    );
    await settle();

    view.stdin.write("d");
    await settle();
    expect(completeManualTask).not.toHaveBeenCalled();

    view.stdin.write("c");
    await settle();
    expect(view.lastFrame()).toContain("CANCEL TASK?");
    expect(cancelTask).not.toHaveBeenCalled();

    view.stdin.write("n");
    await settle();
    expect(view.lastFrame()).not.toContain("CANCEL TASK?");
    expect(cancelTask).not.toHaveBeenCalled();

    view.stdin.write("c");
    await settle();
    view.stdin.write("y");
    await settle();
    expect(cancelTask).toHaveBeenCalledWith("task-1");
    expect(view.lastFrame()).toContain("Cancellation requested for task-1");
  });

  test("confirms retry and supports manual completion of a failed task", async () => {
    const retryTask = mock(async () => undefined);
    const completeManualTask = mock(async () => undefined);
    const failedController = createController({
      listTasks: mock(async () => [task({ status: "failed" })]),
      retryTask,
      completeManualTask,
    });
    const view = render(
      <AgentqApp controller={failedController} dimensions={{ columns: 90, rows: 24 }} />,
    );
    await settle();

    view.stdin.write("r");
    await settle();
    expect(view.lastFrame()).toContain("RETRY TASK?");
    expect(retryTask).not.toHaveBeenCalled();

    view.stdin.write("\r");
    await settle();
    expect(retryTask).toHaveBeenCalledWith("task-1");
    expect(view.lastFrame()).toContain("Retry queued for task-1");

    view.stdin.write("d");
    await settle();
    expect(completeManualTask).toHaveBeenCalledWith("task-1");
    expect(view.lastFrame()).toContain("Marked task-1 complete");
  });

  test("treats interrupted work as terminal while allowing retry or manual completion", async () => {
    const cancelTask = mock(async () => undefined);
    const completeManualTask = mock(async () => undefined);
    const view = render(
      <AgentqApp
        controller={createController({
          listTasks: mock(async () => [task({ status: "interrupted" })]),
          listEvents: mock(async () => []),
          cancelTask,
          completeManualTask,
        })}
        dimensions={{ columns: 90, rows: 24 }}
      />,
    );
    await settle();

    expect(view.lastFrame()).toContain("No recorded activity for this task");
    expect(view.lastFrame()).not.toContain("Waiting for agent activity");
    view.stdin.write("c");
    await settle();
    expect(view.lastFrame()).not.toContain("CANCEL TASK?");
    expect(cancelTask).not.toHaveBeenCalled();

    view.stdin.write("d");
    await settle();
    expect(completeManualTask).toHaveBeenCalledWith("task-1");
    expect(view.lastFrame()).toContain("Marked task-1 complete");
  });

  test("renders actionable empty and load-error states", async () => {
    const empty = render(
      <AgentqApp
        controller={createController({
          listQueues: mock(async () => []),
          listTasks: mock(async () => []),
        })}
        dimensions={{ columns: 120, rows: 24 }}
      />,
    );
    await settle();
    expect(empty.lastFrame()).toContain("No queues yet");
    expect(empty.lastFrame()).toContain("Queue is clear");
    empty.unmount();

    const broken = render(
      <AgentqApp
        controller={createController({
          listQueues: mock(async () => {
            throw new Error("database is locked");
          }),
        })}
        dimensions={{ columns: 80, rows: 20 }}
      />,
    );
    await settle();
    expect(broken.lastFrame()).toContain("Could not load AgentQ");
    expect(broken.lastFrame()).toContain("database is locked");
    expect(broken.lastFrame()).toContain("Press R to retry");
  });

  test("refreshes snapshots from subscriptions and keeps polling for external changes", async () => {
    let current = task({ title: "Original task title" });
    let notify = () => {};
    const unsubscribe = mock(() => undefined);
    const subscribedController = createController({
      listTasks: mock(async () => [current]),
      subscribe: (listener) => {
        notify = listener;
        return unsubscribe;
      },
    });
    const subscribed = render(
      <AgentqApp
        controller={subscribedController}
        dimensions={{ columns: 120, rows: 24 }}
        pollIntervalMs={20}
      />,
    );
    await settle();
    expect(subscribed.lastFrame()).toContain("Original task title");

    current = task({ title: "Updated through subscription" });
    notify();
    await settle();
    expect(subscribed.lastFrame()).toContain("Updated through subscription");

    current = task({ title: "Updated by another process" });
    await settle();
    expect(subscribed.lastFrame()).toContain("Updated by another process");
    subscribed.unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    current = task({ title: "Before polling" });
    const polling = render(
      <AgentqApp
        controller={createController({ listTasks: mock(async () => [current]) })}
        dimensions={{ columns: 120, rows: 24 }}
        pollIntervalMs={20}
      />,
    );
    await settle();
    current = task({ title: "Updated by polling" });
    await settle();
    expect(polling.lastFrame()).toContain("Updated by polling");
  });

  test("keeps every add-task field visible in a narrow terminal", async () => {
    const view = render(
      <AgentqApp controller={createController()} dimensions={{ columns: 44, rows: 16 }} />,
    );
    await settle();
    view.stdin.write("a");
    await settle();

    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("ADD TASK");
    expect(frame).toContain("Queue");
    expect(frame).toContain("Provider");
    expect(frame).toContain("Title");
    expect(frame).toContain("Instructions");
    expect(frame).toContain("esc");
    expect(frame).toContain("cancel");
  });

  test("keeps the selected queue visible when a short viewport contains many queues", async () => {
    const queues = Array.from({ length: 24 }, (_, index) =>
      queue({ id: `queue-${index + 1}`, name: `Queue item ${index + 1}` }),
    );
    const tasks = queues.map((item, index) =>
      task({
        id: `task-${index + 1}`,
        queueId: item.id,
        queueName: item.name,
        title: `Task for queue ${index + 1}`,
      }),
    );
    const view = render(
      <AgentqApp
        controller={createController({
          listQueues: mock(async () => queues),
          listTasks: mock(async () => tasks),
        })}
        dimensions={{ columns: 48, rows: 16 }}
      />,
    );
    await settle();

    for (let index = 0; index < 21; index += 1) {
      view.stdin.write("\u001B[B");
      await Bun.sleep(5);
    }
    await settle();

    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("QUEUES  22/24");
    expect(frame).toContain("Queue item 22");
    expect(frame).not.toContain("Queue item 1 ");
  });

  test("keeps the selected task visible when a short viewport contains many tasks", async () => {
    const tasks = Array.from({ length: 24 }, (_, index) =>
      task({ id: `task-${index + 1}`, title: `Task item ${index + 1}`, status: "queued" }),
    );
    const view = render(
      <AgentqApp
        controller={createController({ listTasks: mock(async () => tasks) })}
        dimensions={{ columns: 48, rows: 16 }}
      />,
    );
    await settle();

    view.stdin.write("\t");
    await Bun.sleep(10);
    for (let index = 0; index < 21; index += 1) {
      view.stdin.write("\u001B[B");
      await Bun.sleep(5);
    }
    await settle();

    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("TASKS  24  22/24");
    expect(frame).toContain("Task item 22");
    expect(frame).not.toContain("Task item 1 ");
  });

  test("strips terminal control sequences from untrusted display text", async () => {
    const dangerousTitle = "\u001B]2;hijacked-title\u0007Visible \u001B[31mred\u001B[0m\nnext";
    const dangerousEvent = "\u001BPdiscarded-device-command\u001B\\Agent \u009B32moutput\u009B0m";
    const maliciousTask = task({ title: dangerousTitle, instructions: "safe\u0000 instructions" });
    const view = render(
      <AgentqApp
        controller={createController({
          listQueues: mock(async () => [
            queue({ name: "\u001B]8;;https://invalid.example\u0007Main\u001B]8;;\u0007" }),
          ]),
          listTasks: mock(async () => [maliciousTask]),
          listEvents: mock(async () => [event({ payload: { text: dangerousEvent } })]),
        })}
        dimensions={{ columns: 120, rows: 24 }}
      />,
    );
    await settle();

    expect(sanitizeTerminalText(dangerousTitle)).toBe("Visible red next");
    expect(sanitizeTerminalText(dangerousEvent)).toBe("Agent output");
    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("Visible red next");
    expect(frame).toContain("safe instructions");
    expect(frame).toContain("Agent output");
    expect(frame).not.toContain("hijacked-title");
    expect(frame).not.toContain("invalid.example");
    expect(frame).not.toContain("discarded-device-command");
    expect(maliciousTask.title).toBe(dangerousTitle);
  });
});
