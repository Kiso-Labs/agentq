<div align="center">

<h1>AgentQ</h1>
<p><strong>Dependency-aware orchestration and local delivery for coding agents.</strong></p>
<p>Plan, run, verify, integrate, and land parallel Codex and Claude Code tasks from one durable queue.</p>

<p>
  <a href="https://github.com/Kiso-Labs/agentq/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Kiso-Labs/agentq/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://bun.sh"><img alt="Bun 1.3+" src="https://img.shields.io/badge/Bun-1.3%2B-14151a?logo=bun&logoColor=white"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-2563eb"></a>
</p>

<p>
  <a href="#installation">Installation</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#terminal-ui">Terminal UI</a> ·
  <a href="#core-concepts">Core concepts</a> ·
  <a href="#command-reference">CLI reference</a>
</p>

</div>

## Overview

AgentQ coordinates parallel coding agents through the complete path from task dependency to verified local change.

Each attempt runs on its own Git branch and worktree. SQLite preserves scheduling, policy, approvals, verification, and delivery state.

```text
blocked → planned → implemented → verified → ready to integrate → integrated → landed
```

Every task uses two separate agent processes. A read-only planner produces a repository-specific handoff, then a fresh implementation agent receives the structured task and that plan.

This is AgentQ's workflow, not either provider's built-in plan mode. The planner cannot edit the repository or enqueue child tasks.

> [!IMPORTANT]
> AgentQ integrates and lands local Git branches. It does not push remotes, open pull requests, or merge remote hosting branches.

## Key capabilities

| Capability | What AgentQ provides |
| --- | --- |
| Dependency scheduling | Native blocker graphs, exact result bases, cycle rejection, and shared-lane fan-in |
| Parallel execution | Isolated Git worktrees with conservative file-level concurrency control |
| Structured work | Objectives, invariants, acceptance criteria, handoffs, policies, gates, and approvals |
| Enforced verification | Allowed and denied paths, changed-file limits, commands, and clean-worktree evidence |
| Durable recovery | SQLite state, fenced leases, typed failures, bounded retries, and resumable sessions |
| Local delivery | Immutable result refs, integration trains, conflict reporting, and atomic branch landing |
| Operator experience | Full-screen Ink UI, JSON automation, repository scoping, and normalized live activity |

## Installation

AgentQ requires [Bun](https://bun.sh/) 1.3 or newer. The package includes the official Codex and Claude Code CLI dependencies.

```bash
npm install -g bun
npm install -g agentq
```

Authenticate with one or both providers, then verify the environment:

```bash
agentq provider login codex
agentq provider login claude
agentq doctor
```

Authentication remains in each provider's credential store. AgentQ does not read or persist API keys.

Install from source:

```bash
git clone https://github.com/Kiso-Labs/agentq.git
cd agentq
bun install --frozen-lockfile
bun run check
bun link
```

## Quick start

Create a repository-scoped queue:

```bash
cd ~/src/my-app

agentq queue create app \
  --repo . \
  --base main \
  --provider codex \
  --concurrency 4 \
  --allow-path "src/**" \
  --allow-path "tests/**" \
  --verify "bun test" \
  --verify "bun run typecheck" \
  --land-strategy merge-train \
  --file-concurrency enforced
```

Add a task:

```bash
agentq task add \
  --queue app \
  --title "Restore bounded retries" \
  --objective "Restore bounded retries without changing API behavior" \
  --invariant "Existing response schemas remain unchanged" \
  --expected-path "src/services/**" \
  --deny-path "src/api/**" \
  --verify "bun test tests/services" \
  --accept "The regression test fails before the fix and passes after it"
```

Open the terminal UI and start the foreground supervisor:

```bash
agentq
```

Run headlessly when you do not need the UI:

```bash
agentq run
agentq run app --once
```

Install AgentQ task-creation instructions for both providers:

```bash
agentq integrate all --repo .
```

Use `agentq doctor` to diagnose Git, provider authentication, state, and isolation problems.

## Core concepts

### Repository scope

Inside a Git working tree, AgentQ uses the repository's canonical Git common directory as its scope.

The terminal UI shows and runs only queues for that repository, and linked worktrees share the same scope. Queue names are unique within a repository, so separate repositories can each have a queue named `app`.

Use the explicit cross-repository forms when needed:

```bash
agentq queue list --all
agentq task list --all
agentq run --all
```

In the UI, press `g` to switch between the current repository and all repositories. The supervisor follows that scope immediately.

### Queue configuration

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

The task's selected provider runs both stages. Queue-level fields select stage-specific models when the task uses the queue provider; a blank model uses the provider default.

A task-level provider override uses that provider's defaults instead of model names configured for another provider. Stage instructions remain reusable queue guidance.

Queue and task configuration is copied into an immutable run snapshot when an attempt is claimed. Editing configuration changes future fresh attempts, not an active attempt or a retained session resume.

Delivery requires a local branch target. With `--land-strategy stack` or `merge-train`, AgentQ canonicalizes the queue base to `refs/heads/<branch>`.

Tags, detached commits, and remote-tracking refs are rejected as landing targets. `--auto-land` requires a non-`none` landing strategy.

### Structured task specifications

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

List fields have matching clear options, including `--clear-blockers`, `--clear-invariants`, `--clear-expected-paths`, `--clear-allowed-paths`, and `--clear-denied-paths`.

Limits, gates, and text fields support `--clear-max-changed-files`, `--clear-verify`, `--clear-checkpoints`, `--clear-handoff`, and `--clear-acceptance`.

Only `queued`, `failed`, `interrupted`, or `cancelled` tasks without an active run are editable. Active and succeeded tasks are locked.

Optimistic version checks reject stale saves instead of overwriting newer edits. Every successful edit records a task event.

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

### Native dependency graphs

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

### Parallel execution and file concurrency

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

### Plan → implement

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

An empty planner response or Git-visible planner change fails planning and prevents implementation.

A retained planning session can resume before handing off to a fresh implementation process. A retained implementation session resumes with its stored plan. A normal retry starts a new attempt from planning.

### Machine-enforced scope and verification

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

Queue commands run first, followed by task commands. A task reaches `succeeded` only after its effective policy and every configured command pass.

Deliverable and dependency-producing tasks must also create a canonical commit under:

```text
refs/agentq/results/<task-id>/<run-id>
```

Integration repeats scope evaluation and verification against the replayed candidate before advancing the train.

An agent branch, a verified artifact, and an integrated or landed result are distinct states with separate evidence.

### Base drift and typed retries

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

### Approval checkpoints

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

### Delivery: verified result → local target

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

Landing uses a fenced compare-and-swap operation to update the configured local target branch.

It detects target drift, refuses dirty checked-out targets, records the landed SHA atomically with task state, and remains idempotent across retries or crashes.

The running supervisor automatically integrates ready tasks whose strategy is not `none`. `--auto-land` also lands eligible integrated results after approvals. Manual operations are safe and idempotent:

```bash
agentq task integrate task_456
agentq queue delivery app
agentq queue land app --yes
```

`queue delivery` shows train refs, generation, task state, commit identities, recent operations, conflicts, and errors.

`--json` returns the complete queue, lane, task, artifact, and operation snapshot.

AgentQ's delivery boundary is intentionally local: it updates local Git refs and checked-out local target branches. It does **not** push, create pull requests, or merge a remote hosting branch.

## Terminal UI

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

Task forms expose every structured field. Inputs use large bordered areas with focus-following viewports.

Use `Tab`/`Shift+Tab` between fields, arrows for selectors, `Space` for toggles, `Ctrl+N` for a newline, `Ctrl+U` to clear, `Ctrl+S` to save, and `Esc` to cancel.

Consequential actions use confirmation screens. Active work and retained worktrees block deletion. Provider login temporarily yields the terminal to the real provider CLI, then restores Ink.

## Agent integration

Agents use the same durable intake as humans. During a managed run, AgentQ injects `AGENTQ_QUEUE`, `AGENTQ_TASK_ID`, `AGENTQ_RUN_ID`, and `AGENTQ_STAGE` (`plan` or `implement`).

Only the implementation process receives the private task-intake directory, so the planner cannot enqueue child work. A child task is recorded with parent provenance. Idempotency keys prevent duplicates across retries.

Codex remains sandboxed. Managed `task add` requests cross a per-run intake directory, and the supervisor atomically stages, validates, and inserts them.

The agent never needs database access or another task's worktree. Delegation defaults to 16 children per parent and four ancestry levels.

Lower those bounds with `AGENTQ_MAX_CHILD_TASKS_PER_RUN` and `AGENTQ_MAX_DELEGATION_DEPTH`.

## Safe deletion

Task and queue deletion require explicit confirmation in Ink or `--yes` in the CLI.

Deleting a task removes its attempts, events, logs, approvals, and delivery metadata. Deleting a queue atomically removes the queue and its inactive task history.

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

## Operations

### State and recovery

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

SQLite uses WAL mode, foreign keys, a busy timeout, atomic claims, dependency snapshots, fenced leases, idempotency constraints, and append-only events.

Integration artifacts, lanes, operations, approvals, and verification evidence survive restarts.

Providers start behind a gate. Their random process identity is persisted before the real Codex or Claude command is released.

If a supervisor dies, a live peer fences the stale run, terminates its verified orphan process tree, then makes the task retryable. Reused PIDs are not signalled, and ambiguous exits are not reported as success.

### Security model

- Codex planning runs read-only; implementation runs workspace-write and receives only its run's intake directory as an additional writable root.
- Claude Code planning is restricted to `Read`, `Glob`, and `Grep`; implementation uses its configured coding-tool allow-list. Claude Code does not provide the same filesystem sandbox as Codex.
- Dangerous provider bypass flags are never enabled automatically.
- Child processes receive argument arrays rather than interpolated shell commands.
- Process cleanup targets the complete lifecycle-owned tree: POSIX process groups and Windows Job Objects.
- Provider credentials remain in provider-owned credential stores.
- Verification commands are trusted queue/task configuration and run through the platform shell inside isolated worktrees.
- Delivery targets only canonical local branches and uses immutable refs, temporary worktrees, fenced leases, and compare-and-swap updates.

See [docs/security.md](docs/security.md) for exact trust boundaries.

## Documentation

- [Architecture](docs/architecture.md) explains the durable control plane, scheduler, provider pipeline, and delivery coordinator.
- [Security](docs/security.md) defines trust boundaries, sandbox behavior, verification, approvals, and local landing.
- [Releasing](docs/releasing.md) documents the token-free npm release process for maintainers.

## Development

```bash
bun install
bun run typecheck
bun run lint
bun run test
bun run build
bun run check
```

## License

[MIT](LICENSE)
