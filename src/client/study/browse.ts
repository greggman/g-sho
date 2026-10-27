/**
 * The card browser (?study=browse): every card, searchable and filtered by
 * deck and state, in a virtual list (fast with thousands). A card opens in
 * a dialog with its fields, schedule and review history, and actions:
 * move, suspend, forget, delete, look up.
 */
import {h} from '../dom.ts';
import {stripHtml} from '../anki/apkg.ts';
import {t} from '../i18n.ts';
import {
  CardState,
  type CardRow,
  type FactRow,
  type Store,
} from '../store/store.ts';
import {fieldsOf} from '../store/table.ts';
import {VirtualList} from '../virtual-list.ts';
import {NOTE_TYPE, newCard, removeWord} from './model.ts';
import {formatInterval, ratingLabel} from './scheduler.ts';

const ROW_HEIGHT = 52;
const DAY = 86_400_000;

type StateFilter =
  'all' | 'new' | 'learning' | 'review' | 'due' | 'suspended' | 'duplicate';
type SortKey = 'due' | 'added' | 'word' | 'lapses' | 'interval';

interface Item {
  card: CardRow;
  fact?: FactRow;
  front: string;
  back: string;
  /** lower-cased text to search */
  text: string;
}

/** A field as plain text: no HTML, sounds, or cloze/furigana markup. */
export function plain(field: string): string {
  return stripHtml(
    field
      .replace(/\[sound:[^\]]*\]/g, '')
      .replace(/\{\{c\d+::(.*?)(::[^}]*)?\}\}/g, '$1')
      .replace(/<br\s*\/?>/gi, ' '),
  )
    .replace(/ ?([^ >]+?)\[(.+?)\]/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function describe(fact: FactRow | undefined): {front: string; back: string} {
  if (!fact) return {front: '?', back: ''};
  if (fact.noteType === NOTE_TYPE) {
    const [word = '', reading = '', meaning = ''] = fact.fields;
    return {front: word, back: [reading, meaning].filter(Boolean).join(' — ')};
  }
  const texts = fact.fields.map(plain).filter(Boolean);
  return {front: texts[0] ?? '', back: texts.slice(1, 3).join(' — ')};
}

function stateLabel(c: CardRow, now: number): {text: string; kind: string} {
  if (c.suspended)
    return {
      text: c.dupOf ? t('duplicate') : t('suspended'),
      kind: 'suspended',
    };
  if (c.state === CardState.New) return {text: t('new'), kind: 'new'};
  const kind = c.state === CardState.Review ? 'review' : 'learning';
  const left = c.due - now;
  return {
    text:
      left <= 0
        ? left < -DAY
          ? t('due ({time} late)', {time: formatInterval(-left)})
          : t('due')
        : t('in {time}', {time: formatInterval(left)}),
    kind,
  };
}

export function renderBrowser(store: Store): HTMLElement {
  const search = h('input', {
    type: 'search',
    class: 'browse-search',
    placeholder: t('Search cards'),
    'aria-label': t('Search cards'),
  });
  const deckSelect = h('select', {'aria-label': t('Deck')});
  const stateSelect = h(
    'select',
    {'aria-label': t('State')},
    (
      [
        ['all', t('All cards')],
        ['due', t('Due now')],
        ['new', t('New')],
        ['learning', t('Learning')],
        ['review', t('Review')],
        ['suspended', t('Suspended')],
        ['duplicate', t('Suspended as duplicates')],
      ] as [StateFilter, string][]
    ).map(([v, l]) => h('option', {value: v}, l)),
  );
  const sortSelect = h(
    'select',
    {'aria-label': t('Sort by')},
    (
      [
        ['due', t('Sort: due')],
        ['added', t('Sort: newest')],
        ['word', t('Sort: word')],
        ['lapses', t('Sort: most forgotten')],
        ['interval', t('Sort: longest interval')],
      ] as [SortKey, string][]
    ).map(([v, l]) => h('option', {value: v}, l)),
  );
  const count = h('p', {class: 'hint browse-count'});
  const dialog = h('dialog', {class: 'card-dialog'});

  let items: Item[] = [];
  const list = new VirtualList<Item>(
    ROW_HEIGHT,
    item => row(item),
    'browse-list',
  );

  const row = (item: Item) => {
    const s = stateLabel(item.card, Date.now());
    const deck = store.decks.get(item.card.deckId)?.name ?? '';
    const wordId = item.fact?.wordId;
    return h(
      'div',
      {class: 'browse-row'},
      h(
        'button',
        {
          type: 'button',
          class: 'browse-open',
          onclick: () => open(item.card.id),
        },
        h('span', {class: 'browse-front', lang: 'ja'}, item.front),
        h('span', {class: 'browse-back'}, item.back),
        h('span', {class: 'browse-deck hint'}, deck),
        h('span', {class: `browse-state state-${s.kind}`}, s.text),
      ),
      wordId !== undefined ? knownToggle(wordId) : h('span'),
    );
  };

  /**
   * The word's "known" mark, as on its dictionary entry: study skips the
   * cards of a known word.
   */
  const knownToggle = (wordId: number) => {
    const id = `known:${wordId}`;
    const button = h('button', {
      type: 'button',
      class: 'word-tool known',
      onclick: () => {
        if (store.marks.get(id)) store.marks.delete(id);
        else store.marks.put({id, wordId, kind: 'known'});
        draw();
      },
    });
    const draw = () => {
      const known = !!store.marks.get(id);
      button.setAttribute('aria-pressed', String(known));
      button.title = known
        ? t('Marked as known. Click to unmark.')
        : t('I know this word: study won’t show it');
      button.textContent = known ? t('✓ known') : t('known');
    };
    draw();
    return button;
  };

  const fillDecks = () => {
    const current = deckSelect.value;
    deckSelect.replaceChildren(
      h('option', {value: ''}, t('All decks')),
      ...store.decks
        .all()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(d =>
          h('option', {value: d.id, selected: d.id === current}, d.name),
        ),
    );
  };

  const update = () => {
    const now = Date.now();
    const q = search.value.trim().toLowerCase();
    const deck = deckSelect.value;
    const state = stateSelect.value as StateFilter;
    const all = store.cards.all();
    items = all
      .filter(c => !deck || c.deckId === deck)
      .filter(c => {
        switch (state) {
          case 'new':
            return !c.suspended && c.state === CardState.New;
          case 'learning':
            return (
              !c.suspended &&
              (c.state === CardState.Learning ||
                c.state === CardState.Relearning)
            );
          case 'review':
            return !c.suspended && c.state === CardState.Review;
          case 'due':
            return !c.suspended && c.state !== CardState.New && c.due <= now;
          case 'suspended':
            return !!c.suspended;
          case 'duplicate':
            return !!c.dupOf;
          default:
            return true;
        }
      })
      .map(card => {
        const fact = store.facts.get(card.factId);
        const {front, back} = describe(fact);
        return {
          card,
          fact,
          front,
          back,
          text: `${front} ${back} ${fact?.tags.join(' ') ?? ''}`.toLowerCase(),
        };
      })
      .filter(i => !q || i.text.includes(q));
    const by: Record<SortKey, (a: Item, b: Item) => number> = {
      due: (a, b) => {
        // Due cards first, then new ones in the order they'd come, then
        // suspended ones.
        const rank = (c: CardRow) =>
          c.suspended ? 2 : c.state === CardState.New ? 1 : 0;
        return (
          rank(a.card) - rank(b.card) ||
          (a.card.state === CardState.New
            ? a.card.added - b.card.added
            : a.card.due - b.card.due)
        );
      },
      added: (a, b) => b.card.added - a.card.added,
      word: (a, b) => a.front.localeCompare(b.front, 'ja'),
      lapses: (a, b) => b.card.lapses - a.card.lapses,
      interval: (a, b) => b.card.scheduledDays - a.card.scheduledDays,
    };
    items.sort(by[sortSelect.value as SortKey]);
    count.textContent = t('{shown} of {total} cards', {
      shown: items.length.toLocaleString(),
      total: all.length.toLocaleString(),
    });
    list.setItems(items);
  };

  // ---- one card ----

  const open = (id: string) => {
    const card = store.cards.get(id);
    if (!card) return;
    const fact = store.facts.get(card.factId);
    const nt =
      fact && fact.noteType !== NOTE_TYPE
        ? store.noteTypes.get(fact.noteType)
        : undefined;
    const names =
      fact?.noteType === NOTE_TYPE
        ? [t('Word'), t('Reading'), t('Meaning')]
        : (nt?.fields ?? []);
    const now = Date.now();
    const s = stateLabel(card, now);
    const reviews = store.reviews
      .all()
      .filter(r => r.cardId === card.id)
      .sort((a, b) => b.t - a.t);
    const date = (ms: number) => new Date(ms).toLocaleDateString();
    const close = () => dialog.close();
    const act = (fn: () => void) => () => {
      fn();
      close();
      update();
    };
    const moveTo = h(
      'select',
      {
        'aria-label': t('Move to deck'),
        onchange: act(() => {
          store.cards.put({
            ...fieldsOf(store.cards.get(id)!),
            deckId: moveTo.value,
          });
        }),
      },
      store.decks
        .all()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(d =>
          h('option', {value: d.id, selected: d.id === card.deckId}, d.name),
        ),
    );
    const facts: [string, string | Node][] = [
      [t('State'), s.text],
      [t('Deck'), moveTo],
      ...(card.state !== CardState.New
        ? ([
            [t('Due'), date(card.due)],
            [
              t('Interval'),
              card.scheduledDays
                ? t('{n} days', {n: Math.round(card.scheduledDays)})
                : '—',
            ],
            [t('Stability'), t('{n} days', {n: card.stability.toFixed(1)})],
            [t('Difficulty'), `${card.difficulty.toFixed(1)} / 10`],
            [t('Reviews'), String(card.reps)],
            [t('Forgotten'), String(card.lapses)],
          ] as [string, string][])
        : []),
      [t('Added'), date(card.added)],
      ...(card.lastReview
        ? ([[t('Last review'), date(card.lastReview)]] as [string, string][])
        : []),
    ];
    dialog.replaceChildren(
      h(
        'div',
        {class: 'card-dialog-body'},
        h(
          'div',
          {class: 'card-dialog-head'},
          h('h2', {lang: 'ja'}, describe(fact).front || t('Card')),
          h(
            'button',
            {
              type: 'button',
              class: 'card-dialog-close',
              'aria-label': t('Close'),
              onclick: close,
            },
            '×',
          ),
        ),
        fact &&
          h(
            'dl',
            {class: 'card-fields'},
            fact.fields.flatMap((v, i) =>
              plain(v)
                ? [
                    h('dt', null, names[i] ?? t('Field {n}', {n: i + 1})),
                    h('dd', {lang: 'ja'}, plain(v)),
                  ]
                : [],
            ),
            fact.tags.length
              ? [h('dt', null, t('Tags')), h('dd', null, fact.tags.join(' '))]
              : [],
          ),
        h(
          'dl',
          {class: 'card-facts'},
          facts.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]),
        ),
        reviews.length > 0 &&
          h(
            'details',
            {class: 'card-reviews'},
            h('summary', null, t('Review history ({n})', {n: reviews.length})),
            h(
              'table',
              null,
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  h('th', null, t('Date')),
                  h('th', null, t('Answer')),
                  h('th', null, t('Time')),
                ),
              ),
              h(
                'tbody',
                null,
                reviews.map(r =>
                  h(
                    'tr',
                    null,
                    h('td', null, new Date(r.t).toLocaleString()),
                    h('td', null, ratingLabel(r.rating)),
                    h(
                      'td',
                      null,
                      t('{n}s', {n: Math.round(r.durationMs / 1000)}),
                    ),
                  ),
                ),
              ),
            ),
          ),
        h(
          'div',
          {class: 'deck-option-buttons'},
          h(
            'button',
            {
              type: 'button',
              onclick: act(() => {
                const c = fieldsOf(store.cards.get(id)!);
                if (c.suspended) {
                  delete c.suspended;
                  delete c.dupOf;
                } else {
                  c.suspended = 1;
                }
                store.cards.put(c);
              }),
            },
            card.suspended ? t('Unsuspend') : t('Suspend'),
          ),
          card.state !== CardState.New &&
            h(
              'button',
              {
                type: 'button',
                onclick: () => {
                  if (
                    !confirm(
                      t(
                        'Forget this card? It will be new again (its review history is kept).',
                      ),
                    )
                  )
                    return;
                  act(() => {
                    const c = store.cards.get(id)!;
                    store.cards.put({
                      ...newCard(c.factId, c.deckId, c.ord, Date.now()),
                      ...(c.direction && {direction: c.direction}),
                    });
                  })();
                },
              },
              t('Forget'),
            ),
          !!fact?.wordId &&
            h(
              'a',
              {
                class: 'button',
                href: `?${new URLSearchParams({q: describe(fact).front})}`,
              },
              t('Look up'),
            ),
          h(
            'button',
            {
              type: 'button',
              class: 'danger',
              onclick: () => {
                const siblings = store.cards
                  .all()
                  .filter(c => c.factId === card.factId);
                const question =
                  siblings.length > 1
                    ? t(
                        'Delete this note and its {n} cards? Their review history is kept.',
                        {n: siblings.length},
                      )
                    : t('Delete this card? Their review history is kept.');
                if (!confirm(question)) return;
                act(() => {
                  if (fact?.noteType === NOTE_TYPE && fact.wordId) {
                    removeWord(store, fact.wordId);
                  } else {
                    store.facts.delete(card.factId);
                    store.cards.delete(...siblings.map(c => c.id));
                  }
                })();
              },
            },
            t('Delete'),
          ),
        ),
      ),
    );
    dialog.showModal();
  };

  for (const el of [deckSelect, stateSelect, sortSelect]) {
    el.addEventListener('change', update);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(update, 150);
  });
  // Close the dialog by clicking outside it.
  dialog.addEventListener('click', e => {
    if (e.target === dialog) dialog.close();
  });

  fillDecks();
  const page = h(
    'div',
    {class: 'study-page browse-page'},
    h(
      'div',
      {class: 'study-head'},
      h('h1', null, t('Cards')),
      h('a', {href: '?study'}, t('← Decks')),
    ),
    h(
      'div',
      {class: 'browse-filters'},
      search,
      deckSelect,
      stateSelect,
      sortSelect,
    ),
    count,
    list.element,
    dialog,
  );
  update();
  return page;
}
