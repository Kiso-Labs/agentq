import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import stringWidth from "string-width";
import {
  BASE_DRIFT_POLICIES,
  canCancelTask,
  canCompleteTaskManually,
  canRetryTask,
  FILE_CONCURRENCY_MODES,
  isTaskActive,
  isTaskTerminal,
  LAND_STRATEGIES,
  PROVIDERS,
  type Provider,
  type Queue,
  type Run,
  TASK_STATUSES,
  type Task,
  type TaskEvent,
} from "../core/types.ts";
import type { IntegrationResult, IntegrationTarget } from "../integrations/instructions.ts";
import {
  type ActivityEntry,
  type ActivityTone,
  activityEntries,
  visibleActivityEntries,
} from "./activity.ts";
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

interface TaskDraftFields {
  providerIndex: number;
  priority: string;
  title: string;
  instructions: string;
  acceptanceCriteria: string;
  objective: string;
  invariants: string;
  handoffRequirements: string;
  blockedBy: string;
  expectedPaths: string;
  allowedPaths: string;
  deniedPaths: string;
  maxChangedFiles: string;
  verifyCommands: string;
  approvalCheckpoints: string;
  baseDriftPolicyIndex: number;
  landStrategyIndex: number;
  idempotencyKey: string;
  field: number;
  error?: string;
}

interface AddDraft extends TaskDraftFields {
  queueId: string;
}

interface EditDraft extends TaskDraftFields {
  taskId: string;
  expectedUpdatedAt: string;
}

type TaskDraftTextKey =
  | "priority"
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
  | "idempotencyKey";

type TaskFormControl =
  | { kind: "queue"; label: string; focusIndex: number }
  | { kind: "provider"; label: string; focusIndex: number }
  | {
      kind: "text";
      key: TaskDraftTextKey;
      label: string;
      focusIndex: number;
      multiline?: boolean;
      placeholder?: string;
    }
  | {
      kind: "selector";
      key: "baseDriftPolicyIndex" | "landStrategyIndex";
      label: string;
      focusIndex: number;
      options: readonly string[];
    };

const TASK_STRUCTURED_CONTROLS = (firstIndex: number): readonly TaskFormControl[] => [
  {
    kind: "text",
    key: "objective",
    label: "Objective",
    focusIndex: firstIndex,
    multiline: true,
    placeholder: "Use title and instructions",
  },
  {
    kind: "text",
    key: "invariants",
    label: "Invariants",
    focusIndex: firstIndex + 1,
    multiline: true,
    placeholder: "none · separate with ; or ctrl+n",
  },
  {
    kind: "text",
    key: "handoffRequirements",
    label: "Handoff requirements",
    focusIndex: firstIndex + 2,
    multiline: true,
    placeholder: "none · separate with ; or ctrl+n",
  },
  {
    kind: "text",
    key: "blockedBy",
    label: "Blocked by task IDs",
    focusIndex: firstIndex + 3,
    multiline: true,
    placeholder: "none · separate with ; or ctrl+n",
  },
  {
    kind: "text",
    key: "expectedPaths",
    label: "Expected paths",
    focusIndex: firstIndex + 4,
    multiline: true,
    placeholder: "none · globs separated with ;",
  },
  {
    kind: "text",
    key: "allowedPaths",
    label: "Allowed paths",
    focusIndex: firstIndex + 5,
    multiline: true,
    placeholder: "inherit queue · globs separated with ;",
  },
  {
    kind: "text",
    key: "deniedPaths",
    label: "Denied paths",
    focusIndex: firstIndex + 6,
    multiline: true,
    placeholder: "inherit queue · globs separated with ;",
  },
  {
    kind: "text",
    key: "maxChangedFiles",
    label: "Maximum changed files",
    focusIndex: firstIndex + 7,
    placeholder: "inherit queue",
  },
  {
    kind: "text",
    key: "verifyCommands",
    label: "Verification commands",
    focusIndex: firstIndex + 8,
    multiline: true,
    placeholder: "inherit queue · separate with ; or ctrl+n",
  },
  {
    kind: "text",
    key: "approvalCheckpoints",
    label: "Approval checkpoints",
    focusIndex: firstIndex + 9,
    multiline: true,
    placeholder: "none · separate with ; or ctrl+n",
  },
  {
    kind: "selector",
    key: "baseDriftPolicyIndex",
    label: "Base drift policy",
    focusIndex: firstIndex + 10,
    options: BASE_DRIFT_POLICIES,
  },
  {
    kind: "selector",
    key: "landStrategyIndex",
    label: "Land strategy",
    focusIndex: firstIndex + 11,
    options: LAND_STRATEGIES,
  },
];

const ADD_TASK_CONTROLS: readonly TaskFormControl[] = [
  { kind: "queue", label: "Queue", focusIndex: 0 },
  { kind: "provider", label: "Provider", focusIndex: 1 },
  { kind: "text", key: "title", label: "Title", focusIndex: 2 },
  {
    kind: "text",
    key: "instructions",
    label: "Instructions",
    focusIndex: 3,
    multiline: true,
  },
  { kind: "text", key: "priority", label: "Priority", focusIndex: 4 },
  {
    kind: "text",
    key: "acceptanceCriteria",
    label: "Acceptance criteria",
    focusIndex: 5,
    multiline: true,
    placeholder: "none · separate with ; or ctrl+n",
  },
  {
    kind: "text",
    key: "idempotencyKey",
    label: "Idempotency key",
    focusIndex: 6,
    placeholder: "optional",
  },
  ...TASK_STRUCTURED_CONTROLS(7),
];

const EDIT_TASK_CONTROLS: readonly TaskFormControl[] = [
  { kind: "provider", label: "Provider", focusIndex: 0 },
  { kind: "text", key: "priority", label: "Priority", focusIndex: 1 },
  { kind: "text", key: "title", label: "Title", focusIndex: 2 },
  {
    kind: "text",
    key: "instructions",
    label: "Instructions",
    focusIndex: 3,
    multiline: true,
  },
  {
    kind: "text",
    key: "acceptanceCriteria",
    label: "Acceptance criteria",
    focusIndex: 4,
    multiline: true,
    placeholder: "none · separate with ; or ctrl+n",
  },
  ...TASK_STRUCTURED_CONTROLS(5),
];

interface QueueDraft {
  kind: "create" | "edit";
  queueId?: string;
  name: string;
  repoPath: string;
  baseRef: string;
  providerIndex: number;
  planModel: string;
  planInstructions: string;
  implementModel: string;
  implementInstructions: string;
  concurrency: string;
  maxAttempts: string;
  verifyCommands: string;
  autoCommit: boolean;
  allowedPaths: string;
  deniedPaths: string;
  maxChangedFiles: string;
  approvalCheckpoints: string;
  baseDriftPolicyIndex: number;
  landStrategyIndex: number;
  autoLand: boolean;
  fileConcurrencyIndex: number;
  field: number;
  error?: string;
}

type QueueDraftTextKey =
  | "name"
  | "repoPath"
  | "baseRef"
  | "planModel"
  | "planInstructions"
  | "implementModel"
  | "implementInstructions"
  | "concurrency"
  | "maxAttempts"
  | "verifyCommands"
  | "allowedPaths"
  | "deniedPaths"
  | "maxChangedFiles"
  | "approvalCheckpoints";

type QueueFormControl =
  | {
      kind: "text";
      key: QueueDraftTextKey;
      label: string;
      focusIndex: number;
      multiline?: boolean;
      placeholder?: string;
    }
  | { kind: "provider"; label: string; focusIndex: number }
  | {
      kind: "toggle";
      key: "autoCommit" | "autoLand";
      label: string;
      focusIndex: number;
    }
  | {
      kind: "selector";
      key: "baseDriftPolicyIndex" | "landStrategyIndex" | "fileConcurrencyIndex";
      label: string;
      focusIndex: number;
      options: readonly string[];
    }
  | { kind: "readonly"; key: "repoPath"; label: string };

const CREATE_QUEUE_CONTROLS: readonly QueueFormControl[] = [
  { kind: "text", key: "name", label: "Name", focusIndex: 0 },
  { kind: "text", key: "repoPath", label: "Repository", focusIndex: 1 },
  {
    kind: "text",
    key: "baseRef",
    label: "Base ref",
    focusIndex: 2,
    placeholder: "auto (current branch)",
  },
  { kind: "provider", label: "Provider", focusIndex: 3 },
  {
    kind: "text",
    key: "planModel",
    label: "Plan model",
    focusIndex: 4,
    placeholder: "provider default",
  },
  {
    kind: "text",
    key: "planInstructions",
    label: "Plan instructions",
    focusIndex: 5,
    multiline: true,
    placeholder: "none",
  },
  {
    kind: "text",
    key: "implementModel",
    label: "Implementation model",
    focusIndex: 6,
    placeholder: "provider default",
  },
  {
    kind: "text",
    key: "implementInstructions",
    label: "Implementation instructions",
    focusIndex: 7,
    multiline: true,
    placeholder: "none",
  },
  { kind: "text", key: "concurrency", label: "Concurrency", focusIndex: 8 },
  { kind: "text", key: "maxAttempts", label: "Max attempts", focusIndex: 9 },
  {
    kind: "text",
    key: "verifyCommands",
    label: "Verify commands",
    focusIndex: 10,
    multiline: true,
    placeholder: "none",
  },
  { kind: "toggle", key: "autoCommit", label: "Auto-commit", focusIndex: 11 },
  {
    kind: "text",
    key: "allowedPaths",
    label: "Allowed paths",
    focusIndex: 12,
    multiline: true,
    placeholder: "unrestricted · globs separated with ;",
  },
  {
    kind: "text",
    key: "deniedPaths",
    label: "Denied paths",
    focusIndex: 13,
    multiline: true,
    placeholder: "none · globs separated with ;",
  },
  {
    kind: "text",
    key: "maxChangedFiles",
    label: "Maximum changed files",
    focusIndex: 14,
    placeholder: "unlimited",
  },
  {
    kind: "text",
    key: "approvalCheckpoints",
    label: "Approval checkpoints",
    focusIndex: 15,
    multiline: true,
    placeholder: "none · separate with ; or ctrl+n",
  },
  {
    kind: "selector",
    key: "baseDriftPolicyIndex",
    label: "Base drift policy",
    focusIndex: 16,
    options: BASE_DRIFT_POLICIES,
  },
  {
    kind: "selector",
    key: "landStrategyIndex",
    label: "Land strategy",
    focusIndex: 17,
    options: LAND_STRATEGIES,
  },
  { kind: "toggle", key: "autoLand", label: "Auto-land", focusIndex: 18 },
  {
    kind: "selector",
    key: "fileConcurrencyIndex",
    label: "File concurrency",
    focusIndex: 19,
    options: FILE_CONCURRENCY_MODES,
  },
];

const EDIT_QUEUE_CONTROLS: readonly QueueFormControl[] = [
  { kind: "text", key: "name", label: "Name", focusIndex: 0 },
  { kind: "readonly", key: "repoPath", label: "Repository (read-only)" },
  { kind: "text", key: "baseRef", label: "Base ref", focusIndex: 1 },
  { kind: "provider", label: "Provider", focusIndex: 2 },
  {
    kind: "text",
    key: "planModel",
    label: "Plan model",
    focusIndex: 3,
    placeholder: "provider default",
  },
  {
    kind: "text",
    key: "planInstructions",
    label: "Plan instructions",
    focusIndex: 4,
    multiline: true,
    placeholder: "none",
  },
  {
    kind: "text",
    key: "implementModel",
    label: "Implementation model",
    focusIndex: 5,
    placeholder: "provider default",
  },
  {
    kind: "text",
    key: "implementInstructions",
    label: "Implementation instructions",
    focusIndex: 6,
    multiline: true,
    placeholder: "none",
  },
  { kind: "text", key: "concurrency", label: "Concurrency", focusIndex: 7 },
  { kind: "text", key: "maxAttempts", label: "Max attempts", focusIndex: 8 },
  {
    kind: "text",
    key: "verifyCommands",
    label: "Verify commands",
    focusIndex: 9,
    multiline: true,
    placeholder: "none",
  },
  { kind: "toggle", key: "autoCommit", label: "Auto-commit", focusIndex: 10 },
  {
    kind: "text",
    key: "allowedPaths",
    label: "Allowed paths",
    focusIndex: 11,
    multiline: true,
    placeholder: "unrestricted · globs separated with ;",
  },
  {
    kind: "text",
    key: "deniedPaths",
    label: "Denied paths",
    focusIndex: 12,
    multiline: true,
    placeholder: "none · globs separated with ;",
  },
  {
    kind: "text",
    key: "maxChangedFiles",
    label: "Maximum changed files",
    focusIndex: 13,
    placeholder: "unlimited",
  },
  {
    kind: "text",
    key: "approvalCheckpoints",
    label: "Approval checkpoints",
    focusIndex: 14,
    multiline: true,
    placeholder: "none · separate with ; or ctrl+n",
  },
  {
    kind: "selector",
    key: "baseDriftPolicyIndex",
    label: "Base drift policy",
    focusIndex: 15,
    options: BASE_DRIFT_POLICIES,
  },
  {
    kind: "selector",
    key: "landStrategyIndex",
    label: "Land strategy",
    focusIndex: 16,
    options: LAND_STRATEGIES,
  },
  { kind: "toggle", key: "autoLand", label: "Auto-land", focusIndex: 17 },
  {
    kind: "selector",
    key: "fileConcurrencyIndex",
    label: "File concurrency",
    focusIndex: 18,
    options: FILE_CONCURRENCY_MODES,
  },
];

const queueFormControls = (kind: QueueDraft["kind"]): readonly QueueFormControl[] =>
  kind === "create" ? CREATE_QUEUE_CONTROLS : EDIT_QUEUE_CONTROLS;

type Confirmation =
  | { kind: "cancel"; task: Task }
  | { kind: "retry"; task: Task }
  | { kind: "delete-queue"; queue: Queue }
  | { kind: "delete-task"; task: Task }
  | { kind: "clean"; task: Task; force: boolean }
  | { kind: "integration"; target: IntegrationTarget; repoPath: string };

type ActionId =
  | "create-queue"
  | "edit-queue"
  | "delete-queue"
  | "add-task"
  | "edit-task"
  | "delete-task"
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
  | "quit"
  | "approve-checkpoint"
  | "integrate-result"
  | "land-result";

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

const queueModelLabel = (queue: Queue, model: string): string =>
  model.trim() || `${queue.defaultProvider} default`;

const queueInstructionSummary = (instructions: string): string => {
  const summary = sanitizeTerminalText(instructions).replace(/\s+/gu, " ").trim();
  return summary || "none";
};

const workflowLabel = (value: string): string =>
  value.replace(/[_-]+/gu, " ").replace(/\s+/gu, " ").trim().toUpperCase();

const listSummary = (values: readonly string[], fallback = "none"): string =>
  values.length > 0 ? sanitizeTerminalText(values.join(", ")) : fallback;

const formatElapsed = (run: Run | undefined, task: Task): string => {
  const started = Date.parse(run?.startedAt ?? task.createdAt);
  const finished = Date.parse(
    run?.finishedAt ?? run?.heartbeatAt ?? task.completedAt ?? task.updatedAt,
  );
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) {
    return "unknown";
  }
  const seconds = Math.floor((finished - started) / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${remainder}s`;
  return `${remainder}s`;
};

const formatCost = (costUsd: number): string =>
  costUsd === 0 ? "$0" : `$${costUsd.toFixed(costUsd < 0.01 ? 4 : 2)}`;

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

const parseCommands = (value: string): string[] =>
  value
    .split(/[;\n]/u)
    .map((command) => command.trim())
    .filter((command) => command.length > 0);

const parseList = parseCommands;

const positiveIntegerFrom = (value: string, label: string): number => {
  if (!/^\d+$/u.test(value.trim())) throw new Error(`${label} must be a positive whole number.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive whole number.`);
  }
  return parsed;
};

const optionalPositiveIntegerFrom = (value: string, label: string): number | undefined =>
  value.trim() ? positiveIntegerFrom(value, label) : undefined;

const selectedOption = <T extends string>(options: readonly T[], index: number, fallback: T): T =>
  options[index] ?? fallback;

const selectedOptionIndex = <T extends string>(options: readonly T[], value: T): number =>
  Math.max(0, options.indexOf(value));

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
    typeof height === "number" ? Math.max(1, Math.floor((height - 3) / 2)) : tasks.length;
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
            <Box key={task.id} flexDirection="column" flexShrink={0}>
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

const ACTIVITY_COLOR: Record<ActivityTone, string | undefined> = {
  default: undefined,
  active: "cyan",
  muted: "gray",
  success: "green",
  warning: "yellow",
  error: "red",
};

function ActivityRow({ entry }: { entry: ActivityEntry }) {
  const color = ACTIVITY_COLOR[entry.tone];
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={color}>{entry.marker} </Text>
        <Text
          bold={entry.emphasis}
          color={color}
          dimColor={entry.tone === "muted"}
          wrap="truncate-end"
        >
          {entry.title}
        </Text>
      </Box>
      {entry.details.map((detail, index) => (
        <Box key={`${entry.key}-detail-${detail}`} marginLeft={2}>
          <Text dimColor>{index === 0 ? "└ " : "  "}</Text>
          <Text
            color={entry.tone === "error" || entry.tone === "warning" ? color : undefined}
            dimColor={entry.tone !== "error" && entry.tone !== "warning"}
            wrap="truncate-end"
          >
            {detail}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

function DetailsPane({
  task,
  queue,
  run,
  events,
  active,
  height,
  width,
}: {
  task?: Task;
  queue?: Queue;
  run?: Run;
  events: TaskEvent[];
  active: boolean;
  height?: number | string;
  width?: number | string;
}) {
  const activeRun =
    run && ["starting", "running", "cancelling"].includes(run.status) ? run : undefined;
  const activity = activityEntries(
    activeRun
      ? events.filter(
          (event) =>
            !(
              event.runId === activeRun.id &&
              event.kind === "workflow.phase" &&
              event.payload.phase === activeRun.phase &&
              event.payload.state === "started"
            ),
        )
      : events,
  );
  const workflow = activeRun?.taskSnapshot?.workflow;
  const activeModel =
    activeRun?.phase === "plan"
      ? (workflow?.planModel ?? queue?.planModel)
      : (workflow?.implementModel ?? queue?.implementModel);
  const activeStageFinished = activeRun
    ? events.some(
        (event) =>
          event.runId === activeRun.id &&
          event.kind === "workflow.phase" &&
          event.payload.phase === activeRun.phase &&
          (event.payload.state === "completed" || event.payload.state === "failed"),
      )
    : false;
  const activeStage: ActivityEntry | undefined =
    activeRun && !activeStageFinished
      ? {
          key: `active-${activeRun.id}-${activeRun.phase}`,
          marker: "›",
          title: `${activeRun.phase === "plan" ? "Planning" : "Implementing"} with ${
            activeRun.provider === "claude" ? "Claude Code" : "Codex"
          }${activeModel?.trim() ? ` · ${sanitizeTerminalText(activeModel.trim())}` : ""}`,
          details: [],
          tone: "active",
          emphasis: true,
        }
      : undefined;
  const verificationResults = task
    ? task.verificationResults.length > 0
      ? task.verificationResults
      : (run?.verificationResults ?? [])
    : [];
  const changedFiles = task
    ? task.changedFiles.length > 0
      ? task.changedFiles
      : (run?.changedFiles ?? [])
    : [];
  const verificationCounts = verificationResults.reduce(
    (counts, result) => {
      counts[result.status] += 1;
      return counts;
    },
    { pending: 0, passed: 0, failed: 0, skipped: 0 },
  );
  const latestVerification = verificationResults.at(-1);
  const blockerState =
    task && task.blockedBy.length > 0
      ? task.blockedBy
          .map((taskId) => {
            const dependency = run?.dependencySnapshot.find(
              (candidate) => candidate.taskId === taskId,
            );
            return dependency
              ? `${taskId} ${workflowLabel(dependency.deliveryStatus)} @ ${dependency.resultCommitSha}`
              : taskId;
          })
          .join(", ")
      : "none";
  const taskInputTokens = task ? task.inputTokens || run?.inputTokens || 0 : 0;
  const taskOutputTokens = task ? task.outputTokens || run?.outputTokens || 0 : 0;
  const taskCost = task ? task.costUsd || run?.costUsd || 0 : 0;
  const failureSummary =
    task && (task.failureClass || task.failureReason || task.retryDisposition || run?.error)
      ? [
          task.failureClass ? workflowLabel(task.failureClass) : undefined,
          task.retryDisposition ? `next ${workflowLabel(task.retryDisposition)}` : undefined,
          task.failureReason ?? run?.error,
        ]
          .filter((value): value is string => Boolean(value))
          .join(" · ")
      : undefined;
  const operationalRows = task
    ? [
        {
          label: "Phase",
          value: `${workflowLabel(task.currentPhase)} · delivery ${workflowLabel(task.deliveryStatus)}`,
          tone:
            task.failureClass !== undefined
              ? "red"
              : task.deliveryStatus === "landed"
                ? "green"
                : "cyan",
        },
        ...(failureSummary
          ? [{ label: "Failure", value: failureSummary, tone: "red" as const }]
          : []),
        ...(task.integrationConflictFiles.length > 0
          ? [
              {
                label: "Conflicts",
                value: listSummary(task.integrationConflictFiles),
                tone: "red" as const,
              },
            ]
          : []),
        {
          label: "Source",
          value: `base ${run?.baseSha ?? task.createdBaseSha ?? "not recorded"} · branch ${
            run?.branchName ?? task.integrationBranch ?? "not created"
          }`,
        },
        {
          label: "Result",
          value: `${task.resultCommitSha ?? run?.resultCommitSha ?? "not recorded"} · integrated ${
            task.integratedSha ?? "no"
          } · landed ${task.landedSha ?? "no"}`,
        },
        {
          label: "Blockers",
          value: `${blockerState}${task.blockedReason ? ` · ${task.blockedReason}` : ""}`,
        },
        {
          label: "Changed",
          value:
            changedFiles.length > 0
              ? `${changedFiles.length} · ${listSummary(changedFiles)}`
              : "0 files recorded",
        },
        {
          label: "Verification",
          value:
            verificationResults.length > 0
              ? `${verificationCounts.passed} passed · ${verificationCounts.failed} failed · ${verificationCounts.pending} pending · ${verificationCounts.skipped} skipped`
              : `${task.verifyCommands.length} configured · no results`,
          tone:
            verificationCounts.failed > 0
              ? "red"
              : verificationCounts.passed > 0
                ? "green"
                : undefined,
        },
        ...(latestVerification
          ? [
              {
                label: "Latest gate",
                value: `${workflowLabel(latestVerification.status)} · ${
                  latestVerification.name ??
                  latestVerification.command ??
                  workflowLabel(latestVerification.kind)
                }${latestVerification.summary ? ` · ${latestVerification.summary}` : ""}`,
                tone: latestVerification.status === "failed" ? "red" : undefined,
              },
            ]
          : []),
        {
          label: "Resources",
          value: `${formatElapsed(run, task)} · ${taskInputTokens.toLocaleString("en-US")} in / ${taskOutputTokens.toLocaleString("en-US")} out · ${formatCost(taskCost)}`,
        },
      ]
    : [];
  const operationalLimit = typeof height === "number" ? Math.max(3, Math.min(11, height - 14)) : 11;
  const visibleOperationalRows = operationalRows.slice(0, operationalLimit);
  const activityRowLimit =
    (typeof height === "number" ? Math.max(2, height - 7 - visibleOperationalRows.length) : 8) -
    (activeStage ? 1 : 0);
  const visibleActivity = visibleActivityEntries(activity, activityRowLimit);

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
              <Text bold color="cyan">
                PLAN
              </Text>
              <Text wrap="truncate-end">
                Model: {sanitizeTerminalText(queueModelLabel(queue, queue.planModel))}
              </Text>
              <Text dimColor wrap="truncate-end">
                Instructions: {queueInstructionSummary(queue.planInstructions)}
              </Text>
              <Text bold color="green">
                IMPLEMENTATION
              </Text>
              <Text wrap="truncate-end">
                Model: {sanitizeTerminalText(queueModelLabel(queue, queue.implementModel))}
              </Text>
              <Text dimColor wrap="truncate-end">
                Instructions: {queueInstructionSummary(queue.implementInstructions)}
              </Text>
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
              <Text wrap="truncate-end">
                Allowed paths: {listSummary(queue.allowedPaths, "unrestricted")}
              </Text>
              <Text wrap="truncate-end">Denied paths: {listSummary(queue.deniedPaths)}</Text>
              <Text>Changed-file limit: {queue.maxChangedFiles ?? "unlimited"}</Text>
              <Text wrap="truncate-end">Approvals: {listSummary(queue.approvalCheckpoints)}</Text>
              <Text wrap="truncate-end">
                Drift: {workflowLabel(queue.baseDriftPolicy)} · landing:{" "}
                {workflowLabel(queue.landStrategy)} · auto-land {queue.autoLand ? "on" : "off"}
              </Text>
              <Text wrap="truncate-end">
                File concurrency: {workflowLabel(queue.fileConcurrency)}
              </Text>
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
            Objective: {sanitizeTerminalText(task.objective || task.title)}
          </Text>
          <Text dimColor wrap="truncate-end">
            Instructions:{" "}
            {task.instructions
              ? sanitizeTerminalText(task.instructions)
              : "No additional instructions."}
          </Text>
          <Box flexDirection="column" marginTop={1}>
            <Text bold color="magenta">
              ENGINEERING STATE
            </Text>
            {visibleOperationalRows.map((row) => (
              <Text key={row.label} color={row.tone} wrap="truncate-end">
                <Text bold dimColor={!row.tone}>
                  {row.label}:{" "}
                </Text>
                {sanitizeTerminalText(row.value)}
              </Text>
            ))}
          </Box>
          <Box marginTop={1} flexDirection="column" flexGrow={1} overflow="hidden">
            {activeStage ? <ActivityRow entry={activeStage} /> : null}
            {visibleActivity.length === 0 && !activeStage ? (
              <Text dimColor>
                {isTaskTerminal(task.status)
                  ? "No recorded activity for this task."
                  : "Waiting for agent activity…"}
              </Text>
            ) : (
              visibleActivity.map((entry) => <ActivityRow key={entry.key} entry={entry} />)
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
        delete {focus === "queues" ? "queue" : "task"}
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
          c cancel · r retry · s resume · d done · v attempts · X clean · f filter · 1-3/tab focus
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

const attemptWorkflowLines = (run: Run, width: number): string[] => {
  const lines: string[] = [];
  const workflow = run.taskSnapshot?.workflow;
  const addSection = (label: string, value: string | undefined, fallback: string) => {
    lines.push(label);
    lines.push(
      ...wrapFormValue(sanitizeTerminalText(value ?? "").trim() || fallback, Math.max(1, width)),
    );
    lines.push("");
  };

  addSection(
    "PLANNING INSTRUCTIONS",
    workflow?.planInstructions,
    "No planning instructions were captured for this attempt.",
  );
  addSection(
    "IMPLEMENTATION INSTRUCTIONS",
    workflow?.implementInstructions,
    "No implementation instructions were captured for this attempt.",
  );
  addSection(
    "PLANNER HANDOFF",
    run.planOutput,
    "No planner handoff was recorded for this attempt.",
  );
  if (lines.at(-1) === "") lines.pop();
  return lines;
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
  const [liveRun, setLiveRun] = useState<Run>();
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
  const [attemptIndex, setAttemptIndex] = useState(0);
  const [attemptDetailOpen, setAttemptDetailOpen] = useState(false);
  const [attemptDetailOffset, setAttemptDetailOffset] = useState(0);
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
      setLiveRun(undefined);
      return;
    }
    try {
      const [nextEvents, taskRuns] = await Promise.all([
        controller.listEvents(selectedTaskId, { limit: 200 }),
        controller.listRuns(selectedTaskId).catch(() => []),
      ]);
      if (mounted.current && sequence === eventRefreshSequence.current) {
        setEvents(nextEvents);
        setLiveRun(
          taskRuns.find((candidate) => candidate.id === selectedTask?.currentRunId) ??
            taskRuns.find((candidate) =>
              ["starting", "running", "cancelling"].includes(candidate.status),
            ) ??
            taskRuns[0],
        );
      }
    } catch (cause) {
      if (mounted.current && sequence === eventRefreshSequence.current) {
        setNotice(`Logs unavailable: ${messageFrom(cause)}`);
      }
    }
  }, [controller, selectedTask, selectedTaskId]);

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
      objective: "",
      invariants: "",
      handoffRequirements: "",
      blockedBy: "",
      expectedPaths: "",
      allowedPaths: "",
      deniedPaths: "",
      maxChangedFiles: "",
      verifyCommands: "",
      approvalCheckpoints: "",
      baseDriftPolicyIndex: selectedOptionIndex(BASE_DRIFT_POLICIES, queue.baseDriftPolicy),
      landStrategyIndex: selectedOptionIndex(LAND_STRATEGIES, queue.landStrategy),
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
    let maxChangedFiles: number | undefined;
    try {
      maxChangedFiles = optionalPositiveIntegerFrom(draft.maxChangedFiles, "Maximum changed files");
    } catch (cause) {
      setDraft((current) => (current ? { ...current, error: messageFrom(cause) } : current));
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
        objective: draft.objective.trim() || undefined,
        invariants: parseList(draft.invariants),
        handoffRequirements: parseList(draft.handoffRequirements),
        blockedBy: parseList(draft.blockedBy),
        expectedPaths: parseList(draft.expectedPaths),
        allowedPaths: parseList(draft.allowedPaths),
        deniedPaths: parseList(draft.deniedPaths),
        ...(maxChangedFiles === undefined ? {} : { maxChangedFiles }),
        verifyCommands: parseCommands(draft.verifyCommands),
        approvalCheckpoints: parseList(draft.approvalCheckpoints),
        baseDriftPolicy: selectedOption(BASE_DRIFT_POLICIES, draft.baseDriftPolicyIndex, "replan"),
        landStrategy: selectedOption(LAND_STRATEGIES, draft.landStrategyIndex, "none"),
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
      objective: selectedTask.objective,
      invariants: selectedTask.invariants.join("; "),
      handoffRequirements: selectedTask.handoffRequirements.join("; "),
      blockedBy: selectedTask.blockedBy.join("; "),
      expectedPaths: selectedTask.expectedPaths.join("; "),
      allowedPaths: selectedTask.allowedPaths.join("; "),
      deniedPaths: selectedTask.deniedPaths.join("; "),
      maxChangedFiles:
        selectedTask.maxChangedFiles === undefined ? "" : String(selectedTask.maxChangedFiles),
      verifyCommands: selectedTask.verifyCommands.join("; "),
      approvalCheckpoints: selectedTask.approvalCheckpoints.join("; "),
      baseDriftPolicyIndex: selectedOptionIndex(BASE_DRIFT_POLICIES, selectedTask.baseDriftPolicy),
      landStrategyIndex: selectedOptionIndex(LAND_STRATEGIES, selectedTask.landStrategy),
      idempotencyKey: "",
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
    let maxChangedFiles: number | undefined;
    try {
      maxChangedFiles = optionalPositiveIntegerFrom(
        editDraft.maxChangedFiles,
        "Maximum changed files",
      );
    } catch (cause) {
      setEditDraft((current) => (current ? { ...current, error: messageFrom(cause) } : current));
      return;
    }

    const patch: UiTaskPatch = {
      title,
      instructions: editDraft.instructions.trim(),
      acceptanceCriteria: parseAcceptanceCriteria(editDraft.acceptanceCriteria),
      objective: editDraft.objective.trim() || title,
      invariants: parseList(editDraft.invariants),
      handoffRequirements: parseList(editDraft.handoffRequirements),
      blockedBy: parseList(editDraft.blockedBy),
      expectedPaths: parseList(editDraft.expectedPaths),
      allowedPaths: parseList(editDraft.allowedPaths),
      deniedPaths: parseList(editDraft.deniedPaths),
      maxChangedFiles: maxChangedFiles ?? null,
      verifyCommands: parseCommands(editDraft.verifyCommands),
      approvalCheckpoints: parseList(editDraft.approvalCheckpoints),
      baseDriftPolicy: selectedOption(
        BASE_DRIFT_POLICIES,
        editDraft.baseDriftPolicyIndex,
        "replan",
      ),
      landStrategy: selectedOption(LAND_STRATEGIES, editDraft.landStrategyIndex, "none"),
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
      planModel: "",
      planInstructions: "",
      implementModel: "",
      implementInstructions: "",
      concurrency: "2",
      maxAttempts: "2",
      verifyCommands: "",
      autoCommit: true,
      allowedPaths: "",
      deniedPaths: "",
      maxChangedFiles: "",
      approvalCheckpoints: "",
      baseDriftPolicyIndex: selectedOptionIndex(BASE_DRIFT_POLICIES, "replan"),
      landStrategyIndex: selectedOptionIndex(LAND_STRATEGIES, "none"),
      autoLand: false,
      fileConcurrencyIndex: selectedOptionIndex(FILE_CONCURRENCY_MODES, "off"),
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
      planModel: selectedQueue.planModel,
      planInstructions: selectedQueue.planInstructions,
      implementModel: selectedQueue.implementModel,
      implementInstructions: selectedQueue.implementInstructions,
      concurrency: String(selectedQueue.concurrency),
      maxAttempts: String(selectedQueue.maxAttempts),
      verifyCommands: selectedQueue.verifyCommands.join("; "),
      autoCommit: selectedQueue.autoCommit,
      allowedPaths: selectedQueue.allowedPaths.join("; "),
      deniedPaths: selectedQueue.deniedPaths.join("; "),
      maxChangedFiles:
        selectedQueue.maxChangedFiles === undefined ? "" : String(selectedQueue.maxChangedFiles),
      approvalCheckpoints: selectedQueue.approvalCheckpoints.join("; "),
      baseDriftPolicyIndex: selectedOptionIndex(BASE_DRIFT_POLICIES, selectedQueue.baseDriftPolicy),
      landStrategyIndex: selectedOptionIndex(LAND_STRATEGIES, selectedQueue.landStrategy),
      autoLand: selectedQueue.autoLand,
      fileConcurrencyIndex: selectedOptionIndex(
        FILE_CONCURRENCY_MODES,
        selectedQueue.fileConcurrency,
      ),
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
      const maxChangedFiles = optionalPositiveIntegerFrom(
        queueDraft.maxChangedFiles,
        "Maximum changed files",
      );
      const verifyCommands = parseCommands(queueDraft.verifyCommands);
      const allowedPaths = parseList(queueDraft.allowedPaths);
      const deniedPaths = parseList(queueDraft.deniedPaths);
      const approvalCheckpoints = parseList(queueDraft.approvalCheckpoints);
      const baseDriftPolicy = selectedOption(
        BASE_DRIFT_POLICIES,
        queueDraft.baseDriftPolicyIndex,
        "replan",
      );
      const landStrategy = selectedOption(LAND_STRATEGIES, queueDraft.landStrategyIndex, "none");
      const fileConcurrency = selectedOption(
        FILE_CONCURRENCY_MODES,
        queueDraft.fileConcurrencyIndex,
        "off",
      );
      if (!beginAction()) return;
      started = true;

      if (queueDraft.kind === "create") {
        const created = await controller.createQueue({
          name,
          repoPath,
          ...(baseRef ? { baseRef } : {}),
          defaultProvider: provider,
          planModel: queueDraft.planModel.trim(),
          planInstructions: queueDraft.planInstructions.trim(),
          implementModel: queueDraft.implementModel.trim(),
          implementInstructions: queueDraft.implementInstructions.trim(),
          concurrency,
          maxAttempts,
          verifyCommands,
          autoCommit: queueDraft.autoCommit,
          allowedPaths,
          deniedPaths,
          ...(maxChangedFiles === undefined ? {} : { maxChangedFiles }),
          approvalCheckpoints,
          baseDriftPolicy,
          landStrategy,
          autoLand: queueDraft.autoLand,
          fileConcurrency,
        });
        setSelectedQueueId(created.id);
        setFocus("queues");
        setNotice(`Created queue ${created.name}. Settings are snapshotted by future claims.`);
      } else {
        if (!queueDraft.queueId) throw new Error("The selected queue is no longer available.");
        const patch: UiQueuePatch = {
          name,
          baseRef,
          defaultProvider: provider,
          planModel: queueDraft.planModel.trim(),
          planInstructions: queueDraft.planInstructions.trim(),
          implementModel: queueDraft.implementModel.trim(),
          implementInstructions: queueDraft.implementInstructions.trim(),
          concurrency,
          maxAttempts,
          verifyCommands,
          autoCommit: queueDraft.autoCommit,
          allowedPaths,
          deniedPaths,
          maxChangedFiles: maxChangedFiles ?? null,
          approvalCheckpoints,
          baseDriftPolicy,
          landStrategy,
          autoLand: queueDraft.autoLand,
          fileConcurrency,
        };
        const updated = await controller.updateQueue(queueDraft.queueId, patch);
        setSelectedQueueId(updated.id);
        setNotice(
          `Updated queue ${updated.name}. Changes apply to future claims; active attempts keep their snapshot.`,
        );
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
      let outcome: string;
      try {
        if (action === "cancel") await controller.cancelTask(task.id);
        if (action === "retry") await controller.retryTask(task.id);
        if (action === "resume") await controller.resumeTask(task.id);
        if (action === "done") await controller.completeManualTask(task.id);
        setMode("dashboard");
        await refresh();
        outcome =
          action === "cancel"
            ? `Cancellation requested for ${task.id}.`
            : action === "retry"
              ? `Retry queued for ${task.id}.`
              : action === "resume"
                ? `Resume queued for ${task.id}.`
                : `Marked ${task.id} complete.`;
      } catch (cause) {
        setMode("dashboard");
        outcome = `${action} failed: ${messageFrom(cause)}`;
      } finally {
        finishAction();
      }
      if (mounted.current) setNotice(outcome);
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
      setAttemptIndex(0);
      setAttemptDetailOpen(false);
      setAttemptDetailOffset(0);
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
      if (pending.kind === "delete-queue") {
        await controller.deleteQueue(pending.queue.id);
        setSelectedQueueId(undefined);
        setMode("dashboard");
        setNotice(`Deleted queue ${pending.queue.name}.`);
        await refresh();
      } else if (pending.kind === "delete-task") {
        await controller.deleteTask(pending.task.id);
        setSelectedTaskId(undefined);
        setMode("dashboard");
        setNotice(`Deleted task ${pending.task.title}.`);
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
    const deletable = Boolean(
      selectedTask && !isTaskActive(selectedTask.status) && !selectedTask.currentRunId,
    );
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
        detail: "Planning and implementation models, guidance, and limits",
        available: queueSelected,
      },
      {
        id: "delete-queue",
        label: "Delete selected queue",
        detail: "Delete the queue and all inactive tasks and history",
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
        id: "delete-task",
        label: "Delete selected task",
        detail: "Delete the task, attempts, events, and logs",
        available: deletable,
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
        detail: "Continue its latest retained planning or implementation stage",
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
      {
        id: "approve-checkpoint",
        label: "Approve current checkpoint",
        detail: taskSelected
          ? "Unavailable: the UI controller does not expose approval decisions yet"
          : "Select a task; approval decisions also require a controller API",
        available: false,
      },
      {
        id: "integrate-result",
        label: "Integrate selected task result",
        detail: taskSelected
          ? "Unavailable: the UI controller does not expose result integration yet"
          : "Select a task; result integration also requires a controller API",
        available: false,
      },
      {
        id: "land-result",
        label: "Land selected task result",
        detail: taskSelected
          ? "Unavailable: the UI controller does not expose result landing yet"
          : "Select a task; result landing also requires a controller API",
        available: false,
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
        case "delete-queue":
          if (selectedQueue) {
            setConfirmation({ kind: "delete-queue", queue: selectedQueue });
            setMode("confirm");
          }
          break;
        case "add-task":
          startAdd();
          break;
        case "edit-task":
          startEdit();
          break;
        case "delete-task":
          if (selectedTask) {
            setConfirmation({ kind: "delete-task", task: selectedTask });
            setMode("confirm");
          }
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
        case "approve-checkpoint":
        case "integrate-result":
        case "land-result":
          setNotice(`${item.label} requires a lifecycle controller API.`);
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

  const safeAttemptIndex = Math.max(0, Math.min(runs.length - 1, attemptIndex));
  const selectedAttempt = runs[safeAttemptIndex];
  const attemptPanelWidth = Math.max(1, Math.min(columns - 2, 96));
  const attemptHorizontalPadding = columns >= 50 ? 2 : 1;
  const attemptContentWidth = Math.max(1, attemptPanelWidth - attemptHorizontalPadding * 2 - 2);
  const attemptDetailCapacity = Math.max(1, rows - 9);
  const attemptDetailLines = selectedAttempt
    ? attemptWorkflowLines(selectedAttempt, attemptContentWidth)
    : [];
  const attemptDetailMaxOffset = Math.max(0, attemptDetailLines.length - attemptDetailCapacity);

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
      if (attemptDetailOpen) {
        if (input === "v") {
          setAttemptDetailOpen(false);
          setAttemptDetailOffset(0);
          setMode("dashboard");
          return;
        }
        if (key.escape) {
          setAttemptDetailOpen(false);
          setAttemptDetailOffset(0);
          return;
        }
        if (key.upArrow || input === "k") {
          setAttemptDetailOffset((current) => Math.max(0, current - 1));
          return;
        }
        if (key.downArrow || input === "j") {
          setAttemptDetailOffset((current) => Math.min(attemptDetailMaxOffset, current + 1));
        }
        return;
      }
      if (key.escape || input === "v") {
        setMode("dashboard");
        return;
      }
      if (key.upArrow || input === "k") {
        setAttemptIndex((current) => nextIndex(current, runs.length, -1));
        setAttemptDetailOffset(0);
        return;
      }
      if (key.downArrow || input === "j") {
        setAttemptIndex((current) => nextIndex(current, runs.length, 1));
        setAttemptDetailOffset(0);
        return;
      }
      if (key.return && selectedAttempt) {
        setAttemptDetailOpen(true);
        setAttemptDetailOffset(0);
      }
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
      const controls = queueFormControls(queueDraft.kind);
      const focusedControl = controls.find(
        (control) => "focusIndex" in control && control.focusIndex === queueDraft.field,
      );
      const fieldCount = controls.filter((control) => "focusIndex" in control).length;
      if (key.tab) {
        setQueueDraft((current) =>
          current
            ? { ...current, field: nextIndex(current.field, fieldCount, key.shift ? -1 : 1) }
            : current,
        );
        return;
      }
      if (
        focusedControl?.kind === "provider" &&
        (key.leftArrow || key.upArrow || key.rightArrow || key.downArrow)
      ) {
        const delta = key.leftArrow || key.upArrow ? -1 : 1;
        setQueueDraft((current) => {
          if (!current) return current;
          const providerIndex = nextIndex(current.providerIndex, PROVIDERS.length, delta);
          return {
            ...current,
            providerIndex,
            ...(providerIndex === current.providerIndex
              ? {}
              : { planModel: "", implementModel: "" }),
            error: undefined,
          };
        });
        return;
      }
      if (
        focusedControl?.kind === "selector" &&
        (key.leftArrow || key.upArrow || key.rightArrow || key.downArrow)
      ) {
        const delta = key.leftArrow || key.upArrow ? -1 : 1;
        setQueueDraft((current) =>
          current
            ? {
                ...current,
                [focusedControl.key]: nextIndex(
                  current[focusedControl.key],
                  focusedControl.options.length,
                  delta,
                ),
                error: undefined,
              }
            : current,
        );
        return;
      }
      if (
        focusedControl?.kind === "toggle" &&
        (input === " " || key.leftArrow || key.upArrow || key.rightArrow || key.downArrow)
      ) {
        setQueueDraft((current) =>
          current
            ? {
                ...current,
                [focusedControl.key]: !current[focusedControl.key],
                error: undefined,
              }
            : current,
        );
        return;
      }
      if (key.return) {
        if (queueDraft.field < fieldCount - 1) {
          setQueueDraft((current) =>
            current ? { ...current, field: current.field + 1 } : current,
          );
        } else {
          void submitQueue();
        }
        return;
      }

      const textField = focusedControl?.kind === "text" ? focusedControl.key : undefined;
      if (
        textField &&
        focusedControl?.kind === "text" &&
        focusedControl.multiline &&
        key.ctrl &&
        input === "n"
      ) {
        setQueueDraft((current) =>
          current
            ? { ...current, [textField]: `${current[textField]}\n`, error: undefined }
            : current,
        );
        return;
      }
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
      const controls = EDIT_TASK_CONTROLS;
      const focusedControl = controls.find((control) => control.focusIndex === editDraft.field);
      const fieldCount = controls.length;
      if (key.tab) {
        setEditDraft((current) =>
          current
            ? {
                ...current,
                field: nextIndex(current.field, fieldCount, key.shift ? -1 : 1),
              }
            : current,
        );
        return;
      }
      if (
        focusedControl?.kind === "provider" &&
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
      if (
        focusedControl?.kind === "selector" &&
        (key.leftArrow || key.upArrow || key.rightArrow || key.downArrow)
      ) {
        const delta = key.leftArrow || key.upArrow ? -1 : 1;
        setEditDraft((current) =>
          current
            ? {
                ...current,
                [focusedControl.key]: nextIndex(
                  current[focusedControl.key],
                  focusedControl.options.length,
                  delta,
                ),
                error: undefined,
              }
            : current,
        );
        return;
      }
      if (key.return) {
        if (editDraft.field < fieldCount - 1) {
          setEditDraft((current) => (current ? { ...current, field: current.field + 1 } : current));
        } else {
          void submitEdit();
        }
        return;
      }

      if (
        focusedControl?.kind === "text" &&
        focusedControl.multiline &&
        key.ctrl &&
        input === "n"
      ) {
        const textField = focusedControl.key;
        setEditDraft((current) =>
          current
            ? { ...current, [textField]: `${current[textField]}\n`, error: undefined }
            : current,
        );
        return;
      }
      const textField = focusedControl?.kind === "text" ? focusedControl.key : undefined;
      if (textField && ((key.ctrl && input === "u") || key.backspace || key.delete)) {
        setEditDraft((current) => {
          if (!current) return current;
          return {
            ...current,
            [textField]: key.ctrl ? "" : current[textField].slice(0, -1),
            error: undefined,
          };
        });
        return;
      }
      if (textField && !key.ctrl && !key.meta && input) {
        setEditDraft((current) =>
          current
            ? { ...current, [textField]: current[textField] + input, error: undefined }
            : current,
        );
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
      const controls = ADD_TASK_CONTROLS;
      const focusedControl = controls.find((control) => control.focusIndex === draft.field);
      const fieldCount = controls.length;
      if (key.tab) {
        setDraft((current) =>
          current
            ? {
                ...current,
                field: nextIndex(current.field, fieldCount, key.shift ? -1 : 1),
              }
            : current,
        );
        return;
      }
      if (
        (focusedControl?.kind === "queue" || focusedControl?.kind === "provider") &&
        (key.leftArrow || key.upArrow || key.rightArrow || key.downArrow)
      ) {
        const delta = key.leftArrow || key.upArrow ? -1 : 1;
        setDraft((current) => {
          if (!current) return current;
          if (focusedControl.kind === "queue") {
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
      if (
        focusedControl?.kind === "selector" &&
        (key.leftArrow || key.upArrow || key.rightArrow || key.downArrow)
      ) {
        const delta = key.leftArrow || key.upArrow ? -1 : 1;
        setDraft((current) =>
          current
            ? {
                ...current,
                [focusedControl.key]: nextIndex(
                  current[focusedControl.key],
                  focusedControl.options.length,
                  delta,
                ),
                error: undefined,
              }
            : current,
        );
        return;
      }
      if (key.return) {
        if (draft.field < fieldCount - 1) {
          setDraft((current) => (current ? { ...current, field: current.field + 1 } : current));
        } else {
          void submitAdd();
        }
        return;
      }

      if (
        focusedControl?.kind === "text" &&
        focusedControl.multiline &&
        key.ctrl &&
        input === "n"
      ) {
        const textField = focusedControl.key;
        setDraft((current) =>
          current
            ? { ...current, [textField]: `${current[textField]}\n`, error: undefined }
            : current,
        );
        return;
      }
      const textField = focusedControl?.kind === "text" ? focusedControl.key : undefined;
      if (textField && ((key.ctrl && input === "u") || key.backspace || key.delete)) {
        setDraft((current) => {
          if (!current) return current;
          return {
            ...current,
            [textField]: key.ctrl ? "" : current[textField].slice(0, -1),
            error: undefined,
          };
        });
        return;
      }
      if (textField && !key.ctrl && !key.meta && input) {
        setDraft((current) =>
          current
            ? { ...current, [textField]: current[textField] + input, error: undefined }
            : current,
        );
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
        setConfirmation({ kind: "delete-queue", queue: selectedQueue });
        setMode("confirm");
      } else if (selectedTask && !isTaskActive(selectedTask.status) && !selectedTask.currentRunId) {
        setConfirmation({ kind: "delete-task", task: selectedTask });
        setMode("confirm");
      } else if (selectedTask) {
        setNotice("Cancel active work before deleting this task.");
      } else {
        setNotice("Select a queue or task to delete.");
      }
      return;
    }
    if (input === "X") {
      if (selectedTask && isTaskTerminal(selectedTask.status)) {
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
            contextual edit · <Text bold>x</Text> delete queue / task · <Text bold>X</Text> clean
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
          <Text dimColor>
            Forms: tab fields · ctrl+n newline · ctrl+u clear · ctrl+s save · esc cancel
          </Text>
          <Text dimColor>
            Lifecycle: approval, result integration, and landing appear in : and stay disabled until
            controller APIs are connected
          </Text>
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
    const fields: FormField[] = queueFormControls(queueDraft.kind).map((control) => {
      if (control.kind === "readonly") {
        return {
          label: control.label,
          value: queueDraft[control.key],
          focusable: false,
        };
      }
      if (control.kind === "provider") {
        return {
          label: control.label,
          value: provider,
          focused: queueDraft.field === control.focusIndex,
        };
      }
      if (control.kind === "toggle") {
        return {
          label: control.label,
          value: queueDraft[control.key] ? "on" : "off",
          focused: queueDraft.field === control.focusIndex,
        };
      }
      if (control.kind === "selector") {
        return {
          label: control.label,
          value: control.options[queueDraft[control.key]] ?? "unavailable",
          focused: queueDraft.field === control.focusIndex,
        };
      }
      return {
        label: control.label,
        value: queueDraft[control.key] || control.placeholder || "",
        focused: queueDraft.field === control.focusIndex,
        multiline: control.multiline,
        textInput: true,
      };
    });
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
        footer="ctrl+s save · ctrl+n newline · esc cancel · ←→ change · tab fields · ctrl+u clear"
      />
    );
  }

  if (mode === "attempts" && selectedTask) {
    if (attemptDetailOpen && selectedAttempt) {
      const safeOffset = Math.min(attemptDetailOffset, attemptDetailMaxOffset);
      const visibleLines = attemptDetailLines.slice(safeOffset, safeOffset + attemptDetailCapacity);
      const workflow = selectedAttempt.taskSnapshot?.workflow;
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
              width={attemptPanelWidth}
              height={Math.max(1, rows - 4)}
              borderStyle="double"
              borderColor="magenta"
              paddingX={attemptHorizontalPadding}
              flexDirection="column"
              overflow="hidden"
            >
              <Text bold color="magenta" wrap="truncate-end">
                ATTEMPT DETAIL · #{selectedAttempt.attemptNo}
              </Text>
              <Text dimColor wrap="truncate-end">
                {selectedAttempt.status.toUpperCase()} · {selectedAttempt.provider} ·{" "}
                {selectedAttempt.phase} · plan{" "}
                {sanitizeTerminalText(workflow?.planModel || `${selectedAttempt.provider} default`)}{" "}
                → implement{" "}
                {sanitizeTerminalText(
                  workflow?.implementModel || `${selectedAttempt.provider} default`,
                )}
              </Text>
              <Box height={attemptDetailCapacity} flexDirection="column" overflow="hidden">
                {visibleLines.map((line, index) => (
                  // The workflow snapshot is immutable; its absolute line number is a stable key.
                  // biome-ignore lint/suspicious/noArrayIndexKey: static viewport over immutable text
                  <Text key={`${safeOffset + index}-${line}`} wrap="truncate-end">
                    {line || " "}
                  </Text>
                ))}
              </Box>
              <Text dimColor wrap="truncate-end">
                Lines {safeOffset + 1}–
                {Math.min(attemptDetailLines.length, safeOffset + attemptDetailCapacity)} of{" "}
                {attemptDetailLines.length} · ↑↓/jk scroll · esc attempts · v dashboard
              </Text>
            </Box>
          </Box>
        </Box>
      );
    }

    const capacity = Math.max(1, Math.floor((rows - 9) / 5));
    const visible = windowItems(runs, safeAttemptIndex, capacity);
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
            width={attemptPanelWidth}
            height={Math.max(1, rows - 4)}
            borderStyle="double"
            borderColor="magenta"
            paddingX={attemptHorizontalPadding}
            flexDirection="column"
            overflow="hidden"
          >
            <Text bold color="magenta">
              ATTEMPTS · {sanitizeTerminalText(selectedTask.title)}
            </Text>
            {runs.length > 0 ? (
              <Text dimColor>
                SELECTED {safeAttemptIndex + 1}/{runs.length} · ↑↓/jk select · enter details
              </Text>
            ) : null}
            {runs.length === 0 ? <Text dimColor>No attempts have started.</Text> : null}
            {visible.items.map((run, offset) => {
              const index = visible.start + offset;
              const selected = index === safeAttemptIndex;
              return (
                <Box key={run.id} flexDirection="column" marginBottom={1}>
                  <Text>
                    <Text color={selected ? "magenta" : undefined}>{selected ? "› " : "  "}</Text>
                    <Text
                      bold={selected}
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
                      · {run.provider} · {run.phase} · {run.id}
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
                  {run.taskSnapshot?.workflow ? (
                    <Text dimColor wrap="truncate-end">
                      Models: plan{" "}
                      {sanitizeTerminalText(
                        run.taskSnapshot.workflow.planModel || `${run.provider} default`,
                      )}{" "}
                      → implement{" "}
                      {sanitizeTerminalText(
                        run.taskSnapshot.workflow.implementModel || `${run.provider} default`,
                      )}
                    </Text>
                  ) : null}
                </Box>
              );
            })}
            <Text dimColor>↑↓ / j k select · enter details · v / esc back</Text>
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
    const fields: FormField[] = EDIT_TASK_CONTROLS.map((control) => {
      if (control.kind === "provider") {
        return {
          label: control.label,
          value: PROVIDERS[editDraft.providerIndex] ?? "No provider",
          focused: editDraft.field === control.focusIndex,
        };
      }
      if (control.kind === "selector") {
        return {
          label: control.label,
          value: control.options[editDraft[control.key]] ?? "unavailable",
          focused: editDraft.field === control.focusIndex,
        };
      }
      if (control.kind === "text") {
        return {
          label: control.label,
          value: editDraft[control.key] || control.placeholder || "",
          focused: editDraft.field === control.focusIndex,
          multiline: control.multiline,
          textInput: true,
        };
      }
      return {
        label: control.label,
        value: "Unavailable while editing",
        focused: editDraft.field === control.focusIndex,
      };
    });
    return (
      <FormScreen
        columns={columns}
        rows={rows}
        title="EDIT TASK"
        subtitle="Changes apply to the next attempt and keep existing run history."
        fields={fields}
        error={editDraft.error}
        footer="ctrl+s save · ctrl+n newline · esc cancel · ←→ change · tab fields · ctrl+u clear"
      />
    );
  }

  if (mode === "add" && draft) {
    const queue = snapshot.queues.find((candidate) => candidate.id === draft.queueId);
    const provider = PROVIDERS[draft.providerIndex];
    const fields: FormField[] = ADD_TASK_CONTROLS.map((control) => {
      if (control.kind === "queue") {
        return {
          label: control.label,
          value: queue?.name ?? "Queue unavailable (removed)",
          focused: draft.field === control.focusIndex,
        };
      }
      if (control.kind === "provider") {
        return {
          label: control.label,
          value: provider ?? "No provider",
          focused: draft.field === control.focusIndex,
        };
      }
      if (control.kind === "selector") {
        return {
          label: control.label,
          value: control.options[draft[control.key]] ?? "unavailable",
          focused: draft.field === control.focusIndex,
        };
      }
      return {
        label: control.label,
        value: draft[control.key] || control.placeholder || "",
        focused: draft.field === control.focusIndex,
        multiline: control.multiline,
        textInput: true,
      };
    });
    return (
      <FormScreen
        columns={columns}
        rows={rows}
        title="ADD TASK"
        subtitle="Choose the queue and provider, then describe the outcome."
        fields={fields}
        error={draft.error}
        footer="ctrl+s submit · esc cancel · ←→ choose"
      />
    );
  }

  if (mode === "confirm" && confirmation) {
    const title =
      confirmation.kind === "cancel"
        ? "CANCEL TASK?"
        : confirmation.kind === "retry"
          ? "RETRY TASK?"
          : confirmation.kind === "delete-queue"
            ? "DELETE QUEUE?"
            : confirmation.kind === "delete-task"
              ? "DELETE TASK?"
              : confirmation.kind === "clean"
                ? "CLEAN WORKTREE?"
                : "INSTALL INTEGRATION?";
    const subject =
      confirmation.kind === "delete-queue"
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
          : confirmation.kind === "delete-queue"
            ? "Permanently deletes this queue and all inactive tasks, attempts, events, and logs. Active work or retained worktrees block deletion."
            : confirmation.kind === "delete-task"
              ? "Permanently deletes this task, its attempts, events, and logs. Active work or retained worktrees block deletion."
              : confirmation.kind === "clean"
                ? confirmation.force
                  ? "Force removal discards uncommitted work in the retained worktree."
                  : "Safe removal stops if the retained worktree has uncommitted changes."
                : "Repository instructions will be installed in:";
    const destructive =
      confirmation.kind === "cancel" ||
      confirmation.kind === "delete-queue" ||
      confirmation.kind === "delete-task" ||
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
      run={liveRun?.taskId === selectedTask?.id ? liveRun : undefined}
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
