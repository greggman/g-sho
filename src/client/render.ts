import type {Entry, Example, KanjiInfo, Sense} from '../shared/types.ts';
import type {Dict} from './dict.ts';
import {h, join, searchLink} from './dom.ts';
import {furigana, headword, otherForms, type Headword} from './forms.ts';
import type {Inflection, SearchResult, Token, WordResult} from './search.ts';

/** ISO 639-2 codes used in JMdict language sources. Others show as the code. */
const LANGUAGES: Record<string, string> = {
  afr: 'Afrikaans',
  ain: 'Ainu',
  ara: 'Arabic',
  chi: 'Chinese',
  dan: 'Danish',
  dut: 'Dutch',
  eng: 'English',
  fin: 'Finnish',
  fre: 'French',
  ger: 'German',
  gre: 'Greek',
  heb: 'Hebrew',
  hin: 'Hindi',
  hun: 'Hungarian',
  ind: 'Indonesian',
  ita: 'Italian',
  kor: 'Korean',
  lat: 'Latin',
  may: 'Malay',
  mon: 'Mongolian',
  nor: 'Norwegian',
  per: 'Persian',
  pol: 'Polish',
  por: 'Portuguese',
  rus: 'Russian',
  san: 'Sanskrit',
  spa: 'Spanish',
  swe: 'Swedish',
  tha: 'Thai',
  tib: 'Tibetan',
  tur: 'Turkish',
  vie: 'Vietnamese',
};

/**
 * Shorter labels for the most common part-of-speech tags. JMdict's own
 * descriptions ("noun (common) (futsuumeishi)") are used for the rest.
 */
const SHORT_TAGS: Record<string, string> = {
  n: 'Noun',
  'n-pr': 'Proper noun',
  'n-suf': 'Suffix noun',
  'n-pref': 'Prefix noun',
  'n-adv': 'Adverbial noun',
  'n-t': 'Temporal noun',
  vs: 'Suru verb',
  'vs-i': 'Suru verb (irregular)',
  'vs-s': 'Suru verb (special class)',
  v1: 'Ichidan verb',
  vk: 'Kuru verb (special class)',
  vt: 'Transitive verb',
  vi: 'Intransitive verb',
  'adj-i': 'I-adjective',
  'adj-ix': 'I-adjective (yoi/ii class)',
  'adj-na': 'Na-adjective',
  'adj-no': 'No-adjective',
  'adj-pn': 'Pre-noun adjectival',
  'adj-t': 'Taru-adjective',
  'adj-f': 'Noun or verb acting prenominally',
  adv: 'Adverb',
  'adv-to': 'Adverb taking と',
  exp: 'Expression',
  int: 'Interjection',
  conj: 'Conjunction',
  prt: 'Particle',
  pn: 'Pronoun',
  pref: 'Prefix',
  suf: 'Suffix',
  ctr: 'Counter',
  num: 'Numeric',
  aux: 'Auxiliary',
  'aux-v': 'Auxiliary verb',
  'aux-adj': 'Auxiliary adjective',
  cop: 'Copula',
};

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A word with furigana over its kanji. */
export function rubyWord(word: Headword): HTMLElement {
  if (!word.reading) return h('span', {class: 'word', lang: 'ja'}, word.text);
  return h(
    'span',
    {class: 'word', lang: 'ja'},
    furigana(word.text, word.reading).map(([text, ruby]) =>
      ruby ? h('ruby', null, text, h('rt', null, ruby)) : text,
    ),
  );
}

/** The steps from dictionary form to what was typed: "行く → -tai → negative → past". */
function inflectionChain(base: string, reasons: string[]): string {
  return [base, ...[...reasons].reverse()].join(' → ');
}

function inflectionNote(inf: Inflection): HTMLElement {
  return h(
    'p',
    {class: 'inflection'},
    h('span', {lang: 'ja'}, inf.from),
    ' is an inflection of ',
    h('span', {lang: 'ja'}, inf.to),
    h(
      'span',
      {class: 'chain', lang: 'ja'},
      inflectionChain(inf.to, inf.reasons),
    ),
  );
}

function posLabel(dict: Dict, tag: string): string {
  return SHORT_TAGS[tag] ?? capitalize(dict.tagDescription(tag));
}

/** Highlights the word within an example sentence. */
function exampleSentence(ex: Example): HTMLElement {
  const i = ex.w ? ex.ja.indexOf(ex.w) : -1;
  const ja =
    i < 0
      ? [ex.ja]
      : [
          ex.ja.slice(0, i),
          h('mark', null, ex.w),
          ex.ja.slice(i + ex.w.length),
        ];
  return h(
    'li',
    {class: 'example'},
    h('p', {class: 'example-ja', lang: 'ja'}, ja),
    h('p', {class: 'example-en'}, ex.en),
  );
}

/** "See also" link text for a JMdict cross reference like ["漢字", "かんじ", 2]. */
function xref(ref: (string | number)[]): HTMLElement {
  const [word, ...rest] = ref;
  const reading = rest.find(r => typeof r === 'string');
  const sense = rest.find(r => typeof r === 'number');
  return searchLink(
    String(word),
    h('span', {lang: 'ja'}, String(word), reading ? `・${reading}` : ''),
    sense !== undefined ? ` (sense ${sense})` : '',
  );
}

function renderSense(
  dict: Dict,
  sense: Sense,
  n: number,
  prevPos: string | undefined,
): HTMLElement {
  const pos = sense.p?.map(p => posLabel(dict, p)).join(', ');
  const tags = [...(sense.m ?? []), ...(sense.f ?? []), ...(sense.d ?? [])].map(
    t => capitalize(dict.tagDescription(t)),
  );
  const restrictions = [...(sense.ak ?? []), ...(sense.ar ?? [])];
  const sources = (sense.ls ?? []).map(ls => {
    const lang = LANGUAGES[ls.l] ?? ls.l;
    const kind = ls.w ? 'Wasei, from' : ls.p ? 'Partly from' : 'From';
    return ls.t ? `${kind} ${lang} "${ls.t}"` : `${kind} ${lang}`;
  });
  return h(
    'li',
    {class: 'sense'},
    pos && pos !== prevPos && h('div', {class: 'pos'}, pos),
    h(
      'div',
      {class: 'sense-line'},
      h('span', {class: 'sense-num'}, `${n}. `),
      h('span', {class: 'glosses'}, sense.g.join('; ')),
      tags.length > 0 && h('span', {class: 'sense-tags'}, tags.join(', ')),
      restrictions.length > 0 &&
        h(
          'span',
          {class: 'sense-tags'},
          'Only applies to ',
          h('span', {lang: 'ja'}, restrictions.join('、')),
        ),
      sense.i?.map(i => h('span', {class: 'sense-info'}, i)),
      sources.map(s => h('span', {class: 'sense-info'}, s)),
      sense.rel &&
        h(
          'span',
          {class: 'sense-info'},
          'See also ',
          join(sense.rel.map(xref), ', '),
        ),
      sense.ant &&
        h(
          'span',
          {class: 'sense-info'},
          'Antonym: ',
          join(sense.ant.map(xref), ', '),
        ),
    ),
    sense.ex &&
      h(
        'details',
        {class: 'examples'},
        h(
          'summary',
          null,
          sense.ex.length === 1 ? 'Example' : `${sense.ex.length} examples`,
        ),
        h('ul', null, sense.ex.map(exampleSentence)),
      ),
  );
}

function isCommon(entry: Entry): boolean {
  return (entry.k ?? []).some(k => k.c) || entry.r.some(r => r.c);
}

export function renderEntry(
  dict: Dict,
  {entry, inflection}: WordResult,
): HTMLElement {
  const others = otherForms(entry);
  let prevPos: string | undefined;
  return h(
    'article',
    {class: 'entry'},
    h(
      'div',
      {class: 'entry-head'},
      h(
        'div',
        {class: 'headword'},
        searchLink(headword(entry).text, rubyWord(headword(entry))),
      ),
      isCommon(entry) && h('span', {class: 'badge common'}, 'common word'),
    ),
    h(
      'div',
      {class: 'entry-body'},
      inflection && inflectionNote(inflection),
      h(
        'ol',
        {class: 'senses'},
        entry.s.map((s, i) => {
          const el = renderSense(dict, s, i + 1, prevPos);
          prevPos = s.p?.map(p => posLabel(dict, p)).join(', ');
          return el;
        }),
      ),
      others.length > 0 &&
        h(
          'div',
          {class: 'other-forms'},
          h('span', {class: 'pos'}, 'Other forms'),
          h(
            'p',
            {lang: 'ja'},
            join(
              others.map(o =>
                o.reading ? `${o.text}【${o.reading}】` : o.text,
              ),
              '、',
            ),
          ),
        ),
    ),
  );
}

function gradeText(g: number): string {
  if (g <= 6) return `Taught in grade ${g}`;
  if (g === 8) return 'Jōyō (taught in junior high)';
  return 'Jinmeiyō (used in names)';
}

export function renderKanji(k: KanjiInfo): HTMLElement {
  const stats = [
    k.s && `${k.s} strokes`,
    k.g && gradeText(k.g),
    k.j && `Old JLPT level ${k.j}`,
    k.f && `#${k.f} of 2,500 most used`,
  ].filter(Boolean);
  const readings = (label: string, list: string[] | undefined) =>
    list &&
    h(
      'div',
      {class: 'kanji-readings'},
      h('span', {class: 'label'}, label),
      h(
        'span',
        {lang: 'ja'},
        join(
          list.map(r => searchLink(r.replace(/[.-]/g, ''), r)),
          '、',
        ),
      ),
    );
  return h(
    'section',
    {class: 'kanji-card'},
    h('div', {class: 'kanji-char', lang: 'ja'}, searchLink(k.c)),
    h(
      'div',
      {class: 'kanji-info'},
      h('p', {class: 'kanji-meanings'}, k.m.join(', ')),
      readings('Kun:', k.kun),
      readings('On:', k.on),
      readings('Names:', k.nanori),
      stats.length > 0 && h('p', {class: 'kanji-stats'}, stats.join(' · ')),
      k.parts &&
        h(
          'p',
          {class: 'kanji-parts'},
          h('span', {class: 'label'}, 'Parts: '),
          h('span', {lang: 'ja'}, k.parts.join(' ')),
        ),
    ),
  );
}

export function renderTokens(
  tokens: Token[],
  selected: number,
  hrefFor: (i: number) => string,
): HTMLElement {
  return h(
    'nav',
    {class: 'sentence', lang: 'ja', 'aria-label': 'Words in the sentence'},
    tokens.map((t, i) =>
      t.known
        ? h(
            'a',
            {
              class: i === selected ? 'token selected' : 'token',
              href: hrefFor(i),
              title: t.base
                ? inflectionChain(t.base, t.reasons ?? [])
                : undefined,
              'aria-current': i === selected ? 'true' : undefined,
            },
            t.text,
          )
        : h('span', {class: 'token unknown'}, t.text),
    ),
  );
}

export function resultsHeading(result: SearchResult): HTMLElement {
  const count =
    result.total === 1 ? '1 word' : `${result.total.toLocaleString()} words`;
  return h(
    'h2',
    {class: 'results-heading'},
    'Words',
    h('span', {class: 'count'}, ` — ${count}`),
    result.kana &&
      h(
        'span',
        {class: 'searched-as'},
        ' · also searched for ',
        searchLink(result.kana),
      ),
  );
}
