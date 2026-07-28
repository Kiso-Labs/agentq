import { DatabaseSync, type StatementSync } from "node:sqlite";

export type SQLQueryBindings = string | number | bigint | Uint8Array | null;

interface DatabaseOptions {
  create?: boolean;
  readwrite?: boolean;
  readonly?: boolean;
  safeIntegers?: boolean;
  strict?: boolean;
  timeout?: number;
}

interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

class Statement<Row = unknown> {
  readonly #statement: StatementSync;

  constructor(statement: StatementSync) {
    this.#statement = statement;
  }

  get(...params: SQLQueryBindings[]): Row | null {
    return (this.#statement.get(...params) as Row | undefined) ?? null;
  }

  all(...params: SQLQueryBindings[]): Row[] {
    return this.#statement.all(...params) as Row[];
  }

  run(...params: SQLQueryBindings[]): RunResult {
    const result = this.#statement.run(...params);
    return {
      changes: Number(result.changes),
      lastInsertRowid: Number(result.lastInsertRowid),
    };
  }

  values(...params: SQLQueryBindings[]): unknown[][] {
    return this.#statement.all(...params).map((row) => Object.values(row));
  }

  finalize(): void {
    // StatementSync objects are finalized when they become unreachable.
  }
}

interface Transaction<T> {
  immediate(): T;
  deferred(): T;
  exclusive(): T;
}

export class Database {
  readonly #database: DatabaseSync;

  constructor(path: string, options: DatabaseOptions = {}) {
    const timeout = options.timeout ?? 0;
    if (!Number.isSafeInteger(timeout) || timeout < 0) {
      throw new RangeError("SQLite timeout must be a non-negative safe integer");
    }
    this.#database = new DatabaseSync(path, {
      readOnly: options.readonly ?? options.readwrite === false,
    });
    // PRAGMA keeps timeout behavior explicit and consistent across supported Node releases.
    this.#database.exec(`PRAGMA busy_timeout = ${timeout}`);
  }

  run(sql: string, bindings: SQLQueryBindings[] = []): RunResult {
    return this.prepare(sql).run(...bindings);
  }

  prepare<Row = unknown, _Params extends SQLQueryBindings[] = SQLQueryBindings[]>(
    sql: string,
  ): Statement<Row> {
    return new Statement<Row>(this.#database.prepare(sql));
  }

  query<Row = unknown, Params extends SQLQueryBindings[] = SQLQueryBindings[]>(
    sql: string,
  ): Statement<Row> {
    return this.prepare<Row, Params>(sql);
  }

  transaction<T>(operation: () => T): Transaction<T> {
    const execute = (mode: "DEFERRED" | "IMMEDIATE" | "EXCLUSIVE"): T => {
      this.#database.exec(`BEGIN ${mode}`);
      try {
        const result = operation();
        this.#database.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          this.#database.exec("ROLLBACK");
        } catch {
          // Preserve the operation failure.
        }
        throw error;
      }
    };
    return {
      immediate: () => execute("IMMEDIATE"),
      deferred: () => execute("DEFERRED"),
      exclusive: () => execute("EXCLUSIVE"),
    };
  }

  close(_throwOnError?: boolean): void {
    this.#database.close();
  }
}

export function sqliteBusy(error: unknown): boolean {
  const value = error as { code?: unknown; errcode?: unknown; message?: unknown };
  return (
    value.errcode === 5 ||
    (typeof value.code === "string" && value.code.startsWith("SQLITE_BUSY")) ||
    (typeof value.message === "string" && /database (?:is )?(?:locked|busy)/i.test(value.message))
  );
}

export function selectOne<Row, Params extends SQLQueryBindings[]>(
  database: Database,
  sql: string,
  params: Params,
): Row | null {
  const statement = database.prepare<Row, SQLQueryBindings[]>(sql);
  try {
    return statement.get(...params);
  } finally {
    statement.finalize();
  }
}

export function selectAll<Row, Params extends SQLQueryBindings[]>(
  database: Database,
  sql: string,
  params: Params,
): Row[] {
  const statement = database.prepare<Row, SQLQueryBindings[]>(sql);
  try {
    return statement.all(...params);
  } finally {
    statement.finalize();
  }
}
