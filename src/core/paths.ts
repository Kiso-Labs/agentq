import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentQPaths } from "./types.ts";

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): AgentQPaths {
  const stateDir = resolve(
    env.AGENTQ_STATE_DIR ??
      (env.XDG_STATE_HOME
        ? join(env.XDG_STATE_HOME, "agentq")
        : join(homedir(), ".local", "state", "agentq")),
  );

  return {
    stateDir,
    databasePath: join(stateDir, "agentq.sqlite"),
    logsDir: join(stateDir, "logs"),
    worktreesDir: join(stateDir, "worktrees"),
    locksDir: join(stateDir, "locks"),
  };
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function makeId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
}
