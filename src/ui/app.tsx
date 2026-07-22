import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import stringWidth from "string-width";
import {
  canCancelTask,
  canCompleteTaskManually,
  canRetryTask,
  isTaskActive,
  isTaskTerminal,
  PROVIDERS,
  type Provider,
  type Queue,
  type Run,
  TASK_STATUSES,
  type Task,
  type TaskEvent,
} from "../core/types.ts";
import type { IntegrationResult, IntegrationTarget } from "../integrations/instructions.ts";
import { sanitizeTerminalText } from "./sanitize.ts";
import type {
  AgentqAppProps,
  UiContext,
  UiDoctorCheck,
  UiQueuePatch,
  UiTaskPatch,
} from "./types.ts";

type FocusPane = "queues" | "tasks" | "details";
type ScreenMode =
  | "dashboard"
  | "add"
  | "edit"
  | "queue-form"
  | "help"
  | "actions"
  | "confirm"
  | "attempts"
  | "doctor"
  | "integration-results";

interface Snapshot {
  queues: Queue[];
  tasks: Task[];
}

interface AddDraft {
  queueId: string;
  providerIndex: number;
  priority: string;
  title: string;
  instructions: string;
  acceptanceCriteria: string;
  idempotencyKey: string;
  field: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  error?: string;
}

interface EditDraft {
  taskId: string;
  expectedUpdatedAt: string;
  providerIndex: number;
  priority: string;
  title: string;
  instructions: string;
  acceptanceCriteria: string;
  field: 0 | 1 | 2 | 3 | 4;
  error?: string;
}

interface QueueDraft {
  kind: "create" | "edit";
  queueId?: string;
  name: string;
  repoPath: string;
  baseRef: string;
  providerIndex: number;
  concurrency: string;
  maxAttempts: string;
  verifyCommands: string;
  autoCommit: boolean;
  field: number;
  error?: string;
}

type Confirmation =
  | { kind: "cancel"; task: Task }
  | { kind: "retry"; task: Task }
  | { kind: "remove-queue"; queue: Queue }
  | { kind: "clean"; task: Task; force: boolean }
  | { kind: "integration"; target: IntegrationTarget; repoPath: string };

type ActionId =
  | "create-queue"
  | "edit-queue"
  | "remove-queue"
  | "add-task"
  | "edit-task"
  | "cancel-task"
  | "retry-task"
  | "resume-task"
  | "complete-task"
  | "attempts"
  | "clean-task"
  | "filter-status"
  | "doctor"
  | "login-codex"
  | "login-claude"
  | "integrate-codex"
  | "integrate-claude"
  | "integrate-all"
  | "toggle-scope"
  | "refresh"
  | "help"
  | "quit";

interface ActionItem {
  id: ActionId;
  label: string;
  detail: string;
  available: boolean;
}

type TaskStatusFilter = "all" | Task["status"];

const EDITABLE_TASK_STATUSES = new Set<Task["status"]>([
  "queued",
  "failed",
  "interrupted",
  "cancelled",
]);
const TASK_FILTERS: readonly TaskStatusFilter[] = ["all", ...TASK_STATUSES];

const isTaskEditable = (task: Task): boolean => EDITABLE_TASK_STATUSES.has(task.status);

const parseAcceptanceCriteria = (value: string): string[] =>
  value
    .split(/[;\n]/u)
    .map((criterion) => criterion.trim())
    .filter((criterion) => criterion.length > 0);

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
type PaneWeights = Record<FocusPane, number>;

const DEFAULT_PANE_WEIGHTS: PaneWeights = {
  queues: 0.2,
  tasks: 0.32,
  details: 0.48,
};
const MIN_PANE_WEIGHT = 0.16;
const PANE_RESIZE_STEP = 0.05;

const resizePaneWeights = (current: PaneWeights, pane: FocusPane, delta: number): PaneWeights => {
  const others = FOCUS_ORDER.filter((candidate) => candidate !== pane);
  const next = { ...current };

  if (delta > 0) {
    const capacities = others.map((candidate) => Math.max(0, current[candidate] - MIN_PANE_WEIGHT));
    const available = capacities.reduce((total, capacity) => total + capacity, 0);
    const amount = Math.min(delta, available);
    if (amount <= 0 || available <= 0) return current;
    next[pane] += amount;
    for (const [index, candidate] of others.entries()) {
      next[candidate] -= amount * ((capacities[index] ?? 0) / available);
    }
  } else {
    const available = Math.max(0, current[pane] - MIN_PANE_WEIGHT);
    const amount = Math.min(-delta, available);
    if (amount <= 0) return current;
    next[pane] -= amount;
    const otherTotal = others.reduce((total, candidate) => total + current[candidate], 0);
    for (const candidate of others) {
      next[candidate] += amount * (current[candidate] / otherTotal);
    }
  }

  const total = FOCUS_ORDER.reduce((sum, candidate) => sum + next[candidate], 0);
  for (const candidate of FOCUS_ORDER) next[candidate] /= total;
  return next;
};

const paneWidths = (width: number, weights: PaneWeights): Record<FocusPane, number> => {
  const queues = Math.floor(width * weights.queues);
  const tasks = Math.floor(width * weights.tasks);
  return { queues, tasks, details: Math.max(1, width - queues - tasks) };
};

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

const parseCommands = (value: string): string[] =>
  value
    .split(/[;\n]/u)
    .map((command) => command.trim())
    .filter((command) => command.length > 0);

const positiveIntegerFrom = (value: string, label: string): number => {
  if (!/^\d+$/u.test(value.trim())) throw new Error(`${label} must be a positive whole number.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive whole number.`);
  }
  return parsed;
};

const runSummary = (run: Run): string =>
  run.error ?? run.summary ?? run.taskSnapshot?.title ?? "No summary recorded.";

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

function Header({
  tasks,
  focus,
  narrow,
  scopeLabel,
}: {
  tasks: Task[];
  focus: FocusPane;
  narrow: boolean;
  scopeLabel?: string;
}) {
  const running = tasks.filter((task) => isTaskActive(task.status)).length;
  const queued = tasks.filter((task) => task.status === "queued").length;
  const failed = tasks.filter(
    (task) => task.status === "failed" || task.status === "interrupted",
  ).length;
  const scope = scopeLabel ? sanitizeTerminalText(scopeLabel) : undefined;

  if (narrow) {
    return (
      <Box height={3} paddingX={1} flexDirection="column">
        <Box justifyContent="space-between">
          <Text bold color="cyan" wrap="truncate-end">
            ◆ AGENTQ{scope ? ` · ${scope}` : ""}
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
        <Text dimColor wrap="truncate-end">
          {scope ? `${scope} · ` : ""}isolated worktrees · durable runs · live output
        </Text>
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
  scopeLabel,
  showRepositories,
}: {
  queues: Queue[];
  tasks: Task[];
  selectedId?: string;
  active: boolean;
  height?: number | string;
  width?: number | string;
  scopeLabel?: string;
  showRepositories: boolean;
}) {
  const selectedIndex = queues.findIndex((queue) => queue.id === selectedId);
  const rowHeight = showRepositories ? 2 : 1;
  const rowCapacity =
    typeof height === "number" ? Math.max(1, Math.floor((height - 3) / rowHeight)) : queues.length;
  const visible = windowItems(queues, selectedIndex, rowCapacity);
  const position = selectedIndex >= 0 ? `  ${selectedIndex + 1}/${queues.length}` : "";

  return (
    <Panel title={`QUEUES${position}`} active={active} height={height} width={width}>
      {queues.length === 0 ? (
        <Box flexGrow={1} flexDirection="column" justifyContent="center">
          <Text bold>{scopeLabel ? "No queues for this repository" : "No queues yet"}</Text>
          {scopeLabel ? <Text dimColor>{sanitizeTerminalText(scopeLabel)}</Text> : null}
          <Text dimColor>Press n to create one, or run `agentq queue create &lt;name&gt;`.</Text>
        </Box>
      ) : (
        visible.items.map((queue) => {
          const queueTasks = tasks.filter((task) => task.queueId === queue.id);
          const activeCount = queueTasks.filter((task) => isTaskActive(task.status)).length;
          const queuedCount = queueTasks.filter((task) => task.status === "queued").length;
          const selected = queue.id === selectedId;
          return (
            <Box key={queue.id} flexDirection="column">
              <Box justifyContent="space-between">
                <Text bold={selected} color={selected ? "cyan" : undefined} wrap="truncate-end">
                  {selected ? "›" : " "} {sanitizeTerminalText(queue.name)}
                </Text>
                <Text dimColor={!selected}>
                  {activeCount}/{queue.concurrency} <Text color="blue">+{queuedCount}</Text>
                </Text>
              </Box>
              {showRepositories ? (
                <Text dimColor wrap="truncate-end">
                  {sanitizeTerminalText(queue.repoPath)}
                </Text>
              ) : null}
            </Box>
          );
        })
      )}
    </Panel>
  );
}

function TaskPane({
  tasks,
  filter,
  selectedId,
  active,
  height,
  width,
}: {
  tasks: Task[];
  filter: TaskStatusFilter;
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
      title={`TASKS  ${tasks.length}${filter === "all" ? "" : ` · ${filter.toUpperCase()}`}${position}`}
      active={active}
      height={height}
      width={width}
    >
      {tasks.length === 0 ? (
        <Box flexGrow={1} flexDirection="column" justifyContent="center">
          <Text bold>{filter === "all" ? "Queue is clear" : `No ${filter} tasks`}</Text>
          <Text dimColor>
            {filter === "all" ? "Press a to add the first task." : "Press f to change the filter."}
          </Text>
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
  queue,
  events,
  active,
  height,
  width,
}: {
  task?: Task;
  queue?: Queue;
  events: TaskEvent[];
  active: boolean;
  height?: number | string;
  width?: number | string;
}) {
  const eventLimit = typeof height === "number" ? Math.max(2, height - 12) : 8;
  const visibleEvents = events.slice(-eventLimit);

  return (
    <Panel title="DETAILS / LIVE LOG" active={active} height={height} width={width}>
      {!task ? (
        <Box flexGrow={1} flexDirection="column" justifyContent="center">
          {queue ? (
            <>
              <Text bold>{sanitizeTerminalText(queue.name)}</Text>
              <Text dimColor wrap="truncate-end">
                {sanitizeTerminalText(queue.repoPath)}
              </Text>
              <Text>Base: {sanitizeTerminalText(queue.baseRef)}</Text>
              <Text>Provider: {queue.defaultProvider}</Text>
              <Text>
                Concurrency: {queue.concurrency} · max attempts: {queue.maxAttempts}
              </Text>
              <Text wrap="truncate-end">
                Verify:{" "}
                {queue.verifyCommands.length > 0
                  ? sanitizeTerminalText(queue.verifyCommands.join("; "))
                  : "none"}
              </Text>
              <Text>Auto-commit: {queue.autoCommit ? "on" : "off"}</Text>
              <Text dimColor>Select a task to inspect its live activity.</Text>
            </>
          ) : (
            <>
              <Text bold>No task selected</Text>
              <Text dimColor>Choose a queue and task to inspect its run.</Text>
            </>
          )}
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

function Footer({
  notice,
  narrow,
  task,
  focus,
  queue,
  canToggle,
}: {
  notice?: string;
  narrow: boolean;
  task?: Task;
  focus: FocusPane;
  queue?: Queue;
  canToggle: boolean;
}) {
  return (
    <Box height={2} paddingX={1} flexDirection="column">
      <Text wrap="truncate-end">
        <Text bold color="cyan">
          :
        </Text>{" "}
        actions{"  "}
        <Text bold color="green">
          n
        </Text>{" "}
        queue{"  "}
        <Text bold color="green">
          a
        </Text>{" "}
        task{"  "}
        <Text bold color="cyan">
          e
        </Text>{" "}
        edit {focus === "queues" ? "queue" : "task"}
        {"  "}
        <Text bold color="yellow">
          x
        </Text>{" "}
        {focus === "queues" ? "remove" : "clean"}
        {"  "}
        {canToggle ? (
          <>
            <Text bold>g</Text> local/all{"  "}
          </>
        ) : null}
        <Text bold>?</Text> help{"  "}
        <Text bold>q</Text> quit
      </Text>
      {notice ? (
        <Text color="yellow">{sanitizeTerminalText(notice)}</Text>
      ) : task ? (
        <Text dimColor wrap="truncate-end">
          c cancel · r retry · s resume · d done · v attempts · f filter · 1-3/tab focus
        </Text>
      ) : !narrow ? (
        <Text dimColor>
          {queue ? `${sanitizeTerminalText(queue.name)} selected · ` : ""}1-3/tab focus · ↑↓/jk
          select · [ ] size · z zoom · R refresh
        </Text>
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

interface FormField {
  label: string;
  value: string;
  focused?: boolean;
  focusable?: boolean;
  multiline?: boolean;
  textInput?: boolean;
}

interface FormScreenProps {
  columns: number;
  rows: number;
  title: string;
  subtitle: string;
  fields: FormField[];
  error?: string;
  footer: string;
}

const formFieldHeight = (field: FormField): number => (field.multiline ? 6 : 4);

const formGraphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const splitFormGraphemes = (value: string): string[] =>
  Array.from(formGraphemes.segment(value), ({ segment }) => segment);

const takeFormTail = (value: string, width: number): string => {
  const tail: string[] = [];
  let used = 0;
  for (const grapheme of splitFormGraphemes(value).reverse()) {
    const graphemeWidth = stringWidth(grapheme);
    if (used + graphemeWidth > width) break;
    tail.push(grapheme);
    used += graphemeWidth;
  }
  return tail.reverse().join("");
};

const wrapFormValue = (value: string, width: number): string[] => {
  const lines: string[] = [];
  for (const logicalLine of value.split("\n")) {
    const graphemes = splitFormGraphemes(logicalLine);
    if (graphemes.length === 0) {
      lines.push("");
      continue;
    }

    let line = "";
    let used = 0;
    for (const grapheme of graphemes) {
      const graphemeWidth = stringWidth(grapheme);
      if (line && used + graphemeWidth > width) {
        lines.push(line);
        line = "";
        used = 0;
      }
      line += grapheme;
      used += graphemeWidth;
    }
    if (line) lines.push(line);
  }
  return lines;
};

const focusedFormValue = (value: string, width: number, height: number): string => {
  const wrapped = wrapFormValue(value, width);
  const clipped = wrapped.length > height;
  const visible = wrapped.slice(-height);
  if (visible.length === 0) visible.push("");

  const marker = "…";
  const cursor = "▏";
  const markerWidth = stringWidth(marker);
  const cursorWidth = stringWidth(cursor);
  if (clipped && visible.length === 1) {
    const contentWidth = Math.max(0, width - markerWidth - cursorWidth);
    return `${marker}${takeFormTail(visible[0] ?? "", contentWidth)}${cursor}`;
  }

  if (clipped) {
    const contentWidth = Math.max(0, width - markerWidth);
    visible[0] = `${marker}${takeFormTail(visible[0] ?? "", contentWidth)}`;
  }

  const lastIndex = visible.length - 1;
  const contentWidth = Math.max(0, width - cursorWidth);
  visible[lastIndex] = `${takeFormTail(visible[lastIndex] ?? "", contentWidth)}${cursor}`;
  return visible.join("\n");
};

const visibleFormFields = (
  fields: FormField[],
  focusedIndex: number,
  capacity: number,
): { fields: FormField[]; start: number; end: number } => {
  if (fields.length === 0) return { fields: [], start: 0, end: 0 };

  const focus = Math.max(0, Math.min(fields.length - 1, focusedIndex));
  let start = focus;
  let end = focus + 1;
  let used = formFieldHeight(fields[focus] as FormField);
  let preferAfter = true;

  while (start > 0 || end < fields.length) {
    const before = start > 0 ? fields[start - 1] : undefined;
    const after = end < fields.length ? fields[end] : undefined;
    const beforeFits = before !== undefined && used + formFieldHeight(before) <= capacity;
    const afterFits = after !== undefined && used + formFieldHeight(after) <= capacity;

    if (!beforeFits && !afterFits) break;
    if ((preferAfter && afterFits) || !beforeFits) {
      used += formFieldHeight(after as FormField);
      end += 1;
    } else {
      start -= 1;
      used += formFieldHeight(before as FormField);
    }
    preferAfter = !preferAfter;
  }

  return { fields: fields.slice(start, end), start, end };
};

function FormScreen({ columns, rows, title, subtitle, fields, error, footer }: FormScreenProps) {
  const focusedIndex = Math.max(
    0,
    fields.findIndex((field) => field.focused),
  );
  const focusableFields = fields.filter((field) => field.focusable !== false);
  const focusedPosition = Math.max(
    0,
    focusableFields.findIndex((field) => field.focused),
  );
  const chromeHeight = 4 + (error ? 1 : 0);
  const viewportHeight = Math.max(
    formFieldHeight(fields[focusedIndex] as FormField),
    rows - chromeHeight,
  );
  const visible = visibleFormFields(fields, focusedIndex, viewportHeight);
  const hiddenAbove = visible.start;
  const hiddenBelow = fields.length - visible.end;
  const formWidth = Math.max(1, Math.min(columns - 2, 96));
  const horizontalPadding = columns >= 50 ? 2 : 1;
  const fieldTextWidth = Math.max(1, formWidth - horizontalPadding * 2 - 4);

  return (
    <Box width={columns} height={rows} alignItems="center" overflow="hidden">
      <Box
        width={formWidth}
        height={rows}
        paddingX={horizontalPadding}
        flexDirection="column"
        overflow="hidden"
      >
        <Box justifyContent="space-between">
          <Text bold color="cyan">
            {title}
          </Text>
          <Text dimColor>
            FIELD {focusedPosition + 1}/{focusableFields.length}
          </Text>
        </Box>
        <Text dimColor wrap="truncate-end">
          {subtitle}
        </Text>
        <Text dimColor wrap="truncate-end">
          Showing {visible.start + 1}–{visible.end} of {fields.length} rows
          {hiddenAbove > 0 ? ` · ↑ ${hiddenAbove} hidden` : ""}
          {hiddenBelow > 0 ? ` · ↓ ${hiddenBelow} hidden` : ""}
        </Text>
        <Box height={viewportHeight} flexDirection="column" overflow="hidden">
          {visible.fields.map((field) => {
            const value = sanitizeTerminalText(field.value);
            const displayValue =
              field.focused && field.textInput
                ? focusedFormValue(value, fieldTextWidth, field.multiline ? 3 : 1)
                : value || " ";
            return (
              <Box key={field.label} flexDirection="column">
                <Text bold color={field.focused ? "cyan" : "gray"} wrap="truncate-end">
                  {field.label}
                </Text>
                <Box
                  height={field.multiline ? 5 : 3}
                  borderStyle="round"
                  borderColor={field.focused ? "cyan" : "gray"}
                  paddingX={1}
                  overflow="hidden"
                >
                  <Text wrap={field.multiline ? "wrap" : "truncate-end"}>{displayValue}</Text>
                </Box>
              </Box>
            );
          })}
        </Box>
        {error ? (
          <Text color="red" wrap="truncate-end">
            {sanitizeTerminalText(error)}
          </Text>
        ) : null}
        <Text dimColor wrap="truncate-end">
          {footer}
        </Text>
      </Box>
    </Box>
  );
}

export function AgentqApp({
  controller,
  dimensions,
  pollIntervalMs = 1_000,
  scopeLabel,
  onExit,
}: AgentqAppProps) {
  const windowSize = useWindowSize();
  const { exit, suspendTerminal } = useApp();
  const columns = dimensions?.columns ?? windowSize.columns;
  const rows = dimensions?.rows ?? windowSize.rows;
  const [snapshot, setSnapshot] = useState<Snapshot>({ queues: [], tasks: [] });
  const [context, setContext] = useState<UiContext>();
  const [snapshotVersion, setSnapshotVersion] = useState(0);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [focus, setFocus] = useState<FocusPane>("queues");
  const [weights, setWeights] = useState<PaneWeights>(DEFAULT_PANE_WEIGHTS);
  const [zoomedPane, setZoomedPane] = useState<FocusPane>();
  const [mode, setMode] = useState<ScreenMode>("dashboard");
  const [selectedQueueId, setSelectedQueueId] = useState<string>();
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  const [taskFilter, setTaskFilter] = useState<TaskStatusFilter>("all");
  const [draft, setDraft] = useState<AddDraft>();
  const [editDraft, setEditDraft] = useState<EditDraft>();
  const [queueDraft, setQueueDraft] = useState<QueueDraft>();
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [runs, setRuns] = useState<Run[]>([]);
  const [doctorChecks, setDoctorChecks] = useState<UiDoctorCheck[]>([]);
  const [integrationResults, setIntegrationResults] = useState<IntegrationResult[]>([]);
  const [actionIndex, setActionIndex] = useState(0);
  const [actionPending, setActionPending] = useState(false);
  const mounted = useRef(true);
  const refreshSequence = useRef(0);
  const eventRefreshSequence = useRef(0);
  const actionPendingRef = useRef(false);

  const beginAction = useCallback(() => {
    if (actionPendingRef.current) return false;
    actionPendingRef.current = true;
    setActionPending(true);
    return true;
  }, []);

  const finishAction = useCallback(() => {
    actionPendingRef.current = false;
    if (mounted.current) setActionPending(false);
  }, []);

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    try {
      const [queues, tasks, nextContext] = await Promise.all([
        controller.listQueues(),
        controller.listTasks(),
        Promise.resolve(controller.uiContext()),
      ]);
      if (!mounted.current || sequence !== refreshSequence.current) return;
      setSnapshot({ queues, tasks });
      setContext(nextContext);
      setSnapshotVersion((version) => version + 1);
      setSelectedQueueId((current) =>
        current && queues.some((queue) => queue.id === current) ? current : queues[0]?.id,
      );
      setError(undefined);
      return true;
    } catch (cause) {
      if (mounted.current && sequence === refreshSequence.current) setError(messageFrom(cause));
      return false;
    } finally {
      if (mounted.current && sequence === refreshSequence.current) setLoading(false);
    }
  }, [controller]);

  const displayScope = context?.label ?? scopeLabel;

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

  const queueTasks = useMemo(
    () => snapshot.tasks.filter((task) => task.queueId === selectedQueueId),
    [selectedQueueId, snapshot.tasks],
  );
  const visibleTasks = useMemo(
    () => queueTasks.filter((task) => taskFilter === "all" || task.status === taskFilter),
    [queueTasks, taskFilter],
  );
  const selectedQueue = snapshot.queues.find((queue) => queue.id === selectedQueueId);
  const integrationRepositoryPath = context?.all
    ? selectedQueue?.repoPath
    : (context?.repositoryPath ?? selectedQueue?.repoPath);

  useEffect(() => {
    setSelectedTaskId((current) =>
      current && visibleTasks.some((task) => task.id === current) ? current : visibleTasks[0]?.id,
    );
  }, [visibleTasks]);

  const selectedTask = visibleTasks.find((task) => task.id === selectedTaskId);

  const refreshEvents = useCallback(async () => {
    const sequence = ++eventRefreshSequence.current;
    if (!selectedTaskId) {
      setEvents([]);
      return;
    }
    try {
      const nextEvents = await controller.listEvents(selectedTaskId, { limit: 200 });
      if (mounted.current && sequence === eventRefreshSequence.current) setEvents(nextEvents);
    } catch (cause) {
      if (mounted.current && sequence === eventRefreshSequence.current) {
        setNotice(`Logs unavailable: ${messageFrom(cause)}`);
      }
    }
  }, [controller, selectedTaskId]);

  useEffect(() => {
    if (snapshotVersion > 0) void refreshEvents();
  }, [refreshEvents, snapshotVersion]);

  const cycleFocus = useCallback((delta: number) => {
    setFocus((current) => {
      const index = FOCUS_ORDER.indexOf(current);
      const next = FOCUS_ORDER[nextIndex(index, FOCUS_ORDER.length, delta)] ?? "queues";
      setZoomedPane((zoomed) => (zoomed ? next : zoomed));
      return next;
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
    const queue =
      snapshot.queues.find((candidate) => candidate.id === selectedQueueId) ?? snapshot.queues[0];
    if (!queue) return;
    const provider = queue.defaultProvider;
    setDraft({
      queueId: queue.id,
      providerIndex: Math.max(0, PROVIDERS.indexOf(provider)),
      priority: "0",
      title: "",
      instructions: "",
      acceptanceCriteria: "",
      idempotencyKey: "",
      field: 0,
    });
    setMode("add");
    setNotice(undefined);
  }, [selectedQueueId, snapshot.queues]);

  const submitAdd = useCallback(async () => {
    if (!draft || actionPending) return;
    const queue = snapshot.queues.find((candidate) => candidate.id === draft.queueId);
    const provider = PROVIDERS[draft.providerIndex];
    if (!queue) {
      setDraft((current) =>
        current
          ? {
              ...current,
              error:
                "Selected queue is no longer available. Choose another queue with the arrow keys.",
            }
          : current,
      );
      return;
    }
    if (!provider) return;
    if (!draft.title.trim()) {
      setDraft((current) => (current ? { ...current, error: "Title is required." } : current));
      return;
    }
    if (!/^-?\d+$/u.test(draft.priority.trim())) {
      setDraft((current) =>
        current ? { ...current, error: "Priority must be a whole number." } : current,
      );
      return;
    }
    const priority = Number(draft.priority);
    if (!Number.isSafeInteger(priority)) {
      setDraft((current) =>
        current ? { ...current, error: "Priority is outside the safe integer range." } : current,
      );
      return;
    }

    if (!beginAction()) return;
    try {
      const added = await controller.addTask({
        queue: queue.id,
        provider,
        title: draft.title.trim(),
        instructions: draft.instructions.trim() || undefined,
        acceptanceCriteria: parseAcceptanceCriteria(draft.acceptanceCriteria),
        priority,
        idempotencyKey: draft.idempotencyKey.trim() || undefined,
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
      finishAction();
    }
  }, [actionPending, beginAction, controller, draft, finishAction, refresh, snapshot.queues]);

  const startEdit = useCallback(() => {
    if (!selectedTask) {
      setNotice("Select a task before editing.");
      return;
    }
    if (!isTaskEditable(selectedTask)) {
      setNotice(
        `Task ${selectedTask.id} is ${selectedTask.status} and locked. Edit is available for queued, failed, interrupted, or cancelled tasks.`,
      );
      return;
    }

    setEditDraft({
      taskId: selectedTask.id,
      expectedUpdatedAt: selectedTask.updatedAt,
      providerIndex: Math.max(0, PROVIDERS.indexOf(selectedTask.provider)),
      priority: String(selectedTask.priority),
      title: selectedTask.title,
      instructions: selectedTask.instructions,
      acceptanceCriteria: selectedTask.acceptanceCriteria.join("; "),
      field: 0,
    });
    setMode("edit");
    setNotice(undefined);
  }, [selectedTask]);

  const submitEdit = useCallback(async () => {
    if (!editDraft || actionPending) return;
    const provider = PROVIDERS[editDraft.providerIndex];
    if (!provider) return;

    const title = editDraft.title.trim();
    if (!title) {
      setEditDraft((current) => (current ? { ...current, error: "Title is required." } : current));
      return;
    }
    if (!/^-?\d+$/u.test(editDraft.priority.trim())) {
      setEditDraft((current) =>
        current ? { ...current, error: "Priority must be a whole number." } : current,
      );
      return;
    }
    const priority = Number(editDraft.priority);
    if (!Number.isSafeInteger(priority)) {
      setEditDraft((current) =>
        current ? { ...current, error: "Priority is outside the safe integer range." } : current,
      );
      return;
    }

    const patch: UiTaskPatch = {
      title,
      instructions: editDraft.instructions.trim(),
      acceptanceCriteria: parseAcceptanceCriteria(editDraft.acceptanceCriteria),
      provider,
      priority,
    };

    if (!beginAction()) return;
    try {
      const updated = await controller.editTask(
        editDraft.taskId,
        patch,
        editDraft.expectedUpdatedAt,
      );
      setSnapshot((current) => ({
        ...current,
        tasks: current.tasks.map((task) => (task.id === updated.id ? updated : task)),
      }));
      setMode("dashboard");
      setEditDraft(undefined);
      setNotice(`Updated ${updated.id}.`);
    } catch (cause) {
      setEditDraft((current) =>
        current ? { ...current, error: `Could not edit task: ${messageFrom(cause)}` } : current,
      );
    } finally {
      finishAction();
    }
  }, [actionPending, beginAction, controller, editDraft, finishAction]);

  const startCreateQueue = useCallback(() => {
    setQueueDraft({
      kind: "create",
      name: "",
      repoPath: context?.repositoryPath ?? process.cwd(),
      baseRef: "",
      providerIndex: 0,
      concurrency: "2",
      maxAttempts: "2",
      verifyCommands: "",
      autoCommit: true,
      field: 0,
    });
    setMode("queue-form");
    setNotice(undefined);
  }, [context?.repositoryPath]);

  const startEditQueue = useCallback(() => {
    if (!selectedQueue) {
      setNotice("Select a queue before editing.");
      return;
    }
    setQueueDraft({
      kind: "edit",
      queueId: selectedQueue.id,
      name: selectedQueue.name,
      repoPath: selectedQueue.repoPath,
      baseRef: selectedQueue.baseRef,
      providerIndex: Math.max(0, PROVIDERS.indexOf(selectedQueue.defaultProvider)),
      concurrency: String(selectedQueue.concurrency),
      maxAttempts: String(selectedQueue.maxAttempts),
      verifyCommands: selectedQueue.verifyCommands.join("; "),
      autoCommit: selectedQueue.autoCommit,
      field: 0,
    });
    setMode("queue-form");
    setNotice(undefined);
  }, [selectedQueue]);

  const submitQueue = useCallback(async () => {
    if (!queueDraft || actionPending) return;
    const provider = PROVIDERS[queueDraft.providerIndex];
    if (!provider) return;

    const name = queueDraft.name.trim();
    const repoPath = queueDraft.repoPath.trim();
    const baseRef = queueDraft.baseRef.trim();
    let started = false;
    try {
      if (!name) throw new Error("Queue name is required.");
      if (queueDraft.kind === "create" && !repoPath) {
        throw new Error("Repository path is required.");
      }
      if (queueDraft.kind === "edit" && !baseRef) throw new Error("Base ref is required.");
      const concurrency = positiveIntegerFrom(queueDraft.concurrency, "Concurrency");
      const maxAttempts = positiveIntegerFrom(queueDraft.maxAttempts, "Max attempts");
      const verifyCommands = parseCommands(queueDraft.verifyCommands);
      if (!beginAction()) return;
      started = true;

      if (queueDraft.kind === "create") {
        const created = await controller.createQueue({
          name,
          repoPath,
          ...(baseRef ? { baseRef } : {}),
          defaultProvider: provider,
          concurrency,
          maxAttempts,
          verifyCommands,
          autoCommit: queueDraft.autoCommit,
        });
        setSelectedQueueId(created.id);
        setFocus("queues");
        setNotice(`Created queue ${created.name}.`);
      } else {
        if (!queueDraft.queueId) throw new Error("The selected queue is no longer available.");
        const patch: UiQueuePatch = {
          name,
          baseRef,
          defaultProvider: provider,
          concurrency,
          maxAttempts,
          verifyCommands,
          autoCommit: queueDraft.autoCommit,
        };
        const updated = await controller.updateQueue(queueDraft.queueId, patch);
        setSelectedQueueId(updated.id);
        setNotice(`Updated queue ${updated.name}.`);
      }
      setQueueDraft(undefined);
      setMode("dashboard");
      await refresh();
    } catch (cause) {
      setQueueDraft((current) =>
        current ? { ...current, error: `Could not save queue: ${messageFrom(cause)}` } : current,
      );
    } finally {
      if (started) finishAction();
    }
  }, [actionPending, beginAction, controller, finishAction, queueDraft, refresh]);

  const runAction = useCallback(
    async (action: "cancel" | "retry" | "resume" | "done", task = selectedTask) => {
      if (!task || actionPending || !beginAction()) return;
      try {
        if (action === "cancel") await controller.cancelTask(task.id);
        if (action === "retry") await controller.retryTask(task.id);
        if (action === "resume") await controller.resumeTask(task.id);
        if (action === "done") await controller.completeManualTask(task.id);
        setMode("dashboard");
        setNotice(
          action === "cancel"
            ? `Cancellation requested for ${task.id}.`
            : action === "retry"
              ? `Retry queued for ${task.id}.`
              : action === "resume"
                ? `Resume queued for ${task.id}.`
                : `Marked ${task.id} complete.`,
        );
        await refresh();
      } catch (cause) {
        setMode("dashboard");
        setNotice(`${action} failed: ${messageFrom(cause)}`);
      } finally {
        finishAction();
      }
    },
    [actionPending, beginAction, controller, finishAction, refresh, selectedTask],
  );

  const openAttempts = useCallback(async () => {
    if (!selectedTask || actionPending) {
      if (!selectedTask) setNotice("Select a task to view attempts.");
      return;
    }
    if (!beginAction()) return;
    try {
      const nextRuns = await controller.listRuns(selectedTask.id);
      setRuns(nextRuns);
      setMode("attempts");
      setNotice(undefined);
    } catch (cause) {
      setMode("dashboard");
      setNotice(`Could not load attempts: ${messageFrom(cause)}`);
    } finally {
      finishAction();
    }
  }, [actionPending, beginAction, controller, finishAction, selectedTask]);

  const openDoctor = useCallback(async () => {
    if (actionPending || !beginAction()) return;
    setMode("doctor");
    setDoctorChecks([]);
    try {
      setDoctorChecks(await controller.doctor());
      setNotice(undefined);
    } catch (cause) {
      setMode("dashboard");
      setNotice(`Doctor failed: ${messageFrom(cause)}`);
    } finally {
      finishAction();
    }
  }, [actionPending, beginAction, controller, finishAction]);

  const toggleRepositoryScope = useCallback(async () => {
    if (actionPending) return;
    if (!context?.canToggle) {
      setMode("dashboard");
      setNotice("Repository scope cannot be changed from this location.");
      return;
    }
    const all = !context.all;
    if (!beginAction()) return;
    try {
      await Promise.resolve(controller.setAllRepositories(all));
      setSelectedQueueId(undefined);
      setSelectedTaskId(undefined);
      setMode("dashboard");
      await refresh();
      setNotice(all ? "Showing all repositories." : "Showing the current repository.");
    } catch (cause) {
      setMode("dashboard");
      setNotice(`Could not change repository scope: ${messageFrom(cause)}`);
    } finally {
      finishAction();
    }
  }, [actionPending, beginAction, context, controller, finishAction, refresh]);

  const runProviderLogin = useCallback(
    async (provider: Provider) => {
      if (actionPending || !beginAction()) return;
      setMode("dashboard");
      setNotice(`Opening ${provider === "codex" ? "Codex" : "Claude Code"} login…`);
      try {
        await suspendTerminal(async () => {
          await controller.loginProvider(provider);
        });
        const label = provider === "codex" ? "Codex" : "Claude Code";
        try {
          const checks = await controller.doctor();
          setDoctorChecks(checks);
          setMode("doctor");
          setNotice(`${label} login finished.`);
        } catch (cause) {
          setMode("dashboard");
          setNotice(
            `${label} login finished, but provider status refresh failed: ${messageFrom(cause)}`,
          );
        }
      } catch (cause) {
        setMode("dashboard");
        setNotice(`${provider} login failed: ${messageFrom(cause)}`);
      } finally {
        finishAction();
      }
    },
    [actionPending, beginAction, controller, finishAction, suspendTerminal],
  );

  const runIntegration = useCallback(
    async (target: IntegrationTarget, confirmedRepoPath?: string) => {
      if (actionPending) return;
      const repoPath = confirmedRepoPath ?? integrationRepositoryPath;
      if (!repoPath) {
        setMode("dashboard");
        setNotice("Select a repository queue before installing agent instructions.");
        return;
      }
      if (!beginAction()) return;
      try {
        const results = await controller.installIntegration(target, repoPath);
        setIntegrationResults(results);
        setMode("integration-results");
        setNotice(undefined);
      } catch (cause) {
        setMode("dashboard");
        setNotice(`Integration failed: ${messageFrom(cause)}`);
      } finally {
        finishAction();
      }
    },
    [actionPending, beginAction, controller, finishAction, integrationRepositoryPath],
  );

  const runConfirmation = useCallback(async () => {
    if (!confirmation || actionPending) return;
    const pending = confirmation;
    setConfirmation(undefined);
    if (pending.kind === "cancel" || pending.kind === "retry") {
      setMode("dashboard");
      await runAction(pending.kind, pending.task);
      return;
    }
    if (pending.kind === "integration") {
      await runIntegration(pending.target, pending.repoPath);
      return;
    }

    if (!beginAction()) return;
    try {
      if (pending.kind === "remove-queue") {
        await controller.deleteQueue(pending.queue.id);
        setSelectedQueueId(undefined);
        setMode("dashboard");
        setNotice(`Removed queue ${pending.queue.name}.`);
        await refresh();
      } else if (pending.kind === "clean") {
        const result = await controller.cleanTask(pending.task.id, { force: pending.force });
        setMode("dashboard");
        setNotice(`Removed worktree ${result.removedWorktree}.`);
        await refresh();
      }
    } catch (cause) {
      setMode("dashboard");
      setNotice(`${pending.kind} failed: ${messageFrom(cause)}`);
    } finally {
      finishAction();
    }
  }, [
    actionPending,
    beginAction,
    confirmation,
    controller,
    finishAction,
    refresh,
    runAction,
    runIntegration,
  ]);

  const cycleTaskFilter = useCallback(() => {
    setTaskFilter((current) => {
      const next =
        TASK_FILTERS[nextIndex(TASK_FILTERS.indexOf(current), TASK_FILTERS.length, 1)] ?? "all";
      setNotice(next === "all" ? "Showing tasks in every status." : `Showing ${next} tasks.`);
      return next;
    });
  }, []);

  const actionItems = useMemo<ActionItem[]>(() => {
    const taskSelected = selectedTask !== undefined;
    const queueSelected = selectedQueue !== undefined;
    const editable = selectedTask ? isTaskEditable(selectedTask) : false;
    const integrationAvailable = Boolean(integrationRepositoryPath);
    return [
      {
        id: "create-queue",
        label: "Create queue",
        detail: "Connect another Git repository queue",
        available: true,
      },
      {
        id: "edit-queue",
        label: "Edit selected queue",
        detail: "Provider, limits, verification, and commit policy",
        available: queueSelected,
      },
      {
        id: "remove-queue",
        label: "Remove selected queue",
        detail: "Only empty queues can be removed",
        available: queueSelected,
      },
      { id: "add-task", label: "Add task", detail: "Queue manual work", available: queueSelected },
      {
        id: "edit-task",
        label: "Edit selected task",
        detail: "Change the next attempt specification",
        available: editable,
      },
      {
        id: "cancel-task",
        label: "Cancel selected task",
        detail: "Request a graceful agent stop",
        available: Boolean(selectedTask && canCancelTask(selectedTask.status)),
      },
      {
        id: "retry-task",
        label: "Retry selected task",
        detail: "Start a fresh attempt and worktree",
        available: Boolean(selectedTask && canRetryTask(selectedTask.status)),
      },
      {
        id: "resume-task",
        label: "Resume selected task",
        detail: "Continue its retained provider session",
        available: Boolean(selectedTask && canRetryTask(selectedTask.status)),
      },
      {
        id: "complete-task",
        label: "Complete selected task",
        detail: "Mark non-running work done manually",
        available: Boolean(selectedTask && canCompleteTaskManually(selectedTask.status)),
      },
      {
        id: "attempts",
        label: "View attempts",
        detail: "Inspect run history and snapshots",
        available: taskSelected,
      },
      {
        id: "clean-task",
        label: "Clean retained worktree",
        detail: "Choose safe or force removal",
        available: Boolean(selectedTask && isTaskTerminal(selectedTask.status)),
      },
      {
        id: "filter-status",
        label: `Task filter: ${taskFilter}`,
        detail: "Cycle the dashboard status filter",
        available: true,
      },
      {
        id: "doctor",
        label: "Doctor & providers",
        detail: "Check Git and agent health",
        available: true,
      },
      {
        id: "login-codex",
        label: "Log in to Codex",
        detail: "Open the real Codex login flow",
        available: true,
      },
      {
        id: "login-claude",
        label: "Log in to Claude Code",
        detail: "Open the real Claude login flow",
        available: true,
      },
      {
        id: "integrate-codex",
        label: "Integrate Codex",
        detail: "Install repository agent instructions",
        available: integrationAvailable,
      },
      {
        id: "integrate-claude",
        label: "Integrate Claude Code",
        detail: "Install repository agent instructions",
        available: integrationAvailable,
      },
      {
        id: "integrate-all",
        label: "Integrate both providers",
        detail: "Install both instruction formats",
        available: integrationAvailable,
      },
      {
        id: "toggle-scope",
        label: context?.all ? "Show current repository" : "Show all repositories",
        detail: "Toggle dashboard queue scope",
        available: context?.canToggle ?? false,
      },
      {
        id: "refresh",
        label: "Refresh dashboard",
        detail: "Reload queues, tasks, and logs",
        available: true,
      },
      { id: "help", label: "Keyboard help", detail: "Show direct shortcuts", available: true },
      {
        id: "quit",
        label: "Quit AgentQ",
        detail: "Stop the foreground supervisor safely and requeue interrupted work",
        available: true,
      },
    ];
  }, [context, integrationRepositoryPath, selectedQueue, selectedTask, taskFilter]);

  const performAction = useCallback(
    (item: ActionItem) => {
      if (!item.available) {
        setNotice(`${item.label} is unavailable for the current selection.`);
        return;
      }
      switch (item.id) {
        case "create-queue":
          startCreateQueue();
          break;
        case "edit-queue":
          startEditQueue();
          break;
        case "remove-queue":
          if (selectedQueue) {
            setConfirmation({ kind: "remove-queue", queue: selectedQueue });
            setMode("confirm");
          }
          break;
        case "add-task":
          startAdd();
          break;
        case "edit-task":
          startEdit();
          break;
        case "cancel-task":
          if (selectedTask) {
            setConfirmation({ kind: "cancel", task: selectedTask });
            setMode("confirm");
          }
          break;
        case "retry-task":
          if (selectedTask) {
            setConfirmation({ kind: "retry", task: selectedTask });
            setMode("confirm");
          }
          break;
        case "resume-task":
          setMode("dashboard");
          void runAction("resume");
          break;
        case "complete-task":
          setMode("dashboard");
          void runAction("done");
          break;
        case "attempts":
          void openAttempts();
          break;
        case "clean-task":
          if (selectedTask) {
            setConfirmation({ kind: "clean", task: selectedTask, force: false });
            setMode("confirm");
          }
          break;
        case "filter-status":
          setMode("dashboard");
          cycleTaskFilter();
          break;
        case "doctor":
          void openDoctor();
          break;
        case "login-codex":
          void runProviderLogin("codex");
          break;
        case "login-claude":
          void runProviderLogin("claude");
          break;
        case "integrate-codex":
        case "integrate-claude":
        case "integrate-all": {
          const target: IntegrationTarget =
            item.id === "integrate-codex"
              ? "codex"
              : item.id === "integrate-claude"
                ? "claude"
                : "all";
          if (integrationRepositoryPath) {
            setConfirmation({ kind: "integration", target, repoPath: integrationRepositoryPath });
            setMode("confirm");
          }
          break;
        }
        case "toggle-scope":
          void toggleRepositoryScope();
          break;
        case "refresh":
          setMode("dashboard");
          void refresh().then((ok) => {
            if (mounted.current) setNotice(ok ? "Dashboard refreshed." : undefined);
          });
          break;
        case "help":
          setMode("help");
          break;
        case "quit":
          if (onExit) onExit();
          else exit();
          break;
      }
    },
    [
      exit,
      cycleTaskFilter,
      integrationRepositoryPath,
      onExit,
      openAttempts,
      openDoctor,
      refresh,
      runAction,
      runProviderLogin,
      selectedQueue,
      selectedTask,
      startAdd,
      startCreateQueue,
      startEdit,
      startEditQueue,
      toggleRepositoryScope,
    ],
  );

  useInput((input, key) => {
    if (mode === "help") {
      if (key.escape || input === "?") setMode("dashboard");
      return;
    }

    if (mode === "integration-results") {
      if (key.escape || key.return) setMode("dashboard");
      return;
    }

    if (mode === "attempts") {
      if (key.escape || input === "v") setMode("dashboard");
      return;
    }

    if (mode === "doctor") {
      if (key.escape) {
        setMode("dashboard");
        return;
      }
      if (input === "R") void openDoctor();
      if (input === "c") void runProviderLogin("codex");
      if (input === "l") void runProviderLogin("claude");
      return;
    }

    if (mode === "actions") {
      if (key.escape || input === ":") {
        setMode("dashboard");
        return;
      }
      if (key.upArrow || input === "k") {
        setActionIndex((current) => nextIndex(current, actionItems.length, -1));
        return;
      }
      if (key.downArrow || input === "j") {
        setActionIndex((current) => nextIndex(current, actionItems.length, 1));
        return;
      }
      if (key.return) {
        const item = actionItems[actionIndex];
        if (item) performAction(item);
      }
      return;
    }

    if (mode === "confirm" && confirmation) {
      if (key.escape || input === "n") {
        setConfirmation(undefined);
        setMode("dashboard");
        return;
      }
      if (
        confirmation.kind === "clean" &&
        (input === "f" || key.leftArrow || key.rightArrow || key.upArrow || key.downArrow)
      ) {
        setConfirmation((current) =>
          current?.kind === "clean" ? { ...current, force: !current.force } : current,
        );
        return;
      }
      if (key.return || input === "y") void runConfirmation();
      return;
    }

    if (mode === "queue-form" && queueDraft) {
      if (key.escape) {
        setMode("dashboard");
        setQueueDraft(undefined);
        return;
      }
      if (key.ctrl && input === "s") {
        void submitQueue();
        return;
      }
      const providerField = queueDraft.kind === "create" ? 3 : 2;
      const autoCommitField = queueDraft.kind === "create" ? 7 : 6;
      const fieldCount = autoCommitField + 1;
      if (key.tab) {
        setQueueDraft((current) =>
          current
            ? { ...current, field: nextIndex(current.field, fieldCount, key.shift ? -1 : 1) }
            : current,
        );
        return;
      }
      if (
        queueDraft.field === providerField &&
        (key.leftArrow || key.upArrow || key.rightArrow || key.downArrow)
      ) {
        const delta = key.leftArrow || key.upArrow ? -1 : 1;
        setQueueDraft((current) =>
          current
            ? {
                ...current,
                providerIndex: nextIndex(current.providerIndex, PROVIDERS.length, delta),
                error: undefined,
              }
            : current,
        );
        return;
      }
      if (
        queueDraft.field === autoCommitField &&
        (input === " " || key.leftArrow || key.upArrow || key.rightArrow || key.downArrow)
      ) {
        setQueueDraft((current) =>
          current ? { ...current, autoCommit: !current.autoCommit, error: undefined } : current,
        );
        return;
      }
      if (key.return) {
        if (queueDraft.field < autoCommitField) {
          setQueueDraft((current) =>
            current ? { ...current, field: current.field + 1 } : current,
          );
        } else {
          void submitQueue();
        }
        return;
      }

      const createFields = [
        "name",
        "repoPath",
        "baseRef",
        undefined,
        "concurrency",
        "maxAttempts",
        "verifyCommands",
        undefined,
      ] as const;
      const editFields = [
        "name",
        "baseRef",
        undefined,
        "concurrency",
        "maxAttempts",
        "verifyCommands",
        undefined,
      ] as const;
      const textField = (queueDraft.kind === "create" ? createFields : editFields)[
        queueDraft.field
      ];
      if (textField && ((key.ctrl && input === "u") || key.backspace || key.delete)) {
        setQueueDraft((current) => {
          if (!current) return current;
          const value = current[textField];
          return {
            ...current,
            [textField]: key.ctrl ? "" : value.slice(0, -1),
            error: undefined,
          };
        });
        return;
      }
      if (textField && !key.ctrl && !key.meta && input) {
        setQueueDraft((current) =>
          current
            ? { ...current, [textField]: current[textField] + input, error: undefined }
            : current,
        );
      }
      return;
    }

    if (mode === "edit" && editDraft) {
      if (key.escape) {
        setMode("dashboard");
        setEditDraft(undefined);
        return;
      }
      if (key.ctrl && input === "s") {
        void submitEdit();
        return;
      }
      if (key.tab) {
        setEditDraft((current) =>
          current
            ? {
                ...current,
                field: nextIndex(current.field, 5, key.shift ? -1 : 1) as EditDraft["field"],
              }
            : current,
        );
        return;
      }
      if (
        editDraft.field === 0 &&
        (key.leftArrow || key.upArrow || key.rightArrow || key.downArrow)
      ) {
        const delta = key.leftArrow || key.upArrow ? -1 : 1;
        setEditDraft((current) =>
          current
            ? {
                ...current,
                providerIndex: nextIndex(current.providerIndex, PROVIDERS.length, delta),
                error: undefined,
              }
            : current,
        );
        return;
      }
      if (key.return) {
        if (editDraft.field < 4) {
          setEditDraft((current) =>
            current ? { ...current, field: (current.field + 1) as EditDraft["field"] } : current,
          );
        } else {
          void submitEdit();
        }
        return;
      }
      if ((key.ctrl && input === "u") || key.backspace || key.delete) {
        setEditDraft((current) => {
          if (!current || current.field === 0) return current;
          const field =
            current.field === 1
              ? "priority"
              : current.field === 2
                ? "title"
                : current.field === 3
                  ? "instructions"
                  : "acceptanceCriteria";
          return {
            ...current,
            [field]: key.ctrl ? "" : current[field].slice(0, -1),
            error: undefined,
          };
        });
        return;
      }
      if (!key.ctrl && !key.meta && input && editDraft.field > 0) {
        setEditDraft((current) => {
          if (!current || current.field === 0) return current;
          const field =
            current.field === 1
              ? "priority"
              : current.field === 2
                ? "title"
                : current.field === 3
                  ? "instructions"
                  : "acceptanceCriteria";
          return { ...current, [field]: current[field] + input, error: undefined };
        });
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
                field: nextIndex(current.field, 7, key.shift ? -1 : 1) as AddDraft["field"],
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
            const currentIndex = snapshot.queues.findIndex((queue) => queue.id === current.queueId);
            const nextQueue =
              currentIndex < 0
                ? snapshot.queues[delta < 0 ? snapshot.queues.length - 1 : 0]
                : snapshot.queues[nextIndex(currentIndex, snapshot.queues.length, delta)];
            if (!nextQueue) {
              return {
                ...current,
                error: "Selected queue is no longer available.",
              };
            }
            return {
              ...current,
              queueId: nextQueue.id,
              error: undefined,
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
        if (draft.field < 6) {
          setDraft((current) =>
            current ? { ...current, field: (current.field + 1) as AddDraft["field"] } : current,
          );
        } else {
          void submitAdd();
        }
        return;
      }
      if ((key.ctrl && input === "u") || key.backspace || key.delete) {
        setDraft((current) => {
          if (!current || current.field < 2) return current;
          const keyName =
            current.field === 2
              ? "title"
              : current.field === 3
                ? "instructions"
                : current.field === 4
                  ? "priority"
                  : current.field === 5
                    ? "acceptanceCriteria"
                    : "idempotencyKey";
          return {
            ...current,
            [keyName]: key.ctrl ? "" : current[keyName].slice(0, -1),
            error: undefined,
          };
        });
        return;
      }
      if (!key.ctrl && !key.meta && input && draft.field >= 2) {
        setDraft((current) => {
          if (!current) return current;
          const keyName =
            current.field === 2
              ? "title"
              : current.field === 3
                ? "instructions"
                : current.field === 4
                  ? "priority"
                  : current.field === 5
                    ? "acceptanceCriteria"
                    : "idempotencyKey";
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
    if (input === "1" || input === "2" || input === "3") {
      const next = FOCUS_ORDER[Number(input) - 1] ?? "queues";
      setFocus(next);
      setZoomedPane((zoomed) => (zoomed ? next : zoomed));
      return;
    }
    if (input === "j") {
      moveSelection(1);
      return;
    }
    if (input === "k") {
      moveSelection(-1);
      return;
    }
    if (input === "[" || input === "]") {
      const enlarged = input === "]";
      setWeights((current) =>
        resizePaneWeights(current, focus, enlarged ? PANE_RESIZE_STEP : -PANE_RESIZE_STEP),
      );
      setNotice(`${focus} pane ${enlarged ? "enlarged" : "reduced"}.`);
      return;
    }
    if (input === "0") {
      setWeights({ ...DEFAULT_PANE_WEIGHTS });
      setNotice("Layout reset.");
      return;
    }
    if (input === "z") {
      const next = zoomedPane === focus ? undefined : focus;
      setZoomedPane(next);
      setNotice(next ? `${focus} pane zoomed.` : "Pane zoom cleared.");
      return;
    }
    if (input === ":") {
      setActionIndex(0);
      setMode("actions");
      setNotice(undefined);
      return;
    }
    if (input === "n") {
      startCreateQueue();
      return;
    }
    if (input === "a") {
      startAdd();
      return;
    }
    if (input === "e") {
      if (focus === "queues") startEditQueue();
      else startEdit();
      return;
    }
    if (input === "?") {
      setMode("help");
      return;
    }
    if (input === "c" && selectedTask && canCancelTask(selectedTask.status)) {
      setConfirmation({ kind: "cancel", task: selectedTask });
      setMode("confirm");
      return;
    }
    if (input === "r" && selectedTask && canRetryTask(selectedTask.status)) {
      setConfirmation({ kind: "retry", task: selectedTask });
      setMode("confirm");
      return;
    }
    if (input === "s" && selectedTask && canRetryTask(selectedTask.status)) {
      void runAction("resume");
      return;
    }
    if (input === "d" && selectedTask && canCompleteTaskManually(selectedTask.status)) {
      void runAction("done");
      return;
    }
    if (input === "v" && selectedTask) {
      void openAttempts();
      return;
    }
    if (input === "x") {
      if (focus === "queues" && selectedQueue) {
        setConfirmation({ kind: "remove-queue", queue: selectedQueue });
        setMode("confirm");
      } else if (selectedTask && isTaskTerminal(selectedTask.status)) {
        setConfirmation({ kind: "clean", task: selectedTask, force: false });
        setMode("confirm");
      } else {
        setNotice("Cancel or finish the task before cleaning its worktree.");
      }
      return;
    }
    if (input === "f") {
      cycleTaskFilter();
      return;
    }
    if (input === "g") {
      void toggleRepositoryScope();
      return;
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

  if (mode === "help") {
    return (
      <Box
        width={columns}
        height={rows}
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
        overflow="hidden"
      >
        <Box
          width={Math.max(1, Math.min(columns - 2, 76))}
          borderStyle="double"
          borderColor="cyan"
          paddingX={columns >= 50 ? 2 : 1}
          flexDirection="column"
        >
          <Text bold color="cyan">
            KEYBOARD HELP
          </Text>
          <Text dimColor>
            Context: {focus} {displayScope ? `· ${sanitizeTerminalText(displayScope)}` : ""}
          </Text>
          <Text>
            <Text bold>1 / 2 / 3</Text> focus queues / tasks / details
          </Text>
          <Text>
            <Text bold>tab / ← →</Text> cycle focus · <Text bold>↑ ↓ / j / k</Text> select
          </Text>
          <Text>
            <Text bold>n</Text> new queue · <Text bold>a</Text> add task · <Text bold>e</Text>{" "}
            contextual edit · <Text bold>x</Text> remove / clean
          </Text>
          <Text>
            <Text bold>c</Text> cancel · <Text bold>r</Text> retry · <Text bold>s</Text> resume ·{" "}
            <Text bold>d</Text> done · <Text bold>v</Text> attempts
          </Text>
          <Text>
            <Text bold>[ / ]</Text> resize focused pane · <Text bold>0</Text> reset ·{" "}
            <Text bold>z</Text> zoom · <Text bold>f</Text> status filter
          </Text>
          <Text>
            <Text bold>:</Text> action center · <Text bold>g</Text> local / all ·{" "}
            <Text bold>R</Text> refresh · <Text bold>q</Text> quit · <Text bold>? / esc</Text> close
          </Text>
          <Text dimColor>Forms: tab fields · ctrl+u clear · ctrl+s save · esc cancel</Text>
        </Box>
      </Box>
    );
  }

  if (mode === "actions") {
    const rowCapacity = Math.max(3, rows - 9);
    const visible = windowItems(actionItems, actionIndex, rowCapacity);
    const selected = actionItems[actionIndex];
    return (
      <Box width={columns} height={rows} flexDirection="column" overflow="hidden">
        <Header
          tasks={snapshot.tasks}
          focus={focus}
          narrow={columns < 72}
          scopeLabel={displayScope}
        />
        <Box flexGrow={1} alignItems="center" overflow="hidden">
          <Box
            width={Math.max(1, Math.min(columns - 2, 82))}
            height={Math.max(1, rows - 4)}
            borderStyle="double"
            borderColor="cyan"
            paddingX={columns >= 50 ? 2 : 1}
            flexDirection="column"
            overflow="hidden"
          >
            <Box justifyContent="space-between">
              <Text bold color="cyan">
                ACTION CENTER
              </Text>
              <Text dimColor>
                {actionIndex + 1}/{actionItems.length}
              </Text>
            </Box>
            {visible.items.map((item, offset) => {
              const index = visible.start + offset;
              const active = index === actionIndex;
              return (
                <Text
                  key={item.id}
                  bold={active}
                  color={!item.available ? "gray" : active ? "cyan" : undefined}
                  wrap="truncate-end"
                >
                  {active ? "›" : " "} {item.available ? " " : "×"} {item.label}
                </Text>
              );
            })}
            <Box marginTop={1} borderTop borderColor="gray" flexDirection="column">
              <Text bold>{sanitizeTerminalText(selected?.label ?? "")}</Text>
              <Text dimColor wrap="truncate-end">
                {sanitizeTerminalText(selected?.detail ?? "")}
              </Text>
              {notice ? (
                <Text color="yellow" wrap="truncate-end">
                  {sanitizeTerminalText(notice)}
                </Text>
              ) : null}
              <Text dimColor>↑↓ / j k select · enter run · : / esc close</Text>
            </Box>
          </Box>
        </Box>
      </Box>
    );
  }

  if (mode === "queue-form" && queueDraft) {
    const provider = PROVIDERS[queueDraft.providerIndex] ?? "codex";
    const fields: FormField[] =
      queueDraft.kind === "create"
        ? [
            {
              label: "Name",
              value: queueDraft.name,
              focused: queueDraft.field === 0,
              textInput: true,
            },
            {
              label: "Repository",
              value: queueDraft.repoPath,
              focused: queueDraft.field === 1,
              textInput: true,
            },
            {
              label: "Base ref",
              value: queueDraft.baseRef || "auto (current branch)",
              focused: queueDraft.field === 2,
              textInput: true,
            },
            { label: "Provider", value: provider, focused: queueDraft.field === 3 },
            {
              label: "Concurrency",
              value: queueDraft.concurrency,
              focused: queueDraft.field === 4,
              textInput: true,
            },
            {
              label: "Max attempts",
              value: queueDraft.maxAttempts,
              focused: queueDraft.field === 5,
              textInput: true,
            },
            {
              label: "Verify commands",
              value: queueDraft.verifyCommands || "none",
              focused: queueDraft.field === 6,
              multiline: true,
              textInput: true,
            },
            {
              label: "Auto-commit",
              value: queueDraft.autoCommit ? "on" : "off",
              focused: queueDraft.field === 7,
            },
          ]
        : [
            {
              label: "Name",
              value: queueDraft.name,
              focused: queueDraft.field === 0,
              textInput: true,
            },
            { label: "Repository (read-only)", value: queueDraft.repoPath, focusable: false },
            {
              label: "Base ref",
              value: queueDraft.baseRef,
              focused: queueDraft.field === 1,
              textInput: true,
            },
            { label: "Provider", value: provider, focused: queueDraft.field === 2 },
            {
              label: "Concurrency",
              value: queueDraft.concurrency,
              focused: queueDraft.field === 3,
              textInput: true,
            },
            {
              label: "Max attempts",
              value: queueDraft.maxAttempts,
              focused: queueDraft.field === 4,
              textInput: true,
            },
            {
              label: "Verify commands",
              value: queueDraft.verifyCommands || "none",
              focused: queueDraft.field === 5,
              multiline: true,
              textInput: true,
            },
            {
              label: "Auto-commit",
              value: queueDraft.autoCommit ? "on" : "off",
              focused: queueDraft.field === 6,
            },
          ];
    return (
      <FormScreen
        columns={columns}
        rows={rows}
        title={queueDraft.kind === "create" ? "CREATE QUEUE" : "EDIT QUEUE"}
        subtitle={
          queueDraft.kind === "create"
            ? "Connect a Git repository to a durable parallel queue."
            : "Repository (read-only); update this queue's execution policy."
        }
        fields={fields}
        error={queueDraft.error}
        footer="ctrl+s save · esc cancel · ←→ change · tab fields · ctrl+u clear · ; separates commands"
      />
    );
  }

  if (mode === "attempts" && selectedTask) {
    const capacity = Math.max(1, Math.floor((rows - 10) / 4));
    const visibleRuns = runs.slice(0, capacity);
    return (
      <Box width={columns} height={rows} flexDirection="column" overflow="hidden">
        <Header
          tasks={snapshot.tasks}
          focus={focus}
          narrow={columns < 72}
          scopeLabel={displayScope}
        />
        <Box flexGrow={1} alignItems="center" overflow="hidden">
          <Box
            width={Math.max(1, Math.min(columns - 2, 96))}
            height={Math.max(1, rows - 4)}
            borderStyle="double"
            borderColor="magenta"
            paddingX={columns >= 50 ? 2 : 1}
            flexDirection="column"
            overflow="hidden"
          >
            <Text bold color="magenta">
              ATTEMPTS · {sanitizeTerminalText(selectedTask.title)}
            </Text>
            {runs.length === 0 ? <Text dimColor>No attempts have started.</Text> : null}
            {visibleRuns.map((run) => (
              <Box key={run.id} flexDirection="column" marginBottom={1}>
                <Text>
                  <Text
                    bold
                    color={
                      run.status === "succeeded"
                        ? "green"
                        : run.status === "failed"
                          ? "red"
                          : "cyan"
                    }
                  >
                    #{run.attemptNo} {run.status.toUpperCase()}
                  </Text>
                  <Text dimColor>
                    {" "}
                    · {run.provider} · {run.id}
                  </Text>
                </Text>
                <Text dimColor wrap="truncate-end">
                  {sanitizeTerminalText(runSummary(run))}
                </Text>
                <Text dimColor wrap="truncate-end">
                  {run.taskSnapshot
                    ? `Spec: ${sanitizeTerminalText(run.taskSnapshot.title)} · ${run.taskSnapshot.provider} · priority ${run.taskSnapshot.priority}`
                    : "Spec snapshot unavailable (legacy attempt)"}
                </Text>
                <Text dimColor wrap="truncate-end">
                  {run.worktreePath
                    ? sanitizeTerminalText(run.worktreePath)
                    : "No worktree recorded"}
                </Text>
              </Box>
            ))}
            {runs.length > visibleRuns.length ? (
              <Text dimColor>
                … {runs.length - visibleRuns.length} older attempts hidden at this size
              </Text>
            ) : null}
            <Text dimColor>v / esc back</Text>
          </Box>
        </Box>
      </Box>
    );
  }

  if (mode === "doctor") {
    const capacity = Math.max(1, Math.floor((rows - 9) / 2));
    const visibleChecks = doctorChecks.slice(0, capacity);
    return (
      <Box width={columns} height={rows} flexDirection="column" overflow="hidden">
        <Header
          tasks={snapshot.tasks}
          focus={focus}
          narrow={columns < 72}
          scopeLabel={displayScope}
        />
        <Box flexGrow={1} alignItems="center" overflow="hidden">
          <Box
            width={Math.max(1, Math.min(columns - 2, 96))}
            height={Math.max(1, rows - 4)}
            borderStyle="double"
            borderColor="cyan"
            paddingX={columns >= 50 ? 2 : 1}
            flexDirection="column"
            overflow="hidden"
          >
            <Text bold color="cyan">
              DOCTOR / PROVIDERS
            </Text>
            {doctorChecks.length === 0 ? <Text dimColor>Running checks…</Text> : null}
            {visibleChecks.map((check) => (
              <Box key={check.name} flexDirection="column">
                <Text color={check.ok ? "green" : "red"} wrap="truncate-end">
                  {check.ok ? "✓" : "✗"} {sanitizeTerminalText(check.name)} ·{" "}
                  {sanitizeTerminalText(check.detail)}
                </Text>
                {check.remediation ? (
                  <Text dimColor wrap="truncate-end">
                    {" "}
                    {sanitizeTerminalText(check.remediation)}
                  </Text>
                ) : null}
              </Box>
            ))}
            {doctorChecks.length > visibleChecks.length ? (
              <Text dimColor>
                … {doctorChecks.length - visibleChecks.length} checks hidden at this size
              </Text>
            ) : null}
            {notice ? <Text color="yellow">{sanitizeTerminalText(notice)}</Text> : null}
            <Box marginTop={1} borderTop borderColor="gray">
              <Text dimColor>c login Codex · l login Claude Code · R rerun · esc back</Text>
            </Box>
          </Box>
        </Box>
      </Box>
    );
  }

  if (mode === "integration-results") {
    return (
      <Box width={columns} height={rows} flexDirection="column" overflow="hidden">
        <Header
          tasks={snapshot.tasks}
          focus={focus}
          narrow={columns < 72}
          scopeLabel={displayScope}
        />
        <Box flexGrow={1} alignItems="center" justifyContent="center" overflow="hidden">
          <Box
            width={Math.max(1, Math.min(columns - 4, 88))}
            borderStyle="double"
            borderColor="green"
            paddingX={columns >= 50 ? 2 : 1}
            paddingY={1}
            flexDirection="column"
          >
            <Text bold color="green">
              INTEGRATION COMPLETE
            </Text>
            {integrationResults.map((result) => (
              <Text key={result.file} wrap="truncate-end">
                <Text color={result.action === "unchanged" ? "gray" : "green"}>
                  {result.action === "created" ? "+" : result.action === "updated" ? "~" : "="}
                </Text>{" "}
                {sanitizeTerminalText(result.file)} · {result.action}
              </Text>
            ))}
            <Text dimColor>enter / esc return to dashboard</Text>
          </Box>
        </Box>
      </Box>
    );
  }

  if (mode === "edit" && editDraft) {
    return (
      <FormScreen
        columns={columns}
        rows={rows}
        title="EDIT TASK"
        subtitle="Changes apply to the next attempt and keep existing run history."
        fields={[
          {
            label: "Provider",
            value: PROVIDERS[editDraft.providerIndex] ?? "No provider",
            focused: editDraft.field === 0,
          },
          {
            label: "Priority",
            value: editDraft.priority,
            focused: editDraft.field === 1,
            textInput: true,
          },
          {
            label: "Title",
            value: editDraft.title,
            focused: editDraft.field === 2,
            textInput: true,
          },
          {
            label: "Instructions",
            value: editDraft.instructions,
            focused: editDraft.field === 3,
            multiline: true,
            textInput: true,
          },
          {
            label: "Acceptance criteria",
            value: editDraft.acceptanceCriteria,
            focused: editDraft.field === 4,
            multiline: true,
            textInput: true,
          },
        ]}
        error={editDraft.error}
        footer="ctrl+s save · esc cancel · ←→ provider · enter next/submit · tab next · ctrl+u clear"
      />
    );
  }

  if (mode === "add" && draft) {
    const queue = snapshot.queues.find((candidate) => candidate.id === draft.queueId);
    const provider = PROVIDERS[draft.providerIndex];
    return (
      <FormScreen
        columns={columns}
        rows={rows}
        title="ADD TASK"
        subtitle="Choose the queue and provider, then describe the outcome."
        fields={[
          {
            label: "Queue",
            value: queue?.name ?? "Queue unavailable (removed)",
            focused: draft.field === 0,
          },
          {
            label: "Provider",
            value: provider ?? "No provider",
            focused: draft.field === 1,
          },
          {
            label: "Title",
            value: draft.title,
            focused: draft.field === 2,
            textInput: true,
          },
          {
            label: "Instructions",
            value: draft.instructions,
            focused: draft.field === 3,
            multiline: true,
            textInput: true,
          },
          {
            label: "Priority",
            value: draft.priority,
            focused: draft.field === 4,
            textInput: true,
          },
          {
            label: "Acceptance",
            value: draft.acceptanceCriteria,
            focused: draft.field === 5,
            multiline: true,
            textInput: true,
          },
          {
            label: "Idempotency key",
            value: draft.idempotencyKey,
            focused: draft.field === 6,
            textInput: true,
          },
        ]}
        error={draft.error}
        footer="ctrl+s submit · esc cancel · ←→ choose · tab next · ctrl+u clear · ; separates criteria"
      />
    );
  }

  if (mode === "confirm" && confirmation) {
    const title =
      confirmation.kind === "cancel"
        ? "CANCEL TASK?"
        : confirmation.kind === "retry"
          ? "RETRY TASK?"
          : confirmation.kind === "remove-queue"
            ? "REMOVE QUEUE?"
            : confirmation.kind === "clean"
              ? "CLEAN WORKTREE?"
              : "INSTALL INTEGRATION?";
    const subject =
      confirmation.kind === "remove-queue"
        ? confirmation.queue.name
        : confirmation.kind === "integration"
          ? confirmation.target === "all"
            ? "Codex + Claude Code"
            : confirmation.target === "codex"
              ? "Codex"
              : "Claude Code"
          : confirmation.task.title;
    const description =
      confirmation.kind === "cancel"
        ? "The agent process will receive a graceful stop request."
        : confirmation.kind === "retry"
          ? "A fresh isolated attempt and provider session will be queued."
          : confirmation.kind === "remove-queue"
            ? "The queue must be empty. Tasks and history are never silently deleted."
            : confirmation.kind === "clean"
              ? confirmation.force
                ? "Force removal discards uncommitted work in the retained worktree."
                : "Safe removal stops if the retained worktree has uncommitted changes."
              : "Repository instructions will be installed in:";
    const destructive =
      confirmation.kind === "cancel" ||
      confirmation.kind === "remove-queue" ||
      (confirmation.kind === "clean" && confirmation.force);
    return (
      <Box width={columns} height={rows} flexDirection="column">
        <Header
          tasks={snapshot.tasks}
          focus={focus}
          narrow={columns < 72}
          scopeLabel={displayScope}
        />
        <Box flexGrow={1} alignItems="center" justifyContent="center">
          <Box
            width={Math.max(1, Math.min(columns - 4, 64))}
            borderStyle="double"
            borderColor={destructive ? "yellow" : "magenta"}
            paddingX={2}
            paddingY={1}
            flexDirection="column"
          >
            <Text bold color={destructive ? "yellow" : "magenta"}>
              {title}
            </Text>
            <Text wrap="truncate-end">{sanitizeTerminalText(subject)}</Text>
            <Text dimColor wrap="truncate-end">
              {sanitizeTerminalText(description)}
            </Text>
            {confirmation.kind === "integration" ? (
              <Text color="cyan" wrap="truncate-end">
                {sanitizeTerminalText(confirmation.repoPath)}
              </Text>
            ) : null}
            {confirmation.kind === "clean" ? (
              <Text>
                Removal mode:{" "}
                <Text bold color={confirmation.force ? "red" : "green"}>
                  {confirmation.force ? "FORCE" : "SAFE"}
                </Text>{" "}
                <Text dimColor>(f / arrows toggle)</Text>
              </Text>
            ) : null}
            <Text>
              <Text bold>y / enter</Text> confirm <Text bold>n / esc</Text> go back
            </Text>
          </Box>
        </Box>
      </Box>
    );
  }

  const narrow = columns < 72;
  const wide = columns >= 110;
  const bodyHeight = Math.max(1, rows - 5);
  const widths = paneWidths(columns, weights);
  const singlePane = narrow || zoomedPane !== undefined;
  const mediumQueueWidth = Math.max(16, Math.min(columns - 24, widths.queues));
  const stackMinimum = Math.min(6, Math.max(1, Math.floor(bodyHeight / 3)));
  const taskShare = weights.tasks / (weights.tasks + weights.details);
  const mediumTaskHeight = Math.max(
    stackMinimum,
    Math.min(bodyHeight - stackMinimum, Math.floor(bodyHeight * taskShare)),
  );
  const mediumDetailsHeight = Math.max(1, bodyHeight - mediumTaskHeight);
  const queuePane = (
    <QueuePane
      queues={snapshot.queues}
      tasks={snapshot.tasks}
      selectedId={selectedQueueId}
      active={focus === "queues"}
      height={bodyHeight}
      width={singlePane ? "100%" : wide ? widths.queues : mediumQueueWidth}
      scopeLabel={displayScope}
      showRepositories={context?.all ?? false}
    />
  );
  const taskPane = (
    <TaskPane
      tasks={visibleTasks}
      filter={taskFilter}
      selectedId={selectedTaskId}
      active={focus === "tasks"}
      height={singlePane || wide ? bodyHeight : mediumTaskHeight}
      width={singlePane ? "100%" : wide ? widths.tasks : undefined}
    />
  );
  const detailsPane = (
    <DetailsPane
      task={selectedTask}
      queue={selectedQueue}
      events={events}
      active={focus === "details"}
      height={singlePane || wide ? bodyHeight : mediumDetailsHeight}
      width={singlePane ? "100%" : wide ? widths.details : undefined}
    />
  );
  const focusedPane =
    zoomedPane === "queues" ? queuePane : zoomedPane === "tasks" ? taskPane : detailsPane;

  return (
    <Box width={columns} height={rows} flexDirection="column" overflow="hidden">
      <Header tasks={snapshot.tasks} focus={focus} narrow={narrow} scopeLabel={displayScope} />
      {zoomedPane ? (
        <Box height={bodyHeight} overflow="hidden">
          {focusedPane}
        </Box>
      ) : narrow ? (
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
      <Footer
        notice={notice ?? error}
        narrow={narrow}
        task={selectedTask}
        focus={focus}
        queue={selectedQueue}
        canToggle={context?.canToggle ?? false}
      />
    </Box>
  );
}
