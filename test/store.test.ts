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

function createVersion3Database(path: string): void {
  const database = new Database(path, { create: true, readwrite: true, strict: true });
  const at = "2026-07-20T12:00:00.000Z";
  try {
    database.run("PRAGMA foreign_keys = ON");
    database.run(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    database.run(`
      CREATE TABLE queues (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        repo_path TEXT NOT NULL,
        base_ref TEXT NOT NULL,
        default_provider TEXT NOT NULL CHECK (default_provider IN ('codex', 'claude')),
        concurrency INTEGER NOT NULL CHECK (concurrency > 0),
        max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
        verify_commands TEXT NOT NULL,
        auto_commit INTEGER NOT NULL CHECK (auto_commit IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    database.run(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        queue_id TEXT NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        instructions TEXT NOT NULL,
        acceptance_criteria TEXT NOT NULL,
        provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude')),
        priority INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN (
            'queued', 'starting', 'running', 'cancelling',
            'succeeded', 'failed', 'interrupted', 'cancelled'
          )
        ),
        source_kind TEXT NOT NULL CHECK (source_kind IN ('manual', 'agent', 'api')),
        parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        idempotency_key TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        current_run_id TEXT,
        cancel_requested_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        resume_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL
      )
    `);
    database.run(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
        provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude')),
        status TEXT NOT NULL CHECK (
          status IN (
            'starting', 'running', 'cancelling',
            'succeeded', 'failed', 'interrupted', 'cancelled'
          )
        ),
        base_sha TEXT,
        branch_name TEXT,
        worktree_path TEXT,
        provider_session_id TEXT,
        pid INTEGER,
        started_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        finished_at TEXT,
        exit_code INTEGER,
        summary TEXT,
        error TEXT,
        log_path TEXT,
        owner_token TEXT,
        owner_pid INTEGER,
        process_token TEXT,
        process_start_marker TEXT,
        process_identity_path TEXT,
        UNIQUE(task_id, attempt_no)
      )
    `);
    database.run(`
      CREATE TABLE task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    for (const [version, name] of [
      [1, "initial_schema"],
      [2, "run_leases_and_resume_intent"],
      [3, "provider_process_identity"],
    ] as const) {
      database
        .query("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)")
        .run(version, name, at);
    }
    database
      .query(`
        INSERT INTO queues(
          id, name, repo_path, base_ref, default_provider, concurrency,
          max_attempts, verify_commands, auto_commit, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run("queue_v3", "Build", "/repos/legacy", "main", "codex", 2, 3, "[]", 1, at, at);
    database
      .query(`
        INSERT INTO tasks(
          id, queue_id, title, instructions, acceptance_criteria, provider, priority,
          status, source_kind, attempt_count, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        "task_v3",
        "queue_v3",
        "Legacy task",
        "Preserve me",
        '["Still present"]',
        "codex",
        7,
        "failed",
        "manual",
        1,
        at,
        at,
        at,
      );
    database
      .query(`
        INSERT INTO runs(
          id, task_id, attempt_no, provider, status, started_at, heartbeat_at,
          finished_at, exit_code, summary
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run("run_v3", "task_v3", 1, "codex", "failed", at, at, at, 1, "Legacy run");
    database
      .query(
        "UPDATE tasks SET status = 'queued', completed_at = NULL, resume_run_id = ? WHERE id = ?",
      )
      .run("run_v3", "task_v3");
    database
      .query(`
        INSERT INTO task_events(task_id, run_id, kind, payload, created_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run("task_v3", "run_v3", "assistant", '{"text":"legacy event"}', at);
  } finally {
    database.close();
  }
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
    // Windows can briefly retain SQLite/WAL handles after a synchronous close.
    // Bound the native EBUSY retry so persistent handle leaks still fail the test.
    rmSync(stateDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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
    const queue = first.createQueue({ name: "build", repoKey: "repo", repoPath: "/repo" });
    expect(queue.baseRef).toBe("HEAD");
    expect(queue).toMatchObject({
      planModel: "",
      planInstructions: "",
      implementModel: "",
      implementInstructions: "",
    });

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
      ).toBe(7);
    } finally {
      inspection.close();
    }
  });

  test("migrates v3 queues without losing related tasks, runs, events, or foreign keys", () => {
    databasePath = join(stateDirectory, "agentq-v3.sqlite");
    createVersion3Database(databasePath);

    const store = open();
    expect(store.getQueue("queue_v3")).toMatchObject({
      id: "queue_v3",
      name: "Build",
      repoKey: "/repos/legacy",
      repoPath: "/repos/legacy",
      planModel: "",
      planInstructions: "",
      implementModel: "",
      implementInstructions: "",
    });
    expect(store.getTask("task_v3")).toMatchObject({
      title: "Legacy task",
      acceptanceCriteria: ["Still present"],
      status: "queued",
    });
    expect(store.getTask("task_v3")?.resumeRunId).toBeUndefined();
    expect(store.getRun("run_v3")).toMatchObject({
      id: "run_v3",
      phase: "implement",
      summary: "Legacy run",
    });
    expect(store.getRun("run_v3")?.taskSnapshot).toBeUndefined();
    expect(store.listEvents({ taskId: "task_v3" })[0]).toMatchObject({
      runId: "run_v3",
      payload: { text: "legacy event" },
    });

    const inspection = new Database(databasePath);
    try {
      inspection.run("PRAGMA foreign_keys = ON");
      expect(inspection.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      inspection.close();
    }

    expect(store.deleteTask("task_v3")).toBe(true);
    expect(store.getRun("run_v3")).toBeUndefined();
    expect(store.listEvents({ taskId: "task_v3" })).toEqual([]);
    expect(store.deleteQueue("queue_v3")).toBe(true);
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
    const queue = store.createQueue({
      name: "delegation-quota",
      repoKey: "repo",
      repoPath: "/repo",
    });
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
      repoKey: "features-repo",
      repoPath: "/repo/features",
      baseRef: "main",
      defaultProvider: "claude",
      concurrency: 3,
      maxAttempts: 5,
      planModel: "gpt-5.4-mini",
      planInstructions: "Identify the smallest safe change before handing off.",
      implementModel: "gpt-5.4",
      implementInstructions: "Prefer focused tests and preserve public APIs.",
      verifyCommands: ["bun test", "bun run typecheck"],
      autoCommit: true,
    });

    expect(store.listQueues()).toEqual([queue]);
    const updated = store.updateQueue(queue.id, {
      name: "product",
      concurrency: 2,
      planModel: "gpt-5.4",
      planInstructions: "Map the affected call paths.",
      implementModel: "gpt-5.4-codex",
      implementInstructions: "Keep commits reviewable.",
      verifyCommands: ["bun test"],
      autoCommit: false,
    });
    expect(updated).toMatchObject({
      name: "product",
      concurrency: 2,
      planModel: "gpt-5.4",
      planInstructions: "Map the affected call paths.",
      implementModel: "gpt-5.4-codex",
      implementInstructions: "Keep commits reviewable.",
      verifyCommands: ["bun test"],
      autoCommit: false,
    });
    expect(store.updateQueue(queue.id, { defaultProvider: "codex" })).toMatchObject({
      defaultProvider: "codex",
      planModel: "",
      implementModel: "",
      planInstructions: "Map the affected call paths.",
      implementInstructions: "Keep commits reviewable.",
    });
    expect(
      store.updateQueue(queue.id, {
        defaultProvider: "claude",
        planModel: "haiku",
        implementModel: "sonnet",
      }),
    ).toMatchObject({
      defaultProvider: "claude",
      planModel: "haiku",
      implementModel: "sonnet",
    });
    expect(() =>
      store.createQueue({ name: "PRODUCT", repoKey: "features-repo", repoPath: "/other" }),
    ).toThrow(AgentQError);

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

  test("supports same-named queues across repositories without ambiguous resolution", () => {
    const store = open();
    const first = store.createQueue({ name: "Build", repoKey: "repo-a", repoPath: "/repos/a" });
    const second = store.createQueue({
      name: "build",
      repoKey: "repo-b",
      repoPath: "/repos/b",
    });

    expect(store.listQueues("repo-a")).toEqual([first]);
    expect(store.listQueues("repo-b")).toEqual([second]);
    expect(store.listQueues("REPO-A")).toEqual([]);
    expect(store.getQueue("BUILD", "repo-a")?.id).toBe(first.id);
    expect(store.getQueue("build", "repo-b")?.id).toBe(second.id);
    expect(store.getQueue(first.id, "repo-b")).toBeUndefined();
    try {
      store.getQueue("build");
      throw new Error("Expected an unscoped duplicate queue name to be ambiguous");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentQError);
      expect((error as AgentQError).code).toBe("QUEUE_AMBIGUOUS");
    }

    expect(store.updateQueue("build", { concurrency: 4 }, "repo-a").concurrency).toBe(4);
    expect(store.getQueue(first.id)?.concurrency).toBe(4);
    expect(store.getQueue(second.id)?.concurrency).toBe(1);
    expect(() =>
      store.createQueue({ name: "BUILD", repoKey: "repo-a", repoPath: "/repos/a-copy" }),
    ).toThrow(AgentQError);
    expect(store.deleteQueue("build", "repo-b")).toBe(true);
    expect(store.getQueue(second.id)).toBeUndefined();
    expect(store.getQueue("build")?.id).toBe(first.id);
  });

  test("scopes task lists and claims before applying cross-repository priority", () => {
    const store = open();
    const first = store.createQueue({ name: "work", repoKey: "repo-a", repoPath: "/repos/a" });
    const second = store.createQueue({ name: "WORK", repoKey: "repo-b", repoPath: "/repos/b" });
    const local = store.addTask({ queue: first.id, title: "Local task", priority: 1 });
    const foreign = store.addTask({ queue: second.id, title: "Foreign task", priority: 100 });

    expect(store.listTasks({ repoKey: "repo-a" }).map((task) => task.id)).toEqual([local.id]);
    expect(store.listTasks({ repoKey: "repo-b" }).map((task) => task.id)).toEqual([foreign.id]);
    expect(store.claimNextTask({ repoKey: "repo-a" })?.task.id).toBe(local.id);
    expect(store.claimNextTask({ queue: "work", repoKey: "repo-b" })?.task.id).toBe(foreign.id);
  });

  test("removes only empty queues and preserves tasks in every lifecycle state", () => {
    const store = open();
    const queue = store.createQueue({ name: "not-empty", repoKey: "repo", repoPath: "/repo" });
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

  test("cascades inactive queue history but preserves active or retained work", () => {
    const store = open();
    const removableQueue = store.createQueue({
      name: "cascade-delete",
      repoKey: "repo",
      repoPath: "/repo",
    });
    const removableTask = store.addTask({
      queue: removableQueue.id,
      title: "remove all history",
    });
    const completed = store.claimNextTask({ queue: removableQueue.id });
    if (!completed) throw new Error("Expected completed claim");
    store.appendEvent({
      taskId: removableTask.id,
      runId: completed.run.id,
      kind: "assistant",
      payload: { text: "done" },
    });
    store.finishRun(completed.run.id, { status: "succeeded", exitCode: 0 });

    expect(store.deleteQueueCascade(removableQueue.id)).toMatchObject({
      queue: { id: removableQueue.id },
      taskIds: [removableTask.id],
    });
    expect(store.getQueue(removableQueue.id)).toBeUndefined();
    expect(store.getTask(removableTask.id)).toBeUndefined();
    expect(store.getRun(completed.run.id)).toBeUndefined();
    expect(store.listEvents({ taskId: removableTask.id })).toEqual([]);

    const activeQueue = store.createQueue({
      name: "cascade-active",
      repoKey: "repo",
      repoPath: "/repo",
    });
    const activeTask = store.addTask({ queue: activeQueue.id, title: "still active" });
    const active = store.claimNextTask({ queue: activeQueue.id });
    if (!active) throw new Error("Expected active claim");
    try {
      store.deleteQueueCascade(activeQueue.id);
      throw new Error("Expected active queue deletion to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentQError);
      expect((error as AgentQError).code).toBe("QUEUE_HAS_ACTIVE_TASKS");
    }
    expect(store.getQueue(activeQueue.id)?.id).toBe(activeQueue.id);
    expect(store.getTask(activeTask.id)?.status).toBe("starting");

    store.finishRun(active.run.id, { status: "failed", exitCode: 1 });
    store.updateRun(active.run.id, { worktreePath: "/retained/worktree" });
    try {
      store.deleteQueueCascade(activeQueue.id);
      throw new Error("Expected retained queue deletion to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentQError);
      expect((error as AgentQError).code).toBe("QUEUE_HAS_WORKTREES");
    }
    expect(store.getQueue(activeQueue.id)?.id).toBe(activeQueue.id);
    expect(store.getTask(activeTask.id)?.id).toBe(activeTask.id);
  });

  test("preserves delegation provenance by deleting only leaf tasks", () => {
    const store = open();
    const queue = store.createQueue({ name: "task-tree", repoKey: "repo", repoPath: "/repo" });
    const parent = store.addTask({ queue: queue.id, title: "parent" });
    const child = store.addTask({
      queue: queue.id,
      title: "child",
      parentTaskId: parent.id,
      sourceKind: "agent",
    });

    try {
      store.deleteTask(parent.id);
      throw new Error("Expected parent task deletion to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentQError);
      expect((error as AgentQError).code).toBe("TASK_HAS_CHILDREN");
    }
    expect(store.getTask(parent.id)?.id).toBe(parent.id);
    expect(store.getTask(child.id)?.parentTaskId).toBe(parent.id);

    expect(store.deleteTask(child.id)).toBe(true);
    expect(store.deleteTask(parent.id)).toBe(true);
  });

  test("refuses task deletion while any run remains active", () => {
    const store = open();
    const queue = store.createQueue({ name: "active-run", repoKey: "repo", repoPath: "/repo" });
    const task = store.addTask({ queue: queue.id, title: "active run" });
    const claim = store.claimNextTask({ queue: queue.id });
    if (!claim) throw new Error("Expected task claim");

    // Exercise the defensive store boundary with deliberately inconsistent task metadata.
    store.updateTask(task.id, { status: "failed", currentRunId: null });
    try {
      store.deleteTask(task.id);
      throw new Error("Expected active run deletion to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentQError);
      expect((error as AgentQError).code).toBe("TASK_ACTIVE");
    }
    expect(store.getTask(task.id)?.id).toBe(task.id);
    expect(store.getRun(claim.run.id)?.status).toBe("starting");
  });

  test("serializes queue removal with a task added by another writer", async () => {
    const store = open();
    const queue = store.createQueue({ name: "delete-race", repoKey: "repo", repoPath: "/repo" });
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
    const queue = store.createQueue({
      name: "task-delete-race",
      repoKey: "repo",
      repoPath: "/repo",
    });
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
    const queue = first.createQueue({ name: "bugs", repoKey: "repo", repoPath: "/repo" });

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
    const otherQueue = first.createQueue({
      name: "other",
      repoKey: "other-repo",
      repoPath: "/repo/other",
    });
    expect(() =>
      first.addTask({ queue: otherQueue.id, title: "Wrong queue", parentTaskId: parent.id }),
    ).toThrow("same queue");
    expect(() => first.addTask({ queue: queue.id, title: "", priority: 0 })).toThrow(AgentQError);
  });

  test("stores structured task specifications and enforces a native dependency DAG", () => {
    const store = open();
    const queue = store.createQueue({
      name: "dependency-graph",
      repoKey: "repo",
      repoPath: "/repo",
      allowedPaths: ["src/**", "test/**"],
      deniedPaths: ["src/api/**"],
      maxChangedFiles: 25,
      approvalCheckpoints: ["after-plan"],
      baseDriftPolicy: "replan",
      landStrategy: "stack",
    });
    const blocker = store.addTask({
      queue: queue.id,
      title: "Create the service seam",
      objective: "Create a reusable service seam.",
    });
    const dependent = store.addTask({
      queue: queue.id,
      title: "Use the service seam",
      objective: "Move the feature onto the new service seam.",
      instructions: "Preserve the public API.",
      acceptanceCriteria: ["Focused tests pass"],
      invariants: ["Existing callers keep working"],
      handoffRequirements: ["Document the new ownership boundary"],
      blockedBy: [blocker.id, blocker.id],
      expectedPaths: ["src/services/feature.ts"],
      allowedPaths: ["src/services/**", "test/services/**"],
      deniedPaths: ["src/api/**", "test/api/**"],
      maxChangedFiles: 20,
      verifyCommands: ["bun test test/services"],
      approvalCheckpoints: ["after-plan", "before-integrate"],
      baseDriftPolicy: "rebase",
      landStrategy: "stack",
    });

    expect(queue).toMatchObject({
      allowedPaths: ["src/**", "test/**"],
      deniedPaths: ["src/api/**"],
      maxChangedFiles: 25,
      approvalCheckpoints: ["after-plan"],
      baseDriftPolicy: "replan",
      landStrategy: "stack",
    });
    expect(dependent).toMatchObject({
      objective: "Move the feature onto the new service seam.",
      invariants: ["Existing callers keep working"],
      handoffRequirements: ["Document the new ownership boundary"],
      blockedBy: [blocker.id],
      expectedPaths: ["src/services/feature.ts"],
      allowedPaths: ["src/services/**", "test/services/**"],
      deniedPaths: ["src/api/**", "test/api/**"],
      maxChangedFiles: 20,
      verifyCommands: ["bun test test/services"],
      approvalCheckpoints: ["after-plan", "before-integrate"],
      baseDriftPolicy: "rebase",
      landStrategy: "stack",
      currentPhase: "blocked",
      deliveryStatus: "not_started",
    });
    expect(store.listTaskDependents(blocker.id).map((task) => task.id)).toEqual([dependent.id]);

    const foreignQueue = store.createQueue({
      name: "foreign",
      repoKey: "other-repo",
      repoPath: "/other",
    });
    try {
      store.addTask({
        queue: foreignQueue.id,
        title: "Invalid cross-repository dependency",
        blockedBy: [blocker.id],
      });
      throw new Error("Expected cross-repository dependency to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentQError);
      expect((error as AgentQError).code).toBe("TASK_DEPENDENCY_REPOSITORY_MISMATCH");
    }

    try {
      store.editTask(blocker.id, { blockedBy: [dependent.id] }, blocker.updatedAt);
      throw new Error("Expected a dependency cycle to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentQError);
      expect((error as AgentQError).code).toBe("TASK_DEPENDENCY_CYCLE");
    }
    expect(store.getTask(blocker.id)?.blockedBy).toEqual([]);
    try {
      store.deleteTask(blocker.id);
      throw new Error("Expected blocker deletion to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentQError);
      expect((error as AgentQError).code).toBe("TASK_HAS_DEPENDENTS");
    }

    expect(store.deleteTask(dependent.id)).toBe(true);
    expect(store.deleteTask(blocker.id)).toBe(true);
  });

  test("blocks claims without spending attempts and snapshots the blocker result commit", () => {
    const store = open();
    const queue = store.createQueue({
      name: "dependency-scheduler",
      repoKey: "repo",
      repoPath: "/repo",
      concurrency: 2,
      landStrategy: "stack",
    });
    const blocker = store.addTask({ queue: queue.id, title: "Build foundation", priority: 1 });
    const dependent = store.addTask({
      queue: queue.id,
      title: "Build on foundation",
      priority: 100,
      blockedBy: [blocker.id],
      landStrategy: "stack",
    });

    const blockerClaim = store.claimNextTask({ queue: queue.id });
    expect(blockerClaim?.task.id).toBe(blocker.id);
    expect(store.claimNextTask({ queue: queue.id })).toBeUndefined();
    expect(store.getTask(dependent.id)).toMatchObject({
      status: "queued",
      currentPhase: "blocked",
      attemptCount: 0,
    });
    if (!blockerClaim) throw new Error("Expected blocker claim");

    const finished = store.finishRun(blockerClaim.run.id, {
      status: "succeeded",
      exitCode: 0,
      resultCommitSha: "0123456789abcdef",
      changedFiles: ["src/foundation.ts"],
      verificationResults: [
        {
          kind: "command",
          command: "bun test",
          status: "passed",
          exitCode: 0,
          startedAt: "2026-07-24T12:00:00.000Z",
          finishedAt: "2026-07-24T12:00:01.000Z",
        },
      ],
    });
    expect(finished.task).toMatchObject({
      status: "succeeded",
      deliveryStatus: "ready_to_integrate",
      resultCommitSha: "0123456789abcdef",
      changedFiles: ["src/foundation.ts"],
    });

    const dependentClaim = store.claimNextTask({ queue: queue.id });
    expect(dependentClaim?.task.id).toBe(dependent.id);
    expect(dependentClaim?.run).toMatchObject({
      baseSha: "0123456789abcdef",
      dependencySnapshot: [
        {
          taskId: blocker.id,
          runId: blockerClaim.run.id,
          resultCommitSha: "0123456789abcdef",
        },
      ],
    });
  });

  test("edits only operator-owned task fields and appends one atomic audit event", () => {
    const store = open();
    const queue = store.createQueue({ name: "edit", repoKey: "repo", repoPath: "/repo" });
    const task = store.addTask({ queue: queue.id, title: "Before", instructions: "Old" });

    const edited = store.editTask(
      task.id,
      {
        title: "After",
        instructions: "New instructions",
        acceptanceCriteria: ["Tests pass", "Behavior documented"],
        provider: "claude",
        priority: 9,
      },
      task.updatedAt,
    );

    expect(edited).toMatchObject({
      title: "After",
      instructions: "New instructions",
      acceptanceCriteria: ["Tests pass", "Behavior documented"],
      provider: "claude",
      priority: 9,
      status: "queued",
    });
    expect(edited.updatedAt).not.toBe(task.updatedAt);
    expect(store.listEvents({ taskId: task.id })).toEqual([
      expect.objectContaining({
        taskId: task.id,
        kind: "task.edited",
        payload: expect.objectContaining({
          fields: ["title", "instructions", "acceptanceCriteria", "provider", "priority"],
        }),
      }),
    ]);
  });

  test("rejects stale, active, and succeeded task edits without partial changes or events", () => {
    const store = open();
    const queue = store.createQueue({ name: "edit-guards", repoKey: "repo", repoPath: "/repo" });
    const task = store.addTask({ queue: queue.id, title: "Original" });
    const firstEdit = store.editTask(task.id, { title: "Fresh" }, task.updatedAt);

    try {
      store.editTask(task.id, { title: "Stale" }, task.updatedAt);
      throw new Error("Expected stale task edit to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentQError);
      expect((error as AgentQError).code).toBe("TASK_EDIT_CONFLICT");
    }
    expect(store.getTask(task.id)?.title).toBe("Fresh");
    expect(store.listEvents({ taskId: task.id })).toHaveLength(1);
    store.completeTaskManually(task.id, "Done testing stale edits");

    const active = store.addTask({ queue: queue.id, title: "Active" });
    expect(store.claimNextTask({ queue: queue.id })?.task.id).toBe(active.id);
    for (const blockedStatus of ["starting", "running", "cancelling", "succeeded"] as const) {
      store.updateTask(active.id, { status: blockedStatus });
      try {
        store.editTask(active.id, { title: `Changed while ${blockedStatus}` });
        throw new Error(`Expected ${blockedStatus} task edit to fail`);
      } catch (error) {
        expect(error).toBeInstanceOf(AgentQError);
        expect((error as AgentQError).code).toBe("TASK_NOT_EDITABLE");
      }
    }
    expect(store.getTask(active.id)?.title).toBe("Active");
    expect(store.listEvents({ taskId: active.id })).toEqual([]);
    expect(firstEdit.title).toBe("Fresh");
  });

  test("allows edits in every retryable non-active status", () => {
    const store = open();
    const queue = store.createQueue({ name: "editable", repoKey: "repo", repoPath: "/repo" });

    for (const status of ["queued", "failed", "interrupted", "cancelled"] as const) {
      const task = store.addTask({ queue: queue.id, title: `${status} before` });
      if (status !== "queued") store.updateTask(task.id, { status });
      const current = store.getTask(task.id);
      if (!current) throw new Error("Expected task");
      expect(
        store.editTask(task.id, { title: `${status} after` }, current.updatedAt),
      ).toMatchObject({
        title: `${status} after`,
        status,
      });
    }
  });

  test("snapshots each claimed task specification independently of later edits", () => {
    const store = open();
    const queue = store.createQueue({
      name: "snapshots",
      repoKey: "repo",
      repoPath: "/repo",
      maxAttempts: 1,
      planModel: "planner-v1",
      planInstructions: "Inspect dependencies first.",
      implementModel: "builder-v1",
      implementInstructions: "Run focused checks.",
    });
    const task = store.addTask({
      queue: queue.id,
      title: "Original title",
      instructions: "Original instructions",
      acceptanceCriteria: ["Original criterion"],
      provider: "codex",
      priority: 2,
    });
    const first = store.claimNextTask({ queue: queue.id });
    if (!first) throw new Error("Expected first claim");
    const structuredSnapshot = {
      objective: "Original title",
      invariants: [],
      handoffRequirements: [],
      blockedBy: [],
      expectedPaths: [],
      allowedPaths: [],
      deniedPaths: [],
      verifyCommands: [],
      approvalCheckpoints: [],
      baseDriftPolicy: "replan" as const,
      landStrategy: "none" as const,
      dependencies: [],
    };
    expect(first.run.taskSnapshot).toEqual({
      title: "Original title",
      instructions: "Original instructions",
      acceptanceCriteria: ["Original criterion"],
      provider: "codex",
      priority: 2,
      ...structuredSnapshot,
      workflow: {
        planModel: "planner-v1",
        planInstructions: "Inspect dependencies first.",
        implementModel: "builder-v1",
        implementInstructions: "Run focused checks.",
      },
    });
    store.finishRun(first.run.id, { status: "failed", error: "Needs revision" });

    const failed = store.getTask(task.id);
    if (!failed) throw new Error("Expected failed task");
    store.editTask(
      task.id,
      {
        title: "Revised title",
        instructions: "Revised instructions",
        acceptanceCriteria: ["Revised criterion"],
        provider: "claude",
        priority: 8,
      },
      failed.updatedAt,
    );
    expect(store.getRun(first.run.id)?.taskSnapshot).toEqual(first.run.taskSnapshot);

    store.requeueTask(task.id);
    const second = store.claimNextTask({ queue: queue.id });
    if (!second) throw new Error("Expected second claim");
    expect(second.run.taskSnapshot).toEqual({
      title: "Revised title",
      instructions: "Revised instructions",
      acceptanceCriteria: ["Revised criterion"],
      provider: "claude",
      priority: 8,
      ...structuredSnapshot,
      workflow: {
        planModel: "",
        planInstructions: "Inspect dependencies first.",
        implementModel: "",
        implementInstructions: "Run focused checks.",
      },
    });
    expect(store.getRun(first.run.id)?.taskSnapshot).toEqual({
      title: "Original title",
      instructions: "Original instructions",
      acceptanceCriteria: ["Original criterion"],
      provider: "codex",
      priority: 2,
      ...structuredSnapshot,
      workflow: {
        planModel: "planner-v1",
        planInstructions: "Inspect dependencies first.",
        implementModel: "builder-v1",
        implementInstructions: "Run focused checks.",
      },
    });
  });

  test("durably advances one active run from planning to implementation", () => {
    const store = open();
    const queue = store.createQueue({
      name: "pipeline",
      repoKey: "repo",
      repoPath: "/repo",
      planModel: "planner",
      implementModel: "builder",
    });
    const task = store.addTask({ queue: queue.id, title: "Pipeline task" });
    const claim = store.claimNextTask({
      queue: queue.id,
      ownerToken: "pipeline-owner",
      ownerPid: process.pid,
    });
    if (!claim) throw new Error("Expected pipeline claim");
    expect(claim.run.phase).toBe("plan");

    store.markRunRunning(
      claim.run.id,
      {
        planSessionId: "plan-session",
        pid: 123,
        processToken: "plan-token",
        processStartMarker: "plan-start",
        processIdentityPath: "/tmp/plan-identity",
      },
      claim.leaseToken,
    );
    const advanced = store.advanceRunToImplementation(
      claim.run.id,
      {
        planOutput: "Edit src/pipeline.ts and add a focused regression test.",
        planSessionId: "plan-session",
      },
      claim.leaseToken,
    );

    expect(advanced).toMatchObject({
      phase: "implement",
      planOutput: "Edit src/pipeline.ts and add a focused regression test.",
      planSessionId: "plan-session",
      status: "running",
    });
    expect(advanced.pid).toBeUndefined();
    expect(advanced.processToken).toBeUndefined();
    expect(store.getTask(task.id)?.status).toBe("running");
    expect(() =>
      store.advanceRunToImplementation(
        claim.run.id,
        { planOutput: "second plan" },
        claim.leaseToken,
      ),
    ).toThrow(AgentQError);
  });

  test("restores the saved pipeline phase and handoff for an explicit implementation resume", () => {
    const store = open();
    const queue = store.createQueue({
      name: "implementation-resume",
      repoKey: "repo",
      repoPath: "/repo",
      planModel: "planner-v1",
      implementModel: "builder-v1",
    });
    const task = store.addTask({ queue: queue.id, title: "Resume implementation" });
    const first = store.claimNextTask({
      queue: queue.id,
      ownerToken: "first-owner",
      now: "2026-07-22T12:02:00Z",
    });
    if (!first) throw new Error("Expected first claim");
    store.markRunRunning(
      first.run.id,
      {
        planSessionId: "plan-session",
        baseSha: "abc123",
        branchName: "agentq/resume/task-a1",
        worktreePath: "/tmp/resume-worktree",
      },
      first.leaseToken,
    );
    store.advanceRunToImplementation(
      first.run.id,
      { planOutput: "Edit src/resume.ts and run its focused test." },
      first.leaseToken,
    );
    store.finishRun(
      first.run.id,
      { status: "failed", error: "Implementation did not start" },
      first.leaseToken,
    );

    store.requeueTask(task.id, undefined, first.run.id);
    const resumed = store.claimNextTask({
      queue: queue.id,
      ownerToken: "second-owner",
      now: "2026-07-22T12:01:00Z",
    });
    if (!resumed) throw new Error("Expected resumed claim");
    expect(resumed.run).toMatchObject({
      phase: "implement",
      planOutput: "Edit src/resume.ts and run its focused test.",
      planSessionId: "plan-session",
      taskSnapshot: {
        workflow: { planModel: "planner-v1", implementModel: "builder-v1" },
      },
    });
    expect(resumed.run.providerSessionId).toBeUndefined();
    expect(store.listRuns({ taskId: task.id }).map((run) => run.id)).toEqual([
      resumed.run.id,
      first.run.id,
    ]);
  });

  test("discards an invalid legacy resume intent and starts a fresh planning claim", () => {
    const store = open();
    const queue = store.createQueue({
      name: "legacy-resume",
      repoKey: "repo",
      repoPath: "/repo",
      planModel: "new-planner",
    });
    const task = store.addTask({ queue: queue.id, title: "Upgrade legacy resume" });
    const first = store.claimNextTask({ queue: queue.id });
    if (!first) throw new Error("Expected first claim");
    store.markRunRunning(first.run.id, {
      planSessionId: "legacy-session",
      baseSha: "abc123",
      branchName: "agentq/legacy/task-a1",
      worktreePath: "/tmp/legacy-worktree",
    });
    store.finishRun(first.run.id, { status: "failed", error: "legacy failure" });
    store.requeueTask(task.id, undefined, first.run.id);

    const raw = new Database(databasePath);
    raw
      .query("UPDATE runs SET phase = 'implement', plan_output = NULL WHERE id = ?")
      .run(first.run.id);
    raw.close();

    const fresh = store.claimNextTask({ queue: queue.id });
    if (!fresh) throw new Error("Expected fresh claim");
    expect(fresh.task.resumeRunId).toBeUndefined();
    expect(fresh.run).toMatchObject({
      phase: "plan",
      taskSnapshot: { workflow: { planModel: "new-planner" } },
    });
    expect(fresh.run.planOutput).toBeUndefined();
    expect(fresh.run.planSessionId).toBeUndefined();
  });

  test("enforces delegated child limits atomically after idempotency lookup", () => {
    const first = open();
    const second = open();
    const queue = first.createQueue({
      name: "delegation-limit",
      repoKey: "repo",
      repoPath: "/repo",
    });
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
      repoKey: "serial-repo",
      repoPath: "/repo/serial",
      concurrency: 1,
      maxAttempts: 2,
    });
    const parallel = first.createQueue({
      name: "parallel",
      repoKey: "parallel-repo",
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
      repoKey: "repo",
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
    const queue = first.createQueue({ name: "manual-race", repoKey: "repo", repoPath: "/repo" });
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
    const queue = store.createQueue({ name: "run-race", repoKey: "repo", repoPath: "/repo" });
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
    const queue = store.createQueue({
      name: "processes",
      repoKey: "repo",
      repoPath: "/repo",
      concurrency: 1,
    });
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
    const queue = store.createQueue({ name: "cancel", repoKey: "repo", repoPath: "/repo" });
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
    expect(() =>
      store.advanceRunToImplementation(
        claim.run.id,
        { planOutput: "This plan must not be implemented after cancellation." },
        claim.leaseToken,
      ),
    ).toThrow("being cancelled");
    expect(store.getRun(claim.run.id)?.phase).toBe("plan");
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
    const queue = store.createQueue({
      name: "leases",
      repoKey: "repo",
      repoPath: "/repo",
      maxAttempts: 1,
    });
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
    const queue = store.createQueue({ name: "resume-intent", repoKey: "repo", repoPath: "/repo" });
    const task = store.addTask({ queue: queue.id, title: "resume me", provider: "codex" });
    const first = store.claimNextTask({ queue: queue.id });
    if (!first) throw new Error("Expected initial claim");
    store.markRunRunning(first.run.id, {
      planSessionId: "session-1",
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

    store.markRunRunning(
      resumed.run.id,
      {
        planSessionId: "session-2",
        worktreePath: "/tmp/worktree-2",
        branchName: "agentq/resume/task-a2",
        baseSha: "def456",
      },
      resumed.leaseToken,
    );
    expect(
      store.consumeResumeIntent(task.id, resumed.run.id, first.run.id, resumed.leaseToken)
        .resumeRunId,
    ).toBeUndefined();

    store.finishRun(
      resumed.run.id,
      { status: "failed", error: "switch providers" },
      resumed.leaseToken,
    );
    const queuedAgain = store.requeueTask(task.id, undefined, resumed.run.id);
    expect(queuedAgain.resumeRunId).toBe(resumed.run.id);
    const changedProvider = store.editTask(task.id, { provider: "claude" }, queuedAgain.updatedAt);
    expect(changedProvider.resumeRunId).toBeUndefined();
    expect(() => store.requeueTask(task.id, undefined, first.run.id)).toThrow("cannot be resumed");
  });

  test("rechecks the heartbeat while atomically fencing eligible stale runs", () => {
    const store = open();
    const queue = store.createQueue({ name: "recovery-fence", repoKey: "repo", repoPath: "/repo" });
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
    const queue = store.createQueue({
      name: "two-phase-recovery",
      repoKey: "repo",
      repoPath: "/repo",
    });
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
    for (const patch of [
      { planSessionId: "stale-plan-session" },
      { providerSessionId: "stale-implementation-session" },
    ]) {
      expect(() => store.updateRun(claim.run.id, patch, "expired-owner")).toThrow(AgentQError);
    }
    expect(store.getRun(claim.run.id)?.planSessionId).toBeUndefined();
    expect(store.getRun(claim.run.id)?.providerSessionId).toBeUndefined();

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
      repoKey: "repo",
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
    const queue = store.createQueue({ name: "events", repoKey: "repo", repoPath: "/repo" });
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

  test("returns the newest limited event window while cursors continue forward", () => {
    const store = open();
    const queue = store.createQueue({ name: "event-window", repoKey: "repo", repoPath: "/repo" });
    const task = store.addTask({ queue: queue.id, title: "stream a long run" });
    const events = Array.from({ length: 5 }, (_, index) =>
      store.appendEvent({
        taskId: task.id,
        kind: "assistant",
        payload: { text: `event ${index + 1}` },
      }),
    );

    expect(store.listEvents({ taskId: task.id, limit: 2 })).toEqual(events.slice(-2));
    expect(store.listEvents({ taskId: task.id, afterId: events[0]?.id, limit: 2 })).toEqual(
      events.slice(1, 3),
    );
  });

  test("enables foreign keys on every store connection", () => {
    const store = open();
    const queue = store.createQueue({ name: "foreign-keys", repoKey: "repo", repoPath: "/repo" });
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
