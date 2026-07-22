import { dlopen, ptr } from "bun:ffi";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, constants, mkdirSync, readFileSync } from "node:fs";
import { link, open, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

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

interface WindowsJob {
  close(): void;
}

const IDENTITY_HEARTBEAT_MS = 250;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x0000_2000;
const PROCESS_TERMINATE = 0x0000_0001;
const PROCESS_SET_QUOTA = 0x0000_0100;

const LAUNCHER_SOURCE = String.raw`
import { chmodSync, closeSync, ftruncateSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";

const token = process.argv[1];
const payload = process.argv[2];
const identityPath = process.argv[3];
const gatePath = process.argv[4];
if (!token || !payload || !identityPath || !gatePath) process.exit(78);
const supervisorPid = process.ppid;

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
let windowsIdentityHandle;

if (process.platform !== "win32") {
  // The supervisor signals the whole process group. Keep the launcher alive
  // long enough to reap a launched provider, but exit immediately if setup is
  // cancelled while still waiting at the release gate.
  process.on("SIGTERM", () => {
    if (!launched) {
      cleanup();
      process.exit(143);
    }
  });
}

function writeIdentity() {
  const serialized = JSON.stringify({
    pid: process.pid,
    token,
    startMarker,
    sequence: ++sequence,
    updatedAt: Date.now(),
  });
  if (process.platform === "win32") {
    if (windowsIdentityHandle === undefined) {
      windowsIdentityHandle = openSync(identityPath, "wx+", 0o600);
      chmodSync(identityPath, 0o600);
    }
    const contents = Buffer.from(serialized, "utf8");
    ftruncateSync(windowsIdentityHandle, 0);
    let offset = 0;
    while (offset < contents.length) {
      const written = writeSync(
        windowsIdentityHandle,
        contents,
        offset,
        contents.length - offset,
        offset,
      );
      if (written <= 0) throw new Error("Could not refresh the process identity lease");
      offset += written;
    }
    // Reading the path back detects deletion or replacement while the retained
    // handle prevents heartbeat updates from reopening an attacker-controlled path.
    if (readFileSync(identityPath, "utf8") !== serialized) {
      throw new Error("Process identity lease path changed during refresh");
    }
    return;
  }
  const temporary = identityPath + "." + process.pid + ".tmp";
  writeFileSync(temporary, serialized, { encoding: "utf8", mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, identityPath);
}

function cleanup() {
  if (heartbeat) clearInterval(heartbeat);
  if (windowsIdentityHandle !== undefined) {
    try { closeSync(windowsIdentityHandle); } catch {}
    windowsIdentityHandle = undefined;
  }
  // The supervisor verifies ownership before removing a Windows lease. Avoid
  // unlinking a pathname here after a detected delete/replace race.
  if (process.platform !== "win32") {
    try { unlinkSync(identityPath); } catch {}
  }
  try { unlinkSync(gatePath); } catch {}
}

function failBeforeLaunch(error) {
  cleanup();
  if (error) console.error(error instanceof Error ? error.message : String(error));
  if (!launched) process.exit(78);
  identityFailed = true;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(process.pid), "/T", "/F"], {
      detached: false,
      stdio: "ignore",
      windowsHide: true,
    });
    let exiting = false;
    const forceExit = () => {
      if (exiting) return;
      exiting = true;
      try { providerChild?.kill("SIGKILL"); } catch {}
      process.exit(79);
    };
    killer.once("error", forceExit);
    killer.once("close", forceExit);
    setTimeout(forceExit, 1000);
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
} catch (error) {
  failBeforeLaunch(error);
}

function launchProvider() {
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
      'import { chmodSync, renameSync, writeFileSync } from "node:fs";',
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
      'setInterval(() => {',
      '  try { beat(); }',
      '  catch {',
      '    try { process.kill(-targetPid, "SIGKILL"); }',
      '    catch { try { process.kill(targetPid, "SIGKILL"); } catch {} }',
      '    process.exit(79);',
      '  }',
      '}, ${IDENTITY_HEARTBEAT_MS});',
    ].join("\n");
    const sidecar = spawn(process.execPath, ["-e", sidecarSource, String(process.pid), token, startMarker, identityPath, String(sequence)], {
      detached: false,
      stdio: "ignore",
      windowsHide: true,
    });
    sidecar.unref();
    const sidecarDeadline = Date.now() + 3000;
    let sidecarFailed;
    sidecar.once("error", (error) => { sidecarFailed = error; });
    const execWhenSidecarReady = () => {
      if (sidecarFailed || sidecar.exitCode !== null) {
        return failBeforeLaunch(sidecarFailed ?? new Error("Process identity sidecar exited before startup"));
      }
      try {
        const lease = JSON.parse(readFileSync(identityPath, "utf8"));
        if (lease.pid === process.pid && lease.token === token && lease.startMarker === startMarker && lease.sequence > sequence) {
          try {
            process.execve(invocation.command, [invocation.command, ...invocation.args], process.env);
          } catch (execError) {
            console.error(execError instanceof Error ? execError.message : String(execError));
            cleanup();
            return process.exit(127);
          }
          return;
        }
      } catch {}
      if (Date.now() >= sidecarDeadline) {
        return failBeforeLaunch(new Error("Process identity sidecar failed to establish its lease"));
      }
      setTimeout(execWhenSidecarReady, 10);
    };
    execWhenSidecarReady();
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
}

function waitForRelease() {
  if (process.ppid !== supervisorPid) {
    return failBeforeLaunch(new Error("Supervisor exited before releasing the provider"));
  }
  try {
    const gate = readFileSync(gatePath, "utf8");
    if (gate !== token) return failBeforeLaunch(new Error("Provider release gate is invalid"));
    try { unlinkSync(gatePath); } catch {}
    return launchProvider();
  } catch (error) {
    if (error?.code !== "ENOENT") return failBeforeLaunch(error);
  }
  setTimeout(waitForRelease, 10);
}

waitForRelease();
`;

function errorWithCode(error: unknown): error is Error & { code?: string } {
  return error instanceof Error;
}

function createWindowsJob(pid: number): WindowsJob | undefined {
  if (process.platform !== "win32") return undefined;
  if (process.arch !== "x64" && process.arch !== "arm64") {
    throw new Error(`Windows process jobs are unsupported on ${process.arch}`);
  }

  const kernel = dlopen("kernel32.dll", {
    CreateJobObjectW: { args: ["ptr", "ptr"], returns: "ptr" },
    SetInformationJobObject: { args: ["ptr", "u32", "ptr", "u32"], returns: "bool" },
    OpenProcess: { args: ["u32", "bool", "u32"], returns: "ptr" },
    AssignProcessToJobObject: { args: ["ptr", "ptr"], returns: "bool" },
    CloseHandle: { args: ["ptr"], returns: "bool" },
    GetLastError: { args: [], returns: "u32" },
  } as const);
  const api = kernel.symbols;
  const failure = (operation: string) =>
    new Error(`${operation} failed with Windows error ${api.GetLastError()}`);
  const job = api.CreateJobObjectW(null, null);
  if (!job) {
    const error = failure("CreateJobObjectW");
    kernel.close();
    throw error;
  }

  let processHandle: ReturnType<typeof api.OpenProcess> = null;
  try {
    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION is 144 bytes on 64-bit Windows.
    // LimitFlags is the DWORD at offset 16 in BasicLimitInformation.
    const limits = new Uint8Array(144);
    new DataView(limits.buffer).setUint32(16, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, true);
    if (
      !api.SetInformationJobObject(
        job,
        JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
        ptr(limits),
        limits.byteLength,
      )
    ) {
      throw failure("SetInformationJobObject");
    }

    processHandle = api.OpenProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA, false, pid);
    if (!processHandle) throw failure("OpenProcess");
    if (!api.AssignProcessToJobObject(job, processHandle)) {
      throw failure("AssignProcessToJobObject");
    }
    if (!api.CloseHandle(processHandle)) throw failure("CloseHandle(process)");
    processHandle = null;
  } catch (error) {
    if (processHandle) api.CloseHandle(processHandle);
    api.CloseHandle(job);
    kernel.close();
    throw error;
  }

  let closed = false;
  return {
    close() {
      if (closed) return;
      closed = true;
      const succeeded = api.CloseHandle(job);
      const error = succeeded ? undefined : failure("CloseHandle(job)");
      kernel.close();
      if (error) throw error;
    },
  };
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

async function waitForLauncherIdentity(
  pid: number,
  token: string,
  path: string,
): Promise<ProcessIdentity> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const lease = await readIdentityLease(path);
    if (
      lease &&
      lease.pid === pid &&
      lease.token === token &&
      lease.startMarker &&
      isProcessAlive(pid)
    ) {
      const actualStartMarker = processStartMarker(pid);
      if (actualStartMarker && actualStartMarker !== lease.startMarker) {
        throw new Error(`Process identity marker does not match PID ${pid}`);
      }
      return { pid, token, path, startMarker: lease.startMarker };
    }
    if (!isProcessAlive(pid)) {
      throw new Error(`Gated process ${pid} exited before establishing its identity`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out establishing process identity for PID ${pid}`);
    }
    await Bun.sleep(10);
  }
}

async function writeReleaseGate(path: string, token: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(token, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function readIdentityLeaseOnce(path: string): Promise<IdentityLease | undefined> {
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

async function readIdentityLease(path: string): Promise<IdentityLease | undefined> {
  const attempts = process.platform === "win32" ? 4 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const lease = await readIdentityLeaseOnce(path);
    if (lease) return lease;
    if (attempt + 1 < attempts) await Bun.sleep(5);
  }
  return undefined;
}

function leaseMatches(lease: IdentityLease, identity: ProcessIdentity): boolean {
  return (
    lease.pid === identity.pid &&
    lease.token === identity.token &&
    lease.startMarker === identity.startMarker
  );
}

async function unlinkOwnedIdentityLease(
  path: string,
  pid: number,
  token: string,
  startMarker?: string,
): Promise<void> {
  const lease = await readIdentityLease(path);
  if (
    !lease ||
    lease.pid !== pid ||
    lease.token !== token ||
    (startMarker !== undefined && lease.startMarker !== startMarker)
  ) {
    return;
  }
  await unlink(path).catch(() => undefined);
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
    if (expectedIdentity) {
      await unlinkOwnedIdentityLease(
        expectedIdentity.path,
        expectedIdentity.pid,
        expectedIdentity.token,
        expectedIdentity.startMarker,
      );
    }
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
  if (expectedIdentity) {
    await unlinkOwnedIdentityLease(
      expectedIdentity.path,
      expectedIdentity.pid,
      expectedIdentity.token,
      expectedIdentity.startMarker,
    );
  }
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
  const gatePath = token ? join(identityDirectory, `${token}.gate`) : undefined;
  const payload = gated
    ? Buffer.from(
        JSON.stringify({ command: options.command, args: [...(options.args ?? [])] }),
        "utf8",
      ).toString("base64url")
    : undefined;
  const child = spawn(
    gated ? process.execPath : options.command,
    gated
      ? [
          "-e",
          LAUNCHER_SOURCE,
          token as string,
          payload as string,
          identityPath as string,
          gatePath as string,
        ]
      : [...(options.args ?? [])],
    {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );

  const pid = child.pid;
  if (pid === undefined) {
    child.once("error", () => {});
    throw new Error(`Unable to start process: ${options.command}`);
  }
  const processId: number = pid;
  let windowsJob: WindowsJob | undefined;
  try {
    windowsJob = gated ? createWindowsJob(processId) : undefined;
  } catch (error) {
    child.once("error", () => {});
    child.kill("SIGKILL");
    throw error;
  }

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
        if (windowsJob) {
          try {
            windowsJob.close();
          } catch (error) {
            spawnError ??= error instanceof Error ? error : new Error(String(error));
          }
        }
        if (process.platform !== "win32" && isProcessGroupAlive(processId)) {
          try {
            await terminateProcessTree(processId, Math.min(options.cancelGraceMs ?? 250, 1_000));
          } catch (error) {
            spawnError ??= error instanceof Error ? error : new Error(String(error));
          }
        }
        if (identityPath && token) {
          await unlinkOwnedIdentityLease(identityPath, processId, token);
        }
        if (gatePath) await unlink(gatePath).catch(() => undefined);
        settled = true;
        options.signal?.removeEventListener("abort", abort);
        resolveCompletion({ exitCode, signal, error: spawnError, cancelled });
      })();
    });
  });

  const identity =
    token && identityPath ? waitForLauncherIdentity(processId, token, identityPath) : undefined;

  async function terminate(): Promise<void> {
    if (settled) return;
    if (leaderClosed) return await completion.then(() => undefined);
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
    if (settled || !gatePath || !token) {
      throw new Error(`Gated process ${processId} exited before release`);
    }
    await writeReleaseGate(gatePath, token);
    if (settled) {
      await unlink(gatePath).catch(() => undefined);
      throw new Error(`Gated process ${processId} exited before release`);
    }
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
