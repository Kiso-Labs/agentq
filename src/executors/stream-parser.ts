import type { ExecutorEvent } from "../core/types.ts";

const MAX_SUMMARY_LENGTH = 64 * 1024;

export interface StreamOutcome {
  terminal: "pending" | "succeeded" | "failed";
  sessionId?: string;
  summary?: string;
  error?: string;
}

export interface StreamParser {
  readonly outcome: StreamOutcome;
  parseLine(line: string): ExecutorEvent[];
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function errorMessage(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  const record = asRecord(value);
  if (!record) return undefined;
  return (
    asString(record.message)?.trim() ||
    asString(record.error)?.trim() ||
    errorMessage(record.error) ||
    asString(record.result)?.trim() ||
    undefined
  );
}

export function compactDetail(value: unknown, maxLength = 2_000): string | undefined {
  if (value === undefined || value === null) return undefined;
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  if (!text) return undefined;
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}

export function replaceSummary(value: string): string {
  return value.length <= MAX_SUMMARY_LENGTH
    ? value
    : `${value.slice(0, MAX_SUMMARY_LENGTH)}\n… summary truncated …`;
}

export function appendSummary(current: string | undefined, delta: string): string {
  const combined = `${current ?? ""}${delta}`;
  if (combined.length <= MAX_SUMMARY_LENGTH) return combined;
  return `… earlier summary truncated …\n${combined.slice(-MAX_SUMMARY_LENGTH)}`;
}

export function usageEvent(
  usageValue: unknown,
  costValue?: unknown,
): Extract<ExecutorEvent, { type: "usage" }> | undefined {
  const usage = asRecord(usageValue);
  const inputTokens = asNumber(usage?.input_tokens ?? usage?.inputTokens);
  const outputTokens = asNumber(usage?.output_tokens ?? usage?.outputTokens);
  const costUsd = asNumber(costValue ?? usage?.cost_usd ?? usage?.costUsd);
  if (inputTokens === undefined && outputTokens === undefined && costUsd === undefined)
    return undefined;
  return { type: "usage", inputTokens, outputTokens, costUsd };
}

export function malformedJsonDiagnostic(
  providerName: string,
  line: string,
): Extract<ExecutorEvent, { type: "diagnostic" }> {
  const preview = line.length > 240 ? `${line.slice(0, 240)}…` : line;
  return {
    type: "diagnostic",
    level: "warning",
    message: `${providerName} emitted non-JSON output: ${preview}`,
  };
}
