import { describe, expect, test } from "bun:test";
import type { TaskEvent } from "../src/core/types.ts";
import { activityEntries } from "../src/ui/activity.ts";

const event = (
  id: number,
  kind: string,
  payload: Record<string, unknown>,
  runId = "run-1",
): TaskEvent => ({
  id,
  taskId: "task-1",
  runId,
  kind,
  payload,
  createdAt: "2026-07-22T00:00:00.000Z",
});

describe("activityEntries workflow stages", () => {
  test("renders the active planning stage without a redundant run-start row", () => {
    const entries = activityEntries([
      event(1, "workflow.phase", {
        phase: "plan",
        state: "started",
        provider: "codex",
        model: "gpt-5.6-planner",
      }),
      event(2, "run.started", {
        phase: "plan",
        provider: "codex",
        model: "gpt-5.6-planner",
      }),
    ]);

    expect(entries).toEqual([
      expect.objectContaining({
        marker: "›",
        title: "Planning with Codex · gpt-5.6-planner",
        tone: "active",
      }),
    ]);
  });

  test("folds completed phase events into concise stage summaries", () => {
    const entries = activityEntries([
      event(10, "workflow.phase", {
        phase: "plan",
        state: "started",
        provider: "codex",
        model: "gpt-5.6-planner",
      }),
      event(11, "workflow.phase", {
        phase: "plan",
        state: "completed",
        summary: "Update src/session.ts, then run the redirect regression test.",
      }),
      event(12, "workflow.phase", {
        phase: "implement",
        state: "started",
        provider: "codex",
        model: "gpt-5.6-builder",
      }),
      event(13, "workflow.phase", {
        phase: "implement",
        state: "completed",
        summary: "Updated the redirect guard and its regression coverage.",
      }),
    ]);

    expect(entries).toEqual([
      expect.objectContaining({
        marker: "✓",
        title: "Plan ready",
        details: ["Update src/session.ts, then run the redirect regression test."],
        tone: "success",
      }),
      expect.objectContaining({
        marker: "•",
        title: "Implementation agent finished",
        details: ["Updated the redirect guard and its regression coverage."],
        tone: "default",
      }),
    ]);
  });

  test("does not repeat a provider's final message under the completed stage", () => {
    const plan = "Update src/session.ts and run the redirect regression test.";
    const entries = activityEntries([
      event(14, "workflow.phase", { phase: "plan", state: "started" }),
      event(15, "executor.assistant", { type: "assistant", phase: "plan", text: plan }),
      event(16, "workflow.phase", { phase: "plan", state: "completed", summary: plan }),
    ]);

    expect(entries).toEqual([
      expect.objectContaining({ title: "Plan ready", details: [] }),
      expect.objectContaining({ title: plan }),
    ]);
  });

  test("keeps successful-run metadata without repeating the implementation summary", () => {
    const summary = "Updated the redirect guard and its regression coverage.";
    const entries = activityEntries([
      event(17, "executor.assistant", {
        type: "assistant",
        phase: "implement",
        text: summary,
      }),
      event(18, "run.succeeded", {
        summary: `${summary}\n\nBranch: agentq/work/fix-redirect\nCommit: abc123\nWorktree: /tmp/agentq-worktree`,
        branchName: "agentq/work/fix-redirect",
        commitSha: "abc123",
        worktreePath: "/tmp/agentq-worktree",
      }),
    ]);

    expect(entries).toEqual([
      expect.objectContaining({ title: summary }),
      expect.objectContaining({
        marker: "✓",
        title: "Run succeeded",
        details: [
          "Branch: agentq/work/fix-redirect",
          "Commit: abc123",
          "Worktree: /tmp/agentq-worktree",
        ],
        tone: "success",
      }),
    ]);
  });

  test("renders phase failures with the failing stage and message", () => {
    const entries = activityEntries([
      event(20, "workflow.phase", { phase: "plan", state: "started" }, "run-plan"),
      event(
        21,
        "workflow.phase",
        { phase: "plan", state: "failed", message: "Repository inspection failed" },
        "run-plan",
      ),
      event(22, "workflow.phase", { phase: "implement", state: "started" }, "run-implement"),
      event(
        23,
        "workflow.phase",
        { phase: "implement", state: "failed", message: "Agent exited with code 1" },
        "run-implement",
      ),
    ]);

    expect(entries).toEqual([
      expect.objectContaining({
        marker: "×",
        title: "Planning failed",
        details: ["Repository inspection failed"],
        tone: "error",
      }),
      expect.objectContaining({
        marker: "×",
        title: "Implementation failed",
        details: ["Agent exited with code 1"],
        tone: "error",
      }),
    ]);
  });
});

describe("activityEntries provider phases", () => {
  test("never attaches an implementation result to an open planner tool with the same id", () => {
    const entries = activityEntries([
      event(30, "executor.tool", {
        type: "tool",
        phase: "plan",
        toolId: "call-1",
        name: "command",
        state: "started",
        detail: "rg -n session src",
      }),
      event(31, "executor.tool", {
        type: "tool",
        phase: "implement",
        toolId: "call-1",
        name: "command",
        state: "started",
        detail: "bun test test/session.test.ts",
      }),
      event(32, "executor.tool", {
        type: "tool",
        phase: "implement",
        toolId: "call-1",
        name: "command",
        state: "completed",
        output: "implementation tests passed",
      }),
    ]);

    expect(entries.find((entry) => entry.title === "Ran rg -n session src")?.details).toEqual([]);
    expect(
      entries.find((entry) => entry.title === "Ran bun test test/session.test.ts")?.details,
    ).toEqual(["implementation tests passed"]);
  });

  test("folds repeated timestamped provider diagnostics into one counted warning", () => {
    const first =
      "2026-07-21T21:16:07.964435Z ERROR codex_models_manager::manager: failed to renew cache TTL";
    const second =
      "2026-07-21T21:16:12.930259Z ERROR codex_models_manager::manager: failed to renew cache TTL";
    const entries = activityEntries([
      event(40, "executor.diagnostic", {
        type: "diagnostic",
        phase: "plan",
        level: "warning",
        message: first,
      }),
      event(41, "executor.tool", {
        type: "tool",
        phase: "plan",
        name: "command",
        state: "completed",
        detail: "rg -n session src",
      }),
      event(42, "executor.diagnostic", {
        type: "diagnostic",
        phase: "plan",
        level: "warning",
        message: second,
      }),
    ]);

    expect(entries.filter((entry) => entry.tone === "warning")).toEqual([
      expect.objectContaining({
        title: "Warning · repeated 2×",
        details: ["ERROR codex_models_manager::manager: failed to renew cache TTL"],
      }),
    ]);
  });
});
