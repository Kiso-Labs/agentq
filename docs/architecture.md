# Architecture

agentq is a single local control plane with four separable layers.

## Durable control plane

`AgentQStore` owns the SQLite schema and all state transitions. Queue creation, task insertion, task claims, run completion, retries, cancellation, and event append operations cross explicit transactions. A task claim creates its run record and random supervisor lease in the same `BEGIN IMMEDIATE` transaction that changes the task from `queued` to `starting`. Lease tokens fence late writes from a recovered owner.

Queues carry a canonical repository key derived from Git's common directory. Queue names are case-insensitively unique within that key, not across the entire database. This lets separate repositories reuse natural names such as `app`, while linked Git worktrees resolve to the same repository scope. When agentq starts inside Git, `AgentQApp` scopes the TUI, ordinary queue/task listings, queue-name resolution, and unqualified supervisor claims to that repository. `queue list --all`, `task list --all`, and `run --all` deliberately remove that filter. Queue edits can replace the display name, base ref, default provider, planning and implementation models/instructions, concurrency, maximum attempts, verification commands, and auto-commit policy, but never the canonical repository key or path.

An operator edit can replace only a task's title, instructions, acceptance criteria, provider, or priority. The edit transaction requires both a non-active editable status (`queued`, `failed`, `interrupted`, or `cancelled`) and, when supplied by the CLI or TUI, the expected `updated_at` version. It rejects stale writes and appends a `task.edited` audit event atomically. Active and succeeded tasks cannot be edited.

Every claim serializes those five task fields and the queue's four planning/implementation settings into an immutable snapshot on the new run record. The selected task provider runs both stages. Queue stage models apply when that provider matches the queue default; blank models, and every task-level provider override, use the selected provider's default model for both stages so a model name is never carried across providers. A later task or queue edit therefore affects a future fresh claim without changing the recorded input for an active attempt or retained session resume.

Worktree cleanup is allowed only after a task reaches a terminal state. Once Git removal succeeds, one store transaction clears the run's retained path and any matching resume pointer and appends `task.worktree_removed`. Repeated cleanup therefore cannot operate on a stale path, and a removed provider session is no longer advertised as resumable.

The state machine is:

```text
queued → starting → running → succeeded
                     │  │
                     │  ├→ failed → queued (attempts remain)
                     │  ├→ interrupted → queued (attempts remain)
                     │  └→ cancelling → cancelled
                     └→ stale supervisor recovery
```

## Supervisor

The supervisor is intentionally provider-neutral. It:

1. Recovers stale leases at startup and on a bounded recurring cadence.
2. Claims tasks while global and queue capacity are available.
3. Provisions a worktree under a per-repository lock.
4. Starts a gated, read-only planning process, durably records its process identity, and persists its normalized events and provider session.
5. Requires a non-empty handoff and verifies that planning changed neither `HEAD` nor tracked/untracked Git status, then atomically stores the handoff and advances the run phase.
6. Starts a fresh implementation process with the same task provider, the implementation model, and the complete durable handoff.
7. Observes cancellation requests, runs verification, finalizes the branch, and commits a terminal state transaction.

This mandatory sequence is an agentq-defined two-process pipeline, not either provider's built-in plan mode. It has no bypass setting: every fresh attempt must produce and persist a valid custom planner handoff before implementation can start. `AGENTQ_STAGE` identifies `plan` or `implement` in both child environments. The implementation process alone receives a registered task-intake directory. Planning cannot enqueue delegated work or write to the worktree; Codex may run inspection commands inside its read-only sandbox, while Claude receives only repository-reading tools.

Multiple supervisors may share one database. SQLite claims prevent duplicate local execution. Queue concurrency is evaluated inside the claim transaction. Soft recovery starts when a heartbeat is stale and its supervisor PID is gone; a conservative hard expiry also handles wedged processes and PID reuse. Recovery atomically replaces the old lease while leaving the task unclaimable, verifies the provider's random live identity, terminates its tree, and only then retries or terminalizes the task. Graceful supervisor shutdown records an interrupted attempt and restores its retry budget, while a persisted user cancellation remains terminal.

Managed agents do not write SQLite directly. During implementation, each run receives a private task-intake directory, and Codex receives only that directory as an additional writable sandbox root. `agentq task add` writes an atomic request there and waits for the supervisor. The supervisor renames requests into a private staging area, opens and bounds the claimed file through one descriptor, validates it, and inserts with a request-derived idempotency key. It forces queue and parent-task provenance, caps child fan-out and ancestry depth, contains response failures per request, and removes the run inbox when execution ends. No intake directory is registered or exposed during planning.

Run phase, planner output, planner session, and implementation session are durable. A stage resume copies the prior run's immutable workflow snapshot and restarts only its retained phase: planning resumes its planner session and still hands off to a fresh implementation process; implementation uses the saved plan and resumes its session when one was captured. If implementation startup failed before emitting a session, resume starts a fresh implementation process in the retained worktree. Runs created before schema v5 do not contain a trustworthy planner handoff, so their sessions are not resumable; a fresh retry begins the mandatory pipeline at planning. Every other fresh retry does the same.

## Provider adapters

`AgentExecutor` exposes only `probe()` and `start()`. A started execution returns a hot bounded event stream, a completion promise, an optional supervisor release gate, and idempotent cancellation.

The Codex adapter runs `codex exec --json` with prompt stdin. Planning uses the `read-only` sandbox; implementation uses `workspace-write`. The Claude adapter runs print mode with `stream-json`: planning uses `--tools Read,Glob,Grep`, while implementation uses `acceptEdits` and passes the coding-tool set to both `--tools` and `--allowedTools`. `--tools` is the capability restriction; `--allowedTools` controls approval. Both adapters translate provider JSONL into session, assistant, tool, usage, and diagnostic events. Unknown events remain harmless diagnostics instead of crashing the worker.

Provider success requires a successful child exit and a non-error terminal event. EOF, malformed output, a signal, or a provider error cannot be mistaken for task success.

## Git workspaces

Every attempt captures the queue base ref's commit and creates a unique `agentq/...` branch plus linked worktree. Only worktree administration is serialized; agent execution remains parallel. Each repository uses a separate SQLite database whose `BEGIN IMMEDIATE` transaction holds an OS-backed lock for the complete mutation, and process death releases it automatically. Before implementation, agentq rejects an empty planner result or a planner that moved `HEAD` or left any Git-visible tracked or untracked worktree change. Failed worktrees are retained for inspection and phase-aware provider-session resumption; reuse verifies the managed path, registered Git worktree, common repository, and expected branch first.

The original checkout is never used as an agent working directory.

## User interfaces

The Commander CLI, JSON commands, and Ink TUI all call the same `AgentQApp` service. Queue creation and updates, task mutations and worktree cleanup, provider login, integration installation, diagnostics, and repository-scope changes therefore share validation and side effects across both surfaces. The TUI has no private durable queue state; it renders store snapshots and append-only events. In-process notifications make local updates immediate, while periodic polling discovers changes committed by other CLI/supervisor processes.

The Ink dashboard exposes three focusable panes for queues, tasks, and task details/live activity. Direct pane keys (`1`/`2`/`3`), cyclic focus, arrow or `j`/`k` selection, focused-pane resizing (`[`/`]`), pane-size reset (`0`), zoom (`z`), and contextual help (`?`) all operate on that durable view. `:` opens an action center containing queue and task operations, doctor and provider login, Codex/Claude integration, scope, refresh, help, and exit. Frequent actions also have contextual direct keys.

Queue create and edit use a complete form for name, repository/base, provider, per-stage models and general instructions, concurrency, attempt limit, verification, and auto-commit configuration. Blank model fields mean provider default. Task and queue forms share large, individually bordered input fields; a focus-following viewport keeps the active control visible when the terminal cannot fit the complete form. Repository is selectable only during creation and is rendered read-only during editing. Task add and edit forms persist through the same service methods as their CLI equivalents; task edit saves include the version captured when the form opened, preserving optimistic concurrency.

The UI models system work as explicit flows instead of shelling out behind a dashboard refresh. Queue removal, cancellation, retry, integration, and worktree cleanup enter confirmation state; cleanup additionally selects safe or forced removal. Doctor results can be rerun. Provider login suspends Ink, gives the official Codex or Claude Code CLI ownership of the terminal, then restores the dashboard and reruns diagnostics. Integration records and displays each created, updated, or unchanged instruction file. Attempt history has its own read-only view.

Repository scope is mutable UI context. `AgentQApp.setAllRepositories()` changes queue resolution and snapshots, while the supervisor receives a getter for `activeRepositoryKey`; each claim evaluates that getter so toggling local/all scope changes worker eligibility without restarting either process.
