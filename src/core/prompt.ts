import { AgentQError } from "./errors.ts";
import type { Queue, Task } from "./types.ts";

function acceptanceCriteria(task: Task): string {
  return task.acceptanceCriteria.length
    ? task.acceptanceCriteria.map((criterion, index) => `${index + 1}. ${criterion}`).join("\n")
    : "No additional acceptance criteria were supplied. Derive appropriate verification from the repository.";
}

function bullets(values: readonly string[], empty: string): string {
  return values.length > 0 ? values.map((value) => `- ${value}`).join("\n") : empty;
}

function structuredSpecification(task: Task, queue: Queue): string {
  const effectiveVerification = [...queue.verifyCommands, ...task.verifyCommands];
  return `Objective:
${task.objective}

Invariants:
${bullets(task.invariants, "- No additional invariants were supplied.")}

Dependency blockers:
${bullets(task.blockedBy, "- None.")}

Expected paths:
${bullets(task.expectedPaths, "- Not declared; determine them from repository evidence.")}

Allowed path scopes:
${bullets(
  [...queue.allowedPaths, ...task.allowedPaths],
  "- Unrestricted except for denied path scopes.",
)}

Denied path scopes:
${bullets([...queue.deniedPaths, ...task.deniedPaths], "- None.")}

Maximum changed files:
${task.maxChangedFiles ?? queue.maxChangedFiles ?? "No explicit limit."}

Mandatory verification:
${bullets(effectiveVerification, "- Derive the appropriate repository checks.")}

Handoff requirements:
${bullets(task.handoffRequirements, "- No additional handoff requirements were supplied.")}`;
}

export function buildPlanningPrompt(task: Task, queue: Queue): string {
  const guidance =
    queue.planInstructions.trim() || "No additional queue-level planning guidance was supplied.";

  return `You are the planning agent for an agentq task. Your only job is to inspect the repository and produce a precise handoff for a separate implementation agent.

Task ID: ${task.id}
Queue: ${queue.name}
Repository: ${queue.repoPath}
Title: ${task.title}

Original instructions:
${task.instructions || task.title}

Structured task specification:
${structuredSpecification(task, queue)}

Acceptance criteria:
${acceptanceCriteria(task)}

Queue planning guidance:
${guidance}

Planning contract:
- Inspect repository instructions, relevant code, tests, configuration, and history when useful.
- Work out what actually needs to change. Name specific files and symbols, explain the intended edits, and identify important dependencies or edge cases.
- Give the implementation agent an ordered, self-contained plan plus concrete verification commands or test targets.
- Resolve ambiguity using repository evidence. Clearly label any remaining uncertainty or risk.
- Do not modify files, create commits, or perform the implementation. The worktree must remain Git-clean.
- Do not invoke another agent or use a provider-specific planning mode.
- Return only the implementation handoff. Make it detailed enough that a fresh agent can execute it without access to this conversation.
`;
}

export function buildImplementationPrompt(task: Task, queue: Queue, planOutput: string): string {
  const acceptance = task.acceptanceCriteria.length
    ? task.acceptanceCriteria.map((criterion, index) => `${index + 1}. ${criterion}`).join("\n")
    : "No additional acceptance criteria were supplied. Derive appropriate verification from the repository.";
  const guidance =
    queue.implementInstructions.trim() ||
    "No additional queue-level implementation guidance was supplied.";
  const handoff = planOutput.trim();
  if (!handoff) {
    throw new AgentQError(
      "Implementation cannot start without a planner handoff",
      "EMPTY_PLAN_OUTPUT",
    );
  }

  return `You are the implementation agent for an agentq task.

Task ID: ${task.id}
Queue: ${queue.name}
Repository: ${queue.repoPath}
Title: ${task.title}

Instructions:
${task.instructions || task.title}

Structured task specification:
${structuredSpecification(task, queue)}

Acceptance criteria:
${acceptance}

Queue implementation guidance:
${guidance}

Planner handoff:
--- BEGIN PLANNER HANDOFF ---
${handoff}
--- END PLANNER HANDOFF ---

Execution contract:
- Use the planner handoff as repository-specific guidance, but the original task and acceptance criteria remain authoritative.
- Work only in the current isolated Git worktree and current branch. Do not create, remove, or switch worktrees.
- Inspect the repository instructions before editing. Implement the complete task, including relevant tests and documentation.
- Run the most relevant verification available in the repository before finishing.
- Do not push, merge, open a pull request, or modify the source checkout. agentq owns lifecycle operations.
- If you discover a genuinely independent follow-up task, you may enqueue it with the agentq CLI. Use the queue in $AGENTQ_QUEUE and do not recursively enqueue the task you are currently executing.
- Finish with a concise summary of changes, verification performed, and any remaining risk. A successful response without the requested repository changes is a failure.
`;
}

/** @deprecated Use buildImplementationPrompt for the implementation phase. */
export const buildTaskPrompt = buildImplementationPrompt;

export const AGENT_INTEGRATION_TEXT = `## agentq task queues

This repository uses [agentq](https://github.com/Luke-Pitstick/agentq) for durable coding-agent task queues.

When asked to record or delegate follow-up work, use the installed CLI rather than keeping an informal TODO:

\`\`\`bash
agentq task add --queue <queue> --title "Short task title" --instructions "Complete, standalone instructions" --provider codex
\`\`\`

For machine-generated tasks, prefer JSON on stdin:

\`\`\`bash
printf '%s' '{"queue":"<queue>","title":"Short task title","instructions":"Complete instructions","provider":"claude","idempotencyKey":"stable-key"}' | agentq task add --stdin-json
\`\`\`

Inside an agentq-managed run, \`AGENTQ_QUEUE\`, \`AGENTQ_TASK_ID\`, \`AGENTQ_RUN_ID\`, and \`AGENTQ_STAGE\` are set. \`AGENTQ_STAGE\` is either \`plan\` or \`implement\`; only the implementation agent receives the managed child-task intake. Tasks created there are automatically linked to their parent task. Do not enqueue duplicates or recursively enqueue the current task.
`;
