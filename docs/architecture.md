# Architecture

agentq is a single local control plane with four separable layers.

## Durable control plane

`AgentQStore` owns the SQLite schema and all state transitions. Queue creation, task insertion, task claims, run completion, retries, cancellation, and event append operations cross explicit transactions. A task claim creates its run record and random supervisor lease in the same `BEGIN IMMEDIATE` transaction that changes the task from `queued` to `starting`. Lease tokens fence late writes from a recovered owner.

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
4. Starts a gated launcher and durably records its random process identity.
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

The Commander CLI, JSON commands, and Ink TUI all call the same `AgentQApp` service. The TUI has no private in-memory queue state; it renders durable snapshots and append-only events. In-process notifications make local updates immediate, while periodic polling discovers changes committed by other CLI/supervisor processes.
