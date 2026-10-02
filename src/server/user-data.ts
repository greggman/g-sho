/**
 * One user's synced data, in the SQLite storage of their Durable Object
 * (UserStore). See DESIGN-SERVER.md, "Sync protocol".
 *
 * Rows from every client table are kept in one SQL table, keyed by
 * (table, id), with the row's fields as JSON. Each stored change gets the
 * next sequence number; a client pulls everything after the last number it
 * saw. A pushed row replaces the stored one only if it's a later change.
 *
 * The code is synchronous, so a request is applied atomically, and a
 * Durable Object runs one request at a time, so sequence numbers can't race.
 */
import {validateRow, LIMITS, SyncError, type SyncRow} from './schema.ts';

/** The parts of a Durable Object's `ctx.storage` that we use. */
export interface SqlStorage {
  exec(
    query: string,
    ...bindings: unknown[]
  ): {toArray(): Record<string, unknown>[]};
}

export interface Storage {
  sql: SqlStorage;
  /** Runs fn in a transaction, rolled back if it throws. */
  transactionSync<T>(fn: () => T): T;
}

/** How many rows a pull returns at most. */
export const PAGE_SIZE = 2000;
/** How far in the future a change time may be (clock skew). */
const MAX_FUTURE_MS = 60_000;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS rows (
     tbl TEXT NOT NULL,
     id TEXT NOT NULL,
     mtime INTEGER NOT NULL,
     deleted INTEGER NOT NULL DEFAULT 0,
     seq INTEGER NOT NULL,
     data TEXT,
     PRIMARY KEY (tbl, id)
   )`,
  'CREATE INDEX IF NOT EXISTS rows_seq ON rows(seq)',
  'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)',
];

export interface SyncRequest {
  since: number;
  push?: Record<string, SyncRow[]>;
}

export interface SyncResponse {
  rows: Record<string, SyncRow[]>;
  /** pass as `since` next time */
  cursor: number;
  /** more rows are waiting: call again */
  more: boolean;
  /** pushed rows that weren't valid, and weren't stored */
  rejected?: {table: string; id: unknown; error: string}[];
}

export class UserData {
  private readonly storage: Storage;
  private readonly sql: SqlStorage;

  constructor(storage: Storage) {
    this.storage = storage;
    this.sql = storage.sql;
    for (const s of SCHEMA) this.sql.exec(s);
  }

  private get seq(): number {
    const [row] = this.sql
      .exec("SELECT value FROM meta WHERE key = 'seq'")
      .toArray();
    return Number(row?.value ?? 0);
  }

  private set seq(value: number) {
    this.sql.exec(
      "INSERT OR REPLACE INTO meta (key, value) VALUES ('seq', ?)",
      value,
    );
  }

  private count(table: string): number {
    const [row] = this.sql
      .exec(
        'SELECT COUNT(*) AS n FROM rows WHERE tbl = ? AND deleted = 0',
        table,
      )
      .toArray();
    return Number(row.n);
  }

  sync(request: SyncRequest, now = Date.now()): SyncResponse {
    const since = Number(request.since);
    if (!Number.isInteger(since) || since < 0) {
      throw new SyncError('bad cursor');
    }
    const push: Record<string, SyncRow[]> = {};
    const rejected: NonNullable<SyncResponse['rejected']> = [];
    let total = 0;
    for (const [table, rows] of Object.entries(request.push ?? {})) {
      if (!(table in LIMITS)) throw new SyncError(`unknown table ${table}`);
      if (!Array.isArray(rows)) throw new SyncError(`${table}: not a list`);
      total += rows.length;
      // An invalid row is skipped and reported, so one bad row doesn't stop
      // everything else from syncing.
      push[table] = rows.filter(row => {
        try {
          validateRow(table, row);
          return true;
        } catch (e) {
          if (!(e instanceof SyncError)) throw e;
          rejected.push({table, id: (row as SyncRow)?.id, error: e.message});
          return false;
        }
      });
    }
    if (total > PAGE_SIZE) throw new SyncError('too many rows in one request');

    // Sequence numbers of the rows this request stored: the client has
    // them already, so they're not sent back.
    const written = new Set<number>();
    this.storage.transactionSync(() => {
      let seq = this.seq;
      for (const [table, rows] of Object.entries(push)) {
        for (const row of rows) {
          const mtime = Math.min(row.mtime, now + MAX_FUTURE_MS);
          const [existing] = this.sql
            .exec(
              'SELECT mtime FROM rows WHERE tbl = ? AND id = ?',
              table,
              row.id,
            )
            .toArray();
          if (existing && Number(existing.mtime) >= mtime) continue;
          const {id, deleted} = row;
          const fields: Record<string, unknown> = {...row};
          delete fields.id;
          delete fields.mtime;
          seq++;
          written.add(seq);
          this.sql.exec(
            `INSERT OR REPLACE INTO rows (tbl, id, mtime, deleted, seq, data)
             VALUES (?, ?, ?, ?, ?, ?)`,
            table,
            id,
            mtime,
            deleted ? 1 : 0,
            seq,
            deleted ? null : JSON.stringify(fields),
          );
        }
        if (this.count(table) > LIMITS[table].maxRows) {
          // Rolls back the whole request.
          throw new SyncError(`${table}: too many rows`, 413);
        }
      }
      this.seq = seq;
    });

    const page = this.sql
      .exec(
        'SELECT tbl, id, mtime, deleted, seq, data FROM rows WHERE seq > ? ORDER BY seq LIMIT ?',
        since,
        PAGE_SIZE,
      )
      .toArray();
    const rows: Record<string, SyncRow[]> = {};
    for (const r of page) {
      if (written.has(Number(r.seq))) continue;
      (rows[String(r.tbl)] ??= []).push(toRow(r));
    }
    const cursor = page.length ? Number(page[page.length - 1].seq) : since;
    return {
      rows,
      cursor,
      more: page.length === PAGE_SIZE,
      ...(rejected.length && {rejected}),
    };
  }

  /** Everything stored (not deleted), by table: for /api/export. */
  export(): Record<string, SyncRow[]> {
    const out: Record<string, SyncRow[]> = {};
    for (const r of this.sql
      .exec(
        'SELECT tbl, id, mtime, deleted, data FROM rows WHERE deleted = 0 ORDER BY tbl, id',
      )
      .toArray()) {
      (out[String(r.tbl)] ??= []).push(toRow(r));
    }
    return out;
  }
}

function toRow(r: Record<string, unknown>): SyncRow {
  return {
    id: String(r.id),
    mtime: Number(r.mtime),
    ...(r.deleted
      ? {deleted: 1 as const}
      : (JSON.parse(String(r.data)) as object)),
  };
}
