# Dependency-to-Landing Engineering System Subtasks

Generated: 2026-07-24

## Goal

Turn agentq from a parallel branch producer into a durable engineering workflow that carries structured work through dependency resolution, policy enforcement, verified implementation, integration, and landing.

## Assumptions

- Existing CLI and JSON contracts remain compatible unless a stricter safety invariant requires an explicit error.
- `Task.status` remains the operational execution state; a new orthogonal delivery state records `pending → implemented → verified → ready_to_integrate → integrated → landed`.
- Queue verification gates are inherited and cannot be bypassed; task gates may only append stricter checks.
- `parentTaskId` remains delegation provenance. A separate many-to-many DAG models `blockedBy`.
- Automatic Git mutation is opt-in through a task/queue land strategy. Legacy queues keep manual delivery behavior.
- Tests target the public store/service, CLI/JSON, Git worktree, supervisor, and Ink UI seams.

## Execution Shape

- Critical path: T1 → T2 → T3 → T4 → T6 → T7
- Parallel lanes after T1: T3 policy enforcement and T5 approval checkpoints
- Integration point: T4 consumes durable result commits from T2/T3; T6 exposes every persisted state
- Riskiest assumption: crash-safe Git integration requires a durable lease/CAS protocol around repository refs, not only an in-process lock

## Subtasks

### T1: Add the durable workflow domain

- **Outcome:** Migration and types for structured specifications, dependencies, delivery state, result artifacts, verification results, integration metadata, approval checkpoints, failure classes, and usage metrics.
- **Scope:** SQLite schema, row mapping, validation, immutable run snapshots, backward-compatible defaults. No scheduler behavior yet.
- **Context:** `src/core/types.ts`, `src/store/migrations.ts`, `src/store/store.ts`, `src/store/types.ts`.
- **Instructions:** Add normalized `task_dependencies`; keep delegation ancestry separate; validate a same-queue acyclic dependency graph atomically; persist task policy fields and run result metadata.
- **Expansion:** Split schema rebuilds from mapping changes if SQLite CHECK constraints require it.
- **Reuse check:** Prefer SQLite constraints/indexes and existing validation helpers over custom persistence machinery.
- **Acceptance:** Old databases migrate without loss; dependency cycles/cross-queue blockers fail; new fields round-trip and enter immutable run snapshots.
- **Validation:** Store migration, CRUD, FK, concurrency, and snapshot tests.
- **Dependencies:** None.
- **Handoff:** Migration plus typed store API.

### T2: Enforce dependencies and base selection in the scheduler

- **Outcome:** Blocked tasks consume no attempt, claims are dependency-aware, and each dependent attempt starts from its blockers' integrated/result commit.
- **Scope:** Claim SQL, dependency resolution, run base selection, declared file-scope serialization, dependency events. No Git landing yet.
- **Context:** `AgentQStore.claimNextTask`, `Supervisor.run`, `WorktreeManager.prepare`.
- **Instructions:** Evaluate blockers inside the claim IMMEDIATE transaction; require durable blocker artifacts; select one deterministic dependency base; add file-scope leases/overlap keys and release them on every terminal path.
- **Expansion:** Multiple divergent blockers must wait for a common integration head rather than picking an arbitrary SHA.
- **Reuse check:** Use SQLite exclusion queries and leases before introducing an external scheduler.
- **Acceptance:** Blocked work stays queued with zero attempts; a blocker completion makes it claimable; concurrent claimers cannot violate dependencies or scope leases; the worktree HEAD equals the resolved dependency base.
- **Validation:** Cross-process claim races and real-Git worktree tests.
- **Dependencies:** T1.
- **Handoff:** Dependency-aware claim and preparation path.

### T3: Enforce scope policies and verified-success semantics

- **Outcome:** Prohibited changes cannot be committed; every successful run records mandatory built-in and configured gates; retry behavior follows a durable failure class.
- **Scope:** Allowed/denied path globs, maximum changed files, task-appended verification, diff/clean-tree gates, verification persistence, failure classification, automatic resume/replan/stop dispositions.
- **Context:** `Supervisor.finalizeSuccessfulOrFailed`, `WorktreeManager.verify`, prompts, run events.
- **Instructions:** Evaluate changed files against the immutable snapshot before commit; run queue gates plus task gates; persist each result; only mark verified after all gates pass; policy violations are permanent; test regressions resume implementation; stale bases replan/rebase; dependency waits spend no attempt.
- **Expansion:** Add a reusable policy evaluator and precise failure messages with offending paths.
- **Reuse check:** Before implementing glob matching, compare a small maintained matcher with Node.js/standard ecosystem APIs; adopt a dependency only if packaging remains simple.
- **Acceptance:** Denied/out-of-scope/excess-file changes fail before commit; no gate can be skipped; clean-tree is proven after auto-commit; retry disposition matches failure class.
- **Validation:** Policy unit vectors plus supervisor integration tests with real changed files and commands.
- **Dependencies:** T1; can proceed alongside T2 after snapshot types stabilize.
- **Handoff:** Verified result artifact or classified terminal failure.

### T4: Build crash-safe integration and landing

- **Outcome:** Verified commits can be stacked or serialized through a merge-train ref, with automatic rebase, conflict detection, integration state, and optional landing onto the configured base branch.
- **Scope:** Queue integration lease/ref, disposable integration worktree, CAS updates, stack and merge-train strategies, `task integrate`, `queue land`, conflict/stale-base states, recovery.
- **Context:** `src/git/worktrees.ts`, repo locks, task result commits from T3.
- **Instructions:** Never integrate from the source checkout; persist intent before Git mutation; update refs with compare-and-swap; make retries idempotent; record integrated/landed SHAs; dependents use the integrated SHA.
- **Expansion:** Treat multiple blockers as a merge-train convergence point; add explicit conflict remediation rather than consuming generic attempts.
- **Reuse check:** Use Git plumbing (`merge-base`, `rebase`, `cherry-pick`, `update-ref`) under existing repository locks before adding a Git library.
- **Acceptance:** Four verified tasks produce one deterministic train; conflicts stop safely with diagnostics; stale train writers lose CAS; restart can reconcile every crash window; opt-in landing updates only the intended local ref.
- **Validation:** Real-Git stacked, train, conflict, concurrent integration, and crash-recovery tests.
- **Dependencies:** T2 and T3.
- **Handoff:** Durable integrated/landed artifacts.

### T5: Add approval checkpoints

- **Outcome:** Queues/tasks can pause after investigation/planning or before integration and continue only after an explicit approval.
- **Scope:** Checkpoint policy, awaiting-approval state, approve/reject service methods, CLI/UI actions, immutable handoff reuse.
- **Context:** Plan-to-implement phase boundary, task snapshots, cancellation/retry behavior.
- **Instructions:** Pausing must release execution capacity, preserve the clean worktree and handoff, spend no extra attempt, and be race-safe against cancel/delete/retry.
- **Expansion:** Keep the first implementation to `before_implement` and `before_integrate`; represent additional named stages without schema redesign.
- **Acceptance:** Planner can stop at approval; approve resumes implementation with the exact handoff; reject terminalizes with an audit event.
- **Validation:** Store transition races, supervisor phase tests, CLI and Ink confirmation tests.
- **Dependencies:** T1; integrates with T3/T4.
- **Handoff:** Durable checkpoint transitions.

### T6: Expose the complete workflow through CLI, JSON, prompts, and Ink

- **Outcome:** Every new field and operation is available manually and for agents, with actionable operational visibility.
- **Scope:** `task add/edit/show/list`, queue defaults, JSON stdin, integration/landing commands, approval actions, UI forms/details/action center, agent instruction templates.
- **Context:** `src/cli.tsx`, `src/ui/app.tsx`, `src/ui/types.ts`, `src/integrations/instructions.ts`, README command contract.
- **Instructions:** Support `--blocked-by`, `--objective`, `--invariant`, `--allow-path`, `--deny-path`, `--max-changed-files`, append-only `--verify`, `--checkpoint`, and `--land-strategy`. Show phase, blocker states, base/branch/result/integration SHAs, changed files, gates, failure class, elapsed time, tokens/cost, and delivery state.
- **Expansion:** Preserve compact/narrow terminal layouts and sanitize every external string.
- **Acceptance:** CLI and UI achieve parity; JSON is stable and complete; agents can create fully structured tasks; unavailable actions explain remediation.
- **Validation:** CLI automation tests and Ink interaction tests across terminal widths.
- **Dependencies:** T1–T5 contracts.
- **Handoff:** Complete operator and automation surface.

### T7: Harden, document, and release the system

- **Outcome:** Reviewed, cross-platform, migration-safe release with truthful security and recovery documentation.
- **Scope:** Full suite, packaging, Windows/macOS/Linux CI, adversarial code review, migration fixtures, docs, examples, changelog/release readiness.
- **Context:** All previous subtasks, `docs/architecture.md`, `docs/security.md`, `.github/workflows/ci.yml`.
- **Instructions:** Audit deletion/integration crash windows, Git ref scope, shell-free command construction, glob/path traversal, dependency cycles, lease recovery, and JSON compatibility.
- **Acceptance:** Full local gate and all three CI jobs green; no unresolved P0/P1 review findings; README example from the request works end-to-end.
- **Validation:** `npm run check`, packed CLI smoke tests, real repository demo, CI.
- **Dependencies:** T1–T6.
- **Handoff:** Production-ready branch and PR evidence.

## Coordination Notes

- Delivery state is orthogonal to execution status so existing cancellation/retry logic remains intelligible.
- Queue gates are a floor; task gates append and never replace them.
- Dependency and integration mutations must share durable SQLite state with Git CAS; an OS lock alone is insufficient across crashes.
- Automatic landing is opt-in and local. agentq still never pushes or opens pull requests unless a future explicit feature adds that authority.
- Implement each subtask as vertical red/green slices and push it independently.

## Suggested Next Dispatch

Implement T1 first: add migration-backed structured task specifications, normalized dependencies, orthogonal delivery state, and durable run result/verification metadata, with migration and store API tests before scheduler changes.
