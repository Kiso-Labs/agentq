import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";

export interface ResolveBinaryOptions {
  name: string;
  envVar: string;
  env?: NodeJS.ProcessEnv;
  /** Directory from which ancestor node_modules/.bin directories are searched. */
  from?: string;
}

export interface CommandInvocation {
  command: string;
  args: string[];
}

function environmentValue(
  env: NodeJS.ProcessEnv,
  name: string,
  platform = process.platform,
): string | undefined {
  if (env[name] !== undefined || platform !== "win32") return env[name];
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

function executableExtensions(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): string[] {
  if (platform !== "win32") return [""];
  const configured = environmentValue(env, "PATHEXT", platform)?.split(";").filter(Boolean);
  return configured?.length ? configured : [".EXE", ".CMD", ".BAT", ".COM"];
}

function isExecutable(path: string, platform = process.platform): boolean {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return false;
    accessSync(path, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function candidates(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): string[] {
  if (platform !== "win32" || /\.[a-z0-9]+$/i.test(path)) return [path];
  return executableExtensions(env, platform).map((extension) => `${path}${extension}`);
}

function firstExecutable(
  paths: Iterable<string>,
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): string | undefined {
  for (const path of paths) {
    for (const candidate of candidates(path, env, platform)) {
      if (isExecutable(candidate, platform)) return resolve(candidate);
    }
  }
  return undefined;
}

function pathCandidates(name: string, pathValue: string | undefined): string[] {
  if (!pathValue) return [];
  return pathValue
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, name));
}

function bundledCandidates(name: string, from: string): string[] {
  let current = resolve(from);
  try {
    if (statSync(current).isFile()) current = dirname(current);
  } catch {
    // A not-yet-created source path is still treated as a directory.
  }

  const result: string[] = [];
  while (true) {
    result.push(join(current, "node_modules", ".bin", name));
    const parent = dirname(current);
    if (parent === current) return result;
    current = parent;
  }
}

function containsPathSeparator(value: string): boolean {
  return value.includes(sep) || (process.platform === "win32" && value.includes("/"));
}

function expandShimPath(shimPath: string, value: string): string {
  if (!/^%dp0%[\\/]/i.test(value)) {
    throw new Error(`Unsupported npm command shim path in ${shimPath}`);
  }
  const relativePath = value.replace(/^%dp0%[\\/]?/i, "").replaceAll("\\", sep);
  return resolve(dirname(shimPath), relativePath);
}

function parseStaticArguments(shimPath: string, value: string): string[] {
  if (!value) return [];
  if (/[&|<>^%!\r\n]/.test(value)) {
    throw new Error(`Unsupported npm command shim arguments in ${shimPath}`);
  }

  const args: string[] = [];
  let current = "";
  let quoted = false;
  let backslashes = 0;

  const flushBackslashes = (): void => {
    if (backslashes > 0) current += "\\".repeat(backslashes);
    backslashes = 0;
  };

  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      current += "\\".repeat(Math.floor(backslashes / 2));
      if (backslashes % 2 === 1) current += '"';
      else quoted = !quoted;
      backslashes = 0;
      continue;
    }
    flushBackslashes();
    if (/\s/.test(character) && !quoted) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }
  flushBackslashes();
  if (quoted) throw new Error(`Unterminated quote in npm command shim ${shimPath}`);
  if (current) args.push(current);
  return args;
}

/**
 * Resolve an npm-generated Windows `.cmd` shim to the executable it wraps.
 *
 * Node cannot spawn batch files without a shell. Passing provider arguments through `cmd.exe`
 * would make repository paths and provider session IDs command-language input, so agentq instead
 * recognizes npm's shim format and launches its interpreter or target with a real argv array.
 */
function npmShimInvocation(
  shimPath: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): CommandInvocation {
  const source = readFileSync(shimPath, "utf8");
  if (!/^@ECHO off\r?\nGOTO start\r?\n/i.test(source) || !/CALL :find_dp0/i.test(source)) {
    throw new Error(
      `Cannot safely launch Windows command shim ${shimPath}; only npm-generated .cmd shims are supported`,
    );
  }

  const invocationLine = source.split(/\r?\n/).findLast((line) => /%\*\s*$/i.test(line.trim()));
  const targetMatch = invocationLine?.match(/"(%dp0%[\\/][^"]+)"\s+%\*\s*$/i);
  if (!invocationLine || !targetMatch?.[1]) {
    throw new Error(`Cannot safely determine the target of npm command shim ${shimPath}`);
  }

  const target = expandShimPath(shimPath, targetMatch[1]);
  if (!isExecutable(target, "win32")) {
    throw new Error(`The target of npm command shim ${shimPath} does not exist: ${target}`);
  }

  const interpreterMarker = '"%_prog%"';
  const interpreterIndex = invocationLine.lastIndexOf(interpreterMarker);
  if (interpreterIndex < 0) {
    if (invocationLine.slice(0, targetMatch.index).trim()) {
      throw new Error(`Cannot safely parse npm command shim ${shimPath}`);
    }
    return { command: target, args: [...args] };
  }

  const assignments = [...source.matchAll(/^\s*SET "_prog=([^"\r\n]+)"\s*$/gim)].map(
    (match) => match[1],
  );
  const fallback = assignments.at(-1);
  if (!fallback || /[&|<>^%!\r\n]/.test(fallback)) {
    throw new Error(`Cannot safely determine the interpreter of npm command shim ${shimPath}`);
  }

  const localInterpreter = assignments
    .filter((value): value is string => Boolean(value && /^%dp0%[\\/]/i.test(value)))
    .map((value) => expandShimPath(shimPath, value))
    .find((value) => isExecutable(value, "win32"));
  const interpreter =
    localInterpreter ??
    firstExecutable(
      pathCandidates(fallback, environmentValue(env, "PATH", "win32")),
      env,
      "win32",
    ) ??
    fallback;
  const staticText = invocationLine
    .slice(interpreterIndex + interpreterMarker.length, targetMatch.index)
    .trim();

  return {
    command: interpreter,
    args: [...parseStaticArguments(shimPath, staticText), target, ...args],
  };
}

/** Return a shell-free command and argv suitable for `child_process.spawn`. */
export function resolveCommandInvocation(
  command: string,
  args: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env,
  /** @internal Allows the Windows-only shim parser to be exercised on other CI hosts. */
  platform: NodeJS.Platform = process.platform,
): CommandInvocation {
  if (platform !== "win32" || !/\.cmd$/i.test(command)) {
    return { command, args: [...args] };
  }
  return npmShimInvocation(resolve(command), args, env);
}

/** Resolve an agent CLI without invoking a shell. Explicit invalid overrides fail closed. */
export function resolveBinary(options: ResolveBinaryOptions): string | undefined {
  const env = options.env ?? process.env;
  const override = env[options.envVar]?.trim();
  if (override) {
    if (isAbsolute(override) || containsPathSeparator(override)) {
      return firstExecutable([isAbsolute(override) ? override : resolve(override)], env);
    }
    return firstExecutable(pathCandidates(override, environmentValue(env, "PATH")), env);
  }

  const from = options.from ?? import.meta.dir;
  return (
    firstExecutable(bundledCandidates(options.name, from), env) ??
    firstExecutable(pathCandidates(options.name, environmentValue(env, "PATH")), env)
  );
}
