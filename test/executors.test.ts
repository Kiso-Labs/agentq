import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutorEvent, ExecutorRunInput, Queue, Task } from "../src/core/types.ts";
import {
  ClaudeExecutor,
  ClaudeStreamParser,
  CodexExecutor,
  CodexStreamParser,
} from "../src/executors/index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentq-executor-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function makeInput(cwd: string, overrides: Partial<ExecutorRunInput> = {}): ExecutorRunInput {
  const now = new Date().toISOString();
  const queue: Queue = {
    id: "queue-1",
    name: "bugs",
    repoKey: cwd,
    repoPath: cwd,
    baseRef: "main",
    defaultProvider: "codex",
    concurrency: 2,
    maxAttempts: 2,
    verifyCommands: [],
    autoCommit: false,
    createdAt: now,
    updatedAt: now,
  };
  const task: Task = {
    id: "task-1",
    queueId: queue.id,
    title: "Fix the bug",
    instructions: "Fix it",
    acceptanceCriteria: [],
    provider: "codex",
    priority: 0,
    status: "starting",
    sourceKind: "manual",
    attemptCount: 1,
    createdAt: now,
    updatedAt: now,
  };

  return {
    runId: "run-1",
    task,
    queue,
    cwd,
    prompt: "Fix the bug and test it.",
    signal: new AbortController().signal,
    env: {},
    ...overrides,
  };
}

async function collect(events: AsyncIterable<ExecutorEvent>): Promise<ExecutorEvent[]> {
  const result: ExecutorEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

describe("CodexStreamParser", () => {
  test("normalizes a real Codex JSONL-shaped successful turn", () => {
    const parser = new CodexStreamParser();
    const fixture = [
      '{"type":"thread.started","thread_id":"019abc"}',
      '{"type":"turn.started"}',
      '{"type":"item.started","item":{"id":"item_0","type":"command_execution","command":"bun test","status":"in_progress"}}',
      '{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"bun test","aggregated_output":"pass","exit_code":0,"status":"completed"}}',
      '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Fixed the bug."}}',
      '{"type":"turn.completed","usage":{"input_tokens":120,"cached_input_tokens":20,"output_tokens":30}}',
    ];

    const events = fixture.flatMap((line) => parser.parseLine(line));

    expect(events).toContainEqual({ type: "session", sessionId: "019abc" });
    expect(events).toContainEqual({
      type: "tool",
      name: "command",
      state: "started",
      detail: "bun test",
    });
    expect(events).toContainEqual({
      type: "tool",
      name: "command",
      state: "completed",
      detail: "bun test",
    });
    expect(events).toContainEqual({ type: "assistant", text: "Fixed the bug." });
    expect(events).toContainEqual({ type: "usage", inputTokens: 120, outputTokens: 30 });
    expect(parser.outcome).toMatchObject({
      terminal: "succeeded",
      sessionId: "019abc",
      summary: "Fixed the bug.",
    });
  });

  test("records malformed JSON and terminal failures", () => {
    const parser = new CodexStreamParser();

    expect(parser.parseLine("not-json")[0]).toMatchObject({
      type: "diagnostic",
      level: "warning",
    });
    const events = parser.parseLine(
      '{"type":"turn.failed","error":{"message":"model overloaded"}}',
    );

    expect(events).toContainEqual({
      type: "diagnostic",
      level: "error",
      message: "model overloaded",
    });
    expect(parser.outcome).toMatchObject({ terminal: "failed", error: "model overloaded" });
  });

  test("bounds cumulative streamed summaries", () => {
    const parser = new CodexStreamParser();
    for (const text of ["a".repeat(40_000), "b".repeat(40_000)]) {
      parser.parseLine(JSON.stringify({ type: "item.agent_message.delta", delta: text }));
    }

    expect(parser.outcome.summary?.length).toBeLessThan(70_000);
    expect(parser.outcome.summary).toContain("earlier summary truncated");
    expect(parser.outcome.summary?.endsWith("b".repeat(100))).toBeTrue();
  });
});

describe("ClaudeStreamParser", () => {
  test("normalizes init, assistant tools, tool results, usage, and result", () => {
    const parser = new ClaudeStreamParser();
    const fixture = [
      '{"type":"system","subtype":"init","session_id":"550e8400-e29b-41d4-a716-446655440000","cwd":"/tmp/repo"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"I will inspect it."},{"type":"tool_use","id":"tool-1","name":"Bash","input":{"command":"bun test"}}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool-1","content":"all tests passed","is_error":false}]}}',
      '{"type":"result","subtype":"success","is_error":false,"result":"Implemented and tested.","session_id":"550e8400-e29b-41d4-a716-446655440000","total_cost_usd":0.012,"usage":{"input_tokens":200,"output_tokens":40}}',
    ];

    const events = fixture.flatMap((line) => parser.parseLine(line));

    expect(events).toContainEqual({
      type: "session",
      sessionId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(events).toContainEqual({ type: "assistant", text: "I will inspect it." });
    expect(events).toContainEqual({
      type: "tool",
      name: "Bash",
      state: "started",
      detail: '{"command":"bun test"}',
    });
    expect(events).toContainEqual({
      type: "tool",
      name: "Bash",
      state: "completed",
      detail: "all tests passed",
    });
    expect(events).toContainEqual({
      type: "usage",
      inputTokens: 200,
      outputTokens: 40,
      costUsd: 0.012,
    });
    expect(parser.outcome).toMatchObject({
      terminal: "succeeded",
      summary: "Implemented and tested.",
    });
  });

  test("does not treat an error result as success", () => {
    const parser = new ClaudeStreamParser();
    const events = parser.parseLine(
      '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"permission denied","session_id":"session-1"}',
    );

    expect(events).toContainEqual({
      type: "diagnostic",
      level: "error",
      message: "permission denied",
    });
    expect(parser.outcome).toMatchObject({ terminal: "failed", error: "permission denied" });
  });
});

async function fakeProviderScript(directory: string): Promise<string> {
  const script = join(directory, "fake-provider.ts");
  await writeFile(
    script,
    [
      "#!/usr/bin/env bun",
      'import { writeFileSync } from "node:fs";',
      'if (process.argv.includes("--version") || process.argv.includes("-v")) { console.log("fake-provider 1.2.3"); process.exit(0); }',
      "const input = await Bun.stdin.text();",
      "if (process.env.AGENTQ_CAPTURE) writeFileSync(process.env.AGENTQ_CAPTURE, JSON.stringify({ args: process.argv.slice(2), input, cwd: process.cwd() }));",
      'console.error("provider stderr");',
      'if (process.env.AGENTQ_FAKE_EMPTY === "1") process.exit(0);',
      'if (process.env.AGENTQ_FAKE_PROVIDER === "codex") {',
      '  console.log(JSON.stringify({ type: "thread.started", thread_id: "codex-session" }));',
      '  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Codex done" } }));',
      '  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 4 } }));',
      "} else {",
      '  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session" }));',
      '  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "claude-session", result: "Claude done", usage: { input_tokens: 12, output_tokens: 5 } }));',
      "}",
    ].join("\n"),
  );
  await chmod(script, 0o755);
  return script;
}

async function npmCommandShim(directory: string, target: string): Promise<string> {
  const shim = join(directory, "codex.cmd");
  const targetName = target.slice(directory.length + 1).replaceAll("/", "\\");
  await writeFile(
    shim,
    [
      "@ECHO off",
      "GOTO start",
      ":find_dp0",
      "SET dp0=%~dp0",
      "EXIT /b",
      ":start",
      "SETLOCAL",
      "CALL :find_dp0",
      'IF EXIST "%dp0%\\bun.exe" (',
      '  SET "_prog=%dp0%\\bun.exe"',
      ") ELSE (",
      '  SET "_prog=bun"',
      "  SET PATHEXT=%PATHEXT:;.JS;=;%",
      ")",
      "",
      `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${targetName}" %*`,
      "",
    ].join("\r\n"),
  );
  return shim;
}

async function fakeProviderBinary(directory: string): Promise<string> {
  const target = await fakeProviderScript(directory);
  return process.platform === "win32" ? npmCommandShim(directory, target) : target;
}

describe("CLI executors", () => {
  test.skipIf(process.platform !== "win32")(
    "launches npm .cmd provider shims without treating arguments as shell input",
    async () => {
      const directory = await temporaryDirectory();
      const target = await fakeProviderScript(directory);
      const binary = await npmCommandShim(directory, target);
      const capture = join(directory, "capture.json");
      const injectedFile = join(directory, "command-injection.txt");
      const hostileSessionId = "session & echo compromised > command-injection.txt";
      const executor = new CodexExecutor({ binary });

      expect(await executor.probe()).toMatchObject({
        provider: "codex",
        available: true,
        binary,
        version: "fake-provider 1.2.3",
      });

      const execution = await executor.start(
        makeInput(directory, {
          resumeSessionId: hostileSessionId,
          env: { AGENTQ_CAPTURE: capture, AGENTQ_FAKE_PROVIDER: "codex" },
        }),
      );
      const [events, result] = await Promise.all([collect(execution.events), execution.completion]);
      const invocation = JSON.parse(await Bun.file(capture).text());

      expect(invocation.args).toEqual([
        "exec",
        "--json",
        "-C",
        directory,
        "--sandbox",
        "workspace-write",
        "resume",
        hostileSessionId,
        "-",
      ]);
      expect(await Bun.file(injectedFile).exists()).toBe(false);
      expect(events).toContainEqual({ type: "session", sessionId: "codex-session" });
      expect(result).toMatchObject({ status: "succeeded", sessionId: "codex-session" });
    },
  );

  test("Codex uses exact argv, stdin, cwd, streaming, and probe", async () => {
    const directory = await temporaryDirectory();
    const binary = await fakeProviderBinary(directory);
    const capture = join(directory, "capture.json");
    const intake = join(directory, "intake");
    await mkdir(intake);
    const executor = new CodexExecutor({ binary });

    expect(await executor.probe()).toMatchObject({
      provider: "codex",
      available: true,
      binary,
      version: "fake-provider 1.2.3",
    });

    const execution = await executor.start(
      makeInput(directory, {
        env: {
          AGENTQ_CAPTURE: capture,
          AGENTQ_FAKE_PROVIDER: "codex",
          AGENTQ_INTAKE_DIR: intake,
        },
      }),
    );
    const [events, result] = await Promise.all([collect(execution.events), execution.completion]);
    const invocation = JSON.parse(await Bun.file(capture).text());

    expect(invocation).toMatchObject({
      args: [
        "exec",
        "--json",
        "-C",
        directory,
        "--sandbox",
        "workspace-write",
        "--add-dir",
        intake,
        "-",
      ],
      input: "Fix the bug and test it.",
    });
    expect(await realpath(invocation.cwd)).toBe(await realpath(directory));
    expect(events).toContainEqual({ type: "session", sessionId: "codex-session" });
    expect(events).toContainEqual({
      type: "diagnostic",
      level: "warning",
      message: "provider stderr",
    });
    expect(result).toMatchObject({
      status: "succeeded",
      exitCode: 0,
      sessionId: "codex-session",
      summary: "Codex done",
    });
  });

  test("Claude resumes with safe autonomous flags and stdin", async () => {
    const directory = await temporaryDirectory();
    const binary = await fakeProviderBinary(directory);
    const capture = join(directory, "capture.json");
    const executor = new ClaudeExecutor({ binary });
    const execution = await executor.start(
      makeInput(directory, {
        resumeSessionId: "existing-session",
        env: { AGENTQ_CAPTURE: capture, AGENTQ_FAKE_PROVIDER: "claude" },
      }),
    );
    const [events, result] = await Promise.all([collect(execution.events), execution.completion]);
    const invocation = JSON.parse(await Bun.file(capture).text());

    expect(invocation.args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Bash,Edit,Write,Read,Glob,Grep",
      "--resume",
      "existing-session",
    ]);
    expect(invocation.input).toBe("Fix the bug and test it.");
    expect(events).toContainEqual({ type: "session", sessionId: "claude-session" });
    expect(result).toMatchObject({
      status: "succeeded",
      sessionId: "claude-session",
      summary: "Claude done",
    });
  });

  test("fails instead of inventing success when a provider omits its terminal event", async () => {
    const directory = await temporaryDirectory();
    const binary = await fakeProviderBinary(directory);
    const executor = new CodexExecutor({ binary });
    const execution = await executor.start(
      makeInput(directory, { env: { AGENTQ_FAKE_EMPTY: "1" } }),
    );
    const [events, result] = await Promise.all([collect(execution.events), execution.completion]);

    expect(events).toContainEqual({
      type: "diagnostic",
      level: "warning",
      message: "provider stderr",
    });
    expect(result).toMatchObject({
      status: "failed",
      exitCode: 0,
      error: "Codex exited without a successful terminal event",
    });
  });
});
