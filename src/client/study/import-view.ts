/**
 * The import page (?import): an Anki deck (.apkg / .colpkg) or plain text
 * from a file, a drop, or a paste; a preview with the fields that hold each
 * note type's word and reading; then the import.
 */
import type {Dict} from '../dict.ts';
import {h} from '../dom.ts';
import {language, t} from '../i18n.ts';
import {NOT_A_PACKAGE} from '../anki/import/errors.ts';
import {
  DEFAULT_CHOICES,
  commitImport,
  prepareImport,
  type DuplicateChoices,
  type ImportOptions,
  type PreparedImport,
} from '../anki/import/apply.ts';
import type {DuplicateChoice, KnownChoice} from './duplicates.ts';
import {
  guessLinkFields,
  noteWord,
  type LinkFields,
} from '../anki/import/link.ts';
import type {AnkiCollection} from '../anki/import/read.ts';
import {readAnkiText} from '../anki/import/read-text.ts';
import type {Store} from '../store/store.ts';
import {trackWorker} from '../versions.ts';

export const IMPORTABLE = /\.(apkg|colpkg|txt|tsv|csv)$/i;

/** Reads a package in the import worker. */
function readPackage(file: File): Promise<AnkiCollection> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('import-worker.js', document.baseURI), {
      type: 'module',
    });
    trackWorker(t('Anki import'), worker);
    worker.onmessage = (
      e: MessageEvent<{collection?: AnkiCollection; error?: string}>,
    ) => {
      worker.terminate();
      if (e.data.collection) resolve(e.data.collection);
      else if (e.data.error === NOT_A_PACKAGE) {
        reject(
          new Error(t('This isn’t an Anki package (no collection inside).')),
        );
      } else reject(new Error(e.data.error ?? t('Couldn’t read the file.')));
    };
    worker.onerror = e => {
      worker.terminate();
      reject(new Error(e.message || t('Couldn’t read the file.')));
    };
    void file.arrayBuffer().then(b => worker.postMessage(b, [b]));
  });
}

export function renderImport(
  store: Store,
  dict: Dict,
  file?: File,
): HTMLElement {
  const page = h('div', {class: 'study-page import-page'});
  const status = h('p', {class: 'import-status'});

  const choose = () => {
    const input = h('input', {
      type: 'file',
      accept: '.apkg,.colpkg,.txt,.tsv,.csv',
      onchange: () => {
        const f = input.files?.[0];
        if (f) void load(f);
      },
    });
    const text = h('textarea', {
      class: 'import-text',
      rows: 6,
      placeholder: t(
        'Or paste Anki’s plain-text export, or lines of “word<Tab>meaning”',
      ),
    });
    page.replaceChildren(
      h(
        'div',
        {class: 'study-head'},
        h('h1', null, t('Import')),
        h('a', {href: '?study'}, t('← Decks')),
      ),
      h(
        'p',
        null,
        t('Bring in an Anki deck: one you exported, or a shared deck from '),
        h(
          'a',
          {
            href: 'https://ankiweb.net/shared/decks',
            target: '_blank',
            rel: 'noopener',
          },
          'AnkiWeb',
        ),
        t(
          '. Choose the .apkg file, drop it anywhere on this site, or paste a copied file.',
        ),
      ),
      h(
        'label',
        {class: 'button primary import-pick'},
        t('Choose a file…'),
        input,
      ),
      text,
      h(
        'button',
        {
          type: 'button',
          onclick: () => {
            if (text.value.trim())
              preview(readAnkiText(text.value), t('Pasted text'));
          },
        },
        t('Import the text'),
      ),
      status,
    );
  };

  const load = async (f: File) => {
    page.replaceChildren(
      h('h1', null, t('Import')),
      h('p', null, t('Reading {file}…', {file: f.name})),
    );
    try {
      const col = /\.(apkg|colpkg)$/i.test(f.name)
        ? await readPackage(f)
        : readAnkiText(await f.text(), f.name.replace(/\.\w+$/, ''));
      preview(col, f.name);
    } catch (e) {
      choose();
      status.textContent = t('Couldn’t read {file}: {error}', {
        file: f.name,
        error: (e as Error).message,
      });
      status.classList.add('error');
    }
  };

  const preview = (col: AnkiCollection, name: string) => {
    if (!col.notes.length) {
      choose();
      status.textContent = t('{name} has no notes in it.', {name});
      status.classList.add('error');
      return;
    }
    const used = new Set(col.notes.map(n => n.noteTypeId));
    const types = col.noteTypes.filter(nt => used.has(nt.ankiId));
    const decks = col.decks
      .map(d => ({
        name: d.name,
        cards: col.cards.filter(c => c.deckId === d.ankiId).length,
      }))
      .filter(d => d.cards > 0);
    const studied = col.cards.filter(c => c.type !== 0).length;
    const linkFields = new Map<number, LinkFields>(
      types.map(nt => [nt.ankiId, guessLinkFields(nt.fields)]),
    );
    const keep = h('input', {type: 'checkbox', checked: studied > 0});

    const typeRow = (nt: (typeof types)[number]) => {
      const sample = col.notes.find(n => n.noteTypeId === nt.ankiId)!;
      const example = h('span', {class: 'hint'});
      const showExample = () => {
        const w = noteWord(sample.fields, linkFields.get(nt.ankiId)!);
        example.textContent = !w.text
          ? ''
          : w.reading
            ? t(' e.g. {word} ({reading})', {word: w.text, reading: w.reading})
            : t(' e.g. {word}', {word: w.text});
      };
      const select = (key: keyof LinkFields, none: boolean) =>
        h(
          'select',
          {
            onchange: (e: Event) => {
              const v = Number((e.target as HTMLSelectElement).value);
              linkFields.set(nt.ankiId, {
                ...linkFields.get(nt.ankiId)!,
                [key]: v,
              });
              showExample();
            },
          },
          none && h('option', {value: -1}, t('(none)')),
          nt.fields.map((f, i) =>
            h(
              'option',
              {value: i, selected: linkFields.get(nt.ankiId)![key] === i},
              f,
            ),
          ),
        );
      showExample();
      return h(
        'li',
        null,
        h('strong', null, nt.name),
        t(' ({n} notes)', {
          n: col.notes.filter(n => n.noteTypeId === nt.ankiId).length,
        }),
        h(
          'div',
          {class: 'import-fields'},
          h('label', null, t('Word '), select('word', false)),
          h('label', null, t('Reading '), select('reading', true)),
          example,
        ),
      );
    };

    page.replaceChildren(
      h(
        'div',
        {class: 'study-head'},
        h('h1', null, t('Import')),
        h('a', {href: '?import'}, t('Cancel')),
      ),
      h(
        'p',
        null,
        h('strong', null, name),
        col.media.length
          ? t(': {notes} notes, {cards} cards, {media} images and sounds.', {
              notes: col.notes.length,
              cards: col.cards.length,
              media: col.media.length,
            })
          : t(': {notes} notes, {cards} cards.', {
              notes: col.notes.length,
              cards: col.cards.length,
            }),
      ),
      h('h3', null, t('Decks')),
      h(
        'ul',
        null,
        decks.map(d =>
          h('li', null, t('{name} — {n} cards', {name: d.name, n: d.cards})),
        ),
      ),
      h('h3', null, t('Which fields hold the word?')),
      h(
        'p',
        {class: 'hint'},
        t(
          'Each note is linked to its dictionary entry, so you can look it up and later skip words you already know.',
        ),
      ),
      h('ul', {class: 'import-types'}, types.map(typeRow)),
      studied > 0
        ? h(
            'label',
            {class: 'setting'},
            keep,
            h(
              'span',
              null,
              t(
                'Keep the schedule and review history ({n} cards have been studied)',
                {n: studied},
              ),
            ),
          )
        : '',
      col.media.length > 0
        ? h(
            'p',
            {class: 'hint'},
            t(
              'Images and sounds are kept on this device only (they don’t sync yet).',
            ),
          )
        : '',
      h(
        'p',
        {class: 'hint'},
        t(
          'Notes you imported before are updated, and your progress on them is kept.',
        ),
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'primary',
          onclick: () =>
            void prepare(col, {keepScheduling: keep.checked, linkFields}),
        },
        t('Continue'),
      ),
      status,
    );
  };

  /** Links the notes and finds duplicates, then asks what to do with them. */
  const prepare = async (col: AnkiCollection, options: ImportOptions) => {
    page.replaceChildren(h('h1', null, t('Import')), status);
    status.classList.remove('error');
    try {
      const prepared = await prepareImport(store, dict, col, options, text => {
        status.textContent = text;
      });
      status.textContent = '';
      chooseDuplicates(prepared);
    } catch (e) {
      console.error(e);
      status.textContent = t('The import failed: {error}', {
        error: (e as Error).message,
      });
      status.classList.add('error');
    }
  };

  const radios = <T extends string>(
    name: string,
    options: [T, string][],
    initial: T,
    onChange: (v: T) => void,
  ) =>
    h(
      'div',
      {class: 'import-choices'},
      options.map(([value, label]) =>
        h(
          'label',
          {class: 'setting'},
          h('input', {
            type: 'radio',
            name,
            value,
            checked: value === initial,
            onchange: () => onChange(value),
          }),
          h('span', null, label),
        ),
      ),
    );

  const chooseDuplicates = (prepared: PreparedImport) => {
    const {summary: r, duplicates: d} = prepared;
    const choices: DuplicateChoices = {...DEFAULT_CHOICES};
    const total = r.added + r.updated;
    page.replaceChildren(
      h(
        'div',
        {class: 'study-head'},
        h('h1', null, t('Import')),
        h('a', {href: '?import'}, t('Cancel')),
      ),
      h(
        'p',
        null,
        r.updated
          ? t(
              '{added} new notes and {updated} already here (they’ll be updated), {cards} new cards. {linked} of {total} notes are linked to dictionary words.',
              {
                added: r.added,
                updated: r.updated,
                cards: r.cards,
                linked: r.linked,
                total,
              },
            )
          : t(
              '{added} new notes, {cards} new cards. {linked} of {total} notes are linked to dictionary words.',
              {added: r.added, cards: r.cards, linked: r.linked, total},
            ),
      ),
      h('h3', null, t('Words you already know')),
      d.studied.size === 0 && d.known.size === 0
        ? h(
            'p',
            null,
            t(
              'None of the new cards are words you already study or marked known.',
            ),
          )
        : '',
      d.studied.size > 0
        ? h(
            'div',
            null,
            h(
              'p',
              null,
              d.studied.size === 1
                ? t(
                    '{n} new card is a word you already study (asked the same way):',
                    {n: d.studied.size},
                  )
                : t(
                    '{n} new cards are words you already study (asked the same way):',
                    {n: d.studied.size},
                  ),
            ),
            radios<DuplicateChoice>(
              'dups',
              [
                [
                  'copy',
                  t(
                    'Give them your schedule for the word, so they come up when you’d review it anyway',
                  ),
                ],
                ['suspend', t('Suspend them (you can unsuspend later)')],
                ['keep', t('Study them as new')],
              ],
              choices.duplicates,
              v => (choices.duplicates = v),
            ),
          )
        : '',
      d.known.size > 0
        ? h(
            'div',
            null,
            h(
              'p',
              null,
              d.known.size === 1
                ? t('{n} new card is a word you marked known:', {
                    n: d.known.size,
                  })
                : t('{n} new cards are words you marked known:', {
                    n: d.known.size,
                  }),
            ),
            radios<KnownChoice>(
              'known',
              [
                ['suspend', t('Suspend them')],
                ['keep', t('Study them anyway')],
              ],
              choices.known,
              v => (choices.known = v),
            ),
          )
        : '',
      d.repeats > 0
        ? h(
            'p',
            {class: 'hint'},
            d.repeats === 1
              ? t('{n} card repeats a word that come earlier in this deck.', {
                  n: d.repeats,
                })
              : t('{n} cards repeat words that come earlier in this deck.', {
                  n: d.repeats,
                }),
          )
        : '',
      h(
        'button',
        {
          type: 'button',
          class: 'primary',
          onclick: () => void commit(prepared, choices),
        },
        t('Import'),
      ),
      status,
    );
  };

  const commit = async (
    prepared: PreparedImport,
    choices: DuplicateChoices,
  ) => {
    page.replaceChildren(h('h1', null, t('Import')), status);
    status.classList.remove('error');
    try {
      const r = await commitImport(store, prepared, choices, text => {
        status.textContent = text;
      });
      const first = store.decks.all().find(d => d.name === r.decks[0]);
      const handled =
        prepared.duplicates.studied.size + prepared.duplicates.known.size;
      const decks = r.decks.join(language === 'ja' ? '、' : ', ');
      page.replaceChildren(
        h('h1', null, t('Imported')),
        h(
          'p',
          null,
          r.updated
            ? t(
                '{added} new notes and {updated} updated, {cards} new cards, in {decks}.',
                {added: r.added, updated: r.updated, cards: r.cards, decks},
              )
            : t('{added} new notes, {cards} new cards, in {decks}.', {
                added: r.added,
                cards: r.cards,
                decks,
              }),
        ),
        handled
          ? h(
              'p',
              null,
              handled === 1
                ? t('{n} card was a word you already know.', {n: handled})
                : t('{n} cards were words you already know.', {n: handled}),
            )
          : '',
        h(
          'div',
          {class: 'deck-option-buttons'},
          first
            ? h(
                'a',
                {
                  class: 'button primary',
                  href: `?${new URLSearchParams({study: first.id})}`,
                },
                t('Study it'),
              )
            : '',
          h('a', {class: 'button', href: '?study'}, t('All decks')),
          h('a', {class: 'button', href: '?import'}, t('Import another')),
        ),
      );
    } catch (e) {
      console.error(e);
      status.textContent = t('The import failed: {error}', {
        error: (e as Error).message,
      });
      status.classList.add('error');
    }
  };

  if (file) void load(file);
  else choose();
  return page;
}
