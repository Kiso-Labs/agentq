import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  canCancelTask,
  canCompleteTaskManually,
  canRetryTask,
  isTaskActive,
  isTaskTerminal,
  PROVIDERS,
  type Queue,
  type Task,
  type TaskEvent,
} from "../core/types.ts";
import { sanitizeTerminalText } from "./sanitize.ts";
import type { AgentqAppProps } from "./types.ts";

type FocusPane = "queues" | "tasks" | "details";
type ScreenMode = "dashboard" | "add" | "confirm-cancel" | "confirm-retry";

interface Snapshot {
  queues: Queue[];
  tasks: Task[];
}

interface AddDraft {
  queueIndex: number;
  providerIndex: number;
  title: string;
  instructions: string;
  field: 0 | 1 | 2 | 3;
  error?: string;
}

const STATUS_LABEL: Record<Task["status"], string> = {
  queued: "QUEUED",
  starting: "START",
  running: "RUN",
  cancelling: "STOPPING",
  succeeded: "DONE",
  failed: "FAILED",
  interrupted: "LOST",
  cancelled: "CANCELLED",
};

const STATUS_COLOR: Record<Task["status"], string> = {
  queued: "blue",
  starting: "cyan",
  running: "green",
  cancelling: "yellow",
  succeeded: "green",
  failed: "red",
  interrupted: "magenta",
  cancelled: "gray",
};

const FOCUS_ORDER: FocusPane[] = ["queues", "tasks", "details"];

interface WindowedItems<T> {
  items: T[];
  start: number;
  end: number;
}

const windowItems = <T,>(items: T[], selectedIndex: number, capacity: number): WindowedItems<T> => {
  const size = Math.max(1, Math.min(items.length, Math.floor(capacity)));
  if (items.length <= size) return { items, start: 0, end: items.length };

  const safeIndex = Math.max(0, Math.min(items.length - 1, selectedIndex));
  const start = Math.max(0, Math.min(items.length - size, safeIndex - Math.floor(size / 2)));
  return { items: items.slice(start, start + size), start, end: start + size };
};

const messageFrom = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return String(error);
};

const eventText = (event: TaskEvent): string => {
  const text = event.payload.text ?? event.payload.message ?? event.payload.detail;
  if (typeof text === "string" && text.length > 0) return sanitizeTerminalText(text);

  const name = typeof event.payload.name === "string" ? event.payload.name : undefined;
  const state = typeof event.payload.state === "string" ? event.payload.state : undefined;
  if (name) {
    return sanitizeTerminalText(state ? `${name} · ${state}` : name);
  }

  const keys = Object.keys(event.payload);
  if (keys.length === 0) return sanitizeTerminalText(event.kind);
  return sanitizeTerminalText(JSON.stringify(event.payload));
};

const nextIndex = (current: number, length: number, delta: number): number => {
  if (length === 0) return 0;
  return (current + delta + length) % length;
};

function StatusBadge({ status }: { status: Task["status"] }) {
  return (
    <Text bold color={STATUS_COLOR[status]}>
      [{STATUS_LABEL[status]}]
    </Text>
  );
}

interface PanelProps {
  title: string;
  active: boolean;
  children: React.ReactNode;
  width?: number | string;
  height?: number | string;
  flexGrow?: number;
}

function Panel({ title, active, children, width, height, flexGrow }: PanelProps) {
  return (
    <Box
      borderStyle="round"
      borderColor={active ? "cyan" : "gray"}
      flexDirection="column"
      flexGrow={flexGrow}
      height={height}
      overflow="hidden"
      paddingX={1}
      width={width}
    >
      <Text bold color={active ? "cyan" : "white"}>
        {active ? "● " : "  "}
        {title}
      </Text>
      {children}
    </Box>
  );
}

function Header({ tasks, focus, narrow }: { tasks: Task[]; focus: FocusPane; narrow: boolean }) {
  const running = tasks.filter((task) => isTaskActive(task.status)).length;
  const queued = tasks.filter((task) => task.status === "queued").length;
  const failed = tasks.filter(
    (task) => task.status === "failed" || task.status === "interrupted",
  ).length;

  if (narrow) {
    return (
      <Box height={3} paddingX={1} flexDirection="column">
        <Box justifyContent="space-between">
          <Text bold color="cyan">
            ◆ AGENTQ
          </Text>
          <Text dimColor>
            {running} run · {queued} wait · {failed} alert
          </Text>
        </Box>
        <Text dimColor>
          {FOCUS_ORDER.map((pane) => (pane === focus ? `[${pane}]` : pane)).join("  ")}
        </Text>
      </Box>
    );
  }

  return (
    <Box height={3} paddingX={1} justifyContent="space-between">
      <Box flexDirection="column">
        <Text bold color="cyan">
          ◆ AGENTQ <Text color="gray">/ parallel coding queue</Text>
        </Text>
        <Text dimColor>isolated worktrees · durable runs · live output</Text>
      </Box>
      <Box flexDirection="column" alignItems="flex-end">
        <Text>
          <Text color="green">{running} active</Text>
          <Text dimColor> · </Text>
          <Text color="blue">{queued} queued</Text>
        </Text>
        <Text color={failed > 0 ? "red" : "gray"}>{failed} need attention</Text>
      </Box>
    </Box>
  );
}

function QueuePane({
  queues,
  tasks,
  selectedId,
  active,
  height,
  width,
}: {
  queues: Queue[];
  tasks: Task[];
  selectedId?: string;
  active: boolean;
  height?: number | string;
  width?: number | string;
}) {
  const selectedIndex = queues.findIndex((queue) => queue.id === selectedId);
  const rowCapacity = typeof height === "number" ? Math.max(1, height - 3) : queues.length;
  const visible = windowItems(queues, selectedIndex, rowCapacity);
  const position = selectedIndex >= 0 ? `  ${selectedIndex + 1}/${queues.length}` : "";

  return (
    <Panel title={`QUEUES${position}`} active={active} height={height} width={width}>
      {queues.length === 0 ? (
        <Box flexGrow={1} flexDirection="column" justifyContent="center">
          <Text bold>No queues yet</Text>
          <Text dimColor>Create one with `agentq queue create`.</Text>
        </Box>
      ) : (
        visible.items.map((queue) => {
          const queueTasks = tasks.filter((task) => task.queueId === queue.id);
          const activeCount = queueTasks.filter((task) => isTaskActive(task.status)).length;
          const queuedCount = queueTasks.filter((task) => task.status === "queued").length;
          const selected = queue.id === selectedId;
          return (
            <Box key={queue.id} justifyContent="space-between">
              <Text bold={selected} color={selected ? "cyan" : undefined} wrap="truncate-end">
                {selected ? "›" : " "} {sanitizeTerminalText(queue.name)}
              </Text>
              <Text dimColor={!selected}>
                {activeCount}/{queue.concurrency} <Text color="blue">+{queuedCount}</Text>
              </Text>
            </Box>
          );
        })
      )}
    </Panel>
  );
}

function TaskPane({
  tasks,
  selectedId,
  active,
  height,
  width,
}: {
  tasks: Task[];
  selectedId?: string;
  active: boolean;
  height?: number | string;
  width?: number | string;
}) {
  const selectedIndex = tasks.findIndex((task) => task.id === selectedId);
  const rowCapacity =
    typeof height === "number" ? Math.max(1, Math.floor((height - 3) / 3)) : tasks.length;
  const visible = windowItems(tasks, selectedIndex, rowCapacity);
  const position = selectedIndex >= 0 ? `  ${selectedIndex + 1}/${tasks.length}` : "";

  return (
    <Panel
      title={`TASKS  ${tasks.length}${position}`}
      active={active}
      height={height}
      width={width}
    >
      {tasks.length === 0 ? (
        <Box flexGrow={1} flexDirection="column" justifyContent="center">
          <Text bold>Queue is clear</Text>
          <Text dimColor>Press a to add the first task.</Text>
        </Box>
      ) : (
        visible.items.map((task) => {
          const selected = task.id === selectedId;
          return (
            <Box key={task.id} flexDirection="column" marginBottom={1}>
              <Box>
                <Text color={selected ? "cyan" : undefined}>{selected ? "› " : "  "}</Text>
                <StatusBadge status={task.status} />
                <Text dimColor> {task.provider === "codex" ? "CDX" : "CLD"}</Text>
              </Box>
              <Text bold={selected} color={selected ? "white" : "gray"} wrap="truncate-end">
                {sanitizeTerminalText(task.title)}
              </Text>
            </Box>
          );
        })
      )}
    </Panel>
  );
}

function DetailsPane({
  task,
  events,
  active,
  height,
}: {
  task?: Task;
  events: TaskEvent[];
  active: boolean;
  height?: number | string;
}) {
  const eventLimit = typeof height === "number" ? Math.max(2, height - 12) : 8;
  const visibleEvents = events.slice(-eventLimit);

  return (
    <Panel title="DETAILS / LIVE LOG" active={active} height={height} flexGrow={1}>
      {!task ? (
        <Box flexGrow={1} flexDirection="column" justifyContent="center">
          <Text bold>No task selected</Text>
          <Text dimColor>Choose a queue and task to inspect its run.</Text>
        </Box>
      ) : (
        <Box flexDirection="column" flexGrow={1} overflow="hidden">
          <Text bold wrap="truncate-end">
            {sanitizeTerminalText(task.title)}
          </Text>
          <Box>
            <StatusBadge status={task.status} />
            <Text dimColor>
              {`  ${task.provider} · attempt ${task.attemptCount || 0} · ${task.sourceKind}`}
            </Text>
          </Box>
          <Text dimColor wrap="truncate-end">
            {task.instructions
              ? sanitizeTerminalText(task.instructions)
              : "No additional instructions."}
          </Text>
          <Box marginTop={1} borderTop borderColor="gray" flexDirection="column" flexGrow={1}>
            <Text bold color="gray">
              LIVE ACTIVITY
            </Text>
            {visibleEvents.length === 0 ? (
              <Text dimColor>
                {isTaskTerminal(task.status)
                  ? "No recorded activity for this task."
                  : "Waiting for agent activity…"}
              </Text>
            ) : (
              visibleEvents.map((event) => (
                <Box key={event.id}>
                  <Text color="gray">{String(event.id).padStart(3, "0")} </Text>
                  <Text
                    color={event.kind === "diagnostic" ? "yellow" : undefined}
                    wrap="truncate-end"
                  >
                    {eventText(event)}
                  </Text>
                </Box>
              ))
            )}
          </Box>
        </Box>
      )}
    </Panel>
  );
}

function Footer({ notice, narrow, task }: { notice?: string; narrow: boolean; task?: Task }) {
  return (
    <Box height={2} paddingX={1} flexDirection="column">
      <Text wrap="truncate-end">
        <Text bold color="cyan">
          tab
        </Text>{" "}
        focus{" "}
        <Text bold color="cyan">
          ↑↓
        </Text>{" "}
        select{"  "}
        <Text bold color="green">
          a
        </Text>{" "}
        add{" "}
        {task && canCancelTask(task.status) ? (
          <>
            <Text bold color="yellow">
              c
            </Text>{" "}
            cancel{"  "}
          </>
        ) : null}
        {task && canRetryTask(task.status) ? (
          <>
            <Text bold color="magenta">
              r
            </Text>{" "}
            retry{"  "}
          </>
        ) : null}
        {task && canCompleteTaskManually(task.status) ? (
          <>
            <Text bold color="green">
              d
            </Text>{" "}
            done{"  "}
          </>
        ) : null}
        <Text bold>q</Text> quit
      </Text>
      {notice ? (
        <Text color="yellow">{sanitizeTerminalText(notice)}</Text>
      ) : !narrow ? (
        <Text dimColor>Agent output refreshes automatically.</Text>
      ) : null}
    </Box>
  );
}

function LoadingScreen({ columns, rows }: { columns: number; rows: number }) {
  return (
    <Box
      width={columns}
      height={rows}
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
    >
      <Text bold color="cyan">
        ◆ AGENTQ
      </Text>
      <Text dimColor>Loading workspace…</Text>
    </Box>
  );
}

export function AgentqApp({
  controller,
  dimensions,
  pollIntervalMs = 1_000,
  onExit,
}: AgentqAppProps) {
  const windowSize = useWindowSize();
  const { exit } = useApp();
  const columns = Math.max(40, dimensions?.columns ?? windowSize.columns);
  const rows = Math.max(16, dimensions?.rows ?? windowSize.rows);
  const [snapshot, setSnapshot] = useState<Snapshot>({ queues: [], tasks: [] });
  const [snapshotVersion, setSnapshotVersion] = useState(0);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [focus, setFocus] = useState<FocusPane>("queues");
  const [mode, setMode] = useState<ScreenMode>("dashboard");
  const [selectedQueueId, setSelectedQueueId] = useState<string>();
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  const [draft, setDraft] = useState<AddDraft>();
  const [actionPending, setActionPending] = useState(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const [queues, tasks] = await Promise.all([controller.listQueues(), controller.listTasks()]);
      if (!mounted.current) return;
      setSnapshot({ queues, tasks });
      setSnapshotVersion((version) => version + 1);
      setSelectedQueueId((current) =>
        current && queues.some((queue) => queue.id === current) ? current : queues[0]?.id,
      );
      setError(undefined);
    } catch (cause) {
      if (mounted.current) setError(messageFrom(cause));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [controller]);

  useEffect(() => {
    mounted.current = true;
    void refresh();

    const unsubscribe = controller.subscribe?.(() => void refresh());
    // Subscriptions only cover in-process mutations. Keep polling so work done
    // by another CLI/supervisor process is reflected without user input.
    const timer = setInterval(() => void refresh(), pollIntervalMs);
    return () => {
      mounted.current = false;
      unsubscribe?.();
      clearInterval(timer);
    };
  }, [controller, pollIntervalMs, refresh]);

  const visibleTasks = useMemo(
    () => snapshot.tasks.filter((task) => task.queueId === selectedQueueId),
    [selectedQueueId, snapshot.tasks],
  );

  useEffect(() => {
    setSelectedTaskId((current) =>
      current && visibleTasks.some((task) => task.id === current) ? current : visibleTasks[0]?.id,
    );
  }, [visibleTasks]);

  const selectedTask = visibleTasks.find((task) => task.id === selectedTaskId);

  const refreshEvents = useCallback(async () => {
    if (!selectedTaskId) {
      setEvents([]);
      return;
    }
    try {
      const nextEvents = await controller.listEvents(selectedTaskId, { limit: 200 });
      if (mounted.current) setEvents(nextEvents);
    } catch (cause) {
      if (mounted.current) setNotice(`Logs unavailable: ${messageFrom(cause)}`);
    }
  }, [controller, selectedTaskId]);

  useEffect(() => {
    if (snapshotVersion > 0) void refreshEvents();
  }, [refreshEvents, snapshotVersion]);

  const cycleFocus = useCallback((delta: number) => {
    setFocus((current) => {
      const index = FOCUS_ORDER.indexOf(current);
      return FOCUS_ORDER[nextIndex(index, FOCUS_ORDER.length, delta)] ?? "queues";
    });
  }, []);

  const moveSelection = useCallback(
    (delta: number) => {
      if (focus === "queues") {
        const index = snapshot.queues.findIndex((queue) => queue.id === selectedQueueId);
        const next = snapshot.queues[nextIndex(Math.max(index, 0), snapshot.queues.length, delta)];
        if (next) setSelectedQueueId(next.id);
      } else if (focus === "tasks") {
        const index = visibleTasks.findIndex((task) => task.id === selectedTaskId);
        const next = visibleTasks[nextIndex(Math.max(index, 0), visibleTasks.length, delta)];
        if (next) setSelectedTaskId(next.id);
      }
    },
    [focus, selectedQueueId, selectedTaskId, snapshot.queues, visibleTasks],
  );

  const startAdd = useCallback(() => {
    if (snapshot.queues.length === 0) {
      setNotice("Create a queue before adding a task.");
      return;
    }
    const queueIndex = Math.max(
      0,
      snapshot.queues.findIndex((queue) => queue.id === selectedQueueId),
    );
    const provider = snapshot.queues[queueIndex]?.defaultProvider ?? "codex";
    setDraft({
      queueIndex,
      providerIndex: Math.max(0, PROVIDERS.indexOf(provider)),
      title: "",
      instructions: "",
      field: 0,
    });
    setMode("add");
    setNotice(undefined);
  }, [selectedQueueId, snapshot.queues]);

  const submitAdd = useCallback(async () => {
    if (!draft || actionPending) return;
    const queue = snapshot.queues[draft.queueIndex];
    const provider = PROVIDERS[draft.providerIndex];
    if (!queue || !provider) return;
    if (!draft.title.trim()) {
      setDraft((current) => (current ? { ...current, error: "Title is required." } : current));
      return;
    }

    setActionPending(true);
    try {
      const added = await controller.addTask({
        queue: queue.name,
        provider,
        title: draft.title.trim(),
        instructions: draft.instructions.trim() || undefined,
        sourceKind: "manual",
      });
      setMode("dashboard");
      setDraft(undefined);
      setSelectedQueueId(added.queueId);
      setSelectedTaskId(added.id);
      setFocus("tasks");
      setNotice(`Added ${added.id}.`);
      await refresh();
    } catch (cause) {
      setDraft((current) =>
        current ? { ...current, error: `Could not add task: ${messageFrom(cause)}` } : current,
      );
    } finally {
      setActionPending(false);
    }
  }, [actionPending, controller, draft, refresh, snapshot.queues]);

  const runAction = useCallback(
    async (action: "cancel" | "retry" | "done") => {
      if (!selectedTask || actionPending) return;
      setActionPending(true);
      try {
        if (action === "cancel") await controller.cancelTask(selectedTask.id);
        if (action === "retry") await controller.retryTask(selectedTask.id);
        if (action === "done") await controller.completeManualTask(selectedTask.id);
        setMode("dashboard");
        setNotice(
          action === "cancel"
            ? `Cancellation requested for ${selectedTask.id}.`
            : action === "retry"
              ? `Retry queued for ${selectedTask.id}.`
              : `Marked ${selectedTask.id} complete.`,
        );
        await refresh();
      } catch (cause) {
        setMode("dashboard");
        setNotice(`${action} failed: ${messageFrom(cause)}`);
      } finally {
        setActionPending(false);
      }
    },
    [actionPending, controller, refresh, selectedTask],
  );

  useInput((input, key) => {
    if (mode === "confirm-cancel" || mode === "confirm-retry") {
      if (key.escape || input === "n") {
        setMode("dashboard");
        return;
      }
      if (key.return || input === "y") {
        void runAction(mode === "confirm-cancel" ? "cancel" : "retry");
      }
      return;
    }

    if (mode === "add" && draft) {
      if (key.escape) {
        setMode("dashboard");
        setDraft(undefined);
        return;
      }
      if (key.ctrl && input === "s") {
        void submitAdd();
        return;
      }
      if (key.tab) {
        setDraft((current) =>
          current
            ? {
                ...current,
                field: nextIndex(current.field, 4, key.shift ? -1 : 1) as AddDraft["field"],
              }
            : current,
        );
        return;
      }
      if ((key.leftArrow || key.upArrow || key.rightArrow || key.downArrow) && draft.field < 2) {
        const delta = key.leftArrow || key.upArrow ? -1 : 1;
        setDraft((current) => {
          if (!current) return current;
          if (current.field === 0) {
            return {
              ...current,
              queueIndex: nextIndex(current.queueIndex, snapshot.queues.length, delta),
            };
          }
          return {
            ...current,
            providerIndex: nextIndex(current.providerIndex, PROVIDERS.length, delta),
          };
        });
        return;
      }
      if (key.return) {
        if (draft.field < 3) {
          setDraft((current) =>
            current ? { ...current, field: (current.field + 1) as AddDraft["field"] } : current,
          );
        } else {
          void submitAdd();
        }
        return;
      }
      if (key.backspace || key.delete) {
        setDraft((current) => {
          if (!current || current.field < 2) return current;
          const keyName = current.field === 2 ? "title" : "instructions";
          return { ...current, [keyName]: current[keyName].slice(0, -1), error: undefined };
        });
        return;
      }
      if (!key.ctrl && !key.meta && input && draft.field >= 2) {
        setDraft((current) => {
          if (!current) return current;
          const keyName = current.field === 2 ? "title" : "instructions";
          return { ...current, [keyName]: current[keyName] + input, error: undefined };
        });
      }
      return;
    }

    if (key.tab) {
      cycleFocus(key.shift ? -1 : 1);
      return;
    }
    if (key.leftArrow) {
      cycleFocus(-1);
      return;
    }
    if (key.rightArrow) {
      cycleFocus(1);
      return;
    }
    if (key.upArrow) {
      moveSelection(-1);
      return;
    }
    if (key.downArrow) {
      moveSelection(1);
      return;
    }
    if (input === "a") startAdd();
    if (input === "c" && selectedTask && canCancelTask(selectedTask.status)) {
      setMode("confirm-cancel");
    }
    if (input === "r" && selectedTask && canRetryTask(selectedTask.status)) {
      setMode("confirm-retry");
    }
    if (input === "d" && selectedTask && canCompleteTaskManually(selectedTask.status)) {
      void runAction("done");
    }
    if (input === "R") void refresh();
    if (input === "q") {
      if (onExit) onExit();
      else exit();
    }
  });

  if (loading) return <LoadingScreen columns={columns} rows={rows} />;

  if (error && snapshot.queues.length === 0) {
    return (
      <Box
        width={columns}
        height={rows}
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
      >
        <Text bold color="red">
          Could not load AgentQ
        </Text>
        <Text>{sanitizeTerminalText(error)}</Text>
        <Text dimColor>Press R to retry or q to quit.</Text>
      </Box>
    );
  }

  if (mode === "add" && draft) {
    const queue = snapshot.queues[draft.queueIndex];
    const provider = PROVIDERS[draft.providerIndex];
    const compactForm = columns < 60 || rows < 24;
    const field = (index: number, label: string, value: string) => {
      if (compactForm) {
        return (
          <Text key={label} color={draft.field === index ? "cyan" : undefined} wrap="truncate-end">
            {draft.field === index ? "●" : "○"} {label.padEnd(13)}{" "}
            {sanitizeTerminalText(value) || (draft.field === index ? "▏" : "—")}
          </Text>
        );
      }

      return (
        <Box key={label} flexDirection="column" marginBottom={1}>
          <Text bold color={draft.field === index ? "cyan" : "gray"}>
            {draft.field === index ? "●" : "○"} {label}
          </Text>
          <Box
            borderStyle="round"
            borderColor={draft.field === index ? "cyan" : "gray"}
            paddingX={1}
          >
            <Text wrap="truncate-end">
              {sanitizeTerminalText(value) || (draft.field === index ? "▏" : "—")}
            </Text>
          </Box>
        </Box>
      );
    };

    return (
      <Box width={columns} height={rows} flexDirection="column">
        <Header tasks={snapshot.tasks} focus={focus} narrow={columns < 72} />
        <Box flexGrow={1} alignItems="center" overflow="hidden">
          <Box
            width={Math.min(columns - 2, 76)}
            borderStyle="double"
            borderColor="cyan"
            paddingX={compactForm ? 1 : 2}
            flexDirection="column"
          >
            <Text bold color="cyan">
              ADD TASK
            </Text>
            <Text dimColor>Choose the queue and provider, then describe the outcome.</Text>
            {field(0, "Queue", queue?.name ?? "No queue")}
            {field(1, "Provider", provider ?? "No provider")}
            {field(2, "Title", draft.title)}
            {field(3, "Instructions", draft.instructions)}
            {draft.error ? <Text color="red">{sanitizeTerminalText(draft.error)}</Text> : null}
            <Text dimColor>
              tab next · arrows choose · enter advance/submit · ctrl+s submit · esc cancel
            </Text>
          </Box>
        </Box>
      </Box>
    );
  }

  if ((mode === "confirm-cancel" || mode === "confirm-retry") && selectedTask) {
    const cancelling = mode === "confirm-cancel";
    return (
      <Box width={columns} height={rows} flexDirection="column">
        <Header tasks={snapshot.tasks} focus={focus} narrow={columns < 72} />
        <Box flexGrow={1} alignItems="center" justifyContent="center">
          <Box
            width={Math.min(columns - 4, 64)}
            borderStyle="double"
            borderColor={cancelling ? "yellow" : "magenta"}
            paddingX={2}
            paddingY={1}
            flexDirection="column"
          >
            <Text bold color={cancelling ? "yellow" : "magenta"}>
              {cancelling ? "CANCEL TASK?" : "RETRY TASK?"}
            </Text>
            <Text wrap="truncate-end">{sanitizeTerminalText(selectedTask.title)}</Text>
            <Text dimColor>
              {cancelling
                ? "The agent process will receive a graceful stop request."
                : "A new isolated attempt will be queued for this task."}
            </Text>
            <Text>
              <Text bold>y / enter</Text> confirm <Text bold>n / esc</Text> keep task
            </Text>
          </Box>
        </Box>
      </Box>
    );
  }

  const narrow = columns < 72;
  const wide = columns >= 110;
  const bodyHeight = Math.max(10, rows - 5);
  const queuePane = (
    <QueuePane
      queues={snapshot.queues}
      tasks={snapshot.tasks}
      selectedId={selectedQueueId}
      active={focus === "queues"}
      height={bodyHeight}
      width={narrow ? "100%" : 25}
    />
  );
  const taskPane = (
    <TaskPane
      tasks={visibleTasks}
      selectedId={selectedTaskId}
      active={focus === "tasks"}
      height={narrow || wide ? bodyHeight : Math.max(8, Math.floor(bodyHeight * 0.45))}
      width={narrow ? "100%" : wide ? 39 : undefined}
    />
  );
  const detailsPane = (
    <DetailsPane
      task={selectedTask}
      events={events}
      active={focus === "details"}
      height={narrow ? bodyHeight : wide ? "100%" : undefined}
    />
  );

  return (
    <Box width={columns} height={rows} flexDirection="column" overflow="hidden">
      <Header tasks={snapshot.tasks} focus={focus} narrow={narrow} />
      {narrow ? (
        <Box height={bodyHeight} overflow="hidden">
          {focus === "queues" ? queuePane : focus === "tasks" ? taskPane : detailsPane}
        </Box>
      ) : wide ? (
        <Box height={bodyHeight} flexDirection="row" overflow="hidden">
          {queuePane}
          {taskPane}
          {detailsPane}
        </Box>
      ) : (
        <Box height={bodyHeight} flexDirection="row" overflow="hidden">
          {queuePane}
          <Box flexGrow={1} flexDirection="column" overflow="hidden">
            {taskPane}
            {detailsPane}
          </Box>
        </Box>
      )}
      <Footer notice={notice ?? error} narrow={narrow} task={selectedTask} />
    </Box>
  );
}
