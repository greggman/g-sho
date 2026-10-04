/**
 * Definitions in Japanese (国語), from the Japanese Wiktionary, for when a
 * learner moves on to a Japanese–Japanese dictionary. Shown when the
 * "Japanese definitions" display setting is on.
 *
 * Entries get an empty placeholder when drawn; fillJapanese() loads and
 * shows the definitions. Each definition is first shown as plain text, then
 * split into words (like a pasted sentence): every word links to its own
 * entry, with furigana over its kanji, so the definitions themselves can be
 * read.
 */
import type {JaDefinition} from '../shared/types.ts';
import type {Dict} from './dict.ts';
import {h} from './dom.ts';
import {surfaceFurigana} from './forms.ts';
import {isKanji} from '../shared/kana.ts';
import {segment, sentenceMatches} from './search.ts';

/** How many senses a sentence's compact word card shows. */
const COMPACT_SENSES = 2;

/** Where an entry's Japanese definitions go (hidden while the setting is off). */
export function jaDefinitionsSlot(
  entryId: number,
  compact = false,
): HTMLElement {
  return h('section', {
    class: compact ? 'ja-defs compact' : 'ja-defs',
    lang: 'ja',
    'data-entry': entryId,
  });
}

export const japaneseOn = () =>
  document.documentElement.classList.contains('show-japanese');

/** Fills the empty Japanese-definition slots under `root`, if they're on. */
export async function fillJapanese(dict: Dict, root: ParentNode) {
  if (!japaneseOn()) return;
  const slots = [
    ...root.querySelectorAll<HTMLElement>('.ja-defs:not([data-filled])'),
  ];
  for (const slot of slots) slot.dataset.filled = '';
  await Promise.all(
    slots.map(async slot => {
      const defs = await dict
        .jaDefinitions(Number(slot.dataset.entry))
        .catch(() => undefined);
      render(slot, defs);
    }),
  );
  // Then, one at a time, turn the text into linked words with furigana.
  for (const el of root.querySelectorAll<HTMLElement>(
    '.ja-text:not([data-linked])',
  )) {
    el.dataset.linked = '';
    await linkWords(dict, el).catch(() => {});
  }
}

function text(s: string, hints?: [string, string][]) {
  return h(
    'span',
    {
      class: 'ja-text',
      ...(hints?.length && {'data-hints': JSON.stringify(hints)}),
    },
    s,
  );
}

function render(slot: HTMLElement, defs: JaDefinition[] | undefined) {
  const compact = slot.classList.contains('compact');
  if (!defs?.length) {
    slot.replaceChildren(
      compact
        ? ''
        : h(
            'p',
            {class: 'ja-none'},
            'ウィクショナリーにこの語の定義はありません。',
          ),
    );
    return;
  }
  const shown = compact ? defs.slice(0, 1) : defs;
  slot.replaceChildren(
    compact
      ? ''
      : h(
          'h3',
          {class: 'ja-defs-title'},
          '国語',
          h('span', {class: 'ja-source'}, 'ウィクショナリー'),
        ),
    ...shown.map(d =>
      h(
        'div',
        {class: 'ja-def'},
        d.p && h('span', {class: 'ja-pos'}, d.p),
        h(
          'ol',
          {class: 'ja-senses'},
          (compact ? d.s.slice(0, COMPACT_SENSES) : d.s).map(s =>
            h(
              'li',
              null,
              s.t?.length
                ? h(
                    'span',
                    {class: 'ja-tags'},
                    s.t.map(t => `〔${t}〕`).join(''),
                  )
                : '',
              text(s.g, s.r),
              !compact &&
                !!s.ex?.length &&
                h(
                  'ul',
                  {class: 'ja-examples'},
                  s.ex!.map(e => h('li', null, text(e))),
                ),
            ),
          ),
        ),
      ),
    ),
  );
}

/** Replaces the element's text with its words, linked, with furigana. */
async function linkWords(dict: Dict, el: HTMLElement) {
  const source = el.textContent ?? '';
  const hints = new Map<string, string>(
    el.dataset.hints
      ? (JSON.parse(el.dataset.hints) as [string, string][])
      : [],
  );
  const tokens = await segment(dict, source);
  const parts: (Node | string)[] = [];
  for (const t of tokens) {
    if (!t.known) {
      parts.push(t.text);
      continue;
    }
    const query = t.base ?? t.text;
    let word: (Node | string)[] = [t.text];
    if (Array.from(t.text).some(isKanji)) {
      const hint = hints.get(t.text);
      if (hint) {
        word = [h('ruby', null, t.text, h('rt', null, hint))];
      } else {
        const entry = (await sentenceMatches(dict, t))[0]?.entry;
        if (entry) {
          word = surfaceFurigana(t.text, entry, query).map(([s, rt]) =>
            rt ? h('ruby', null, s, h('rt', null, rt)) : s,
          );
        }
      }
    }
    parts.push(
      h(
        'a',
        {class: 'ja-word', href: `?${new URLSearchParams({q: query})}`},
        ...word,
      ),
    );
  }
  // Only if nothing changed the text meanwhile.
  if (el.textContent === source) el.replaceChildren(...parts);
}
