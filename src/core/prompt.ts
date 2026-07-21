import type { Queue, Task } from "./types.ts";

export function buildTaskPrompt(task: Task, queue: Queue): string {
  const acceptance = task.acceptanceCriteria.length
    ? task.acceptanceCriteria.map((criterion, index) => `${index + 1}. ${criterion}`).join("\n")
    : "No additional acceptance criteria were supplied. Derive appropriate verification from the repository.";

  return `You are the implementation agent for an agentq task.

Task ID: ${task.id}
Queue: ${queue.name}
Repository: ${queue.repoPath}
Title: ${task.title}

Instructions:
${task.instructions || task.title}

Acceptance criteria:
${acceptance}

Execution contract:
- Work only in the current isolated Git worktree and current branch. Do not create, remove, or switch worktrees.
- Inspect the repository instructions before editing. Implement the complete task, including relevant tests and documentation.
- Run the most relevant verification available in the repository before finishing.
- Do not push, merge, open a pull request, or modify the source checkout. agentq owns lifecycle operations.
- If you discover a genuinely independent follow-up task, you may enqueue it with the agentq CLI. Use the queue in $AGENTQ_QUEUE and do not recursively enqueue the task you are currently executing.
- Finish with a concise summary of changes, verification performed, and any remaining risk. A successful response without the requested repository changes is a failure.
`;
}

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

Inside an agentq-managed run, \`AGENTQ_QUEUE\`, \`AGENTQ_TASK_ID\`, and \`AGENTQ_RUN_ID\` are set. Tasks created there are automatically linked to their parent task. Do not enqueue duplicates or recursively enqueue the current task.
`;
