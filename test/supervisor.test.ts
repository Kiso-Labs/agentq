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

const planningPromptMarker = "You are the planning agent for an agentq task";

function codexPlanningGate(
  plan = "Inspect the relevant repository files, identify the exact edits, and run focused verification.",
): string {
  return `
    const agentqPrompt = await Bun.stdin.text();
    if (agentqPrompt.includes(${JSON.stringify(planningPromptMarker)})) {
      console.log(JSON.stringify({type:"thread.started",thread_id:"codex-plan-session"}));
      console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:${JSON.stringify(plan)}}}));
      console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:5,output_tokens:5}}));
      process.exit(0);
    }
  `;
}

function claudePlanningGate(
  plan = "Inspect the relevant repository files, identify the exact edits, and run focused verification.",
): string {
  return `
    const agentqPrompt = await Bun.stdin.text();
    if (agentqPrompt.includes(${JSON.stringify(planningPromptMarker)})) {
      console.log(JSON.stringify({type:"system",subtype:"init",session_id:"claude-plan-session"}));
      console.log(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:${JSON.stringify(plan)}}]}}));
      console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,session_id:"claude-plan-session",result:${JSON.stringify(plan)},usage:{input_tokens:5,output_tokens:5}}));
      process.exit(0);
    }
  `;
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

  test("hands a persisted repository plan to a fresh implementation agent", async () => {
    const { root, repo, app } = await setup();
    const codex = join(root, "codex");
    const capture = join(root, "pipeline.jsonl");
    const plan =
      "Update src/session.ts at the redirect guard and add the expired-session regression test.";
    await executable(
      codex,
      `
      import { appendFileSync } from "node:fs";
      const args = process.argv.slice(2);
      const input = await Bun.stdin.text();
      appendFileSync(${JSON.stringify(capture)}, JSON.stringify({
        args,
        input,
        stage: process.env.AGENTQ_STAGE,
        intake: process.env.AGENTQ_INTAKE_DIR,
      }) + "\\n");
      const planning = input.includes("You are the planning agent");
      if (planning) {
        console.log(JSON.stringify({type:"thread.started",thread_id:"plan-session"}));
        console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:${JSON.stringify(plan)}}}));
        console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:10,output_tokens:4}}));
      } else {
        if (!input.includes(${JSON.stringify(plan)})) {
          console.error("planner handoff missing");
          process.exit(9);
        }
        await Bun.write("implemented.txt", "implemented");
        console.log(JSON.stringify({type:"thread.started",thread_id:"implementation-session"}));
        console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"Implemented the handoff"}}));
        console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:20,output_tokens:8}}));
      }
      `,
    );
    process.env.AGENTQ_CODEX_BIN = codex;
    const queue = await app.createQueue({
      name: "pipeline",
      repoPath: repo,
      maxAttempts: 1,
      planModel: "planner-model",
      planInstructions: "Identify exact files and symbols before handing off.",
      implementModel: "builder-model",
      implementInstructions: "Follow the handoff and keep APIs stable.",
      verifyCommands: ["test -f implemented.txt"],
    });
    const task = await app.addTask({ queue: queue.id, title: "Fix redirects" });

    await new Supervisor(app, { pollIntervalMs: 20 }).run({ once: true });

    expect(app.store.getTask(task.id)?.status).toBe("succeeded");
    const run = app.store.listRuns({ taskId: task.id })[0];
    expect(run).toMatchObject({
      phase: "implement",
      planOutput: plan,
      planSessionId: "plan-session",
      providerSessionId: "implementation-session",
      changedFiles: ["implemented.txt"],
      inputTokens: 30,
      outputTokens: 12,
    });
    expect(run?.taskSnapshot?.workflow).toEqual({
      planModel: "planner-model",
      planInstructions: "Identify exact files and symbols before handing off.",
      implementModel: "builder-model",
      implementInstructions: "Follow the handoff and keep APIs stable.",
      allowedPaths: [],
      deniedPaths: [],
      verifyCommands: ["test -f implemented.txt"],
      approvalCheckpoints: [],
      baseDriftPolicy: "replan",
      landStrategy: "none",
      autoLand: false,
      fileConcurrency: "off",
    });
    expect(app.store.getTask(task.id)).toMatchObject({
      deliveryStatus: "verified",
      changedFiles: ["implemented.txt"],
      inputTokens: 30,
      outputTokens: 12,
    });
    const invocations = (await readFile(capture, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as { args: string[]; input: string; stage?: string; intake?: string },
      );
    expect(invocations).toHaveLength(2);
    expect(invocations[0]?.args).toContain("read-only");
    expect(invocations[0]?.args).toContain("planner-model");
    expect(invocations[0]?.args).not.toContain("--add-dir");
    expect(invocations[0]).toMatchObject({ stage: "plan" });
    expect(invocations[0]?.intake).toBeUndefined();
    expect(invocations[0]?.input).toContain("Identify exact files and symbols before handing off.");
    expect(invocations[1]?.args).toContain("workspace-write");
    expect(invocations[1]?.args).toContain("builder-model");
    expect(invocations[1]).toMatchObject({ stage: "implement" });
    expect(invocations[1]?.intake).toContain("intake");
    expect(invocations[1]?.input).toContain(plan);
    expect(invocations[1]?.input).toContain("Follow the handoff and keep APIs stable.");
    expect(
      app.store.listEvents({ taskId: task.id }).filter((event) => event.kind === "workflow.phase"),
    ).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ phase: "plan", state: "started" }),
      }),
      expect.objectContaining({
        payload: expect.objectContaining({ phase: "plan", state: "completed" }),
      }),
      expect.objectContaining({
        payload: expect.objectContaining({ phase: "implement", state: "started" }),
      }),
      expect.objectContaining({
        payload: expect.objectContaining({ phase: "implement", state: "completed" }),
      }),
    ]);
    app.close();
  });

  test("fails closed when the planning agent returns an empty handoff", async () => {
    const { root, repo, app } = await setup();
    const codex = join(root, "codex");
    await executable(
      codex,
      `
      const input = await Bun.stdin.text();
      if (input.includes(${JSON.stringify(planningPromptMarker)})) {
        console.log(JSON.stringify({type:"thread.started",thread_id:"empty-plan-session"}));
        console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:2,output_tokens:0}}));
      } else {
        await Bun.write("implementation-ran.txt", "unexpected");
        console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:1}}));
      }
      `,
    );
    process.env.AGENTQ_CODEX_BIN = codex;
    const queue = await app.createQueue({ name: "empty-plan", repoPath: repo, maxAttempts: 1 });
    const task = await app.addTask({ queue: queue.id, title: "Require a real plan" });

    await new Supervisor(app, { pollIntervalMs: 20 }).run({ once: true });

    expect(app.store.getTask(task.id)?.status).toBe("failed");
    const run = app.store.listRuns({ taskId: task.id })[0];
    expect(run).toMatchObject({
      status: "failed",
      phase: "plan",
      planSessionId: "empty-plan-session",
    });
    expect(run?.planOutput).toBeUndefined();
    expect(run?.providerSessionId).toBeUndefined();
    expect(run?.error).toContain("without a usable implementation handoff");
    expect(
      await Bun.file(join(run?.worktreePath ?? repo, "implementation-ran.txt")).exists(),
    ).toBeFalse();
    expect(
      app.store
        .listEvents({ taskId: task.id })
        .some(
          (event) =>
            event.kind === "workflow.phase" &&
            event.payload.phase === "implement" &&
            event.payload.state === "started",
        ),
    ).toBeFalse();
    app.close();
  });

  test("rejects a planner handoff when the planning agent modifies the worktree", async () => {
    const { root, repo, app } = await setup();
    const codex = join(root, "codex");
    await executable(
      codex,
      `
      const input = await Bun.stdin.text();
      if (input.includes(${JSON.stringify(planningPromptMarker)})) {
        await Bun.write("planner-leak.txt", "planner changed the repository");
        console.log(JSON.stringify({type:"thread.started",thread_id:"dirty-plan-session"}));
        console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"Edit README.md and verify the result."}}));
        console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:3,output_tokens:3}}));
      } else {
        await Bun.write("implementation-ran.txt", "unexpected");
        console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:1}}));
      }
      `,
    );
    process.env.AGENTQ_CODEX_BIN = codex;
    const queue = await app.createQueue({ name: "dirty-plan", repoPath: repo, maxAttempts: 1 });
    const task = await app.addTask({ queue: queue.id, title: "Keep planning read-only" });

    await new Supervisor(app, { pollIntervalMs: 20 }).run({ once: true });

    expect(app.store.getTask(task.id)?.status).toBe("failed");
    const run = app.store.listRuns({ taskId: task.id })[0];
    expect(run).toMatchObject({
      status: "failed",
      phase: "plan",
      planSessionId: "dirty-plan-session",
    });
    expect(run?.planOutput).toBeUndefined();
    expect(run?.providerSessionId).toBeUndefined();
    expect(run?.error).toContain("Planning agent modified the worktree");
    expect(await Bun.file(join(run?.worktreePath ?? repo, "planner-leak.txt")).exists()).toBeTrue();
    expect(
      await Bun.file(join(run?.worktreePath ?? repo, "implementation-ran.txt")).exists(),
    ).toBeFalse();
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
      ${provider === "codex" ? codexPlanningGate() : claudePlanningGate()}
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
    const capture = join(root, "implementation-resume.jsonl");
    const plan = "Reuse the retained implementation worktree and finish the requested task.";
    await executable(
      codex,
      `
      import { appendFileSync } from "node:fs";
      const args = process.argv.slice(2);
      const input = await Bun.stdin.text();
      appendFileSync(${JSON.stringify(capture)}, JSON.stringify({args,input}) + "\\n");
      if (input.includes(${JSON.stringify(planningPromptMarker)})) {
        console.log(JSON.stringify({type:"thread.started",thread_id:"codex-plan-session"}));
        console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:${JSON.stringify(plan)}}}));
        console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:5,output_tokens:5}}));
        process.exit(0);
      }
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
    expect(secondRun?.phase).toBe("implement");
    expect(secondRun?.planOutput).toBe(plan);
    expect(secondRun?.worktreePath).toBe(originalRun?.worktreePath);
    expect(await readFile(join(secondRun?.worktreePath ?? "", "resumed.txt"), "utf8")).toBe("yes");
    const invocations = (await readFile(capture, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { args: string[]; input: string });
    expect(invocations).toHaveLength(3);
    expect(invocations.filter(({ input }) => input.includes(planningPromptMarker))).toHaveLength(1);
    expect(invocations[1]?.args).not.toContain("resume");
    expect(invocations[2]?.args).toContain("resume");
    expect(invocations[2]?.args).toContain("codex-session");
    app.close();
  });

  test("resumes a failed planning session before starting a fresh implementation agent", async () => {
    const { root, repo, app } = await setup();
    const codex = join(root, "codex");
    const capture = join(root, "planning-resume.jsonl");
    const plan = "Edit README.md in the retained worktree, then verify its new contents.";
    await executable(
      codex,
      `
      import { appendFileSync } from "node:fs";
      const args = process.argv.slice(2);
      const input = await Bun.stdin.text();
      appendFileSync(${JSON.stringify(capture)}, JSON.stringify({args,input}) + "\\n");
      if (input.includes(${JSON.stringify(planningPromptMarker)})) {
        console.log(JSON.stringify({type:"thread.started",thread_id:"retryable-plan-session"}));
        if (!args.includes("resume")) {
          console.log(JSON.stringify({type:"turn.failed",error:{message:"planner needs another turn"}}));
          process.exit(0);
        }
        console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:${JSON.stringify(plan)}}}));
        console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:5,output_tokens:5}}));
        process.exit(0);
      }
      if (args.includes("resume")) {
        console.error("implementation must start in a fresh provider session");
        process.exit(8);
      }
      await Bun.write("planned-implementation.txt", "implemented");
      console.log(JSON.stringify({type:"thread.started",thread_id:"fresh-implementation-session"}));
      console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"Implemented resumed plan"}}));
      console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:5,output_tokens:5}}));
      `,
    );
    process.env.AGENTQ_CODEX_BIN = codex;
    const queue = await app.createQueue({
      name: "plan-resume",
      repoPath: repo,
      maxAttempts: 1,
      verifyCommands: ["test -f planned-implementation.txt"],
    });
    const task = await app.addTask({ queue: queue.id, title: "Resume planning" });

    await new Supervisor(app, { pollIntervalMs: 20 }).run({ once: true });
    const failedPlan = app.store.listRuns({ taskId: task.id })[0];
    expect(failedPlan).toMatchObject({
      status: "failed",
      phase: "plan",
      planSessionId: "retryable-plan-session",
    });
    expect(failedPlan?.providerSessionId).toBeUndefined();

    await app.resumeTask(task.id);
    await new Supervisor(app, { pollIntervalMs: 20 }).run({ once: true });

    const [completed, original] = app.store.listRuns({ taskId: task.id });
    expect(completed).toMatchObject({
      status: "succeeded",
      phase: "implement",
      planOutput: plan,
      planSessionId: "retryable-plan-session",
      providerSessionId: "fresh-implementation-session",
      worktreePath: original?.worktreePath,
    });
    const invocations = (await readFile(capture, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { args: string[]; input: string });
    expect(invocations).toHaveLength(3);
    expect(invocations[0]?.args).not.toContain("resume");
    expect(invocations[1]?.args).toContain("resume");
    expect(invocations[1]?.args).toContain("retryable-plan-session");
    expect(invocations[2]?.args).not.toContain("resume");
    expect(invocations[2]?.input).toContain(plan);
    app.close();
  });

  test("continues a saved plan with a fresh implementation process when no session was emitted", async () => {
    const { root, repo, app } = await setup();
    const codex = join(root, "codex");
    const capture = join(root, "fresh-implementation-resume.jsonl");
    const firstImplementation = join(root, "first-implementation-attempted");
    const plan = "Update the retained worktree using the concrete saved implementation plan.";
    await executable(
      codex,
      `
      import { appendFileSync, existsSync, writeFileSync } from "node:fs";
      const args = process.argv.slice(2);
      const input = await Bun.stdin.text();
      appendFileSync(${JSON.stringify(capture)}, JSON.stringify({args,input}) + "\\n");
      if (input.includes(${JSON.stringify(planningPromptMarker)})) {
        console.log(JSON.stringify({type:"thread.started",thread_id:"saved-plan-session"}));
        console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:${JSON.stringify(plan)}}}));
        console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:4,output_tokens:4}}));
        process.exit(0);
      }
      if (!existsSync(${JSON.stringify(firstImplementation)})) {
        writeFileSync(${JSON.stringify(firstImplementation)}, "attempted");
        console.log(JSON.stringify({type:"turn.failed",error:{message:"startup failed before session"}}));
        process.exit(0);
      }
      if (args.includes("resume")) {
        console.error("implementation without a saved session must start fresh");
        process.exit(8);
      }
      await Bun.write("continued-from-plan.txt", "implemented");
      console.log(JSON.stringify({type:"thread.started",thread_id:"new-implementation-session"}));
      console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"Continued saved plan"}}));
      console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:4,output_tokens:4}}));
      `,
    );
    process.env.AGENTQ_CODEX_BIN = codex;
    const queue = await app.createQueue({
      name: "fresh-implementation-resume",
      repoPath: repo,
      maxAttempts: 1,
      verifyCommands: ["test -f continued-from-plan.txt"],
    });
    const task = await app.addTask({ queue: queue.id, title: "Continue without session" });

    await new Supervisor(app, { pollIntervalMs: 20 }).run({ once: true });
    const firstRun = app.store.listRuns({ taskId: task.id })[0];
    expect(firstRun).toMatchObject({
      status: "failed",
      phase: "implement",
      planOutput: plan,
    });
    expect(firstRun?.providerSessionId).toBeUndefined();

    await app.resumeTask(task.id);
    await new Supervisor(app, { pollIntervalMs: 20 }).run({ once: true });

    const [completed, original] = app.store.listRuns({ taskId: task.id });
    expect(completed).toMatchObject({
      status: "succeeded",
      phase: "implement",
      planOutput: plan,
      providerSessionId: "new-implementation-session",
      worktreePath: original?.worktreePath,
    });
    expect(
      await readFile(join(completed?.worktreePath ?? "", "continued-from-plan.txt"), "utf8"),
    ).toBe("implemented");
    const invocations = (await readFile(capture, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { args: string[]; input: string });
    expect(invocations).toHaveLength(3);
    expect(invocations.filter(({ input }) => input.includes(planningPromptMarker))).toHaveLength(1);
    expect(invocations[2]?.args).not.toContain("resume");
    expect(invocations[2]?.input).toContain(plan);
    app.close();
  });

  test("records implementation completion separately from verification failure", async () => {
    const { root, repo, app } = await setup();
    const codex = join(root, "codex");
    await executable(
      codex,
      `
      ${codexPlanningGate("Inspect README.md and hand the exact verification requirement to implementation.")}
      console.log(JSON.stringify({type:"thread.started",thread_id:"implementation-finished"}));
      console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"Implementation work finished"}}));
      console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:1}}));
      `,
    );
    process.env.AGENTQ_CODEX_BIN = codex;
    const queue = await app.createQueue({
      name: "verification-failure",
      repoPath: repo,
      maxAttempts: 1,
      verifyCommands: ["test -f intentionally-missing.txt"],
    });
    const task = await app.addTask({ queue: queue.id, title: "Fail verification only" });

    await new Supervisor(app, { pollIntervalMs: 20 }).run({ once: true });

    expect(app.store.getTask(task.id)?.status).toBe("failed");
    const events = app.store.listEvents({ taskId: task.id, limit: 1_000 });
    expect(
      events.some(
        (event) =>
          event.kind === "workflow.phase" &&
          event.payload.phase === "implement" &&
          event.payload.state === "completed",
      ),
    ).toBeTrue();
    expect(
      events.some(
        (event) =>
          event.kind === "workflow.phase" &&
          event.payload.phase === "implement" &&
          event.payload.state === "failed",
      ),
    ).toBeFalse();
    expect(
      events.some(
        (event) => event.kind === "verification.completed" && event.payload.exitCode !== 0,
      ),
    ).toBeTrue();
    app.close();
  });

  test("exposes implemented and verify lifecycle state while mandatory gates run", async () => {
    const { root, repo, app } = await setup();
    const codex = join(root, "codex");
    const verificationStarted = join(root, "verification-started");
    const releaseVerification = join(root, "release-verification");
    await executable(
      codex,
      `
      ${codexPlanningGate("Implement the change, then wait for the mandatory verification gate.")}
      await Bun.write("implemented.txt", "implemented\\n");
      console.log(JSON.stringify({type:"thread.started",thread_id:"lifecycle-state"}));
      console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"Implementation finished"}}));
      console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:2,output_tokens:2}}));
      `,
    );
    process.env.AGENTQ_CODEX_BIN = codex;
    const verify = `bun -e 'await Bun.write(${JSON.stringify(
      verificationStarted,
    )}, "ready"); while (!(await Bun.file(${JSON.stringify(
      releaseVerification,
    )}).exists())) await Bun.sleep(10)'`;
    const queue = await app.createQueue({
      name: "lifecycle-state",
      repoPath: repo,
      maxAttempts: 1,
      verifyCommands: [verify],
      autoCommit: true,
    });
    const task = await app.addTask({ queue: queue.id, title: "Expose lifecycle state" });
    const running = new Supervisor(app, { pollIntervalMs: 10 }).run({ once: true });

    const deadline = Date.now() + 3_000;
    while (!(await Bun.file(verificationStarted).exists())) {
      if (Date.now() > deadline) throw new Error("verification did not start");
      await Bun.sleep(10);
    }
    expect(app.store.getTask(task.id)).toMatchObject({
      status: "running",
      currentPhase: "verify",
      deliveryStatus: "implemented",
    });

    await Bun.write(releaseVerification, "release");
    await running;
    expect(app.store.getTask(task.id)).toMatchObject({
      status: "succeeded",
      currentPhase: "complete",
      deliveryStatus: "ready_to_integrate",
    });
    app.close();
  });

  test("stops permanently when authoritative Git changes violate path policy", async () => {
    const { root, repo, app } = await setup();
    const codex = join(root, "codex");
    await executable(
      codex,
      `
      import { mkdirSync } from "node:fs";
      ${codexPlanningGate("Change only the service implementation and its focused test.")}
      mkdirSync("src/api", {recursive:true});
      await Bun.write("src/api/private.ts", "forbidden\\n");
      console.log(JSON.stringify({type:"thread.started",thread_id:"policy-implementation"}));
      console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"Changed a denied path"}}));
      console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:7,output_tokens:3}}));
      `,
    );
    process.env.AGENTQ_CODEX_BIN = codex;
    const queue = await app.createQueue({
      name: "policy-enforcement",
      repoPath: repo,
      maxAttempts: 3,
      allowedPaths: ["src/**"],
      deniedPaths: ["src/api/**"],
      verifyCommands: ["touch verification-must-not-run"],
      autoCommit: true,
    });
    const task = await app.addTask({ queue: queue.id, title: "Respect service scope" });
    const initialMain = (await runCommand("git", ["-C", repo, "rev-parse", "main"])).stdout.trim();

    await new Supervisor(app, { pollIntervalMs: 20 }).run({ once: true });

    const stored = app.store.getTask(task.id);
    const run = app.store.listRuns({ taskId: task.id })[0];
    expect(stored).toMatchObject({
      status: "failed",
      deliveryStatus: "implemented",
      failureClass: "policy_violation",
      retryDisposition: "stop",
      changedFiles: ["src/api/private.ts"],
    });
    expect(run).toMatchObject({
      status: "failed",
      failureClass: "policy_violation",
      retryDisposition: "stop",
      changedFiles: ["src/api/private.ts"],
    });
    expect(run?.resultCommitSha).toBeUndefined();
    expect(
      await Bun.file(join(run?.worktreePath ?? "", "verification-must-not-run")).exists(),
    ).toBe(false);
    expect((await runCommand("git", ["-C", repo, "rev-parse", "main"])).stdout.trim()).toBe(
      initialMain,
    );
    expect(
      app.store
        .listEvents({ taskId: task.id, limit: 1_000 })
        .some(
          (event) =>
            event.kind === "policy.completed" &&
            event.payload.passed === false &&
            Array.isArray(event.payload.violations),
        ),
    ).toBeTrue();
    app.close();
  });

  test("runs inherited and task gates then persists one immutable landable result", async () => {
    const { root, repo, app } = await setup();
    const codex = join(root, "codex");
    await executable(
      codex,
      `
      import { mkdirSync } from "node:fs";
      ${codexPlanningGate("Add the service module and a focused test, then run both mandatory gates.")}
      mkdirSync("src", {recursive:true});
      mkdirSync("test", {recursive:true});
      await Bun.write("src/service.ts", "export const service = true;\\n");
      await Bun.write("test/service.test.ts", "export const covered = true;\\n");
      console.log(JSON.stringify({type:"thread.started",thread_id:"landable-implementation"}));
      console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"Implemented service and test"}}));
      console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:7,output_tokens:3}}));
      `,
    );
    process.env.AGENTQ_CODEX_BIN = codex;
    const queue = await app.createQueue({
      name: "landable-result",
      repoPath: repo,
      maxAttempts: 1,
      allowedPaths: ["src/**", "test/**"],
      deniedPaths: ["src/api/**"],
      maxChangedFiles: 4,
      verifyCommands: ["test -f src/service.ts"],
      autoCommit: true,
      landStrategy: "stack",
    });
    const task = await app.addTask({
      queue: queue.id,
      title: "Create a landable service result",
      allowedPaths: ["src/service.ts", "test/service.test.ts"],
      verifyCommands: ["test -f test/service.test.ts"],
      landStrategy: "stack",
    });
    const initialMain = (await runCommand("git", ["-C", repo, "rev-parse", "main"])).stdout.trim();

    await new Supervisor(app, { pollIntervalMs: 20 }).run({ once: true });

    const stored = app.store.getTask(task.id);
    const run = app.store.listRuns({ taskId: task.id })[0];
    expect(stored).toMatchObject({
      status: "succeeded",
      deliveryStatus: "ready_to_integrate",
      changedFiles: ["src/service.ts", "test/service.test.ts"],
      inputTokens: 12,
      outputTokens: 8,
    });
    expect(run?.resultCommitSha).toBe(stored?.resultCommitSha);
    expect(run?.verificationResults.every((gate) => gate.status === "passed")).toBeTrue();
    expect(run?.verificationResults.filter((gate) => gate.kind === "command")).toHaveLength(2);
    const resultSha = stored?.resultCommitSha;
    if (!resultSha || !run?.baseSha) throw new Error("Expected a canonical result");
    expect(
      (await runCommand("git", ["-C", repo, "rev-parse", `${resultSha}^`])).stdout.trim(),
    ).toBe(run.baseSha);
    expect(
      (
        await runCommand("git", [
          "-C",
          repo,
          "rev-parse",
          `refs/agentq/results/${task.id}/${run.id}`,
        ])
      ).stdout.trim(),
    ).toBe(resultSha);
    expect((await runCommand("git", ["-C", repo, "rev-parse", "main"])).stdout.trim()).toBe(
      initialMain,
    );
    app.close();
  });

  test("publishes a blocker result even when queue auto-commit is disabled", async () => {
    const { root, repo, app } = await setup();
    const codex = join(root, "codex");
    await executable(
      codex,
      `
      ${codexPlanningGate("Create the dependency output consumed by the downstream task.")}
      await Bun.write("dependency-output.txt", "ready\\n");
      console.log(JSON.stringify({type:"thread.started",thread_id:"dependency-result"}));
      console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"Produced dependency output"}}));
      console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:2,output_tokens:2}}));
      `,
    );
    process.env.AGENTQ_CODEX_BIN = codex;
    const queue = await app.createQueue({
      name: "dependency-result",
      repoPath: repo,
      maxAttempts: 1,
      autoCommit: false,
    });
    const blocker = await app.addTask({
      queue: queue.id,
      title: "Produce dependency output",
    });
    const dependent = await app.addTask({
      queue: queue.id,
      title: "Consume dependency output later",
      blockedBy: [blocker.id],
    });
    await app.cancelTask(dependent.id);

    await new Supervisor(app, { pollIntervalMs: 20 }).run({ once: true });

    const stored = app.store.getTask(blocker.id);
    const run = app.store.listRuns({ taskId: blocker.id })[0];
    expect(stored).toMatchObject({
      status: "succeeded",
      deliveryStatus: "ready_to_integrate",
      changedFiles: ["dependency-output.txt"],
    });
    expect(stored?.resultCommitSha).toBeString();
    expect(run?.resultCommitSha).toBe(stored?.resultCommitSha);
    if (!stored?.resultCommitSha || !run) throw new Error("Expected a durable blocker result");
    expect(
      (
        await runCommand("git", [
          "-C",
          repo,
          "rev-parse",
          `refs/agentq/results/${blocker.id}/${run.id}`,
        ])
      ).stdout.trim(),
    ).toBe(stored.resultCommitSha);
    app.close();
  });

  test("observes cross-process cancellation and terminates the running agent", async () => {
    const { root, repo, app } = await setup();
    const codex = join(root, "codex");
    await executable(
      codex,
      `
      ${codexPlanningGate()}
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
    while (
      app.store.getTask(task.id)?.status !== "running" ||
      app.store.listRuns({ taskId: task.id })[0]?.providerSessionId !== "cancel-session"
    ) {
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

  test("never releases implementation when cancellation reaches the phase boundary", async () => {
    const { root, repo, app } = await setup();
    const codex = join(root, "codex");
    const plannerReady = join(root, "planner-ready");
    const releasePlanner = join(root, "release-planner");
    const implementationStarted = join(root, "implementation-started");
    await executable(
      codex,
      `
      import { existsSync } from "node:fs";
      const input = await Bun.stdin.text();
      if (input.includes(${JSON.stringify(planningPromptMarker)})) {
        await Bun.write(${JSON.stringify(plannerReady)}, "ready");
        while (!existsSync(${JSON.stringify(releasePlanner)})) await Bun.sleep(10);
        console.log(JSON.stringify({type:"thread.started",thread_id:"boundary-plan-session"}));
        console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"Inspect README.md, then implement the requested change."}}));
        console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:2,output_tokens:2}}));
        process.exit(0);
      }
      await Bun.write(${JSON.stringify(implementationStarted)}, "released");
      console.log(JSON.stringify({type:"thread.started",thread_id:"must-not-start"}));
      console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:1}}));
      `,
    );
    process.env.AGENTQ_CODEX_BIN = codex;
    const queue = await app.createQueue({ name: "phase-cancel", repoPath: repo, maxAttempts: 1 });
    const task = await app.addTask({ queue: queue.id, title: "Cancel between stages" });
    const running = new Supervisor(app, { pollIntervalMs: 10 }).run({ once: true });

    const deadline = Date.now() + 3_000;
    while (!(await Bun.file(plannerReady).exists())) {
      if (Date.now() > deadline) throw new Error("planner did not reach the phase boundary");
      await Bun.sleep(10);
    }
    await app.cancelTask(task.id);
    await Bun.write(releasePlanner, "release");
    await running;

    expect(app.store.getTask(task.id)?.status).toBe("cancelled");
    expect(await Bun.file(implementationStarted).exists()).toBeFalse();
    expect(
      app.store
        .listEvents({ taskId: task.id, limit: 1_000 })
        .some(
          (event) =>
            event.kind === "workflow.phase" &&
            event.payload.phase === "implement" &&
            event.payload.state === "started",
        ),
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
      ${codexPlanningGate()}
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
      if (input.kind.startsWith("executor.") && input.payload?.phase === "implement")
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
      ${codexPlanningGate()}
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
      ${codexPlanningGate()}
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
    while (
      app.store.getTask(task.id)?.status !== "running" ||
      app.store.listRuns({ taskId: task.id })[0]?.providerSessionId !== "shutdown-session"
    ) {
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
      ${codexPlanningGate()}
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
      ${codexPlanningGate()}
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
      ${codexPlanningGate()}
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
      ${codexPlanningGate()}
      await Bun.write(${JSON.stringify(pidFile)}, String(process.pid));
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
      ${codexPlanningGate()}
      if (agentqPrompt.includes("Title: Parent task")) {
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
