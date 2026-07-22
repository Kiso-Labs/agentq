import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { AgentQError } from "../src/core/errors.ts";
import { runCommand } from "../src/git/command.ts";
import { findRepositoryContext, resolveRepositoryContext } from "../src/git/repository.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function repositoryFixture(): Promise<{ container: string; repository: string }> {
  const container = await mkdtemp(join(tmpdir(), "agentq-repository-"));
  temporaryRoots.push(container);
  const repository = join(container, "project");
  await mkdir(repository);
  await runCommand("git", ["init", "-b", "main", repository]);
  await writeFile(join(repository, "README.md"), "fixture\n");
  await runCommand("git", ["-C", repository, "add", "README.md"]);
  await runCommand("git", [
    "-C",
    repository,
    "-c",
    "user.name=AgentQ Test",
    "-c",
    "user.email=agentq@example.invalid",
    "commit",
    "-m",
    "fixture",
  ]);
  return { container, repository };
}

describe("repository context discovery", () => {
  test("resolves a nested directory to canonical repository paths", async () => {
    const { repository } = await repositoryFixture();
    const nested = join(repository, "packages", "agent");
    await mkdir(nested, { recursive: true });

    const context = await resolveRepositoryContext(nested);
    const rootPath = await realpath(repository);
    const commonDir = await realpath(join(repository, ".git"));

    expect(context).toEqual({
      rootPath,
      commonDir,
      repoKey: commonDir,
      displayName: basename(rootPath),
    });
  });

  test.skipIf(process.platform === "win32")(
    "canonicalizes a working directory reached through a symbolic link",
    async () => {
      const { container, repository } = await repositoryFixture();
      const alias = join(container, "project-alias");
      await symlink(repository, alias, "dir");

      const context = await resolveRepositoryContext(alias);

      expect(context.rootPath).toBe(await realpath(repository));
      expect(context.commonDir).toBe(await realpath(join(repository, ".git")));
      expect(context.repoKey).toBe(context.commonDir);
    },
  );

  test("returns undefined outside Git and throws a stable strict error", async () => {
    const outside = await mkdtemp(join(tmpdir(), "agentq-not-repository-"));
    temporaryRoots.push(outside);

    expect(await findRepositoryContext(outside)).toBeUndefined();
    try {
      await resolveRepositoryContext(outside);
      throw new Error("Expected strict repository discovery to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentQError);
      expect((error as AgentQError).code).toBe("NOT_GIT_REPOSITORY");
    }
  });

  test("uses one repository key for the main and linked worktrees", async () => {
    const { container, repository } = await repositoryFixture();
    const linked = join(container, "linked-project");
    await runCommand("git", [
      "-C",
      repository,
      "worktree",
      "add",
      "-b",
      "linked-context",
      linked,
      "main",
    ]);

    const mainContext = await resolveRepositoryContext(repository);
    const linkedContext = await resolveRepositoryContext(linked);

    expect(linkedContext.rootPath).toBe(await realpath(linked));
    expect(linkedContext.commonDir).toBe(mainContext.commonDir);
    expect(linkedContext.repoKey).toBe(mainContext.repoKey);
    expect(linkedContext.displayName).toBe("linked-project");
  });
});
