/**
 * What the server accepts in a sync: for each table, its fields and limits.
 * Anything else is refused, so the sync can't be used as general storage.
 * These match the client's tables (src/client/store/store.ts).
 */

export interface SyncRow {
  id: string;
  mtime: number;
  deleted?: 1;
  [field: string]: unknown;
}

export class SyncError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

type Check = (value: unknown) => boolean;

const str =
  (max: number): Check =>
  v =>
    typeof v === 'string' && v.length <= max;
const optional =
  (check: Check): Check =>
  v =>
    v === undefined || check(v);
const wordId: Check = v => Number.isSafeInteger(v) && (v as number) > 0;
const time: Check = v => Number.isSafeInteger(v) && (v as number) >= 0;
const object =
  (fields: Record<string, Check>): Check =>
  v =>
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.keys(v).every(k => k in fields) &&
    Object.entries(fields).every(([k, check]) =>
      check((v as Record<string, unknown>)[k]),
    );
/** Any JSON object, up to `max` characters as JSON. */
const jsonObject =
  (max: number): Check =>
  v =>
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    JSON.stringify(v).length <= max;

interface TableSchema {
  /** most rows (not counting deletions) */
  maxRows: number;
  fields: Record<string, Check>;
  /** what the id must be, given the row */
  id: (row: SyncRow) => boolean;
}

export const LIMITS: Record<string, TableSchema> = {
  history: {
    maxRows: 10_500,
    fields: {
      q: str(2000),
      t: time,
      word: optional(
        object({
          text: str(200),
          reading: optional(str(200)),
          meaning: str(2000),
        }),
      ),
    },
    id: r => r.id === r.q,
  },
  settings: {
    maxRows: 20,
    fields: {value: jsonObject(4000)},
    id: r => /^[a-z][a-zA-Z]{0,31}$/.test(r.id),
  },
  marks: {
    maxRows: 100_000,
    fields: {wordId, kind: v => v === 'star' || v === 'known'},
    id: r => r.id === `${String(r.kind)}:${String(r.wordId)}`,
  },
  notes: {
    maxRows: 50_000,
    fields: {wordId, text: str(2000)},
    id: r => r.id === String(r.wordId),
  },
};

/** Throws a SyncError unless the row is valid for the table. */
export function validateRow(table: string, row: unknown) {
  const schema = LIMITS[table];
  const bad = (why: string) => new SyncError(`${table}: ${why}`);
  if (typeof row !== 'object' || row === null) throw bad('not an object');
  const r = row as SyncRow;
  if (typeof r.id !== 'string' || r.id.length === 0 || r.id.length > 2000) {
    throw bad('bad id');
  }
  if (!time(r.mtime)) throw bad(`${r.id}: bad mtime`);
  if (r.deleted !== undefined) {
    if (r.deleted !== 1) throw bad(`${r.id}: bad deleted`);
    // A deletion carries nothing else.
    if (Object.keys(r).some(k => !['id', 'mtime', 'deleted'].includes(k))) {
      throw bad(`${r.id}: a deletion has fields`);
    }
    return;
  }
  for (const k of Object.keys(r)) {
    if (k !== 'id' && k !== 'mtime' && !(k in schema.fields)) {
      throw bad(`${r.id}: unknown field ${k}`);
    }
  }
  for (const [k, check] of Object.entries(schema.fields)) {
    if (!check(r[k])) throw bad(`${r.id}: bad ${k}`);
  }
  if (!schema.id(r)) throw bad(`${r.id}: id doesn't match`);
}
