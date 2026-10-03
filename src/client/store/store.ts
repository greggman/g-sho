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

/** A study deck; the one words are added to by default has id "default". */
export interface DeckRow extends Row {
  name: string;
  /** new cards introduced per day */
  newPerDay: number;
  /** most reviews per day */
  reviewsPerDay: number;
  /** FSRS desired retention (0.7–0.99) */
  retention: number;
}

/**
 * What cards are made from: Anki's "note" (called a fact here, since
 * "notes" are your notes on words). A word added from the dictionary has
 * id `w:${wordId}` and the built-in note type.
 */
export interface FactRow extends Row {
  /** "g-sho" for the built-in type: fields [word, reading, meaning] */
  noteType: string;
  fields: string[];
  tags: string[];
  /** Anki's note GUID, kept for exporting and re-importing */
  guid: string;
  /** the dictionary entry it's about, if known */
  wordId?: number;
}

/** FSRS card states (the same numbers as ts-fsrs's State). */
export const CardState = {
  New: 0,
  Learning: 1,
  Review: 2,
  Relearning: 3,
} as const;
export type CardState = (typeof CardState)[keyof typeof CardState];

/**
 * One thing to review, made from a fact: id `${factId}:${ord}`. The FSRS
 * fields mirror ts-fsrs's Card, with times in ms.
 */
export interface CardRow extends Row {
  factId: string;
  deckId: string;
  /** which card of the fact (0: recognition, word → meaning) */
  ord: number;
  due: number;
  stability: number;
  difficulty: number;
  elapsedDays: number;
  scheduledDays: number;
  learningSteps: number;
  reps: number;
  lapses: number;
  state: CardState;
  lastReview?: number;
  /** when it was added (orders new cards) */
  added: number;
  suspended?: 1;
}

/** One review of a card, never changed: the history its schedule came from. */
export interface ReviewRow extends Row {
  cardId: string;
  /** when (ms) */
  t: number;
  /** 1 again, 2 hard, 3 good, 4 easy */
  rating: number;
  /** time spent on the card (ms) */
  durationMs: number;
  /** the card's state before this review */
  state: CardState;
  stability: number;
  difficulty: number;
  elapsedDays: number;
  scheduledDays: number;
}

export interface Store {
  history: Table<HistoryRow>;
  settings: Table<SettingsRow>;
  marks: Table<MarkRow>;
  notes: Table<NoteRow>;
  decks: Table<DeckRow>;
  facts: Table<FactRow>;
  cards: Table<CardRow>;
  reviews: Table<ReviewRow>;
  backend: Backend;
  /** false when nothing is saved (no IndexedDB) */
  persistent: boolean;
}

const TABLES = [
  'history',
  'settings',
  'marks',
  'notes',
  'decks',
  'facts',
  'cards',
  'reviews',
] as const;
/** Bump when TABLES changes. */
const DB_VERSION = 2;

export async function createStore(backend: Backend, persistent: boolean) {
  const store = {
    history: new Table<HistoryRow>('history', backend),
    settings: new Table<SettingsRow>('settings', backend),
    marks: new Table<MarkRow>('marks', backend),
    notes: new Table<NoteRow>('notes', backend),
    decks: new Table<DeckRow>('decks', backend),
    facts: new Table<FactRow>('facts', backend),
    cards: new Table<CardRow>('cards', backend),
    reviews: new Table<ReviewRow>('reviews', backend),
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
  shareBetweenTabs(store);
  return store;
}

/** Tables in this tab pick up what other tabs save. */
function shareBetweenTabs(store: Store) {
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel('g-sho-store');
  for (const name of TABLES) {
    store[name].onSaved = () => channel.postMessage(name);
  }
  channel.onmessage = e => {
    const name = e.data as (typeof TABLES)[number];
    if (TABLES.includes(name)) void store[name].refresh();
  };
}

/** The tables, for code that handles them all alike (sync). */
export function tables(store: Store): Table<Row>[] {
  return TABLES.map(t => store[t] as unknown as Table<Row>);
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
