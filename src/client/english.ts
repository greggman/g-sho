/**
 * English words explained in Japanese (英和): looked up when you search in
 * English, and shown above the Japanese words when "Japanese meanings (英和)"
 * is on (html.show-english-japanese; the card is always made, so the setting
 * shows and hides it without a new search).
 *
 * A form is followed to its word ("went" → go, "apples" → apple), from the
 * data; failing that, regular endings are tried ("walked" → walk).
 */
import {hasJapanese} from '../shared/kana.ts';
import type {EnglishEntry} from '../shared/types.ts';
import type {Dict} from './dict.ts';
import {h, searchLink} from './dom.ts';

/** Longest query looked up as an English word or phrase. */
const MAX_WORDS = 4;

export interface EnglishWord {
  word: string;
  entries: EnglishEntry[];
  /** the query is a form of this word */
  base?: boolean;
}

/** "walked" → walk, walke; "stopped" → stop; "cities" → city; … */
export function regularBases(word: string): string[] {
  const out: string[] = [];
  const add = (s: string) => {
    if (s.length > 1 && s !== word && !out.includes(s)) out.push(s);
  };
  const undouble = (s: string) =>
    /([bcdfgklmnprstvz])\1$/.test(s) ? s.slice(0, -1) : undefined;
  const rules: [RegExp, string[]][] = [
    [/ies$/, ['y']],
    [/(s|x|z|ch|sh|o)es$/, ['$1']],
    [/s$/, ['']],
    [/ied$/, ['y']],
    [/ed$/, ['', 'e']],
    [/ing$/, ['', 'e']],
    [/ier$/, ['y']],
    [/iest$/, ['y']],
    [/er$/, ['', 'e']],
    [/est$/, ['', 'e']],
  ];
  for (const [ending, replacements] of rules) {
    if (!ending.test(word)) continue;
    for (const r of replacements) {
      const base = word.replace(ending, r);
      add(base);
      const single = undouble(base);
      if (single) add(single);
    }
  }
  return out;
}

/**
 * The English word (and the words it's a form of) for a query; empty if
 * it isn't one, or the data has no English words.
 */
export async function lookupEnglish(
  dict: Dict,
  query: string,
): Promise<EnglishWord[]> {
  const key = query.trim().toLowerCase().replace(/\s+/g, ' ');
  if (
    !key ||
    !dict.meta.shards.enw ||
    hasJapanese(key) ||
    key.split(' ').length > MAX_WORDS
  ) {
    return [];
  }
  const found = await dict.englishWord(key);
  const out: EnglishWord[] = [];
  if (found?.e) out.push({word: key, entries: found.e});
  let bases = found?.of ?? [];
  if (!found) {
    // Not in the data: a regular form of a word that is.
    const tried = await Promise.all(
      regularBases(key).map(async b =>
        (await dict.englishWord(b))?.e ? b : '',
      ),
    );
    bases = tried.filter(Boolean).slice(0, 2);
  }
  for (const base of bases) {
    const b = await dict.englishWord(base.toLowerCase());
    if (b?.e) out.push({word: base, entries: b.e, base: true});
  }
  return out;
}

function renderEntry(e: EnglishEntry): HTMLElement {
  return h(
    'div',
    {class: 'en-entry'},
    h('p', {class: 'ja-pos'}, e.p),
    h(
      'ol',
      {class: 'ja-senses', lang: 'ja'},
      e.s.map(s =>
        h(
          'li',
          null,
          s.t && h('span', {class: 'ja-tags'}, `〔${s.t.join('・')}〕`),
          s.g,
          s.ex &&
            h(
              'ul',
              {class: 'ja-examples'},
              s.ex.map(([en, ja]) =>
                h(
                  'li',
                  null,
                  h('span', {lang: 'en'}, en),
                  ja && h('span', {class: 'en-translation'}, ` ${ja}`),
                ),
              ),
            ),
        ),
      ),
    ),
    e.f &&
      h(
        'p',
        {class: 'en-forms'},
        e.f.flatMap(([form, label], i) => [
          i > 0 ? ' · ' : '',
          h('span', {class: 'ja-tags', lang: 'ja'}, label),
          ' ',
          searchLink(form, form),
        ]),
      ),
  );
}

/** The 英和 card: each word, its pronunciation, and its entries. */
export function renderEnglish(words: EnglishWord[]): HTMLElement | undefined {
  if (!words.length) return undefined;
  return h(
    'section',
    {class: 'english-words'},
    h(
      'h2',
      {class: 'results-heading'},
      'English → Japanese',
      h('span', {class: 'ja-source'}, ' 英和 · Japanese Wiktionary'),
    ),
    words.map(w => {
      const ipa = [...new Set(w.entries.flatMap(e => e.ipa ?? []))];
      // One entry per spelling (cat, CAT): its own heading when it differs.
      return h(
        'article',
        {class: 'english-word', lang: 'en'},
        h(
          'h3',
          {class: 'english-headword'},
          w.base ? searchLink(w.word, w.word) : w.word,
          ipa.length > 0 && h('span', {class: 'en-ipa'}, ` ${ipa.join('  ')}`),
        ),
        w.entries.map(e =>
          e.w.toLowerCase() === w.word.toLowerCase() && e.w !== w.word
            ? h(
                'div',
                null,
                h('p', {class: 'en-spelling'}, e.w),
                renderEntry(e),
              )
            : renderEntry(e),
        ),
      );
    }),
  );
}
