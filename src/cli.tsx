#!/usr/bin/env node

import { resolve } from "node:path";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { z } from "zod";
import {
  AgentQApp,
  type QueueDeliverySnapshot,
  type QueueLandingOutcome,
  type TaskIntegrationOutcome,
} from "./app.ts";
import { AgentQError, errorMessage } from "./core/errors.ts";
import { resolvePaths } from "./core/paths.ts";
import { readStdin, sleep } from "./core/runtime.ts";
import {
  type AddTaskInput,
  BASE_DRIFT_POLICIES,
  type BaseDriftPolicy,
  FILE_CONCURRENCY_MODES,
  type FileConcurrencyMode,
  LAND_STRATEGIES,
  type LandStrategy,
  PROVIDERS,
  type Provider,
  TASK_STATUSES,
} from "./core/types.ts";
import { findRepositoryContext } from "./git/repository.ts";
import { submitDelegatedTask } from "./intake/delegated-tasks.ts";
import type { IntegrationTarget } from "./integrations/instructions.ts";
import { Supervisor } from "./supervisor/supervisor.ts";
import { activityEntries } from "./ui/activity.ts";
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
  .option("--allow-path <glob>", "allowed repository path; repeatable", collect, [])
  .option("--deny-path <glob>", "forbidden repository path; repeatable", collect, [])
  .option(
    "--max-changed-files <number>",
    "maximum number of changed files per task",
    positiveInteger,
  )
  .option("--checkpoint <name>", "required approval checkpoint; repeatable", collect, [])
  .option(
    "--base-drift <policy>",
    "stale-base policy: rebase, replan, or fail",
    parseBaseDriftPolicy,
  )
  .option(
    "--land-strategy <strategy>",
    "delivery strategy: none, stack, or merge-train",
    parseLandStrategy,
  )
  .option("--auto-land", "land integrated results automatically")
  .option(
    "--file-concurrency <mode>",
    "file-overlap policy: off, advisory, or enforced",
    parseFileConcurrency,
  )
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
        allowedPaths: options.allowPath,
        deniedPaths: options.denyPath,
        maxChangedFiles: options.maxChangedFiles,
        approvalCheckpoints: options.checkpoint,
        baseDriftPolicy: options.baseDrift,
        landStrategy: options.landStrategy,
        autoLand: options.autoLand,
        fileConcurrency: options.fileConcurrency,
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
  .option("--allow-path <glob>", "replace allowed repository paths; repeatable", collectOptional)
  .option("--clear-allowed-paths", "remove all allowed repository paths")
  .option("--deny-path <glob>", "replace forbidden repository paths; repeatable", collectOptional)
  .option("--clear-denied-paths", "remove all forbidden repository paths")
  .option(
    "--max-changed-files <number>",
    "replace the maximum number of changed files",
    positiveInteger,
  )
  .option("--clear-max-changed-files", "remove the changed-file limit")
  .option("--checkpoint <name>", "replace approval checkpoints; repeatable", collectOptional)
  .option("--clear-checkpoints", "remove all approval checkpoints")
  .option(
    "--base-drift <policy>",
    "replace stale-base policy: rebase, replan, or fail",
    parseBaseDriftPolicy,
  )
  .option(
    "--land-strategy <strategy>",
    "replace delivery strategy: none, stack, or merge-train",
    parseLandStrategy,
  )
  .option("--auto-land", "land integrated results automatically")
  .option("--no-auto-land", "require explicit queue landing")
  .option(
    "--file-concurrency <mode>",
    "replace file-overlap policy: off, advisory, or enforced",
    parseFileConcurrency,
  )
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
    if (options.maxChangedFiles !== undefined && options.clearMaxChangedFiles) {
      throw new AgentQError(
        "Use either --max-changed-files or --clear-max-changed-files, not both",
        "INVALID_QUEUE_EDIT",
        2,
      );
    }
    const listConflicts = [
      [options.allowPath, options.clearAllowedPaths, "--allow-path", "--clear-allowed-paths"],
      [options.denyPath, options.clearDeniedPaths, "--deny-path", "--clear-denied-paths"],
      [options.checkpoint, options.clearCheckpoints, "--checkpoint", "--clear-checkpoints"],
    ] as const;
    const listConflict = listConflicts.find(([value, clear]) => value !== undefined && clear);
    if (listConflict) {
      throw new AgentQError(
        `Use either ${listConflict[2]} or ${listConflict[3]}, not both`,
        "INVALID_QUEUE_EDIT",
        2,
      );
    }
    const patch = {
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
      allowedPaths: options.clearAllowedPaths ? [] : (options.allowPath as string[] | undefined),
      deniedPaths: options.clearDeniedPaths ? [] : (options.denyPath as string[] | undefined),
      maxChangedFiles: options.clearMaxChangedFiles
        ? null
        : (options.maxChangedFiles as number | undefined),
      approvalCheckpoints: options.clearCheckpoints
        ? []
        : (options.checkpoint as string[] | undefined),
      baseDriftPolicy: options.baseDrift as BaseDriftPolicy | undefined,
      landStrategy: options.landStrategy as LandStrategy | undefined,
      autoLand: options.autoLand as boolean | undefined,
      fileConcurrency: options.fileConcurrency as FileConcurrencyMode | undefined,
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
  .command("delivery")
  .description("Show the integration lane, task delivery states, and recent operations")
  .argument("<queue>", "queue name or id")
  .option("--json", "print machine-readable JSON")
  .action(async (queueRef, options) => {
    await withApp(async (app) => {
      const found = await app.getQueue(queueRef);
      const delivery = await app.getQueueDelivery(found.id);
      if (options.json) return printJson(delivery);
      printQueueDelivery(found.name, delivery);
    });
  });

queue
  .command("land")
  .description("Atomically land a queue's verified integration train on its target branch")
  .argument("<queue>", "queue name or id")
  .option("--yes", "confirm landing the integration train")
  .option("--json", "print machine-readable JSON")
  .action(async (queueRef, options) => {
    if (!options.yes) {
      throw new AgentQError("Queue landing requires --yes", "CONFIRMATION_REQUIRED", 2);
    }
    const controller = signalController();
    try {
      await withApp(async (app) => {
        const outcome = await app.landQueue(queueRef, controller.signal);
        print(outcome, options.json, landingOutcomeMessage(queueRef, outcome));
      });
    } finally {
      controller.abort("Queue landing command completed");
    }
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
  .option("--objective <text>", "structured task objective")
  .option("--blocked-by <task-id>", "blocking task id; repeatable", collect, [])
  .option("--invariant <text>", "invariant the change must preserve; repeatable", collect, [])
  .option("--allow-path <glob>", "allowed repository path; repeatable", collect, [])
  .option("--deny-path <glob>", "forbidden repository path; repeatable", collect, [])
  .option("--expected-path <glob>", "expected changed path; repeatable", collect, [])
  .option("--max-changed-files <number>", "maximum number of changed files", positiveInteger)
  .option("--verify <command>", "task-specific verification command; repeatable", collect, [])
  .option("--checkpoint <name>", "required approval checkpoint; repeatable", collect, [])
  .option(
    "--base-drift <policy>",
    "stale-base policy: rebase, replan, or fail",
    parseBaseDriftPolicy,
  )
  .option(
    "--land-strategy <strategy>",
    "delivery strategy: none, stack, or merge-train",
    parseLandStrategy,
  )
  .option("--handoff <text>", "handoff requirement; repeatable", collect, [])
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
          objective: options.objective,
          blockedBy: options.blockedBy,
          invariants: options.invariant,
          allowedPaths: options.allowPath,
          deniedPaths: options.denyPath,
          expectedPaths: options.expectedPath,
          maxChangedFiles: options.maxChangedFiles,
          verifyCommands: options.verify,
          approvalCheckpoints: options.checkpoint,
          baseDriftPolicy: options.baseDrift,
          landStrategy: options.landStrategy,
          handoffRequirements: options.handoff,
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
  .command("graph")
  .description("Show the task dependency graph")
  .option("-q, --queue <queue>", "filter by queue")
  .option("--json", "print machine-readable JSON")
  .action(async (options) => {
    await withApp(async (app) => {
      const queueId = options.queue ? (await app.getQueue(options.queue)).id : undefined;
      const tasks = [...(await app.listTasks(queueId))].sort((left, right) =>
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
      );
      const nodeIds = new Set(tasks.map(({ id }) => id));
      const nodes = tasks.map(
        ({ id, title, status, currentPhase, deliveryStatus, queueId, queueName }) => ({
          id,
          title,
          status,
          currentPhase,
          deliveryStatus,
          queueId,
          ...(queueName ? { queueName } : {}),
        }),
      );
      const edges = tasks
        .flatMap((dependent) =>
          dependent.blockedBy
            .filter((blockerId) => nodeIds.has(blockerId))
            .map((blockerId) => ({ from: blockerId, to: dependent.id })),
        )
        .sort((left, right) => {
          if (left.from !== right.from) return left.from < right.from ? -1 : 1;
          return left.to < right.to ? -1 : left.to > right.to ? 1 : 0;
        });
      if (options.json) return printJson({ nodes, edges });
      if (nodes.length === 0) return console.log("No matching tasks.");
      console.log("ID\tSTATUS\tPHASE\tBLOCKED BY\tTITLE");
      for (const item of tasks) {
        console.log(
          `${item.id}\t${item.status}\t${item.currentPhase}\t${item.blockedBy.join(",") || "-"}\t${human(item.title)}`,
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
  .command("approvals")
  .description("List durable approval checkpoints for a task")
  .argument("<task-id>")
  .option("--json", "print machine-readable JSON")
  .action(async (taskId, options) => {
    await withApp(async (app) => {
      const approvals = await app.listTaskApprovals(taskId);
      if (options.json) return printJson(approvals);
      if (approvals.length === 0) return console.log("No approval checkpoints.");
      console.log("CHECKPOINT\tSTATUS\tACTOR\tDECIDED");
      for (const approval of approvals) {
        console.log(
          [
            human(approval.checkpoint),
            approval.status,
            approval.actor ? human(approval.actor) : "-",
            approval.decidedAt ?? "-",
          ].join("\t"),
        );
      }
    });
  });

task
  .command("integrate")
  .description("Verify and add a completed task result to its queue's integration train")
  .argument("<task-id>")
  .option("--json", "print machine-readable JSON")
  .action(async (taskId, options) => {
    const controller = signalController();
    try {
      await withApp(async (app) => {
        const outcome = await app.integrateTask(taskId, controller.signal);
        print(outcome, options.json, integrationOutcomeMessage(taskId, outcome));
        if (!["integrated", "already-integrated"].includes(outcome.status)) process.exitCode = 1;
      });
    } finally {
      controller.abort("Task integration command completed");
    }
  });

task
  .command("approve")
  .description("Approve a pending task checkpoint")
  .argument("<task-id>")
  .argument("<checkpoint>")
  .option("--actor <name>", "record who approved the checkpoint", "cli")
  .option("--note <text>", "record an approval note")
  .option("--json", "print machine-readable JSON")
  .action(async (taskId, checkpoint, options) => {
    await withApp(async (app) => {
      const approval = await app.approveTaskCheckpoint(taskId, checkpoint, {
        actor: options.actor,
        note: options.note,
      });
      print(approval, options.json, `Approved ${human(checkpoint)} for ${human(taskId)}`);
    });
  });

task
  .command("reject")
  .description("Reject a pending task checkpoint and stop the task")
  .argument("<task-id>")
  .argument("<checkpoint>")
  .option("--actor <name>", "record who rejected the checkpoint", "cli")
  .option("--note <text>", "record why the checkpoint was rejected")
  .option("--yes", "confirm checkpoint rejection")
  .option("--json", "print machine-readable JSON")
  .action(async (taskId, checkpoint, options) => {
    if (!options.yes) {
      throw new AgentQError("Checkpoint rejection requires --yes", "CONFIRMATION_REQUIRED", 2);
    }
    await withApp(async (app) => {
      const approval = await app.rejectTaskCheckpoint(taskId, checkpoint, {
        actor: options.actor,
        note: options.note,
      });
      print(approval, options.json, `Rejected ${human(checkpoint)} for ${human(taskId)}`);
    });
  });

task
  .command("edit")
  .description("Edit a queued or retryable task")
  .argument("<task-id>")
  .option("--title <title>", "replace the task title")
  .option("--instructions <text>", "replace the complete task instructions")
  .option("--objective <text>", "replace the structured task objective")
  .option("--blocked-by <task-id>", "replace blocking task ids; repeatable", collectOptional)
  .option("--clear-blockers", "remove all blocking task ids")
  .option("--invariant <text>", "replace invariants; repeatable", collectOptional)
  .option("--clear-invariants", "remove all invariants")
  .option("--allow-path <glob>", "replace allowed repository paths; repeatable", collectOptional)
  .option("--clear-allowed-paths", "remove all task-specific allowed paths")
  .option("--deny-path <glob>", "replace forbidden repository paths; repeatable", collectOptional)
  .option("--clear-denied-paths", "remove all task-specific forbidden paths")
  .option("--expected-path <glob>", "replace expected changed paths; repeatable", collectOptional)
  .option("--clear-expected-paths", "remove all expected changed paths")
  .option(
    "--max-changed-files <number>",
    "replace the maximum number of changed files",
    positiveInteger,
  )
  .option("--clear-max-changed-files", "remove the task-specific changed-file limit")
  .option("--verify <command>", "replace task-specific verification commands", collectOptional)
  .option("--clear-verify", "remove all task-specific verification commands")
  .option("--checkpoint <name>", "replace approval checkpoints; repeatable", collectOptional)
  .option("--clear-checkpoints", "remove all approval checkpoints")
  .option(
    "--base-drift <policy>",
    "replace stale-base policy: rebase, replan, or fail",
    parseBaseDriftPolicy,
  )
  .option(
    "--land-strategy <strategy>",
    "replace delivery strategy: none, stack, or merge-train",
    parseLandStrategy,
  )
  .option("--handoff <text>", "replace handoff requirements; repeatable", collectOptional)
  .option("--clear-handoff", "remove all handoff requirements")
  .option("-p, --provider <provider>", "replace the provider", parseProvider)
  .option("--priority <number>", "replace the scheduling priority", integer)
  .option("--accept <criterion>", "replace acceptance criteria; repeatable", collectOptional)
  .option("--clear-acceptance", "remove all acceptance criteria")
  .option("--json", "print machine-readable JSON")
  .action(async (taskId, options) => {
    const conflicts = [
      [options.accept, options.clearAcceptance, "--accept", "--clear-acceptance"],
      [options.blockedBy, options.clearBlockers, "--blocked-by", "--clear-blockers"],
      [options.invariant, options.clearInvariants, "--invariant", "--clear-invariants"],
      [options.allowPath, options.clearAllowedPaths, "--allow-path", "--clear-allowed-paths"],
      [options.denyPath, options.clearDeniedPaths, "--deny-path", "--clear-denied-paths"],
      [
        options.expectedPath,
        options.clearExpectedPaths,
        "--expected-path",
        "--clear-expected-paths",
      ],
      [options.verify, options.clearVerify, "--verify", "--clear-verify"],
      [options.checkpoint, options.clearCheckpoints, "--checkpoint", "--clear-checkpoints"],
      [options.handoff, options.clearHandoff, "--handoff", "--clear-handoff"],
    ] as const;
    const conflict = conflicts.find(([value, clear]) => value !== undefined && clear);
    if (conflict) {
      throw new AgentQError(
        `Use either ${conflict[2]} or ${conflict[3]}, not both`,
        "INVALID_TASK_EDIT",
        2,
      );
    }
    if (options.maxChangedFiles !== undefined && options.clearMaxChangedFiles) {
      throw new AgentQError(
        "Use either --max-changed-files or --clear-max-changed-files, not both",
        "INVALID_TASK_EDIT",
        2,
      );
    }
    const patch = {
      title: options.title as string | undefined,
      instructions: options.instructions as string | undefined,
      objective: options.objective as string | undefined,
      acceptanceCriteria: options.clearAcceptance ? [] : (options.accept as string[] | undefined),
      blockedBy: options.clearBlockers ? [] : (options.blockedBy as string[] | undefined),
      invariants: options.clearInvariants ? [] : (options.invariant as string[] | undefined),
      allowedPaths: options.clearAllowedPaths ? [] : (options.allowPath as string[] | undefined),
      deniedPaths: options.clearDeniedPaths ? [] : (options.denyPath as string[] | undefined),
      expectedPaths: options.clearExpectedPaths
        ? []
        : (options.expectedPath as string[] | undefined),
      maxChangedFiles: options.clearMaxChangedFiles
        ? null
        : (options.maxChangedFiles as number | undefined),
      verifyCommands: options.clearVerify ? [] : (options.verify as string[] | undefined),
      approvalCheckpoints: options.clearCheckpoints
        ? []
        : (options.checkpoint as string[] | undefined),
      baseDriftPolicy: options.baseDrift as BaseDriftPolicy | undefined,
      landStrategy: options.landStrategy as LandStrategy | undefined,
      handoffRequirements: options.clearHandoff ? [] : (options.handoff as string[] | undefined),
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
        await sleep(500);
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
  objective: z.string().min(1).optional(),
  invariants: z.array(z.string().min(1)).optional(),
  handoffRequirements: z.array(z.string().min(1)).optional(),
  blockedBy: z.array(z.string().min(1)).optional(),
  expectedPaths: z.array(z.string().min(1)).optional(),
  allowedPaths: z.array(z.string().min(1)).optional(),
  deniedPaths: z.array(z.string().min(1)).optional(),
  maxChangedFiles: z.number().int().positive().optional(),
  verifyCommands: z.array(z.string().min(1)).optional(),
  approvalCheckpoints: z.array(z.string().min(1)).optional(),
  baseDriftPolicy: z.enum(BASE_DRIFT_POLICIES).optional(),
  landStrategy: z.enum(LAND_STRATEGIES).optional(),
  provider: z.enum(PROVIDERS).optional(),
  priority: z.number().int().optional(),
  idempotencyKey: z.string().min(1).optional(),
});

async function readTaskJson(): Promise<z.infer<typeof taskJsonSchema>> {
  const text = await readStdin();
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

function parseBaseDriftPolicy(value: string): BaseDriftPolicy {
  if (BASE_DRIFT_POLICIES.includes(value as BaseDriftPolicy)) return value as BaseDriftPolicy;
  throw new InvalidArgumentError(`Expected one of: ${BASE_DRIFT_POLICIES.join(", ")}.`);
}

function parseLandStrategy(value: string): LandStrategy {
  if (LAND_STRATEGIES.includes(value as LandStrategy)) return value as LandStrategy;
  throw new InvalidArgumentError(`Expected one of: ${LAND_STRATEGIES.join(", ")}.`);
}

function parseFileConcurrency(value: string): FileConcurrencyMode {
  if (FILE_CONCURRENCY_MODES.includes(value as FileConcurrencyMode)) {
    return value as FileConcurrencyMode;
  }
  throw new InvalidArgumentError(`Expected one of: ${FILE_CONCURRENCY_MODES.join(", ")}.`);
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

function printQueueDelivery(queueName: string, delivery: QueueDeliverySnapshot): void {
  console.log(`DELIVERY\t${human(queueName)}`);
  if (delivery.lane) {
    console.log(
      [
        "LANE",
        human(delivery.lane.targetRef),
        human(delivery.lane.trainRef),
        shortSha(delivery.lane.headSha),
        `generation ${delivery.lane.generation}`,
      ].join("\t"),
    );
  } else {
    console.log("LANE\tNot created");
  }

  const artifactByTask = new Map(delivery.artifacts.map((artifact) => [artifact.taskId, artifact]));
  console.log("TASK\tDELIVERY\tPHASE\tBRANCH\tBASE\tRESULT\tTITLE");
  for (const task of delivery.tasks) {
    const artifact = artifactByTask.get(task.id);
    console.log(
      [
        human(task.id),
        task.deliveryStatus,
        task.currentPhase,
        task.integrationBranch ? human(task.integrationBranch) : "-",
        artifact?.baseSha
          ? shortSha(artifact.baseSha)
          : task.createdBaseSha
            ? shortSha(task.createdBaseSha)
            : "-",
        task.integratedSha
          ? shortSha(task.integratedSha)
          : task.resultCommitSha
            ? shortSha(task.resultCommitSha)
            : "-",
        human(task.title),
      ].join("\t"),
    );
  }

  const operations = delivery.operations.slice(-10);
  if (operations.length === 0) {
    console.log("OPERATIONS\tNone");
    return;
  }
  console.log("OPERATION\tSTATUS\tTASK\tCONFLICTS\tERROR");
  for (const operation of operations) {
    console.log(
      [
        operation.kind,
        operation.status,
        operation.taskId ? human(operation.taskId) : "-",
        operation.conflictFiles.length > 0 ? operation.conflictFiles.map(human).join(",") : "-",
        operation.error ? human(operation.error) : "-",
      ].join("\t"),
    );
  }
}

function integrationOutcomeMessage(taskId: string, outcome: TaskIntegrationOutcome): string {
  switch (outcome.status) {
    case "integrated":
      return `Integrated ${human(taskId)} at ${shortSha(outcome.integratedSha)} on lane ${human(outcome.laneId)}`;
    case "already-integrated":
      return `${human(taskId)} is already integrated at ${shortSha(outcome.integratedSha)} on lane ${human(outcome.laneId)}`;
    case "conflict":
      return `Integration conflict for ${human(taskId)}: ${outcome.conflictPaths.map(human).join(", ") || "unknown paths"}`;
    case "verification-failed":
      return `Integration verification failed for ${human(taskId)} (${outcome.failureClass})`;
    case "contended":
      return `Integration deferred for ${human(taskId)}: ${human(outcome.message)}`;
  }
}

function landingOutcomeMessage(queueRef: string, outcome: QueueLandingOutcome): string {
  if (outcome.status === "already-landed") {
    return `${human(queueRef)} is already landed at ${shortSha(outcome.landedSha)}`;
  }
  const taskLabel = outcome.artifactIds.length === 1 ? "task result" : "task results";
  return `Landed ${outcome.artifactIds.length} ${taskLabel} from ${human(queueRef)} at ${shortSha(outcome.landedSha)}`;
}

function shortSha(value: string): string {
  return human(value.slice(0, 12));
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
