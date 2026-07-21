import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, constants, mkdirSync, readFileSync } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

export interface SpawnProcessOptions {
  command: string;
  args?: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
  signal?: AbortSignal;
  cancelGraceMs?: number;
  /**
   * Start behind a parent-owned gate. The real command is not spawned until
   * `release()` is called, and the launcher exits if its parent dies first.
   */
  gated?: boolean;
  identityDirectory?: string;
}

export interface ProcessExit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
  cancelled: boolean;
}

export interface ProcessIdentity {
  pid: number;
  token: string;
  /** Launcher-generated creation marker paired with a live filesystem lease. */
  startMarker: string;
  path: string;
}

export interface ManagedProcess {
  pid: number;
  stdout: Readable;
  stderr: Readable;
  completion: Promise<ProcessExit>;
  identity?: Promise<ProcessIdentity>;
  release(): Promise<void>;
  cancel(reason?: string): Promise<void>;
}

interface IdentityLease {
  pid: number;
  token: string;
  startMarker: string;
  sequence: number;
  updatedAt: number;
}

const IDENTITY_HEARTBEAT_MS = 250;

const LAUNCHER_SOURCE = String.raw`
import { chmodSync, closeSync, read, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";

const token = process.argv[1];
const payload = process.argv[2];
const identityPath = process.argv[3];
if (!token || !payload || !identityPath) process.exit(78);

function processStartMarker(pid) {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync("/proc/" + pid + "/stat", "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      return fields[19] ? "linux:" + fields[19] : undefined;
    }
    if (process.platform === "darwin") {
      const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
      const value = result.status === 0 ? result.stdout.trim() : "";
      return value ? "darwin:" + value : undefined;
    }
    if (process.platform === "win32") {
      const script = "(Get-Process -Id " + pid + ").StartTime.ToUniversalTime().Ticks";
      const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true });
      const value = result.status === 0 ? result.stdout.trim() : "";
      return value ? "win32:" + value : undefined;
    }
  } catch {}
  return undefined;
}

const startMarker = processStartMarker(process.pid) ??
  "lease:" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
let sequence = 0;
let launched = false;
let heartbeat;
let providerChild;
let identityFailed = false;

if (process.platform !== "win32") {
  // The supervisor signals the whole process group. Keep the launcher alive
  // long enough to reap the provider and clean its identity lease.
  process.on("SIGTERM", () => {});
}

function writeIdentity() {
  const temporary = identityPath + "." + process.pid + ".tmp";
  writeFileSync(temporary, JSON.stringify({
    pid: process.pid,
    token,
    startMarker,
    sequence: ++sequence,
    updatedAt: Date.now(),
  }), { encoding: "utf8", mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, identityPath);
}

function cleanup() {
  if (heartbeat) clearInterval(heartbeat);
  try { unlinkSync(identityPath); } catch {}
}

function failBeforeLaunch(error) {
  cleanup();
  if (error) console.error(error instanceof Error ? error.message : String(error));
  if (!launched) process.exit(78);
  identityFailed = true;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(process.pid), "/T", "/F"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    killer.unref();
    return;
  }
  try { process.kill(-process.pid, "SIGTERM"); }
  catch { providerChild?.kill("SIGTERM"); }
  setTimeout(() => {
    try { process.kill(-process.pid, "SIGKILL"); }
    catch { process.exit(79); }
  }, 1000);
}

try {
  writeIdentity();
  heartbeat = setInterval(() => {
    try { writeIdentity(); } catch (error) { failBeforeLaunch(error); }
  }, ${IDENTITY_HEARTBEAT_MS});
  writeSync(4, JSON.stringify({ startMarker }) + "\n");
  closeSync(4);
} catch (error) {
  failBeforeLaunch(error);
}

const gate = Buffer.alloc(1);
read(3, gate, 0, 1, null, (error, bytesRead) => {
  try { closeSync(3); } catch {}
  if (error || bytesRead !== 1 || gate[0] !== 0x47) return failBeforeLaunch(error);
  launched = true;

  let invocation;
  try {
    invocation = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch (parseError) {
    cleanup();
    return process.exit(78);
  }

  if (process.platform !== "win32") {
    if (heartbeat) clearInterval(heartbeat);
    const sidecarSource = [
      'import { chmodSync, closeSync, renameSync, writeFileSync, writeSync } from "node:fs";',
      'const targetPid = Number(process.argv[1]);',
      'const token = process.argv[2];',
      'const startMarker = process.argv[3];',
      'const identityPath = process.argv[4];',
      'let sequence = Number(process.argv[5]);',
      'function beat() {',
      '  if (process.ppid !== targetPid) process.exit(0);',
      '  const temporary = identityPath + ".sidecar." + process.pid + ".tmp";',
      '  writeFileSync(temporary, JSON.stringify({ pid: targetPid, token, startMarker, sequence: ++sequence, updatedAt: Date.now() }), { encoding: "utf8", mode: 0o600 });',
      '  chmodSync(temporary, 0o600);',
      '  renameSync(temporary, identityPath);',
      '}',
      'beat();',
      'writeSync(3, Buffer.from([0x52]));',
      'closeSync(3);',
      'setInterval(() => { try { beat(); } catch { process.exit(79); } }, ${IDENTITY_HEARTBEAT_MS});',
    ].join("\n");
    const sidecar = spawn(process.execPath, ["-e", sidecarSource, String(process.pid), token, startMarker, identityPath, String(sequence)], {
      detached: false,
      stdio: ["ignore", "ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    sidecar.unref();
    const ready = sidecar.stdio[3];
    let sidecarReady = false;
    const execProvider = (chunk) => {
      if (sidecarReady) return;
      sidecarReady = true;
      if (!chunk || chunk[0] !== 0x52) {
        return failBeforeLaunch(new Error("Process identity sidecar failed to start"));
      }
      try {
        process.execve(invocation.command, [invocation.command, ...invocation.args], process.env);
      } catch (execError) {
        console.error(execError instanceof Error ? execError.message : String(execError));
        cleanup();
        return process.exit(127);
      }
    };
    ready.once("data", execProvider);
    ready.once("error", failBeforeLaunch);
    ready.once("end", () => {
      if (!sidecarReady) {
        failBeforeLaunch(new Error("Process identity sidecar closed before startup"));
      }
    });
    return;
  }

  const child = spawn(invocation.command, invocation.args, {
    cwd: process.cwd(),
    env: process.env,
    detached: false,
    shell: false,
    stdio: ["pipe", "inherit", "inherit"],
    windowsHide: true,
  });
  providerChild = child;
  child.once("error", (spawnError) => {
    console.error(spawnError instanceof Error ? spawnError.message : String(spawnError));
    cleanup();
    process.exit(127);
  });
  child.once("close", (code) => {
    cleanup();
    if (!identityFailed) process.exit(code ?? 1);
  });
  process.stdin.on("error", () => {});
  child.stdin.on("error", () => {});
  process.stdin.pipe(child.stdin);
});
`;

function errorWithCode(error: unknown): error is Error & { code?: string } {
  return error instanceof Error;
}

export function processStartMarker(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 1) return undefined;
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/);
      return fields[19] ? `linux:${fields[19]}` : undefined;
    }
    if (process.platform === "darwin") {
      const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
      });
      const value = result.status === 0 ? result.stdout.trim() : "";
      return value ? `darwin:${value}` : undefined;
    }
    if (process.platform === "win32") {
      const script = `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`;
      const result = spawnSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { encoding: "utf8", windowsHide: true },
      );
      const value = result.status === 0 ? result.stdout.trim() : "";
      return value ? `win32:${value}` : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function sendPosixGroupSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (errorWithCode(error) && error.code === "ESRCH") return;
    try {
      process.kill(pid, signal);
    } catch (fallbackError) {
      if (!errorWithCode(fallbackError) || fallbackError.code !== "ESRCH") throw fallbackError;
    }
  }
}

function readLauncherIdentity(
  stream: Readable,
  pid: number,
  token: string,
  path: string,
): Promise<ProcessIdentity> {
  return new Promise((resolve, reject) => {
    let value = "";
    let settled = false;
    const finish = (error?: Error, identity?: ProcessIdentity) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeAllListeners();
      if (error) reject(error);
      else if (identity) resolve(identity);
    };
    const timer = setTimeout(
      () => finish(new Error(`Timed out establishing process identity for PID ${pid}`)),
      3_000,
    );
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      value += chunk;
      if (value.length > 4_096) {
        finish(new Error(`Invalid process identity response for PID ${pid}`));
        return;
      }
      const newline = value.indexOf("\n");
      if (newline < 0) return;
      try {
        const parsed = JSON.parse(value.slice(0, newline)) as { startMarker?: unknown };
        if (typeof parsed.startMarker !== "string" || !parsed.startMarker) {
          throw new Error("invalid identity fields");
        }
        finish(undefined, { pid, token, path, startMarker: parsed.startMarker });
      } catch {
        finish(new Error(`Invalid process identity response for PID ${pid}`));
      }
    });
    stream.once("error", (error) => finish(error));
    stream.once("end", () => {
      if (!settled) finish(new Error(`Process identity stream closed for PID ${pid}`));
    });
  });
}

async function readIdentityLease(path: string): Promise<IdentityLease | undefined> {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | noFollow);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 2 || metadata.size > 4_096) return undefined;
    const parsed = JSON.parse(await handle.readFile("utf8")) as Partial<IdentityLease>;
    if (
      !Number.isSafeInteger(parsed.pid) ||
      typeof parsed.token !== "string" ||
      typeof parsed.startMarker !== "string" ||
      !Number.isSafeInteger(parsed.sequence) ||
      !Number.isFinite(parsed.updatedAt)
    ) {
      return undefined;
    }
    return parsed as IdentityLease;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function leaseMatches(lease: IdentityLease, identity: ProcessIdentity): boolean {
  return (
    lease.pid === identity.pid &&
    lease.token === identity.token &&
    lease.startMarker === identity.startMarker
  );
}

export async function matchesProcessIdentity(identity: ProcessIdentity): Promise<boolean> {
  return (await inspectProcessIdentity(identity)) === "matches";
}

async function runTaskkill(pid: number): Promise<void> {
  const result = await new Promise<{ code: number; error?: Error }>((resolve) => {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    let spawnError: Error | undefined;
    killer.once("error", (error) => {
      spawnError = error;
    });
    killer.once("close", (code) => resolve({ code: code ?? 1, error: spawnError }));
  });
  if ((result.error || result.code !== 0) && isProcessAlive(pid)) {
    throw result.error ?? new Error(`taskkill failed for PID ${pid} with exit code ${result.code}`);
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorWithCode(error) && error.code === "EPERM";
  }
}

export function isProcessGroupAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  if (process.platform === "win32") return isProcessAlive(pid);
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return errorWithCode(error) && error.code === "EPERM";
  }
}

export type ProcessIdentityState = "dead" | "matches" | "mismatch" | "unverifiable";

export async function inspectProcessIdentity(
  identity: ProcessIdentity,
): Promise<ProcessIdentityState> {
  if (!isProcessAlive(identity.pid)) return "dead";
  const actualStartMarker = processStartMarker(identity.pid);
  if (actualStartMarker && actualStartMarker !== identity.startMarker) return "mismatch";
  if (!actualStartMarker && !identity.startMarker.startsWith("lease:")) return "unverifiable";
  const first = await readIdentityLease(identity.path);
  if (!first || !leaseMatches(first, identity)) return "unverifiable";
  await Bun.sleep(IDENTITY_HEARTBEAT_MS + 75);
  if (!isProcessAlive(identity.pid)) return "dead";
  const second = await readIdentityLease(identity.path);
  return second && leaseMatches(second, identity) && second.sequence > first.sequence
    ? "matches"
    : "unverifiable";
}

/** Terminate a process tree previously launched as its own process group. */
export async function terminateProcessTree(
  pid: number,
  graceMs = 5_000,
  expectedIdentity?: ProcessIdentity,
): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return;
  if (expectedIdentity) {
    if (expectedIdentity.pid !== pid || !(await matchesProcessIdentity(expectedIdentity))) {
      throw new Error(`Refusing to signal PID ${pid}: process identity does not match`);
    }
  }
  if (process.platform === "win32") {
    await runTaskkill(pid);
    if (isProcessAlive(pid)) throw new Error(`Process tree ${pid} survived taskkill`);
    if (expectedIdentity) await unlink(expectedIdentity.path).catch(() => undefined);
    return;
  }

  sendPosixGroupSignal(pid, "SIGTERM");
  // A wedged provider may be job-control stopped; resume it so the pending
  // termination signal can run before escalation.
  sendPosixGroupSignal(pid, "SIGCONT");
  const deadline = Date.now() + Math.max(0, graceMs);
  while (isProcessGroupAlive(pid) && Date.now() < deadline) await Bun.sleep(50);
  if (isProcessGroupAlive(pid)) {
    sendPosixGroupSignal(pid, "SIGKILL");
    const killDeadline = Date.now() + 2_000;
    while (isProcessGroupAlive(pid) && Date.now() < killDeadline) await Bun.sleep(25);
  }
  if (isProcessGroupAlive(pid)) {
    throw new Error(`Process group ${pid} survived SIGKILL`);
  }
  if (expectedIdentity) await unlink(expectedIdentity.path).catch(() => undefined);
}

/** Spawn an argv-safe child in its own POSIX process group. */
export function spawnProcess(options: SpawnProcessOptions): ManagedProcess {
  const gated = options.gated === true;
  const token = gated ? randomUUID() : undefined;
  const identityDirectory =
    options.identityDirectory ?? join(tmpdir(), "agentq-process-identities");
  if (gated) {
    mkdirSync(identityDirectory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(identityDirectory, 0o700);
  }
  const identityPath = token ? join(identityDirectory, `${token}.json`) : undefined;
  const payload = gated
    ? Buffer.from(
        JSON.stringify({ command: options.command, args: [...(options.args ?? [])] }),
        "utf8",
      ).toString("base64url")
    : undefined;
  const child = spawn(
    gated ? process.execPath : options.command,
    gated
      ? ["-e", LAUNCHER_SOURCE, token as string, payload as string, identityPath as string]
      : [...(options.args ?? [])],
    {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      shell: false,
      stdio: gated ? ["pipe", "pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );

  const pid = child.pid;
  if (pid === undefined) {
    child.once("error", () => {});
    throw new Error(`Unable to start process: ${options.command}`);
  }
  const processId: number = pid;
  const control = gated ? (child.stdio[3] as Writable | null) : undefined;
  const identityStream = gated ? (child.stdio[4] as Readable | null) : undefined;

  let settled = false;
  let leaderClosed = false;
  let cancelled = false;
  let released = !gated;
  let spawnError: Error | undefined;
  let cancellation: Promise<void> | undefined;

  const completion = new Promise<ProcessExit>((resolveCompletion) => {
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (exitCode, signal) => {
      leaderClosed = true;
      void (async () => {
        if (process.platform !== "win32" && isProcessGroupAlive(processId)) {
          try {
            await terminateProcessTree(processId, Math.min(options.cancelGraceMs ?? 250, 1_000));
          } catch (error) {
            spawnError ??= error instanceof Error ? error : new Error(String(error));
          }
        }
        if (identityPath) await unlink(identityPath).catch(() => undefined);
        settled = true;
        options.signal?.removeEventListener("abort", abort);
        resolveCompletion({ exitCode, signal, error: spawnError, cancelled });
      })();
    });
  });

  const identity =
    token && identityStream && identityPath
      ? readLauncherIdentity(identityStream, processId, token, identityPath)
      : undefined;

  async function terminate(): Promise<void> {
    if (settled) return;
    if (leaderClosed) return await completion.then(() => undefined);
    control?.destroy();
    await terminateProcessTree(processId, options.cancelGraceMs ?? 1_000);
    if (!settled && process.platform === "win32") child.kill("SIGKILL");
    await completion;
  }

  function cancel(_reason?: string): Promise<void> {
    cancelled = true;
    cancellation ??= terminate();
    return cancellation;
  }

  function abort(): void {
    void cancel(String(options.signal?.reason ?? "aborted"));
  }

  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) queueMicrotask(abort);

  // Reading agents expect EOF. EPIPE is normal when a CLI exits before consuming its prompt.
  child.stdin?.on("error", () => {});

  async function release(): Promise<void> {
    if (released) return;
    options.signal?.throwIfAborted();
    if (settled || !control) throw new Error(`Gated process ${processId} exited before release`);
    await new Promise<void>((resolve, reject) => {
      control.end(Buffer.from([0x47]), (error?: Error | null) =>
        error ? reject(error) : resolve(),
      );
    });
    released = true;
    child.stdin?.end(options.stdin ?? "");
  }

  if (!gated) child.stdin?.end(options.stdin ?? "");
  return {
    pid: processId,
    stdout: child.stdout,
    stderr: child.stderr,
    completion,
    identity,
    release,
    cancel,
  };
}
