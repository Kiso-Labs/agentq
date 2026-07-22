import type { Database, SQLQueryBindings } from "bun:sqlite";

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
