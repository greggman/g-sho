/**
 * The study pages: the deck list (?study) and a review session
 * (?study=<deck id>, or ?study=all). Loaded on demand with ts-fsrs.
 */
import type {Grade} from 'ts-fsrs';
import type {Dict} from '../dict.ts';
import {h} from '../dom.ts';
import {cardFrame} from '../anki/card-frame.ts';
import {renderTemplate} from '../anki/template.ts';
import {headword} from '../forms.ts';
import {renderEntry, rubyWord} from '../render.ts';
import type {CardRow, DeckRow, Store} from '../store/store.ts';
import {fieldsOf} from '../store/table.ts';
import {
  applyDeckDuplicates,
  deckDuplicates,
  type DuplicateChoice,
} from './duplicates.ts';
import {
  DECK_DEFAULTS,
  NOTE_TYPE,
  addToDeck,
  buildQueue,
  defaultDeck,
  randomId,
  setAddToDeck,
  type DeckCounts,
} from './model.ts';
import {RATINGS, answer, formatInterval, preview} from './scheduler.ts';

const studyUrl = (deck: string) => `?${new URLSearchParams({study: deck})}`;

function counts(c: DeckCounts) {
  return h(
    'span',
    {class: 'study-counts', title: 'New · learning · to review'},
    h('span', {class: 'count-new'}, String(c.new)),
    h('span', {class: 'count-learning'}, String(c.learning)),
    h('span', {class: 'count-review'}, String(c.review)),
  );
}

// ---- deck list ----

export function renderDecks(store: Store, dict: Dict): HTMLElement {
  defaultDeck(store);
  const page = h('div', {class: 'study-page'});
  const draw = () => {
    const decks = store.decks
      .all()
      .sort((a, b) => a.name.localeCompare(b.name));
    const total = buildQueue(store);
    const target = addToDeck(store);
    page.replaceChildren(
      h(
        'div',
        {class: 'study-head'},
        h('h1', null, 'Study'),
        h(
          'div',
          {class: 'deck-option-buttons'},
          h('a', {class: 'button', href: '?study=browse'}, 'Cards'),
          h('a', {class: 'button', href: '?study=stats'}, 'Stats'),
          h('a', {class: 'button', href: '?import'}, 'Import'),
          total.cards.length > 0 &&
            h(
              'a',
              {class: 'button primary', href: studyUrl('all')},
              'Study all',
            ),
        ),
      ),
      h(
        'p',
        {class: 'hint'},
        'Add words with the “study” button on any entry, or import an Anki deck. ',
        'Cards are scheduled with FSRS, the algorithm modern Anki uses.',
      ),
      h(
        'ul',
        {class: 'deck-list'},
        decks.map(d => deckRow(store, dict, d, draw)),
      ),
      h(
        'div',
        {class: 'deck-tools'},
        h(
          'label',
          null,
          'Add new words to ',
          h(
            'select',
            {
              onchange: (e: Event) =>
                setAddToDeck(store, (e.target as HTMLSelectElement).value),
            },
            decks.map(d =>
              h('option', {value: d.id, selected: d.id === target.id}, d.name),
            ),
          ),
        ),
        h(
          'button',
          {
            type: 'button',
            onclick: () => {
              const name = prompt('Name of the new deck?')?.trim();
              if (name) {
                store.decks.put({id: randomId(), name, ...DECK_DEFAULTS});
                draw();
              }
            },
          },
          'New deck',
        ),
      ),
    );
  };
  draw();
  return page;
}

function deckRow(store: Store, dict: Dict, deck: DeckRow, redraw: () => void) {
  const q = buildQueue(store, [deck.id]);
  const size = store.cards.all().filter(c => c.deckId === deck.id).length;
  const options = h('details', {class: 'deck-options'});
  const number = (
    label: string,
    key: 'newPerDay' | 'reviewsPerDay',
    max: number,
  ) =>
    h(
      'label',
      null,
      label,
      h('input', {
        type: 'number',
        min: 0,
        max,
        value: deck[key],
        onchange: (e: Event) => {
          const v = Math.round(Number((e.target as HTMLInputElement).value));
          if (v >= 0 && v <= max)
            store.decks.put({...fieldsOf(deck), [key]: v});
          redraw();
        },
      }),
    );
  options.append(
    h('summary', null, 'Options and export'),
    number('New cards per day ', 'newPerDay', 9999),
    number('Most reviews per day ', 'reviewsPerDay', 99999),
    h(
      'label',
      null,
      'Desired retention ',
      h('input', {
        type: 'number',
        min: 0.7,
        max: 0.99,
        step: 0.01,
        value: deck.retention,
        onchange: (e: Event) => {
          const v = Number((e.target as HTMLInputElement).value);
          if (v >= 0.7 && v <= 0.99) {
            store.decks.put({...fieldsOf(deck), retention: v});
          }
          redraw();
        },
      }),
      h(
        'span',
        {class: 'hint'},
        ' How likely you are to remember a card when it comes up. Higher means more reviews.',
      ),
    ),
    h(
      'div',
      {class: 'deck-option-buttons'},
      h(
        'button',
        {
          type: 'button',
          onclick: () => {
            const name = prompt('Rename the deck', deck.name)?.trim();
            if (name) store.decks.put({...fieldsOf(deck), name});
            redraw();
          },
        },
        'Rename',
      ),
      deck.id !== 'default' &&
        h(
          'button',
          {
            type: 'button',
            class: 'danger',
            onclick: () => {
              if (
                !confirm(
                  `Delete “${deck.name}” and its ${size} cards? Their review history is kept.`,
                )
              ) {
                return;
              }
              const cards = store.cards.all().filter(c => c.deckId === deck.id);
              store.facts.delete(...new Set(cards.map(c => c.factId)));
              store.cards.delete(...cards.map(c => c.id));
              store.decks.delete(deck.id);
              if (addToDeck(store).id === deck.id)
                setAddToDeck(store, 'default');
              redraw();
            },
          },
          'Delete deck',
        ),
    ),
  );
  options.append(duplicatesSection(store, deck, redraw));
  options.append(exportSection(store, dict, deck, size));
  return h(
    'li',
    {class: 'deck'},
    h(
      'div',
      {class: 'deck-main'},
      h('a', {class: 'deck-name', href: studyUrl(deck.id)}, deck.name),
      h('span', {class: 'hint'}, ` ${size} card${size === 1 ? '' : 's'}`),
      counts(q),
      q.cards.length > 0 &&
        h('a', {class: 'button', href: studyUrl(deck.id)}, 'Study'),
    ),
    options,
  );
}

/**
 * "Find words you already know": the deck's unstudied cards for words you
 * study elsewhere or marked known, and what to do with them.
 */
function duplicatesSection(store: Store, deck: DeckRow, redraw: () => void) {
  const body = h('div', null);
  const find = () => {
    const report = deckDuplicates(store, deck.id);
    const n = report.studied.size + report.known.size;
    if (!n) {
      body.replaceChildren(
        h(
          'p',
          {class: 'hint'},
          'None of this deck’s new cards are words you already study or marked known.',
        ),
      );
      return;
    }
    let dupChoice: DuplicateChoice = 'copy';
    const choice = (value: DuplicateChoice, label: string) =>
      h(
        'label',
        {class: 'setting'},
        h('input', {
          type: 'radio',
          name: `dups-${deck.id}`,
          checked: value === dupChoice,
          onchange: () => (dupChoice = value),
        }),
        h('span', null, label),
      );
    body.replaceChildren(
      h(
        'p',
        null,
        [
          report.studied.size &&
            `${report.studied.size} new card${report.studied.size === 1 ? ' is a word' : 's are words'} you study in other cards`,
          report.known.size &&
            `${report.known.size} ${report.known.size === 1 ? 'is a word' : 'are words'} you marked known`,
        ]
          .filter(Boolean)
          .join(', and ') + '.',
      ),
      report.studied.size > 0
        ? h(
            'div',
            {class: 'import-choices'},
            choice('copy', 'Give them your schedule for the word'),
            choice('suspend', 'Suspend them'),
          )
        : '',
      report.known.size > 0
        ? h('p', {class: 'hint'}, 'Words marked known are suspended.')
        : '',
      h(
        'button',
        {
          type: 'button',
          onclick: () => {
            const changed = applyDeckDuplicates(
              store,
              report,
              dupChoice,
              'suspend',
            );
            redraw();
            body.replaceChildren(
              h(
                'p',
                {class: 'hint'},
                `Done: ${changed} card${changed === 1 ? '' : 's'} changed.`,
              ),
            );
          },
        },
        'Apply',
      ),
    );
  };
  body.append(
    h('button', {type: 'button', onclick: find}, 'Find words you already know'),
  );
  return h(
    'div',
    {class: 'deck-duplicates'},
    h('h3', null, 'Duplicates'),
    body,
  );
}

function skippedNote(n: number) {
  return n
    ? ` ${n} note${n === 1 ? '' : 's'} from imported decks ${n === 1 ? 'was' : 'were'} left out: exporting those isn’t supported yet.`
    : '';
}

/** Download the deck as an .apkg, or send it to Anki through AnkiConnect. */
function exportSection(store: Store, dict: Dict, deck: DeckRow, size: number) {
  const status = h('p', {class: 'export-status hint'});
  const run = async (work: () => Promise<string>) => {
    status.classList.remove('error');
    try {
      status.textContent = await work();
    } catch (e) {
      status.textContent = (e as Error).message;
      status.classList.add('error');
    }
  };
  const fileName = `${deck.name.replace(/[\\/:*?"<>|]+/g, '_')}.apkg`;
  return h(
    'div',
    {class: 'deck-export'},
    h('h3', null, 'Export to Anki'),
    h(
      'div',
      {class: 'deck-option-buttons'},
      h(
        'button',
        {
          type: 'button',
          disabled: size === 0,
          onclick: () =>
            void run(async () => {
              status.textContent = 'Making the file…';
              const {exportApkg, download} = await import('./export.ts');
              const {blob, skipped} = await exportApkg(store, dict, deck);
              download(blob, fileName);
              return (
                `Saved ${fileName}. Open it with Anki (File → Import) to add the deck, with its schedule and review history.` +
                skippedNote(skipped)
              );
            }),
        },
        'Download .apkg',
      ),
      h(
        'button',
        {
          type: 'button',
          disabled: size === 0,
          onclick: () =>
            void run(async () => {
              const [
                {sendToAnki},
                {AnkiConnect, AnkiUnreachable},
                {loadSettings},
              ] = await Promise.all([
                import('./export.ts'),
                import('../anki/connect.ts'),
                import('../anki/settings.ts'),
              ]);
              const settings = loadSettings();
              const anki = new AnkiConnect(settings.url, settings.apiKey);
              try {
                const r = await sendToAnki(anki, store, dict, deck, text => {
                  status.textContent = text;
                });
                return (
                  `Done: ${r.added} added and ${r.updated} updated in Anki's “${deck.name}” deck` +
                  (r.failed ? `, ${r.failed} couldn't be added.` : '.') +
                  skippedNote(r.skipped)
                );
              } catch (e) {
                if (e instanceof AnkiUnreachable) {
                  throw new Error(
                    'Couldn’t reach Anki. Open Anki (with the AnkiConnect add-on), and connect it in Settings → Anki.',
                  );
                }
                throw e;
              }
            }),
        },
        'Send to Anki',
      ),
    ),
    h(
      'p',
      {class: 'hint'},
      'The file keeps each card’s schedule and review history. Sending through AnkiConnect adds the words and their due dates.',
    ),
    status,
  );
}

// ---- a session ----

/** Reviews the due cards of a deck (or all decks) until none are left. */
export function renderSession(
  store: Store,
  dict: Dict,
  deck: string,
): HTMLElement {
  const deckIds = deck === 'all' ? undefined : [deck];
  const deckName =
    deck === 'all' ? 'All decks' : (store.decks.get(deck)?.name ?? 'Deck');
  const page = h('div', {class: 'study-session'});
  let last: string | undefined;
  /** what the keyboard does now */
  let keys: (e: KeyboardEvent) => void = () => {};

  const onKey = (e: KeyboardEvent) => {
    if (!page.isConnected) {
      document.removeEventListener('keydown', onKey);
      return;
    }
    const t = e.target as HTMLElement;
    if (
      t.closest('input, textarea, select') ||
      e.metaKey ||
      e.ctrlKey ||
      e.altKey
    ) {
      return;
    }
    keys(e);
  };
  document.addEventListener('keydown', onKey);
  // The search box has focus on load; keys are for the cards here.
  (document.activeElement as HTMLElement | null)?.blur();

  const next = () => {
    const now = Date.now();
    const q = buildQueue(store, deckIds, now);
    // Don't show the card just answered again if there's another.
    const card =
      q.cards.find(c => c.id !== last && c.due <= now + 1000) ??
      q.cards.find(c => c.id !== last) ??
      q.cards[0];
    if (!card) {
      done();
      return;
    }
    void show(card, q);
  };

  const header = (q: DeckCounts) =>
    h(
      'div',
      {class: 'session-head'},
      h('a', {href: '?study', class: 'session-back'}, '← Decks'),
      h('span', {class: 'session-deck'}, deckName),
      counts(q),
    );

  /** An imported card's two sides, drawn from its note type's template. */
  const importedCard = (card: CardRow) => {
    const fact = store.facts.get(card.factId)!;
    const nt = store.noteTypes.get(fact.noteType);
    const tmpl = nt
      ? nt.kind === 'cloze'
        ? nt.templates[0]
        : (nt.templates[card.ord] ?? nt.templates[0])
      : undefined;
    if (!nt || !tmpl) return undefined;
    const ctx = {
      fields: Object.fromEntries(
        nt.fields.map((f, i) => [f, fact.fields[i] ?? '']),
      ),
      tags: fact.tags,
      deck: store.decks.get(card.deckId)?.name ?? '',
      noteType: nt.name,
      cardName: tmpl.name,
      ord: card.ord,
    };
    const frontHtml = renderTemplate(tmpl.front, {...ctx, side: 'front'});
    const backHtml = renderTemplate(tmpl.back, {
      ...ctx,
      side: 'back',
      frontSide: frontHtml,
    });
    return {
      front: cardFrame(store, frontHtml, nt.css, card.ord),
      back: cardFrame(store, backHtml, nt.css, card.ord),
    };
  };

  const show = async (card: CardRow, q: DeckCounts) => {
    const fact = store.facts.get(card.factId);
    const entry = fact?.wordId ? await dict.entry(fact.wordId) : undefined;
    const word = fact?.fields[0] ?? '?';
    const reading = fact?.fields[1] || undefined;
    const shownAt = Date.now();

    // A card from an imported deck is drawn with its own template.
    const imported =
      fact && fact.noteType !== NOTE_TYPE ? importedCard(card) : undefined;
    const front = imported
      ? await imported.front
      : h('div', {class: 'card-front', lang: 'ja'}, word);
    const backSide = async () => {
      if (!imported) {
        return [
          h(
            'div',
            {class: 'card-front revealed'},
            rubyWord({text: word, ...(reading && {reading})}),
          ),
          h(
            'div',
            {class: 'card-back'},
            entry
              ? renderEntry(dict, {entry})
              : h('p', {class: 'card-meaning'}, fact?.fields[2] ?? ''),
          ),
        ];
      }
      const head = entry && headword(entry);
      return [
        await imported.back,
        head &&
          h(
            'p',
            {class: 'card-word-link hint'},
            'In the dictionary: ',
            h(
              'a',
              {href: `?${new URLSearchParams({q: head.text})}`},
              rubyWord(head),
            ),
          ),
      ];
    };
    let revealing = false;
    const reveal = async () => {
      if (revealing) return;
      revealing = true;
      const now = Date.now();
      const due = preview(card, store.decks.get(card.deckId), now);
      const rate = (grade: Grade) => {
        answer(store, card, grade, Date.now(), Date.now() - shownAt);
        last = card.id;
        next();
      };
      keys = e => {
        const r = RATINGS.find(r => r.key === e.key);
        if (r) rate(r.grade);
        else if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          rate(3 as Grade);
        }
      };
      face.replaceChildren(...(await backSide()).filter(n => n !== undefined));
      buttons.replaceChildren(
        ...RATINGS.map(r =>
          h(
            'button',
            {
              type: 'button',
              class: `rate rate-${r.label.toLowerCase()}`,
              onclick: () => rate(r.grade),
              title: `${r.label} (${r.key})`,
            },
            h(
              'span',
              {class: 'rate-interval'},
              formatInterval(due.get(r.grade)! - now),
            ),
            h('span', {class: 'rate-label'}, r.label),
          ),
        ),
      );
    };
    keys = e => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        void reveal();
      }
    };
    const face = h('div', {class: 'card-face'}, front);
    const buttons = h(
      'div',
      {class: 'card-buttons'},
      h(
        'button',
        {
          type: 'button',
          class: 'primary show-answer',
          onclick: () => void reveal(),
        },
        'Show answer',
      ),
    );
    page.replaceChildren(header(q), face, buttons);
  };

  const done = () => {
    keys = () => {};
    const upcoming = store.cards
      .all()
      .filter(c => (!deckIds || deckIds.includes(c.deckId)) && c.reps > 0)
      .sort((a, b) => a.due - b.due)[0];
    page.replaceChildren(
      header({new: 0, learning: 0, review: 0}),
      h(
        'div',
        {class: 'session-done'},
        h('h2', null, 'All done for now'),
        upcoming &&
          h(
            'p',
            null,
            `The next card is due in ${formatInterval(Math.max(0, upcoming.due - Date.now()))}.`,
          ),
        h('a', {class: 'button', href: '?study'}, 'Back to decks'),
      ),
    );
  };

  next();
  return page;
}
