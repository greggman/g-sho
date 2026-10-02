/**
 * The words you've looked up, newest first: the store's history table
 * (synced when signed in). Each item is a search and a snapshot of its top
 * result, so the list can be drawn without loading the dictionary.
 */
import type {HistoryRow} from './store/store.ts';
import type {Fields, Table} from './store/table.ts';

export type HistoryItem = Omit<Fields<HistoryRow>, 'id'>;

/** Oldest items are dropped past this many. */
const MAX_ITEMS = 10000;

export function historyItems(table: Table<HistoryRow>): HistoryItem[] {
  return table.all().sort((a, b) => b.t - a.t);
}

/** Adds (or moves to the top) a search. */
export function addToHistory(table: Table<HistoryRow>, item: HistoryItem) {
  table.put({...item, id: item.q});
  const items = table.all();
  if (items.length > MAX_ITEMS) {
    items.sort((a, b) => b.t - a.t);
    table.delete(...items.slice(MAX_ITEMS).map(i => i.id));
  }
}

export function removeFromHistory(table: Table<HistoryRow>, q: string) {
  table.delete(q);
}

export function clearHistory(table: Table<HistoryRow>) {
  table.delete(...table.all().map(i => i.id));
}
