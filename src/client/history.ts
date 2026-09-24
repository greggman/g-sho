/**
 * The words you've looked up, kept in this browser's localStorage, newest
 * first. Each item is a search and a snapshot of its top result, so the
 * list can be drawn without loading the dictionary.
 */

export interface HistoryItem {
  /** the search */
  q: string;
  /** when it was last searched (ms since epoch) */
  t: number;
  /** the top result: how it's written, its reading, and a short meaning */
  word?: {text: string; reading?: string; meaning: string};
}

const KEY = 'g-sho.history';
/** Oldest items are dropped past this many. */
const MAX_ITEMS = 10000;

export function loadHistory(): HistoryItem[] {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) return JSON.parse(saved) as HistoryItem[];
  } catch {
    // Storage unavailable (private mode) or corrupt.
  }
  return [];
}

function save(items: HistoryItem[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    // Storage unavailable or full: history just isn't kept.
  }
}

/** Adds (or moves to the top) a search. */
export function addToHistory(
  items: HistoryItem[],
  item: HistoryItem,
): HistoryItem[] {
  const out = [item, ...items.filter(i => i.q !== item.q)].slice(0, MAX_ITEMS);
  save(out);
  return out;
}

export function removeFromHistory(
  items: HistoryItem[],
  q: string,
): HistoryItem[] {
  const out = items.filter(i => i.q !== q);
  save(out);
  return out;
}

export function clearHistory(): HistoryItem[] {
  save([]);
  return [];
}
