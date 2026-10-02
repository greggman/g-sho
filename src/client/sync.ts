/**
 * Syncs the store with the signed-in account (POST /api/sync; see
 * DESIGN-SERVER.md, "Sync protocol"). Each round sends what changed here
 * and gets what changed elsewhere since the last round.
 *
 * Runs on start, a moment after changes, when the tab comes back into
 * view, when the browser comes back online, and every few minutes while
 * visible. Open tabs take turns (a Web Lock), since they share the store.
 */
import {tables, type Store} from './store/store.ts';
import type {Row, Table} from './store/table.ts';

export type SyncState = 'syncing' | 'synced' | 'offline' | 'error';

export interface SyncStatus {
  state: SyncState;
  /** when the last sync finished (ms) */
  lastSynced?: number;
  message?: string;
}

/** Rows sent per request (the server takes up to 2,000). */
const BATCH = 1000;
/** Wait after a change, so a burst of changes goes in one request. */
const CHANGE_DELAY = 2000;
const PERIOD = 5 * 60 * 1000;
/** Stop a round after this many requests, in case something loops. */
const MAX_REQUESTS = 100;

/** Only browsers know; elsewhere (tests), assume online. */
const offline = () => navigator.onLine === false;

interface Response {
  rows: Record<string, Row[]>;
  cursor: number;
  more: boolean;
  rejected?: {table: string; id: string; error: string}[];
}

export class Sync {
  private readonly store: Store;
  private readonly userId: string;
  private readonly tables: Map<string, Table<Row>>;
  private readonly listeners = new Set<(s: SyncStatus) => void>();
  private readonly cleanups: (() => void)[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private again = false;
  private stopped = false;
  status: SyncStatus = {state: 'syncing'};
  /** Called when the server says we're no longer signed in. */
  onSignedOut?: () => void;
  /** for tests: how requests are sent */
  fetch: typeof fetch = (input, init) => fetch(input, init);

  constructor(store: Store, userId: string) {
    this.store = store;
    this.userId = userId;
    this.tables = new Map(tables(store).map(t => [t.name, t]));
  }

  private get cursorKey() {
    return `syncCursor:${this.userId}`;
  }

  async start() {
    // Data in this browser that hasn't been synced with this account (first
    // sign-in, or a different account than last time) joins it: send all.
    const last = await this.store.backend.getMeta<string>('syncUser');
    if (last !== this.userId) {
      for (const t of this.tables.values()) await t.markAllDirty();
      await this.store.backend.setMeta('syncUser', this.userId);
    }
    for (const t of this.tables.values()) {
      this.cleanups.push(t.onChange(() => this.soon(CHANGE_DELAY)));
    }
    if (typeof document !== 'undefined') this.listen();
    await this.now();
  }

  /** Syncs when the tab is shown, when back online, and every few minutes. */
  private listen() {
    const onVisible = () => {
      if (document.visibilityState === 'visible') this.soon(0, true);
    };
    const onOnline = () => this.soon(0, true);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') this.soon(0, true);
    }, PERIOD);
    this.cleanups.push(
      () => document.removeEventListener('visibilitychange', onVisible),
      () => window.removeEventListener('online', onOnline),
      () => clearInterval(interval),
    );
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    for (const c of this.cleanups.splice(0)) c();
  }

  onStatus(fn: (s: SyncStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Syncs after `delay`. Unless forced, only if something changed here
   * (changes that came from the server don't need sending back).
   */
  soon(delay: number, force = false) {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (force || this.hasChanges()) void this.now();
    }, delay);
  }

  /** Syncs now; if a sync is running, runs another after it. */
  async now(): Promise<void> {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.withLock(() => this.round());
      } while (this.again && !this.stopped);
    })().finally(() => (this.running = undefined));
    return this.running;
  }

  private hasChanges() {
    for (const t of this.tables.values()) if (t.dirty().length) return true;
    return false;
  }

  private async withLock(fn: () => Promise<void>) {
    if (typeof navigator !== 'undefined' && navigator.locks) {
      await navigator.locks.request('g-sho-sync', fn);
    } else {
      await fn();
    }
  }

  private setStatus(status: SyncStatus) {
    this.status = status;
    for (const fn of this.listeners) fn(status);
  }

  /** Requests until everything is sent and nothing more is waiting. */
  private async round() {
    if (offline()) {
      this.setStatus({...this.status, state: 'offline'});
      return;
    }
    this.setStatus({...this.status, state: 'syncing'});
    try {
      let cursor =
        (await this.store.backend.getMeta<number>(this.cursorKey)) ?? 0;
      for (let i = 0; i < MAX_REQUESTS && !this.stopped; i++) {
        const sent = this.batch();
        const res = await this.fetch('/api/sync', {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({since: cursor, push: sent}),
        });
        if (res.status === 401) {
          this.stop();
          this.onSignedOut?.();
          return;
        }
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {error?: string};
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        const data = (await res.json()) as Response;
        if (data.rejected)
          console.warn('sync: rows not accepted', data.rejected);
        // Rejected rows are marked clean too: sending them again won't help.
        for (const [name, rows] of Object.entries(sent)) {
          this.tables.get(name)?.markClean(rows);
        }
        for (const [name, rows] of Object.entries(data.rows)) {
          this.tables.get(name)?.applyRemote(rows);
        }
        cursor = data.cursor;
        await this.store.backend.setMeta(this.cursorKey, cursor);
        if (!data.more && !this.hasChanges()) break;
      }
      this.setStatus({state: 'synced', lastSynced: Date.now()});
    } catch (e) {
      console.warn('sync failed', e);
      this.setStatus({
        ...this.status,
        state: offline() ? 'offline' : 'error',
        message: (e as Error).message,
      });
    }
  }

  /** Up to BATCH changed rows, by table, without the dirty flag. */
  private batch(): Record<string, Row[]> {
    const out: Record<string, Row[]> = {};
    let n = 0;
    for (const t of this.tables.values()) {
      for (const r of t.dirty()) {
        if (n++ >= BATCH) return out;
        const row = {...r};
        delete row.dirty;
        (out[t.name] ??= []).push(row);
      }
    }
    return out;
  }
}
