import { describe, expect, test } from "bun:test";
import { buildImplementationPrompt, buildPlanningPrompt } from "../src/core/prompt.ts";
import type { Queue, Task } from "../src/core/types.ts";

const now = "2026-07-22T12:00:00.000Z";

const queue: Queue = {
  id: "queue-1",
  name: "delivery",
  repoKey: "/repo/.git",
  repoPath: "/repo",
  baseRef: "main",
  defaultProvider: "codex",
  planModel: "planner-model",
  planInstructions: "Trace the current data flow before choosing files.",
  implementModel: "implementation-model",
  implementInstructions: "Keep public APIs stable and add focused tests.",
  concurrency: 2,
  maxAttempts: 2,
  verifyCommands: ["bun test"],
  autoCommit: true,
  allowedPaths: ["src/**", "test/**"],
  deniedPaths: ["src/api/**"],
  maxChangedFiles: 20,
  approvalCheckpoints: [],
  baseDriftPolicy: "replan",
  landStrategy: "none",
  autoLand: false,
  fileConcurrency: "off",
  createdAt: now,
  updatedAt: now,
};

const task: Task = {
  id: "task-1",
  queueId: queue.id,
  title: "Fix redirects",
  instructions: "Stop expired sessions from redirecting in a loop.",
  acceptanceCriteria: ["A regression test covers the expired session"],
  objective: "Stop expired sessions from redirecting in a loop.",
  invariants: ["The public session API remains stable"],
  handoffRequirements: ["Explain the redirect ownership boundary"],
  blockedBy: ["task-auth-seam"],
  expectedPaths: ["src/session.ts", "test/session.test.ts"],
  allowedPaths: ["src/session.ts", "test/session.test.ts"],
  deniedPaths: ["test/api/**"],
  maxChangedFiles: 10,
  verifyCommands: ["bun run lint"],
  approvalCheckpoints: [],
  baseDriftPolicy: "replan",
  landStrategy: "none",
  provider: "codex",
  priority: 0,
  status: "running",
  currentPhase: "implement",
  deliveryStatus: "not_started",
  changedFiles: [],
  verificationResults: [],
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  sourceKind: "manual",
  attemptCount: 1,
  createdAt: now,
  updatedAt: now,
};

describe("pipeline prompts", () => {
  test("asks a custom planning agent for a concrete read-only repository handoff", () => {
    const prompt = buildPlanningPrompt(task, queue);

    expect(prompt).toContain("planning agent");
    expect(prompt).toContain("Stop expired sessions from redirecting in a loop.");
    expect(prompt).toContain("Trace the current data flow before choosing files.");
    expect(prompt).toContain("specific files and symbols");
    expect(prompt).toContain("The public session API remains stable");
    expect(prompt).toContain("task-auth-seam");
    expect(prompt).toContain("src/api/**");
    expect(prompt).toContain("Maximum changed files:\n10");
    expect(prompt).toContain("bun test");
    expect(prompt).toContain("bun run lint");
    expect(prompt).toContain("Explain the redirect ownership boundary");
    expect(prompt).toContain("Do not modify files");
    expect(prompt).not.toContain("/plan");
  });

  test("passes the planner handoff and implementation guidance to a fresh implementer", () => {
    const handoff = "Update src/session.ts and cover the redirect guard in test/session.test.ts.";
    const prompt = buildImplementationPrompt(task, queue, handoff);

    expect(prompt).toContain("implementation agent");
    expect(prompt).toContain("Keep public APIs stable and add focused tests.");
    expect(prompt).toContain(handoff);
    expect(prompt).toContain("src/session.ts");
    expect(prompt).toContain("test/api/**");
    expect(prompt).toContain("The public session API remains stable");
    expect(prompt).toContain("original task and acceptance criteria remain authoritative");
  });

  test("refuses to construct an implementation prompt without a planner handoff", () => {
    expect(() => buildImplementationPrompt(task, queue, "   ")).toThrow(
      "without a planner handoff",
    );
  });
});
