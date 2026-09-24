import {h} from './dom.ts';
import {
  addToHistory,
  clearHistory,
  loadHistory,
  removeFromHistory,
  type HistoryItem,
} from './history.ts';
import {rubyWord} from './render.ts';
import {VirtualList} from './virtual-list.ts';

/** Height of a history row: the word with furigana, then its meaning. */
const ROW_HEIGHT = 64;

function searchUrl(q: string): string {
  return `?${new URLSearchParams({q})}`;
}

/**
 * The history, shared by every view of it (the side column and the home
 * page): changes are saved and every view updates.
 */
export class HistoryStore {
  items: HistoryItem[] = loadHistory();
  private readonly views = new Set<HistoryView>();

  add(item: HistoryItem) {
    this.items = addToHistory(this.items, item);
    this.changed();
  }

  remove(q: string) {
    this.items = removeFromHistory(this.items, q);
    this.changed();
  }

  clear() {
    this.items = clearHistory();
    this.changed();
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

/** A heading with the count and Clear, then a virtual list of rows. */
export class HistoryView {
  readonly element: HTMLElement;
  readonly persistent: boolean;
  private readonly store: HistoryStore;
  private readonly list: VirtualList<HistoryItem>;
  private readonly count: HTMLElement;
  private current = '';

  /** `persistent`: stays on the page across searches (the side column). */
  constructor(store: HistoryStore, persistent = false) {
    this.store = store;
    this.persistent = persistent;
    this.count = h('span', {class: 'count'});
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
        h('h2', {class: 'results-heading'}, 'History', this.count),
        h(
          'button',
          {
            type: 'button',
            class: 'history-clear',
            onclick: () => {
              if (confirm('Clear your whole history?')) store.clear();
            },
          },
          'Clear',
        ),
      ),
      this.list.element,
    );
    store.watch(this);
    this.update();
  }

  /** Highlights the row for the search on screen. */
  setCurrent(q: string) {
    this.current = q;
    this.list.setItems(this.store.items);
  }

  update() {
    const {items} = this.store;
    this.element.hidden = items.length === 0;
    this.count.textContent = ` — ${items.length.toLocaleString()}`;
    this.list.setItems(items);
  }

  private row(item: HistoryItem): HTMLElement {
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
      h(
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
