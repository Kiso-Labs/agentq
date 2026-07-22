# Architecture

agentq is a single local control plane with four separable layers.

## Durable control plane

`AgentQStore` owns the SQLite schema and all state transitions. Queue creation, task insertion, task claims, run completion, retries, cancellation, and event append operations cross explicit transactions. A task claim creates its run record and random supervisor lease in the same `BEGIN IMMEDIATE` transaction that changes the task from `queued` to `starting`. Lease tokens fence late writes from a recovered owner.

Queues carry a canonical repository key derived from Git's common directory. Queue names are case-insensitively unique within that key, not across the entire database. This lets separate repositories reuse natural names such as `app`, while linked Git worktrees resolve to the same repository scope. When agentq starts inside Git, `AgentQApp` scopes the TUI, ordinary queue/task listings, queue-name resolution, and unqualified supervisor claims to that repository. `queue list --all`, `task list --all`, and `run --all` deliberately remove that filter. Queue edits can replace the display name, base ref, default provider, concurrency, maximum attempts, verification commands, and auto-commit policy, but never the canonical repository key or path.

An operator edit can replace only a task's title, instructions, acceptance criteria, provider, or priority. The edit transaction requires both a non-active editable status (`queued`, `failed`, `interrupted`, or `cancelled`) and, when supplied by the CLI or TUI, the expected `updated_at` version. It rejects stale writes and appends a `task.edited` audit event atomically. Active and succeeded tasks cannot be edited.

Every claim serializes those five specification fields into an immutable snapshot on the new run record. The claimed executor receives the same values. A later edit therefore affects a future claim without changing the recorded input for an earlier attempt.

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
4. Starts a gated launcher, durably records its random process identity, and places Windows launches in a kill-on-close Job Object.
5. Releases the selected executor and persists normalized events and heartbeats.
6. Observes cancellation requests from any process.
7. Runs verification and finalizes the branch.
8. Commits a terminal state transaction.

Multiple supervisors may share one database. SQLite claims prevent duplicate local execution. Queue concurrency is evaluated inside the claim transaction. Soft recovery starts when a heartbeat is stale and its supervisor PID is gone; a conservative hard expiry also handles wedged processes and PID reuse. Recovery atomically replaces the old lease while leaving the task unclaimable, verifies the provider's random live identity, terminates its tree, and only then retries or terminalizes the task. Graceful supervisor shutdown records an interrupted attempt and restores its retry budget, while a persisted user cancellation remains terminal.

Managed agents do not write SQLite directly. Each run receives a private task-intake directory, and Codex receives only that directory as an additional writable sandbox root. `agentq task add` writes an atomic request there and waits for the supervisor. The supervisor renames requests into a private staging area, opens and bounds the claimed file through one descriptor, validates it, and inserts with a request-derived idempotency key. It forces queue and parent-task provenance, caps child fan-out and ancestry depth, contains response failures per request, and removes the run inbox when execution ends.

## Provider adapters

`AgentExecutor` exposes only `probe()` and `start()`. A started execution returns a hot bounded event stream, a completion promise, an optional supervisor release gate, and idempotent cancellation.

The Codex adapter runs `codex exec --json` with prompt stdin. The Claude adapter runs print mode with `stream-json`. Both translate provider JSONL into session, assistant, tool, usage, and diagnostic events. Unknown events remain harmless diagnostics instead of crashing the worker.

Provider success requires a successful child exit and a non-error terminal event. EOF, malformed output, a signal, or a provider error cannot be mistaken for task success.

## Git workspaces

Every attempt captures the queue base ref's commit and creates a unique `agentq/...` branch plus linked worktree. Only worktree administration is serialized; agent execution remains parallel. Each repository uses a separate SQLite database whose `BEGIN IMMEDIATE` transaction holds an OS-backed lock for the complete mutation, and process death releases it automatically. Failed worktrees are retained for inspection and provider-session resumption; reuse verifies the managed path, registered Git worktree, common repository, and expected branch first.

The original checkout is never used as an agent working directory.

## User interfaces

The Commander CLI, JSON commands, and Ink TUI all call the same `AgentQApp` service. Queue creation and updates, task mutations and worktree cleanup, provider login, integration installation, diagnostics, and repository-scope changes therefore share validation and side effects across both surfaces. The TUI has no private durable queue state; it renders store snapshots and append-only events. In-process notifications make local updates immediate, while periodic polling discovers changes committed by other CLI/supervisor processes.

The Ink dashboard exposes three focusable panes for queues, tasks, and task details/live activity. Direct pane keys (`1`/`2`/`3`), cyclic focus, arrow or `j`/`k` selection, focused-pane resizing (`[`/`]`), pane-size reset (`0`), zoom (`z`), and contextual help (`?`) all operate on that durable view. `:` opens an action center containing queue and task operations, doctor and provider login, Codex/Claude integration, scope, refresh, help, and exit. Frequent actions also have contextual direct keys.

Queue create and edit use a complete form for name, repository/base, provider, concurrency, attempt limit, verification, and auto-commit configuration. Task and queue forms share large, individually bordered input fields; a focus-following viewport keeps the active control visible when the terminal cannot fit the complete form. Repository is selectable only during creation and is rendered read-only during editing. Task add and edit forms persist through the same service methods as their CLI equivalents; task edit saves include the version captured when the form opened, preserving optimistic concurrency.

The UI models system work as explicit flows instead of shelling out behind a dashboard refresh. Queue removal, cancellation, retry, integration, and worktree cleanup enter confirmation state; cleanup additionally selects safe or forced removal. Doctor results can be rerun. Provider login suspends Ink, gives the official Codex or Claude Code CLI ownership of the terminal, then restores the dashboard and reruns diagnostics. Integration records and displays each created, updated, or unchanged instruction file. Attempt history has its own read-only view.

Repository scope is mutable UI context. `AgentQApp.setAllRepositories()` changes queue resolution and snapshots, while the supervisor receives a getter for `activeRepositoryKey`; each claim evaluates that getter so toggling local/all scope changes worker eligibility without restarting either process.
