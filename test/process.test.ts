import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  BoundedAsyncQueue,
  lines,
  matchesProcessIdentity,
  resolveBinary,
  resolveCommandInvocation,
  spawnProcess,
} from "../src/process/index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentq-process-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function executable(path: string, source = "#!/bin/sh\nexit 0\n"): Promise<void> {
  await writeFile(path, source);
  await chmod(path, 0o755);
}

describe("BoundedAsyncQueue", () => {
  test("bounds buffered events by dropping the oldest event", async () => {
    const queue = new BoundedAsyncQueue<number>(2);

    expect(queue.push(1)).toBe(true);
    expect(queue.push(2)).toBe(true);
    expect(queue.push(3)).toBe(false);
    queue.close();

    const values: number[] = [];
    for await (const value of queue) values.push(value);

    expect(values).toEqual([2, 3]);
    expect(queue.dropped).toBe(1);
  });

  test("delivers queued failures to consumers", async () => {
    const queue = new BoundedAsyncQueue<number>(1);
    queue.fail(new Error("stream failed"));

    await expect(async () => {
      for await (const _value of queue) {
        // The failure is raised by the iterator.
      }
    }).toThrow("stream failed");
  });
});

describe("lines", () => {
  test("reassembles split UTF-8 chunks, CRLF, and a trailing line", async () => {
    const source = Readable.from([
      Buffer.from([0x61, 0x0d, 0x0a, 0xf0, 0x9f]),
      Buffer.from([0x98, 0x80, 0x0a, 0x74, 0x61]),
      Buffer.from("il"),
    ]);

    const result: string[] = [];
    for await (const line of lines(source)) result.push(line);

    expect(result).toEqual(["a", "😀", "tail"]);
  });

  test("bounds an overlong line and continues at the next line", async () => {
    const source = Readable.from([Buffer.from("abcdefghij\nok\n")]);
    const result: string[] = [];

    for await (const line of lines(source, { maxLineLength: 5 })) result.push(line);

    expect(result).toEqual(["abcde…[truncated]", "ok"]);
  });
});

describe("resolveBinary", () => {
  test("prefers the configured environment override", async () => {
    const directory = await temporaryDirectory();
    const override = join(directory, "override");
    const onPath = join(directory, "agent-tool");
    await executable(override);
    await executable(onPath);

    const resolved = resolveBinary({
      name: "agent-tool",
      envVar: "AGENTQ_TEST_BIN",
      env: { AGENTQ_TEST_BIN: override, PATH: directory },
      from: join(directory, "project", "src"),
    });

    expect(resolved).toBe(override);
  });

  test("prefers an ancestor node_modules binary over PATH", async () => {
    const directory = await temporaryDirectory();
    const sourceDirectory = join(directory, "src", "nested");
    const bundledDirectory = join(directory, "node_modules", ".bin");
    const pathDirectory = join(directory, "path-bin");
    await mkdir(sourceDirectory, { recursive: true });
    await mkdir(bundledDirectory, { recursive: true });
    await mkdir(pathDirectory, { recursive: true });
    const bundled = join(bundledDirectory, "agent-tool");
    await executable(bundled);
    await executable(join(pathDirectory, "agent-tool"));

    const resolved = resolveBinary({
      name: "agent-tool",
      envVar: "AGENTQ_TEST_BIN",
      env: { PATH: pathDirectory },
      from: sourceDirectory,
    });

    expect(resolved).toBe(bundled);
  });

  test("unwraps npm Windows command shims into a shell-free argv", async () => {
    const directory = await temporaryDirectory();
    const shim = join(directory, "agent-tool.cmd");
    const target = join(directory, "agent-tool.js");
    await writeFile(target, "console.log('ok');\n");
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
        'IF EXIST "%dp0%\\node.exe" (',
        '  SET "_prog=%dp0%\\node.exe"',
        ") ELSE (",
        '  SET "_prog=node"',
        ")",
        "",
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\agent-tool.js" %*',
        "",
      ].join("\r\n"),
    );

    const hostileArgument = "literal & echo never-runs";
    const invocation = resolveCommandInvocation(shim, [hostileArgument], { PATH: "" }, "win32");

    expect(invocation).toEqual({ command: "node", args: [target, hostileArgument] });
  });

  test("unwraps npm Windows shims that directly target a provider executable", async () => {
    const directory = await temporaryDirectory();
    const shim = join(directory, "claude.cmd");
    const target = join(directory, "claude.exe");
    await writeFile(target, "placeholder executable");
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
        "",
        '"%dp0%\\claude.exe"   %*',
        "",
      ].join("\r\n"),
    );

    expect(resolveCommandInvocation(shim, ["--version"], {}, "win32")).toEqual({
      command: target,
      args: ["--version"],
    });
  });
});

describe("spawnProcess", () => {
  test("preserves argument boundaries, streams output, and closes stdin", async () => {
    const directory = await temporaryDirectory();
    const script = join(directory, "child.ts");
    await writeFile(
      script,
      [
        "const input = await Bun.stdin.text();",
        "console.log(JSON.stringify({ args: process.argv.slice(2), input }));",
        'console.error("diagnostic");',
      ].join("\n"),
    );

    const child = spawnProcess({
      command: process.execPath,
      args: [script, "one argument", "two"],
      cwd: directory,
      env: { ...process.env },
      stdin: "hello",
    });

    const stdoutPromise = (async () => {
      const output: string[] = [];
      for await (const line of lines(child.stdout)) output.push(line);
      return output;
    })();
    const stderrPromise = (async () => {
      const output: string[] = [];
      for await (const line of lines(child.stderr)) output.push(line);
      return output;
    })();
    const [stdout, stderr, completion] = await Promise.all([
      stdoutPromise,
      stderrPromise,
      child.completion,
    ]);

    expect(JSON.parse(stdout[0] ?? "{}")).toEqual({
      args: ["one argument", "two"],
      input: "hello",
    });
    expect(stderr).toEqual(["diagnostic"]);
    expect(completion).toMatchObject({ exitCode: 0, signal: null });
  });

  test("gates provider startup behind a live, unforgeable process identity", async () => {
    const directory = await temporaryDirectory();
    const sentinel = join(directory, "started.txt");
    const script = join(directory, "gated.ts");
    await writeFile(script, `await Bun.write(${JSON.stringify(sentinel)}, "started");\n`);

    const child = spawnProcess({
      command: process.execPath,
      args: [script],
      cwd: directory,
      env: { ...process.env },
      gated: true,
      identityDirectory: join(directory, "identities"),
    });
    const identity = await child.identity;
    if (!identity) throw new Error("Expected a gated process identity");

    await Bun.sleep(350);
    expect(await Bun.file(sentinel).exists()).toBe(false);
    expect(await matchesProcessIdentity(identity)).toBe(true);
    expect(await matchesProcessIdentity({ ...identity, token: randomUUID() })).toBe(false);

    await child.release();
    expect((await child.completion).exitCode).toBe(0);
    expect(await Bun.file(sentinel).text()).toBe("started");
    expect(await Bun.file(identity.path).exists()).toBe(false);
  });

  test.skipIf(process.platform === "win32")(
    "cleans same-group background descendants before reporting normal completion",
    async () => {
      const directory = await temporaryDirectory();
      const script = join(directory, "background.ts");
      await writeFile(
        script,
        [
          'import { spawn } from "node:child_process";',
          'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
          "console.log(child.pid);",
          "child.unref();",
        ].join("\n"),
      );

      const child = spawnProcess({
        command: process.execPath,
        args: [script],
        cwd: directory,
        env: { ...process.env },
        gated: true,
        identityDirectory: join(directory, "identities"),
        cancelGraceMs: 100,
      });
      await child.identity;
      await child.release();
      const descendantPid = Number(
        (await lines(child.stdout)[Symbol.asyncIterator]().next()).value,
      );
      const completion = await child.completion;

      expect(completion.exitCode).toBe(0);
      expect(completion.error).toBeUndefined();
      expect(() => process.kill(descendantPid, 0)).toThrow();
      await child.cancel("already complete");
    },
  );

  test.skipIf(process.platform === "win32")(
    "cancels the POSIX process group, including descendants",
    async () => {
      const directory = await temporaryDirectory();
      const script = join(directory, "tree.ts");
      await writeFile(
        script,
        [
          'import { spawn } from "node:child_process";',
          'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
          "console.log(child.pid);",
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      );

      const child = spawnProcess({
        command: process.execPath,
        args: [script],
        cwd: directory,
        env: { ...process.env },
        cancelGraceMs: 100,
      });
      const iterator = lines(child.stdout)[Symbol.asyncIterator]();
      const descendantPid = Number((await iterator.next()).value);

      await child.cancel("test cancellation");
      const completion = await child.completion;

      expect(completion.signal).not.toBeNull();
      expect(() => process.kill(descendantPid, 0)).toThrow();
    },
  );
});
