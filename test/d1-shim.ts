/**
 * A stand-in for Cloudflare D1 on node:sqlite, with the migrations applied,
 * so server code can be tested under node:test.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {DatabaseSync, type SQLInputValue} from 'node:sqlite';
import type {D1Database, D1PreparedStatement} from '../src/server/env.ts';

const MIGRATIONS = path.resolve(import.meta.dirname, '../migrations');

class Statement implements D1PreparedStatement {
  private readonly db: DatabaseSync;
  private readonly sql: string;
  private readonly values: SQLInputValue[];
  constructor(db: DatabaseSync, sql: string, values: SQLInputValue[] = []) {
    this.db = db;
    this.sql = sql;
    this.values = values;
  }
  bind(...values: unknown[]) {
    return new Statement(this.db, this.sql, values as SQLInputValue[]);
  }
  async first<T>() {
    return (this.db.prepare(this.sql).get(...this.values) as T) ?? null;
  }
  async all<T>() {
    return {results: this.db.prepare(this.sql).all(...this.values) as T[]};
  }
  async run() {
    return this.db.prepare(this.sql).run(...this.values);
  }
  runSync() {
    return this.db.prepare(this.sql).run(...this.values);
  }
}

export function createTestDb(): D1Database & {raw: DatabaseSync} {
  const db = new DatabaseSync(':memory:');
  // D1 enforces foreign keys.
  db.exec('PRAGMA foreign_keys = ON');
  for (const file of fs.readdirSync(MIGRATIONS).sort()) {
    db.exec(fs.readFileSync(path.join(MIGRATIONS, file), 'utf8'));
  }
  return {
    raw: db,
    prepare: sql => new Statement(db, sql),
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const out = statements.map(s => (s as Statement).runSync());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
}
