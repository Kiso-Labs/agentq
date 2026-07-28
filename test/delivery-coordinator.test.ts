import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScopePolicyEvaluation } from "../src/core/scope-policy.ts";
import {
  type CompleteIntegrationInput,
  type CompleteLandingInput,
  type DeliveryArtifact,
  DeliveryCoordinator,
  type DeliveryLane,
  type DeliveryLaneKey,
  type DeliveryPersistence,
  type IntegratedArtifact,
  type IntegrationFailureRecord,
  type LaneClaimInput,
  type ReconcileLandingInput,
  type ReconcileLaneHeadInput,
} from "../src/delivery/coordinator.ts";
import { runCommand } from "../src/git/command.ts";
import type { ChangedFile } from "../src/git/delivery.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "./support/test.ts";

const roots: string[] = [];

setDefaultTimeout(20_000);

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});

interface ArtifactState {
  status: "integrated" | "landed";
  integratedSha: string;
  changedFiles: readonly ChangedFile[];
  scopeEvaluation: ScopePolicyEvaluation;
}

class MemoryDeliveryPersistence implements DeliveryPersistence {
  lane?: DeliveryLane;
  claim?: LaneClaimInput;
  claimHistory: LaneClaimInput[] = [];
  failures: IntegrationFailureRecord[] = [];
  artifacts = new Map<string, ArtifactState>();
  failNextIntegrationCompletion = false;
  failNextLandingCompletion = false;

  async getOrCreateLane(input: DeliveryLaneKey & { initialSha: string }): Promise<DeliveryLane> {
    if (!this.lane) {
      this.lane = {
        id: "lane_1",
        repoKey: input.repoKey,
        repoPath: input.repoPath,
        targetRef: input.targetRef,
        trainRef: input.trainRef,
        headSha: input.initialSha,
        landedSha: input.initialSha,
        revision: 0,
      };
    }
    return this.lane;
  }

  async reconcileLaneHead(input: ReconcileLaneHeadInput): Promise<DeliveryLane | undefined> {
    const lane = this.lane;
    if (
      !lane ||
      lane.id !== input.laneId ||
      lane.revision !== input.expectedRevision ||
      lane.headSha !== input.expectedHeadSha
    ) {
      return undefined;
    }
    this.lane = {
      ...lane,
      headSha: input.actualHeadSha,
      revision: lane.revision + 1,
    };
    return this.lane;
  }

  async tryClaimLane(input: LaneClaimInput): Promise<boolean> {
    const lane = this.lane;
    if (
      !lane ||
      this.claim ||
      lane.id !== input.laneId ||
      lane.revision !== input.expectedRevision ||
      lane.headSha !== input.expectedHeadSha
    ) {
      return false;
    }
    this.claim = input;
    this.claimHistory.push(input);
    return true;
  }

  async reconcileLanding(input: ReconcileLandingInput): Promise<DeliveryLane | undefined> {
    const lane = this.lane;
    if (
      !lane ||
      lane.id !== input.laneId ||
      lane.revision !== input.expectedRevision ||
      lane.headSha !== input.expectedHeadSha ||
      lane.landedSha !== input.expectedLandedSha
    ) {
      return undefined;
    }
    this.lane = {
      ...lane,
      landedSha: input.actualLandedSha,
      revision: lane.revision + 1,
    };
    for (const artifactId of input.artifactIds) {
      const artifact = this.artifacts.get(artifactId);
      if (artifact) this.artifacts.set(artifactId, { ...artifact, status: "landed" });
    }
    return this.lane;
  }

  async completeIntegration(input: CompleteIntegrationInput): Promise<boolean> {
    const lane = this.lane;
    if (this.failNextIntegrationCompletion) {
      this.failNextIntegrationCompletion = false;
      return false;
    }
    if (
      !lane ||
      this.claim?.operationId !== input.operationId ||
      lane.id !== input.laneId ||
      lane.revision !== input.expectedRevision ||
      lane.headSha !== input.expectedHeadSha
    ) {
      return false;
    }
    this.lane = {
      ...lane,
      headSha: input.integratedSha,
      revision: lane.revision + 1,
    };
    this.artifacts.set(input.artifactId, {
      status: "integrated",
      integratedSha: input.integratedSha,
      changedFiles: input.changedFiles,
      scopeEvaluation: input.scopeEvaluation,
    });
    this.claim = undefined;
    return true;
  }

  async completeLanding(input: CompleteLandingInput): Promise<boolean> {
    const lane = this.lane;
    if (this.failNextLandingCompletion) {
      this.failNextLandingCompletion = false;
      return false;
    }
    if (
      !lane ||
      this.claim?.operationId !== input.operationId ||
      lane.id !== input.laneId ||
      lane.revision !== input.expectedRevision ||
      lane.headSha !== input.expectedHeadSha ||
      lane.landedSha !== input.expectedLandedSha
    ) {
      return false;
    }
    this.lane = {
      ...lane,
      landedSha: input.landedSha,
      revision: lane.revision + 1,
    };
    for (const artifactId of input.artifactIds) {
      const artifact = this.artifacts.get(artifactId);
      if (artifact) this.artifacts.set(artifactId, { ...artifact, status: "landed" });
    }
    this.claim = undefined;
    return true;
  }

  async releaseLaneClaim(laneId: string, operationId: string): Promise<void> {
    if (this.lane?.id === laneId && this.claim?.operationId === operationId) {
      this.claim = undefined;
    }
  }

  async recordIntegrationFailure(input: IntegrationFailureRecord): Promise<void> {
    this.failures.push(input);
  }

  async listIntegratedArtifacts(_laneId: string): Promise<readonly IntegratedArtifact[]> {
    return [...this.artifacts]
      .filter(([, artifact]) => artifact.status === "integrated")
      .map(([id, artifact]) => ({ id, integratedSha: artifact.integratedSha }));
  }
}

interface Fixture {
  root: string;
  repo: string;
  baseSha: string;
  worktreesRoot: string;
  lane: DeliveryLaneKey;
}

async function git(repoPath: string, ...args: string[]): Promise<string> {
  const result = await runCommand("git", ["-C", repoPath, ...args]);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args[0]} failed`);
  }
  return result.stdout.trim();
}

async function commitAll(repoPath: string, message: string): Promise<string> {
  await git(repoPath, "add", "--all");
  await git(
    repoPath,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    message,
  );
  return git(repoPath, "rev-parse", "HEAD");
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "agentq-delivery-coordinator-"));
  roots.push(root);
  const repo = join(root, "repo");
  await runCommand("git", ["init", "-b", "main", repo]);
  await writeFile(join(repo, "README.md"), "initial\n");
  const baseSha = await commitAll(repo, "initial");
  return {
    root,
    repo,
    baseSha,
    worktreesRoot: join(root, "delivery-worktrees"),
    lane: {
      repoKey: "repo_1",
      repoPath: repo,
      targetRef: "refs/heads/main",
      trainRef: "refs/heads/agentq/train/main",
    },
  };
}

async function createArtifact(
  fixture: Fixture,
  id: string,
  mutate: () => Promise<void>,
  parentRef = fixture.baseSha,
): Promise<DeliveryArtifact> {
  await git(fixture.repo, "checkout", "-B", `artifact-${id}`, parentRef);
  await mutate();
  const resultSha = await commitAll(fixture.repo, `result ${id}`);
  const resultRef = `refs/agentq/results/task_${id}/run_${id}`;
  await git(fixture.repo, "update-ref", resultRef, resultSha);
  return {
    id,
    taskId: `task_${id}`,
    runId: `run_${id}`,
    resultRef,
    resultSha,
  };
}

async function coordinator(
  fixture: Fixture,
  persistence: MemoryDeliveryPersistence,
): Promise<DeliveryCoordinator> {
  return new DeliveryCoordinator(persistence, {
    worktreesRoot: fixture.worktreesRoot,
  });
}

async function candidateRefs(repoPath: string): Promise<string[]> {
  const output = await git(
    repoPath,
    "for-each-ref",
    "--format=%(refname)",
    "refs/agentq/candidates",
  );
  return output ? output.split("\n") : [];
}

describe("DeliveryCoordinator", () => {
  test("replays, authoritatively verifies, and integrates an immutable result", async () => {
    const context = await fixture();
    const artifact = await createArtifact(context, "success", async () => {
      await mkdir(join(context.repo, "src"));
      await writeFile(join(context.repo, "src", "feature.ts"), "export const feature = true;\n");
    });
    await git(context.repo, "checkout", "main");
    const persistence = new MemoryDeliveryPersistence();
    const service = await coordinator(context, persistence);

    const outcome = await service.integrate({
      lane: context.lane,
      artifact,
      scopePolicy: {
        allowPathGroups: [["src/**"]],
        deniedPaths: ["src/private/**"],
        maxChangedFiles: 1,
      },
      verificationCommands: ["test -f src/feature.ts"],
    });

    expect(outcome.status).toBe("integrated");
    if (outcome.status !== "integrated") throw new Error("Expected integration");
    expect(outcome.changedFiles).toEqual([
      { path: "src/feature.ts", kind: "added", tracked: true },
    ]);
    expect(outcome.scopeEvaluation.passed).toBe(true);
    expect(outcome.verificationResults.map((result) => result.status)).toEqual([
      "passed",
      "passed",
      "passed",
      "passed",
      "passed",
    ]);
    expect(await git(context.repo, "rev-parse", context.lane.trainRef)).toBe(outcome.integratedSha);
    expect(await git(context.repo, "rev-parse", "main")).toBe(context.baseSha);
    expect(await git(context.repo, "rev-parse", artifact.resultRef)).toBe(artifact.resultSha);
    expect(persistence.artifacts.get(artifact.id)?.status).toBe("integrated");
    expect(persistence.claimHistory[0]).toMatchObject({
      kind: "integrate",
      taskId: artifact.taskId,
      artifactId: artifact.id,
    });
    expect(await candidateRefs(context.repo)).toEqual([]);
  });

  test("classifies and stores replay conflicts with exact paths", async () => {
    const context = await fixture();
    const artifact = await createArtifact(context, "conflict", async () => {
      await writeFile(join(context.repo, "README.md"), "artifact\n");
    });
    await git(context.repo, "checkout", "main");
    await writeFile(join(context.repo, "README.md"), "target\n");
    const targetSha = await commitAll(context.repo, "target drift");
    const persistence = new MemoryDeliveryPersistence();
    const service = await coordinator(context, persistence);

    const outcome = await service.integrate({ lane: context.lane, artifact });

    expect(outcome).toEqual({
      status: "conflict",
      laneId: "lane_1",
      artifactId: "conflict",
      conflictPaths: ["README.md"],
    });
    expect(persistence.failures).toHaveLength(1);
    expect(persistence.failures[0]).toMatchObject({
      artifactId: "conflict",
      failureClass: "integration_conflict",
      conflictPaths: ["README.md"],
    });
    expect(await git(context.repo, "rev-parse", context.lane.trainRef)).toBe(targetSha);
    expect(await git(context.repo, "rev-parse", artifact.resultRef)).toBe(artifact.resultSha);
    expect(await candidateRefs(context.repo)).toEqual([]);
  });

  test("does not advance the train when mandatory verification regresses", async () => {
    const context = await fixture();
    const artifact = await createArtifact(context, "regression", async () => {
      await writeFile(join(context.repo, "feature.txt"), "feature\n");
    });
    await git(context.repo, "checkout", "main");
    const persistence = new MemoryDeliveryPersistence();
    const service = await coordinator(context, persistence);

    const outcome = await service.integrate({
      lane: context.lane,
      artifact,
      verificationCommands: ["exit 7"],
    });

    expect(outcome.status).toBe("verification-failed");
    if (outcome.status !== "verification-failed") throw new Error("Expected verification failure");
    expect(outcome.failureClass).toBe("test_regression");
    expect(outcome.verificationResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "command", exitCode: 7, status: "failed" }),
      ]),
    );
    expect(await git(context.repo, "rev-parse", context.lane.trainRef)).toBe(context.baseSha);
    expect(persistence.failures[0]?.failureClass).toBe("test_regression");
    expect(await candidateRefs(context.repo)).toEqual([]);
  });

  test("enforces policy against both sides of a renamed path", async () => {
    const original = await fixture();
    await mkdir(join(original.repo, "src", "private"), { recursive: true });
    await writeFile(
      join(original.repo, "src", "private", "secret.ts"),
      "export const secret = 1;\n",
    );
    const baseSha = await commitAll(original.repo, "private source");
    const context = { ...original, baseSha };
    const artifact = await createArtifact(context, "rename", async () => {
      await mkdir(join(context.repo, "src", "public"), { recursive: true });
      await git(context.repo, "mv", "src/private/secret.ts", "src/public/secret.ts");
    });
    await git(context.repo, "checkout", "main");
    const persistence = new MemoryDeliveryPersistence();
    const service = await coordinator(context, persistence);

    const outcome = await service.integrate({
      lane: context.lane,
      artifact,
      scopePolicy: {
        allowPathGroups: [["src/public/**"]],
        deniedPaths: ["src/private/**"],
      },
    });

    expect(outcome.status).toBe("verification-failed");
    if (outcome.status !== "verification-failed") throw new Error("Expected policy failure");
    expect(outcome.failureClass).toBe("policy_violation");
    expect(outcome.scopeEvaluation.changedPaths).toEqual([
      "src/private/secret.ts",
      "src/public/secret.ts",
    ]);
    expect(outcome.scopeEvaluation.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "denied_path",
          path: "src/private/secret.ts",
        }),
      ]),
    );
    expect(await git(context.repo, "rev-parse", context.lane.trainRef)).toBe(baseSha);
  });

  test("recovers a Git-first train advance after persistent CAS contention", async () => {
    const context = await fixture();
    const artifact = await createArtifact(context, "recovery", async () => {
      await writeFile(join(context.repo, "recovered.txt"), "durable\n");
    });
    await git(context.repo, "checkout", "main");
    const persistence = new MemoryDeliveryPersistence();
    persistence.failNextIntegrationCompletion = true;
    const service = await coordinator(context, persistence);

    const first = await service.integrate({ lane: context.lane, artifact });

    expect(first.status).toBe("contended");
    const gitSourceOfTruth = await git(context.repo, "rev-parse", context.lane.trainRef);
    expect(gitSourceOfTruth).not.toBe(context.baseSha);
    expect(persistence.lane?.headSha).toBe(context.baseSha);
    expect(await candidateRefs(context.repo)).toEqual([]);

    const recovered = await service.integrate({ lane: context.lane, artifact });

    expect(recovered.status).toBe("integrated");
    if (recovered.status !== "integrated") throw new Error("Expected recovered integration");
    expect(recovered.integratedSha).toBe(gitSourceOfTruth);
    expect(recovered.changedFiles.map((file) => file.path)).toEqual(["recovered.txt"]);
    expect(persistence.lane?.headSha).toBe(gitSourceOfTruth);
    expect(persistence.artifacts.get(artifact.id)?.status).toBe("integrated");
    expect(await git(context.repo, "rev-parse", artifact.resultRef)).toBe(artifact.resultSha);
  });

  test("refuses to land over a dirty checked-out target", async () => {
    const context = await fixture();
    const artifact = await createArtifact(context, "dirty", async () => {
      await writeFile(join(context.repo, "feature.txt"), "feature\n");
    });
    await git(context.repo, "checkout", "main");
    const persistence = new MemoryDeliveryPersistence();
    const service = await coordinator(context, persistence);
    const integrated = await service.integrate({ lane: context.lane, artifact });
    expect(integrated.status).toBe("integrated");
    await writeFile(join(context.repo, "local-only.txt"), "dirty\n");

    await expect(service.land({ lane: context.lane })).rejects.toMatchObject({
      code: "LAND_TARGET_DIRTY",
    });

    expect(await git(context.repo, "rev-parse", "main")).toBe(context.baseSha);
    expect(persistence.artifacts.get(artifact.id)?.status).toBe("integrated");
    expect(persistence.claim).toBeUndefined();
  });

  test("recovers a Git-first landing and marks reachable artifacts landed", async () => {
    const context = await fixture();
    const artifact = await createArtifact(context, "land_recovery", async () => {
      await writeFile(join(context.repo, "feature.txt"), "feature\n");
    });
    await git(context.repo, "checkout", "main");
    const persistence = new MemoryDeliveryPersistence();
    const service = await coordinator(context, persistence);
    const integrated = await service.integrate({ lane: context.lane, artifact });
    expect(integrated.status).toBe("integrated");
    if (integrated.status !== "integrated") throw new Error("Expected integration");
    persistence.failNextLandingCompletion = true;

    await expect(service.land({ lane: context.lane })).rejects.toMatchObject({
      code: "DELIVERY_LANDING_PERSISTENCE_DIVERGED",
    });
    expect(await git(context.repo, "rev-parse", "main")).toBe(integrated.integratedSha);
    expect(persistence.lane?.landedSha).toBe(context.baseSha);
    expect(persistence.artifacts.get(artifact.id)?.status).toBe("integrated");

    const recovered = await service.land({ lane: context.lane });

    expect(recovered.landedSha).toBe(integrated.integratedSha);
    expect(recovered.artifactIds).toEqual([artifact.id]);
    expect(persistence.lane?.landedSha).toBe(integrated.integratedSha);
    expect(persistence.artifacts.get(artifact.id)?.status).toBe("landed");
  });

  test("fails closed when the target moves to a divergent external commit", async () => {
    const context = await fixture();
    const artifact = await createArtifact(context, "target_drift", async () => {
      await writeFile(join(context.repo, "feature.txt"), "feature\n");
    });
    await git(context.repo, "checkout", "main");
    const persistence = new MemoryDeliveryPersistence();
    const service = await coordinator(context, persistence);
    const integrated = await service.integrate({ lane: context.lane, artifact });
    expect(integrated.status).toBe("integrated");
    await writeFile(join(context.repo, "external.txt"), "external\n");
    const externalSha = await commitAll(context.repo, "external target movement");

    await expect(service.land({ lane: context.lane })).rejects.toMatchObject({
      code: "DELIVERY_TARGET_DRIFT",
    });

    expect(await git(context.repo, "rev-parse", "main")).toBe(externalSha);
    expect(persistence.lane?.landedSha).toBe(context.baseSha);
    expect(persistence.artifacts.get(artifact.id)?.status).toBe("integrated");
  });

  test("integrates stacked dependent results and lands every reachable artifact", async () => {
    const context = await fixture();
    const firstArtifact = await createArtifact(context, "stack_a", async () => {
      await writeFile(join(context.repo, "a.txt"), "a\n");
    });
    const secondArtifact = await createArtifact(
      context,
      "stack_b",
      async () => {
        await writeFile(join(context.repo, "b.txt"), "b\n");
      },
      firstArtifact.resultSha,
    );
    await git(context.repo, "checkout", "main");
    const persistence = new MemoryDeliveryPersistence();
    const service = await coordinator(context, persistence);

    const first = await service.integrate({ lane: context.lane, artifact: firstArtifact });
    const second = await service.integrate({ lane: context.lane, artifact: secondArtifact });

    expect(first.status).toBe("integrated");
    expect(second.status).toBe("integrated");
    if (second.status !== "integrated") throw new Error("Expected stacked integration");
    expect(await git(context.repo, "show", `${second.integratedSha}:a.txt`)).toBe("a");
    expect(await git(context.repo, "show", `${second.integratedSha}:b.txt`)).toBe("b");
    expect(await git(context.repo, "rev-parse", firstArtifact.resultRef)).toBe(
      firstArtifact.resultSha,
    );
    expect(await git(context.repo, "rev-parse", secondArtifact.resultRef)).toBe(
      secondArtifact.resultSha,
    );

    const landed = await service.land({ lane: context.lane });

    expect(landed.status).toBe("landed");
    expect([...landed.artifactIds].sort()).toEqual(["stack_a", "stack_b"]);
    expect(await git(context.repo, "rev-parse", "main")).toBe(second.integratedSha);
    expect(persistence.artifacts.get("stack_a")?.status).toBe("landed");
    expect(persistence.artifacts.get("stack_b")?.status).toBe("landed");
    expect(await readdir(context.repo)).toEqual(
      expect.arrayContaining(["README.md", "a.txt", "b.txt"]),
    );
  });
});
