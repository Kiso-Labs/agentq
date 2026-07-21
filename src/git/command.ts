import { spawn } from "node:child_process";
import { AgentQError } from "../core/errors.ts";
import { resolveCommandInvocation } from "../process/resolve-binary.ts";
import { terminateProcessTree } from "../process/spawn.ts";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  stdin?: string;
  maxOutputBytes?: number;
  killProcessTree?: boolean;
  cancelGraceMs?: number;
}

export async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {},
): Promise<CommandResult> {
  const maxOutputBytes = options.maxOutputBytes ?? 4 * 1024 * 1024;
  options.signal?.throwIfAborted();

  return await new Promise<CommandResult>((resolve, reject) => {
    const environment = options.env ?? process.env;
    const invocation = resolveCommandInvocation(command, args, environment);
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: environment,
      detached: options.killProcessTree === true && process.platform !== "win32",
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    let aborted = false;
    let settled = false;
    let spawnError: Error | undefined;
    let termination: Promise<void> | undefined;

    const cleanup = () => options.signal?.removeEventListener("abort", abort);
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const abort = () => {
      if (aborted) return;
      aborted = true;
      const pid = child.pid;
      if (!pid) return;
      if (options.killProcessTree) {
        termination = terminateProcessTree(pid, options.cancelGraceMs);
      } else {
        child.kill("SIGTERM");
        termination = Promise.resolve();
      }
      void termination.catch(rejectOnce);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();

    const collect = (chunks: Buffer[], chunk: Buffer, currentSize: number): number => {
      const remaining = maxOutputBytes - currentSize;
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      return currentSize + chunk.length;
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutSize = collect(stdout, chunk, stdoutSize);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrSize = collect(stderr, chunk, stderrSize);
    });
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", async (code) => {
      if (settled) return;
      try {
        await termination;
      } catch (error) {
        rejectOnce(error);
        return;
      }
      if (settled) return;
      settled = true;
      cleanup();
      if (aborted) {
        const reason = options.signal?.reason;
        reject(reason instanceof Error ? reason : new Error(String(reason ?? "Command aborted")));
        return;
      }
      if (spawnError) {
        reject(spawnError);
        return;
      }
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code ?? 1,
      });
    });

    if (options.stdin !== undefined) child.stdin?.end(options.stdin);
  });
}

export async function runGit(
  repoPath: string,
  args: string[],
  options: Omit<RunCommandOptions, "cwd"> & { allowFailure?: boolean } = {},
): Promise<CommandResult> {
  const result = await runCommand("git", ["-C", repoPath, ...args], {
    ...options,
    killProcessTree: true,
  });
  if (result.exitCode !== 0 && !options.allowFailure) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
    throw new AgentQError(`git ${args[0] ?? "command"} failed: ${detail}`, "GIT_COMMAND_FAILED");
  }
  return result;
}
