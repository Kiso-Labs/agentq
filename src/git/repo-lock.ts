import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { AgentQError } from "../core/errors.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_STALE_MS = 120_000;
const MAX_BUSY_SLICE_MS = 100;

interface LockOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Retained for API compatibility; SQLite releases the lock on process death. */
  staleMs?: number;
}

function duration(value: number, name: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new AgentQError(
      `${name} must be an integer greater than or equal to ${minimum}`,
      "INVALID_REPO_LOCK_OPTIONS",
      2,
    );
  }
  return value;
}

function secureMode(path: string, mode: number): void {
  if (process.platform === "win32") return;
  try {
    chmodSync(path, mode);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function sqliteBusy(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.startsWith("SQLITE_BUSY");
}

/**
 * Serialize Git metadata mutations for one repository.
 *
 * Each repository gets a tiny SQLite database, and the operation holds an
 * IMMEDIATE transaction for its full lifetime. SQLite's OS-backed file lock is
 * released automatically if the process crashes, so takeover needs no PID,
 * timeout heuristic, unlink, or stale-owner race. Separate repositories remain
 * fully parallel because they use separate database files.
 */
export async function withRepoLock<T>(
  locksDir: string,
  repoPath: string,
  operation: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const timeoutMs = duration(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs", 0);
  duration(options.staleMs ?? DEFAULT_STALE_MS, "staleMs", 1);
  mkdirSync(locksDir, { recursive: true, mode: 0o700 });
  secureMode(locksDir, 0o700);

  const key = createHash("sha256").update(repoPath).digest("hex");
  const databasePath = join(locksDir, `repo-${key}.sqlite`);
  const database = new Database(databasePath, {
    create: true,
    readwrite: true,
    safeIntegers: false,
    strict: true,
  });
  secureMode(databasePath, 0o600);

  const startedAt = Date.now();
  let acquired = false;
  try {
    while (!acquired) {
      options.signal?.throwIfAborted();
      const remaining = timeoutMs - (Date.now() - startedAt);
      if (remaining < 0) {
        throw new AgentQError(
          `Timed out waiting for Git lock for ${repoPath}`,
          "REPO_LOCK_TIMEOUT",
        );
      }
      database.run(
        `PRAGMA busy_timeout = ${Math.max(1, Math.min(MAX_BUSY_SLICE_MS, remaining || 1))}`,
      );
      try {
        database.run("BEGIN IMMEDIATE");
        acquired = true;
      } catch (error) {
        if (!sqliteBusy(error)) throw error;
        if (Date.now() - startedAt >= timeoutMs) {
          throw new AgentQError(
            `Timed out waiting for Git lock for ${repoPath}`,
            "REPO_LOCK_TIMEOUT",
          );
        }
        await Bun.sleep(10);
      }
    }

    try {
      const result = await operation();
      database.run("COMMIT");
      acquired = false;
      return result;
    } catch (error) {
      try {
        database.run("ROLLBACK");
      } catch {
        // Preserve the operation error; closing the connection releases the lock.
      }
      acquired = false;
      throw error;
    }
  } finally {
    if (acquired) {
      try {
        database.run("ROLLBACK");
      } catch {
        // Closing the connection is the final crash-safe release mechanism.
      }
    }
    database.close();
    secureMode(databasePath, 0o600);
    secureMode(`${databasePath}-journal`, 0o600);
  }
}
