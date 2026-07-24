# Architecture

agentq is a local control plane composed of a durable store, a dependency-aware scheduler and supervisor, provider adapters, Git result delivery, and shared CLI/TUI application services.

## Durable control plane

`AgentQStore` owns the SQLite schema and all state transitions. Queue and task mutations, dependency edges, task claims, run completion, retries, cancellation, approvals, immutable artifacts, integration lanes, delivery operations, and events cross explicit transactions. A task claim creates its run and random supervisor lease in the same `BEGIN IMMEDIATE` transaction that changes the task from `queued` to `starting`. Run leases and delivery-operation fence tokens prevent a recovered or contending owner from committing late state.

Queues carry a canonical repository key derived from Git's common directory. Queue names are case-insensitively unique within that key, not globally, so different repositories can each have a queue named `app` while linked worktrees share one scope. Inside Git, ordinary TUI and CLI operations resolve only that repository unless an explicit `--all` operation or UI scope toggle is used.

A queue stores its repository/base, provider, planning and implementation models/instructions, concurrency and attempt limits, verification commands, auto-commit setting, allowed and denied paths, changed-file limit, approval checkpoints, base-drift policy, landing strategy, auto-land setting, and file-concurrency mode. A task is a structured specification: title, instructions, objective, acceptance criteria, invariants, handoff requirements, provider, priority, blockers, expected/allowed/denied paths, changed-file limit, verification commands, approvals, drift policy, and landing strategy.

Edits require a non-active editable task status (`queued`, `failed`, `interrupted`, or `cancelled`) and can use the expected `updated_at` version to reject stale writes. Successful edits append an audit event atomically. Active and succeeded tasks cannot be edited. When an attempt is claimed, the complete task specification, queue workflow, dependency result evidence, and chosen models are copied into an immutable run snapshot. Later edits affect a fresh claim, never an active attempt or retained session resume.

Execution state and delivery state are deliberately separate:

```text
execution: queued → starting → running → succeeded
                        │  ├→ failed → queued when retryable
                        │  ├→ interrupted → queued when retryable
                        │  └→ cancelling → cancelled

delivery:  not_started → implemented → verified → ready_to_integrate
                                                    → integrated → landed
```

Current phase records where work is waiting or running (`blocked`, `plan`, `approval`, `implement`, `verify`, `integrate`, or `land`). Durable gates distinguish `command`, `allowed_paths`, `denied_paths`, `max_changed_files`, and `clean_worktree` evidence.

Failure classes distinguish transient infrastructure, stale bases, test regressions, blocked dependencies, file conflicts, policy violations, integration conflicts/contention, agent failure, cancellation, and unknown errors. They map to durable dispositions: retry, rebase and retry, return to implementation, wait, stop, or manual resolution. Transient infrastructure, stale-base, blocked-dependency, integration-conflict, and integration-contention outcomes do not consume an attempt.

## Dependency-aware supervisor

Dependencies are native graph edges, not prompt text. The store rejects cycles and invalid edges, prevents deleting referenced blockers, and excludes a dependent from claims until every blocker has succeeded with a verified immutable result. One blocker makes its exact result commit the dependent's base. Multiple blockers must have their artifacts integrated through one common delivery lane; the dependent then starts from that lane's head after all blockers are present. The frozen run snapshot records the evidence used for either case.

The scheduler applies global and per-queue concurrency inside the claim transaction. In `enforced` file-concurrency mode, it also serializes conservatively overlapping work across the repository. Predicted scope comes from task expected paths, then task allowed paths, then queue allowed paths; an undeclared scope is repository-wide. `off` and `advisory` retain queue capacity behavior without file-scope exclusion.

A fresh supervised attempt:

1. Resolves its dependency result or queue base and records any base drift.
2. Applies the configured `rebase`, `replan`, or `fail` drift policy before provisioning.
3. Creates a dedicated branch and linked worktree.
4. Runs a read-only planning process and persists its session and handoff.
5. Proves planning changed neither `HEAD` nor tracked/untracked Git state.
6. Requests any implementation-boundary approvals and waits without spending an attempt.
7. Starts a fresh implementation process with the original structured task and durable handoff.
8. Evaluates scope policy from the authoritative Git diff and runs every queue/task verification command.
9. Creates a canonical result commit and immutable result ref when dependencies or delivery require one.
10. Records verified evidence, then makes the result eligible for integration.

This is an agentq-defined two-process pipeline, not either provider's built-in plan mode. `AGENTQ_STAGE` identifies the child stage. Only implementation receives a private registered task-intake directory; planning cannot enqueue delegated work or write to the worktree.

Named checkpoints default to the implementation boundary. `before-integrate`, `integrate`, and `after-verify` gate integration; `before-land`, `land`, and `after-integrate` gate landing. Decisions, actor, note, run association, and timestamps are durable. A rejection stops the applicable work; an approval allows the supervisor or operator to resume it.

Multiple supervisors may share one database. SQLite claims prevent duplicate execution, while heartbeats, random process identity, and fenced recovery keep a task unclaimable until an orphaned provider tree is terminated. Graceful shutdown records an interrupted attempt and restores its retry budget; persisted user cancellation remains terminal.

Managed agents never write SQLite directly. Implementation task requests are atomically moved from an agent-writable inbox into private staging, opened with bounded and symlink-resistant handling, validated, and inserted with request-derived idempotency. Parent provenance, fan-out, and ancestry limits constrain recursive delegation. The inbox is absent during planning and removed when execution ends.

Run phase, planner handoff, provider sessions, worktree identity, and the immutable specification snapshot survive restarts. A retained planning session resumes planning and still hands off to a fresh implementation process. A retained implementation session resumes with its saved plan. Legacy runs without a trustworthy planner handoff start a fresh attempt instead.

## Provider adapters

`AgentExecutor` exposes `probe()` and `start()`. A started execution returns a hot bounded event stream, a completion promise, an optional supervisor release gate, and idempotent cancellation.

The Codex adapter runs `codex exec --json` with prompt stdin. Planning uses the `read-only` sandbox; implementation uses `workspace-write`. The Claude adapter runs print mode with `stream-json`: planning uses `--tools Read,Glob,Grep`, while implementation uses `acceptEdits` and passes the coding-tool set to both `--tools` and `--allowedTools`. Both adapters normalize provider JSONL into session, assistant, tool, usage, and diagnostic events. Unknown events remain diagnostics instead of crashing the worker.

Provider success requires a successful child exit and a non-error terminal event. EOF, malformed output, a signal, or a provider error cannot be mistaken for verified task success.

## Git results and local delivery

Every attempt captures an exact base and uses a unique `agentq/...` branch plus linked worktree. Worktree administration is serialized per repository, but provider execution remains parallel. Failed worktrees are retained for inspection and phase-aware resume; reuse verifies the managed path, registered worktree, common repository, and expected branch. The source checkout is never an agent working directory.

Scope policy is machine-enforced after implementation and before a result becomes verified: every configured queue/task allow-list must accept changed paths, deny-lists are combined, the stricter changed-file maximum wins, and renames check both paths. Queue verification commands run before task commands. Deliverable results receive an immutable `refs/agentq/results/<task-id>/<run-id>` ref and clean-worktree evidence. An agent's success message alone cannot produce `succeeded`.

The delivery coordinator owns a repository/target-scoped integration lane and `refs/heads/agentq/train/<queue-id>` train. Both `stack` and `merge-train` use this ordered local lane. Each integration operation has a persisted lease and monotonically fenced claim, replays one immutable result onto the current train in a temporary worktree, repeats path policy and commands against the combined candidate, checks cleanliness, and advances both Git and SQLite with compare-and-swap semantics. Conflicts, policy failures, test regressions, and contention remain explicit operation outcomes.

Landing is a separate fenced operation. It fast-forwards the configured canonical local branch to the verified train head only when the expected landing cursor still matches, records every reachable artifact as landed, and can reconcile an already-performed forward movement along the verified train. It never pushes a remote or opens a pull request.

## User interfaces

The Commander CLI, JSON commands, and Ink TUI call the same `AgentQApp` service, so queue policies, structured task fields, dependencies, approvals, retry/cancellation, cleanup, provider login, integration installation, delivery integration/landing, diagnostics, and repository scope share validation and durable side effects. The TUI has no private queue state: notifications expose local writes immediately and polling discovers changes from other processes.

The dashboard exposes queue, task, and details/live-activity panes with keyboard focus, resizing, zoom, filters, and repository-scope controls. Forms cover the same queue and structured-task settings as the CLI with optimistic task-edit versions. Task details show blockers, base/result/branch identity, current phase, changed files, verification gates, failure class and disposition, resource use, approvals, lane/train state, and delivery operations. Confirmed flows handle destructive actions, verified-result integration, and local queue landing; checkpoint screens support durable approve/reject decisions with optional actor and note.
