import {h} from './dom.ts';
import {
  addToHistory,
  clearHistory,
  historyItems,
  removeFromHistory,
  type HistoryItem,
} from './history.ts';
import {rubyWord} from './render.ts';
import type {HistoryRow, MarkRow} from './store/store.ts';
import type {Table} from './store/table.ts';
import {VirtualList} from './virtual-list.ts';

/** Height of a history row: the word with furigana, then its meaning. */
const ROW_HEIGHT = 64;

function searchUrl(q: string): string {
  return `?${new URLSearchParams({q})}`;
}

/** A starred word, shown like a history item (searching its headword). */
export interface StarredItem extends HistoryItem {
  wordId: number;
}

/**
 * The history, shared by every view of it (the side column and the home
 * page): changes are saved and every view updates. Also the starred words,
 * which a view can show instead.
 */
export class HistoryStore {
  items: HistoryItem[] = [];
  /** starred words, newest first (those found in the dictionary) */
  starred: StarredItem[] = [];
  private table?: Table<HistoryRow>;
  private marks?: Table<MarkRow>;
  private readonly views = new Set<HistoryView>();
  /** starred words looked up, by word ID */
  private readonly words = new Map<number, Promise<StarredItem | undefined>>();

  /** Shows the store's history; called once the store is open. */
  attach(table: Table<HistoryRow>) {
    this.table = table;
    const load = () => {
      this.items = historyItems(table);
      this.changed();
    };
    // Every change, including ones synced from another device.
    table.onChange(load);
    load();
  }

  /**
   * Shows the starred words. A mark only has the word's ID, so each is
   * looked up (`lookup`) to show it.
   */
  attachStars(
    marks: Table<MarkRow>,
    lookup: (wordId: number) => Promise<StarredItem | undefined>,
  ) {
    this.marks = marks;
    let latest = 0;
    const load = async () => {
      const call = ++latest;
      const stars = marks
        .all()
        .filter(m => m.kind === 'star')
        .sort((a, b) => b.mtime - a.mtime);
      const items = await Promise.all(
        stars.map(m => {
          let item = this.words.get(m.wordId);
          if (!item) {
            item = lookup(m.wordId).catch(() => undefined);
            this.words.set(m.wordId, item);
          }
          return item;
        }),
      );
      if (call !== latest) return;
      this.starred = items.filter(i => i !== undefined);
      this.changed();
    };
    marks.onChange(() => void load());
    void load();
  }

  unstar(wordId: number) {
    this.marks?.delete(`star:${wordId}`);
  }

  add(item: HistoryItem) {
    if (this.table) addToHistory(this.table, item);
  }

  remove(q: string) {
    if (this.table) removeFromHistory(this.table, q);
  }

  clear() {
    if (this.table) clearHistory(this.table);
  }

  watch(view: HistoryView) {
    this.views.add(view);
  }

  private changed() {
    for (const v of this.views) {
      // Views on pages that were replaced are forgotten.
      if (v.element.isConnected || v.persistent) v.update();
      else this.views.delete(v);
    }
  }
}

/**
 * A heading with the count, a Starred toggle and Clear, then a virtual list
 * of rows: the history, or (toggled) the starred words.
 */
export class HistoryView {
  readonly element: HTMLElement;
  readonly persistent: boolean;
  private readonly store: HistoryStore;
  private readonly list: VirtualList<HistoryItem>;
  private readonly count: HTMLElement;
  private readonly title: HTMLElement;
  private readonly starToggle: HTMLButtonElement;
  private readonly clearButton: HTMLButtonElement;
  private readonly empty: HTMLElement;
  private current = '';
  private showStarred = false;

  /** `persistent`: stays on the page across searches (the side column). */
  constructor(store: HistoryStore, persistent = false) {
    this.store = store;
    this.persistent = persistent;
    this.count = h('span', {class: 'count'});
    this.title = h('span', null, 'History');
    this.starToggle = h(
      'button',
      {
        type: 'button',
        class: 'history-filter',
        'aria-pressed': 'false',
        title: 'Show only the words you starred',
        onclick: () => {
          this.showStarred = !this.showStarred;
          this.update();
        },
      },
      '★ Starred',
    );
    this.clearButton = h(
      'button',
      {
        type: 'button',
        class: 'history-clear',
        onclick: () => {
          if (confirm('Clear your whole history?')) store.clear();
        },
      },
      'Clear',
    );
    this.empty = h(
      'p',
      {class: 'hint history-empty'},
      'No starred words yet. Tap ☆ by a word to star it.',
    );
    this.list = new VirtualList<HistoryItem>(
      ROW_HEIGHT,
      item => this.row(item),
      'history-list',
    );
    this.element = h(
      'section',
      {class: 'history', 'aria-label': 'History'},
      h(
        'div',
        {class: 'history-head'},
        h('h2', {class: 'results-heading'}, this.title, this.count),
        this.starToggle,
        this.clearButton,
      ),
      this.empty,
      this.list.element,
    );
    store.watch(this);
    this.update();
  }

  /** Highlights the row for the search on screen. */
  setCurrent(q: string) {
    this.current = q;
    this.update();
  }

  update() {
    const {items, starred} = this.store;
    const shown = this.showStarred ? starred : items;
    this.element.hidden = items.length === 0 && starred.length === 0;
    this.title.textContent = this.showStarred ? 'Starred' : 'History';
    this.count.textContent = ` — ${shown.length.toLocaleString()}`;
    this.starToggle.setAttribute('aria-pressed', String(this.showStarred));
    this.clearButton.hidden = this.showStarred;
    this.empty.hidden = !this.showStarred || starred.length > 0;
    this.list.setItems(shown);
  }

  private row(item: HistoryItem | StarredItem): HTMLElement {
    const current = item.q === this.current;
    return h(
      'div',
      {class: current ? 'history-row current' : 'history-row'},
      h(
        'a',
        {
          class: 'history-link',
          href: searchUrl(item.q),
          'aria-current': current ? 'page' : undefined,
        },
        h(
          'span',
          {class: 'history-word'},
          item.word ? rubyWord(item.word) : h('span', {lang: 'ja'}, item.q),
          item.word &&
            item.word.text !== item.q &&
            h('span', {class: 'history-query'}, item.q),
        ),
        h('span', {class: 'history-meaning'}, item.word?.meaning ?? 'Sentence'),
      ),
      'wordId' in item
        ? h(
            'button',
            {
              type: 'button',
              class: 'history-remove',
              title: `Unstar ${item.q}`,
              'aria-label': `Unstar ${item.q}`,
              onclick: () => this.store.unstar(item.wordId),
            },
            '×',
          )
        : h(
            'button',
            {
              type: 'button',
              class: 'history-remove',
              title: `Remove ${item.q} from history`,
              'aria-label': `Remove ${item.q} from history`,
              onclick: () => this.store.remove(item.q),
            },
            '×',
          ),
    );
  }
}
