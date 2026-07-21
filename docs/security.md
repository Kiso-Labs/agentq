# Security and trust boundaries

agentq orchestrates coding agents that can execute commands. A worktree prevents two agents from overwriting each other's checkout, but it is not a security sandbox.

## Trusted inputs

Queue owners are trusted to choose repositories, provider permissions, concurrency, verification commands, and tasks. Verification commands execute through the platform shell in the task worktree. Do not import queue state from an untrusted source.

Repository instructions (`AGENTS.md`, `CLAUDE.md`, hooks, skills, and provider configuration) are inputs to the coding provider. Review repositories before granting an agent write/tool access.

## Provider isolation

Codex is started with its `workspace-write` sandbox. Its only additional writable path is the current run's narrow task-intake directory; the SQLite database and sibling worktrees are not added to the sandbox. Claude Code is started with `acceptEdits` and an explicit tool allowlist because its permission system is different. agentq does not pass either provider's dangerous permission-bypass flag.

Neither setting is a container or virtual machine. Commands may be able to access credentials and files available to the current operating-system user. Use a container or dedicated user account when processing untrusted repositories.

## Secrets

agentq does not collect provider tokens. Official Codex and Claude Code authentication flows and credential stores are used directly. Environment variables are inherited because real repository builds commonly need toolchain configuration; child-specific agentq metadata contains no secrets.

Task prompts, normalized events, provider summaries, command output, branch names, and worktree paths are stored locally under the state directory. agentq creates state directories with owner-only permissions and the database/log/intake files with owner-only modes on POSIX. Protect that directory as you would protect source code and build logs, especially on platforms whose ACL model does not honor POSIX modes.

Provider summaries, individual persisted events, aggregate event counts/bytes, command capture, and log lines are bounded. Once a run reaches its persistence ceiling, agentq records one truncation diagnostic rather than allowing provider output to grow memory and state without limit. Human CLI and TUI views strip ANSI, OSC, DCS, and C0/C1 controls; JSON output preserves the underlying data for automation.

## Process lifecycle and cancellation

The real provider starts behind a small launcher gate. The launcher exits without running the provider if its parent dies before the run PID, random token, creation marker, and live identity lease are durable. This closes the spawn-before-persistence orphan window. Recovery requires the identity lease to advance before signalling a numeric PID, so PID reuse cannot target an unrelated process.

On cancellation, agentq terminates the provider or verification process tree, waits for a grace period on POSIX, and escalates to a forced kill. Windows uses `taskkill /T /F` and treats a surviving tree as an error. Stale recovery fences the database lease and keeps the task unclaimable until orphan cleanup is complete. A persistence failure in the provider event stream also cancels the provider immediately.

Managed task-intake files are atomically moved out of the agent-writable inbox, opened without following symlinks where the platform supports it, checked through the same descriptor, and read with a hard byte bound. Request-derived idempotency prevents duplicate inserts if delivery is retried, while child-count and ancestry limits bound accidental recursive spend.

## Git behavior

Successful task changes may be committed on a dedicated local branch. Existing or resumed worktrees are identity-checked before use, and cleanup refuses paths outside agentq's managed worktree root. agentq never pushes, merges, deletes the source branch, or opens a pull request automatically. `task clean --force --yes` is the explicit destructive worktree cleanup operation.
