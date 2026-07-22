import type { ExecutorEvent, ExecutorRunInput } from "../core/types.ts";
import { CliExecutor, type CliExecutorOptions } from "./cli-executor.ts";
import {
  appendSummary,
  asNumber,
  asRecord,
  asString,
  compactDetail,
  errorMessage,
  malformedJsonDiagnostic,
  replaceSummary,
  type StreamOutcome,
  type StreamParser,
  usageEvent,
} from "./stream-parser.ts";

function codexToolName(item: Record<string, unknown>): string | undefined {
  const type = asString(item.type);
  switch (type) {
    case "command_execution":
      return "command";
    case "mcp_tool_call": {
      const server = asString(item.server);
      const tool = asString(item.tool) ?? asString(item.name);
      return server && tool ? `${server}.${tool}` : (tool ?? "MCP tool");
    }
    case "file_change":
      return "file change";
    case "web_search":
      return "web search";
    case "image_generation":
      return "image generation";
    case "collaboration_tool_call":
      return asString(item.tool) ?? "agent collaboration";
    default:
      return undefined;
  }
}

function codexToolDetail(item: Record<string, unknown>): string | undefined {
  return compactDetail(
    item.command ?? item.query ?? item.changes ?? item.arguments ?? item.input ?? item.result,
  );
}

function codexToolOutput(item: Record<string, unknown>): string | undefined {
  return compactDetail(item.aggregated_output ?? item.output ?? item.result ?? item.error);
}

function failedTool(item: Record<string, unknown>): boolean {
  const status = asString(item.status);
  const exitCode = asNumber(item.exit_code ?? item.exitCode);
  return status === "failed" || status === "error" || (exitCode !== undefined && exitCode !== 0);
}

export class CodexStreamParser implements StreamParser {
  readonly outcome: StreamOutcome = { terminal: "pending" };

  parseLine(line: string): ExecutorEvent[] {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return [malformedJsonDiagnostic("Codex", line)];
    }
    const record = asRecord(value);
    if (!record) return [malformedJsonDiagnostic("Codex", line)];

    const events: ExecutorEvent[] = [];
    const type = asString(record.type) ?? "";
    const sessionId = asString(record.thread_id ?? record.threadId ?? record.session_id);
    if (sessionId && sessionId !== this.outcome.sessionId) {
      this.outcome.sessionId = sessionId;
      events.push({ type: "session", sessionId });
    }

    if (type === "item.agent_message.delta" || type === "agent_message.delta") {
      const text = asString(record.delta ?? record.text);
      if (text) {
        this.outcome.summary = appendSummary(this.outcome.summary, text);
        events.push({ type: "assistant", text, delta: true });
      }
      return events;
    }

    if (type === "item.started" || type === "item.completed" || type === "item.failed") {
      const item = asRecord(record.item);
      if (!item) return events;
      if (asString(item.type) === "agent_message") {
        const text = asString(item.text);
        if (text) {
          this.outcome.summary = replaceSummary(text);
          events.push({ type: "assistant", text });
        }
        return events;
      }

      const name = codexToolName(item);
      if (name) {
        const state =
          type === "item.started"
            ? "started"
            : type === "item.failed" || failedTool(item)
              ? "failed"
              : "completed";
        const toolEvent: Extract<ExecutorEvent, { type: "tool" }> = {
          type: "tool",
          name,
          state,
        };
        const toolId = asString(item.id);
        const detail = codexToolDetail(item);
        const output = type === "item.started" ? undefined : codexToolOutput(item);
        const exitCode = asNumber(item.exit_code ?? item.exitCode);
        if (toolId) toolEvent.toolId = toolId;
        if (detail) toolEvent.detail = detail;
        if (output) toolEvent.output = output;
        if (exitCode !== undefined) toolEvent.exitCode = exitCode;
        events.push(toolEvent);
      }
      return events;
    }

    if (type === "turn.completed") {
      const usage = usageEvent(record.usage);
      if (usage) events.push(usage);
      this.outcome.terminal = "succeeded";
      this.outcome.error = undefined;
      return events;
    }

    if (type === "turn.failed" || type === "turn.interrupted" || type === "turn.cancelled") {
      const failure = errorMessage(record.error) ?? errorMessage(record) ?? `Codex ${type}`;
      this.outcome.terminal = "failed";
      this.outcome.error = failure;
      events.push({ type: "diagnostic", level: "error", message: failure });
      return events;
    }

    if (type === "error") {
      const failure = errorMessage(record) ?? "Codex reported an unknown error";
      const willRetry = record.will_retry === true || record.willRetry === true;
      if (!willRetry) {
        this.outcome.terminal = "failed";
        this.outcome.error = failure;
      }
      events.push({
        type: "diagnostic",
        level: willRetry ? "warning" : "error",
        message: failure,
      });
    }

    return events;
  }
}

export class CodexExecutor extends CliExecutor {
  readonly provider = "codex" as const;
  protected readonly binaryName = "codex";
  protected readonly binaryEnvironmentVariable = "AGENTQ_CODEX_BIN";

  constructor(options: CliExecutorOptions = {}) {
    super(options);
  }

  protected createParser(): StreamParser {
    return new CodexStreamParser();
  }

  protected arguments(input: ExecutorRunInput): string[] {
    const base = [
      "exec",
      "--json",
      "-C",
      input.cwd,
      "--sandbox",
      input.phase === "plan" ? "read-only" : "workspace-write",
    ];
    const model = input.model?.trim();
    if (model) base.push("--model", model);
    const intakeDirectory = input.env.AGENTQ_INTAKE_DIR;
    if (input.phase === "implement" && intakeDirectory) base.push("--add-dir", intakeDirectory);
    if (input.resumeSessionId) base.push("resume", input.resumeSessionId);
    base.push("-");
    return base;
  }
}

export type CodexExecutorOptions = CliExecutorOptions;
