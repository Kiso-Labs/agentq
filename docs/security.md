# Security and trust boundaries

agentq orchestrates coding agents that can execute commands. A worktree prevents two agents from overwriting each other's checkout, but it is not a security sandbox.

## Trusted inputs

Queue owners are trusted to choose repositories, providers, per-stage models and instructions, concurrency, verification commands, and tasks. The same task provider runs both planning and implementation. Queue model names must be valid for the queue's default provider; a task-level provider override uses the override provider's defaults instead of carrying those names across providers. Verification commands execute through the platform shell in the task worktree. Do not import queue state from an untrusted source.

Repository instructions (`AGENTS.md`, `CLAUDE.md`, hooks, skills, and provider configuration) are inputs to the coding provider. Review repositories before granting an agent write/tool access.

## Provider isolation

Planning and implementation are separate provider processes. This mandatory custom planner is agentq's own workflow, not Codex or Claude Code's built-in plan mode, and no queue or task setting bypasses it for a fresh attempt. The planner receives read-only repository access and no task intake. Its output must be non-empty, and agentq checks that `HEAD` is unchanged and Git reports no tracked or untracked worktree changes before starting implementation.

Codex planning uses the `read-only` sandbox. Codex implementation uses `workspace-write`; its only additional writable path is the current run's narrow task-intake directory, and the SQLite database and sibling worktrees are not added to the sandbox. Claude Code planning is constrained with `--tools Read,Glob,Grep` as well as the matching `--allowedTools`. Claude Code implementation uses `acceptEdits` and passes its explicit coding-tool set to both `--tools` and `--allowedTools`; `--tools` restricts capabilities, while `--allowedTools` controls approval prompts. agentq does not pass either provider's dangerous permission-bypass flag.

Neither setting is a container or virtual machine. Commands may be able to access credentials and files available to the current operating-system user. Use a container or dedicated user account when processing untrusted repositories.

## Secrets

agentq does not collect provider tokens. Official Codex and Claude Code authentication flows and credential stores are used directly. Environment variables are inherited because real repository builds commonly need toolchain configuration; child-specific agentq metadata contains no secrets.

Task prompts, normalized events, provider summaries, command output, branch names, and worktree paths are stored locally under the state directory. agentq creates state directories with owner-only permissions and the database/log/intake files with owner-only modes on POSIX. Protect that directory as you would protect source code and build logs, especially on platforms whose ACL model does not honor POSIX modes.

Provider summaries, the durable planner handoff, individual persisted events, aggregate event counts/bytes, command capture, and log lines are bounded. Once a run reaches its persistence ceiling, agentq records one truncation diagnostic rather than allowing provider output to grow memory and state without limit. Human CLI and TUI views strip ANSI, OSC, DCS, and C0/C1 controls; JSON output preserves the underlying data for automation.

## Process lifecycle and cancellation

The real provider starts behind a small launcher gate. The launcher exits without running the provider if its parent dies before the run PID, random token, creation marker, and live identity lease are durable. This closes the spawn-before-persistence orphan window. Recovery requires the identity lease to advance before signalling a numeric PID, so PID reuse cannot target an unrelated process.

On cancellation, agentq terminates the provider or verification process tree, waits for a grace period on POSIX, and escalates to a forced kill. Windows providers run in kill-on-close Job Objects, with `taskkill /T /F` as the explicit cancellation path, so descendants are also terminated after normal completion or supervisor death. Stale recovery fences the database lease and keeps the task unclaimable until orphan cleanup is complete. A persistence failure in the provider event stream or identity heartbeat also terminates the provider immediately.

Both provider processes receive `AGENTQ_STAGE` so managed code can distinguish `plan` from `implement`. Only implementation receives `AGENTQ_INTAKE_DIR` and a registered intake inbox. Managed task-intake files are atomically moved out of that agent-writable inbox, opened without following symlinks where the platform supports it, checked through the same descriptor, and read with a hard byte bound. Request-derived idempotency prevents duplicate inserts if delivery is retried, while child-count and ancestry limits bound accidental recursive spend.

Run phase, planner output, separate provider session IDs, and the four queue workflow settings captured at claim are persisted. Resuming continues only the retained phase and immutable workflow snapshot in its worktree; a resumed planner must still pass cleanliness checks before a fresh implementation process starts. Queue edits affect future fresh attempts only. Pre-v5 sessions lack a trusted planner handoff and are rejected for resume; a fresh retry, including the replacement for a legacy run, begins with planning again.

## Git behavior

Successful task changes may be committed on a dedicated local branch. Existing or resumed worktrees are identity-checked before use, and cleanup refuses paths outside agentq's managed worktree root. Task and queue deletion is transactionally rejected while any affected task is active or retains a worktree; operators must use the explicit cleanup flow before deleting durable history. agentq never pushes, merges, deletes the source branch, or opens a pull request automatically. `task clean --force --yes` is the explicit destructive worktree cleanup operation.
