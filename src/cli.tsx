#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { z } from "zod";
import { AgentQApp } from "./app.ts";
import { AgentQError, errorMessage } from "./core/errors.ts";
import { resolvePaths } from "./core/paths.ts";
import { type AddTaskInput, PROVIDERS, type Provider, TASK_STATUSES } from "./core/types.ts";
import { createExecutorMap } from "./executors/index.ts";
import { hasDelegatedTaskIntake, submitDelegatedTask } from "./intake/delegated-tasks.ts";
import { type IntegrationTarget, installIntegration } from "./integrations/instructions.ts";
import { resolveCommandInvocation } from "./process/index.ts";
import { Supervisor } from "./supervisor/supervisor.ts";
import { renderAgentq } from "./ui/index.tsx";
import { sanitizeTerminalText } from "./ui/sanitize.ts";

const version = typeof AGENTQ_VERSION === "string" ? AGENTQ_VERSION : "0.1.0";
const program = new Command();
let activeApp: AgentQApp | undefined;

program
  .name("agentq")
  .description("Durable local task queues for parallel Codex and Claude Code agents")
  .version(version)
  .option("--state-dir <path>", "override the agentq state directory")
  .showHelpAfterError()
  .configureHelp({ sortSubcommands: true, sortOptions: true })
  .action(async () => {
    await launchUi();
  });

const queue = program.command("queue").description("Create and manage task queues");

queue
  .command("create")
  .description("Create a queue backed by a Git repository")
  .argument("<name>", "unique queue name")
  .option("-r, --repo <path>", "Git repository", process.cwd())
  .option("-b, --base <ref>", "base branch or ref (defaults to current branch)")
  .option("-p, --provider <provider>", "default provider: codex or claude", parseProvider, "codex")
  .option("-c, --concurrency <number>", "parallel tasks for this queue", positiveInteger, 2)
  .option("--max-attempts <number>", "maximum attempts per task", positiveInteger, 2)
  .option("--verify <command>", "verification command; repeatable", collect, [])
  .option("--no-auto-commit", "leave successful changes uncommitted")
  .option("--json", "print machine-readable JSON")
  .action(async (name, options) => {
    await withApp(async (app) => {
      const created = await app.createQueue({
        name,
        repoPath: options.repo,
        baseRef: options.base,
        defaultProvider: options.provider,
        concurrency: options.concurrency,
        maxAttempts: options.maxAttempts,
        verifyCommands: options.verify,
        autoCommit: options.autoCommit,
      });
      print(
        created,
        options.json,
        `Created queue ${human(created.name)} → ${human(created.repoPath)}`,
      );
    });
  });

queue
  .command("list")
  .alias("ls")
  .description("List queues")
  .option("--json", "print machine-readable JSON")
  .action(async (options) => {
    await withApp(async (app) => {
      const queues = await app.listQueues();
      if (options.json) return printJson(queues);
      if (queues.length === 0)
        return console.log("No queues yet. Create one with: agentq queue create <name> --repo .");
      console.log("NAME\tPROVIDER\tRUNNING\tREPOSITORY");
      for (const item of queues) {
        const running = app.store.listTasks({
          queue: item.id,
          statuses: ["starting", "running", "cancelling"],
        }).length;
        console.log(
          `${human(item.name)}\t${item.defaultProvider}\t${running}/${item.concurrency}\t${human(item.repoPath)}`,
        );
      }
    });
  });

queue
  .command("show")
  .description("Show queue configuration and tasks")
  .argument("<queue>")
  .option("--json", "print machine-readable JSON")
  .action(async (queueRef, options) => {
    await withApp(async (app) => {
      const found = await app.getQueue(queueRef);
      const tasks = await app.listTasks(found.id);
      print({ ...found, tasks }, options.json);
    });
  });

queue
  .command("remove")
  .description("Remove an empty queue")
  .argument("<queue>")
  .option("--yes", "confirm removal")
  .option("--json", "print machine-readable JSON")
  .action(async (queueRef, options) => {
    if (!options.yes)
      throw new AgentQError("Queue removal requires --yes", "CONFIRMATION_REQUIRED", 2);
    await withApp(async (app) => {
      await app.deleteQueue(queueRef);
      print({ removed: true, queue: queueRef }, options.json, `Removed queue ${human(queueRef)}`);
    });
  });

const task = program.command("task").description("Add and manage tasks");

task
  .command("add")
  .description("Add a task manually or from JSON stdin")
  .argument("[title]", "short task title")
  .option("-t, --title <title>", "short task title (alternative to the positional argument)")
  .option("-q, --queue <queue>", "queue name or id (defaults to $AGENTQ_QUEUE)")
  .option("-i, --instructions <text>", "complete task instructions")
  .option("-p, --provider <provider>", "override queue provider", parseProvider)
  .option("--priority <number>", "higher values run first", integer, 0)
  .option("--accept <criterion>", "acceptance criterion; repeatable", collect, [])
  .option("--idempotency-key <key>", "return the existing task if this key was already queued")
  .option("--stdin-json", "read task object from stdin")
  .option("--json", "print machine-readable JSON")
  .action(async (title, options) => {
    if (title && options.title && title !== options.title) {
      throw new AgentQError(
        "Specify the task title either positionally or with --title, not both",
        "DUPLICATE_TITLE",
        2,
      );
    }
    const input = options.stdinJson
      ? await readTaskJson()
      : {
          queue: options.queue ?? process.env.AGENTQ_QUEUE,
          title: options.title ?? title,
          instructions: options.instructions,
          acceptanceCriteria: options.accept,
          provider: options.provider,
          priority: options.priority,
          idempotencyKey: options.idempotencyKey,
        };
    if (!input.queue)
      throw new AgentQError("Specify --queue or set AGENTQ_QUEUE", "QUEUE_REQUIRED", 2);
    if (!input.title?.trim())
      throw new AgentQError("A task title is required", "TITLE_REQUIRED", 2);

    const taskInput = input as AddTaskInput;
    const created = hasDelegatedTaskIntake()
      ? await submitDelegatedTask(taskInput)
      : await withApp((app) => app.addTask(taskInput));
    print(
      created,
      options.json || options.stdinJson,
      `Queued ${created.id}: ${human(created.title)}`,
    );
  });

task
  .command("list")
  .alias("ls")
  .description("List tasks")
  .option("-q, --queue <queue>", "filter by queue")
  .option("-s, --status <status>", "filter by status; repeatable", collectStatus, [])
  .option("--json", "print machine-readable JSON")
  .action(async (options) => {
    await withApp(async (app) => {
      const tasks = app.store.listTasks({
        queue: options.queue,
        statuses: options.status.length > 0 ? options.status : undefined,
      });
      if (options.json) return printJson(tasks);
      if (tasks.length === 0) return console.log("No matching tasks.");
      console.log("ID\tSTATUS\tPROVIDER\tQUEUE\tTITLE");
      for (const item of tasks) {
        console.log(
          `${item.id}\t${item.status}\t${item.provider}\t${human(item.queueName ?? item.queueId)}\t${human(item.title)}`,
        );
      }
    });
  });

task
  .command("show")
  .description("Show a task, attempts, and recent events")
  .argument("<task-id>")
  .option("--json", "print machine-readable JSON")
  .action(async (taskId, options) => {
    await withApp(async (app) => {
      const found = await app.getTask(taskId);
      const runs = app.store.listRuns({ taskId });
      const events = app.store.listEvents({ taskId, limit: 100 });
      print({ ...found, runs, events }, options.json);
    });
  });

task
  .command("cancel")
  .description("Cancel a queued or running task")
  .argument("<task-id>")
  .option("--json", "print machine-readable JSON")
  .action(async (taskId, options) => {
    await withApp(async (app) => {
      await app.cancelTask(taskId);
      const task = await app.getTask(taskId);
      print(task, options.json, `Cancellation requested for ${taskId}`);
    });
  });

task
  .command("retry")
  .description("Retry a failed, interrupted, or cancelled task in a fresh worktree and session")
  .argument("<task-id>")
  .option("--json", "print machine-readable JSON")
  .action(async (taskId, options) => {
    await withApp(async (app) => {
      await app.retryTask(taskId);
      const task = await app.getTask(taskId);
      print(task, options.json, `Requeued ${taskId} for a fresh attempt`);
    });
  });

task
  .command("resume")
  .description("Resume the latest provider session in its retained worktree")
  .argument("<task-id>")
  .option("--json", "print machine-readable JSON")
  .action(async (taskId, options) => {
    await withApp(async (app) => {
      await app.resumeTask(taskId);
      const task = await app.getTask(taskId);
      print(task, options.json, `Queued ${taskId} to resume its latest agent session`);
    });
  });

task
  .command("complete")
  .description("Mark a non-running task complete manually")
  .argument("<task-id>")
  .option("--summary <text>", "completion summary", "Completed manually")
  .option("--json", "print machine-readable JSON")
  .action(async (taskId, options) => {
    await withApp(async (app) => {
      await app.completeManualTask(taskId, options.summary);
      const task = await app.getTask(taskId);
      print(task, options.json, `Completed ${taskId}`);
    });
  });

task
  .command("logs")
  .description("Print normalized task events")
  .argument("<task-id>")
  .option("-f, --follow", "follow new events")
  .option("--json", "emit JSON lines")
  .action(async (taskId, options) => {
    await withApp(async (app) => {
      let afterId = 0;
      do {
        const events = app.store.listEvents({ taskId, afterId, limit: 500 });
        for (const event of events) {
          afterId = Math.max(afterId, event.id);
          if (options.json) console.log(JSON.stringify(event));
          else
            console.log(
              `${event.createdAt}  ${human(event.kind)}  ${human(formatPayload(event.payload))}`,
            );
        }
        if (!options.follow) break;
        const current = await app.getTask(taskId);
        if (
          ["succeeded", "failed", "interrupted", "cancelled"].includes(current.status) &&
          events.length === 0
        )
          break;
        await Bun.sleep(500);
      } while (options.follow);
    });
  });

task
  .command("clean")
  .description("Remove a retained task worktree")
  .argument("<task-id>")
  .option("--force", "discard uncommitted worktree changes")
  .option("--yes", "confirm removal")
  .option("--json", "print machine-readable JSON")
  .action(async (taskId, options) => {
    if (!options.yes)
      throw new AgentQError("Worktree removal requires --yes", "CONFIRMATION_REQUIRED", 2);
    await withApp(async (app) => {
      const found = await app.getTask(taskId);
      if (["starting", "running", "cancelling"].includes(found.status)) {
        throw new AgentQError("Cannot clean a running task", "TASK_IS_RUNNING");
      }
      const run = app.store.listRuns({ taskId }).find((candidate) => candidate.worktreePath);
      if (!run?.worktreePath)
        throw new AgentQError("Task has no retained worktree", "WORKTREE_NOT_FOUND");
      const queue = await app.getQueue(found.queueId);
      await app.worktrees.remove(queue.repoPath, run.worktreePath, options.force);
      print(
        { taskId, removedWorktree: run.worktreePath },
        options.json,
        `Removed ${human(run.worktreePath)}`,
      );
    });
  });

program
  .command("run")
  .description("Run the foreground parallel-agent supervisor")
  .argument("[queue]", "optional queue name or id")
  .option("--once", "drain currently runnable tasks, then exit")
  .option("-c, --concurrency <number>", "global concurrent agents", positiveInteger)
  .action(async (queueRef, options) => {
    await withApp(async (app) => {
      const controller = signalController();
      const supervisor = new Supervisor(app, {
        queue: queueRef,
        maxConcurrency: options.concurrency,
      });
      console.log(`agentq supervisor started${queueRef ? ` for ${human(queueRef)}` : ""}`);
      await supervisor.run({ once: options.once, signal: controller.signal });
    });
  });

program
  .command("ui")
  .description("Open the interactive Ink interface and run the supervisor")
  .action(async () => {
    await launchUi();
  });

program
  .command("doctor")
  .description("Check Git, bundled providers, state, and parallel isolation")
  .option("--json", "print machine-readable JSON")
  .action(async (options) => {
    await withApp(async (app) => {
      const checks = await app.doctor();
      if (options.json) return printJson(checks);
      for (const check of checks) {
        console.log(`${check.ok ? "✓" : "✗"} ${human(check.name)}: ${human(check.detail)}`);
        if (!check.ok && check.remediation) console.log(`  ${human(check.remediation)}`);
      }
      if (checks.some((check) => !check.ok)) process.exitCode = 1;
    });
  });

const provider = program
  .command("provider")
  .description("Inspect and authenticate bundled agent providers");

provider
  .command("list")
  .description("Show bundled provider versions and authentication state")
  .option("--json", "print machine-readable JSON")
  .action(async (options) => {
    await withApp(async (app) => {
      const checks = (await app.doctor()).filter((check) => /Codex|Claude/.test(check.name));
      if (options.json) printJson(checks);
      else
        for (const check of checks)
          console.log(`${check.ok ? "✓" : "✗"} ${human(check.name)}: ${human(check.detail)}`);
    });
  });

provider
  .command("login")
  .description("Run the official provider authentication flow")
  .argument("<provider>", "codex or claude", parseProvider)
  .action(async (providerName: Provider) => {
    const executor = createExecutorMap().get(providerName);
    const health = await executor?.probe();
    if (!health?.available || !health.binary) {
      throw new AgentQError(
        health?.message ?? `${providerName} executable is unavailable`,
        "PROVIDER_UNAVAILABLE",
      );
    }
    const args = providerName === "codex" ? ["login"] : ["auth", "login"];
    const exitCode = await runInteractive(health.binary, args);
    if (exitCode !== 0)
      throw new AgentQError(`${providerName} login exited with code ${exitCode}`, "LOGIN_FAILED");
  });

program
  .command("integrate")
  .description("Teach Codex and/or Claude Code how to add tasks to agentq")
  .argument("<target>", "codex, claude, or all", parseIntegrationTarget)
  .option("-r, --repo <path>", "repository to update", process.cwd())
  .option("--json", "print machine-readable JSON")
  .action(async (target: IntegrationTarget, options) => {
    const results = await installIntegration(options.repo, target);
    if (options.json) printJson(results);
    else
      for (const result of results) console.log(`${human(result.action)}: ${human(result.file)}`);
  });

async function launchUi(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new AgentQError(
      "The interactive UI requires a TTY. Use agentq --help for scripted commands.",
      "TTY_REQUIRED",
      2,
    );
  }
  await withApp(async (app) => {
    const controller = signalController();
    const supervisor = new Supervisor(app);
    const running = supervisor.run({ signal: controller.signal });
    const supervised = running.then(
      () => ({ kind: "supervisor" as const }),
      (error: unknown) => ({ kind: "supervisor-error" as const, error }),
    );
    const instance = renderAgentq(app);
    try {
      const outcome = await Promise.race([
        instance.waitUntilExit().then(() => ({ kind: "ui" as const })),
        supervised,
      ]);
      if (outcome.kind === "supervisor-error") throw outcome.error;
      if (outcome.kind === "supervisor" && !controller.signal.aborted) {
        throw new AgentQError("The supervisor stopped unexpectedly", "SUPERVISOR_STOPPED");
      }
    } finally {
      controller.abort("UI closed");
      supervisor.stop("UI closed");
      instance.unmount();
      await running.catch(() => undefined);
    }
  });
}

async function withApp<T>(operation: (app: AgentQApp) => Promise<T>): Promise<T> {
  const stateDir = program.opts().stateDir as string | undefined;
  const paths = resolvePaths(
    stateDir ? { ...process.env, AGENTQ_STATE_DIR: resolve(stateDir) } : process.env,
  );
  const app = await AgentQApp.create(paths);
  activeApp = app;
  try {
    return await operation(app);
  } finally {
    app.close();
    activeApp = undefined;
  }
}

const taskJsonSchema = z.object({
  queue: z.string().min(1),
  title: z.string().min(1),
  instructions: z.string().optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  provider: z.enum(PROVIDERS).optional(),
  priority: z.number().int().optional(),
  idempotencyKey: z.string().min(1).optional(),
});

async function readTaskJson(): Promise<z.infer<typeof taskJsonSchema>> {
  const text = await Bun.stdin.text();
  if (!text.trim()) throw new AgentQError("No JSON was provided on stdin", "EMPTY_STDIN", 2);
  try {
    return taskJsonSchema.parse(JSON.parse(text));
  } catch (error) {
    throw new AgentQError(`Invalid task JSON: ${errorMessage(error)}`, "INVALID_TASK_JSON", 2);
  }
}

function parseProvider(value: string): Provider {
  if (PROVIDERS.includes(value as Provider)) return value as Provider;
  throw new InvalidArgumentError("Expected codex or claude.");
}

function parseIntegrationTarget(value: string): IntegrationTarget {
  if (["codex", "claude", "all"].includes(value)) return value as IntegrationTarget;
  throw new InvalidArgumentError("Expected codex, claude, or all.");
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new InvalidArgumentError("Expected a positive integer.");
  return parsed;
}

function integer(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new InvalidArgumentError("Expected an integer.");
  return parsed;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function collectStatus(value: string, previous: string[]): string[] {
  if (!TASK_STATUSES.includes(value as (typeof TASK_STATUSES)[number])) {
    throw new InvalidArgumentError(`Expected one of: ${TASK_STATUSES.join(", ")}`);
  }
  return [...previous, value];
}

function print(value: unknown, json = false, message?: string): void {
  if (json || !message) printJson(value);
  else console.log(message);
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function human(value: string): string {
  return sanitizeTerminalText(value);
}

function formatPayload(payload: Record<string, unknown>): string {
  if (typeof payload.text === "string") return payload.text.replaceAll("\n", " ").slice(0, 180);
  if (typeof payload.message === "string")
    return payload.message.replaceAll("\n", " ").slice(0, 180);
  return JSON.stringify(payload).slice(0, 180);
}

function signalController(): AbortController {
  const controller = new AbortController();
  const abort = (signal: string) => controller.abort(signal);
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  controller.signal.addEventListener(
    "abort",
    () => {
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
    },
    { once: true },
  );
  return controller;
}

async function runInteractive(command: string, args: string[]): Promise<number> {
  return await new Promise<number>((resolvePromise, reject) => {
    const invocation = resolveCommandInvocation(command, args, process.env);
    const child = spawn(invocation.command, invocation.args, {
      stdio: "inherit",
      env: process.env,
      windowsHide: false,
    });
    child.once("error", reject);
    child.once("exit", (code) => resolvePromise(code ?? 1));
  });
}

process.once("exit", () => activeApp?.close());

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof CommanderError) {
    process.exitCode = error.exitCode;
  } else {
    console.error(`agentq: ${human(errorMessage(error))}`);
    process.exitCode = error instanceof AgentQError ? error.exitCode : 1;
  }
}
