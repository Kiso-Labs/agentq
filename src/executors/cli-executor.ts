import { join } from "node:path";
import type {
  AgentExecutor,
  Execution,
  ExecutorEvent,
  ExecutorResult,
  ExecutorRunInput,
  Provider,
  ProviderHealth,
} from "../core/types.ts";
import {
  BoundedAsyncQueue,
  lines,
  type ProcessExit,
  resolveBinary,
  resolveCommandInvocation,
  spawnProcess,
} from "../process/index.ts";
import type { StreamParser } from "./stream-parser.ts";

export interface CliExecutorOptions {
  binary?: string;
  env?: NodeJS.ProcessEnv;
  eventBufferSize?: number;
  cancelGraceMs?: number;
}

interface StartedProcessResult {
  exit: ProcessExit;
  stderr: string;
  streamError?: string;
}

const MAX_CAPTURED_STDERR = 64 * 1024;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export abstract class CliExecutor implements AgentExecutor {
  abstract readonly provider: Provider;
  protected abstract readonly binaryName: string;
  protected abstract readonly binaryEnvironmentVariable: string;
  protected readonly options: CliExecutorOptions;

  constructor(options: CliExecutorOptions = {}) {
    this.options = options;
  }

  protected abstract createParser(): StreamParser;
  protected abstract arguments(input: ExecutorRunInput): string[];

  private environment(runEnvironment: Record<string, string> = {}): NodeJS.ProcessEnv {
    return { ...process.env, ...this.options.env, ...runEnvironment };
  }

  private binary(environment: NodeJS.ProcessEnv): string | undefined {
    if (this.options.binary?.trim()) return this.options.binary.trim();
    return resolveBinary({
      name: this.binaryName,
      envVar: this.binaryEnvironmentVariable,
      env: environment,
      from: import.meta.dirname,
    });
  }

  async probe(): Promise<ProviderHealth> {
    const environment = this.environment();
    const binary = this.binary(environment);
    if (!binary) {
      return {
        provider: this.provider,
        available: false,
        message: `${this.binaryName} was not found; install it or set ${this.binaryEnvironmentVariable}`,
      };
    }

    try {
      const invocation = resolveCommandInvocation(binary, ["--version"], environment);
      const processHandle = spawnProcess({
        command: invocation.command,
        args: invocation.args,
        cwd: process.cwd(),
        env: environment,
        stdin: "",
        cancelGraceMs: this.options.cancelGraceMs,
      });
      const stdoutPromise = this.collectProbeOutput(processHandle.stdout);
      const stderrPromise = this.collectProbeOutput(processHandle.stderr);
      const [stdout, stderr, exit] = await Promise.all([
        stdoutPromise,
        stderrPromise,
        processHandle.completion,
      ]);
      const version = stdout.trim() || stderr.trim();
      if (exit.exitCode !== 0 || exit.error) {
        return {
          provider: this.provider,
          available: false,
          binary,
          version: version || undefined,
          message: exit.error?.message || version || `${this.binaryName} --version failed`,
        };
      }
      return {
        provider: this.provider,
        available: true,
        binary,
        version: version || undefined,
        message: version || `${this.binaryName} is available`,
      };
    } catch (error) {
      return {
        provider: this.provider,
        available: false,
        binary,
        message: message(error),
      };
    }
  }

  private async collectProbeOutput(stream: AsyncIterable<Uint8Array | string>): Promise<string> {
    let output = "";
    for await (const line of lines(stream, { maxLineLength: 32 * 1024 })) {
      if (output.length >= 32 * 1024) continue;
      output += `${line}\n`;
    }
    return output.slice(0, 32 * 1024);
  }

  async start(input: ExecutorRunInput): Promise<Execution> {
    const environment = this.environment(input.env);
    const binary = this.binary(environment);
    if (!binary) {
      throw new Error(
        `${this.binaryName} was not found; install it or set ${this.binaryEnvironmentVariable}`,
      );
    }

    const parser = this.createParser();
    const eventQueue = new BoundedAsyncQueue<ExecutorEvent>(this.options.eventBufferSize ?? 512);
    const invocation = resolveCommandInvocation(binary, this.arguments(input), environment);
    const processHandle = spawnProcess({
      command: invocation.command,
      args: invocation.args,
      cwd: input.cwd,
      env: environment,
      stdin: input.prompt,
      signal: input.signal,
      cancelGraceMs: this.options.cancelGraceMs,
      gated: true,
      identityDirectory: input.env.AGENTQ_STATE_DIR
        ? join(input.env.AGENTQ_STATE_DIR, "process-identities")
        : undefined,
    });

    let processIdentity: Awaited<NonNullable<typeof processHandle.identity>>;
    try {
      if (!processHandle.identity) throw new Error("Provider launcher did not expose an identity");
      processIdentity = await processHandle.identity;
    } catch (error) {
      await processHandle.cancel("Unable to establish provider process identity").catch(() => {});
      throw error;
    }

    let explicitlyCancelled = false;
    const completion = this.completeExecution(
      input,
      parser,
      processHandle,
      eventQueue,
      () => explicitlyCancelled,
    );

    if (!input.deferStart) await processHandle.release();

    return {
      pid: processHandle.pid,
      processIdentity,
      events: eventQueue,
      completion,
      release: () => processHandle.release(),
      cancel: async (reason?: string) => {
        explicitlyCancelled = true;
        await processHandle.cancel(reason);
      },
    };
  }

  private async completeExecution(
    input: ExecutorRunInput,
    parser: StreamParser,
    processHandle: ReturnType<typeof spawnProcess>,
    eventQueue: BoundedAsyncQueue<ExecutorEvent>,
    explicitlyCancelled: () => boolean,
  ): Promise<ExecutorResult> {
    let stderr = "";
    let streamError: string | undefined;

    const stdoutPump = (async () => {
      try {
        for await (const line of lines(processHandle.stdout)) {
          if (!line.trim()) continue;
          for (const event of parser.parseLine(line)) eventQueue.push(event);
        }
      } catch (error) {
        streamError = `Unable to read ${this.provider} output: ${message(error)}`;
        eventQueue.push({ type: "diagnostic", level: "error", message: streamError });
      }
    })();

    const stderrPump = (async () => {
      try {
        for await (const line of lines(processHandle.stderr, { maxLineLength: 1024 * 1024 })) {
          if (!line.trim()) continue;
          if (stderr.length < MAX_CAPTURED_STDERR) stderr += `${line}\n`;
          eventQueue.push({ type: "diagnostic", level: "warning", message: line });
        }
      } catch (error) {
        streamError ??= `Unable to read ${this.provider} diagnostics: ${message(error)}`;
        eventQueue.push({ type: "diagnostic", level: "error", message: streamError });
      }
    })();

    try {
      const [exit] = await Promise.all([processHandle.completion, stdoutPump, stderrPump]);
      const processResult: StartedProcessResult = { exit, stderr: stderr.trim(), streamError };
      const result = this.result(input, parser, processResult, explicitlyCancelled());
      if (eventQueue.dropped > 0) {
        eventQueue.push({
          type: "diagnostic",
          level: "warning",
          message: `Dropped ${eventQueue.dropped} buffered ${this.provider} events because the consumer fell behind`,
        });
      }
      eventQueue.close();
      return result;
    } catch (error) {
      const errorText = message(error);
      eventQueue.push({ type: "diagnostic", level: "error", message: errorText });
      eventQueue.close();
      return {
        status: "failed",
        exitCode: null,
        signal: null,
        sessionId: parser.outcome.sessionId,
        summary: parser.outcome.summary,
        error: errorText,
      };
    }
  }

  private result(
    input: ExecutorRunInput,
    parser: StreamParser,
    processResult: StartedProcessResult,
    explicitlyCancelled: boolean,
  ): ExecutorResult {
    const { exit, stderr, streamError } = processResult;
    const common = {
      exitCode: exit.exitCode,
      signal: exit.signal,
      sessionId: parser.outcome.sessionId,
      summary: parser.outcome.summary,
    };

    if (exit.cancelled || explicitlyCancelled || input.signal.aborted) {
      return { ...common, status: "cancelled" };
    }

    if (exit.error || streamError || exit.exitCode !== 0) {
      return {
        ...common,
        status: "failed",
        error:
          exit.error?.message ||
          streamError ||
          parser.outcome.error ||
          stderr ||
          `${this.binaryName} exited with code ${String(exit.exitCode)}`,
      };
    }

    if (parser.outcome.terminal === "failed") {
      return {
        ...common,
        status: "failed",
        error: parser.outcome.error || stderr || `${this.binaryName} reported failure`,
      };
    }

    if (parser.outcome.terminal !== "succeeded") {
      return {
        ...common,
        status: "failed",
        error: `${this.provider === "codex" ? "Codex" : "Claude Code"} exited without a successful terminal event`,
      };
    }

    return { ...common, status: "succeeded" };
  }
}
