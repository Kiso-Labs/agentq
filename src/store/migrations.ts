import type { Database } from "bun:sqlite";
import { AgentQError } from "../core/errors.ts";
import { isoNow } from "../core/paths.ts";
import { selectOne } from "./sqlite.ts";

interface Migration {
  version: number;
  name: string;
  foreignKeysOff?: boolean;
  up(database: Database): void;
}

interface ForeignKeyViolationRow {
  table: string;
  rowid: number | null;
  parent: string;
  fkid: number;
}

const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    up(database) {
      database.run(`
        CREATE TABLE queues (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL COLLATE NOCASE UNIQUE,
          repo_path TEXT NOT NULL,
          base_ref TEXT NOT NULL,
          default_provider TEXT NOT NULL CHECK (default_provider IN ('codex', 'claude')),
          concurrency INTEGER NOT NULL CHECK (concurrency > 0),
          max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
          verify_commands TEXT NOT NULL,
          auto_commit INTEGER NOT NULL CHECK (auto_commit IN (0, 1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);

      database.run(`
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          queue_id TEXT NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          instructions TEXT NOT NULL,
          acceptance_criteria TEXT NOT NULL,
          provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude')),
          priority INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (
            status IN (
              'queued', 'starting', 'running', 'cancelling',
              'succeeded', 'failed', 'interrupted', 'cancelled'
            )
          ),
          source_kind TEXT NOT NULL CHECK (source_kind IN ('manual', 'agent', 'api')),
          parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
          idempotency_key TEXT,
          attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
          current_run_id TEXT,
          cancel_requested_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT
        )
      `);

      database.run(`
        CREATE UNIQUE INDEX tasks_queue_idempotency
        ON tasks(queue_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL
      `);

      database.run(`
        CREATE INDEX tasks_claim_order
        ON tasks(queue_id, status, priority DESC, created_at, id)
      `);

      database.run(`
        CREATE TABLE runs (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
          provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude')),
          status TEXT NOT NULL CHECK (
            status IN (
              'starting', 'running', 'cancelling',
              'succeeded', 'failed', 'interrupted', 'cancelled'
            )
          ),
          base_sha TEXT,
          branch_name TEXT,
          worktree_path TEXT,
          provider_session_id TEXT,
          pid INTEGER,
          started_at TEXT NOT NULL,
          heartbeat_at TEXT NOT NULL,
          finished_at TEXT,
          exit_code INTEGER,
          summary TEXT,
          error TEXT,
          log_path TEXT,
          UNIQUE(task_id, attempt_no)
        )
      `);

      database.run(`
        CREATE UNIQUE INDEX runs_one_active_per_task
        ON runs(task_id)
        WHERE status IN ('starting', 'running', 'cancelling')
      `);

      database.run(`
        CREATE INDEX runs_active_heartbeat
        ON runs(status, heartbeat_at)
      `);

      database.run(`
        CREATE TABLE task_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
          kind TEXT NOT NULL,
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `);

      database.run(`
        CREATE INDEX task_events_task_sequence
        ON task_events(task_id, id)
      `);

      database.run(`
        CREATE INDEX task_events_run_sequence
        ON task_events(run_id, id)
      `);
    },
  },
  {
    version: 2,
    name: "run_leases_and_resume_intent",
    up(database) {
      database.run(
        "ALTER TABLE tasks ADD COLUMN resume_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL",
      );
      database.run("ALTER TABLE runs ADD COLUMN owner_token TEXT");
      database.run("ALTER TABLE runs ADD COLUMN owner_pid INTEGER");
      database.run("CREATE INDEX runs_owner_lease ON runs(owner_pid, status, heartbeat_at)");
    },
  },
  {
    version: 3,
    name: "provider_process_identity",
    up(database) {
      database.run("ALTER TABLE runs ADD COLUMN process_token TEXT");
      database.run("ALTER TABLE runs ADD COLUMN process_start_marker TEXT");
      database.run("ALTER TABLE runs ADD COLUMN process_identity_path TEXT");
    },
  },
  {
    version: 4,
    name: "repo_scoped_queues_and_task_snapshots",
    // SQLite cannot drop the anonymous UNIQUE constraint from the v1 queues
    // table. Rebuilding the parent table with foreign-key enforcement disabled
    // on this connection preserves child rows while replacing that constraint.
    foreignKeysOff: true,
    up(database) {
      database.run(`
        CREATE TABLE queues_v4 (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL COLLATE NOCASE,
          repo_key TEXT NOT NULL,
          repo_path TEXT NOT NULL,
          base_ref TEXT NOT NULL,
          default_provider TEXT NOT NULL CHECK (default_provider IN ('codex', 'claude')),
          concurrency INTEGER NOT NULL CHECK (concurrency > 0),
          max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
          verify_commands TEXT NOT NULL,
          auto_commit INTEGER NOT NULL CHECK (auto_commit IN (0, 1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(repo_key, name)
        )
      `);
      database.run(`
        INSERT INTO queues_v4(
          id, name, repo_key, repo_path, base_ref, default_provider, concurrency,
          max_attempts, verify_commands, auto_commit, created_at, updated_at
        )
        SELECT
          id, name, repo_path, repo_path, base_ref, default_provider, concurrency,
          max_attempts, verify_commands, auto_commit, created_at, updated_at
        FROM queues
      `);
      database.run("DROP TABLE queues");
      database.run("ALTER TABLE queues_v4 RENAME TO queues");
      database.run("ALTER TABLE runs ADD COLUMN task_snapshot TEXT");

      const violation = selectOne<ForeignKeyViolationRow, []>(
        database,
        "PRAGMA foreign_key_check",
        [],
      );
      if (violation) {
        throw new AgentQError(
          `Database migration would break ${violation.table} foreign key ${violation.fkid}`,
          "MIGRATION_FOREIGN_KEY_VIOLATION",
        );
      }
    },
  },
  {
    version: 5,
    name: "planning_and_implementation_pipeline",
    up(database) {
      database.run("ALTER TABLE queues ADD COLUMN plan_model TEXT NOT NULL DEFAULT ''");
      database.run("ALTER TABLE queues ADD COLUMN plan_instructions TEXT NOT NULL DEFAULT ''");
      database.run("ALTER TABLE queues ADD COLUMN implement_model TEXT NOT NULL DEFAULT ''");
      database.run("ALTER TABLE queues ADD COLUMN implement_instructions TEXT NOT NULL DEFAULT ''");
      // Existing runs predate the pipeline and therefore represent an
      // implementation attempt. New claims explicitly start in `plan`.
      database.run(
        "ALTER TABLE runs ADD COLUMN phase TEXT NOT NULL DEFAULT 'implement' CHECK (phase IN ('plan', 'implement'))",
      );
      database.run("ALTER TABLE runs ADD COLUMN plan_output TEXT");
      database.run("ALTER TABLE runs ADD COLUMN plan_session_id TEXT");
    },
  },
  {
    version: 6,
    name: "discard_unplanned_legacy_resume_intents",
    up(database) {
      // A resume intent created before v5 points at an implementation run
      // that cannot have a trustworthy planner handoff. Leave the task queued,
      // but make its next claim start the mandatory pipeline from planning.
      database.run(`
        UPDATE tasks
        SET resume_run_id = NULL
        WHERE resume_run_id IN (
          SELECT id
          FROM runs
          WHERE phase = 'implement'
            AND (plan_output IS NULL OR trim(plan_output) = '')
        )
      `);
    },
  },
  {
    version: 7,
    name: "structured_delivery_pipeline",
    up(database) {
      // Queue-level policy is inherited by tasks. Compatibility defaults leave
      // existing queues' scheduling and landing behavior unchanged.
      database.run(
        "ALTER TABLE queues ADD COLUMN allowed_paths TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(allowed_paths))",
      );
      database.run(
        "ALTER TABLE queues ADD COLUMN denied_paths TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(denied_paths))",
      );
      database.run(
        "ALTER TABLE queues ADD COLUMN max_changed_files INTEGER CHECK (max_changed_files IS NULL OR max_changed_files > 0)",
      );
      database.run(
        "ALTER TABLE queues ADD COLUMN approval_checkpoints TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(approval_checkpoints))",
      );
      database.run(
        "ALTER TABLE queues ADD COLUMN base_drift_policy TEXT NOT NULL DEFAULT 'replan' CHECK (base_drift_policy IN ('rebase', 'replan', 'fail'))",
      );
      database.run(
        "ALTER TABLE queues ADD COLUMN land_strategy TEXT NOT NULL DEFAULT 'none' CHECK (land_strategy IN ('none', 'stack', 'merge-train'))",
      );
      database.run(
        "ALTER TABLE queues ADD COLUMN auto_land INTEGER NOT NULL DEFAULT 0 CHECK (auto_land IN (0, 1))",
      );
      database.run(
        "ALTER TABLE queues ADD COLUMN file_concurrency TEXT NOT NULL DEFAULT 'off' CHECK (file_concurrency IN ('off', 'advisory', 'enforced'))",
      );

      // Structured task specifications remain additive to the original human
      // title/instructions fields, allowing older clients to keep working.
      database.run("ALTER TABLE tasks ADD COLUMN objective TEXT NOT NULL DEFAULT ''");
      database.run(
        "ALTER TABLE tasks ADD COLUMN invariants TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(invariants))",
      );
      database.run(
        "ALTER TABLE tasks ADD COLUMN handoff_requirements TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(handoff_requirements))",
      );
      database.run(
        "ALTER TABLE tasks ADD COLUMN expected_paths TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(expected_paths))",
      );
      database.run(
        "ALTER TABLE tasks ADD COLUMN allowed_paths TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(allowed_paths))",
      );
      database.run(
        "ALTER TABLE tasks ADD COLUMN denied_paths TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(denied_paths))",
      );
      database.run(
        "ALTER TABLE tasks ADD COLUMN max_changed_files INTEGER CHECK (max_changed_files IS NULL OR max_changed_files > 0)",
      );
      database.run(
        "ALTER TABLE tasks ADD COLUMN verify_commands TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(verify_commands))",
      );
      database.run(
        "ALTER TABLE tasks ADD COLUMN approval_checkpoints TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(approval_checkpoints))",
      );
      database.run(
        "ALTER TABLE tasks ADD COLUMN base_drift_policy TEXT NOT NULL DEFAULT 'replan' CHECK (base_drift_policy IN ('rebase', 'replan', 'fail'))",
      );
      database.run(
        "ALTER TABLE tasks ADD COLUMN land_strategy TEXT NOT NULL DEFAULT 'none' CHECK (land_strategy IN ('none', 'stack', 'merge-train'))",
      );
      database.run("ALTER TABLE tasks ADD COLUMN created_base_sha TEXT");
      database.run(
        "ALTER TABLE tasks ADD COLUMN current_phase TEXT NOT NULL DEFAULT 'queued' CHECK (current_phase IN ('queued', 'blocked', 'plan', 'red_test', 'approval', 'implement', 'verify', 'integrate', 'land', 'complete'))",
      );
      database.run(
        "ALTER TABLE tasks ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'not_started' CHECK (delivery_status IN ('not_started', 'implemented', 'verified', 'ready_to_integrate', 'integrated', 'landed'))",
      );
      database.run("ALTER TABLE tasks ADD COLUMN blocked_reason TEXT");
      database.run(
        "ALTER TABLE tasks ADD COLUMN failure_class TEXT CHECK (failure_class IS NULL OR failure_class IN ('transient_infrastructure', 'stale_base', 'test_regression', 'blocked_dependency', 'file_conflict', 'policy_violation', 'integration_conflict', 'integration_contention', 'agent_failure', 'cancelled', 'unknown'))",
      );
      database.run("ALTER TABLE tasks ADD COLUMN failure_reason TEXT");
      database.run(
        "ALTER TABLE tasks ADD COLUMN retry_disposition TEXT CHECK (retry_disposition IS NULL OR retry_disposition IN ('retry', 'rebase_and_retry', 'return_to_implementation', 'wait', 'stop', 'manual_resolution'))",
      );
      database.run(
        "ALTER TABLE tasks ADD COLUMN result_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL",
      );
      database.run("ALTER TABLE tasks ADD COLUMN result_commit_sha TEXT");
      database.run(
        "ALTER TABLE tasks ADD COLUMN changed_files TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(changed_files))",
      );
      database.run(
        "ALTER TABLE tasks ADD COLUMN verification_results TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(verification_results))",
      );
      database.run("ALTER TABLE tasks ADD COLUMN integration_branch TEXT");
      database.run("ALTER TABLE tasks ADD COLUMN integrated_sha TEXT");
      database.run("ALTER TABLE tasks ADD COLUMN landed_sha TEXT");
      database.run("ALTER TABLE tasks ADD COLUMN integrated_at TEXT");
      database.run("ALTER TABLE tasks ADD COLUMN landed_at TEXT");
      database.run(
        "ALTER TABLE tasks ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0)",
      );
      database.run(
        "ALTER TABLE tasks ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0)",
      );
      database.run(
        "ALTER TABLE tasks ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0 CHECK (cost_usd >= 0)",
      );

      // Every attempt captures exactly which blocker artifacts it was based on
      // and owns its own verification/result evidence.
      database.run(
        "ALTER TABLE runs ADD COLUMN dependency_snapshot TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(dependency_snapshot))",
      );
      database.run("ALTER TABLE runs ADD COLUMN result_commit_sha TEXT");
      database.run(
        "ALTER TABLE runs ADD COLUMN changed_files TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(changed_files))",
      );
      database.run(
        "ALTER TABLE runs ADD COLUMN verification_results TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(verification_results))",
      );
      database.run(
        "ALTER TABLE runs ADD COLUMN failure_class TEXT CHECK (failure_class IS NULL OR failure_class IN ('transient_infrastructure', 'stale_base', 'test_regression', 'blocked_dependency', 'file_conflict', 'policy_violation', 'integration_conflict', 'integration_contention', 'agent_failure', 'cancelled', 'unknown'))",
      );
      database.run(
        "ALTER TABLE runs ADD COLUMN retry_disposition TEXT CHECK (retry_disposition IS NULL OR retry_disposition IN ('retry', 'rebase_and_retry', 'return_to_implementation', 'wait', 'stop', 'manual_resolution'))",
      );
      database.run(
        "ALTER TABLE runs ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0)",
      );
      database.run(
        "ALTER TABLE runs ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0)",
      );
      database.run(
        "ALTER TABLE runs ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0 CHECK (cost_usd >= 0)",
      );

      database.run(`
        CREATE TABLE task_dependencies (
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          blocker_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (task_id, blocker_task_id),
          CHECK (task_id <> blocker_task_id)
        )
      `);
      database.run(`
        CREATE INDEX task_dependencies_by_blocker
        ON task_dependencies(blocker_task_id, task_id)
      `);
      database.run(`
        CREATE INDEX tasks_delivery_progress
        ON tasks(queue_id, delivery_status, current_phase, created_at, id)
      `);
      database.run(`
        CREATE INDEX tasks_result_commit
        ON tasks(result_commit_sha)
        WHERE result_commit_sha IS NOT NULL
      `);

      database.run("UPDATE tasks SET objective = title WHERE trim(objective) = ''");
      database.run(`
        UPDATE tasks
        SET delivery_status = 'verified',
            current_phase = 'complete'
        WHERE status = 'succeeded'
      `);
    },
  },
  {
    version: 8,
    name: "durable_delivery_and_approvals",
    up(database) {
      database.run(
        "ALTER TABLE tasks ADD COLUMN integration_conflict_files TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(integration_conflict_files))",
      );
      // Older v7 databases cannot widen the anonymous failure_class CHECK.
      // Delivery failures therefore use an additive projection column while
      // task mapping exposes one unified typed failure class.
      database.run(
        "ALTER TABLE tasks ADD COLUMN delivery_failure_class TEXT CHECK (delivery_failure_class IS NULL OR delivery_failure_class IN ('integration_conflict', 'integration_contention', 'policy_violation', 'test_regression'))",
      );
      database.run(
        "ALTER TABLE runs ADD COLUMN delivery_failure_class TEXT CHECK (delivery_failure_class IS NULL OR delivery_failure_class IN ('integration_conflict', 'integration_contention', 'policy_violation', 'test_regression'))",
      );

      database.run(`
        CREATE TABLE task_artifacts (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          repo_key TEXT NOT NULL,
          target_ref TEXT NOT NULL,
          base_sha TEXT NOT NULL,
          result_sha TEXT NOT NULL,
          result_ref TEXT NOT NULL,
          changed_files TEXT NOT NULL CHECK (json_valid(changed_files)),
          verification_results TEXT NOT NULL CHECK (json_valid(verification_results)),
          created_at TEXT NOT NULL,
          UNIQUE(run_id),
          UNIQUE(result_ref)
        )
      `);
      database.run(`
        CREATE INDEX task_artifacts_by_task
        ON task_artifacts(task_id, created_at, id)
      `);
      // Result evidence may only be replaced by deleting its owning task/run.
      // This prevents a mutable row from silently changing what was verified.
      database.run(`
        CREATE TRIGGER task_artifacts_are_immutable
        BEFORE UPDATE ON task_artifacts
        BEGIN
          SELECT RAISE(ABORT, 'task artifacts are immutable');
        END
      `);

      database.run(`
        CREATE TABLE integration_lanes (
          id TEXT PRIMARY KEY,
          repo_key TEXT NOT NULL,
          repo_path TEXT NOT NULL,
          target_ref TEXT NOT NULL,
          train_ref TEXT NOT NULL,
          target_base_sha TEXT NOT NULL,
          head_sha TEXT NOT NULL,
          generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(repo_key, target_ref),
          UNIQUE(repo_key, train_ref)
        )
      `);

      database.run(`
        CREATE TABLE delivery_operations (
          id TEXT PRIMARY KEY,
          lane_id TEXT NOT NULL REFERENCES integration_lanes(id) ON DELETE RESTRICT,
          task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
          artifact_id TEXT REFERENCES task_artifacts(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('integrate', 'land')),
          status TEXT NOT NULL CHECK (
            status IN ('queued', 'running', 'succeeded', 'failed', 'conflicted', 'cancelled')
          ),
          owner_token TEXT,
          fence_token INTEGER NOT NULL DEFAULT 0 CHECK (fence_token >= 0),
          expected_head_sha TEXT,
          candidate_sha TEXT,
          conflict_files TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(conflict_files)),
          error TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          heartbeat_at TEXT,
          lease_expires_at TEXT,
          finished_at TEXT,
          CHECK (
            kind = 'land'
            OR (task_id IS NOT NULL AND artifact_id IS NOT NULL)
          )
        )
      `);
      database.run(`
        CREATE INDEX delivery_operations_claim_order
        ON delivery_operations(status, lease_expires_at, created_at, id)
      `);
      database.run(`
        CREATE INDEX delivery_operations_lane_history
        ON delivery_operations(lane_id, created_at, id)
      `);
      database.run(`
        CREATE UNIQUE INDEX delivery_operations_one_running_per_lane
        ON delivery_operations(lane_id)
        WHERE status = 'running'
      `);
      database.run(`
        CREATE UNIQUE INDEX delivery_operations_one_open_artifact
        ON delivery_operations(artifact_id)
        WHERE kind = 'integrate' AND status IN ('queued', 'running')
      `);
      database.run(`
        CREATE UNIQUE INDEX delivery_operations_one_open_land
        ON delivery_operations(lane_id)
        WHERE kind = 'land' AND status IN ('queued', 'running')
      `);

      database.run(`
        CREATE TABLE task_approvals (
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          checkpoint TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
          run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
          requested_at TEXT NOT NULL,
          decided_at TEXT,
          actor TEXT,
          note TEXT,
          PRIMARY KEY (task_id, checkpoint)
        )
      `);
      database.run(`
        CREATE INDEX task_approvals_pending
        ON task_approvals(task_id, status, requested_at)
      `);
    },
  },
];

interface VersionRow {
  version: number;
}

export function migrate(database: Database): void {
  database.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const latestSupported = migrations.at(-1)?.version ?? 0;
  const latestApplied =
    selectOne<VersionRow, []>(
      database,
      "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
      [],
    )?.version ?? 0;

  if (latestApplied > latestSupported) {
    throw new AgentQError(
      `Database schema version ${latestApplied} is newer than this agentq build supports (${latestSupported})`,
      "DATABASE_TOO_NEW",
    );
  }

  for (const migration of migrations) {
    const apply = database.transaction(() => {
      const alreadyApplied = selectOne<VersionRow, [number]>(
        database,
        "SELECT version FROM schema_migrations WHERE version = ?",
        [migration.version],
      );

      if (alreadyApplied) return;

      migration.up(database);
      database.run("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)", [
        migration.version,
        migration.name,
        isoNow(),
      ]);
    });

    if (migration.foreignKeysOff) database.run("PRAGMA foreign_keys = OFF");
    try {
      apply.immediate();
    } finally {
      if (migration.foreignKeysOff) database.run("PRAGMA foreign_keys = ON");
    }
  }
}
