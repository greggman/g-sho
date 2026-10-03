/**
 * The import page (?import): an Anki deck (.apkg / .colpkg) or plain text
 * from a file, a drop, or a paste; a preview with the fields that hold each
 * note type's word and reading; then the import.
 */
import type {Dict} from '../dict.ts';
import {h} from '../dom.ts';
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

export const IMPORTABLE = /\.(apkg|colpkg|txt|tsv|csv)$/i;

/** Reads a package in the import worker. */
function readPackage(file: File): Promise<AnkiCollection> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('import-worker.js', document.baseURI), {
      type: 'module',
    });
    worker.onmessage = (
      e: MessageEvent<{collection?: AnkiCollection; error?: string}>,
    ) => {
      worker.terminate();
      if (e.data.collection) resolve(e.data.collection);
      else reject(new Error(e.data.error ?? 'Couldn’t read the file.'));
    };
    worker.onerror = e => {
      worker.terminate();
      reject(new Error(e.message || 'Couldn’t read the file.'));
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
      placeholder:
        'Or paste Anki’s plain-text export, or lines of “word<Tab>meaning”',
    });
    page.replaceChildren(
      h(
        'div',
        {class: 'study-head'},
        h('h1', null, 'Import'),
        h('a', {href: '?study'}, '← Decks'),
      ),
      h(
        'p',
        null,
        'Bring in an Anki deck: one you exported, or a shared deck from ',
        h(
          'a',
          {
            href: 'https://ankiweb.net/shared/decks',
            target: '_blank',
            rel: 'noopener',
          },
          'AnkiWeb',
        ),
        '. Choose the .apkg file, drop it anywhere on this site, or paste a copied file.',
      ),
      h(
        'label',
        {class: 'button primary import-pick'},
        'Choose a file…',
        input,
      ),
      text,
      h(
        'button',
        {
          type: 'button',
          onclick: () => {
            if (text.value.trim())
              preview(readAnkiText(text.value), 'Pasted text');
          },
        },
        'Import the text',
      ),
      status,
    );
  };

  const load = async (f: File) => {
    page.replaceChildren(
      h('h1', null, 'Import'),
      h('p', null, `Reading ${f.name}…`),
    );
    try {
      const col = /\.(apkg|colpkg)$/i.test(f.name)
        ? await readPackage(f)
        : readAnkiText(await f.text(), f.name.replace(/\.\w+$/, ''));
      preview(col, f.name);
    } catch (e) {
      choose();
      status.textContent = `Couldn’t read ${f.name}: ${(e as Error).message}`;
      status.classList.add('error');
    }
  };

  const preview = (col: AnkiCollection, name: string) => {
    if (!col.notes.length) {
      choose();
      status.textContent = `${name} has no notes in it.`;
      status.classList.add('error');
      return;
    }
    const used = new Set(col.notes.map(n => n.noteTypeId));
    const types = col.noteTypes.filter(t => used.has(t.ankiId));
    const decks = col.decks
      .map(d => ({
        name: d.name,
        cards: col.cards.filter(c => c.deckId === d.ankiId).length,
      }))
      .filter(d => d.cards > 0);
    const studied = col.cards.filter(c => c.type !== 0).length;
    const linkFields = new Map<number, LinkFields>(
      types.map(t => [t.ankiId, guessLinkFields(t.fields)]),
    );
    const keep = h('input', {type: 'checkbox', checked: studied > 0});

    const typeRow = (t: (typeof types)[number]) => {
      const sample = col.notes.find(n => n.noteTypeId === t.ankiId)!;
      const example = h('span', {class: 'hint'});
      const showExample = () => {
        const w = noteWord(sample.fields, linkFields.get(t.ankiId)!);
        example.textContent = w.text
          ? ` e.g. ${w.text}${w.reading ? ` (${w.reading})` : ''}`
          : '';
      };
      const select = (key: keyof LinkFields, none: boolean) =>
        h(
          'select',
          {
            onchange: (e: Event) => {
              const v = Number((e.target as HTMLSelectElement).value);
              linkFields.set(t.ankiId, {
                ...linkFields.get(t.ankiId)!,
                [key]: v,
              });
              showExample();
            },
          },
          none && h('option', {value: -1}, '(none)'),
          t.fields.map((f, i) =>
            h(
              'option',
              {value: i, selected: linkFields.get(t.ankiId)![key] === i},
              f,
            ),
          ),
        );
      showExample();
      return h(
        'li',
        null,
        h('strong', null, t.name),
        ` (${col.notes.filter(n => n.noteTypeId === t.ankiId).length} notes)`,
        h(
          'div',
          {class: 'import-fields'},
          h('label', null, 'Word ', select('word', false)),
          h('label', null, 'Reading ', select('reading', true)),
          example,
        ),
      );
    };

    page.replaceChildren(
      h(
        'div',
        {class: 'study-head'},
        h('h1', null, 'Import'),
        h('a', {href: '?import'}, 'Cancel'),
      ),
      h(
        'p',
        null,
        h('strong', null, name),
        `: ${col.notes.length} notes, ${col.cards.length} cards`,
        col.media.length ? `, ${col.media.length} images and sounds` : '',
        '.',
      ),
      h('h3', null, 'Decks'),
      h(
        'ul',
        null,
        decks.map(d => h('li', null, `${d.name} — ${d.cards} cards`)),
      ),
      h('h3', null, 'Which fields hold the word?'),
      h(
        'p',
        {class: 'hint'},
        'Each note is linked to its dictionary entry, so you can look it up and later skip words you already know.',
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
              `Keep the schedule and review history (${studied} cards have been studied)`,
            ),
          )
        : '',
      col.media.length > 0
        ? h(
            'p',
            {class: 'hint'},
            'Images and sounds are kept on this device only (they don’t sync yet).',
          )
        : '',
      h(
        'p',
        {class: 'hint'},
        'Notes you imported before are updated, and your progress on them is kept.',
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'primary',
          onclick: () =>
            void prepare(col, {keepScheduling: keep.checked, linkFields}),
        },
        'Continue',
      ),
      status,
    );
  };

  /** Links the notes and finds duplicates, then asks what to do with them. */
  const prepare = async (col: AnkiCollection, options: ImportOptions) => {
    page.replaceChildren(h('h1', null, 'Import'), status);
    status.classList.remove('error');
    try {
      const prepared = await prepareImport(store, dict, col, options, text => {
        status.textContent = text;
      });
      status.textContent = '';
      chooseDuplicates(prepared);
    } catch (e) {
      console.error(e);
      status.textContent = `The import failed: ${(e as Error).message}`;
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
        h('h1', null, 'Import'),
        h('a', {href: '?import'}, 'Cancel'),
      ),
      h(
        'p',
        null,
        `${r.added} new notes` +
          (r.updated
            ? ` and ${r.updated} already here (they’ll be updated)`
            : '') +
          `, ${r.cards} new cards. ${r.linked} of ${total} notes are linked to dictionary words.`,
      ),
      h('h3', null, 'Words you already know'),
      d.studied.size === 0 && d.known.size === 0
        ? h(
            'p',
            null,
            'None of the new cards are words you already study or marked known.',
          )
        : '',
      d.studied.size > 0
        ? h(
            'div',
            null,
            h(
              'p',
              null,
              `${d.studied.size} new card${d.studied.size === 1 ? ' is a word' : 's are words'} you already study (asked the same way):`,
            ),
            radios<DuplicateChoice>(
              'dups',
              [
                [
                  'copy',
                  'Give them your schedule for the word, so they come up when you’d review it anyway',
                ],
                ['suspend', 'Suspend them (you can unsuspend later)'],
                ['keep', 'Study them as new'],
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
              `${d.known.size} new card${d.known.size === 1 ? ' is a word' : 's are words'} you marked known:`,
            ),
            radios<KnownChoice>(
              'known',
              [
                ['suspend', 'Suspend them'],
                ['keep', 'Study them anyway'],
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
            `${d.repeats} card${d.repeats === 1 ? ' repeats a word' : 's repeat words'} that come earlier in this deck.`,
          )
        : '',
      h(
        'button',
        {
          type: 'button',
          class: 'primary',
          onclick: () => void commit(prepared, choices),
        },
        'Import',
      ),
      status,
    );
  };

  const commit = async (
    prepared: PreparedImport,
    choices: DuplicateChoices,
  ) => {
    page.replaceChildren(h('h1', null, 'Import'), status);
    status.classList.remove('error');
    try {
      const r = await commitImport(store, prepared, choices, text => {
        status.textContent = text;
      });
      const first = store.decks.all().find(d => d.name === r.decks[0]);
      const handled =
        prepared.duplicates.studied.size + prepared.duplicates.known.size;
      page.replaceChildren(
        h('h1', null, 'Imported'),
        h(
          'p',
          null,
          `${r.added} new notes` +
            (r.updated ? ` and ${r.updated} updated` : '') +
            `, ${r.cards} new cards, in ${r.decks.join(', ')}.`,
        ),
        handled
          ? h(
              'p',
              null,
              `${handled} card${handled === 1 ? ' was a word' : 's were words'} you already know.`,
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
                'Study it',
              )
            : '',
          h('a', {class: 'button', href: '?study'}, 'All decks'),
          h('a', {class: 'button', href: '?import'}, 'Import another'),
        ),
      );
    } catch (e) {
      console.error(e);
      status.textContent = `The import failed: ${(e as Error).message}`;
      status.classList.add('error');
    }
  };

  if (file) void load(file);
  else choose();
  return page;
}
