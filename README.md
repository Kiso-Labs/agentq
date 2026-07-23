<div align="center">

<h1>🌮 agentq 🌮</h1>
<h3>Plan it. Queue it. Ship it.</h3>
<p>Durable parallel task queues for coding agents—with a fresh Git prep station for every task.</p>
<p><code>Bun</code> · <code>Ink</code> · <code>SQLite</code> · <code>Git worktrees</code> · <code>Codex</code> · <code>Claude Code</code></p>

</div>

> **The taco workflow:** the queue is the shell, planning is the recipe, implementation is the filling, and isolated worktrees keep every agent at its own prep station.

`agentq` is a local, durable task queue for running Codex and Claude Code agents in parallel. Every attempt gets its own Git branch and worktree, so agents can work simultaneously without writing into the same checkout.

Every task uses a mandatory two-agent workflow. A read-only planning process inspects the repository and produces a concrete file-, symbol-, and test-level handoff. A fresh implementation process then receives that handoff and performs the work. This custom planning stage cannot be disabled and is agentq's own pipeline, not Codex or Claude Code's built-in plan mode.

It includes a full-screen Ink interface, scriptable JSON commands, SQLite persistence, live event logs, cancellation, retries, provider-session resumption, verification commands, and agent-to-agent task delegation.

## 🌮 Install

agentq runs on [Bun](https://bun.sh/) 1.3 or newer. Its package manifest includes the official Codex and Claude Code CLI packages. After the first public npm release, the global install will be:

```bash
npm install -g bun
npm install -g agentq

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

## 🌮 Quick start

Create a queue for an existing Git repository:

```bash
cd ~/src/my-app

agentq queue create app \
  --repo . \
  --provider codex \
  --plan-model gpt-5.4-mini \
  --plan-instructions "Identify the smallest safe change and exact verification" \
  --implement-model gpt-5.4 \
  --implement-instructions "Keep public APIs stable and add focused tests" \
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

### 🫘 Repository scope

When started inside a Git working tree, agentq uses the repository's canonical Git common directory as its scope. The Ink UI shows and runs only queues for that repository, and linked worktrees share the same scope. Queue names are case-insensitively unique within a repository, so two different repositories can each have a queue named `app`.

Use the explicit cross-repository forms when needed:

```bash
agentq queue list --all
agentq task list --all
agentq run --all
```

In the UI, press `g` to switch between the current repository and all repositories. The running supervisor follows that scope change immediately; restarting the UI is not required.

### 🌶️ Queue configuration

Queue settings can be changed from the CLI or the Ink queue form:

```bash
agentq queue edit app \
  --name delivery \
  --base main \
  --provider claude \
  --plan-model haiku \
  --plan-instructions "Map the affected files, symbols, and tests" \
  --implement-model sonnet \
  --implement-instructions "Follow the handoff and preserve compatibility" \
  --concurrency 4 \
  --max-attempts 3 \
  --verify "bun test" \
  --verify "bun run typecheck" \
  --no-auto-commit

agentq queue edit delivery \
  --clear-plan-model \
  --clear-plan-instructions \
  --clear-implement-model \
  --clear-implement-instructions \
  --clear-verify \
  --auto-commit
```

The task's selected provider is used for both planning and implementation. The two queue model fields select stage-specific models when the task uses the queue's default provider, and leaving either model blank uses that provider's default. If a task overrides the queue provider, agentq uses the override provider's default model for both stages instead of passing model names configured for a different provider. Planning and implementation instructions remain reusable queue-level guidance for every task in the queue.

The four workflow settings are copied into the run's immutable snapshot when an attempt is claimed. Editing a queue changes later fresh attempts, but it cannot change an active attempt or a session resume that is continuing an earlier snapshot.

`--verify` is repeatable and replaces the complete verification-command list; `--clear-verify` removes it. The four `--clear-plan-*` and `--clear-implement-*` options restore provider-default models or remove stage guidance. Queue edits can also change the name, base ref, default provider, concurrency, attempt limit, verification commands, and auto-commit policy. The canonical repository identity and repository path stay fixed; create another queue to target a different repository.

### 🧅 Keyboard UI

The dashboard works in wide, medium, and narrow terminals. Its controls are:

- `1`, `2`, `3` focus the queues, tasks, or details pane; `Tab`, `Shift+Tab`, `←`, and `→` cycle focus.
- `↑`, `↓`, `j`, and `k` move through the focused queue or task list.
- `[` and `]` shrink or grow the focused pane, `0` restores the default pane sizes, and `z` toggles a focused-pane zoom.
- `:` opens the action center, which exposes every queue, task, provider, integration, scope, refresh, help, and quit action in one place. Use `↑`, `↓`, `j`, or `k` to select, `Enter` to run, and `:` or `Esc` to close it.
- `n` creates a queue. `e` edits the selected queue when the queue pane is focused, or the selected task otherwise. `x` deletes the selected queue or inactive task, and `X` cleans a terminal task's retained worktree.
- Task shortcuts are `a` add, `c` cancel, `r` retry, `s` resume, `d` manually complete, and `v` view attempts.
- `f` cycles the task-status filter, `g` toggles local/all-repository scope, `R` refreshes, `?` opens keyboard help, and `q` quits. `Esc` closes help, forms, results, and confirmation prompts.

Queue creation collects the name, repository path, optional base ref, provider, planning model and instructions, implementation model and instructions, concurrency, maximum attempts, verification commands, and auto-commit policy. Enter multiple verification commands separated by `;`; a blank stage model uses the provider default. Queue editing exposes the same settings while showing its repository as read-only. Task and queue forms use large, individually bordered fields with a focus-following viewport on shorter terminals, so inputs remain comfortable instead of collapsing into compact rows. In all forms, use `Tab` and `Shift+Tab` to move between fields, arrow keys to change selectors, `Ctrl+N` to insert a newline in a multiline field, `Ctrl+U` to clear the current editable field, `Ctrl+S` to save, and `Esc` to cancel.

Destructive and consequential actions are explicit. Task and queue deletion, task cancellation or retry, and provider-instruction installation require confirmation (`y`/`Enter` accepts; `n`/`Esc` cancels). Worktree cleanup also asks whether to use safe or force removal; press `f` or an arrow key to toggle that choice. Active work and retained worktrees block deletion, so cancel or finish active tasks and clean retained worktrees before deleting them. The doctor screen uses `R` to rerun checks, `c` for real Codex login, and `l` for real Claude Code login. agentq temporarily yields the terminal to the official provider CLI, then restores Ink and refreshes the checks. Integration can target Codex, Claude Code, or both and reports each instruction file as created, updated, or unchanged. Attempt and integration-result screens close with `v`/`Esc` and `Enter`/`Esc`, respectively.

## 🌮 Adding tasks from Codex or Claude Code

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

During a managed run, agentq injects `AGENTQ_QUEUE`, `AGENTQ_TASK_ID`, `AGENTQ_RUN_ID`, and `AGENTQ_STAGE` (`plan` or `implement`). Only the implementation process receives the private task-intake directory, so the planner cannot enqueue child work. A task created there is recorded with parent/child provenance. Idempotency keys prevent duplicates across retries.

Codex remains sandboxed while doing this: managed `task add` requests cross a per-run intake directory, and the supervisor atomically stages, validates, and inserts them. The agent never needs write access to the database or another task's worktree. Delegation defaults to 16 child tasks per parent and four ancestry levels; operators can lower those bounds with `AGENTQ_MAX_CHILD_TASKS_PER_RUN` and `AGENTQ_MAX_DELEGATION_DEPTH`.

## 🌮 Editing tasks safely

Task specifications can be revised from either the CLI or the Ink edit form:

```bash
agentq task edit <task-id> \
  --title "Revised outcome" \
  --instructions "Use the new API and add regression coverage" \
  --provider claude \
  --priority 10 \
  --accept "The regression test fails before the fix" \
  --accept "All verification commands pass"

agentq task edit <task-id> --clear-acceptance
```

`--accept` is repeatable and replaces the complete acceptance-criteria list; `--clear-acceptance` removes it. Edits are limited to title, instructions, provider, priority, and acceptance criteria. Only `queued`, `failed`, `interrupted`, or `cancelled` tasks with no active run are editable. `starting`, `running`, `cancelling`, and `succeeded` tasks are locked, and optimistic version checks reject stale saves instead of overwriting a newer edit.

Each claim atomically stores an immutable snapshot of those five task fields plus the queue's planning model/instructions and implementation model/instructions on its run. Editing a retryable task or its queue changes the next fresh claimed attempt without rewriting what any previous attempt was asked to do. A retained session resume continues the earlier run's snapshot.

## 🌮 Parallel execution model

The supervisor atomically claims queued work from SQLite. It enforces each queue's concurrency limit and launches every claimed task in a dedicated worktree:

```text
repository main
├── agentq/app/fix-login-task123-a1       worktree A → Codex
├── agentq/app/export-data-task456-a1     worktree B → Claude Code
└── agentq/app/test-race-task789-a1       worktree C → Codex
```

Git worktree mutations are serialized per repository with crash-recoverable SQLite/OS locks. Agent processes run concurrently after provisioning. Parallel worktrees prevent filesystem collisions, but independently produced branches can still contain semantic merge conflicts.

A successful attempt proceeds through:

1. A planner using the task's provider and planning model inspects the worktree with read-only tools and returns a non-empty implementation handoff.
2. agentq verifies that the planner left `HEAD` unchanged and the Git worktree clean of tracked or untracked changes, then stores the handoff and planner session durably.
3. A fresh process using the same provider and implementation model receives the original task, acceptance criteria, implementation guidance, and complete planner handoff.
4. Queue verification commands pass in the task worktree.
5. Uncommitted changes are committed to the task branch when auto-commit is enabled.
6. The task is marked succeeded with its branch, commit, worktree, summary, and event history.

An empty planner response or any Git-visible planner worktree change fails the planning phase; implementation is not started. There is no option to skip this custom planning stage or substitute either provider's built-in plan mode. When a retained provider stage and worktree from the current schema are available, `task resume` continues that phase. A planning-phase resume continues its planner session and still creates a fresh implementation process after producing a valid handoff. An implementation-phase resume reuses the stored handoff and resumes its implementation session when one was captured; if startup failed before a session existed, it starts a fresh implementation process in the retained worktree. Legacy pre-v5 sessions have no trustworthy planner handoff and are rejected for resume; use `task retry` to start them again with a fresh planning attempt. Every ordinary `task retry` likewise starts a new attempt from planning.

agentq never merges, pushes, or opens pull requests automatically.

## 🌮 Deleting tasks and queues safely

Task and queue deletion require explicit confirmation in the Ink UI or `--yes` in the CLI. Deleting a task removes its attempts, events, and local logs. Deleting a queue atomically removes the queue and all of its inactive tasks, attempts, events, and local logs.

Deletion refuses active work and any task that still has a retained worktree. Cancel or finish active tasks first, then run `agentq task clean <id> --yes` for each retained worktree before retrying deletion. This guard keeps agentq from orphaning an agent process or silently discarding an inspection/resume worktree. Both delete commands support `--json` for automation.

## 🌮 Commands

```text
agentq                              open the Ink UI and run workers
agentq doctor                       verify Git, providers, auth, state, and isolation
agentq provider list                show provider versions and auth status
agentq provider login <provider>    run the official login flow

agentq queue create <name>          create a repository-backed queue
agentq queue edit <queue>           change mutable queue configuration
agentq queue list [--all]           list scoped queues or every repository
agentq queue show <queue>           show queue and tasks
agentq queue remove <queue> --yes   delete a queue and its inactive task history

agentq task add                     add a task manually or with --stdin-json
agentq task edit <id>               revise fields on a queued or retryable task
agentq task list [--all]            filter scoped tasks or every repository
agentq task show <id>               show attempts and recent events
agentq task logs <id> --follow      stream normalized provider events
agentq task cancel <id>             cancel queued/running work
agentq task retry <id>              retry in a fresh session/worktree
agentq task resume <id>             continue the latest retained agent stage/worktree
agentq task complete <id>           mark non-running work complete manually
agentq task clean <id> --yes        remove a terminal task's retained worktree
agentq task remove <id> --yes       delete an inactive task and its history

agentq run [queue] [--all]          run scoped queues or every repository
agentq run [queue] --once            drain runnable work and exit
agentq integrate <codex|claude|all>  install agent task-creation instructions
```

Every listing and mutation intended for automation supports JSON input or output. Run `agentq <command> --help` for the complete options.

## 🌮 State and recovery

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

## 🌮 Security model

- Codex planning runs with `read-only`; implementation runs with `workspace-write` and receives only its run's intake directory as an additional writable root.
- Claude Code planning is restricted with `--tools Read,Glob,Grep`; implementation uses `acceptEdits` plus `--tools` and `--allowedTools` for the configured coding-tool set. Claude Code does not provide the same filesystem sandbox as Codex.
- Dangerous provider bypass flags are never enabled automatically.
- Child processes receive argument arrays rather than interpolated shell commands.
- Process cleanup targets the complete lifecycle-owned tree: POSIX process groups and Windows Job Objects.
- Provider credentials remain in the providers' own credential stores.
- Verification commands are trusted queue configuration and run through the platform shell inside the isolated worktree.

See [docs/security.md](docs/security.md) for the exact trust boundaries.

## 🌮 Development

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

## 🌮 License

MIT
