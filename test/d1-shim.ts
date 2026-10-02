/**
 * Stand-ins for Cloudflare D1 (with the migrations applied) and for Durable
 * Object storage, on node:sqlite, so server code can be tested under
 * node:test.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {DatabaseSync, type SQLInputValue} from 'node:sqlite';
import type {
  D1Database,
  D1PreparedStatement,
  DurableObjectNamespace,
} from '../src/server/env.ts';
import type {Storage} from '../src/server/user-data.ts';
import {UserStore} from '../src/server/user-store.ts';

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

/** Durable Object SQLite storage: sql.exec, transactionSync, deleteAll. */
export function testStorage(): Storage & {deleteAll(): Promise<void>} {
  let db = new DatabaseSync(':memory:');
  return {
    sql: {
      exec: (query, ...bindings) => {
        const rows = db.prepare(query).all(...(bindings as SQLInputValue[]));
        return {toArray: () => rows as Record<string, unknown>[]};
      },
    },
    transactionSync(fn) {
      db.exec('BEGIN');
      try {
        const out = fn();
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    async deleteAll() {
      db = new DatabaseSync(':memory:');
    },
  };
}

/** A UserStore namespace: one object per name, kept in memory. */
export function testUserStores(): DurableObjectNamespace {
  const objects = new Map<string, UserStore>();
  return {
    idFromName: name => name,
    get(id) {
      const name = String(id);
      let o = objects.get(name);
      if (!o) objects.set(name, (o = new UserStore({storage: testStorage()})));
      const store = o;
      return {
        // Like Cloudflare's, responses come back with read-only headers.
        async fetch(request: Request) {
          const res = await store.fetch(request);
          const body = await res.arrayBuffer();
          const frozen = new Response(body, {status: res.status});
          frozen.headers.set('content-type', 'application/json');
          const set = () => {
            throw new TypeError("Can't modify immutable headers.");
          };
          for (const m of ['set', 'append', 'delete'] as const) {
            Object.defineProperty(frozen.headers, m, {value: set});
          }
          return frozen;
        },
      };
    },
  };
}
