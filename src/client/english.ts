/**
 * English words, when you search in English: explained in Japanese (英和,
 * Japanese Wiktionary) and defined in English (Open English WordNet), shown
 * above the Japanese words. The settings show either or both
 * (html.show-english-japanese, html.show-english-english); the cards are
 * always made, so changing them needs no new search.
 *
 * A form is followed to its word ("went" → go, "apples" → apple), from the
 * data; failing that, regular endings are tried ("walked" → walk).
 */
import {hasJapanese} from '../shared/kana.ts';
import type {
  EnglishDefinitions,
  EnglishEntry,
  Entry,
  JaDefinition,
} from '../shared/types.ts';
import type {Dict} from './dict.ts';
import {h, searchLink} from './dom.ts';
import {headword} from './forms.ts';
import {t} from './i18n.ts';
import {jaDefinitionsSlot, render as renderJaDefinitions} from './japanese.ts';
import {rubyWord} from './render.ts';

/** Japanese words shown for an English word the 英和 data doesn't have. */
const MAX_TRANSLATIONS = 5;

/** Longest query looked up as an English word or phrase. */
const MAX_WORDS = 4;

export interface EnglishWord {
  word: string;
  /** in Japanese (英和) */
  entries: EnglishEntry[];
  /** in English */
  definitions: EnglishDefinitions[];
  /** pronunciation from WordNet, when the entries have none */
  ipa?: string[];
  /** the query is a form of this word */
  base?: boolean;
  /**
   * When the 英和 data has no entry: the Japanese words JMdict gives for it,
   * with their definitions in Japanese (国語), so it's still answered in
   * Japanese.
   */
  translations?: {entry: Entry; defs?: JaDefinition[]}[];
}

/**
 * For an English word the 英和 data doesn't have ("betterment"): the
 * Japanese words that JMdict's English meanings match (改善, …), each with
 * its definitions in Japanese. `matches` are the search's Japanese words,
 * best first. Words already answered by the 英和 data are left as they are.
 */
export async function addTranslations(
  dict: Dict,
  query: string,
  words: EnglishWord[],
  matches: Entry[],
): Promise<EnglishWord[]> {
  if (words.some(w => w.entries.length) || !matches.length) return words;
  const key = query.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!key || hasJapanese(key)) return words;
  const translations = await Promise.all(
    matches.slice(0, MAX_TRANSLATIONS).map(async entry => ({
      entry,
      defs: await dict.jaDefinitions(entry.id).catch(() => undefined),
    })),
  );
  const own = words.find(w => !w.base);
  if (own) return words.map(w => (w === own ? {...w, translations} : w));
  return [{word: key, entries: [], definitions: [], translations}, ...words];
}

function renderTranslations(
  translations: NonNullable<EnglishWord['translations']>,
): HTMLElement {
  return h(
    'div',
    {class: 'en-ja'},
    h(
      'p',
      {class: 'en-source'},
      t('Japanese words for it · JMdict, Japanese Wiktionary'),
    ),
    translations.map(({entry, defs}) => {
      const word = headword(entry);
      const slot = jaDefinitionsSlot(entry.id, true);
      renderJaDefinitions(slot, defs);
      return h(
        'div',
        {class: 'en-translation-word', lang: 'ja'},
        h('h4', null, searchLink(word.text, rubyWord(word))),
        slot,
      );
    }),
  );
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
  const word = async (w: string, base = false) => {
    const v = await dict.englishWord(w.toLowerCase());
    return v && (v.e || v.d)
      ? {word: w, entries: v.e ?? [], definitions: v.d ?? [], ipa: v.ipa, base}
      : undefined;
  };
  const found = await dict.englishWord(key);
  const out: EnglishWord[] = [];
  const self = await word(key);
  if (self) out.push(self);
  let bases = found?.of ?? [];
  if (!found) {
    // Not in the data: a regular form of a word that is.
    const tried = await Promise.all(
      regularBases(key).map(async b => ((await word(b)) ? b : '')),
    );
    bases = tried.filter(Boolean).slice(0, 2);
  }
  for (const base of bases) {
    const b = await word(base, true);
    if (b) out.push(b);
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

function renderDefinitions(defs: EnglishDefinitions[]): HTMLElement {
  return h(
    'div',
    {class: 'en-en'},
    h('p', {class: 'en-source'}, t('Definitions · Open English WordNet')),
    defs.map(group =>
      h(
        'div',
        {class: 'en-entry'},
        h('p', {class: 'ja-pos'}, group.p),
        h(
          'ol',
          {class: 'ja-senses'},
          group.s.map(s =>
            h(
              'li',
              null,
              s.d,
              s.syn &&
                h(
                  'span',
                  {class: 'en-synonyms'},
                  ' — ',
                  s.syn.flatMap((w, i) => [
                    i > 0 ? ', ' : '',
                    searchLink(w.replace(/_/g, ' '), w.replace(/_/g, ' ')),
                  ]),
                ),
              s.ex &&
                h('ul', {class: 'ja-examples'}, h('li', null, `“${s.ex}”`)),
            ),
          ),
        ),
      ),
    ),
  );
}

/**
 * The English words' cards: each word, its pronunciation, its meanings in
 * Japanese and its definitions in English (each shown by its setting).
 */
export function renderEnglish(words: EnglishWord[]): HTMLElement | undefined {
  if (!words.length) return undefined;
  return h(
    'section',
    {class: 'english-words'},
    words.map(w => {
      const ipa = [
        ...new Set([...w.entries.flatMap(e => e.ipa ?? []), ...(w.ipa ?? [])]),
      ];
      const classes = ['english-word'];
      if (!w.entries.length && !w.translations?.length) classes.push('no-ja');
      if (!w.definitions.length) classes.push('no-en');
      return h(
        'article',
        {class: classes.join(' '), lang: 'en'},
        h(
          'h3',
          {class: 'english-headword'},
          w.base ? searchLink(w.word, w.word) : w.word,
          ipa.length > 0 && h('span', {class: 'en-ipa'}, ` ${ipa.join('  ')}`),
        ),
        w.entries.length > 0 &&
          h(
            'div',
            {class: 'en-ja'},
            h('p', {class: 'en-source'}, t('英和 · Japanese Wiktionary')),
            // One entry per spelling (cat, CAT): its own heading when it differs.
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
          ),
        !w.entries.length &&
          !!w.translations?.length &&
          renderTranslations(w.translations),
        w.definitions.length > 0 && renderDefinitions(w.definitions),
      );
    }),
  );
}
