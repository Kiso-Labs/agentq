import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function cli(stateDir: string, args: string[], stdin?: string) {
  const process = Bun.spawn({
    cmd: [Bun.which("bun") ?? "bun", "src/cli.tsx", "--state-dir", stateDir, ...args],
    cwd: join(import.meta.dir, ".."),
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...globalThis.process.env, NO_COLOR: "1" },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    process.stdout.text(),
    process.stderr.text(),
    process.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("agentq CLI", () => {
  test("creates a queue and accepts idempotent JSON tasks", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentq-cli-"));
    roots.push(stateDir);
    const repository = join(import.meta.dir, "..");
    const created = await cli(stateDir, ["queue", "create", "cli", "--repo", repository, "--json"]);
    expect(created.exitCode).toBe(0);
    expect(JSON.parse(created.stdout).name).toBe("cli");

    const input = JSON.stringify({
      queue: "cli",
      title: "JSON task",
      instructions: "Exercise the machine interface",
      provider: "claude",
      idempotencyKey: "cli-json-task",
    });
    const first = await cli(stateDir, ["task", "add", "--stdin-json"], input);
    const duplicate = await cli(stateDir, ["task", "add", "--stdin-json"], input);
    expect(first.exitCode).toBe(0);
    expect(JSON.parse(duplicate.stdout).id).toBe(JSON.parse(first.stdout).id);

    const listed = await cli(stateDir, ["task", "list", "--json"]);
    expect(listed.exitCode).toBe(0);
    expect(JSON.parse(listed.stdout)).toHaveLength(1);
  });

  test("returns a script-friendly error for invalid JSON", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentq-cli-error-"));
    roots.push(stateDir);
    const result = await cli(stateDir, ["task", "add", "--stdin-json"], "not-json");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Invalid task JSON");
  });

  test("sanitizes an untrusted queue reference in supervisor startup output", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentq-cli-run-output-"));
    roots.push(stateDir);
    const queueRef = "missing\u001b]0;owned\u0007queue";

    const result = await cli(stateDir, ["run", queueRef, "--once"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("agentq supervisor started for missingqueue");
    expect(result.stdout).not.toContain("\u001b");
  });

  test("accepts the documented --title form for manual tasks", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentq-cli-title-"));
    roots.push(stateDir);
    const repository = join(import.meta.dir, "..");
    await cli(stateDir, ["queue", "create", "docs", "--repo", repository, "--json"]);

    const result = await cli(stateDir, [
      "task",
      "add",
      "--queue",
      "docs",
      "--title",
      "Fix expired-session redirects",
      "--instructions",
      "Reproduce the redirect loop and add a regression test",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      queueName: "docs",
      title: "Fix expired-session redirects",
      instructions: "Reproduce the redirect loop and add a regression test",
    });
  });

  test("returns JSON for automation mutations and sanitizes only human output", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "agentq-cli-mutations-"));
    roots.push(stateDir);
    const repository = join(import.meta.dir, "..");
    await cli(stateDir, ["queue", "create", "work", "--repo", repository, "--json"]);
    await cli(stateDir, ["queue", "create", "empty", "--repo", repository, "--json"]);

    const title = "safe\u001b]0;owned\u0007title";
    const added = await cli(
      stateDir,
      ["task", "add", "--stdin-json"],
      JSON.stringify({ queue: "work", title }),
    );
    const task = JSON.parse(added.stdout) as { id: string; title: string };
    expect(task.title).toBe(title);

    const humanList = await cli(stateDir, ["task", "list"]);
    expect(humanList.stdout).not.toContain("\u001b");
    expect(humanList.stdout).toContain("safetitle");
    const jsonList = await cli(stateDir, ["task", "list", "--json"]);
    expect((JSON.parse(jsonList.stdout) as { title: string }[])[0]?.title).toBe(title);

    const cancelled = await cli(stateDir, ["task", "cancel", task.id, "--json"]);
    expect(JSON.parse(cancelled.stdout).status).toBe("cancelled");
    const retried = await cli(stateDir, ["task", "retry", task.id, "--json"]);
    expect(JSON.parse(retried.stdout).status).toBe("queued");
    const completed = await cli(stateDir, ["task", "complete", task.id, "--json"]);
    expect(JSON.parse(completed.stdout).status).toBe("succeeded");
    const removed = await cli(stateDir, ["queue", "remove", "empty", "--yes", "--json"]);
    expect(JSON.parse(removed.stdout)).toEqual({ removed: true, queue: "empty" });
  });
});
