import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentQApp } from "../src/app.ts";
import type { AgentQError } from "../src/core/errors.ts";
import type { AgentQPaths } from "../src/core/types.ts";
import { runCommand } from "../src/git/command.ts";
import { DelegatedTaskIntake } from "../src/intake/delegated-tasks.ts";
import { spawnProcess } from "../src/process/index.ts";
import { Supervisor } from "../src/supervisor/supervisor.ts";

const roots: string[] = [];
const originalCodex = process.env.AGENTQ_CODEX_BIN;
const originalClaude = process.env.AGENTQ_CLAUDE_BIN;
const originalBarrier = process.env.AGENTQ_TEST_BARRIER;
const originalTestCli = process.env.AGENTQ_TEST_CLI;
const originalMaxConcurrency = process.env.AGENTQ_MAX_CONCURRENCY;

afterEach(async () => {
  if (originalCodex === undefined) delete process.env.AGENTQ_CODEX_BIN;
  else process.env.AGENTQ_CODEX_BIN = originalCodex;
  if (originalClaude === undefined) delete process.env.AGENTQ_CLAUDE_BIN;
  else process.env.AGENTQ_CLAUDE_BIN = originalClaude;
  if (originalBarrier === undefined) delete process.env.AGENTQ_TEST_BARRIER;
  else process.env.AGENTQ_TEST_BARRIER = originalBarrier;
  if (originalTestCli === undefined) delete process.env.AGENTQ_TEST_CLI;
  else process.env.AGENTQ_TEST_CLI = originalTestCli;
  if (originalMaxConcurrency === undefined) delete process.env.AGENTQ_MAX_CONCURRENCY;
  else process.env.AGENTQ_MAX_CONCURRENCY = originalMaxConcurrency;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "agentq-supervisor-"));
  roots.push(root);
  const repo = join(root, "repo");
  await runCommand("mkdir", ["-p", repo]);
  await runCommand("git", ["init", "-b", "main", repo]);
  await writeFile(join(repo, "README.md"), "fixture\n");
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

  const stateDir = join(root, "state");
  const paths: AgentQPaths = {
    stateDir,
    databasePath: join(stateDir, "agentq.sqlite"),
    logsDir: join(stateDir, "logs"),
    worktreesDir: join(stateDir, "worktrees"),
    locksDir: join(stateDir, "locks"),
  };
  return { root, repo, paths, app: await AgentQApp.create(paths) };
}

async function executable(path: string, source: string): Promise<void> {
  await writeFile(path, `#!/usr/bin/env bun\n${source}`, "utf8");
  await chmod(path, 0o755);
}

describe.skipIf(process.platform === "win32")("Supervisor", () => {
  test("rejects invalid environment and option concurrency limits before claiming work", async () => {
    const { repo, app } = await setup();
    const queue = await app.createQueue({ name: "invalid-concurrency", repoPath: repo });
    const task = await app.addTask({ queue: queue.id, title: "Remain queued" });

    process.env.AGENTQ_MAX_CONCURRENCY = "not-a-number";
    await expect(new Supervisor(app).run({ once: true })).rejects.toMatchObject({
      code: "INVALID_SUPERVISOR_OPTIONS",
    } satisfies Partial<AgentQError>);

    for (const maxConcurrency of [0, 1.5, 129, Number.POSITIVE_INFINITY, Number.NaN]) {
      await expect(
        new Supervisor(app, { maxConcurrency }).run({ once: true }),
      ).rejects.toMatchObject({
        code: "INVALID_SUPERVISOR_OPTIONS",
      } satisfies Partial<AgentQError>);
    }
    expect(app.store.getTask(task.id)?.status).toBe("queued");
    expect(app.store.listRuns({ taskId: task.id })).toHaveLength(0);
    app.close();
  });

  test("runs Codex and Claude tasks concurrently in distinct worktrees", async () => {
    const { root, repo, app } = await setup();
    const barrier = join(root, "barrier");
    await runCommand("mkdir", ["-p", barrier]);
    const codex = join(root, "codex");
    const claude = join(root, "claude");
    const common = (provider: "codex" | "claude") => `
      import { readdir } from "node:fs/promises";
      import { join } from "node:path";
      const provider = ${JSON.stringify(provider)};
      await Bun.stdin.text();
      await Bun.write(join(process.cwd(), \`done-\${provider}.txt\`), provider);
      await Bun.write(join(process.env.AGENTQ_TEST_BARRIER!, provider), "ready");
      const deadline = Date.now() + 3000;
      while ((await readdir(process.env.AGENTQ_TEST_BARRIER!)).length < 2) {
        if (Date.now() > deadline) { console.error("parallel barrier timed out"); process.exit(7); }
        await Bun.sleep(20);
      }
    `;
    await executable(
      codex,
      `${common("codex")}
       console.log(JSON.stringify({type:"thread.started",thread_id:"codex-session"}));
       console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"Codex completed"}}));
       console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:10,output_tokens:4}}));`,
    );
    await executable(
      claude,
      `${common("claude")}
       console.log(JSON.stringify({type:"system",subtype:"init",session_id:"claude-session"}));
       console.log(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"Claude completed"}]}}));
       console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,session_id:"claude-session",result:"Claude completed",usage:{input_tokens:12,output_tokens:5}}));`,
    );

    process.env.AGENTQ_CODEX_BIN = codex;
    process.env.AGENTQ_CLAUDE_BIN = claude;
    process.env.AGENTQ_TEST_BARRIER = barrier;
    const queue = await app.createQueue({
      name: "app",
      repoPath: repo,
      concurrency: 2,
      maxAttempts: 1,
      verifyCommands: ["test -f done-codex.txt || test -f done-claude.txt"],
    });
    await app.addTask({ queue: queue.id, title: "Codex task", provider: "codex" });
    await app.addTask({ queue: queue.id, title: "Claude task", provider: "claude" });

    await new Supervisor(app, { maxConcurrency: 2, pollIntervalMs: 20 }).run({ once: true });

    const tasks = app.store.listTasks({ queue: queue.id });
    expect(tasks.map((item) => item.status)).toEqual(["succeeded", "succeeded"]);
    const runs = app.store.listRuns({ queue: queue.id });
    expect(new Set(runs.map((run) => run.worktreePath)).size).toBe(2);
    expect(runs.every((run) => run.branchName?.startsWith("agentq/app/"))).toBeTrue();
    expect(runs.every((run) => run.providerSessionId)).toBeTrue();
    expect(await Bun.file(join(repo, "done-codex.txt")).exists()).toBeFalse();
    app.close();
  });

  test("resumes the same Codex session in the retained worktree", async () => {
    const { root, repo, app } = await setup();
    const codex = join(root, "codex");
    await executable(
      codex,
      `
      const args = process.argv.slice(2);
      await Bun.stdin.text();
      const resumed = args.includes("resume");
      await Bun.write(resumed ? "resumed.txt" : "first.txt", resumed ? "yes" : "first");
      console.log(JSON.stringify({type:"thread.started",thread_id:"codex-session"}));
      console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:resumed?"Resumed":"First"}}));
      console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:1}}));
      `,
    );
    process.env.AGENTQ_CODEX_BIN = codex;
    const queue = await app.createQueue({ name: "resume", repoPath: repo, maxAttempts: 3 });
    const task = await app.addTask({ queue: queue.id, title: "Resumable", provider: "codex" });

    await new Supervisor(app, { pollIntervalMs: 20 }).run({ once: true });
    const firstRun = app.store.listRuns({ taskId: task.id })[0];
    expect(firstRun?.status).toBe("succeeded");
    await app.resumeTask(task.id);
    await new Supervisor(app, { pollIntervalMs: 20 }).run({ once: true });

    const [secondRun, originalRun] = app.store.listRuns({ taskId: task.id });
    expect(secondRun?.status).toBe("succeeded");
    expect(secondRun?.worktreePath).toBe(originalRun?.worktreePath);
    expect(await readFile(join(secondRun?.worktreePath ?? "", "resumed.txt"), "utf8")).toBe("yes");
    app.close();
  });

  test("observes cross-process cancellation and terminates the running agent", async () => {
    const { root, repo, app } = await setup();
    const codex = join(root, "codex");
    await executable(
      codex,
      `
      await Bun.stdin.text();
      console.log(JSON.stringify({type:"thread.started",thread_id:"cancel-session"}));
      await Bun.sleep(30_000);
      console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:1}}));
      `,
    );
    process.env.AGENTQ_CODEX_BIN = codex;
    const queue = await app.createQueue({ name: "cancel", repoPath: repo, maxAttempts: 1 });
    const task = await app.addTask({ queue: queue.id, title: "Cancel me", provider: "codex" });
    const supervisor = new Supervisor(app, { pollIntervalMs: 20 });
    const running = supervisor.run({ once: true });

    const deadline = Date.now() + 3_000;
    while (app.store.getTask(task.id)?.status !== "running") {
      if (Date.now() > deadline) throw new Error("task did not start");
      await Bun.sleep(20);
    }
    // This writes the cancellation request through SQLite, as a separate CLI
    // process would. The supervisor observes it on its next poll.
    await app.cancelTask(task.id);
    await running;

    expect(app.store.getTask(task.id)?.status).toBe("cancelled");
    expect(app.store.listRuns({ taskId: task.id })[0]?.status).toBe("cancelled");
    expect(
      app.store
        .listEvents({ taskId: task.id, limit: 100 })
        .some((event) => event.kind === "run.succeeded"),
    ).toBeFalse();
    app.close();
  });

  test("cancels a provider immediately when event persistence fails", async () => {
    const { root, repo, app } = await setup();
    const codex = join(root, "codex");
    const pidFile = join(root, "event-provider.pid");
    await executable(
      codex,
      `
      await Bun.stdin.text();
      await Bun.write(${JSON.stringify(pidFile)}, String(process.pid));
      console.log(JSON.stringify({type:"thread.started",thread_id:"event-failure-session"}));
      await Bun.sleep(30_000);
      `,
    );
    process.env.AGENTQ_CODEX_BIN = codex;
    const queue = await app.createQueue({ name: "event-failure", repoPath: repo, maxAttempts: 1 });
    const task = await app.addTask({
      queue: queue.id,
      title: "Fail persistence",
      provider: "codex",
    });
    const originalAppendEvent = app.store.appendEvent.bind(app.store);
    app.store.appendEvent = ((input) => {
      if (input.kind.startsWith("executor."))
        throw new Error("simulated event persistence failure");
      return originalAppendEvent(input);
    }) as typeof app.store.appendEvent;

    const startedAt = Date.now();
    await new Supervisor(app, { pollIntervalMs: 20 }).run({ once: true });
    app.store.appendEvent = originalAppendEvent;

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    const providerPid = Number(await readFile(pidFile, "utf8"));
    expect(() => process.kill(providerPid, 0)).toThrow();
    expect(app.store.getTask(task.id)?.status).toBe("failed");
    expect(app.store.listRuns({ taskId: task.id })[0]?.error).toContain(
      "simulated event persistence failure",
    );
    app.close();
  });

  test("fail-safe shutdown stops active providers when the supervisor loop crashes", async () => {
    const { root, repo, app } = await setup();
    const codex = join(root, "codex");
    const pidFile = join(root, "loop-provider.pid");
    await executable(
      codex,
      `
      await Bun.stdin.text();
      await Bun.write(${JSON.stringify(pidFile)}, String(process.pid));
      console.log(JSON.stringify({type:"thread.started",thread_id:"loop-failure-session"}));
      await Bun.sleep(30_000);
      `,
    );
    process.env.AGENTQ_CODEX_BIN = codex;
    const queue = await app.createQueue({ name: "loop-failure", repoPath: repo, maxAttempts: 1 });
    const task = await app.addTask({
      queue: queue.id,
      title: "Survive loop crash",
      provider: "codex",
    });
    const supervisor = new Supervisor(app, { pollIntervalMs: 20 });
    const privateSupervisor = supervisor as unknown as {
      intake: { drain(): Promise<void> };
    };
    const originalDrain = privateSupervisor.intake.drain.bind(privateSupervisor.intake);
    privateSupervisor.intake.drain = async () => {
      if (await Bun.file(pidFile).exists()) throw new Error("simulated supervisor loop failure");
      await originalDrain();
    };

    await expect(supervisor.run({ once: true })).rejects.toThrow(
      "simulated supervisor loop failure",
    );

    const providerPid = Number(await readFile(pidFile, "utf8"));
    expect(() => process.kill(providerPid, 0)).toThrow();
    expect(app.store.getTask(task.id)).toMatchObject({ status: "queued", attemptCount: 0 });
    expect(app.store.listRuns({ taskId: task.id })[0]?.status).toBe("interrupted");
    app.close();
  });

  test("graceful shutdown interrupts and requeues work without consuming retry budget", async () => {
    const { root, repo, app } = await setup();
    const codex = join(root, "codex");
    await executable(
      codex,
      `
      await Bun.stdin.text();
      console.log(JSON.stringify({type:"thread.started",thread_id:"shutdown-session"}));
      await Bun.sleep(30_000);
      `,
    );
    process.env.AGENTQ_CODEX_BIN = codex;
    const queue = await app.createQueue({ name: "shutdown", repoPath: repo, maxAttempts: 1 });
    const task = await app.addTask({ queue: queue.id, title: "Keep queued", provider: "codex" });
    const supervisor = new Supervisor(app, { pollIntervalMs: 20 });
    const running = supervisor.run({ once: true });

    const deadline = Date.now() + 3_000;
    while (app.store.getTask(task.id)?.status !== "running") {
      if (Date.now() > deadline) throw new Error("task did not start");
      await Bun.sleep(20);
    }
    supervisor.stop("test shutdown");
    await running;

    expect(app.store.getTask(task.id)).toMatchObject({ status: "queued", attemptCount: 0 });
    expect(app.store.listRuns({ taskId: task.id })[0]?.status).toBe("interrupted");
    app.close();
  });

  test("terminalizes a claim when log setup fails before provider startup", async () => {
    const { repo, paths, app } = await setup();
    await rm(paths.logsDir, { recursive: true, force: true });
    await writeFile(paths.logsDir, "not a directory");
    const queue = await app.createQueue({ name: "bad-logs", repoPath: repo, maxAttempts: 1 });
    const task = await app.addTask({ queue: queue.id, title: "Cannot log", provider: "codex" });

    await new Supervisor(app, { pollIntervalMs: 20 }).run({ once: true });

    expect(app.store.getTask(task.id)?.status).toBe("failed");
    expect(app.store.listRuns({ taskId: task.id })[0]?.status).toBe("failed");
    app.close();
  });

  test("periodically recovers a peer claim that becomes stale after startup", async () => {
    const { root, repo, app } = await setup();
    const codex = join(root, "codex");
    await executable(
      codex,
      `
      await Bun.stdin.text();
      console.log(JSON.stringify({type:"thread.started",thread_id:"recovered-session"}));
      console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:1}}));
      `,
    );
    process.env.AGENTQ_CODEX_BIN = codex;
    const supervisor = new Supervisor(app, {
      pollIntervalMs: 20,
      staleAfterMs: 50,
      heartbeatIntervalMs: 10,
    });
    const running = supervisor.run();
    await Bun.sleep(75);

    const queue = await app.createQueue({ name: "recovery", repoPath: repo, maxAttempts: 2 });
    const task = await app.addTask({ queue: queue.id, title: "Recover me", provider: "codex" });
    const stale = app.store.claimNextTask({
      queue: queue.id,
      now: "2000-01-01T00:00:00.000Z",
      ownerToken: "dead-owner",
      ownerPid: 2_000_000_000,
    });
    expect(stale?.run.status).toBe("starting");

    const deadline = Date.now() + 5_000;
    while (app.store.getTask(task.id)?.status !== "succeeded") {
      if (Date.now() > deadline) throw new Error("stale task was not recovered");
      await Bun.sleep(20);
    }
    supervisor.stop();
    await running;

    const runs = app.store.listRuns({ taskId: task.id });
    expect(runs.map((run) => run.status).sort()).toEqual(["interrupted", "succeeded"]);
    expect(
      app.store
        .listEvents({ taskId: task.id, limit: 100 })
        .some((event) => event.kind === "run.recovered"),
    ).toBeTrue();
    app.close();
  });

  test("hard-expires an abandoned lease even while its recorded owner PID is alive", async () => {
    const { root, repo, app } = await setup();
    const codex = join(root, "codex");
    await executable(
      codex,
      `
      await Bun.stdin.text();
      console.log(JSON.stringify({type:"thread.started",thread_id:"hard-recovery-session"}));
      console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:1}}));
      `,
    );
    process.env.AGENTQ_CODEX_BIN = codex;
    const queue = await app.createQueue({ name: "hard-recovery", repoPath: repo, maxAttempts: 2 });
    const task = await app.addTask({
      queue: queue.id,
      title: "Recover live owner",
      provider: "codex",
    });
    const abandoned = app.store.claimNextTask({
      queue: queue.id,
      now: "2000-01-01T00:00:00.000Z",
      ownerToken: "abandoned-owner",
      ownerPid: process.pid,
    });
    if (!abandoned) throw new Error("Expected abandoned claim");

    await new Supervisor(app, {
      pollIntervalMs: 20,
      staleAfterMs: 50,
      hardStaleAfterMs: 100,
    }).run({ once: true });

    expect(app.store.getRun(abandoned.run.id)?.status).toBe("interrupted");
    expect(app.store.getTask(task.id)?.status).toBe("succeeded");
    expect(
      app.store
        .listRuns({ taskId: task.id })
        .map((run) => run.status)
        .sort(),
    ).toEqual(["interrupted", "succeeded"]);
    app.close();
  });

  test("verifies an orphan provider identity before recovering and killing its tree", async () => {
    const { root, repo, app } = await setup();
    const orphanScript = join(root, "orphan-provider.ts");
    const orphanPidFile = join(root, "orphan-provider.pid");
    await writeFile(
      orphanScript,
      `await Bun.stdin.text(); await Bun.write(${JSON.stringify(orphanPidFile)}, String(process.pid)); await Bun.sleep(30_000);`,
    );
    const codex = join(root, "codex");
    await executable(
      codex,
      `
      await Bun.stdin.text();
      console.log(JSON.stringify({type:"thread.started",thread_id:"replacement-session"}));
      console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:1}}));
      `,
    );
    process.env.AGENTQ_CODEX_BIN = codex;
    const queue = await app.createQueue({
      name: "orphan-identity",
      repoPath: repo,
      maxAttempts: 2,
    });
    const task = await app.addTask({ queue: queue.id, title: "Recover orphan", provider: "codex" });
    const claim = app.store.claimNextTask({
      queue: queue.id,
      now: "2000-01-01T00:00:00.000Z",
      ownerToken: "dead-supervisor",
      ownerPid: 2_000_000_000,
    });
    if (!claim) throw new Error("Expected orphan claim");
    const orphan = spawnProcess({
      command: process.execPath,
      args: [orphanScript],
      cwd: repo,
      env: { ...process.env },
      stdin: "prompt",
      gated: true,
      identityDirectory: join(app.paths.stateDir, "process-identities"),
      cancelGraceMs: 100,
    });
    const identity = await orphan.identity;
    if (!identity) throw new Error("Expected orphan identity");
    app.store.markRunRunning(
      claim.run.id,
      {
        at: "2000-01-01T00:00:00.000Z",
        pid: orphan.pid,
        processToken: identity.token,
        processStartMarker: identity.startMarker,
        processIdentityPath: identity.path,
      },
      claim.leaseToken,
    );
    await orphan.release();
    const providerDeadline = Date.now() + 2_000;
    while (!(await Bun.file(orphanPidFile).exists())) {
      if (Date.now() >= providerDeadline) throw new Error("Orphan provider did not start");
      await Bun.sleep(10);
    }
    if (process.platform !== "win32") process.kill(orphan.pid, "SIGSTOP");

    await new Supervisor(app, { pollIntervalMs: 20, staleAfterMs: 50 }).run({ once: true });

    const providerPid = Number(await readFile(orphanPidFile, "utf8"));
    expect(() => process.kill(providerPid, 0)).toThrow();
    expect(app.store.getRun(claim.run.id)?.status).toBe("interrupted");
    const recoveredTask = app.store.getTask(task.id);
    if (recoveredTask?.status !== "succeeded") {
      throw new Error(
        `Replacement task did not succeed: ${JSON.stringify(app.store.listRuns({ taskId: task.id }))}`,
      );
    }
    await orphan.completion;
    app.close();
  });

  test("never releases a provider if persisting its running state fails", async () => {
    const { root, repo, app } = await setup();
    const codex = join(root, "codex");
    const pidFile = join(root, "provider.pid");
    await executable(
      codex,
      `
      await Bun.write(${JSON.stringify(pidFile)}, String(process.pid));
      await Bun.stdin.text();
      await Bun.sleep(30_000);
      `,
    );
    process.env.AGENTQ_CODEX_BIN = codex;
    const queue = await app.createQueue({ name: "setup-failure", repoPath: repo, maxAttempts: 1 });
    const task = await app.addTask({ queue: queue.id, title: "Do not leak", provider: "codex" });
    const original = app.store.markRunRunning.bind(app.store);
    let launcherPid: number | undefined;
    app.store.markRunRunning = ((_id, input) => {
      launcherPid = input?.pid ?? undefined;
      throw new Error("simulated persistence failure");
    }) as typeof app.store.markRunRunning;

    await new Supervisor(app, { pollIntervalMs: 20 }).run({ once: true });
    app.store.markRunRunning = original;

    expect(await Bun.file(pidFile).exists()).toBe(false);
    expect(launcherPid).toBeNumber();
    expect(app.store.getTask(task.id)?.status).toBe("failed");
    const recordedLauncherPid = launcherPid;
    if (typeof recordedLauncherPid === "number") {
      expect(() => process.kill(recordedLauncherPid, 0)).toThrow();
    }
    app.close();
  });

  test("accepts a child task through the sandbox-safe managed-agent intake", async () => {
    const { root, repo, app } = await setup();
    const codex = join(root, "codex");
    process.env.AGENTQ_TEST_CLI = new URL("../src/cli.tsx", import.meta.url).pathname;
    await executable(
      codex,
      `
      const prompt = await Bun.stdin.text();
      if (prompt.includes("Title: Parent task")) {
        const child = Bun.spawn([
          process.execPath,
          process.env.AGENTQ_TEST_CLI!,
          "task", "add", "Delegated child",
          "--instructions", "Created by the parent agent",
          "--idempotency-key", "delegated-child",
          "--json",
        ], { env: process.env, stdout: "pipe", stderr: "pipe" });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        if (exitCode !== 0) throw new Error(stderr || stdout);
      }
      console.log(JSON.stringify({type:"thread.started",thread_id:"intake-session"}));
      console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:1}}));
      `,
    );
    process.env.AGENTQ_CODEX_BIN = codex;
    const queue = await app.createQueue({ name: "intake", repoPath: repo, maxAttempts: 1 });
    const parent = await app.addTask({ queue: queue.id, title: "Parent task", provider: "codex" });

    await new Supervisor(app, { pollIntervalMs: 20 }).run({ once: true });

    const tasks = app.store.listTasks({ queue: queue.id });
    expect(tasks).toHaveLength(2);
    expect(tasks.find((task) => task.title === "Delegated child")).toMatchObject({
      status: "succeeded",
      sourceKind: "agent",
      parentTaskId: parent.id,
    });
    const parentRun = app.store.listRuns({ taskId: parent.id })[0];
    expect(
      await Bun.file(join(app.paths.stateDir, "intake", parentRun?.id ?? "missing")).exists(),
    ).toBe(false);
    app.close();
  });

  test("contains blocked intake responses without duplicating accepted tasks", async () => {
    const { repo, app } = await setup();
    const queue = await app.createQueue({ name: "blocked-intake", repoPath: repo });
    const parent = await app.addTask({ queue: queue.id, title: "Parent" });
    const intake = new DelegatedTaskIntake(app);
    const directory = await intake.register("run_blocked_response", queue.id, parent.id);
    const id = "a".repeat(32);
    await writeFile(
      join(directory, `request-${id}.json`),
      JSON.stringify({ version: 1, id, task: { title: "Exactly once" } }),
    );
    await mkdir(join(directory, `response-${id}.json`));

    await expect(intake.drain()).resolves.toBeUndefined();
    await expect(intake.drain()).resolves.toBeUndefined();

    const children = app.store
      .listTasks({ queue: queue.id })
      .filter((candidate) => candidate.parentTaskId === parent.id);
    expect(children).toHaveLength(1);
    expect(children[0]?.title).toBe("Exactly once");
    expect(
      app.store
        .listEvents({ taskId: parent.id, limit: 100 })
        .some((candidate) => candidate.kind === "intake.failed"),
    ).toBe(true);
    intake.unregister("run_blocked_response");
    app.close();
  });

  test("bounds delegated fan-out and ancestry depth", async () => {
    const { repo, app } = await setup();
    const queue = await app.createQueue({ name: "bounded-intake", repoPath: repo });
    const parent = await app.addTask({ queue: queue.id, title: "Root" });
    const intake = new DelegatedTaskIntake(app, {
      maxChildrenPerRun: 1,
      maxDelegationDepth: 1,
    });
    const directory = await intake.register("run_bounded", queue.id, parent.id);
    const ids = ["b".repeat(32), "c".repeat(32)] as const;
    for (const [index, id] of ids.entries()) {
      await writeFile(
        join(directory, `request-${id}.json`),
        JSON.stringify({ version: 1, id, task: { title: `Child ${index + 1}` } }),
      );
    }
    await intake.drain();
    const responses = await Promise.all(
      ids.map(async (id) =>
        JSON.parse(await readFile(join(directory, `response-${id}.json`), "utf8")),
      ),
    );
    expect(responses.filter((response) => response.ok)).toHaveLength(1);
    expect(responses.filter((response) => response.code === "DELEGATION_CHILD_LIMIT")).toHaveLength(
      1,
    );

    const child = app.store
      .listTasks({ queue: queue.id })
      .find((candidate) => candidate.parentTaskId === parent.id);
    if (!child) throw new Error("Expected one delegated child");
    intake.unregister("run_bounded");
    const childDirectory = await intake.register("run_too_deep", queue.id, child.id);
    const deepId = "d".repeat(32);
    await writeFile(
      join(childDirectory, `request-${deepId}.json`),
      JSON.stringify({ version: 1, id: deepId, task: { title: "Too deep" } }),
    );
    await intake.drain();
    expect(
      JSON.parse(await readFile(join(childDirectory, `response-${deepId}.json`), "utf8")),
    ).toMatchObject({ ok: false, code: "DELEGATION_DEPTH_LIMIT" });
    expect(app.store.listTasks({ queue: queue.id })).toHaveLength(2);
    intake.unregister("run_too_deep");
    app.close();
  });
});
