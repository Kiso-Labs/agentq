import type { ExecutionPhase, TaskEvent } from "../core/types.ts";
import { sanitizeTerminalText } from "./sanitize.ts";

export type ActivityTone = "default" | "active" | "muted" | "success" | "warning" | "error";

export interface ActivityEntry {
  key: string;
  marker: "›" | "•" | "·" | "✓" | "⚠" | "×";
  title: string;
  details: string[];
  tone: ActivityTone;
  emphasis: boolean;
}

interface WorkingActivityEntry extends ActivityEntry {
  runId?: string;
  phase?: ExecutionPhase;
  stageOpen?: boolean;
  toolId?: string;
  toolName?: string;
  sourceDetail?: string;
  open?: boolean;
  assistantDelta?: boolean;
  assistantText?: string;
  diagnosticKey?: string;
  diagnosticCount?: number;
}

const MAX_DETAIL_LINES = 1;

const payloadString = (event: TaskEvent, key: string): string | undefined => {
  const value = event.payload[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

const payloadNumber = (event: TaskEvent, key: string): number | undefined => {
  const value = event.payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

const payloadPhase = (event: TaskEvent): ExecutionPhase | undefined => {
  const value = payloadString(event, "phase");
  return value === "plan" || value === "implement" ? value : undefined;
};

const oneLine = (value: string): string => sanitizeTerminalText(value).replace(/\s+/gu, " ").trim();

const diagnosticText = (value: string): string =>
  oneLine(value).replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+/u, "");

const detailLines = (value: string | undefined): string[] => {
  if (!value) return [];
  const lines = value
    .split(/\r\n|\n|\r/u)
    .map((line) => sanitizeTerminalText(line).replace(/\s+/gu, " ").trim())
    .filter((line) => line.length > 0);
  if (lines.length <= MAX_DETAIL_LINES) return lines;
  const visible = lines.slice(0, MAX_DETAIL_LINES);
  visible[MAX_DETAIL_LINES - 1] =
    `${visible[MAX_DETAIL_LINES - 1]} … +${lines.length - MAX_DETAIL_LINES} lines`;
  return visible;
};

const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

const unwrapQuotedShellArgument = (value: string): string => {
  if (value.length < 2) return value;
  const quote = value[0];
  if ((quote !== '"' && quote !== "'") || value.at(-1) !== quote) return value;
  const inner = value.slice(1, -1);
  return quote === '"' ? inner.replace(/\\(["\\$`])/gu, "$1") : inner;
};

const commandText = (value: string): string => {
  const parsed = parseJson(value);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const command = (parsed as Record<string, unknown>).command;
    if (typeof command === "string") return oneLine(command);
  }

  const compact = oneLine(value);
  const shell = compact.match(/^(?:\/usr\/bin\/env\s+)?(?:\/bin\/)?(?:zsh|bash|sh)\s+-lc\s+(.+)$/u);
  return oneLine(unwrapQuotedShellArgument(shell?.[1] ?? compact));
};

const collectPaths = (value: unknown, paths: string[], depth = 0): void => {
  if (depth > 3 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, paths, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const key of ["path", "file", "filePath", "filename"]) {
    const path = record[key];
    if (typeof path === "string" && path.length > 0 && !paths.includes(path)) paths.push(path);
  }
  for (const key of ["changes", "files", "edits"]) collectPaths(record[key], paths, depth + 1);
};

const changedPaths = (value: string | undefined): string[] => {
  if (!value) return [];
  const paths: string[] = [];
  collectPaths(parseJson(value), paths);
  return paths;
};

const humanize = (value: string): string => {
  const words = value
    .replace(/[._-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return words ? `${words[0]?.toUpperCase() ?? ""}${words.slice(1)}` : "Activity";
};

const providerLabel = (provider: string | undefined): string | undefined => {
  if (provider === "codex") return "Codex";
  if (provider === "claude") return "Claude Code";
  return provider ? humanize(provider) : undefined;
};

const workflowStartedEntry = (event: TaskEvent, phase: ExecutionPhase): WorkingActivityEntry => {
  const verb = phase === "plan" ? "Planning" : "Implementing";
  const actor = providerLabel(payloadString(event, "provider"));
  const model = payloadString(event, "model");
  const context = [actor, model].filter((value): value is string => Boolean(value)).join(" · ");
  return {
    key: String(event.id),
    marker: "›",
    title: `${verb}${context ? ` with ${context}` : ""}`,
    details: [],
    tone: "active",
    emphasis: true,
    runId: event.runId,
    phase,
    stageOpen: true,
  };
};

const completeWorkflowStage = (
  entry: WorkingActivityEntry,
  event: TaskEvent,
  phase: ExecutionPhase,
): void => {
  entry.marker = phase === "plan" ? "✓" : "•";
  entry.title = phase === "plan" ? "Plan ready" : "Implementation agent finished";
  entry.details = detailLines(payloadString(event, "summary"));
  entry.tone = phase === "plan" ? "success" : "default";
  entry.stageOpen = false;
};

const failWorkflowStage = (
  entry: WorkingActivityEntry,
  event: TaskEvent,
  phase: ExecutionPhase,
): void => {
  entry.marker = "×";
  entry.title = phase === "plan" ? "Planning failed" : "Implementation failed";
  entry.details = detailLines(payloadString(event, "message") ?? payloadString(event, "summary"));
  entry.tone = "error";
  entry.stageOpen = false;
};

const findOpenWorkflowStage = (
  entries: WorkingActivityEntry[],
  runId: string | undefined,
  phase: ExecutionPhase,
): WorkingActivityEntry | undefined => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.stageOpen && entry.runId === runId && entry.phase === phase) return entry;
  }
  return undefined;
};

const isCommandTool = (name: string): boolean =>
  /^(?:command|bash|shell|terminal|exec|execute)$/iu.test(name.trim());

const isFileTool = (name: string): boolean =>
  /(?:file[ _-]?change|apply[ _-]?patch|edit|write|notebookedit)/iu.test(name);

const toolTitle = (
  name: string,
  detail: string | undefined,
): { title: string; consumesDetail: boolean } => {
  if (isCommandTool(name)) {
    return {
      title: detail ? `Ran ${commandText(detail)}` : "Ran command",
      consumesDetail: Boolean(detail),
    };
  }
  if (isFileTool(name)) {
    const paths = changedPaths(detail);
    return {
      title: paths.length > 0 ? `Edited ${paths.join(", ")}` : "Edited files",
      consumesDetail: paths.length > 0,
    };
  }
  if (/web[ _-]?search|search/iu.test(name)) {
    return {
      title: detail ? `Searched ${oneLine(detail)}` : `Searched with ${humanize(name)}`,
      consumesDetail: Boolean(detail),
    };
  }
  if (/collaboration|spawn[ _-]?agent|send[ _-]?message/iu.test(name)) {
    return { title: `Delegated via ${humanize(name)}`, consumesDetail: false };
  }
  if (/image[ _-]?generation/iu.test(name)) {
    return { title: "Generated an image", consumesDetail: false };
  }
  return { title: `Called ${name}`, consumesDetail: false };
};

const toolEntry = (
  event: TaskEvent,
  name: string,
  state: string,
  detail: string | undefined,
  output: string | undefined,
): WorkingActivityEntry => {
  const inputDetail = output === detail ? undefined : detail;
  const presentation = toolTitle(name, inputDetail);
  const failed = state === "failed";
  return {
    key: String(event.id),
    marker: failed ? "×" : state === "started" ? "›" : "•",
    title: presentation.title,
    details: detailLines(output ?? (presentation.consumesDetail ? undefined : detail)),
    tone: failed ? "error" : state === "started" ? "active" : "default",
    emphasis: true,
    runId: event.runId,
    phase: payloadPhase(event),
    toolId: payloadString(event, "toolId") ?? payloadString(event, "id"),
    toolName: name,
    sourceDetail: detail ? oneLine(detail) : undefined,
    open: state === "started",
  };
};

const findOpenTools = (
  entries: WorkingActivityEntry[],
  name: string,
  runId: string | undefined,
  phase: ExecutionPhase | undefined,
): WorkingActivityEntry[] =>
  entries.filter(
    (entry) =>
      entry.open && entry.runId === runId && entry.phase === phase && entry.toolName === name,
  );

const toolResultEntry = (
  event: TaskEvent,
  name: string,
  state: string,
  result: string | undefined,
): WorkingActivityEntry => {
  const failed = state === "failed";
  return {
    key: String(event.id),
    marker: failed ? "×" : "•",
    title: `${humanize(name)} ${failed ? "failed" : "completed"}`,
    details: detailLines(result),
    tone: failed ? "error" : "default",
    emphasis: true,
    runId: event.runId,
    phase: payloadPhase(event),
  };
};

const assistantEntry = (event: TaskEvent, text: string): WorkingActivityEntry => {
  const lines = detailLines(text);
  return {
    key: String(event.id),
    marker: "•",
    title: lines[0] ?? "Agent update",
    details: lines.slice(1),
    tone: "default",
    emphasis: false,
    runId: event.runId,
    phase: payloadPhase(event),
    assistantDelta: event.payload.delta === true,
    assistantText: text,
  };
};

const replaceAssistantText = (entry: WorkingActivityEntry, text: string): void => {
  const lines = detailLines(text);
  entry.title = lines[0] ?? "Agent update";
  entry.details = lines.slice(1);
  entry.assistantText = text;
};

const fallbackDetail = (event: TaskEvent): string | undefined =>
  payloadString(event, "text") ??
  payloadString(event, "message") ??
  payloadString(event, "detail") ??
  payloadString(event, "summary");

const genericPayloadDetail = (event: TaskEvent): string | undefined => {
  const payload = Object.fromEntries(
    Object.entries(event.payload).filter(([key]) => key !== "type"),
  );
  if (Object.keys(payload).length === 0) return undefined;
  try {
    return oneLine(JSON.stringify(payload));
  } catch {
    return undefined;
  }
};

const lifecycleEntry = (event: TaskEvent): WorkingActivityEntry | undefined => {
  const detail = fallbackDetail(event);
  switch (event.kind) {
    case "run.started": {
      if (payloadPhase(event)) return undefined;
      const provider = payloadString(event, "provider");
      const branch = payloadString(event, "branchName");
      return {
        key: String(event.id),
        marker: "•",
        title: `Started ${provider === "claude" ? "Claude Code" : provider === "codex" ? "Codex" : "agent"}`,
        details: branch ? [`Branch ${oneLine(branch)}`] : [],
        tone: "active",
        emphasis: true,
      };
    }
    case "verification.completed": {
      const command = payloadString(event, "command") ?? "verification";
      const exitCode = payloadNumber(event, "exitCode");
      const failed = exitCode !== undefined && exitCode !== 0;
      const output =
        payloadString(event, failed ? "stderr" : "stdout") ?? payloadString(event, "stderr");
      return {
        key: String(event.id),
        marker: failed ? "×" : "✓",
        title: `Verified ${commandText(command)}`,
        details: detailLines(output),
        tone: failed ? "error" : "success",
        emphasis: true,
      };
    }
    case "supervisor.error":
    case "intake.failed":
    case "run.recovery_diagnostic":
      return {
        key: String(event.id),
        marker: "×",
        title: "Agent error",
        details: detailLines(detail),
        tone: "error",
        emphasis: true,
      };
    case "run.recovered":
      return {
        key: String(event.id),
        marker: "⚠",
        title: "Recovered interrupted run",
        details: detailLines(detail),
        tone: "warning",
        emphasis: true,
      };
    case "task.resume_requested":
      return {
        key: String(event.id),
        marker: "•",
        title: "Resume requested",
        details: [],
        tone: "active",
        emphasis: true,
      };
    case "task.resume_consumed":
      return {
        key: String(event.id),
        marker: "•",
        title: "Resumed previous session",
        details: [],
        tone: "default",
        emphasis: true,
      };
    case "manual.completed":
      return {
        key: String(event.id),
        marker: "✓",
        title: "Completed manually",
        details: detailLines(detail),
        tone: "success",
        emphasis: true,
      };
    case "task.worktree_removed":
      return {
        key: String(event.id),
        marker: "✓",
        title: "Removed retained worktree",
        details: detailLines(payloadString(event, "worktreePath")),
        tone: "success",
        emphasis: true,
      };
    case "task.edited":
      return {
        key: String(event.id),
        marker: "•",
        title: "Task specification updated",
        details: [],
        tone: "muted",
        emphasis: true,
      };
    case "run.succeeded": {
      const branch = payloadString(event, "branchName");
      const commit = payloadString(event, "commitSha");
      const worktree = payloadString(event, "worktreePath");
      return {
        key: String(event.id),
        marker: "✓",
        title: "Run succeeded",
        details: [
          branch ? `Branch: ${oneLine(branch)}` : undefined,
          commit ? `Commit: ${oneLine(commit)}` : undefined,
          worktree ? `Worktree: ${oneLine(worktree)}` : undefined,
        ].filter((value): value is string => value !== undefined),
        tone: "success",
        emphasis: true,
      };
    }
    case "run.failed":
      return {
        key: String(event.id),
        marker: "×",
        title: "Run failed",
        details: detailLines(detail),
        tone: "error",
        emphasis: true,
      };
    case "run.interrupted":
    case "run.cancelled":
      return {
        key: String(event.id),
        marker: "⚠",
        title: event.kind === "run.cancelled" ? "Run cancelled" : "Run interrupted",
        details: detailLines(detail),
        tone: "warning",
        emphasis: true,
      };
    default:
      return {
        key: String(event.id),
        marker: "•",
        title: humanize(event.kind),
        details: detailLines(detail ?? genericPayloadDetail(event)),
        tone: "muted",
        emphasis: true,
      };
  }
};

export const activityEntries = (events: TaskEvent[]): ActivityEntry[] => {
  const entries: WorkingActivityEntry[] = [];
  const ambiguousLegacyTools = new Set<string>();

  for (const event of events) {
    const type = payloadString(event, "type") ?? event.kind.replace(/^executor\./u, "");

    if (type === "session") continue;

    if (event.kind === "workflow.phase") {
      const phase = payloadPhase(event);
      const state = payloadString(event, "state");
      if (phase && state === "started") {
        entries.push(workflowStartedEntry(event, phase));
      } else if (phase && state === "completed") {
        const stage =
          findOpenWorkflowStage(entries, event.runId, phase) ?? workflowStartedEntry(event, phase);
        completeWorkflowStage(stage, event, phase);
        const stageSummary = payloadString(event, "summary");
        if (
          stageSummary &&
          entries.some(
            (entry) =>
              entry !== stage &&
              entry.runId === event.runId &&
              entry.phase === phase &&
              entry.assistantText !== undefined &&
              (oneLine(entry.assistantText) === oneLine(stageSummary) ||
                oneLine(entry.assistantText).includes(oneLine(stageSummary)) ||
                oneLine(stageSummary).includes(oneLine(entry.assistantText))),
          )
        ) {
          stage.details = [];
        }
        if (!entries.includes(stage)) entries.push(stage);
      } else if (phase && state === "failed") {
        const stage =
          findOpenWorkflowStage(entries, event.runId, phase) ?? workflowStartedEntry(event, phase);
        failWorkflowStage(stage, event, phase);
        if (!entries.includes(stage)) entries.push(stage);
      }
      continue;
    }

    if (type === "assistant" || event.kind === "assistant") {
      const text = payloadString(event, "text");
      if (!text) continue;
      const previous = entries.at(-1);
      if (event.payload.delta === true && previous?.assistantDelta) {
        replaceAssistantText(previous, `${previous.assistantText ?? ""}${text}`);
      } else if (
        event.payload.delta !== true &&
        previous?.assistantDelta &&
        (oneLine(previous.assistantText ?? "") === oneLine(text) ||
          oneLine(text).includes(oneLine(previous.assistantText ?? "")) ||
          oneLine(previous.assistantText ?? "").includes(oneLine(text)))
      ) {
        previous.assistantDelta = false;
        replaceAssistantText(previous, text);
      } else {
        entries.push(assistantEntry(event, text));
      }
      continue;
    }

    if (type === "tool") {
      const name = payloadString(event, "name") ?? "tool";
      const state = payloadString(event, "state") ?? "completed";
      const detail = payloadString(event, "detail");
      const output = payloadString(event, "output");
      const toolId = payloadString(event, "toolId") ?? payloadString(event, "id");
      if (state === "started") {
        entries.push(toolEntry(event, name, state, detail, output));
        continue;
      }

      const phase = payloadPhase(event);
      const openTools = findOpenTools(entries, name, event.runId, phase);
      const legacyKey = JSON.stringify([event.runId ?? null, phase ?? null, name]);
      if (!toolId && (ambiguousLegacyTools.has(legacyKey) || openTools.length > 1)) {
        ambiguousLegacyTools.add(legacyKey);
        for (const candidate of openTools) {
          candidate.open = false;
          candidate.marker = "•";
          candidate.tone = "default";
        }
        entries.push(toolResultEntry(event, name, state, output ?? detail));
        continue;
      }

      const open = toolId
        ? openTools.find((candidate) => candidate.toolId === toolId)
        : openTools[0];
      if (!open) {
        entries.push(
          !toolId && isCommandTool(name)
            ? toolResultEntry(event, name, state, output ?? detail)
            : toolEntry(event, name, state, detail, output),
        );
        continue;
      }

      open.open = false;
      open.marker = state === "failed" ? "×" : "•";
      open.tone = state === "failed" ? "error" : "default";
      const result =
        output ?? (detail && oneLine(detail) !== open.sourceDetail ? detail : undefined);
      if (detail && isFileTool(name) && changedPaths(detail).length > 0) {
        open.title = toolTitle(name, detail).title;
      }
      if (result) {
        open.details = detailLines(result);
      }
      continue;
    }

    if (type === "diagnostic") {
      const level = payloadString(event, "level") ?? "info";
      const message = payloadString(event, "message") ?? "Provider diagnostic";
      const phase = payloadPhase(event);
      const normalizedMessage = diagnosticText(message);
      const key = `${level}:${normalizedMessage}`;
      const repeated = entries.find(
        (entry) =>
          entry.diagnosticKey === key && entry.runId === event.runId && entry.phase === phase,
      );
      if (repeated) {
        repeated.diagnosticCount = (repeated.diagnosticCount ?? 1) + 1;
        const label = level === "error" ? "Error" : level === "warning" ? "Warning" : "Note";
        repeated.title = `${label} · repeated ${repeated.diagnosticCount}×`;
        continue;
      }
      entries.push({
        key: String(event.id),
        marker: level === "error" ? "×" : level === "warning" ? "⚠" : "•",
        title: level === "error" ? "Error" : level === "warning" ? "Warning" : "Note",
        details: detailLines(normalizedMessage),
        tone: level === "error" ? "error" : level === "warning" ? "warning" : "muted",
        emphasis: true,
        runId: event.runId,
        phase,
        diagnosticKey: key,
        diagnosticCount: 1,
      });
      continue;
    }

    if (type === "usage") {
      const inputTokens = payloadNumber(event, "inputTokens");
      const outputTokens = payloadNumber(event, "outputTokens");
      const costUsd = payloadNumber(event, "costUsd");
      const usage = [
        inputTokens === undefined ? undefined : `${inputTokens.toLocaleString()} input`,
        outputTokens === undefined ? undefined : `${outputTokens.toLocaleString()} output`,
        costUsd === undefined ? undefined : `$${costUsd.toFixed(4)}`,
      ].filter((value): value is string => value !== undefined);
      if (usage.length > 0) {
        entries.push({
          key: String(event.id),
          marker: "·",
          title: usage.join(" · "),
          details: [],
          tone: "muted",
          emphasis: false,
        });
      }
      continue;
    }

    const lifecycle = lifecycleEntry(event);
    if (lifecycle) entries.push(lifecycle);
  }

  return entries.map(
    ({
      runId: _runId,
      phase: _phase,
      stageOpen: _stageOpen,
      toolId: _toolId,
      toolName: _toolName,
      sourceDetail: _sourceDetail,
      open: _open,
      assistantDelta: _assistantDelta,
      assistantText: _assistantText,
      diagnosticKey: _diagnosticKey,
      diagnosticCount: _diagnosticCount,
      ...entry
    }) => ({
      ...entry,
      title: oneLine(entry.title) || "Activity",
      details: entry.details.map(oneLine).filter((detail) => detail.length > 0),
    }),
  );
};

export const visibleActivityEntries = (
  entries: ActivityEntry[],
  rowLimit: number,
): ActivityEntry[] => {
  const visible: ActivityEntry[] = [];
  let rows = 0;
  const capacity = Math.max(1, Math.floor(rowLimit));

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) continue;
    const height = 1 + entry.details.length;
    if (visible.length > 0 && rows + height > capacity) break;
    if (height > capacity) {
      visible.unshift({ ...entry, details: entry.details.slice(0, Math.max(0, capacity - 1)) });
      break;
    }
    visible.unshift(entry);
    rows += height;
  }

  return visible;
};
