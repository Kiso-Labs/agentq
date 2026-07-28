import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as wait } from "node:timers/promises";

function readable(stream) {
  const web = stream ? Readable.toWeb(stream) : new ReadableStream({ start(controller) { controller.close(); } });
  Object.defineProperty(web, "text", {
    value: () => new Response(web).text(),
    enumerable: false,
  });
  return web;
}

function normalizeSpawn(input, options) {
  if (Array.isArray(input)) return { command: input[0], args: input.slice(1), options: options ?? {} };
  const command = input.cmd?.[0];
  return { command, args: input.cmd?.slice(1) ?? [], options: input };
}

function spawnCompat(input, suppliedOptions) {
  const { command, args, options } = normalizeSpawn(input, suppliedOptions);
  if (!command) throw new Error("Bun.spawn compatibility requires a command");
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    windowsHide: true,
    stdio: [
      options.stdin === "ignore" ? "ignore" : "pipe",
      options.stdout === "ignore" ? "ignore" : "pipe",
      options.stderr === "ignore" ? "ignore" : "pipe",
    ],
  });
  if (child.stdin) {
    if (options.stdin instanceof Blob) {
      void options.stdin.arrayBuffer().then((value) => child.stdin?.end(Buffer.from(value)));
    } else if (typeof options.stdin === "string" && options.stdin !== "pipe") {
      child.stdin.end(options.stdin);
    } else if (options.stdin !== "pipe") {
      child.stdin.end();
    }
  }
  const exited = new Promise((resolve) => {
    child.once("error", () => resolve(1));
    child.once("close", (code) => resolve(code ?? 1));
  });
  return {
    pid: child.pid,
    stdout: readable(child.stdout),
    stderr: readable(child.stderr),
    exited,
    get exitCode() {
      return child.exitCode;
    },
    kill(signal = "SIGTERM") {
      return child.kill(signal);
    },
  };
}

function which(name) {
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
      : [""];
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Continue searching PATH.
      }
    }
  }
  return null;
}

async function stdinText() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

globalThis.Bun = {
  file(path) {
    return {
      async exists() {
        try {
          await access(path);
          return true;
        } catch {
          return false;
        }
      },
      text() {
        return readFile(path, "utf8");
      },
    };
  },
  sleep: (milliseconds) => wait(milliseconds),
  sleepSync(milliseconds) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  },
  spawn: spawnCompat,
  stdin: { text: stdinText },
  which,
  write: (path, contents) => writeFile(path, contents),
};
