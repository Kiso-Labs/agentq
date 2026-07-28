import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../src/git/command.ts";
import {
  advanceTrainRef,
  ensureImmutableResultRef,
  fastForwardLand,
  isAncestor,
  releaseReplayCandidate,
  replayResultCommit,
  resolveCommit,
  snapshotChangedFiles,
} from "../src/git/delivery.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "./support/test.ts";

const roots: string[] = [];

setDefaultTimeout(15_000);

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});

async function git(repoPath: string, ...args: string[]): Promise<string> {
  const result = await runCommand("git", ["-C", repoPath, ...args]);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args[0]} failed`);
  }
  return result.stdout.trim();
}

async function commitAll(repoPath: string, message: string): Promise<string> {
  await git(repoPath, "add", "--all");
  await git(
    repoPath,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    message,
  );
  return git(repoPath, "rev-parse", "HEAD");
}

async function fixture(): Promise<{ root: string; repo: string; initialSha: string }> {
  const root = await mkdtemp(join(tmpdir(), "agentq-delivery-"));
  roots.push(root);
  const repo = join(root, "repo");
  await runCommand("git", ["init", "-b", "main", repo]);
  await writeFile(join(repo, "README.md"), "initial\n");
  const initialSha = await commitAll(repo, "initial");
  return { root, repo, initialSha };
}

describe("Git delivery", () => {
  test("resolves commits and distinguishes ancestry from unrelated history", async () => {
    const { repo, initialSha } = await fixture();
    await writeFile(join(repo, "README.md"), "second\n");
    const secondSha = await commitAll(repo, "second");

    expect(await resolveCommit(repo, "main")).toBe(secondSha);
    expect(await isAncestor(repo, initialSha, secondSha)).toBe(true);
    expect(await isAncestor(repo, secondSha, initialSha)).toBe(false);
    await expect(resolveCommit(repo, "missing-ref")).rejects.toMatchObject({
      code: "COMMIT_NOT_FOUND",
    });
  });

  test("snapshots committed, staged, unstaged, deleted, renamed, and untracked paths", async () => {
    const { repo } = await fixture();
    await writeFile(join(repo, "delete-me.txt"), "remove\n");
    await writeFile(join(repo, "old-name.txt"), "rename\n");
    const baseSha = await commitAll(repo, "fixture files");
    await writeFile(join(repo, "committed.txt"), "committed after base\n");
    const headSha = await commitAll(repo, "committed delta");

    await writeFile(join(repo, "README.md"), "unstaged modification\n");
    await unlink(join(repo, "delete-me.txt"));
    await git(repo, "mv", "old-name.txt", "renamed file.txt");
    await writeFile(join(repo, "staged.txt"), "staged\n");
    await git(repo, "add", "staged.txt");
    await writeFile(join(repo, "untracked ü.txt"), "untracked\n");

    const snapshot = await snapshotChangedFiles(repo, baseSha);

    expect(snapshot.baseSha).toBe(baseSha);
    expect(snapshot.headSha).toBe(headSha);
    expect(snapshot.files).toEqual([
      { path: "README.md", kind: "modified", tracked: true },
      { path: "committed.txt", kind: "added", tracked: true },
      { path: "delete-me.txt", kind: "deleted", tracked: true },
      {
        path: "renamed file.txt",
        kind: "renamed",
        previousPath: "old-name.txt",
        score: 100,
        tracked: true,
      },
      { path: "staged.txt", kind: "added", tracked: true },
      { path: "untracked ü.txt", kind: "added", tracked: false },
    ]);
  });

  test("creates immutable result refs idempotently and rejects replacement", async () => {
    const { repo, initialSha } = await fixture();
    const refName = "refs/agentq/results/task_1/artifact_1";

    expect(await ensureImmutableResultRef(repo, refName, initialSha)).toEqual({
      refName,
      sha: initialSha,
      created: true,
    });
    expect(await ensureImmutableResultRef(repo, refName, initialSha)).toEqual({
      refName,
      sha: initialSha,
      created: false,
    });

    await writeFile(join(repo, "README.md"), "replacement\n");
    const replacementSha = await commitAll(repo, "replacement");
    await expect(ensureImmutableResultRef(repo, refName, replacementSha)).rejects.toMatchObject({
      code: "RESULT_REF_IMMUTABLE",
    });
    expect(await resolveCommit(repo, refName)).toBe(initialSha);
  });

  test("advances a train ref with compare-and-swap and rejects a stale writer", async () => {
    const { repo, initialSha } = await fixture();
    const trainRef = "refs/heads/agentq/train/main";
    await writeFile(join(repo, "README.md"), "candidate\n");
    const candidateSha = await commitAll(repo, "candidate");

    expect(await advanceTrainRef(repo, trainRef, initialSha, null)).toEqual({
      refName: trainRef,
      previousSha: undefined,
      sha: initialSha,
    });
    expect(await advanceTrainRef(repo, trainRef, candidateSha, initialSha)).toEqual({
      refName: trainRef,
      previousSha: initialSha,
      sha: candidateSha,
    });
    await expect(advanceTrainRef(repo, trainRef, initialSha, initialSha)).rejects.toMatchObject({
      code: "TRAIN_REF_CONFLICT",
    });
    await expect(advanceTrainRef(repo, trainRef, initialSha, candidateSha)).rejects.toMatchObject({
      code: "TRAIN_NOT_FAST_FORWARD",
    });
    expect(await resolveCommit(repo, trainRef)).toBe(candidateSha);
  });

  test("replays an immutable result onto a train without moving source or train refs", async () => {
    const { root, repo, initialSha } = await fixture();
    await git(repo, "checkout", "-b", "result", initialSha);
    await writeFile(join(repo, "feature.txt"), "feature\n");
    const resultSha = await commitAll(repo, "result");
    await git(repo, "checkout", "main");
    await writeFile(join(repo, "train.txt"), "train\n");
    const trainSha = await commitAll(repo, "train");
    const trainRef = "refs/heads/agentq/train/main";
    await advanceTrainRef(repo, trainRef, trainSha, null);
    const worktreesRoot = join(root, "delivery-worktrees");

    const replay = await replayResultCommit(repo, resultSha, trainSha, worktreesRoot);

    expect(replay.status).toBe("applied");
    if (replay.status !== "applied") throw new Error("Expected an applied replay");
    expect(replay.candidateRef).toStartWith("refs/agentq/candidates/");
    expect(await git(repo, "rev-parse", `${replay.candidateSha}^`)).toBe(trainSha);
    expect(await git(repo, "show", `${replay.candidateSha}:feature.txt`)).toBe("feature");
    expect(await git(repo, "show", `${replay.candidateSha}:train.txt`)).toBe("train");
    expect(await resolveCommit(repo, "refs/heads/result")).toBe(resultSha);
    expect(await resolveCommit(repo, trainRef)).toBe(trainSha);
    expect(await resolveCommit(repo, "main")).toBe(trainSha);
    expect(await readdir(worktreesRoot)).toEqual([]);

    expect(await releaseReplayCandidate(repo, replay.candidateRef, replay.candidateSha)).toBe(true);
    await expect(resolveCommit(repo, replay.candidateRef)).rejects.toMatchObject({
      code: "COMMIT_NOT_FOUND",
    });
  });

  test.skipIf(process.platform === "win32")(
    "does not execute repository checkout hooks while creating a replay worktree",
    async () => {
      const { root, repo, initialSha } = await fixture();
      await git(repo, "checkout", "-b", "result", initialSha);
      await writeFile(join(repo, "feature.txt"), "feature\n");
      const resultSha = await commitAll(repo, "result");
      await git(repo, "checkout", "main");
      const markerPath = join(root, "hook-ran.txt");
      const hookPath = join(repo, ".git", "hooks", "post-checkout");
      await writeFile(hookPath, `#!/bin/sh\nprintf 'ran' > "${markerPath}"\n`);
      await chmod(hookPath, 0o755);

      const replay = await replayResultCommit(
        repo,
        resultSha,
        initialSha,
        join(root, "delivery-worktrees"),
      );

      expect(replay.status).toBe("applied");
      expect(await Bun.file(markerPath).exists()).toBe(false);
      if (replay.status === "applied") {
        await releaseReplayCandidate(repo, replay.candidateRef, replay.candidateSha);
      }
    },
  );

  test("reports replay conflicts and cleans the disposable worktree without moving refs", async () => {
    const { root, repo, initialSha } = await fixture();
    await git(repo, "checkout", "-b", "result", initialSha);
    await writeFile(join(repo, "README.md"), "result\n");
    const resultSha = await commitAll(repo, "result");
    await git(repo, "checkout", "main");
    await writeFile(join(repo, "README.md"), "train\n");
    const trainSha = await commitAll(repo, "train");
    const worktreesRoot = join(root, "delivery-worktrees");

    const replay = await replayResultCommit(repo, resultSha, trainSha, worktreesRoot);

    expect(replay).toEqual({
      status: "conflict",
      resultSha,
      expectedTrainSha: trainSha,
      conflictPaths: ["README.md"],
    });
    expect(await resolveCommit(repo, "refs/heads/result")).toBe(resultSha);
    expect(await resolveCommit(repo, "main")).toBe(trainSha);
    expect(await readdir(worktreesRoot)).toEqual([]);
  });

  test("recognizes a result that is already present on the train", async () => {
    const { root, repo, initialSha } = await fixture();
    await git(repo, "checkout", "-b", "result", initialSha);
    await writeFile(join(repo, "same.txt"), "already present\n");
    const resultSha = await commitAll(repo, "result");
    await git(repo, "checkout", "main");
    await writeFile(join(repo, "same.txt"), "already present\n");
    const trainSha = await commitAll(repo, "independent equivalent change");
    const worktreesRoot = join(root, "delivery-worktrees");

    expect(await replayResultCommit(repo, resultSha, trainSha, worktreesRoot)).toEqual({
      status: "already-applied",
      resultSha,
      expectedTrainSha: trainSha,
      candidateSha: trainSha,
    });
    expect(await resolveCommit(repo, "main")).toBe(trainSha);
    expect(await readdir(worktreesRoot)).toEqual([]);
  });

  test("fast-forwards a clean checked-out target and updates its worktree", async () => {
    const { repo, initialSha } = await fixture();
    await git(repo, "checkout", "-b", "train");
    await writeFile(join(repo, "README.md"), "landed\n");
    const trainSha = await commitAll(repo, "train");
    await git(repo, "checkout", "main");

    expect(await fastForwardLand(repo, "refs/heads/main", trainSha, initialSha)).toEqual({
      targetRef: "refs/heads/main",
      previousSha: initialSha,
      sha: trainSha,
      checkedOutWorktree: await realpath(repo),
    });
    expect(await resolveCommit(repo, "main")).toBe(trainSha);
    expect(await readFile(join(repo, "README.md"), "utf8")).toBe("landed\n");
    expect(await git(repo, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
  });

  test.skipIf(process.platform === "win32")(
    "does not execute repository merge hooks while landing",
    async () => {
      const { repo, initialSha } = await fixture();
      await git(repo, "checkout", "-b", "train");
      await writeFile(join(repo, "README.md"), "landed\n");
      const trainSha = await commitAll(repo, "train");
      await git(repo, "checkout", "main");
      const hookPath = join(repo, ".git", "hooks", "post-merge");
      await writeFile(hookPath, "#!/bin/sh\nprintf 'ran' > hook-ran.txt\n");
      await chmod(hookPath, 0o755);

      await fastForwardLand(repo, "refs/heads/main", trainSha, initialSha);

      expect(await Bun.file(join(repo, "hook-ran.txt")).exists()).toBe(false);
      expect(await resolveCommit(repo, "main")).toBe(trainSha);
    },
  );

  test("refuses to land over a dirty checked-out target", async () => {
    const { repo, initialSha } = await fixture();
    await git(repo, "checkout", "-b", "train");
    await writeFile(join(repo, "README.md"), "train\n");
    const trainSha = await commitAll(repo, "train");
    await git(repo, "checkout", "main");
    await writeFile(join(repo, "local.txt"), "do not overwrite\n");

    await expect(
      fastForwardLand(repo, "refs/heads/main", trainSha, initialSha),
    ).rejects.toMatchObject({ code: "LAND_TARGET_DIRTY" });
    expect(await resolveCommit(repo, "main")).toBe(initialSha);
    expect(await readFile(join(repo, "local.txt"), "utf8")).toBe("do not overwrite\n");
  });

  test("lands an unchecked target with a compare-and-swap ref update", async () => {
    const { repo, initialSha } = await fixture();
    await git(repo, "branch", "release", initialSha);
    await writeFile(join(repo, "README.md"), "train\n");
    const trainSha = await commitAll(repo, "train");

    expect(await fastForwardLand(repo, "refs/heads/release", trainSha, initialSha)).toEqual({
      targetRef: "refs/heads/release",
      previousSha: initialSha,
      sha: trainSha,
    });
    expect(await resolveCommit(repo, "refs/heads/release")).toBe(trainSha);
    await expect(
      fastForwardLand(repo, "refs/heads/release", initialSha, initialSha),
    ).rejects.toMatchObject({ code: "LAND_REF_CONFLICT" });
  });
});
