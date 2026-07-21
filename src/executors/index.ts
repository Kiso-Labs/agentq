import type { AgentExecutor, Provider } from "../core/types.ts";
import { ClaudeExecutor, type ClaudeExecutorOptions } from "./claude.ts";
import { CodexExecutor, type CodexExecutorOptions } from "./codex.ts";

export { ClaudeExecutor, type ClaudeExecutorOptions, ClaudeStreamParser } from "./claude.ts";
export type { CliExecutorOptions } from "./cli-executor.ts";
export { CodexExecutor, type CodexExecutorOptions, CodexStreamParser } from "./codex.ts";
export type { StreamOutcome, StreamParser } from "./stream-parser.ts";

export interface ExecutorFactoryOptions {
  codex?: CodexExecutorOptions;
  claude?: ClaudeExecutorOptions;
}

export function createExecutors(options: ExecutorFactoryOptions = {}): {
  codex: CodexExecutor;
  claude: ClaudeExecutor;
} {
  return {
    codex: new CodexExecutor(options.codex),
    claude: new ClaudeExecutor(options.claude),
  };
}

export function createExecutorMap(
  options: ExecutorFactoryOptions = {},
): Map<Provider, AgentExecutor> {
  const executors = createExecutors(options);
  return new Map<Provider, AgentExecutor>([
    ["codex", executors.codex],
    ["claude", executors.claude],
  ]);
}
