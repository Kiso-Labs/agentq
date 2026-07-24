import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentQPaths, Queue, Task } from "../src/core/types.ts";
import { runCommand } from "../src/git/command.ts";
import { withRepoLock } from "../src/git/repo-lock.ts";
import { WorktreeManager } from "../src/git/worktrees.ts";

const roots: string[] = [];

// Git worktree setup is noticeably slower on Windows CI. Keep the timeout local
// to this integration-test file so a healthy Git process is not killed midway.
setDefaultTimeout(15_000);

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agentq-worktree-"));
  roots.push(root);
  const repo = join(root, "repo");
  await Bun.$`mkdir -p ${repo}`.quiet();
  await runCommand("git", ["init", "-b", "main", repo]);
  await writeFile(join(repo, "README.md"), "hello\n");
  await runCommand("git", ["-C", repo, "add", "README.md"]);
  await runCommand("git", [
    "-C",
    repo,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "init",
  ]);
  const state = join(root, "state");
  const paths: AgentQPaths = {
    stateDir: state,
    databasePath: join(state, "db.sqlite"),
    logsDir: join(state, "logs"),
    worktreesDir: join(state, "worktrees"),
    locksDir: join(state, "locks"),
  };
  return { root, repo, paths };
}

function lockWorker(
  locksDir: string,
  repoPath: string,
  enteredPath: string,
  releasePath: string,
  staleMs: number,
) {
  return Bun.spawn({
    cmd: [
      Bun.which("bun") ?? "bun",
      join(import.meta.dir, "fixtures", "repo-lock-worker.ts"),
      locksDir,
      repoPath,
      enteredPath,
      releasePath,
      String(staleMs),
    ],
    cwd: join(import.meta.dir, ".."),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function waitForFile(path: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await Bun.file(path).exists())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await Bun.sleep(10);
  }
}

async function workerFailure(worker: ReturnType<typeof lockWorker>): Promise<string> {
  return `${await worker.stderr.text()}${await worker.stdout.text()}`;
}

describe("WorktreeManager", () => {
  test("creates an isolated branch and commits changes", async () => {
    const { repo, paths } = await fixture();
    const manager = new WorktreeManager(paths);
    const now = new Date().toISOString();
    const queue: Queue = {
      id: "queue_1",
      name: "Bugs",
      repoKey: repo,
      repoPath: repo,
      baseRef: "main",
      defaultProvider: "codex",
      planModel: "",
      planInstructions: "",
      implementModel: "",
      implementInstructions: "",
      concurrency: 2,
      maxAttempts: 2,
      verifyCommands: [],
      autoCommit: true,
      allowedPaths: [],
      deniedPaths: [],
      approvalCheckpoints: [],
      baseDriftPolicy: "replan",
      landStrategy: "none",
      autoLand: false,
      fileConcurrency: "off",
      createdAt: now,
      updatedAt: now,
    };
    const task: Task = {
      id: "task_1234567890",
      queueId: queue.id,
      title: "Update greeting",
      instructions: "change it",
      acceptanceCriteria: [],
      objective: "change it",
      invariants: [],
      handoffRequirements: [],
      blockedBy: [],
      expectedPaths: [],
      allowedPaths: [],
      deniedPaths: [],
      verifyCommands: [],
      approvalCheckpoints: [],
      baseDriftPolicy: "replan",
      landStrategy: "none",
      provider: "codex",
      priority: 0,
      status: "queued",
      currentPhase: "queued",
      deliveryStatus: "not_started",
      changedFiles: [],
      verificationResults: [],
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      sourceKind: "manual",
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    const prepared = await manager.prepare(queue, task, 1);
    expect(prepared.worktreePath).not.toBe(repo);
    expect(prepared.branchName).toContain("agentq/bugs/");
    await expect(
      manager.assertUnchanged(prepared.worktreePath, prepared.baseSha),
    ).resolves.toBeUndefined();
    await writeFile(join(prepared.worktreePath, "README.md"), "changed\n");
    await expect(
      manager.assertUnchanged(prepared.worktreePath, prepared.baseSha),
    ).rejects.toMatchObject({ code: "PLANNER_MODIFIED_WORKTREE" });
    const sha = await manager.commitChanges(prepared.worktreePath, task);
    expect(sha).toHaveLength(40);
    expect(await readFile(join(repo, "README.md"), "utf8")).toBe("hello\n");
  });

  test("uses one repository lock across linked worktree queue roots", async () => {
    const { root, repo, paths } = await fixture();
    const linked = join(root, "linked");
    await runCommand("git", ["-C", repo, "worktree", "add", "-b", "linked", linked, "main"]);
    const manager = new WorktreeManager(paths);
    const now = new Date().toISOString();
    const queue = (id: string, name: string, repoPath: string): Queue => ({
      id,
      name,
      repoKey: repoPath,
      repoPath,
      baseRef: "main",
      defaultProvider: "codex",
      planModel: "",
      planInstructions: "",
      implementModel: "",
      implementInstructions: "",
      concurrency: 2,
      maxAttempts: 2,
      verifyCommands: [],
      autoCommit: true,
      allowedPaths: [],
      deniedPaths: [],
      approvalCheckpoints: [],
      baseDriftPolicy: "replan",
      landStrategy: "none",
      autoLand: false,
      fileConcurrency: "off",
      createdAt: now,
      updatedAt: now,
    });
    const task = (id: string, queueId: string): Task => ({
      id,
      queueId,
      title: id,
      instructions: "",
      acceptanceCriteria: [],
      objective: id,
      invariants: [],
      handoffRequirements: [],
      blockedBy: [],
      expectedPaths: [],
      allowedPaths: [],
      deniedPaths: [],
      verifyCommands: [],
      approvalCheckpoints: [],
      baseDriftPolicy: "replan",
      landStrategy: "none",
      provider: "codex",
      priority: 0,
      status: "queued",
      currentPhase: "queued",
      deliveryStatus: "not_started",
      changedFiles: [],
      verificationResults: [],
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      sourceKind: "manual",
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    const mainQueue = queue("queue_main", "main", repo);
    const linkedQueue = queue("queue_linked", "linked", linked);

    await manager.prepare(mainQueue, task("task_main123456", mainQueue.id), 1);
    await manager.prepare(linkedQueue, task("task_linked1234", linkedQueue.id), 1);

    const lockDatabases = (await readdir(paths.locksDir)).filter((name) =>
      /^repo-[a-f0-9]{64}\.sqlite$/.test(name),
    );
    expect(lockDatabases).toHaveLength(1);
  });

  test("uses stable branch fallbacks for non-ASCII queue and task names", async () => {
    const { repo, paths } = await fixture();
    const manager = new WorktreeManager(paths);
    const now = new Date().toISOString();
    const queue: Queue = {
      id: "queue_abcdef123456",
      name: "修复",
      repoKey: repo,
      repoPath: repo,
      baseRef: "main",
      defaultProvider: "codex",
      planModel: "",
      planInstructions: "",
      implementModel: "",
      implementInstructions: "",
      concurrency: 1,
      maxAttempts: 1,
      verifyCommands: [],
      autoCommit: true,
      allowedPaths: [],
      deniedPaths: [],
      approvalCheckpoints: [],
      baseDriftPolicy: "replan",
      landStrategy: "none",
      autoLand: false,
      fileConcurrency: "off",
      createdAt: now,
      updatedAt: now,
    };
    const task: Task = {
      id: "task_abcdef123456",
      queueId: queue.id,
      title: "修复登录",
      instructions: "",
      acceptanceCriteria: [],
      objective: "修复登录",
      invariants: [],
      handoffRequirements: [],
      blockedBy: [],
      expectedPaths: [],
      allowedPaths: [],
      deniedPaths: [],
      verifyCommands: [],
      approvalCheckpoints: [],
      baseDriftPolicy: "replan",
      landStrategy: "none",
      provider: "codex",
      priority: 0,
      status: "queued",
      currentPhase: "queued",
      deliveryStatus: "not_started",
      changedFiles: [],
      verificationResults: [],
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      sourceKind: "manual",
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    const prepared = await manager.prepare(queue, task, 1);
    expect(prepared.branchName).toBe("agentq/queue-abcdef12/task-abcdef1234-a1");
  });

  test("rejects a retained worktree whose branch identity changed", async () => {
    const { repo, paths } = await fixture();
    const manager = new WorktreeManager(paths);
    const now = new Date().toISOString();
    const queue: Queue = {
      id: "queue_identity",
      name: "identity",
      repoKey: repo,
      repoPath: repo,
      baseRef: "main",
      defaultProvider: "codex",
      planModel: "",
      planInstructions: "",
      implementModel: "",
      implementInstructions: "",
      concurrency: 1,
      maxAttempts: 1,
      verifyCommands: [],
      autoCommit: true,
      allowedPaths: [],
      deniedPaths: [],
      approvalCheckpoints: [],
      baseDriftPolicy: "replan",
      landStrategy: "none",
      autoLand: false,
      fileConcurrency: "off",
      createdAt: now,
      updatedAt: now,
    };
    const task: Task = {
      id: "task_identity1234",
      queueId: queue.id,
      title: "Identity",
      instructions: "",
      acceptanceCriteria: [],
      objective: "Identity",
      invariants: [],
      handoffRequirements: [],
      blockedBy: [],
      expectedPaths: [],
      allowedPaths: [],
      deniedPaths: [],
      verifyCommands: [],
      approvalCheckpoints: [],
      baseDriftPolicy: "replan",
      landStrategy: "none",
      provider: "codex",
      priority: 0,
      status: "queued",
      currentPhase: "queued",
      deliveryStatus: "not_started",
      changedFiles: [],
      verificationResults: [],
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      sourceKind: "manual",
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    const prepared = await manager.prepare(queue, task, 1);
    await runCommand("git", ["-C", prepared.worktreePath, "checkout", "-b", "unexpected"]);

    await expect(
      manager.validateExisting(repo, prepared.worktreePath, prepared.branchName),
    ).rejects.toThrow("does not match");
  });

  test("does not age-expire a repository lock held by a live process", async () => {
    const { repo, paths } = await fixture();
    let firstExitedAt = 0;
    let secondEnteredAt = 0;
    const first = withRepoLock(
      paths.locksDir,
      repo,
      async () => {
        await Bun.sleep(175);
        firstExitedAt = Date.now();
      },
      { staleMs: 25 },
    );
    await Bun.sleep(50);
    const second = withRepoLock(
      paths.locksDir,
      repo,
      async () => {
        secondEnteredAt = Date.now();
      },
      { staleMs: 25 },
    );
    await Promise.all([first, second]);

    expect(secondEnteredAt).toBeGreaterThanOrEqual(firstExitedAt);
  });

  test("takes over the OS lock left by a terminated process", async () => {
    const { root, repo, paths } = await fixture();
    const enteredPath = join(root, "stale-holder-entered");
    const releasePath = join(root, "stale-holder-release");
    const staleMs = 160;
    const holder = lockWorker(paths.locksDir, repo, enteredPath, releasePath, staleMs);

    try {
      await waitForFile(enteredPath);
      holder.kill("SIGKILL");
      await holder.exited;

      const startedAt = Date.now();
      let acquiredAt = 0;
      await withRepoLock(
        paths.locksDir,
        repo,
        async () => {
          acquiredAt = Date.now();
        },
        { staleMs, timeoutMs: 2_000 },
      );

      expect(acquiredAt - startedAt).toBeLessThan(1_000);
    } finally {
      holder.kill("SIGKILL");
      await holder.exited;
    }
  });

  test("keeps two crash-recovery waiters strictly serialized", async () => {
    const { root, repo, paths } = await fixture();
    const staleMs = 160;
    const staleEntered = join(root, "stale-entered");
    const staleRelease = join(root, "stale-release");
    const staleHolder = lockWorker(paths.locksDir, repo, staleEntered, staleRelease, staleMs);
    const entered = [join(root, "waiter-a-entered"), join(root, "waiter-b-entered")] as const;
    const releases = [join(root, "waiter-a-release"), join(root, "waiter-b-release")] as const;
    let waiters: ReturnType<typeof lockWorker>[] = [];

    try {
      await waitForFile(staleEntered);
      staleHolder.kill("SIGKILL");
      await staleHolder.exited;

      waiters = [
        lockWorker(paths.locksDir, repo, entered[0], releases[0], staleMs),
        lockWorker(paths.locksDir, repo, entered[1], releases[1], staleMs),
      ];

      const deadline = Date.now() + 3_000;
      let winner = -1;
      while (winner === -1) {
        const states = await Promise.all(entered.map((path) => Bun.file(path).exists()));
        winner = states.findIndex(Boolean);
        if (Date.now() >= deadline) throw new Error("Neither lock waiter acquired the lease");
        if (winner === -1) await Bun.sleep(10);
      }
      const winnerIndex: 0 | 1 = winner === 0 ? 0 : 1;
      const loserIndex: 0 | 1 = winnerIndex === 0 ? 1 : 0;

      await Bun.sleep(staleMs * 2);
      expect(await Bun.file(entered[loserIndex]).exists()).toBe(false);

      await writeFile(releases[winnerIndex], "release\n", { mode: 0o600 });
      await waitForFile(entered[loserIndex]);
      await writeFile(releases[loserIndex], "release\n", { mode: 0o600 });

      const exitCodes = await Promise.all(waiters.map((worker) => worker.exited));
      if (exitCodes.some((code) => code !== 0)) {
        throw new Error(
          `Lock waiter failed: ${(
            await Promise.all(waiters.map((worker) => workerFailure(worker)))
          ).join("\n")}`,
        );
      }
    } finally {
      staleHolder.kill("SIGKILL");
      await staleHolder.exited;
      for (const waiter of waiters) waiter.kill("SIGKILL");
      await Promise.all(waiters.map((waiter) => waiter.exited));
    }
  });

  test("does not expire a holder even when its JavaScript event loop stalls", async () => {
    const { root, repo, paths } = await fixture();
    const staleMs = 120;
    const replacementEntered = join(root, "replacement-entered");
    const replacementRelease = join(root, "replacement-release");
    let replacement: ReturnType<typeof lockWorker> | undefined;

    try {
      let overlapped = false;
      await withRepoLock(
        paths.locksDir,
        repo,
        async () => {
          replacement = lockWorker(
            paths.locksDir,
            repo,
            replacementEntered,
            replacementRelease,
            staleMs,
          );

          const deadline = Date.now() + staleMs * 3;
          while (Date.now() < deadline) {
            // Deliberately block timers longer than the legacy TTL. The SQLite
            // transaction remains owned by this process at the OS level.
          }
          overlapped = existsSync(replacementEntered);
        },
        { staleMs, timeoutMs: 2_000 },
      );
      expect(overlapped).toBe(false);

      if (!replacement) throw new Error("Replacement worker was not created");
      await waitForFile(replacementEntered);
      await writeFile(replacementRelease, "release\n", { mode: 0o600 });
      const exitCode = await replacement.exited;
      if (exitCode !== 0)
        throw new Error(`Replacement failed: ${await workerFailure(replacement)}`);
    } finally {
      replacement?.kill("SIGKILL");
      if (replacement) await replacement.exited;
    }
  });

  test.skipIf(process.platform === "win32")(
    "stores repository leases with owner-only permissions",
    async () => {
      const { repo, paths } = await fixture();
      await mkdir(paths.locksDir, { recursive: true, mode: 0o777 });
      await chmod(paths.locksDir, 0o777);

      await withRepoLock(paths.locksDir, repo, async () => undefined);

      expect((await stat(paths.locksDir)).mode & 0o777).toBe(0o700);
      const databases = (await readdir(paths.locksDir)).filter((name) => name.endsWith(".sqlite"));
      expect(databases).toHaveLength(1);
      expect((await stat(join(paths.locksDir, databases[0] as string))).mode & 0o777).toBe(0o600);
    },
  );

  test.skipIf(process.platform === "win32")(
    "cancels verification command descendants",
    async () => {
      const { repo, paths } = await fixture();
      const manager = new WorktreeManager(paths);
      const script = join(repo, "verification-tree.ts");
      const pidFile = join(repo, "verification-child.pid");
      await writeFile(
        script,
        [
          'import { spawn } from "node:child_process";',
          'import { writeFileSync } from "node:fs";',
          'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
          `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      );
      await chmod(script, 0o755);
      const controller = new AbortController();
      const verification = manager.verify(
        repo,
        [`${process.execPath} ${script}`],
        controller.signal,
      );
      const deadline = Date.now() + 2_000;
      while (!(await Bun.file(pidFile).exists())) {
        if (Date.now() >= deadline) throw new Error("verification descendant did not start");
        await Bun.sleep(10);
      }
      const pid = Number(await readFile(pidFile, "utf8"));
      controller.abort(new Error("cancel verification"));

      await expect(verification).rejects.toThrow("cancel verification");
      expect(() => process.kill(pid, 0)).toThrow();
    },
  );
});
