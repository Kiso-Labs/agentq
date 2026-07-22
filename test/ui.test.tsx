import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import type { AddTaskInput, Queue, Run, Task, TaskEvent } from "../src/core/types.ts";
import { AgentqApp } from "../src/ui/app.tsx";
import { sanitizeTerminalText } from "../src/ui/sanitize.ts";
import type { UiController, UiTaskPatch } from "../src/ui/types.ts";

const NOW = "2026-07-21T12:00:00.000Z";

const queue = (overrides: Partial<Queue> = {}): Queue => ({
  id: "queue-main",
  name: "main",
  repoKey: "/code/agentq/.git",
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

const run = (overrides: Partial<Run> = {}): Run => ({
  id: "run-1",
  taskId: "task-1",
  attemptNo: 1,
  provider: "codex",
  status: "failed",
  taskSnapshot: {
    title: "Original task specification",
    instructions: "Original instructions",
    acceptanceCriteria: ["Original criterion"],
    provider: "codex",
    priority: 4,
  },
  startedAt: NOW,
  heartbeatAt: NOW,
  finishedAt: NOW,
  worktreePath: "/code/agentq-worktree",
  summary: "Attempt did not pass verification",
  ...overrides,
});

const createController = (overrides: Partial<UiController> = {}): UiController => {
  const controller: UiController = {
    listQueues: mock(async () => [queue()]),
    listTasks: mock(async () => [task()]),
    listRuns: mock(async () => []),
    listEvents: mock(async () => [event()]),
    createQueue: mock(async (input) =>
      queue({
        name: input.name,
        repoPath: input.repoPath,
        baseRef: input.baseRef ?? "main",
        defaultProvider: input.defaultProvider ?? "codex",
      }),
    ),
    updateQueue: mock(async (_queueId, patch) => queue(patch)),
    deleteQueue: mock(async () => undefined),
    addTask: mock(async (input: AddTaskInput) => task({ title: input.title })),
    editTask: mock(async (_taskId: string, patch: UiTaskPatch) => task(patch)),
    cancelTask: mock(async () => undefined),
    retryTask: mock(async () => undefined),
    resumeTask: mock(async () => undefined),
    completeManualTask: mock(async () => undefined),
    cleanTask: mock(async (taskId) => ({ taskId, removedWorktree: "/tmp/worktree" })),
    doctor: mock(async () => []),
    loginProvider: mock(async () => undefined),
    installIntegration: mock(async (target) => [
      { file: target === "claude" ? "CLAUDE.md" : "AGENTS.md", action: "created" as const },
    ]),
    uiContext: () => ({
      label: "agentq · /code/agentq",
      repositoryPath: "/code/agentq",
      all: false,
      canToggle: true,
    }),
    setAllRepositories: mock(() => undefined),
  };
  return Object.assign(controller, overrides);
};

const settle = async () => {
  await Bun.sleep(80);
};

const waitForFrame = async (
  frame: () => string | undefined,
  expected: string,
  timeoutMs = 2_000,
): Promise<string> => {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const current = frame() ?? "";
    if (current.includes(expected)) return current;
    if (performance.now() >= deadline) {
      throw new Error(`Timed out waiting for frame text: ${expected}\n\n${current}`);
    }
    await Bun.sleep(10);
  }
};

const expectLargeFormField = (
  frame: string,
  title: string,
  label: string,
  position: number,
  total: number,
): void => {
  expect(frame).toContain(title);
  expect(frame).toContain(`FIELD ${position}/${total}`);
  expect(frame).toContain(label);
  expect(frame).toContain("Showing ");
  expect(frame).toContain("hidden");
  expect(frame).toContain("╭");
  expect(frame).toContain("╰");
  expect(frame).not.toMatch(/[●○]/u);
};

const expectTallFormField = (frame: string, label: string): void => {
  const lines = frame.split("\n");
  const labelLine = lines.findIndex((line) => line.trim() === label);
  expect(labelLine).toBeGreaterThanOrEqual(0);
  expect(lines[labelLine + 1]).toContain("╭");
  expect(lines[labelLine + 2]).toContain("│");
  expect(lines[labelLine + 3]).toContain("│");
  expect(lines[labelLine + 4]).toContain("│");
  expect(lines[labelLine + 5]).toContain("╰");
};

afterEach(() => {
  cleanup();
});

describe("AgentqApp", () => {
  test("renders a branded dashboard with queue, task, details, and live activity", async () => {
    const controller = createController({
      listEvents: mock(async () => {
        await Bun.sleep(120);
        return [event()];
      }),
    });
    const view = render(
      <AgentqApp controller={controller} dimensions={{ columns: 128, rows: 30 }} />,
    );

    expect(view.lastFrame()).toContain("Loading workspace");
    const frame = await waitForFrame(view.lastFrame, "Running the focused regression test");
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

  test("disambiguates same-named queues across repositories and shows queue configuration", async () => {
    const view = render(
      <AgentqApp
        controller={createController({
          listQueues: mock(async () => [
            queue({ id: "queue-a", name: "app", repoPath: "/repos/alpha", baseRef: "release" }),
            queue({ id: "queue-b", name: "app", repoPath: "/repos/beta" }),
          ]),
          listTasks: mock(async () => []),
          uiContext: () => ({
            label: "all repositories",
            all: true,
            canToggle: true,
          }),
        })}
        dimensions={{ columns: 128, rows: 28 }}
      />,
    );
    await settle();

    const frame = view.lastFrame() ?? "";
    expect(frame.match(/app/g)?.length).toBeGreaterThanOrEqual(2);
    expect(frame).toContain("/repos/alpha");
    expect(frame).toContain("/repos/beta");
    expect(frame).toContain("Base: release");
    expect(frame).toContain("Provider: codex");
    expect(frame).toContain("Concurrency: 3");
    expect(frame).toContain("Auto-commit: on");
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

  test("supports direct pane focus and j/k selection aliases", async () => {
    const second = task({ id: "task-2", title: "Second keyboard task", status: "queued" });
    const view = render(
      <AgentqApp
        controller={createController({ listTasks: mock(async () => [task(), second]) })}
        dimensions={{ columns: 60, rows: 22 }}
      />,
    );
    await settle();

    view.stdin.write("2");
    await settle();
    expect(view.lastFrame()).toContain("TASKS");
    expect(view.lastFrame()).not.toContain("QUEUES");

    view.stdin.write("j");
    await settle();
    view.stdin.write("3");
    await settle();
    expect(view.lastFrame()).toContain("Second keyboard task");
    expect(view.lastFrame()).toContain("DETAILS / LIVE");

    view.stdin.write("1");
    await settle();
    expect(view.lastFrame()).toContain("QUEUES");
  });

  test("does not let a slow log request overwrite the newly selected task", async () => {
    const second = task({ id: "task-2", title: "Current keyboard task", status: "queued" });
    const view = render(
      <AgentqApp
        controller={createController({
          listTasks: mock(async () => [task(), second]),
          listEvents: mock(async (taskId) => {
            if (taskId === "task-1") {
              await Bun.sleep(180);
              return [event({ payload: { text: "Stale first-task output" } })];
            }
            await Bun.sleep(10);
            return [
              event({
                id: 2,
                taskId: "task-2",
                payload: { text: "Current second-task output" },
              }),
            ];
          }),
        })}
        dimensions={{ columns: 128, rows: 28 }}
      />,
    );
    await settle();

    view.stdin.write("2");
    await settle();
    view.stdin.write("j");
    await waitForFrame(view.lastFrame, "Current second-task output");
    await Bun.sleep(160);

    expect(view.lastFrame()).toContain("Current second-task output");
    expect(view.lastFrame()).not.toContain("Stale first-task output");
  });

  test("shows contextual keyboard help and closes it without acting on dashboard keys", async () => {
    const onExit = mock(() => undefined);
    const view = render(
      <AgentqApp
        controller={createController()}
        dimensions={{ columns: 90, rows: 24 }}
        onExit={onExit}
      />,
    );
    await settle();

    view.stdin.write("?");
    await settle();
    const help = view.lastFrame() ?? "";
    expect(help).toContain("KEYBOARD HELP");
    expect(help).toContain("1 / 2 / 3");
    expect(help).toContain("j / k");
    expect(help).toContain("[ / ]");
    expect(help).toContain("z");

    view.stdin.write("q");
    await settle();
    expect(onExit).not.toHaveBeenCalled();
    expect(view.lastFrame()).toContain("KEYBOARD HELP");

    view.stdin.write("?");
    await settle();
    expect(view.lastFrame()).not.toContain("KEYBOARD HELP");
  });

  test("resizes, resets, and zooms the focused pane without collapsing its siblings", async () => {
    const view = render(
      <AgentqApp controller={createController()} dimensions={{ columns: 128, rows: 30 }} />,
    );
    await settle();

    view.stdin.write("2");
    await settle();
    view.stdin.write("]");
    await settle();
    expect(view.lastFrame()).toContain("tasks pane enlarged");

    for (let index = 0; index < 24; index += 1) view.stdin.write("]");
    await settle();
    expect(view.lastFrame()).toContain("QUEUES");
    expect(view.lastFrame()).toContain("TASKS");
    expect(view.lastFrame()).toContain("DETAILS / LIVE");

    view.stdin.write("[");
    await settle();
    expect(view.lastFrame()).toContain("tasks pane reduced");

    view.stdin.write("0");
    await settle();
    expect(view.lastFrame()).toContain("Layout reset");

    view.stdin.write("z");
    await settle();
    expect(view.lastFrame()).toContain("TASKS");
    expect(view.lastFrame()).not.toContain("QUEUES");
    expect(view.lastFrame()).not.toContain("DETAILS / LIVE");

    view.stdin.write("z");
    await settle();
    expect(view.lastFrame()).toContain("QUEUES");
    expect(view.lastFrame()).toContain("DETAILS / LIVE");
  });

  test("adds a task with every manual task field", async () => {
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
    view.stdin.write("\t");
    await settle();
    view.stdin.write("\u0015");
    view.stdin.write("5");
    await settle();
    view.stdin.write("\t");
    await settle();
    view.stdin.write("Tests pass; Output reconnects");
    await settle();
    view.stdin.write("\t");
    await settle();
    view.stdin.write("manual-queue-view");
    await settle();
    view.stdin.write("\r");
    await settle();

    expect(addTask).toHaveBeenCalledTimes(1);
    expect(addTask.mock.calls[0]?.[0]).toEqual({
      queue: "queue-main",
      provider: "claude",
      title: "Build a durable queue view",
      instructions: "Show reconnect-safe live output",
      acceptanceCriteria: ["Tests pass", "Output reconnects"],
      priority: 5,
      idempotencyKey: "manual-queue-view",
      sourceKind: "manual",
    });
    expect(view.lastFrame()).toContain("Added task-new");
  });

  test("keeps an add-task draft pinned to its queue when a refresh reorders queues", async () => {
    const original = queue({ id: "queue-original", name: "original" });
    const other = queue({ id: "queue-other", name: "other" });
    let queues = [original, other];
    let notify = () => {};
    const addTask = mock(async (input: AddTaskInput) =>
      task({ id: "task-new", queueId: input.queue, title: input.title }),
    );
    const controller = createController({
      listQueues: mock(async () => queues),
      listTasks: mock(async () => []),
      addTask,
      subscribe: (listener) => {
        notify = listener;
        return () => {};
      },
    });
    const view = render(
      <AgentqApp controller={controller} dimensions={{ columns: 90, rows: 28 }} />,
    );
    await settle();

    view.stdin.write("a");
    await settle();
    expect(view.lastFrame()).toContain("original");

    queues = [other, original];
    notify();
    await settle();
    expect(view.lastFrame()).toContain("original");
    expect(view.lastFrame()).not.toContain("other");

    view.stdin.write("\t");
    view.stdin.write("\t");
    await settle();
    view.stdin.write("Keep the queue identity stable");
    await settle();
    view.stdin.write("\u0013");
    await waitForFrame(view.lastFrame, "Added task-new");

    expect(addTask).toHaveBeenCalledTimes(1);
    expect(addTask.mock.calls[0]?.[0].queue).toBe(original.id);
  });

  test("refuses to add a task when its pinned queue disappears", async () => {
    const original = queue({ id: "queue-original", name: "original" });
    const other = queue({ id: "queue-other", name: "other" });
    let queues = [original, other];
    let notify = () => {};
    const addTask = mock(async (input: AddTaskInput) =>
      task({ id: "task-new", queueId: input.queue, title: input.title }),
    );
    const controller = createController({
      listQueues: mock(async () => queues),
      listTasks: mock(async () => []),
      addTask,
      subscribe: (listener) => {
        notify = listener;
        return () => {};
      },
    });
    const view = render(
      <AgentqApp controller={controller} dimensions={{ columns: 90, rows: 28 }} />,
    );
    await settle();

    view.stdin.write("a");
    await settle();
    queues = [other];
    notify();
    await settle();

    expect(view.lastFrame()).toContain("Queue unavailable (removed)");
    view.stdin.write("\t");
    view.stdin.write("\t");
    await settle();
    view.stdin.write("Do not retarget this task");
    await settle();
    view.stdin.write("\u0013");
    await settle();

    expect(addTask).not.toHaveBeenCalled();
    expect(view.lastFrame()).toContain("Selected queue is no longer available.");
  });

  test("submits a form only once when the save shortcut is repeated", async () => {
    const addTask = mock(async (input: AddTaskInput) => {
      await Bun.sleep(100);
      return task({ id: "task-new", title: input.title });
    });
    const view = render(
      <AgentqApp
        controller={createController({ addTask })}
        dimensions={{ columns: 90, rows: 28 }}
      />,
    );
    await settle();

    view.stdin.write("a");
    await settle();
    view.stdin.write("\t");
    view.stdin.write("\t");
    await settle();
    view.stdin.write("One durable submission");
    await settle();
    view.stdin.write("\u0013");
    view.stdin.write("\u0013");
    await Bun.sleep(180);

    expect(addTask).toHaveBeenCalledTimes(1);
    expect(view.lastFrame()).toContain("Added task-new");
  });

  test("creates a queue with the complete repository and execution policy", async () => {
    const createQueue = mock(async (input: Parameters<UiController["createQueue"]>[0]) =>
      queue({
        id: "queue-created",
        name: input.name,
        repoPath: input.repoPath,
        baseRef: input.baseRef ?? "main",
        defaultProvider: input.defaultProvider ?? "codex",
        concurrency: input.concurrency ?? 1,
        maxAttempts: input.maxAttempts ?? 1,
        verifyCommands: input.verifyCommands ?? [],
        autoCommit: input.autoCommit ?? false,
      }),
    );
    const view = render(
      <AgentqApp
        controller={createController({ createQueue })}
        dimensions={{ columns: 100, rows: 28 }}
      />,
    );
    await settle();

    view.stdin.write("n");
    await settle();
    expect(view.lastFrame()).toContain("CREATE QUEUE");
    expect(view.lastFrame()).toContain("FIELD 1/8");
    expect(view.lastFrame()).toContain("↓ 2 hidden");

    view.stdin.write("shipping");
    await settle();
    view.stdin.write("\t");
    await settle();
    view.stdin.write("\u0015");
    await settle();
    view.stdin.write("/code/shipping");
    await settle();
    view.stdin.write("\t");
    await settle();
    view.stdin.write("main");
    await settle();
    view.stdin.write("\t");
    await settle();
    view.stdin.write("\u001B[C");
    await settle();
    view.stdin.write("\t");
    await settle();
    view.stdin.write("\u0015");
    await settle();
    view.stdin.write("4");
    await settle();
    view.stdin.write("\t");
    await settle();
    view.stdin.write("\u0015");
    await settle();
    view.stdin.write("3");
    await settle();
    view.stdin.write("\t");
    await settle();
    view.stdin.write("bun test; bun run typecheck");
    await settle();
    view.stdin.write("\t");
    await settle();
    view.stdin.write(" ");
    await settle();
    view.stdin.write("\r");
    await settle();

    expect(createQueue).toHaveBeenCalledWith({
      name: "shipping",
      repoPath: "/code/shipping",
      baseRef: "main",
      defaultProvider: "claude",
      concurrency: 4,
      maxAttempts: 3,
      verifyCommands: ["bun test", "bun run typecheck"],
      autoCommit: false,
    });
    expect(view.lastFrame()).toContain("Created queue shipping");
  });

  test("contextually edits and confirms removal of the selected queue", async () => {
    const updateQueue = mock(
      async (_queueId: string, patch: Parameters<UiController["updateQueue"]>[1]) =>
        queue({ ...patch, name: patch.name ?? "main" }),
    );
    const deleteQueue = mock(async () => undefined);
    const view = render(
      <AgentqApp
        controller={createController({ updateQueue, deleteQueue })}
        dimensions={{ columns: 90, rows: 26 }}
      />,
    );
    await settle();

    view.stdin.write("e");
    await settle();
    expect(view.lastFrame()).toContain("EDIT QUEUE");
    expect(view.lastFrame()).toContain("Repository (read-only)");
    view.stdin.write("\u0015");
    await settle();
    view.stdin.write("release");
    await settle();
    view.stdin.write("\u0013");
    await settle();
    expect(updateQueue).toHaveBeenCalledWith(
      "queue-main",
      expect.objectContaining({ name: "release", baseRef: "main", concurrency: 3 }),
    );

    view.stdin.write("x");
    await settle();
    expect(view.lastFrame()).toContain("REMOVE QUEUE?");
    expect(deleteQueue).not.toHaveBeenCalled();
    view.stdin.write("n");
    await settle();
    view.stdin.write("x");
    await settle();
    view.stdin.write("y");
    await settle();
    expect(deleteQueue).toHaveBeenCalledWith("queue-main");
    expect(view.lastFrame()).toContain("Removed queue main");
  });

  test("edits every user-controlled task field with optimistic concurrency", async () => {
    let current = task({
      status: "failed",
      title: "Old title",
      instructions: "Old instructions",
      acceptanceCriteria: ["Old criterion"],
      provider: "codex",
      priority: 1,
    });
    const editTask = mock(
      async (_taskId: string, patch: UiTaskPatch, _expectedUpdatedAt: string) => {
        current = task({ ...current, ...patch, updatedAt: "2026-07-21T12:01:00.000Z" });
        return current;
      },
    );
    const view = render(
      <AgentqApp
        controller={createController({
          listTasks: mock(async () => [current]),
          editTask,
        })}
        dimensions={{ columns: 100, rows: 28 }}
      />,
    );
    await settle();

    view.stdin.write("2");
    await settle();
    view.stdin.write("e");
    await settle();
    expect(view.lastFrame()).toContain("EDIT TASK");
    expect(view.lastFrame()).toContain("Acceptance criteria");

    view.stdin.write("\u001B[C");
    await settle();
    view.stdin.write("\t");
    await settle();
    view.stdin.write("\u0015");
    view.stdin.write("7");
    await settle();
    view.stdin.write("\t");
    await settle();
    view.stdin.write("\u0015");
    view.stdin.write("Fix the redirect race");
    await settle();
    view.stdin.write("\t");
    await settle();
    view.stdin.write("\u0015");
    view.stdin.write("Update the guard and cover the race");
    await settle();
    view.stdin.write("\t");
    await settle();
    view.stdin.write("\u0015");
    view.stdin.write("Redirects once; Regression covered");
    await settle();
    view.stdin.write("\r");
    await settle();

    expect(editTask).toHaveBeenCalledTimes(1);
    expect(editTask.mock.calls[0]).toEqual([
      "task-1",
      {
        title: "Fix the redirect race",
        instructions: "Update the guard and cover the race",
        acceptanceCriteria: ["Redirects once", "Regression covered"],
        provider: "claude",
        priority: 7,
      },
      NOW,
    ]);
    expect(view.lastFrame()).toContain("Updated task-1");
  });

  test("opens editing only for editable task states and explains locked states", async () => {
    for (const status of ["queued", "failed", "interrupted", "cancelled"] as const) {
      const view = render(
        <AgentqApp
          controller={createController({ listTasks: mock(async () => [task({ status })]) })}
          dimensions={{ columns: 80, rows: 24 }}
        />,
      );
      await settle();
      view.stdin.write("2");
      await settle();
      view.stdin.write("e");
      await settle();
      expect(view.lastFrame()).toContain("EDIT TASK");
      view.unmount();
    }

    for (const status of ["starting", "running", "cancelling", "succeeded"] as const) {
      const editTask = mock(async (_id: string, patch: UiTaskPatch) => task(patch));
      const view = render(
        <AgentqApp
          controller={createController({
            listTasks: mock(async () => [task({ status })]),
            editTask,
          })}
          dimensions={{ columns: 80, rows: 24 }}
        />,
      );
      await settle();
      view.stdin.write("2");
      await settle();
      view.stdin.write("e");
      await settle();
      expect(view.lastFrame()).toContain(`${status} and locked`);
      expect(editTask).not.toHaveBeenCalled();
      view.unmount();
    }
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

  test("keeps destructive confirmations bound to the task the user reviewed", async () => {
    let current = task({ id: "task-original", title: "Original selected task" });
    const cancelTask = mock(async () => undefined);
    const view = render(
      <AgentqApp
        controller={createController({
          listTasks: mock(async () => [current]),
          cancelTask,
        })}
        dimensions={{ columns: 90, rows: 24 }}
        pollIntervalMs={20}
      />,
    );
    await settle();

    view.stdin.write("c");
    await settle();
    expect(view.lastFrame()).toContain("Original selected task");

    current = task({ id: "task-replacement", title: "Replacement selected task" });
    await Bun.sleep(80);
    view.stdin.write("y");
    await settle();

    expect(cancelTask).toHaveBeenCalledWith("task-original");
    expect(cancelTask).not.toHaveBeenCalledWith("task-replacement");
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
    await waitForFrame(view.lastFrame, "[FAILED]");
    await settle();

    view.stdin.write("r");
    await waitForFrame(view.lastFrame, "RETRY TASK?");
    await settle();
    expect(retryTask).not.toHaveBeenCalled();

    view.stdin.write("\r");
    await waitForFrame(view.lastFrame, "Retry queued for task-1");
    await settle();
    expect(retryTask).toHaveBeenCalledWith("task-1");

    view.stdin.write("d");
    await waitForFrame(view.lastFrame, "Marked task-1 complete");
    expect(completeManualTask).toHaveBeenCalledWith("task-1");
  }, 15_000);

  test("resumes tasks, shows immutable attempt specs, and offers safe or force cleanup", async () => {
    const resumeTask = mock(async () => undefined);
    const listRuns = mock(async () => [run()]);
    const cleanTask = mock(async (taskId: string, options?: { force?: boolean }) => ({
      taskId,
      removedWorktree: options?.force ? "/tmp/forced-worktree" : "/tmp/safe-worktree",
    }));
    const view = render(
      <AgentqApp
        controller={createController({
          listTasks: mock(async () => [task({ status: "failed" })]),
          resumeTask,
          listRuns,
          cleanTask,
        })}
        dimensions={{ columns: 110, rows: 30 }}
      />,
    );
    await waitForFrame(view.lastFrame, "[FAILED]");
    await settle();

    view.stdin.write("s");
    await waitForFrame(view.lastFrame, "Resume queued for task-1");
    await settle();
    expect(resumeTask).toHaveBeenCalledWith("task-1");

    view.stdin.write("v");
    await waitForFrame(view.lastFrame, "ATTEMPTS");
    await settle();
    expect(listRuns).toHaveBeenCalledWith("task-1");
    expect(view.lastFrame()).toContain("Original task specification");
    expect(view.lastFrame()).toContain("codex · priority 4");
    view.stdin.write("\u001B");
    await settle();

    view.stdin.write("2");
    await settle();
    view.stdin.write("x");
    await settle();
    expect(view.lastFrame()).toContain("CLEAN WORKTREE?");
    expect(view.lastFrame()).toContain("SAFE");
    view.stdin.write("f");
    await settle();
    expect(view.lastFrame()).toContain("FORCE");
    view.stdin.write("y");
    await settle();
    expect(cleanTask).toHaveBeenCalledWith("task-1", { force: true });
    expect(view.lastFrame()).toContain("Removed worktree /tmp/forced-worktree");
  });

  test("requires queued tasks to be cancelled before worktree cleanup", async () => {
    const cleanTask = mock(async (taskId: string) => ({
      taskId,
      removedWorktree: "/tmp/worktree",
    }));
    const view = render(
      <AgentqApp
        controller={createController({
          listTasks: mock(async () => [task({ status: "queued" })]),
          cleanTask,
        })}
        dimensions={{ columns: 90, rows: 24 }}
      />,
    );
    await settle();
    view.stdin.write("2");
    await settle();
    view.stdin.write("x");
    await settle();

    expect(view.lastFrame()).toContain("Cancel or finish the task before cleaning");
    expect(view.lastFrame()).not.toContain("CLEAN WORKTREE?");
    expect(cleanTask).not.toHaveBeenCalled();
  });

  test("filters task status and toggles between local and all repository scopes", async () => {
    let all = false;
    const setAllRepositories = mock((next: boolean) => {
      all = next;
    });
    const view = render(
      <AgentqApp
        controller={createController({
          listTasks: mock(async () => [
            task({ id: "task-running", title: "Running item", status: "running" }),
            task({ id: "task-queued", title: "Queued item", status: "queued" }),
          ]),
          uiContext: () => ({
            label: all ? "all repositories" : "agentq · /code/agentq",
            repositoryPath: "/code/agentq",
            all,
            canToggle: true,
          }),
          setAllRepositories,
        })}
        dimensions={{ columns: 120, rows: 28 }}
      />,
    );
    await settle();

    view.stdin.write("f");
    await settle();
    expect(view.lastFrame()).toContain("QUEUED");
    expect(view.lastFrame()).toContain("Queued item");
    expect(view.lastFrame()).not.toContain("Running item");

    view.stdin.write("g");
    await settle();
    expect(setAllRepositories).toHaveBeenCalledWith(true);
    expect(view.lastFrame()).toContain("all repositories");
    expect(view.lastFrame()).toContain("Showing all repositories");
  });

  test("exposes the complete action center and runs doctor plus suspended provider login", async () => {
    const doctor = mock(async () => [
      { name: "Codex CLI", ok: true, detail: "codex 0.145.0" },
      { name: "Claude authentication", ok: false, detail: "Not authenticated" },
    ]);
    const loginProvider = mock(async () => undefined);
    const view = render(
      <AgentqApp
        controller={createController({ doctor, loginProvider })}
        dimensions={{ columns: 120, rows: 42 }}
      />,
    );
    await settle();

    view.stdin.write(":");
    await settle();
    const actions = view.lastFrame() ?? "";
    expect(actions).toContain("ACTION CENTER");
    expect(actions).toContain("Create queue");
    expect(actions).toContain("Resume selected task");
    expect(actions).toContain("Integrate both providers");
    expect(actions).toContain("Doctor & providers");

    for (let index = 0; index < 12; index += 1) {
      view.stdin.write("\u001B[B");
      await Bun.sleep(5);
    }
    view.stdin.write("\r");
    await settle();
    expect(view.lastFrame()).toContain("DOCTOR / PROVIDERS");
    expect(view.lastFrame()).toContain("codex 0.145.0");

    view.stdin.write("c");
    await settle();
    expect(loginProvider).toHaveBeenCalledWith("codex");
    expect(doctor).toHaveBeenCalledTimes(2);
    expect(view.lastFrame()).toContain("Codex login finished");
  });

  test("confirms integrations, uses the selected queue repository in all mode, and reports results", async () => {
    let currentQueue = queue({ repoPath: "/code/selected" });
    const installIntegration = mock(async () => [
      { file: "/code/selected/AGENTS.md", action: "created" as const },
      { file: "/code/selected/CLAUDE.md", action: "updated" as const },
    ]);
    const view = render(
      <AgentqApp
        controller={createController({
          listQueues: mock(async () => [currentQueue]),
          uiContext: () => ({
            label: "all repositories",
            repositoryPath: "/code/launch",
            all: true,
            canToggle: true,
          }),
          installIntegration,
        })}
        dimensions={{ columns: 120, rows: 42 }}
        pollIntervalMs={20}
      />,
    );
    await settle();

    view.stdin.write(":");
    await settle();
    for (let index = 0; index < 17; index += 1) {
      view.stdin.write("\u001B[B");
      await Bun.sleep(5);
    }
    view.stdin.write("\r");
    await settle();
    expect(view.lastFrame()).toContain("INSTALL INTEGRATION?");
    expect(view.lastFrame()).toContain("/code/selected");
    expect(installIntegration).not.toHaveBeenCalled();
    currentQueue = queue({
      id: "queue-replacement",
      name: "replacement",
      repoPath: "/code/replacement",
    });
    await Bun.sleep(80);
    view.stdin.write("y");
    await settle();

    expect(installIntegration).toHaveBeenCalledWith("all", "/code/selected");
    expect(view.lastFrame()).toContain("INTEGRATION COMPLETE");
    expect(view.lastFrame()).toContain("AGENTS.md · created");
    expect(view.lastFrame()).toContain("CLAUDE.md · updated");
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
          uiContext: () => ({
            label: "checkout-api",
            repositoryPath: "/code/checkout-api",
            all: false,
            canToggle: true,
          }),
        })}
        dimensions={{ columns: 120, rows: 24 }}
        scopeLabel="checkout-api"
      />,
    );
    await settle();
    expect(empty.lastFrame()).toContain("checkout-api");
    expect(empty.lastFrame()).toContain("No queues for this");
    expect(empty.lastFrame()).toContain("repository");
    expect(empty.lastFrame()).toContain("Press n to create");
    expect(empty.lastFrame()).toContain("<name>");
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

  test("uses the real terminal dimensions instead of inflating a small viewport", async () => {
    const view = render(
      <AgentqApp
        controller={createController()}
        dimensions={{ columns: 32, rows: 12 }}
        scopeLabel="tiny-repo"
      />,
    );
    await settle();

    const lines = (view.lastFrame() ?? "").split("\n");
    expect(lines.length).toBeLessThanOrEqual(12);
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(32);
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
    await waitForFrame(subscribed.lastFrame, "Updated by another process");
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
    await waitForFrame(polling.lastFrame, "Updated by polling");
  });

  test("scrolls the large add-task fields with focus in a narrow terminal", async () => {
    const view = render(
      <AgentqApp controller={createController()} dimensions={{ columns: 44, rows: 16 }} />,
    );
    await settle();
    view.stdin.write("a");
    await settle();
    expect(view.lastFrame()).not.toContain("main▏");
    expect(view.lastFrame()).toContain("←→ choose");

    const fields = [
      "Queue",
      "Provider",
      "Title",
      "Instructions",
      "Priority",
      "Acceptance",
      "Idempotency key",
    ];
    for (const [index, label] of fields.entries()) {
      const frame = view.lastFrame() ?? "";
      expectLargeFormField(frame, "ADD TASK", label, index + 1, fields.length);
      expect(frame).toContain("hidden");
      if (label === "Instructions" || label === "Acceptance") {
        expectTallFormField(frame, label);
      }
      if (index < fields.length - 1) {
        view.stdin.write("\t");
        await settle();
      }
    }
    expect(view.lastFrame()).toContain("esc cancel");
    expect(view.lastFrame()).toContain("ctrl+s submit");
  });

  test("scrolls the large edit-task fields with focus and keeps multiline fields tall", async () => {
    const view = render(
      <AgentqApp
        controller={createController({
          listTasks: mock(async () => [task({ status: "failed" })]),
        })}
        dimensions={{ columns: 72, rows: 16 }}
      />,
    );
    await settle();
    view.stdin.write("2");
    await settle();
    view.stdin.write("e");
    await settle();

    const fields = ["Provider", "Priority", "Title", "Instructions", "Acceptance criteria"];
    for (const [index, label] of fields.entries()) {
      const frame = view.lastFrame() ?? "";
      expectLargeFormField(frame, "EDIT TASK", label, index + 1, fields.length);
      if (label === "Instructions" || label === "Acceptance criteria") {
        expectTallFormField(frame, label);
      }
      if (index < fields.length - 1) {
        view.stdin.write("\t");
        await settle();
      }
    }
    expect(view.lastFrame()).toContain("ctrl+s save");
    expect(view.lastFrame()).toContain("esc cancel");
  });

  test("keeps the input tail and primary actions visible while typing long task text", async () => {
    const view = render(
      <AgentqApp controller={createController()} dimensions={{ columns: 44, rows: 16 }} />,
    );
    await settle();
    view.stdin.write("a");
    await settle();

    view.stdin.write("\t");
    await settle();
    view.stdin.write("\t");
    await settle();
    view.stdin.write(`${"title-".repeat(20)}TITLETAIL`);
    await settle();
    expect(view.lastFrame()).toContain("TITLETAIL");

    view.stdin.write("\u0015");
    await settle();
    view.stdin.write(`${"界".repeat(27)}UNICODETAIL`);
    await settle();
    expect(view.lastFrame()).toContain("UNICODETAIL");

    view.stdin.write("\t");
    await settle();
    view.stdin.write(`${"instruction-".repeat(30)}INSTRUCTIONTAIL`);
    await settle();
    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("INSTRUCTIONTAIL");
    expect(frame).toContain("ctrl+s submit");
    expect(frame).toContain("esc cancel");
  });

  test("scrolls the large create-queue fields with focus", async () => {
    const view = render(
      <AgentqApp controller={createController()} dimensions={{ columns: 72, rows: 18 }} />,
    );
    await settle();
    view.stdin.write("n");
    await settle();

    const fields = [
      "Name",
      "Repository",
      "Base ref",
      "Provider",
      "Concurrency",
      "Max attempts",
      "Verify commands",
      "Auto-commit",
    ];
    for (const [index, label] of fields.entries()) {
      const frame = view.lastFrame() ?? "";
      expectLargeFormField(frame, "CREATE QUEUE", label, index + 1, fields.length);
      if (label === "Verify commands") expectTallFormField(frame, label);
      if (index < fields.length - 1) {
        view.stdin.write("\t");
        await settle();
      }
    }
    expect(view.lastFrame()).toContain("ctrl+s save");
    expect(view.lastFrame()).toContain("esc cancel");
  });

  test("scrolls every editable queue field and presents repository as a bordered read-only field", async () => {
    const view = render(
      <AgentqApp controller={createController()} dimensions={{ columns: 72, rows: 18 }} />,
    );
    await settle();
    view.stdin.write("e");
    await settle();

    expect(view.lastFrame()).toContain("Repository (read-only)");
    const fields = [
      "Name",
      "Base ref",
      "Provider",
      "Concurrency",
      "Max attempts",
      "Verify commands",
      "Auto-commit",
    ];
    for (const [index, label] of fields.entries()) {
      const frame = view.lastFrame() ?? "";
      expectLargeFormField(frame, "EDIT QUEUE", label, index + 1, fields.length);
      if (label === "Verify commands") expectTallFormField(frame, label);
      if (index < fields.length - 1) {
        view.stdin.write("\t");
        await settle();
      }
    }
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
    const frame = await waitForFrame(view.lastFrame, "Agent output");

    expect(sanitizeTerminalText(dangerousTitle)).toBe("Visible red next");
    expect(sanitizeTerminalText(dangerousEvent)).toBe("Agent output");
    expect(frame).toContain("Visible red next");
    expect(frame).toContain("safe instructions");
    expect(frame).toContain("Agent output");
    expect(frame).not.toContain("hijacked-title");
    expect(frame).not.toContain("invalid.example");
    expect(frame).not.toContain("discarded-device-command");
    expect(maliciousTask.title).toBe(dangerousTitle);
  });
});
