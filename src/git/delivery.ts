import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentQError } from "../core/errors.ts";
import { type CommandResult, runGit } from "./command.ts";

export interface GitDeliveryOptions {
  signal?: AbortSignal;
}

export type ChangedFileKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "type-changed"
  | "unmerged"
  | "unknown";

export interface ChangedFile {
  path: string;
  kind: ChangedFileKind;
  tracked: boolean;
  previousPath?: string;
  score?: number;
}

export interface ChangedFileSnapshot {
  baseSha: string;
  headSha: string;
  files: ChangedFile[];
}

export interface RefUpdateResult {
  refName: string;
  previousSha?: string;
  sha: string;
}

export interface ImmutableRefResult {
  refName: string;
  sha: string;
  created: boolean;
}

export interface ReplayApplied {
  status: "applied";
  resultSha: string;
  expectedTrainSha: string;
  candidateSha: string;
  candidateRef: string;
}

export interface ReplayAlreadyApplied {
  status: "already-applied";
  resultSha: string;
  expectedTrainSha: string;
  candidateSha: string;
}

export interface ReplayConflict {
  status: "conflict";
  resultSha: string;
  expectedTrainSha: string;
  conflictPaths: string[];
}

export type ReplayOutcome = ReplayApplied | ReplayAlreadyApplied | ReplayConflict;

export interface LandingResult {
  targetRef: string;
  previousSha: string;
  sha: string;
  checkedOutWorktree?: string;
}

function commitish(ref: string): string {
  const value = ref.trim();
  if (!value) throw new AgentQError("Git commit reference is required", "INVALID_COMMIT_REF", 2);
  return `${value}^{commit}`;
}

export async function resolveCommit(
  repoPath: string,
  ref: string,
  options: GitDeliveryOptions = {},
): Promise<string> {
  const result = await runGit(
    repoPath,
    ["rev-parse", "--verify", "--end-of-options", commitish(ref)],
    {
      allowFailure: true,
      signal: options.signal,
      maxOutputBytes: 64 * 1024,
    },
  );
  const sha = result.stdout.trim();
  if (result.exitCode !== 0 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(sha)) {
    throw new AgentQError(`Could not resolve Git commit ${ref}`, "COMMIT_NOT_FOUND");
  }
  return sha;
}

export async function isAncestor(
  repoPath: string,
  ancestorRef: string,
  descendantRef: string,
  options: GitDeliveryOptions = {},
): Promise<boolean> {
  const [ancestorSha, descendantSha] = await Promise.all([
    resolveCommit(repoPath, ancestorRef, options),
    resolveCommit(repoPath, descendantRef, options),
  ]);
  const result = await runGit(
    repoPath,
    ["merge-base", "--is-ancestor", ancestorSha, descendantSha],
    {
      allowFailure: true,
      signal: options.signal,
      maxOutputBytes: 64 * 1024,
    },
  );
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw new AgentQError(
    `Could not compare Git ancestry: ${result.stderr.trim() || result.stdout.trim()}`,
    "GIT_ANCESTRY_FAILED",
  );
}

function statusKind(status: string): ChangedFileKind {
  switch (status[0]) {
    case "A":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "type-changed";
    case "U":
      return "unmerged";
    default:
      return "unknown";
  }
}

function parseNameStatus(output: string): ChangedFile[] {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const files: ChangedFile[] = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++];
    if (!status) {
      throw new AgentQError("Git returned an empty change status", "INVALID_GIT_OUTPUT");
    }
    const kind = statusKind(status);
    if (kind === "renamed" || kind === "copied") {
      const previousPath = fields[index++];
      const path = fields[index++];
      if (previousPath === undefined || path === undefined) {
        throw new AgentQError("Git returned an incomplete rename record", "INVALID_GIT_OUTPUT");
      }
      const parsedScore = Number(status.slice(1));
      files.push({
        path,
        kind,
        previousPath,
        ...(Number.isInteger(parsedScore) ? { score: parsedScore } : {}),
        tracked: true,
      });
      continue;
    }
    const path = fields[index++];
    if (path === undefined) {
      throw new AgentQError("Git returned an incomplete change record", "INVALID_GIT_OUTPUT");
    }
    files.push({ path, kind, tracked: true });
  }
  return files;
}

function pathOrder(left: ChangedFile, right: ChangedFile): number {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  return 0;
}

export async function snapshotChangedFiles(
  repoPath: string,
  baseRef: string,
  options: GitDeliveryOptions = {},
): Promise<ChangedFileSnapshot> {
  const baseSha = await resolveCommit(repoPath, baseRef, options);
  const headSha = await resolveCommit(repoPath, "HEAD", options);
  const [trackedResult, untrackedResult] = await Promise.all([
    runGit(repoPath, ["diff", "--name-status", "-z", "--find-renames", baseSha, "--"], {
      signal: options.signal,
      maxOutputBytes: 8 * 1024 * 1024,
    }),
    runGit(repoPath, ["ls-files", "--others", "--exclude-standard", "-z", "--"], {
      signal: options.signal,
      maxOutputBytes: 8 * 1024 * 1024,
    }),
  ]);
  const byPath = new Map<string, ChangedFile>();
  for (const file of parseNameStatus(trackedResult.stdout)) byPath.set(file.path, file);
  for (const path of untrackedResult.stdout.split("\0")) {
    if (path && !byPath.has(path)) byPath.set(path, { path, kind: "added", tracked: false });
  }
  return { baseSha, headSha, files: [...byPath.values()].sort(pathOrder) };
}

async function validateRefName(
  repoPath: string,
  refName: string,
  namespace: string,
  options: GitDeliveryOptions,
): Promise<void> {
  if (!refName.startsWith(namespace)) {
    throw new AgentQError(`Git ref must be under ${namespace}`, "INVALID_DELIVERY_REF", 2);
  }
  const result = await runGit(repoPath, ["check-ref-format", refName], {
    allowFailure: true,
    signal: options.signal,
    maxOutputBytes: 64 * 1024,
  });
  if (result.exitCode !== 0) {
    throw new AgentQError(`Invalid Git ref ${refName}`, "INVALID_DELIVERY_REF", 2);
  }
}

async function readRefCommit(
  repoPath: string,
  refName: string,
  options: GitDeliveryOptions,
): Promise<string | undefined> {
  const result = await runGit(
    repoPath,
    ["rev-parse", "--verify", "--end-of-options", `${refName}^{commit}`],
    {
      allowFailure: true,
      signal: options.signal,
      maxOutputBytes: 64 * 1024,
    },
  );
  const sha = result.stdout.trim();
  return result.exitCode === 0 && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(sha) ? sha : undefined;
}

export async function ensureImmutableResultRef(
  repoPath: string,
  refName: string,
  commitRef: string,
  options: GitDeliveryOptions = {},
): Promise<ImmutableRefResult> {
  await validateRefName(repoPath, refName, "refs/agentq/results/", options);
  const sha = await resolveCommit(repoPath, commitRef, options);
  const current = await readRefCommit(repoPath, refName, options);
  if (current === sha) return { refName, sha, created: false };
  if (current !== undefined) {
    throw new AgentQError(
      `Result ref ${refName} already points to ${current}`,
      "RESULT_REF_IMMUTABLE",
    );
  }

  const update = await runGit(repoPath, ["update-ref", refName, sha, ""], {
    allowFailure: true,
    signal: options.signal,
    maxOutputBytes: 64 * 1024,
  });
  if (update.exitCode === 0) return { refName, sha, created: true };

  const raced = await readRefCommit(repoPath, refName, options);
  if (raced === sha) return { refName, sha, created: false };
  throw new AgentQError(
    raced
      ? `Result ref ${refName} already points to ${raced}`
      : `Could not create result ref ${refName}: ${update.stderr.trim() || update.stdout.trim()}`,
    "RESULT_REF_IMMUTABLE",
  );
}

export async function advanceTrainRef(
  repoPath: string,
  refName: string,
  newCommitRef: string,
  expectedOldRef: string | null,
  options: GitDeliveryOptions = {},
): Promise<RefUpdateResult> {
  await validateRefName(repoPath, refName, "refs/heads/agentq/train/", options);
  const [sha, expectedSha] = await Promise.all([
    resolveCommit(repoPath, newCommitRef, options),
    expectedOldRef === null
      ? Promise.resolve(undefined)
      : resolveCommit(repoPath, expectedOldRef, options),
  ]);
  const current = await readRefCommit(repoPath, refName, options);
  if (current !== expectedSha) {
    throw new AgentQError(
      `Train ref ${refName} changed from ${expectedSha ?? "<missing>"} to ${current ?? "<missing>"}`,
      "TRAIN_REF_CONFLICT",
    );
  }
  if (expectedSha !== undefined && !(await isAncestor(repoPath, expectedSha, sha, options))) {
    throw new AgentQError(
      `Train ref ${refName} cannot move backward or diverge`,
      "TRAIN_NOT_FAST_FORWARD",
    );
  }

  const update = await runGit(repoPath, ["update-ref", refName, sha, expectedSha ?? ""], {
    allowFailure: true,
    signal: options.signal,
    maxOutputBytes: 64 * 1024,
  });
  if (update.exitCode !== 0) {
    const actual = await readRefCommit(repoPath, refName, options);
    throw new AgentQError(
      `Train ref ${refName} changed from ${expectedSha ?? "<missing>"} to ${actual ?? "<missing>"}`,
      "TRAIN_REF_CONFLICT",
    );
  }
  return { refName, previousSha: expectedSha, sha };
}

async function createCandidateRef(
  repoPath: string,
  candidateSha: string,
  options: GitDeliveryOptions,
): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidateRef = `refs/agentq/candidates/${randomUUID()}`;
    const update = await runGit(repoPath, ["update-ref", candidateRef, candidateSha, ""], {
      allowFailure: true,
      signal: options.signal,
      maxOutputBytes: 64 * 1024,
    });
    if (update.exitCode === 0) return candidateRef;
  }
  throw new AgentQError("Could not reserve a replay candidate ref", "CANDIDATE_REF_CONFLICT");
}

async function cleanupReplayWorktree(repoPath: string, worktreePath: string): Promise<void> {
  await runGit(repoPath, ["worktree", "remove", "--force", worktreePath], {
    allowFailure: true,
    maxOutputBytes: 64 * 1024,
  });
  await rm(worktreePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await runGit(repoPath, ["worktree", "prune"], {
    allowFailure: true,
    maxOutputBytes: 64 * 1024,
  });
}

async function withoutGitHooks<T>(operation: (gitConfigArgs: string[]) => Promise<T>): Promise<T> {
  const emptyHooksPath = await mkdtemp(join(tmpdir(), "agentq-hooks-"));
  try {
    return await operation(["-c", `core.hooksPath=${emptyHooksPath}`]);
  } finally {
    await rm(emptyHooksPath, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}

function nulPaths(output: string): string[] {
  return output
    .split("\0")
    .filter(Boolean)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

export async function replayResultCommit(
  repoPath: string,
  resultRef: string,
  expectedTrainRef: string,
  worktreesRoot: string,
  options: GitDeliveryOptions = {},
): Promise<ReplayOutcome> {
  const [resultSha, expectedTrainSha] = await Promise.all([
    resolveCommit(repoPath, resultRef, options),
    resolveCommit(repoPath, expectedTrainRef, options),
  ]);
  const parents = await runGit(repoPath, ["rev-list", "--parents", "-n", "1", resultSha], {
    signal: options.signal,
    maxOutputBytes: 64 * 1024,
  });
  if (parents.stdout.trim().split(/\s+/u).length !== 2) {
    throw new AgentQError(
      `Result commit ${resultSha} must have exactly one parent`,
      "RESULT_COMMIT_NOT_LINEAR",
    );
  }

  await mkdir(worktreesRoot, { recursive: true, mode: 0o700 });
  const worktreePath = await mkdtemp(join(worktreesRoot, "replay-"));
  await rm(worktreePath, { recursive: true, force: true });
  try {
    await withoutGitHooks((gitConfigArgs) =>
      runGit(
        repoPath,
        [...gitConfigArgs, "worktree", "add", "--detach", worktreePath, expectedTrainSha],
        {
          signal: options.signal,
          maxOutputBytes: 1024 * 1024,
        },
      ),
    );
    const replay = await runGit(worktreePath, ["cherry-pick", "--no-commit", resultSha], {
      allowFailure: true,
      signal: options.signal,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      maxOutputBytes: 8 * 1024 * 1024,
    });
    if (replay.exitCode !== 0) {
      const conflicts = await runGit(
        worktreePath,
        ["diff", "--name-only", "-z", "--diff-filter=U", "--"],
        {
          allowFailure: true,
          maxOutputBytes: 8 * 1024 * 1024,
        },
      );
      const conflictPaths = nulPaths(conflicts.stdout);
      await runGit(worktreePath, ["cherry-pick", "--abort"], {
        allowFailure: true,
        maxOutputBytes: 64 * 1024,
      });
      if (conflictPaths.length > 0) {
        return { status: "conflict", resultSha, expectedTrainSha, conflictPaths };
      }
      throw new AgentQError(
        `Could not replay result ${resultSha}: ${replay.stderr.trim() || replay.stdout.trim()}`,
        "RESULT_REPLAY_FAILED",
      );
    }

    const staged = await runGit(
      worktreePath,
      ["diff", "--cached", "--quiet", "--exit-code", "--"],
      {
        allowFailure: true,
        signal: options.signal,
        maxOutputBytes: 64 * 1024,
      },
    );
    if (staged.exitCode === 0) {
      return {
        status: "already-applied",
        resultSha,
        expectedTrainSha,
        candidateSha: expectedTrainSha,
      };
    }
    if (staged.exitCode !== 1) {
      throw new AgentQError("Could not inspect replayed changes", "RESULT_REPLAY_FAILED");
    }

    const tree = (
      await runGit(worktreePath, ["write-tree"], {
        signal: options.signal,
        maxOutputBytes: 64 * 1024,
      })
    ).stdout.trim();
    const candidateSha = (
      await runGit(
        worktreePath,
        [
          "commit-tree",
          tree,
          "-p",
          expectedTrainSha,
          "-m",
          `agentq: integrate ${resultSha.slice(0, 12)}`,
        ],
        {
          signal: options.signal,
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "agentq",
            GIT_AUTHOR_EMAIL: "agentq@localhost",
            GIT_COMMITTER_NAME: "agentq",
            GIT_COMMITTER_EMAIL: "agentq@localhost",
          },
          maxOutputBytes: 64 * 1024,
        },
      )
    ).stdout.trim();
    const candidateRef = await createCandidateRef(repoPath, candidateSha, options);
    return { status: "applied", resultSha, expectedTrainSha, candidateSha, candidateRef };
  } finally {
    await cleanupReplayWorktree(repoPath, worktreePath);
  }
}

export async function releaseReplayCandidate(
  repoPath: string,
  candidateRef: string,
  expectedCommitRef: string,
  options: GitDeliveryOptions = {},
): Promise<boolean> {
  await validateRefName(repoPath, candidateRef, "refs/agentq/candidates/", options);
  const current = await readRefCommit(repoPath, candidateRef, options);
  if (current === undefined) return false;
  const expectedSha = await resolveCommit(repoPath, expectedCommitRef, options);
  if (current !== expectedSha) {
    throw new AgentQError(
      `Replay candidate ${candidateRef} changed from ${expectedSha} to ${current}`,
      "CANDIDATE_REF_CONFLICT",
    );
  }
  const removed = await runGit(repoPath, ["update-ref", "-d", candidateRef, expectedSha], {
    allowFailure: true,
    signal: options.signal,
    maxOutputBytes: 64 * 1024,
  });
  if (removed.exitCode !== 0) {
    throw new AgentQError(
      `Replay candidate ${candidateRef} changed before cleanup`,
      "CANDIDATE_REF_CONFLICT",
    );
  }
  return true;
}

interface WorktreeRecord {
  path: string;
  branch?: string;
}

function parseWorktreeList(output: string): WorktreeRecord[] {
  const records: WorktreeRecord[] = [];
  let current: WorktreeRecord | undefined;
  for (const field of output.split("\0")) {
    if (field.startsWith("worktree ")) {
      if (current) records.push(current);
      current = { path: field.slice("worktree ".length) };
    } else if (field.startsWith("branch ") && current) {
      current.branch = field.slice("branch ".length);
    }
  }
  if (current) records.push(current);
  return records;
}

export async function fastForwardLand(
  repoPath: string,
  targetRef: string,
  trainCommitRef: string,
  expectedTargetRef: string,
  options: GitDeliveryOptions = {},
): Promise<LandingResult> {
  await validateRefName(repoPath, targetRef, "refs/heads/", options);
  const [trainSha, expectedTargetSha] = await Promise.all([
    resolveCommit(repoPath, trainCommitRef, options),
    resolveCommit(repoPath, expectedTargetRef, options),
  ]);
  const currentTargetSha = await readRefCommit(repoPath, targetRef, options);
  if (currentTargetSha !== expectedTargetSha) {
    throw new AgentQError(
      `Landing target ${targetRef} changed from ${expectedTargetSha} to ${currentTargetSha ?? "<missing>"}`,
      "LAND_REF_CONFLICT",
    );
  }
  if (!(await isAncestor(repoPath, expectedTargetSha, trainSha, options))) {
    throw new AgentQError(
      `Landing ${targetRef} at ${trainSha} would not be a fast-forward`,
      "LAND_NOT_FAST_FORWARD",
    );
  }

  const worktreeList = await runGit(repoPath, ["worktree", "list", "--porcelain", "-z"], {
    signal: options.signal,
    maxOutputBytes: 8 * 1024 * 1024,
  });
  const checkedOut = parseWorktreeList(worktreeList.stdout).filter(
    (worktree) => worktree.branch === targetRef,
  );
  if (checkedOut.length > 1) {
    throw new AgentQError(
      `Landing target ${targetRef} is checked out in multiple worktrees`,
      "LAND_TARGET_AMBIGUOUS",
    );
  }

  const targetWorktree = checkedOut[0];
  if (targetWorktree) {
    const headSha = await resolveCommit(targetWorktree.path, "HEAD", options);
    if (headSha !== expectedTargetSha) {
      throw new AgentQError(
        `Checked-out landing target ${targetRef} moved from ${expectedTargetSha} to ${headSha}`,
        "LAND_REF_CONFLICT",
      );
    }
    const status = await runGit(
      targetWorktree.path,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      {
        signal: options.signal,
        maxOutputBytes: 8 * 1024 * 1024,
      },
    );
    if (status.stdout.length > 0) {
      throw new AgentQError(
        `Landing target ${targetRef} has uncommitted changes in ${targetWorktree.path}`,
        "LAND_TARGET_DIRTY",
      );
    }
    const merge: CommandResult = await withoutGitHooks((gitConfigArgs) =>
      runGit(targetWorktree.path, [...gitConfigArgs, "merge", "--ff-only", "--no-edit", trainSha], {
        allowFailure: true,
        signal: options.signal,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        maxOutputBytes: 8 * 1024 * 1024,
      }),
    );
    if (merge.exitCode !== 0) {
      throw new AgentQError(
        `Could not fast-forward ${targetRef}: ${merge.stderr.trim() || merge.stdout.trim()}`,
        "LAND_REF_CONFLICT",
      );
    }
    const [landedSha, landedStatus] = await Promise.all([
      resolveCommit(repoPath, targetRef, options),
      runGit(targetWorktree.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
        signal: options.signal,
        maxOutputBytes: 8 * 1024 * 1024,
      }),
    ]);
    if (landedSha !== trainSha || landedStatus.stdout.length > 0) {
      throw new AgentQError(
        `Landing target ${targetRef} did not finish at the verified train commit`,
        "LAND_POSTCONDITION_FAILED",
      );
    }
    return {
      targetRef,
      previousSha: expectedTargetSha,
      sha: trainSha,
      checkedOutWorktree: targetWorktree.path,
    };
  }

  const update = await runGit(repoPath, ["update-ref", targetRef, trainSha, expectedTargetSha], {
    allowFailure: true,
    signal: options.signal,
    maxOutputBytes: 64 * 1024,
  });
  if (update.exitCode !== 0) {
    throw new AgentQError(
      `Landing target ${targetRef} changed before the fast-forward completed`,
      "LAND_REF_CONFLICT",
    );
  }
  return { targetRef, previousSha: expectedTargetSha, sha: trainSha };
}
