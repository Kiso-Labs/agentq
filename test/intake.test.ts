import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentQApp } from "../src/app.ts";
import type { AgentQPaths } from "../src/core/types.ts";
import { runCommand } from "../src/git/command.ts";
import { DelegatedTaskIntake, submitDelegatedTask } from "../src/intake/delegated-tasks.ts";
import { afterEach, describe, expect, test } from "./support/test.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "agentq-intake-"));
  roots.push(root);
  const stateDir = join(root, "state");
  const paths: AgentQPaths = {
    stateDir,
    databasePath: join(stateDir, "agentq.sqlite"),
    logsDir: join(stateDir, "logs"),
    worktreesDir: join(stateDir, "worktrees"),
    locksDir: join(stateDir, "locks"),
  };
  const app = await AgentQApp.create(paths);
  const repoPath = join(root, "repo");
  await mkdir(repoPath, { recursive: true });
  await git(repoPath, "init", "--initial-branch=main");
  await writeFile(join(repoPath, "README.md"), "# Intake fixture\n");
  await git(repoPath, "add", "--all");
  await git(
    repoPath,
    "-c",
    "user.name=AgentQ Intake Tests",
    "-c",
    "user.email=agentq-intake@example.invalid",
    "commit",
    "-m",
    "Initial fixture",
  );
  const queue = await app.createQueue({ name: "intake", repoPath, baseRef: "main" });
  const parent = app.store.addTask({ queue: queue.id, title: "Parent" });
  return { app, parent, queue, stateDir };
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  const result = await runCommand("git", args, { cwd });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args[0]} failed`);
  }
}

async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for intake state");
    await Bun.sleep(10);
  }
}

async function exists(path: string): Promise<boolean> {
  return Boolean(await lstat(path).catch(() => undefined));
}

describe.skipIf(process.platform === "win32")("DelegatedTaskIntake", () => {
  test("uses one deterministic request for equivalent submissions in a managed run", async () => {
    const { app, parent, queue, stateDir } = await setup();
    const intake = new DelegatedTaskIntake(app);
    const runId = "run_deterministic";
    const directory = await intake.register(runId, queue.id, parent.id);
    const env = {
      AGENTQ_AGENT_CONTEXT: "1",
      AGENTQ_INTAKE_DIR: directory,
      AGENTQ_RUN_ID: runId,
    };
    const input = {
      queue: "ignored-by-managed-intake",
      title: "  Equivalent child  ",
      instructions: "Do the same work",
      acceptanceCriteria: ["It works"],
    };

    const first = submitDelegatedTask(input, { env, timeoutMs: 2_000 });
    const second = submitDelegatedTask({ ...input }, { env, timeoutMs: 2_000 });
    await waitUntil(async () =>
      (await readdir(directory)).some((entry) => /^request-[a-f0-9]{32}\.json$/.test(entry)),
    );
    expect(
      (await readdir(directory)).filter((entry) => /^request-[a-f0-9]{32}\.json$/.test(entry)),
    ).toHaveLength(1);

    await intake.drain();
    const [firstTask, secondTask] = await Promise.all([first, second]);
    expect(secondTask.id).toBe(firstTask.id);
    expect(firstTask.title).toBe("Equivalent child");
    expect(
      app.store
        .listTasks({ queue: queue.id })
        .filter((candidate) => candidate.parentTaskId === parent.id),
    ).toHaveLength(1);

    const replayed = await submitDelegatedTask({ ...input }, { env, timeoutMs: 200 });
    expect(replayed.id).toBe(firstTask.id);
    await intake.cleanup(runId);
    expect(await exists(join(stateDir, "intake", runId))).toBe(false);
    app.close();
  });

  test("replays deterministic stages after a crash and retains them until response delivery", async () => {
    const { app, parent, queue, stateDir } = await setup();
    const intake = new DelegatedTaskIntake(app);
    const runId = "run_replay";
    const directory = await intake.register(runId, queue.id, parent.id);
    const id = "a".repeat(32);
    const responsePath = join(directory, `response-${id}.json`);
    await writeFile(
      join(directory, `request-${id}.json`),
      JSON.stringify({ version: 1, id, task: { title: "Crash durable child" } }),
    );
    await mkdir(responsePath);

    await intake.drain();
    const firstChild = app.store
      .listTasks({ queue: queue.id })
      .find((candidate) => candidate.parentTaskId === parent.id);
    expect(firstChild?.title).toBe("Crash durable child");
    const [runStagingDirectory] = (await readdir(join(stateDir, "intake-staging"))).filter(
      (entry) => entry.startsWith("run-"),
    );
    if (!runStagingDirectory) throw new Error("Expected a durable run staging directory");
    const stagedPath = join(stateDir, "intake-staging", runStagingDirectory, `request-${id}.json`);
    expect(await Bun.file(stagedPath).exists()).toBe(true);

    await intake.cleanup(runId);
    expect(await Bun.file(stagedPath).exists()).toBe(true);
    expect(await exists(directory)).toBe(true);

    await rm(responsePath, { recursive: true, force: true });
    const recovered = new DelegatedTaskIntake(app);
    await recovered.drain();
    const response = JSON.parse(await readFile(responsePath, "utf8")) as {
      ok: boolean;
      task: { id: string };
    };
    expect(response).toMatchObject({ ok: true, task: { id: firstChild?.id } });
    expect(await Bun.file(stagedPath).exists()).toBe(false);
    await recovered.drain();
    expect(
      app.store
        .listTasks({ queue: queue.id })
        .filter((candidate) => candidate.parentTaskId === parent.id),
    ).toHaveLength(1);

    await recovered.cleanup(runId);
    expect(await exists(directory)).toBe(false);
    app.close();
  });

  test("budgets valid requests instead of junk and leaves unknown entries untouched", async () => {
    const { app, parent, queue } = await setup();
    const intake = new DelegatedTaskIntake(app);
    const runId = "run_junk";
    const directory = await intake.register(runId, queue.id, parent.id);
    for (let index = 0; index < 600; index += 1) {
      await writeFile(join(directory, `unknown-${String(index).padStart(4, "0")}`), "junk");
    }
    const id = "b".repeat(32);
    await writeFile(
      join(directory, `request-${id}.json`),
      JSON.stringify({ version: 1, id, task: { title: "Not starved" } }),
    );

    await intake.drain();
    expect(
      JSON.parse(await readFile(join(directory, `response-${id}.json`), "utf8")),
    ).toMatchObject({ ok: true, task: { title: "Not starved" } });
    expect(await Bun.file(join(directory, "unknown-0000")).exists()).toBe(true);

    await intake.cleanup(runId);
    expect(await Bun.file(join(directory, "unknown-0000")).exists()).toBe(true);
    app.close();
  });

  test("serializes cleanup with concurrent supervisor drains", async () => {
    const { app, parent, queue } = await setup();
    const intake = new DelegatedTaskIntake(app);
    const runId = "run_cleanup_race";
    const directory = await intake.register(runId, queue.id, parent.id);
    for (let index = 0; index < 256; index += 1) {
      await writeFile(
        join(directory, `response-${index.toString(16).padStart(32, "0")}.json`),
        "{}",
      );
    }

    await expect(
      Promise.all([intake.drain(), intake.cleanup(runId), intake.drain()]),
    ).resolves.toHaveLength(3);
    expect(await exists(directory)).toBe(false);
    app.close();
  });
});
