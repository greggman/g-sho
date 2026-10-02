/**
 * A synced table: rows kept in memory (reads are synchronous) and written
 * through to a Backend (IndexedDB in the browser). Each row records when it
 * last changed and whether the server has seen that change yet, for the
 * sync in DESIGN-SERVER.md:
 *
 *   mtime    when it last changed here (ms); the later change wins
 *   deleted  a tombstone, kept so the deletion can sync
 *   dirty    changed since the last sync
 */

export interface Row {
  id: string;
  mtime: number;
  deleted?: 1;
  dirty?: 1;
}

/** A row's own fields, as given to put(). */
export type Fields<T extends Row> = Omit<T, 'mtime' | 'deleted' | 'dirty'>;

export interface Backend {
  /** every row of the table, tombstones included */
  load(table: string): Promise<Row[]>;
  write(table: string, rows: Row[]): Promise<void>;
  getMeta<T>(key: string): Promise<T | undefined>;
  setMeta(key: string, value: unknown): Promise<void>;
}

/** A Backend that keeps nothing: when IndexedDB isn't available, and in tests. */
export class MemoryBackend implements Backend {
  readonly tables = new Map<string, Map<string, Row>>();
  readonly meta = new Map<string, unknown>();
  async load(table: string) {
    return [...(this.tables.get(table)?.values() ?? [])].map(r => ({...r}));
  }
  async write(table: string, rows: Row[]) {
    let t = this.tables.get(table);
    if (!t) this.tables.set(table, (t = new Map()));
    for (const r of rows) t.set(r.id, {...r});
  }
  async getMeta<T>(key: string) {
    return this.meta.get(key) as T | undefined;
  }
  async setMeta(key: string, value: unknown) {
    this.meta.set(key, value);
  }
}

function withoutDirty<T extends Row>(row: T): T {
  const out = {...row};
  delete out.dirty;
  return out;
}

export class Table<T extends Row> {
  readonly name: string;
  private readonly backend: Backend;
  private readonly rows = new Map<string, T>();
  private readonly listeners = new Set<() => void>();
  /** for tests: lets a clock be supplied */
  now = () => Date.now();
  /** Called after changes are saved (to tell other tabs). */
  onSaved?: () => void;

  constructor(name: string, backend: Backend) {
    this.name = name;
    this.backend = backend;
  }

  async load() {
    for (const r of (await this.backend.load(this.name)) as T[]) {
      this.rows.set(r.id, r);
    }
  }

  get(id: string): T | undefined {
    const r = this.rows.get(id);
    return r && !r.deleted ? r : undefined;
  }

  /** Rows that aren't deleted. */
  all(): T[] {
    return [...this.rows.values()].filter(r => !r.deleted);
  }

  /** Adds or replaces rows. */
  put(...fields: Fields<T>[]): T[] {
    const rows = fields.map(
      f => ({...f, mtime: this.nextMtime(f.id), dirty: 1}) as T,
    );
    void this.commit(rows);
    return rows;
  }

  /**
   * Adds rows with their own change times (from an older store), as
   * unsynced changes. Resolves once they're saved.
   */
  restore(rows: Omit<T, 'dirty'>[]): Promise<void> {
    return this.commit(rows.map(r => ({...r, dirty: 1}) as T));
  }

  delete(...ids: string[]) {
    const rows = ids
      .filter(id => this.get(id))
      .map(
        id =>
          ({id, mtime: this.nextMtime(id), deleted: 1, dirty: 1}) as Row as T,
      );
    if (rows.length) void this.commit(rows);
  }

  /** Rows changed since the last sync, tombstones included. */
  dirty(): T[] {
    return [...this.rows.values()].filter(r => r.dirty);
  }

  /**
   * The server has these versions. A row changed again since they were
   * sent stays dirty.
   */
  markClean(sent: Row[]) {
    const clean: T[] = [];
    for (const s of sent) {
      const r = this.rows.get(s.id);
      if (r?.dirty && r.mtime === s.mtime) {
        clean.push(withoutDirty(r));
      }
    }
    if (clean.length) void this.commit(clean, false);
  }

  /** Rows from the server: each replaces ours if it's a later change. */
  applyRemote(remote: T[]) {
    const accepted: T[] = [];
    for (const r of remote) {
      const local = this.rows.get(r.id);
      if (
        !local ||
        r.mtime > local.mtime ||
        (r.mtime === local.mtime && !local.dirty)
      ) {
        accepted.push(withoutDirty(r));
      }
    }
    if (accepted.length) void this.commit(accepted);
    return accepted.length > 0;
  }

  /**
   * Marks every row as changed, so the next sync sends them all: when this
   * browser's data joins an account it hasn't synced with before.
   */
  async markAllDirty() {
    const rows = [...this.rows.values()].map(r => ({...r, dirty: 1}) as T);
    if (rows.length) await this.commit(rows, false);
  }

  /**
   * Picks up changes another tab saved: each saved row replaces ours if
   * it's a later change (or the same change, now synced).
   */
  async refresh() {
    let changed = false;
    for (const r of (await this.backend.load(this.name)) as T[]) {
      const local = this.rows.get(r.id);
      if (
        !local ||
        r.mtime > local.mtime ||
        (r.mtime === local.mtime && local.dirty && !r.dirty)
      ) {
        this.rows.set(r.id, r);
        changed = true;
      }
    }
    if (changed) for (const fn of this.listeners) fn();
  }

  /** Calls fn after every change; returns a function that stops it. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Later than the row's last change, even if the clock went backwards. */
  private nextMtime(id: string) {
    return Math.max(this.now(), (this.rows.get(id)?.mtime ?? 0) + 1);
  }

  private commit(rows: T[], notify = true): Promise<void> {
    for (const r of rows) this.rows.set(r.id, r);
    const saved = this.backend.write(this.name, rows);
    saved.then(
      () => this.onSaved?.(),
      e => console.error(`couldn't save ${this.name}`, e),
    );
    if (notify) for (const fn of this.listeners) fn();
    return saved;
  }
}
