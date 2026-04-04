/**
 * sql.js helper functions
 * Wraps sql.js API to provide a simpler interface similar to better-sqlite3
 */

import type { Database } from 'sql.js';

/** Run a query and return all rows as objects */
export function all(db: Database, sql: string, params: any[] = []): any[] {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);

  const rows: any[] = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

/** Run a query and return the first row as an object, or null */
export function get(db: Database, sql: string, params: any[] = []): any | null {
  const rows = all(db, sql, params);
  return rows.length > 0 ? rows[0] : null;
}

/** Run an INSERT/UPDATE/DELETE statement */
export function run(db: Database, sql: string, params: any[] = []): void {
  db.run(sql, params);
}
