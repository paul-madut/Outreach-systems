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
 * The schema is written to be idempotent, so applying it on every open is the
 * whole migration story. A personal tool with one user does not need version
 * tracking, and `create table if not exists` cannot lose data.
 */
export function migrate(db: Db): void {
  const schema = readFileSync(join(HERE, "schema.sql"), "utf8");
  db.exec(schema);
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
