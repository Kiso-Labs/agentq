#!/usr/bin/env bun

import { resolve } from "node:path";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { z } from "zod";
import { AgentQApp } from "./app.ts";
import { AgentQError, errorMessage } from "./core/errors.ts";
import { resolvePaths } from "./core/paths.ts";
import { type AddTaskInput, PROVIDERS, type Provider, TASK_STATUSES } from "./core/types.ts";
import { findRepositoryContext } from "./git/repository.ts";
import { submitDelegatedTask } from "./intake/delegated-tasks.ts";
import type { IntegrationTarget } from "./integrations/instructions.ts";
import { Supervisor } from "./supervisor/supervisor.ts";
import { activityEntries } from "./ui/activity.ts";
import { renderAgentq } from "./ui/index.tsx";
import { sanitizeTerminalText } from "./ui/sanitize.ts";
import type { UiQueuePatch } from "./ui/types.ts";

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
  .argument("<name>", "queue name (unique within its repository)")
  .option("-r, --repo <path>", "Git repository", process.cwd())
  .option("-b, --base <ref>", "base branch or ref (defaults to current branch)")
  .option("-p, --provider <provider>", "default provider: codex or claude", parseProvider, "codex")
  .option("--plan-model <model>", "model used by the planning agent")
  .option("--plan-instructions <text>", "general instructions for the planning agent")
  .option("--implement-model <model>", "model used by the implementation agent")
  .option("--implement-instructions <text>", "general instructions for the implementation agent")
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
        planModel: options.planModel,
        planInstructions: options.planInstructions,
        implementModel: options.implementModel,
        implementInstructions: options.implementInstructions,
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
  .command("edit")
  .description("Edit mutable queue configuration")
  .argument("<queue>", "queue name or id")
  .option("--name <name>", "replace the queue name")
  .option("-b, --base <ref>", "replace the base branch or ref")
  .option("-p, --provider <provider>", "replace the default provider", parseProvider)
  .option("--plan-model <model>", "replace the planning-agent model")
  .option("--clear-plan-model", "use the provider default for the planning agent")
  .option("--plan-instructions <text>", "replace general planning-agent instructions")
  .option("--clear-plan-instructions", "remove general planning-agent instructions")
  .option("--implement-model <model>", "replace the implementation-agent model")
  .option("--clear-implement-model", "use the provider default for the implementation agent")
  .option("--implement-instructions <text>", "replace general implementation-agent instructions")
  .option("--clear-implement-instructions", "remove general implementation-agent instructions")
  .option("-c, --concurrency <number>", "replace parallel task capacity", positiveInteger)
  .option("--max-attempts <number>", "replace maximum attempts per task", positiveInteger)
  .option("--verify <command>", "replace verification commands; repeatable", collectOptional)
  .option("--clear-verify", "remove all verification commands")
  .option("--auto-commit", "commit successful task changes")
  .option("--no-auto-commit", "leave successful task changes uncommitted")
  .option("--json", "print machine-readable JSON")
  .action(async (queueRef, options) => {
    const workflowConflicts = [
      [options.planModel, options.clearPlanModel, "--plan-model", "--clear-plan-model"],
      [
        options.planInstructions,
        options.clearPlanInstructions,
        "--plan-instructions",
        "--clear-plan-instructions",
      ],
      [
        options.implementModel,
        options.clearImplementModel,
        "--implement-model",
        "--clear-implement-model",
      ],
      [
        options.implementInstructions,
        options.clearImplementInstructions,
        "--implement-instructions",
        "--clear-implement-instructions",
      ],
    ] as const;
    const workflowConflict = workflowConflicts.find(
      ([value, clear]) => value !== undefined && clear,
    );
    if (workflowConflict) {
      throw new AgentQError(
        `Use either ${workflowConflict[2]} or ${workflowConflict[3]}, not both`,
        "INVALID_QUEUE_EDIT",
        2,
      );
    }
    if (options.verify && options.clearVerify) {
      throw new AgentQError(
        "Use either --verify or --clear-verify, not both",
        "INVALID_QUEUE_EDIT",
        2,
      );
    }
    const patch: UiQueuePatch = {
      name: options.name as string | undefined,
      baseRef: options.base as string | undefined,
      defaultProvider: options.provider as Provider | undefined,
      planModel: options.clearPlanModel ? "" : (options.planModel as string | undefined),
      planInstructions: options.clearPlanInstructions
        ? ""
        : (options.planInstructions as string | undefined),
      implementModel: options.clearImplementModel
        ? ""
        : (options.implementModel as string | undefined),
      implementInstructions: options.clearImplementInstructions
        ? ""
        : (options.implementInstructions as string | undefined),
      concurrency: options.concurrency as number | undefined,
      maxAttempts: options.maxAttempts as number | undefined,
      verifyCommands: options.clearVerify ? [] : (options.verify as string[] | undefined),
      autoCommit: options.autoCommit as boolean | undefined,
    };
    if (Object.values(patch).every((value) => value === undefined)) {
      throw new AgentQError("Specify at least one queue field to edit", "EMPTY_QUEUE_EDIT", 2);
    }
    await withApp(async (app) => {
      const current = await app.getQueue(queueRef);
      const edited = await app.updateQueue(current.id, patch);
      print(edited, options.json, `Updated queue ${human(edited.name)}`);
    });
  });

queue
  .command("list")
  .alias("ls")
  .description("List queues")
  .option("--all", "include queues from every repository")
  .option("--json", "print machine-readable JSON")
  .action(async (options) => {
    await withApp(async (app) => {
      if (options.all) await app.setAllRepositories(true);
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
  .alias("rm")
  .description("Delete a queue and all inactive tasks and history")
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
    const created =
      process.env.AGENTQ_AGENT_CONTEXT === "1"
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
  .option("--all", "include tasks from every repository")
  .option("--json", "print machine-readable JSON")
  .action(async (options) => {
    await withApp(async (app) => {
      if (options.all) await app.setAllRepositories(true);
      const queueId = options.queue ? (await app.getQueue(options.queue)).id : undefined;
      const listed = await app.listTasks(queueId);
      const statuses = new Set<string>(options.status);
      const tasks = statuses.size > 0 ? listed.filter((item) => statuses.has(item.status)) : listed;
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
  .command("edit")
  .description("Edit a queued or retryable task")
  .argument("<task-id>")
  .option("--title <title>", "replace the task title")
  .option("--instructions <text>", "replace the complete task instructions")
  .option("-p, --provider <provider>", "replace the provider", parseProvider)
  .option("--priority <number>", "replace the scheduling priority", integer)
  .option("--accept <criterion>", "replace acceptance criteria; repeatable", collectOptional)
  .option("--clear-acceptance", "remove all acceptance criteria")
  .option("--json", "print machine-readable JSON")
  .action(async (taskId, options) => {
    if (options.accept && options.clearAcceptance) {
      throw new AgentQError(
        "Use either --accept or --clear-acceptance, not both",
        "INVALID_TASK_EDIT",
        2,
      );
    }
    const patch = {
      title: options.title as string | undefined,
      instructions: options.instructions as string | undefined,
      acceptanceCriteria: options.clearAcceptance ? [] : (options.accept as string[] | undefined),
      provider: options.provider as Provider | undefined,
      priority: options.priority as number | undefined,
    };
    if (Object.values(patch).every((value) => value === undefined)) {
      throw new AgentQError("Specify at least one task field to edit", "EMPTY_TASK_EDIT", 2);
    }
    await withApp(async (app) => {
      const current = await app.getTask(taskId);
      const edited = await app.editTask(taskId, patch, current.updatedAt);
      print(edited, options.json, `Updated ${taskId}: ${human(edited.title)}`);
    });
  });

task
  .command("remove")
  .alias("rm")
  .description("Delete an inactive task, attempts, logs, and events")
  .argument("<task-id>")
  .option("--yes", "confirm deletion")
  .option("--json", "print machine-readable JSON")
  .action(async (taskId, options) => {
    if (!options.yes) {
      throw new AgentQError("Task removal requires --yes", "CONFIRMATION_REQUIRED", 2);
    }
    await withApp(async (app) => {
      await app.deleteTask(taskId);
      print({ removed: true, task: taskId }, options.json, `Removed task ${human(taskId)}`);
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
  .description("Continue the latest resumable planning or implementation stage")
  .argument("<task-id>")
  .option("--json", "print machine-readable JSON")
  .action(async (taskId, options) => {
    await withApp(async (app) => {
      await app.resumeTask(taskId);
      const task = await app.getTask(taskId);
      print(task, options.json, `Queued ${taskId} to continue its latest retained agent stage`);
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
        }
        if (options.json) {
          for (const event of events) console.log(JSON.stringify(event));
        } else {
          for (const entry of activityEntries(events)) {
            console.log(`${entry.marker} ${entry.title}`);
            for (const [index, detail] of entry.details.entries()) {
              console.log(`  ${index === 0 ? "└ " : "  "}${detail}`);
            }
          }
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
  .description("Remove a retained worktree from a terminal task")
  .argument("<task-id>")
  .option("--force", "discard uncommitted worktree changes")
  .option("--yes", "confirm removal")
  .option("--json", "print machine-readable JSON")
  .action(async (taskId, options) => {
    if (!options.yes)
      throw new AgentQError("Worktree removal requires --yes", "CONFIRMATION_REQUIRED", 2);
    await withApp(async (app) => {
      const result = await app.cleanTask(taskId, { force: options.force });
      print(result, options.json, `Removed ${human(result.removedWorktree)}`);
    });
  });

program
  .command("run")
  .description("Run the foreground parallel-agent supervisor")
  .argument("[queue]", "optional queue name or id")
  .option("--all", "run queues from every repository")
  .option("--once", "drain currently runnable tasks, then exit")
  .option("-c, --concurrency <number>", "global concurrent agents", positiveInteger)
  .action(async (queueRef, options) => {
    await withApp(async (app) => {
      if (options.all) await app.setAllRepositories(true);
      console.log(`agentq supervisor started${queueRef ? ` for ${human(queueRef)}` : ""}`);
      const queueId = queueRef ? (await app.getQueue(queueRef)).id : undefined;
      const controller = signalController();
      const supervisor = new Supervisor(app, {
        queue: queueId,
        repoKey: queueId ? undefined : app.activeRepositoryKey,
        maxConcurrency: options.concurrency,
      });
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
    await withApp((app) => app.loginProvider(providerName));
  });

program
  .command("integrate")
  .description("Teach Codex and/or Claude Code how to add tasks to agentq")
  .argument("<target>", "codex, claude, or all", parseIntegrationTarget)
  .option("-r, --repo <path>", "repository to update", process.cwd())
  .option("--json", "print machine-readable JSON")
  .action(async (target: IntegrationTarget, options) => {
    await withApp(async (app) => {
      const results = await app.installIntegration(target, options.repo);
      if (options.json) printJson(results);
      else
        for (const result of results) console.log(`${human(result.action)}: ${human(result.file)}`);
    });
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
    const supervisor = new Supervisor(app, { repoKey: () => app.activeRepositoryKey });
    const running = supervisor.run({ signal: controller.signal });
    const supervised = running.then(
      () => ({ kind: "supervisor" as const }),
      (error: unknown) => ({ kind: "supervisor-error" as const, error }),
    );
    const instance = renderAgentq(app, {
      scopeLabel: app.repositoryContext
        ? `${app.repositoryContext.displayName} · ${app.repositoryContext.rootPath}`
        : "all repositories",
    });
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
  await app.setRepositoryScope(await findRepositoryContext(process.cwd()));
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

function collectOptional(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
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
