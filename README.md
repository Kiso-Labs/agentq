# agentq

`agentq` is a local, durable task queue for running Codex and Claude Code agents in parallel. Every attempt gets its own Git branch and worktree, so agents can work simultaneously without writing into the same checkout.

It includes a full-screen Ink interface, scriptable JSON commands, SQLite persistence, live event logs, cancellation, retries, provider-session resumption, verification commands, and agent-to-agent task delegation.

## Install

agentq runs on [Bun](https://bun.sh/) 1.3 or newer. The npm package includes the official Codex and Claude Code CLI packages.

```bash
npm install -g bun
npm install -g agentq # available after the first public npm release

agentq provider login codex
agentq provider login claude
agentq doctor
```

Authentication remains owned by each official provider. agentq never reads or stores API keys.

For local development:

```bash
git clone https://github.com/Luke-Pitstick/agentq.git
cd agentq
bun install --frozen-lockfile
bun run check
bun link
```

## Quick start

Create a queue for an existing Git repository:

```bash
cd ~/src/my-app

agentq queue create app \
  --repo . \
  --provider codex \
  --concurrency 4 \
  --verify "bun test" \
  --verify "bun run typecheck"
```

Teach both coding agents how to add tasks themselves:

```bash
agentq integrate all --repo .
```

Add work manually:

```bash
agentq task add \
  --queue app \
  --title "Fix expired-session redirects" \
  --instructions "Reproduce the redirect loop, fix it, and add a regression test" \
  --accept "An expired session redirects to /login exactly once"
```

Open the UI and start the parallel supervisor:

```bash
agentq
```

Or run headlessly:

```bash
agentq run                 # continuous foreground worker
agentq run app --once      # drain one queue, then exit
```

## Adding tasks from Codex or Claude Code

Agents use the same durable intake as humans. JSON stdin is stable and avoids shell-quoting problems:

```bash
printf '%s' '{
  "queue": "app",
  "title": "Cover the checkout race",
  "instructions": "Add a deterministic regression test for the race found in checkout",
  "provider": "claude",
  "idempotencyKey": "checkout-race-coverage"
}' | agentq task add --stdin-json
```

During a managed run, agentq injects `AGENTQ_QUEUE`, `AGENTQ_TASK_ID`, and `AGENTQ_RUN_ID`. A task created by that agent is recorded with parent/child provenance. Idempotency keys prevent duplicates across retries.

Codex remains sandboxed while doing this: managed `task add` requests cross a per-run intake directory, and the supervisor atomically stages, validates, and inserts them. The agent never needs write access to the database or another task's worktree. Delegation defaults to 16 child tasks per parent and four ancestry levels; operators can lower those bounds with `AGENTQ_MAX_CHILD_TASKS_PER_RUN` and `AGENTQ_MAX_DELEGATION_DEPTH`.

## Parallel execution model

The supervisor atomically claims queued work from SQLite. It enforces each queue's concurrency limit and launches every claimed task in a dedicated worktree:

```text
repository main
├── agentq/app/fix-login-task123-a1       worktree A → Codex
├── agentq/app/export-data-task456-a1     worktree B → Claude Code
└── agentq/app/test-race-task789-a1       worktree C → Codex
```

Git worktree mutations are serialized per repository with crash-recoverable SQLite/OS locks. Agent processes run concurrently after provisioning. Parallel worktrees prevent filesystem collisions, but independently produced branches can still contain semantic merge conflicts.

A successful attempt proceeds through:

1. Provider process exits successfully.
2. Queue verification commands pass in the task worktree.
3. Uncommitted changes are committed to the task branch when auto-commit is enabled.
4. The task is marked succeeded with its branch, commit, worktree, summary, and event history.

agentq never merges, pushes, or opens pull requests automatically.

## Commands

```text
agentq                              open the Ink UI and run workers
agentq doctor                       verify Git, providers, auth, state, and isolation
agentq provider list                show provider versions and auth status
agentq provider login <provider>    run the official login flow

agentq queue create <name>          create a repository-backed queue
agentq queue list                   list queues and concurrency
agentq queue show <queue>           show queue and tasks
agentq queue remove <queue> --yes   remove an empty queue

agentq task add                     add a task manually or with --stdin-json
agentq task list                    filter tasks by queue or status
agentq task show <id>               show attempts and recent events
agentq task logs <id> --follow      stream normalized provider events
agentq task cancel <id>             cancel queued/running work
agentq task retry <id>              retry in a fresh session/worktree
agentq task resume <id>             resume the retained provider session/worktree
agentq task complete <id>           mark non-running work complete manually
agentq task clean <id> --yes        remove a retained worktree

agentq run [queue]                   run the foreground supervisor
agentq run [queue] --once            drain runnable work and exit
agentq integrate <codex|claude|all>  install agent task-creation instructions
```

Every listing and mutation intended for automation supports JSON input or output. Run `agentq <command> --help` for the complete options.

## State and recovery

State defaults to:

```text
~/.local/state/agentq/
├── agentq.sqlite
├── locks/repo-<hash>.sqlite
├── logs/<task>/<run>.jsonl
├── intake/<run>/
├── intake-staging/
├── process-identities/
└── worktrees/<repository>/<task>/<attempt>/
```

Use `AGENTQ_STATE_DIR`, `XDG_STATE_HOME`, or the global `--state-dir` option to change it.

SQLite runs in WAL mode with foreign keys, a busy timeout, atomic claims, fenced supervisor leases, idempotency constraints, and append-only task events. Providers start behind a gate: their random process identity is persisted before the real Codex or Claude command is released. If a supervisor dies, a live peer first fences the stale run, verifies and terminates its orphan process tree, and only then makes the task retryable. Reused PIDs are never signalled, and ambiguous provider exits are never reported as successful.

## Security model

- Codex runs with `workspace-write` sandboxing by default.
- Claude Code runs in `acceptEdits` mode with an explicit coding-tool allowlist. Claude Code does not provide the same filesystem sandbox as Codex.
- Dangerous provider bypass flags are never enabled automatically.
- Child processes receive argument arrays rather than interpolated shell commands.
- Cancellation targets the complete process group, escalating from graceful termination to forced kill.
- Provider credentials remain in the providers' own credential stores.
- Verification commands are trusted queue configuration and run through the platform shell inside the isolated worktree.

See [docs/security.md](docs/security.md) for the exact trust boundaries.

## Development

```bash
bun install
bun run typecheck
bun run lint
bun run test
bun run build
bun run check
```

Architecture details live in [docs/architecture.md](docs/architecture.md). Maintainers can follow
[docs/releasing.md](docs/releasing.md) for the token-free npm release process.

## License

MIT
