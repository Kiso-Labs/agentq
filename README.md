<div align="center">

<h1>agentq</h1>
<h3>Dependency in. Verified local change out.</h3>
<p>Durable parallel task queues for Codex and Claude Code—from structured work to an integrated local branch.</p>
<p><code>Bun</code> · <code>Ink</code> · <code>SQLite</code> · <code>Git worktrees</code> · <code>Codex</code> · <code>Claude Code</code></p>
<p><code>blocked → planned → implemented → verified → integrated → landed</code></p>

</div>

`agentq` is a local engineering task queue for running Codex and Claude Code agents in parallel. Every attempt gets its own Git branch and worktree. Dependencies, scope rules, verification evidence, approvals, delivery operations, and result commits are persisted in SQLite instead of living only in a prompt.

Every task uses AgentQ's mandatory two-agent workflow:

1. A read-only planning agent inspects the repository and produces a concrete file-, symbol-, and test-level handoff.
2. A fresh implementation agent receives the original structured task plus that handoff and performs the work.

This is AgentQ's own pipeline, not Codex or Claude Code's built-in plan mode. The planner cannot edit the repository or enqueue child tasks.

## Features

- Native `blocked_by` dependency graphs enforced by the scheduler.
- Exact blocker result commits used as dependent-task bases.
- Structured objectives, invariants, handoffs, expected paths, scope policy, gates, and approvals.
- Parallel agents in isolated Git worktrees with conservative file-scope concurrency control.
- Machine-enforced allowed paths, denied paths, changed-file limits, and verification commands.
- Durable failure classes and retry dispositions instead of treating every failure alike.
- Explicit `implemented → verified → ready_to_integrate → integrated → landed` delivery state.
- Immutable result refs, ordered local integration lanes, conflict reporting, and atomic local landing.
- Full-screen Ink UI, scriptable JSON commands, normalized live logs, and Codex-style activity output.

## Install

AgentQ runs on [Bun](https://bun.sh/) 1.3 or newer. Its package manifest includes the official Codex and Claude Code CLI packages. After the public npm release, the global install is:

```bash
npm install -g bun
npm install -g agentq

agentq provider login codex
agentq provider login claude
agentq doctor
```

Authentication remains owned by each official provider. AgentQ never reads or stores API keys.

For local development:

```bash
git clone https://github.com/Kiso-Labs/agentq.git
cd agentq
bun install --frozen-lockfile
bun run check
bun link
```

## Quick start

Create a governed queue for an existing Git repository:

```bash
cd ~/src/my-app

agentq queue create app \
  --repo . \
  --base main \
  --provider codex \
  --plan-model gpt-5.4-mini \
  --plan-instructions "Identify the smallest safe change and exact verification" \
  --implement-model gpt-5.4 \
  --implement-instructions "Keep public APIs stable and add focused tests" \
  --concurrency 4 \
  --max-attempts 3 \
  --allow-path "src/**" \
  --allow-path "tests/**" \
  --deny-path "src/generated/**" \
  --max-changed-files 20 \
  --verify "bun test" \
  --verify "bun run typecheck" \
  --base-drift replan \
  --land-strategy merge-train \
  --file-concurrency enforced
```

Teach both coding agents how to add tasks themselves:

```bash
agentq integrate all --repo .
```

Add a structured task. This is the executable version of the dependency/policy workflow AgentQ is built for:

```bash
agentq task add \
  --queue app \
  --title "Restore bounded retries" \
  --objective "Restore bounded retries without changing API behavior" \
  --blocked-by task_123 \
  --invariant "Existing response schemas remain unchanged" \
  --expected-path "src/services/**" \
  --deny-path "src/api/**" \
  --deny-path "tests/api/**" \
  --max-changed-files 20 \
  --verify "uv run pytest tests/services" \
  --verify "uv run ruff check ." \
  --accept "The regression test fails before the fix and passes after it" \
  --handoff "Report changed files and verification evidence" \
  --land-strategy stack
```

Inspect the dependency graph, then start the parallel supervisor:

```bash
agentq task graph --queue app
agentq                         # Ink UI plus foreground supervisor
```

Or run headlessly:

```bash
agentq run                     # continuous foreground worker
agentq run app --once          # drain runnable work and delivery, then exit
```

Tasks using `stack` or `merge-train` are integrated by the running supervisor when their verified result is ready. Delivery can also be inspected and driven explicitly:

```bash
agentq task integrate task_456
agentq queue delivery app
agentq queue land app --yes
```

Landing updates a configured **local branch**. AgentQ does not push remotes or open pull requests.

## Repository scope

When started inside a Git working tree, AgentQ uses the repository's canonical Git common directory as its scope. The Ink UI shows and runs only queues for that repository, and linked worktrees share the same scope. Queue names are case-insensitively unique within a repository, so two repositories can each have a queue named `app`.

Use the explicit cross-repository forms when needed:

```bash
agentq queue list --all
agentq task list --all
agentq run --all
```

In the UI, press `g` to switch between the current repository and all repositories. The supervisor follows that scope immediately.

## Queue configuration

Queue settings are available in both the CLI and the Ink create/edit form:

```bash
agentq queue edit app \
  --name delivery \
  --base release \
  --provider claude \
  --plan-model haiku \
  --plan-instructions "Map affected files, symbols, dependencies, and tests" \
  --implement-model sonnet \
  --implement-instructions "Follow the handoff and preserve compatibility" \
  --concurrency 4 \
  --max-attempts 3 \
  --verify "bun test" \
  --verify "bun run typecheck" \
  --allow-path "src/**" \
  --deny-path "src/generated/**" \
  --max-changed-files 20 \
  --checkpoint after-plan \
  --checkpoint before-land \
  --base-drift fail \
  --land-strategy merge-train \
  --auto-land \
  --file-concurrency enforced \
  --auto-commit
```

Repeatable queue flags replace their complete lists during an edit. Explicit clear flags remove inherited configuration:

```bash
agentq queue edit delivery \
  --clear-plan-model \
  --clear-plan-instructions \
  --clear-implement-model \
  --clear-implement-instructions \
  --clear-verify \
  --clear-allowed-paths \
  --clear-denied-paths \
  --clear-max-changed-files \
  --clear-checkpoints \
  --no-auto-land
```

The task's selected provider runs both stages. Queue-level plan and implementation model fields select stage-specific models when the task uses the queue provider; a blank model uses the provider default. A task-level provider override uses that provider's defaults rather than passing model names configured for another provider. Stage instructions remain reusable queue guidance.

Queue and task configuration is copied into an immutable run snapshot when an attempt is claimed. Editing configuration changes future fresh attempts, not an active attempt or a retained session resume.

Delivery requires a local branch target. When `--land-strategy` is `stack` or `merge-train`, AgentQ canonicalizes the queue base to `refs/heads/<branch>` and rejects tags, detached commits, or remote-tracking refs as landing targets. `--auto-land` requires a non-`none` landing strategy.

## Structured task specifications

Tasks are not one enormous instruction string. These are native, independently inspectable fields:

- Title, instructions, objective, priority, provider, and acceptance criteria.
- `blockedBy` dependency IDs.
- Invariants and handoff requirements.
- Expected, allowed, and denied path globs.
- Maximum changed files.
- Task-specific verification commands.
- Approval checkpoints.
- Base-drift and landing policies.
- Idempotency and parent-task provenance.

Create and edit forms expose the same fields. CLI task edits are equally complete:

```bash
agentq task edit task_456 \
  --title "Revised retry outcome" \
  --objective "Implement the reviewed service-only design" \
  --blocked-by task_123 \
  --invariant "Public response schemas remain unchanged" \
  --expected-path "src/services/retry.ts" \
  --allow-path "src/services/**" \
  --deny-path "src/api/**" \
  --max-changed-files 12 \
  --verify "bun test test/services.test.ts" \
  --checkpoint after-plan \
  --base-drift replan \
  --land-strategy stack \
  --handoff "Include verification evidence" \
  --provider claude \
  --priority 10 \
  --accept "All gates pass"
```

List fields have matching clear options such as `--clear-blockers`, `--clear-invariants`, `--clear-expected-paths`, `--clear-allowed-paths`, `--clear-denied-paths`, `--clear-max-changed-files`, `--clear-verify`, `--clear-checkpoints`, `--clear-handoff`, and `--clear-acceptance`.

Only `queued`, `failed`, `interrupted`, or `cancelled` tasks with no active run are editable. Active and succeeded tasks are locked. Optimistic version checks reject stale saves instead of overwriting newer edits, and every successful edit records a task event.

JSON stdin provides the same structured contract for automation:

```bash
printf '%s' '{
  "queue": "app",
  "title": "Cover the checkout race",
  "objective": "Add deterministic coverage for the checkout race",
  "blockedBy": ["task_123"],
  "invariants": ["Do not change the public checkout response"],
  "expectedPaths": ["src/checkout/**", "tests/checkout/**"],
  "deniedPaths": ["src/api/**"],
  "maxChangedFiles": 10,
  "verifyCommands": ["bun test tests/checkout.test.ts"],
  "approvalCheckpoints": ["after-plan"],
  "baseDriftPolicy": "replan",
  "landStrategy": "stack",
  "provider": "claude",
  "idempotencyKey": "checkout-race-coverage"
}' | agentq task add --stdin-json
```

## Native dependency graphs

`blocked_by` is scheduler state, not prose:

- A task is not claimable until every blocker has succeeded and published a verified immutable result commit.
- A task with one blocker starts from that blocker's exact result commit.
- Multiple blockers must all be successfully integrated into one shared delivery lane; the dependent starts from that lane's current verified head containing every blocker.
- Fan-in across different lanes or with any unintegrated blocker remains blocked; AgentQ will not guess how to combine divergent histories.
- Dependency snapshots are frozen into the claimed run.
- Cycles and invalid dependencies are rejected, and a blocker cannot be deleted while dependents still reference it.
- Blocked work waits without consuming an attempt.

Use either view:

```bash
agentq task graph --queue app
agentq task graph --queue app --json
```

The UI details pane shows blockers and their result evidence alongside the selected task.

## Parallel execution and file concurrency

The supervisor atomically claims queued work and launches each task in a dedicated branch and worktree:

```text
repository main
├── agentq/app/fix-login-task123-a1       worktree A → Codex
├── agentq/app/export-data-task456-a1     worktree B → Claude Code
└── agentq/app/test-race-task789-a1       worktree C → Codex
```

Git worktree mutations are serialized per repository with crash-recoverable SQLite/OS locks. Provider processes run concurrently after provisioning.

File concurrency uses a task's `expectedPaths`, then task `allowedPaths`, then queue `allowedPaths` as its predicted scope. An unspecified scope is conservatively repository-wide. Modes are:

- `off`: queue capacity is the only scheduling limit.
- `advisory`: retain declared scopes without scheduler exclusion.
- `enforced`: do not run conservatively overlapping scopes at the same time. If either the candidate or an active queue is enforced, an overlap serializes the tasks.

This keeps independent packages parallel while preventing two agents from simultaneously changing the same service or project metadata. It is conservative by design; ambiguous globs serialize rather than gamble.

## Plan → implement

A successful attempt proceeds through:

1. Resolve the exact dependency or queue base.
2. Detect base drift before creating the worktree.
3. Run the planning agent with read-only tools.
4. Verify the planner left `HEAD` unchanged and the worktree completely clean.
5. Persist the plan and any required implementation-boundary approvals.
6. Start a fresh implementation process with the structured task and complete plan handoff.
7. Evaluate path and changed-file policy against the authoritative Git diff.
8. Run queue and task verification commands.
9. Create a canonical result commit and immutable result ref when delivery or dependencies require one.
10. Integrate and optionally land the verified result.

An empty planner response or any Git-visible planner change fails planning and prevents implementation. A retained planning session can resume and still hands off to a fresh implementation process. A retained implementation session resumes with its stored plan. A normal retry always starts a new attempt from planning.

## Machine-enforced scope and verification

Scope policy is evaluated from Git, not from the agent's final message:

- Every changed path must satisfy each non-empty queue and task allow-list.
- Queue and task deny-lists are combined.
- The stricter queue/task changed-file maximum wins.
- Renames check both the original and destination paths.
- A policy violation is terminal and cannot produce a verified result.

Verification results are durable typed gates:

- `allowed_paths`
- `denied_paths`
- `max_changed_files`
- each configured `command`
- `clean_worktree` for a canonical immutable result

Queue commands run first, followed by task commands. A task reaching `succeeded` means its effective policy and every configured command passed—not merely that an agent said it was done. Deliverable and dependency-producing tasks must also create a canonical commit under:

```text
refs/agentq/results/<task-id>/<run-id>
```

Integration repeats scope evaluation and verification against the replayed candidate before advancing the train. A branch produced by an agent is therefore different from a verified artifact, and a verified artifact is different from an integrated or landed result.

## Base drift and typed retries

Each task records the target SHA visible when it was created. Before a root task starts, AgentQ compares that SHA with the queue's current local base:

- `--base-drift fail` records `stale_base` and stops.
- `--base-drift rebase` or `replan` prepares the attempt from the current base and runs the planning pipeline there.
- Dependency-based tasks use their blocker evidence instead of silently rebasing onto unrelated branch movement.

Failures carry a class and disposition:

| Failure class | Disposition |
| --- | --- |
| transient infrastructure | retry without spending an attempt |
| stale base | rebase and retry without spending an attempt |
| test regression | return to implementation |
| blocked dependency | wait without spending an attempt |
| integration contention | retry with bounded backoff |
| file or integration conflict | require manual resolution |
| policy violation | stop permanently |
| agent failure / unknown | retry within the attempt budget |
| cancellation | stop |

The dashboard and JSON task records show the class, concise reason, and retry disposition.

## Approval checkpoints

Approval decisions are durable records with checkpoint, status, actor, note, and decision time. Queue and task checkpoints are combined and deduplicated.

Checkpoint names select their boundary:

- `before-integrate`, `integrate`, and `after-verify` pause before integration.
- `before-land`, `land`, and `after-integrate` pause before landing.
- Any other name—including `after-plan`, `security-review`, or `red-tests-reviewed`—pauses after planning and before implementation.

Manage approvals from the CLI:

```bash
agentq task approvals task_456
agentq task approve task_456 security-review \
  --actor release-manager \
  --note "Plan and red tests reviewed"

agentq task reject task_456 security-review \
  --actor release-manager \
  --note "Scope is too broad" \
  --yes
```

Rejection stops the task as a policy decision. In Ink, press `p` to open approvals, `a`/`Enter` to approve, and `r` to reject; actor and note are collected in a confirmed form.

## Delivery: verified result → local target

Task delivery state is explicit:

```text
not_started
    ↓
implemented
    ↓
verified
    ↓
ready_to_integrate
    ↓
integrated
    ↓
landed
```

Landing strategies are:

- `none`: keep normal task branch/result behavior; no automatic integration lane.
- `stack`: publish immutable results and use dependency commits to build a natural stack.
- `merge-train`: publish immutable results and replay ready work through the queue's ordered train.

Both `stack` and `merge-train` use the durable queue integration lane. Each integration operation:

1. Claims a fenced lane lease.
2. Replays the immutable task result onto the current train head in a temporary worktree.
3. Reports exact conflicting paths instead of claiming success.
4. Re-evaluates path policy and verification commands.
5. Advances the train with a compare-and-swap only after every gate passes.

Landing uses another fenced, compare-and-swap operation to update the configured local target branch. It detects target drift, refuses unsafe dirty checked-out targets, records the landed SHA atomically with task state, and is idempotent across retries or crashes.

The running supervisor automatically integrates ready tasks whose strategy is not `none`. `--auto-land` also lands eligible integrated results after approvals. Manual operations are safe and idempotent:

```bash
agentq task integrate task_456
agentq queue delivery app
agentq queue land app --yes
```

`queue delivery` shows the target/train refs, generation and head, task phase/delivery status, branch/base/result SHAs, recent operations, conflicts, and errors. `--json` returns the complete queue, lane, task, artifact, and operation snapshot.

AgentQ's delivery boundary is intentionally local: it updates local Git refs and checked-out local target branches. It does **not** push, create pull requests, or merge a remote hosting branch.

## Ink UI

The dashboard works in wide, medium, narrow, resized, and zoomed terminals. The details pane shows:

- Current plan/implement/verify/approval/integrate/land phase.
- Task and delivery status.
- Branch, base SHA, result SHA, integrated SHA, and landed SHA.
- Blockers and immutable dependency evidence.
- Changed files and every verification result.
- Approval state and latest delivery operation.
- Conflict files, failure class/reason/disposition, elapsed time, tokens, and cost.

Core controls:

- `1`, `2`, `3` focus queues, tasks, or details. `Tab`, `Shift+Tab`, `←`, and `→` cycle focus.
- `↑`, `↓`, `j`, and `k` move selection.
- `[` and `]` resize the focused pane, `0` resets layout, and `z` toggles zoom.
- `:` opens the action center containing queue, task, provider, integration, approval, delivery, scope, refresh, help, and quit operations.
- `n` creates a queue; `a` adds a task; `e` edits the focused queue or selected task.
- `x` deletes a queue/inactive task; `X` cleans a retained worktree.
- `c` cancels, `r` retries, `s` resumes, `d` manually completes, and `v` opens attempt history.
- `p` opens approvals, `i` integrates a verified result, and `L` lands the selected queue. Integration and landing require confirmation.
- `f` cycles status filters, `g` toggles repository scope, `R` refreshes, `?` opens help, and `q` quits.

Queue forms expose repository/base, provider, both stage models and instructions, concurrency, attempt limit, verification, auto-commit, path policy, file limit, approvals, drift policy, landing strategy, auto-land, and file concurrency.

Task forms expose every structured field described above. Inputs are large individually bordered fields with focus-following viewports. Use `Tab`/`Shift+Tab` between fields, arrows for selectors, `Space` for toggles, `Ctrl+N` for a multiline newline, `Ctrl+U` to clear, `Ctrl+S` to save, and `Esc` to cancel.

Consequential actions use confirmation screens. Active work and retained worktrees block deletion. Provider login temporarily yields the terminal to the real provider CLI, then restores Ink.

## Adding tasks from Codex or Claude Code

Agents use the same durable intake as humans. During a managed run, AgentQ injects `AGENTQ_QUEUE`, `AGENTQ_TASK_ID`, `AGENTQ_RUN_ID`, and `AGENTQ_STAGE` (`plan` or `implement`).

Only the implementation process receives the private task-intake directory, so the planner cannot enqueue child work. A child task is recorded with parent provenance. Idempotency keys prevent duplicates across retries.

Codex remains sandboxed: managed `task add` requests cross a per-run intake directory, and the supervisor atomically stages, validates, and inserts them. The agent never needs database access or another task's worktree. Delegation defaults to 16 child tasks per parent and four ancestry levels; lower those bounds with `AGENTQ_MAX_CHILD_TASKS_PER_RUN` and `AGENTQ_MAX_DELEGATION_DEPTH`.

## Deleting tasks and queues safely

Task and queue deletion require explicit confirmation in Ink or `--yes` in the CLI. Deleting a task removes its attempts, events, local logs, approvals, and delivery metadata. Deleting a queue atomically removes the queue and all inactive task history.

Deletion refuses active work, retained worktrees, and blockers that still have dependent tasks. Delete leaf tasks first. If a terminal task retains a worktree, run:

```bash
agentq task clean <id> --yes
agentq task remove <id> --yes
agentq queue remove <queue> --yes
```

Local-log cleanup failures report the remaining paths rather than silently ignoring them.

## Command reference

```text
agentq                                  open Ink and run the supervisor
agentq doctor                           check Git, providers, auth, state, and isolation
agentq provider list                    show provider versions and authentication
agentq provider login <provider>        run the official provider login

agentq queue create <name>              create a repository-backed queue
agentq queue edit <queue>               edit workflow, policy, concurrency, and delivery
agentq queue list [--all]               list scoped queues or all repositories
agentq queue show <queue>               show queue configuration and tasks
agentq queue delivery <queue>           show lane, artifacts, tasks, and operations
agentq queue land <queue> --yes          atomically land the local integration train
agentq queue remove <queue> --yes        delete a queue and inactive history

agentq task add                         add a manual or --stdin-json task
agentq task edit <id>                   edit a queued/retryable structured specification
agentq task list [--all]                list and filter scoped tasks
agentq task graph [--queue <queue>]     show the native dependency graph
agentq task show <id>                   show task, attempts, and recent events
agentq task logs <id> --follow          stream normalized provider activity
agentq task approvals <id>              list durable checkpoints
agentq task approve <id> <checkpoint>   approve a pending checkpoint
agentq task reject <id> <checkpoint>    reject a checkpoint with --yes
agentq task integrate <id>              add a verified result to its local train
agentq task cancel <id>                 cancel queued/running work
agentq task retry <id>                  start a fresh attempt and planning stage
agentq task resume <id>                 continue a retained agent stage/worktree
agentq task complete <id>               mark non-running work complete manually
agentq task clean <id> --yes            remove a retained terminal worktree
agentq task remove <id> --yes           delete an inactive task and its history

agentq run [queue] [--all]              run scoped queues or all repositories
agentq run [queue] --once               drain runnable work and delivery, then exit
agentq integrate <codex|claude|all>      install agent task-creation instructions
```

Commands intended for automation support `--json`; task intake also supports JSON stdin. Run `agentq <command> --help` for complete options.

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
└── worktrees/
    ├── <repository>/<task>/<attempt>/
    └── delivery/
```

Use `AGENTQ_STATE_DIR`, `XDG_STATE_HOME`, or global `--state-dir` to change it.

SQLite runs in WAL mode with foreign keys, a busy timeout, atomic task claims, dependency snapshots, fenced supervisor and delivery leases, idempotency constraints, and append-only task events. Integration artifacts, lanes, operations, approvals, and verification evidence survive restarts.

Providers start behind a gate: their random process identity is persisted before the real Codex or Claude command is released. If a supervisor dies, a live peer fences the stale run, verifies and terminates its orphan process tree, then makes the task retryable. Reused PIDs are never signalled, and ambiguous exits are never reported as success.

## Security model

- Codex planning runs read-only; implementation runs workspace-write and receives only its run's intake directory as an additional writable root.
- Claude Code planning is restricted to `Read`, `Glob`, and `Grep`; implementation uses its configured coding-tool allow-list. Claude Code does not provide the same filesystem sandbox as Codex.
- Dangerous provider bypass flags are never enabled automatically.
- Child processes receive argument arrays rather than interpolated shell commands.
- Process cleanup targets the complete lifecycle-owned tree: POSIX process groups and Windows Job Objects.
- Provider credentials remain in provider-owned credential stores.
- Verification commands are trusted queue/task configuration and run through the platform shell inside isolated worktrees.
- Delivery targets only canonical local branches and uses immutable refs, temporary worktrees, fenced leases, and compare-and-swap updates.

See [docs/security.md](docs/security.md) for exact trust boundaries.

## Development

```bash
bun install
bun run typecheck
bun run lint
bun run test
bun run build
bun run check
```

Architecture details live in [docs/architecture.md](docs/architecture.md). Maintainers can follow [docs/releasing.md](docs/releasing.md) for the token-free npm release process.

## License

MIT
