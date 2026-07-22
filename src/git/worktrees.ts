import { createHash } from "node:crypto";
import { access, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { AgentQError } from "../core/errors.ts";
import type { AgentQPaths, Queue, Task } from "../core/types.ts";
import { runCommand, runGit } from "./command.ts";
import { withRepoLock } from "./repo-lock.ts";

export interface PreparedWorktree {
  repoRoot: string;
  baseSha: string;
  branchName: string;
  worktreePath: string;
}

export interface VerificationResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface LockedRepository {
  repoRoot: string;
  removeWorktree(worktreePath: string, force?: boolean): Promise<void>;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function canonicalMissingPath(path: string): Promise<string> {
  let ancestor = resolve(path);
  const missingSegments: string[] = [];
  while (true) {
    try {
      return resolve(await realpath(ancestor), ...missingSegments.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      missingSegments.push(basename(ancestor));
      ancestor = parent;
    }
  }
}

export class WorktreeManager {
  constructor(private readonly paths: AgentQPaths) {}

  async resolveRepo(path: string): Promise<string> {
    const candidate = resolve(path);
    const result = await runGit(candidate, ["rev-parse", "--show-toplevel"]);
    return result.stdout.trim();
  }

  private async resolveCommonDir(repoRoot: string, signal?: AbortSignal): Promise<string> {
    const result = await runGit(repoRoot, ["rev-parse", "--git-common-dir"], { signal });
    return realpath(resolve(repoRoot, result.stdout.trim()));
  }

  async prepare(
    queue: Queue,
    task: Task,
    attemptNo: number,
    signal?: AbortSignal,
  ): Promise<PreparedWorktree> {
    const repoRoot = await this.resolveRepo(queue.repoPath);
    const commonDir = await this.resolveCommonDir(repoRoot, signal);
    const baseResult = await runGit(
      repoRoot,
      ["rev-parse", "--verify", `${queue.baseRef}^{commit}`],
      {
        signal,
      },
    );
    const baseSha = baseResult.stdout.trim();
    if (!baseSha)
      throw new AgentQError(`Could not resolve base ref ${queue.baseRef}`, "INVALID_BASE_REF");

    const shortTask = task.id.replace(/^task_/, "").slice(0, 10);
    const queueSlug = slug(queue.name) || `queue-${queue.id.replace(/^queue_/, "").slice(0, 8)}`;
    const titleSlug = slug(task.title).slice(0, 20) || "task";
    const branchName = `agentq/${queueSlug}/${titleSlug}-${shortTask}-a${attemptNo}`;
    const validBranch = await runGit(repoRoot, ["check-ref-format", "--branch", branchName], {
      allowFailure: true,
    });
    if (validBranch.exitCode !== 0) {
      throw new AgentQError(`Generated invalid task branch: ${branchName}`, "INVALID_BRANCH");
    }
    const repoKey = createHash("sha256").update(commonDir).digest("hex").slice(0, 16);
    const worktreePath = join(
      this.paths.worktreesDir,
      `${slug(basename(repoRoot))}-${repoKey}`,
      task.id,
      `attempt-${attemptNo}`,
    );

    await mkdir(join(worktreePath, ".."), { recursive: true });

    await withRepoLock(
      this.paths.locksDir,
      commonDir,
      async () => {
        await runGit(repoRoot, ["worktree", "prune"]);
        if (await pathExists(join(worktreePath, ".git"))) {
          await this.validateExisting(repoRoot, worktreePath, branchName, signal);
          return;
        }

        const branch = await runGit(
          repoRoot,
          ["show-ref", "--verify", `refs/heads/${branchName}`],
          {
            allowFailure: true,
          },
        );
        if (branch.exitCode === 0) {
          await runGit(repoRoot, ["worktree", "add", worktreePath, branchName], { signal });
        } else {
          await runGit(repoRoot, ["worktree", "add", "-b", branchName, worktreePath, baseSha], {
            signal,
          });
        }
        await this.validateExisting(repoRoot, worktreePath, branchName, signal);
      },
      { signal },
    );

    return { repoRoot, baseSha, branchName, worktreePath };
  }

  async validateExisting(
    repoPath: string,
    worktreePath: string,
    branchName: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const [managedRoot, candidate, repoRoot] = await Promise.all([
      realpath(this.paths.worktreesDir),
      realpath(worktreePath),
      this.resolveRepo(repoPath).then((path) => realpath(path)),
    ]);
    if (!inside(managedRoot, candidate)) {
      throw new AgentQError(
        "Retained worktree is outside agentq's managed root",
        "INVALID_WORKTREE",
      );
    }

    const actualRoot = await this.resolveRepo(candidate).then((path) => realpath(path));
    if (actualRoot !== candidate) {
      throw new AgentQError(
        "Retained worktree resolves to an unexpected repository root",
        "INVALID_WORKTREE",
      );
    }

    const [repoCommon, worktreeCommon, branch, registered] = await Promise.all([
      runGit(repoRoot, ["rev-parse", "--git-common-dir"], { signal }),
      runGit(candidate, ["rev-parse", "--git-common-dir"], { signal }),
      runGit(candidate, ["symbolic-ref", "--quiet", "--short", "HEAD"], {
        allowFailure: true,
        signal,
      }),
      runGit(repoRoot, ["worktree", "list", "--porcelain"], { signal }),
    ]);
    const expectedCommon = resolve(repoRoot, repoCommon.stdout.trim());
    const actualCommon = resolve(candidate, worktreeCommon.stdout.trim());
    if (expectedCommon !== actualCommon || branch.stdout.trim() !== branchName) {
      throw new AgentQError(
        "Retained worktree repository or branch does not match its run",
        "INVALID_WORKTREE",
      );
    }
    const registeredPaths = registered.stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => resolve(line.slice("worktree ".length)));
    if (!registeredPaths.includes(candidate)) {
      throw new AgentQError("Retained worktree is not registered with Git", "INVALID_WORKTREE");
    }
  }

  async commitChanges(worktreePath: string, task: Task): Promise<string | undefined> {
    const status = await runGit(worktreePath, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    if (status.stdout.trim()) {
      await runGit(worktreePath, ["add", "--all"]);
      const commit = await runGit(
        worktreePath,
        [
          "-c",
          "user.name=agentq",
          "-c",
          "user.email=agentq@localhost",
          "commit",
          "-m",
          `agentq: ${task.title}`,
        ],
        { allowFailure: true },
      );
      if (commit.exitCode !== 0) {
        throw new AgentQError(
          `Could not commit task changes: ${commit.stderr.trim() || commit.stdout.trim()}`,
          "AUTO_COMMIT_FAILED",
        );
      }
    }

    const head = await runGit(worktreePath, ["rev-parse", "HEAD"]);
    return head.stdout.trim() || undefined;
  }

  async verify(
    worktreePath: string,
    commands: string[],
    signal?: AbortSignal,
  ): Promise<VerificationResult[]> {
    const results: VerificationResult[] = [];
    for (const command of commands) {
      const [shell, args] =
        process.platform === "win32"
          ? [process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command]]
          : ["/bin/sh", ["-lc", command]];
      const result = await runCommand(shell, args, {
        cwd: worktreePath,
        signal,
        env: { ...process.env, CI: "1", GIT_TERMINAL_PROMPT: "0" },
        maxOutputBytes: 8 * 1024 * 1024,
        killProcessTree: true,
      });
      results.push({ command, ...result });
      if (result.exitCode !== 0) break;
    }
    return results;
  }

  async withRepositoryLock<T>(
    repoPath: string,
    operation: (repository: LockedRepository) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const repoRoot = await this.resolveRepo(repoPath);
    const commonDir = await this.resolveCommonDir(repoRoot, signal);
    return withRepoLock(
      this.paths.locksDir,
      commonDir,
      () =>
        operation({
          repoRoot,
          removeWorktree: (worktreePath, force = false) =>
            this.removeFromResolvedRepository(repoRoot, worktreePath, force, signal),
        }),
      { signal },
    );
  }

  async remove(repoPath: string, worktreePath: string, force = false): Promise<void> {
    await this.withRepositoryLock(repoPath, ({ removeWorktree }) =>
      removeWorktree(worktreePath, force),
    );
  }

  private async removeFromResolvedRepository(
    repoRoot: string,
    worktreePath: string,
    force: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const managedRoot = await realpath(this.paths.worktreesDir);
    let candidate: string;
    try {
      candidate = await realpath(worktreePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      candidate = await canonicalMissingPath(worktreePath);
      if (!inside(managedRoot, candidate)) {
        throw new AgentQError(
          "Refusing to reconcile a worktree outside agentq's managed root",
          "INVALID_WORKTREE",
        );
      }
      await runGit(repoRoot, ["worktree", "prune"], { signal });
      return;
    }
    if (!inside(managedRoot, candidate)) {
      throw new AgentQError(
        "Refusing to remove a worktree outside agentq's managed root",
        "INVALID_WORKTREE",
      );
    }
    const args = ["worktree", "remove"];
    if (force) args.push("--force");
    args.push(candidate);
    await runGit(repoRoot, args, { signal });
    await runGit(repoRoot, ["worktree", "prune"], { signal });
  }
}
