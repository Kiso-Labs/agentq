import { realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { AgentQError } from "../core/errors.ts";
import { runGit } from "./command.ts";

export interface RepositoryContext {
  rootPath: string;
  commonDir: string;
  repoKey: string;
  displayName: string;
}

async function discoverRepositoryContext(cwd: string): Promise<RepositoryContext | undefined> {
  const candidate = await realpath(resolve(cwd));
  const rootResult = await runGit(
    candidate,
    ["rev-parse", "--path-format=absolute", "--show-toplevel"],
    { allowFailure: true, maxOutputBytes: 64 * 1024 },
  );
  if (rootResult.exitCode !== 0 || !rootResult.stdout.trim()) return undefined;

  const commonResult = await runGit(
    candidate,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { allowFailure: true, maxOutputBytes: 64 * 1024 },
  );
  if (commonResult.exitCode !== 0 || !commonResult.stdout.trim()) return undefined;

  const [rootPath, commonDir] = await Promise.all([
    realpath(rootResult.stdout.trim()),
    realpath(commonResult.stdout.trim()),
  ]);
  return {
    rootPath,
    commonDir,
    repoKey: commonDir,
    displayName: basename(rootPath),
  };
}

/** Discover the canonical Git working-tree context for `cwd`, if one exists. */
export async function findRepositoryContext(cwd: string): Promise<RepositoryContext | undefined> {
  try {
    return await discoverRepositoryContext(cwd);
  } catch {
    return undefined;
  }
}

/** Resolve the canonical Git working-tree context or fail with a stable domain error. */
export async function resolveRepositoryContext(cwd: string): Promise<RepositoryContext> {
  const context = await findRepositoryContext(cwd);
  if (context) return context;
  throw new AgentQError(`Not inside a Git working tree: ${resolve(cwd)}`, "NOT_GIT_REPOSITORY", 2);
}
