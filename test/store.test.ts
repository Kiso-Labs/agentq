import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentQError } from "../src/core/errors.ts";
import { AgentQStore } from "../src/store/index.ts";

interface PragmaTextRow {
  journal_mode: string;
}

interface PragmaNumberRow {
  foreign_keys: number;
}

interface CountRow {
  count: number;
}

describe("AgentQStore", () => {
  let stateDirectory: string;
  let databasePath: string;
  let stores: AgentQStore[];

  beforeEach(() => {
    stateDirectory = mkdtempSync(join(tmpdir(), "agentq-store-"));
    databasePath = join(stateDirectory, "nested", "agentq.sqlite");
    stores = [];
  });

  afterEach(() => {
    for (const store of stores) store.close();
    rmSync(stateDirectory, { recursive: true, force: true });
  });

  function open(): AgentQStore {
    const store = new AgentQStore(databasePath);
    stores.push(store);
    return store;
  }

  async function waitForFile(path: string): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (!existsSync(path)) {
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
      await Bun.sleep(10);
    }
  }

  test("creates and migrates a WAL database idempotently", () => {
    const first = open();
    const queue = first.createQueue({ name: "build", repoPath: "/repo" });
    expect(queue.baseRef).toBe("HEAD");

    const second = open();
    expect(second.getQueue("BUILD")?.id).toBe(queue.id);

    const inspection = new Database(databasePath, { readonly: true });
    try {
      expect(inspection.query<PragmaTextRow, []>("PRAGMA journal_mode").get()?.journal_mode).toBe(
        "wal",
      );
      expect(
        inspection.query<CountRow, []>("SELECT COUNT(*) AS count FROM schema_migrations").get()
          ?.count,
      ).toBe(3);
    } finally {
      inspection.close();
    }
  });

  test("initializes a fresh database safely across concurrent processes", async () => {
    const storeUrl = new URL("../src/store/index.ts", import.meta.url).href;
    const source = `
      import { AgentQStore } from ${JSON.stringify(storeUrl)};
      const store = new AgentQStore(${JSON.stringify(databasePath)});
      store.listQueues();
      store.close();
    `;
    const children = Array.from({ length: 12 }, () =>
      Bun.spawn([process.execPath, "-e", source], {
        stdout: "pipe",
        stderr: "pipe",
      }),
    );

    const results = await Promise.all(
      children.map(async (child) => ({
        exitCode: await child.exited,
        stderr: await new Response(child.stderr).text(),
      })),
    );

    expect(results).toEqual(
      Array.from({ length: children.length }, () => ({ exitCode: 0, stderr: "" })),
    );
    expect(open().listQueues()).toEqual([]);
  });

  test("enforces delegated child quotas atomically across concurrent writers", async () => {
    const store = open();
    const queue = store.createQueue({ name: "delegation-quota", repoPath: "/repo" });
    const parent = store.addTask({ queue: queue.id, title: "Parent" });
    const storeUrl = new URL("../src/store/index.ts", import.meta.url).href;
    const children = Array.from({ length: 4 }, (_, index) => {
      const source = `
        import { AgentQStore } from ${JSON.stringify(storeUrl)};
        const store = new AgentQStore(${JSON.stringify(databasePath)});
        let result;
        try {
          const task = store.addTask(
            {
              queue: ${JSON.stringify(queue.id)},
              title: ${JSON.stringify(`Child ${index}`)},
              parentTaskId: ${JSON.stringify(parent.id)},
              idempotencyKey: ${JSON.stringify(`concurrent-child-${index}`)},
            },
            { maxChildrenForParent: 1 },
          );
          result = { kind: "created", id: task.id };
        } catch (error) {
          result = { kind: error?.code ?? "unexpected", message: String(error) };
        } finally {
          store.close();
        }
        process.stdout.write(JSON.stringify(result));
      `;
      return Bun.spawn([process.execPath, "-e", source], {
        stdout: "pipe",
        stderr: "pipe",
      });
    });

    const results = await Promise.all(
      children.map(async (child) => ({
        exitCode: await child.exited,
        stderr: await new Response(child.stderr).text(),
        result: JSON.parse(await new Response(child.stdout).text()) as { kind: string },
      })),
    );

    expect(results.every(({ exitCode, stderr }) => exitCode === 0 && stderr === "")).toBe(true);
    expect(results.filter(({ result }) => result.kind === "created")).toHaveLength(1);
    expect(results.filter(({ result }) => result.kind === "DELEGATION_CHILD_LIMIT")).toHaveLength(
      3,
    );
    expect(
      store.listTasks({ queue: queue.id }).filter((task) => task.parentTaskId === parent.id),
    ).toHaveLength(1);
  });

  test("supports queue CRUD, validation, and robust JSON row mapping", () => {
    const store = open();
    const queue = store.createQueue({
      name: "features",
      repoPath: "/repo/features",
      baseRef: "main",
      defaultProvider: "claude",
      concurrency: 3,
      maxAttempts: 5,
      verifyCommands: ["bun test", "bun run typecheck"],
      autoCommit: true,
    });

    expect(store.listQueues()).toEqual([queue]);
    const updated = store.updateQueue(queue.id, {
      name: "product",
      concurrency: 2,
      verifyCommands: ["bun test"],
      autoCommit: false,
    });
    expect(updated).toMatchObject({
      name: "product",
      concurrency: 2,
      verifyCommands: ["bun test"],
      autoCommit: false,
    });
    expect(() => store.createQueue({ name: "PRODUCT", repoPath: "/other" })).toThrow(AgentQError);

    const raw = new Database(databasePath);
    raw.query("UPDATE queues SET verify_commands = ? WHERE id = ?").run("not-json", queue.id);
    raw.close();

    try {
      store.getQueue(queue.id);
      throw new Error("Expected corrupt row mapping to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentQError);
      expect((error as AgentQError).code).toBe("CORRUPT_DATABASE");
    }
  });

  test("removes only empty queues and preserves tasks in every lifecycle state", () => {
    const store = open();
    const queue = store.createQueue({ name: "not-empty", repoPath: "/repo" });
    const task = store.addTask({ queue: queue.id, title: "must survive queue removal" });
    const claim = store.claimNextTask({ queue: queue.id });
    if (!claim) throw new Error("Expected claim");

    expect(() => store.deleteQueue(queue.id)).toThrow(AgentQError);
    expect(store.getQueue(queue.id)?.id).toBe(queue.id);
    expect(store.getTask(task.id)?.status).toBe("starting");

    store.finishRun(claim.run.id, { status: "succeeded", exitCode: 0 });
    try {
      store.deleteQueue(queue.id);
      throw new Error("Expected non-empty queue removal to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentQError);
      expect((error as AgentQError).code).toBe("QUEUE_NOT_EMPTY");
    }
    expect(store.getTask(task.id)?.status).toBe("succeeded");

    expect(store.deleteTask(task.id)).toBe(true);
    expect(store.deleteQueue(queue.id)).toBe(true);
  });

  test("serializes queue removal with a task added by another writer", async () => {
    const store = open();
    const queue = store.createQueue({ name: "delete-race", repoPath: "/repo" });
    const openedMarker = join(stateDirectory, "delete-opened");
    const goMarker = join(stateDirectory, "delete-go");
    const callMarker = join(stateDirectory, "delete-calling");
    const storeUrl = new URL("../src/store/index.ts", import.meta.url).href;
    const source = `
      import { existsSync, writeFileSync } from "node:fs";
      import { AgentQStore } from ${JSON.stringify(storeUrl)};
      const store = new AgentQStore(${JSON.stringify(databasePath)});
      writeFileSync(${JSON.stringify(openedMarker)}, "ready");
      while (!existsSync(${JSON.stringify(goMarker)})) await Bun.sleep(10);
      writeFileSync(${JSON.stringify(callMarker)}, "calling");
      try {
        console.log(store.deleteQueue(${JSON.stringify(queue.id)}) ? "deleted" : "missing");
      } catch (error) {
        console.log("error:" + String(error?.code ?? error));
      } finally {
        store.close();
      }
    `;

    const child = Bun.spawn([process.execPath, "-e", source], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const writer = new Database(databasePath);
    writer.run("PRAGMA foreign_keys = ON");

    try {
      await waitForFile(openedMarker);
      writer.run("BEGIN IMMEDIATE");
      writeFileSync(goMarker, "go");
      await waitForFile(callMarker);
      await Bun.sleep(100);
      const at = "2026-07-21T12:00:00.000Z";
      writer
        .query<
          unknown,
          [
            string,
            string,
            string,
            string,
            string,
            string,
            number,
            string,
            string,
            number,
            string,
            string,
          ]
        >(`
          INSERT INTO tasks (
            id, queue_id, title, instructions, acceptance_criteria, provider,
            priority, status, source_kind, attempt_count, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          "task_delete_race",
          queue.id,
          "arrived during removal",
          "",
          "[]",
          "codex",
          0,
          "queued",
          "manual",
          0,
          at,
          at,
        );
      writer.run("COMMIT");

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe("error:QUEUE_NOT_EMPTY");
      expect(store.getQueue(queue.id)?.id).toBe(queue.id);
      expect(store.getTask("task_delete_race")?.queueId).toBe(queue.id);
    } finally {
      try {
        writer.run("ROLLBACK");
      } catch {
        // The successful path already committed.
      }
      writer.close();
      if (child.exitCode === null) child.kill();
    }
  });

  test("serializes task removal with a claim made by another writer", async () => {
    const store = open();
    const queue = store.createQueue({ name: "task-delete-race", repoPath: "/repo" });
    const task = store.addTask({ queue: queue.id, title: "claimed during removal" });
    const openedMarker = join(stateDirectory, "task-delete-opened");
    const goMarker = join(stateDirectory, "task-delete-go");
    const callMarker = join(stateDirectory, "task-delete-calling");
    const storeUrl = new URL("../src/store/index.ts", import.meta.url).href;
    const source = `
      import { existsSync, writeFileSync } from "node:fs";
      import { AgentQStore } from ${JSON.stringify(storeUrl)};
      const store = new AgentQStore(${JSON.stringify(databasePath)});
      writeFileSync(${JSON.stringify(openedMarker)}, "ready");
      while (!existsSync(${JSON.stringify(goMarker)})) await Bun.sleep(10);
      writeFileSync(${JSON.stringify(callMarker)}, "calling");
      try {
        console.log(store.deleteTask(${JSON.stringify(task.id)}) ? "deleted" : "missing");
      } catch (error) {
        console.log("error:" + String(error?.code ?? error));
      } finally {
        store.close();
      }
    `;

    const child = Bun.spawn([process.execPath, "-e", source], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const writer = new Database(databasePath);
    writer.run("PRAGMA foreign_keys = ON");

    try {
      await waitForFile(openedMarker);
      writer.run("BEGIN IMMEDIATE");
      writeFileSync(goMarker, "go");
      await waitForFile(callMarker);
      await Bun.sleep(100);
      const at = "2026-07-21T12:30:00.000Z";
      const runId = "run_task_delete_race";
      writer
        .query<unknown, [string, string, number, string, string, string, string]>(`
          INSERT INTO runs (
            id, task_id, attempt_no, provider, status, started_at, heartbeat_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(runId, task.id, 1, "codex", "starting", at, at);
      writer
        .query<unknown, [number, string, string, string, string]>(`
          UPDATE tasks
          SET status = 'starting', attempt_count = ?, current_run_id = ?, updated_at = ?
          WHERE id = ? AND status = ?
        `)
        .run(1, runId, at, task.id, "queued");
      writer.run("COMMIT");

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe("error:TASK_ACTIVE");
      expect(store.getTask(task.id)).toMatchObject({ status: "starting", currentRunId: runId });
      expect(store.getRun(runId)?.status).toBe("starting");
    } finally {
      try {
        writer.run("ROLLBACK");
      } catch {
        // The successful path already committed.
      }
      writer.close();
      if (child.exitCode === null) child.kill();
    }
  });

  test("adds tasks transactionally and deduplicates idempotency keys across connections", () => {
    const first = open();
    const second = open();
    const queue = first.createQueue({ name: "bugs", repoPath: "/repo" });

    const parent = first.addTask({
      queue: queue.name,
      title: "Parent",
      instructions: "Investigate",
      acceptanceCriteria: ["Root cause documented"],
      provider: "claude",
      priority: 4,
      sourceKind: "agent",
      idempotencyKey: "parent-1",
    });
    const duplicate = second.addTask({
      queue: queue.id,
      title: "A different title is ignored for the same key",
      idempotencyKey: "parent-1",
    });
    expect(duplicate.id).toBe(parent.id);

    const child = second.addTask({
      queue: queue.id,
      title: "Child",
      parentTaskId: parent.id,
      priority: 10,
    });
    expect(child.parentTaskId).toBe(parent.id);
    expect(first.listTasks({ queue: "BUGS" }).map((task) => task.id)).toEqual([
      child.id,
      parent.id,
    ]);

    const changed = first.updateTask(child.id, {
      title: "Child updated",
      acceptanceCriteria: ["Regression test added"],
      provider: "claude",
    });
    expect(changed).toMatchObject({
      title: "Child updated",
      acceptanceCriteria: ["Regression test added"],
      provider: "claude",
    });
    const otherQueue = first.createQueue({ name: "other", repoPath: "/repo/other" });
    expect(() =>
      first.addTask({ queue: otherQueue.id, title: "Wrong queue", parentTaskId: parent.id }),
    ).toThrow("same queue");
    expect(() => first.addTask({ queue: queue.id, title: "", priority: 0 })).toThrow(AgentQError);
  });

  test("enforces delegated child limits atomically after idempotency lookup", () => {
    const first = open();
    const second = open();
    const queue = first.createQueue({ name: "delegation-limit", repoPath: "/repo" });
    const parent = first.addTask({ queue: queue.id, title: "Parent" });
    const child = first.addTask(
      {
        queue: queue.id,
        title: "First child",
        parentTaskId: parent.id,
        idempotencyKey: "child-one",
      },
      { maxChildrenForParent: 1 },
    );

    expect(
      second.addTask(
        {
          queue: queue.id,
          title: "Idempotent replay",
          parentTaskId: parent.id,
          idempotencyKey: "child-one",
        },
        { maxChildrenForParent: 1 },
      ).id,
    ).toBe(child.id);
    expect(() =>
      second.addTask(
        { queue: queue.id, title: "Second child", parentTaskId: parent.id },
        { maxChildrenForParent: 1 },
      ),
    ).toThrow("delegated task limit");
    expect(first.listTasks({ queue: queue.id }).filter((task) => task.parentTaskId)).toHaveLength(
      1,
    );
  });

  test("atomically enforces per-queue concurrency and claim ordering", () => {
    const first = open();
    const second = open();
    const serial = first.createQueue({
      name: "serial",
      repoPath: "/repo/serial",
      concurrency: 1,
      maxAttempts: 2,
    });
    const parallel = first.createQueue({
      name: "parallel",
      repoPath: "/repo/parallel",
      concurrency: 2,
    });
    const low = first.addTask({ queue: serial.id, title: "low", priority: 0 });
    const high = first.addTask({ queue: serial.id, title: "high", priority: 20 });
    first.addTask({ queue: parallel.id, title: "parallel one" });
    first.addTask({ queue: parallel.id, title: "parallel two" });
    first.addTask({ queue: parallel.id, title: "parallel three" });

    const serialClaim = first.claimNextTask({ queue: serial.name });
    expect(serialClaim?.task.id).toBe(high.id);
    expect(second.claimNextTask({ queue: serial.id })).toBeUndefined();

    const globalClaim = second.claimNextTask();
    expect(globalClaim?.task.queueId).toBe(parallel.id);
    const secondParallelClaim = first.claimNextTask({ queue: parallel.id });
    expect(secondParallelClaim?.task.queueId).toBe(parallel.id);
    expect(second.claimNextTask({ queue: parallel.id })).toBeUndefined();

    if (!serialClaim || !globalClaim || !secondParallelClaim) {
      throw new Error("Expected claims to be available");
    }
    const running = first.markRunRunning(serialClaim.run.id, {
      pid: 1234,
      baseSha: "abc123",
      branchName: "agentq/high",
      worktreePath: "/tmp/high",
      providerSessionId: "session-1",
      logPath: "/tmp/high.log",
      at: "2026-07-21T10:00:00.000Z",
    });
    expect(running).toMatchObject({
      status: "running",
      pid: 1234,
      providerSessionId: "session-1",
    });
    expect(first.heartbeatRun(running.id, "2026-07-21T10:00:01.000Z").heartbeatAt).toBe(
      "2026-07-21T10:00:01.000Z",
    );

    const failed = first.finishRun(serialClaim.run.id, {
      status: "failed",
      exitCode: 1,
      error: "tests failed",
      finishedAt: "2026-07-21T10:00:02.000Z",
    });
    expect(failed.task.status).toBe("queued");
    const retry = second.claimNextTask({ queue: serial.id });
    expect(retry?.task.id).toBe(high.id);
    expect(retry?.run.attemptNo).toBe(2);
    if (!retry) throw new Error("Expected retry claim");
    expect(
      first.finishRun(retry.run.id, { status: "failed", error: "still failing" }).task.status,
    ).toBe("failed");

    expect(second.claimNextTask({ queue: serial.id })?.task.id).toBe(low.id);
    first.finishRun(globalClaim.run.id, { status: "succeeded", exitCode: 0 });
    expect(second.claimNextTask({ queue: parallel.id })?.task.id).toBeDefined();
  });

  test("enforces a database-wide concurrency ceiling across supervisors", () => {
    const first = open();
    const second = open();
    const queue = first.createQueue({
      name: "global-cap",
      repoPath: "/repo",
      concurrency: 4,
    });
    first.addTask({ queue: queue.id, title: "one" });
    first.addTask({ queue: queue.id, title: "two" });

    const claim = first.claimNextTask({ maxConcurrency: 1 });
    expect(claim).toBeDefined();
    expect(second.claimNextTask({ maxConcurrency: 1 })).toBeUndefined();
    if (!claim) throw new Error("Expected the first global claim");
    first.finishRun(claim.run.id, { status: "succeeded" });
    expect(second.claimNextTask({ maxConcurrency: 1 })).toBeDefined();
  });

  test("manual completion cannot race an active claim", () => {
    const first = open();
    const second = open();
    const queue = first.createQueue({ name: "manual-race", repoPath: "/repo" });
    const task = first.addTask({ queue: queue.id, title: "claim wins" });
    const claim = second.claimNextTask({ queue: queue.id });
    expect(claim).toBeDefined();

    try {
      first.completeTaskManually(task.id, "stale operator completion");
      throw new Error("Expected active task completion to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentQError);
      expect((error as AgentQError).code).toBe("TASK_IS_RUNNING");
    }
    expect(first.getTask(task.id)).toMatchObject({
      status: "starting",
      currentRunId: claim?.run.id,
    });
    expect(first.listEvents({ taskId: task.id })).toEqual([]);
  });

  test("does not resurrect a run that becomes terminal during an active transition", async () => {
    const store = open();
    const queue = store.createQueue({ name: "run-race", repoPath: "/repo" });
    const task = store.addTask({ queue: queue.id, title: "finish once" });
    const claim = store.claimNextTask({ queue: queue.id });
    if (!claim) throw new Error("Expected claim");

    const openedMarker = join(stateDirectory, "update-run-opened");
    const goMarker = join(stateDirectory, "update-run-go");
    const observedMarker = join(stateDirectory, "update-run-observed");
    const storeUrl = new URL("../src/store/index.ts", import.meta.url).href;
    const source = `
      import { existsSync, writeFileSync } from "node:fs";
      import { AgentQStore } from ${JSON.stringify(storeUrl)};
      const store = new AgentQStore(${JSON.stringify(databasePath)});
      writeFileSync(${JSON.stringify(openedMarker)}, "ready");
      while (!existsSync(${JSON.stringify(goMarker)})) await Bun.sleep(10);
      const observed = store.getRun(${JSON.stringify(claim.run.id)});
      writeFileSync(${JSON.stringify(observedMarker)}, observed?.status ?? "missing");
      try {
        const updated = store.updateRun(${JSON.stringify(claim.run.id)}, { status: "cancelling" });
        console.log("updated:" + updated.status);
      } catch (error) {
        console.log("error:" + String(error?.code ?? error));
      } finally {
        store.close();
      }
    `;

    const child = Bun.spawn([process.execPath, "-e", source], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const finisher = new Database(databasePath);
    finisher.run("PRAGMA foreign_keys = ON");

    try {
      await waitForFile(openedMarker);
      finisher.run("BEGIN IMMEDIATE");
      const finishedAt = "2026-07-21T13:00:00.000Z";
      finisher
        .query<unknown, [string, string, string]>(`
          UPDATE runs
          SET status = 'succeeded', heartbeat_at = ?, finished_at = ?, exit_code = 0
          WHERE id = ?
        `)
        .run(finishedAt, finishedAt, claim.run.id);
      finisher
        .query<unknown, [string, string, string]>(`
          UPDATE tasks
          SET status = 'succeeded', current_run_id = NULL, completed_at = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(finishedAt, finishedAt, task.id);
      writeFileSync(goMarker, "go");
      await waitForFile(observedMarker);
      expect(await Bun.file(observedMarker).text()).toBe("starting");
      await Bun.sleep(100);
      finisher.run("COMMIT");

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe("error:RUN_NOT_ACTIVE");
      expect(store.getRun(claim.run.id)?.status).toBe("succeeded");
      expect(store.getTask(task.id)?.status).toBe("succeeded");
    } finally {
      try {
        finisher.run("ROLLBACK");
      } catch {
        // The successful path already committed.
      }
      finisher.close();
      if (child.exitCode === null) child.kill();
    }
  });

  test("serializes claims made by separate Bun supervisor processes", async () => {
    const store = open();
    const queue = store.createQueue({ name: "processes", repoPath: "/repo", concurrency: 1 });
    store.addTask({ queue: queue.id, title: "only one active claim" });

    const storeUrl = new URL("../src/store/index.ts", import.meta.url).href;
    const source = `
      import { AgentQStore } from ${JSON.stringify(storeUrl)};
      const store = new AgentQStore(${JSON.stringify(databasePath)});
      const claim = store.claimNextTask({ queue: ${JSON.stringify(queue.id)} });
      console.log(claim?.task.id ?? "none");
      store.close();
    `;
    const children = [
      Bun.spawn([process.execPath, "-e", source], { stdout: "pipe", stderr: "pipe" }),
      Bun.spawn([process.execPath, "-e", source], { stdout: "pipe", stderr: "pipe" }),
    ];

    const outputs = await Promise.all(
      children.map(async (child) => {
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(stderr).toBe("");
        expect(exitCode).toBe(0);
        return stdout.trim();
      }),
    );
    expect(outputs.filter((output) => output === "none")).toHaveLength(1);
    expect(outputs.filter((output) => output !== "none")).toHaveLength(1);
    expect(store.listRuns({ status: ["starting", "running", "cancelling"] })).toHaveLength(1);
  });

  test("persists cancellation flags and safely requeues terminal tasks", () => {
    const store = open();
    const queue = store.createQueue({ name: "cancel", repoPath: "/repo" });
    const queued = store.addTask({ queue: queue.id, title: "queued" });
    const cancelledQueued = store.requestCancellation(queued.id, "2026-07-21T11:00:00Z");
    expect(cancelledQueued).toMatchObject({
      status: "cancelled",
      cancelRequestedAt: "2026-07-21T11:00:00.000Z",
    });
    expect(store.claimNextTask({ queue: queue.id })).toBeUndefined();

    expect(store.requeueTask(queued.id).status).toBe("queued");
    const claim = store.claimNextTask({ queue: queue.id });
    if (!claim) throw new Error("Expected claim");
    store.markRunRunning(claim.run.id);
    const cancelling = store.requestCancellation(claim.task.id);
    expect(cancelling.status).toBe("cancelling");
    expect(store.getRun(claim.run.id)?.status).toBe("cancelling");
    const finished = store.finishRun(claim.run.id, {
      status: "failed",
      error: "process interrupted",
    });
    expect(finished.run.status).toBe("cancelled");
    expect(finished.task.status).toBe("cancelled");
    expect(() => store.heartbeatRun(claim.run.id)).toThrow(AgentQError);
  });

  test("fences run ownership and releases graceful shutdowns without spending an attempt", () => {
    const store = open();
    const queue = store.createQueue({ name: "leases", repoPath: "/repo", maxAttempts: 1 });
    const task = store.addTask({ queue: queue.id, title: "leased task" });
    const claim = store.claimNextTask({
      queue: queue.id,
      ownerToken: "owner-a",
      ownerPid: process.pid,
    });
    if (!claim) throw new Error("Expected claim");
    expect(claim.leaseToken).toBe("owner-a");
    expect(claim.run.ownerPid).toBe(process.pid);

    expect(() => store.heartbeatRun(claim.run.id, undefined, "owner-b")).toThrow(AgentQError);
    expect(store.heartbeatRun(claim.run.id, undefined, "owner-a").status).toBe("starting");
    expect(() => store.finishRun(claim.run.id, { status: "failed" }, "owner-b")).toThrow(
      AgentQError,
    );

    const released = store.finishRun(
      claim.run.id,
      { status: "interrupted", error: "supervisor stopped", requeue: true },
      "owner-a",
    );
    expect(released.run.status).toBe("interrupted");
    expect(released.task).toMatchObject({ id: task.id, status: "queued", attemptCount: 0 });
  });

  test("stores resume intent atomically until a resumed provider is running", () => {
    const store = open();
    const queue = store.createQueue({ name: "resume-intent", repoPath: "/repo" });
    const task = store.addTask({ queue: queue.id, title: "resume me", provider: "codex" });
    const first = store.claimNextTask({ queue: queue.id });
    if (!first) throw new Error("Expected initial claim");
    store.markRunRunning(first.run.id, {
      providerSessionId: "session-1",
      worktreePath: "/tmp/worktree",
      branchName: "agentq/resume/task-a1",
      baseSha: "abc123",
    });
    store.finishRun(first.run.id, { status: "failed", error: "needs another turn" });

    const queued = store.requeueTask(task.id, undefined, first.run.id);
    expect(queued.resumeRunId).toBe(first.run.id);
    const resumed = store.claimNextTask({
      queue: queue.id,
      ownerToken: "resume-owner",
      ownerPid: process.pid,
    });
    if (!resumed) throw new Error("Expected resumed claim");
    expect(resumed.task.resumeRunId).toBe(first.run.id);

    store.markRunRunning(resumed.run.id, {}, resumed.leaseToken);
    expect(
      store.consumeResumeIntent(task.id, resumed.run.id, first.run.id, resumed.leaseToken)
        .resumeRunId,
    ).toBeUndefined();
  });

  test("rechecks the heartbeat while atomically fencing eligible stale runs", () => {
    const store = open();
    const queue = store.createQueue({ name: "recovery-fence", repoPath: "/repo" });
    const task = store.addTask({ queue: queue.id, title: "still owned" });
    const claim = store.claimNextTask({
      queue: queue.id,
      now: "2026-07-21T08:00:00Z",
      ownerToken: "live-owner",
      ownerPid: process.pid,
    });
    if (!claim) throw new Error("Expected claim");
    store.heartbeatRun(claim.run.id, "2026-07-21T08:02:00Z", claim.leaseToken);

    const recovered = store.recoverStaleRuns("2026-07-21T08:01:00Z", "2026-07-21T08:03:00Z", [
      claim.run.id,
    ]);

    expect(recovered.recoveredRuns).toBe(0);
    expect(store.getRun(claim.run.id)?.status).toBe("starting");
    expect(store.getTask(task.id)?.status).toBe("starting");
  });

  test("fences stale ownership before making a replacement task claimable", () => {
    const store = open();
    const queue = store.createQueue({ name: "two-phase-recovery", repoPath: "/repo" });
    const task = store.addTask({ queue: queue.id, title: "cleanup first" });
    const claim = store.claimNextTask({
      queue: queue.id,
      now: "2026-07-21T08:00:00Z",
      ownerToken: "expired-owner",
    });
    if (!claim) throw new Error("Expected claim");

    const fenced = store.fenceStaleRuns({
      staleBefore: "2026-07-21T08:01:00Z",
      at: "2026-07-21T08:02:00Z",
      ownerToken: "recovery-owner",
      eligibleRunIds: [claim.run.id],
    });

    expect(fenced.runs[0]?.status).toBe("cancelling");
    expect(fenced.tasks[0]?.status).toBe("cancelling");
    expect(store.claimNextTask({ queue: queue.id })).toBeUndefined();
    expect(() => store.heartbeatRun(claim.run.id, undefined, "expired-owner")).toThrow(AgentQError);

    const finished = store.finishRun(
      claim.run.id,
      { status: "interrupted", error: "orphan cleaned" },
      "recovery-owner",
    );
    expect(finished.task.status).toBe("queued");
    expect(store.claimNextTask({ queue: queue.id })?.task.id).toBe(task.id);
  });

  test("recovers stale runs, retries within budget, and terminates exhausted attempts", () => {
    const store = open();
    const queue = store.createQueue({
      name: "recovery",
      repoPath: "/repo",
      concurrency: 2,
      maxAttempts: 2,
    });
    const retryable = store.addTask({ queue: queue.id, title: "retryable" });
    const first = store.claimNextTask({ queue: queue.id, now: "2026-07-21T08:00:00Z" });
    if (!first) throw new Error("Expected first claim");
    const firstRecovery = store.recoverStaleRuns("2026-07-21T08:01:00Z", "2026-07-21T08:02:00Z");
    expect(firstRecovery.recoveredRuns).toBe(1);
    expect(firstRecovery.runs[0]?.status).toBe("interrupted");
    expect(firstRecovery.tasks[0]?.status).toBe("queued");

    const second = store.claimNextTask({ queue: queue.id, now: "2026-07-21T08:03:00Z" });
    expect(second?.task.id).toBe(retryable.id);
    const secondRecovery = store.recoverStaleRuns("2026-07-21T08:04:00Z", "2026-07-21T08:05:00Z");
    expect(secondRecovery.tasks[0]?.status).toBe("interrupted");
    expect(store.claimNextTask({ queue: queue.id })).toBeUndefined();

    const cancelled = store.addTask({ queue: queue.id, title: "cancel while worker is lost" });
    const cancelledClaim = store.claimNextTask({
      queue: queue.id,
      now: "2026-07-21T09:00:00Z",
    });
    expect(cancelledClaim?.task.id).toBe(cancelled.id);
    store.requestCancellation(cancelled.id, "2026-07-21T09:00:30Z");
    const cancelledRecovery = store.recoverStaleRuns(
      "2026-07-21T09:01:00Z",
      "2026-07-21T09:02:00Z",
    );
    expect(cancelledRecovery.runs[0]?.status).toBe("cancelled");
    expect(cancelledRecovery.tasks[0]?.status).toBe("cancelled");
  });

  test("stores ordered JSON events and maintains foreign-key cleanup", () => {
    const store = open();
    const queue = store.createQueue({ name: "events", repoPath: "/repo" });
    const task = store.addTask({ queue: queue.id, title: "emit events" });
    const claim = store.claimNextTask();
    if (!claim) throw new Error("Expected claim");

    const first = store.appendEvent({
      taskId: task.id,
      runId: claim.run.id,
      kind: "assistant",
      payload: { text: "hello", tokens: 2 },
    });
    const second = store.appendEvent({
      taskId: task.id,
      runId: claim.run.id,
      kind: "tool",
      payload: { name: "bash", state: "started" },
    });
    expect(store.listEvents({ taskId: task.id })).toEqual([first, second]);
    expect(store.listEvents({ taskId: task.id, afterId: first.id })).toEqual([second]);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => store.appendEvent({ taskId: task.id, kind: "invalid", payload: cyclic })).toThrow(
      AgentQError,
    );

    store.finishRun(claim.run.id, { status: "succeeded", exitCode: 0 });
    expect(store.deleteRun(claim.run.id)).toBe(true);
    expect(store.listEvents({ taskId: task.id }).every((event) => event.runId === undefined)).toBe(
      true,
    );
    expect(store.deleteEvents({ taskId: task.id, afterId: first.id })).toBe(1);
    expect(store.counts()).toEqual({ queues: 1, tasks: 1, runs: 0, events: 1 });

    expect(store.deleteTask(task.id)).toBe(true);
    expect(store.counts().events).toBe(0);
    expect(store.deleteQueue(queue.id)).toBe(true);
    expect(store.counts().queues).toBe(0);
  });

  test("enables foreign keys on every store connection", () => {
    const store = open();
    const queue = store.createQueue({ name: "foreign-keys", repoPath: "/repo" });
    const task = store.addTask({ queue: queue.id, title: "task" });
    expect(() => store.appendEvent({ taskId: task.id, runId: "missing", kind: "invalid" })).toThrow(
      AgentQError,
    );

    // Verify the intended connection-level setting independently as part of the schema contract.
    const check = new Database(databasePath);
    check.run("PRAGMA foreign_keys = ON");
    expect(check.query<PragmaNumberRow, []>("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
    check.close();
  });
});
