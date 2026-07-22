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
