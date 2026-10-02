/**
 * What's kept in this browser, and synced to the account when signed in
 * (DESIGN-SERVER.md, "Data model"). Opened once at startup.
 */
import type {DisplaySettings} from '../settings.ts';
import {IdbBackend} from './idb.ts';
import {MemoryBackend, Table, type Backend, type Row} from './table.ts';

/** A search, with a snapshot of its top result. id is the search (q). */
export interface HistoryRow extends Row {
  q: string;
  /** when it was last searched (ms) */
  t: number;
  word?: {text: string; reading?: string; meaning: string};
}

/** A settings group; id is its name ("display"). */
export interface SettingsRow extends Row {
  value: unknown;
}

export type MarkKind = 'star' | 'known';

/** A mark on a word; id is `${kind}:${wordId}`. */
export interface MarkRow extends Row {
  /** JMdict entry ID */
  wordId: number;
  kind: MarkKind;
}

/** Your note on a word; id is the word's JMdict entry ID. */
export interface NoteRow extends Row {
  wordId: number;
  text: string;
}

export const NOTE_MAX_LENGTH = 2000;

export interface Store {
  history: Table<HistoryRow>;
  settings: Table<SettingsRow>;
  marks: Table<MarkRow>;
  notes: Table<NoteRow>;
  backend: Backend;
  /** false when nothing is saved (no IndexedDB) */
  persistent: boolean;
}

const TABLES = ['history', 'settings', 'marks', 'notes'] as const;
/** Bump when TABLES changes. */
const DB_VERSION = 1;

export async function createStore(backend: Backend, persistent: boolean) {
  const store = {
    history: new Table<HistoryRow>('history', backend),
    settings: new Table<SettingsRow>('settings', backend),
    marks: new Table<MarkRow>('marks', backend),
    notes: new Table<NoteRow>('notes', backend),
    backend,
    persistent,
  };
  await Promise.all(TABLES.map(t => store[t].load()));
  return store;
}

export async function openStore(storage: Storage | undefined): Promise<Store> {
  let store: Store;
  try {
    store = await createStore(
      await IdbBackend.open([...TABLES], DB_VERSION),
      true,
    );
  } catch (e) {
    console.warn('IndexedDB unavailable; nothing will be saved', e);
    return createStore(new MemoryBackend(), false);
  }
  if (storage) await migrateLocalStorage(store, storage);
  return store;
}

const OLD_HISTORY = 'g-sho.history';
const OLD_SETTINGS = 'g-sho.settings';

/**
 * History and display settings used to be in localStorage. Copies them over
 * once, then removes them. Each search keeps its time as its change time,
 * so merging with another device's history keeps the latest of each.
 */
export async function migrateLocalStorage(store: Store, storage: Storage) {
  if (await store.backend.getMeta('migratedLocalStorage')) return;
  try {
    const history = JSON.parse(storage.getItem(OLD_HISTORY) ?? '[]') as Omit<
      HistoryRow,
      'id' | 'mtime'
    >[];
    if (Array.isArray(history) && history.length) {
      await store.history.restore(
        history
          .filter(i => typeof i?.q === 'string' && typeof i.t === 'number')
          .map(i => ({...i, id: i.q, mtime: i.t})),
      );
    }
    const settings = storage.getItem(OLD_SETTINGS);
    if (settings) {
      await store.settings.restore([
        {
          id: 'display',
          mtime: Date.now(),
          value: JSON.parse(settings) as Partial<DisplaySettings>,
        },
      ]);
    }
    await store.backend.setMeta('migratedLocalStorage', true);
    storage.removeItem(OLD_HISTORY);
    storage.removeItem(OLD_SETTINGS);
  } catch (e) {
    // Left in localStorage, to try again next time.
    console.warn('couldn’t move the old history or settings', e);
  }
}
