import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The database.
 *
 * One SQLite file on disk, opened by both the dashboard and the worker. WAL
 * mode lets the dashboard read while the worker writes, which is the only
 * concurrency this tool has.
 */

export type Db = Database.Database;

const HERE = dirname(fileURLToPath(import.meta.url));

/** Default location. Override with OUTREACH_DB, which the tests use. */
export function databasePath(): string {
  return process.env.OUTREACH_DB ?? resolve(process.cwd(), "outreach.db");
}

let instance: Db | null = null;

export function getDb(): Db {
  if (instance) return instance;
  instance = openDb(databasePath());
  return instance;
}

/** Open a database at an explicit path and apply the schema. */
export function openDb(path: string): Db {
  const db = new Database(path);

  // Wait rather than fail when the worker holds a write lock.
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");

  migrate(db);
  return db;
}

/**
 * Columns added to a table that already exists.
 *
 * `create table if not exists` does nothing to a database created before the
 * column was written, so anything added after the first real send needs an
 * entry here as well as in schema.sql. Each definition must carry a constant
 * default if it is NOT NULL, which is all SQLite's ALTER TABLE accepts.
 */
const ADDED_COLUMNS: { table: string; column: string; definition: string }[] = [
  { table: "mailboxes", column: "warmup_started_on", definition: "text" },
  {
    table: "mailboxes",
    column: "warmup_start_cap",
    definition: "integer not null default 5",
  },
  {
    table: "mailboxes",
    column: "warmup_daily_increment",
    definition: "integer not null default 2",
  },
  { table: "inbound_messages", column: "notified_at", definition: "text" },
  { table: "mailboxes", column: "pause_notified_at", definition: "text" },
];

function addMissingColumns(db: Db): void {
  for (const { table, column, definition } of ADDED_COLUMNS) {
    const present = db
      .prepare("select 1 from pragma_table_info(?) where name = ?")
      .get(table, column);

    if (present) continue;
    db.exec(`alter table ${table} add column ${column} ${definition}`);
  }
}

/**
 * The schema is written to be idempotent, so applying it on every open is most
 * of the migration story. A personal tool with one user does not need version
 * tracking, and `create table if not exists` cannot lose data. The one thing
 * it cannot do is widen a table that already exists, which is what
 * `addMissingColumns` is for.
 */
export function migrate(db: Db): void {
  const schema = readFileSync(join(HERE, "schema.sql"), "utf8");
  db.exec(schema);
  addMissingColumns(db);
}

export function closeDb(): void {
  instance?.close();
  instance = null;
}

// ---------------------------------------------------------------- helpers

/** ISO-8601 UTC with milliseconds, the format every timestamp column uses. */
export function nowIso(): string {
  return new Date().toISOString();
}

export function toIso(date: Date): string {
  return date.toISOString();
}

export function fromIso(value: string | null | undefined): Date | null {
  return value ? new Date(value) : null;
}

/** SQLite has no boolean type; these columns are 0 or 1 with a CHECK. */
export function toSqliteBool(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

export function fromSqliteBool(value: number): boolean {
  return value === 1;
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
