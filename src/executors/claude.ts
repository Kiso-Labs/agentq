import type { ExecutorEvent, ExecutorRunInput } from "../core/types.ts";
import { CliExecutor, type CliExecutorOptions } from "./cli-executor.ts";
import {
  appendSummary,
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

const DEFAULT_ALLOWED_TOOLS = ["Bash", "Edit", "Write", "Read", "Glob", "Grep"];

export interface ClaudeExecutorOptions extends CliExecutorOptions {
  allowedTools?: string[];
}

function contentBlocks(messageValue: unknown): unknown[] {
  const message = asRecord(messageValue);
  return Array.isArray(message?.content) ? message.content : [];
}

export class ClaudeStreamParser implements StreamParser {
  readonly outcome: StreamOutcome = { terminal: "pending" };
  private readonly tools = new Map<string, string>();

  parseLine(line: string): ExecutorEvent[] {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return [malformedJsonDiagnostic("Claude Code", line)];
    }
    const record = asRecord(value);
    if (!record) return [malformedJsonDiagnostic("Claude Code", line)];

    const events: ExecutorEvent[] = [];
    const type = asString(record.type) ?? "";
    const sessionId = asString(record.session_id ?? record.sessionId);
    if (sessionId && sessionId !== this.outcome.sessionId) {
      this.outcome.sessionId = sessionId;
      events.push({ type: "session", sessionId });
    }

    if (type === "assistant") {
      for (const blockValue of contentBlocks(record.message)) {
        const block = asRecord(blockValue);
        if (!block) continue;
        if (block.type === "text") {
          const text = asString(block.text);
          if (text) {
            this.outcome.summary = replaceSummary(text);
            events.push({ type: "assistant", text });
          }
        } else if (block.type === "tool_use") {
          const id = asString(block.id);
          const name = asString(block.name) ?? "tool";
          if (id) this.tools.set(id, name);
          events.push({
            type: "tool",
            name,
            state: "started",
            detail: compactDetail(block.input),
          });
        }
      }
      return events;
    }

    if (type === "user") {
      for (const blockValue of contentBlocks(record.message)) {
        const block = asRecord(blockValue);
        if (block?.type !== "tool_result") continue;
        const toolId = asString(block.tool_use_id);
        const name = (toolId && this.tools.get(toolId)) || "tool";
        events.push({
          type: "tool",
          name,
          state: block.is_error === true ? "failed" : "completed",
          detail: compactDetail(block.content),
        });
        if (toolId) this.tools.delete(toolId);
      }
      return events;
    }

    if (type === "stream_event") {
      const streamEvent = asRecord(record.event);
      const delta = asRecord(streamEvent?.delta);
      if (streamEvent?.type === "content_block_delta" && delta?.type === "text_delta") {
        const text = asString(delta.text);
        if (text) {
          this.outcome.summary = appendSummary(this.outcome.summary, text);
          events.push({ type: "assistant", text, delta: true });
        }
      }
      return events;
    }

    if (type === "result") {
      const usage = usageEvent(record.usage, record.total_cost_usd ?? record.totalCostUsd);
      if (usage) events.push(usage);
      const result = asString(record.result);
      if (result) this.outcome.summary = replaceSummary(result);
      const subtype = asString(record.subtype);
      if (record.is_error !== true && subtype === "success") {
        this.outcome.terminal = "succeeded";
        this.outcome.error = undefined;
      } else {
        const failure =
          result || errorMessage(record.error) || subtype || "Claude Code reported failure";
        this.outcome.terminal = "failed";
        this.outcome.error = failure;
        events.push({ type: "diagnostic", level: "error", message: failure });
      }
      return events;
    }

    if (type === "error") {
      const failure = errorMessage(record) ?? "Claude Code reported an unknown error";
      this.outcome.terminal = "failed";
      this.outcome.error = failure;
      events.push({ type: "diagnostic", level: "error", message: failure });
    }

    return events;
  }
}

export class ClaudeExecutor extends CliExecutor {
  readonly provider = "claude" as const;
  protected readonly binaryName = "claude";
  protected readonly binaryEnvironmentVariable = "AGENTQ_CLAUDE_BIN";
  private readonly allowedTools: string[];

  constructor(options: ClaudeExecutorOptions = {}) {
    super(options);
    this.allowedTools = options.allowedTools?.length
      ? [...options.allowedTools]
      : DEFAULT_ALLOWED_TOOLS;
  }

  protected createParser(): StreamParser {
    return new ClaudeStreamParser();
  }

  protected arguments(input: ExecutorRunInput): string[] {
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      this.allowedTools.join(","),
    ];
    if (input.resumeSessionId) args.push("--resume", input.resumeSessionId);
    return args;
  }
}
