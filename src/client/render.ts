import {parseFurigana} from '../shared/furigana.ts';
import type {Entry, Example, KanjiInfo, Sense} from '../shared/types.ts';
import type {Dict} from './dict.ts';
import {h, join, searchLink} from './dom.ts';
import {
  furigana,
  headword,
  otherForms,
  surfaceFurigana,
  type Headword,
  type RubyPart,
} from './forms.ts';
import type {
  Inflection,
  SearchResult,
  SentenceWord,
  Token,
  WordResult,
} from './search.ts';

/** Extra controls to show on each entry (e.g. an "add to Anki" button). */
export type EntryActions = (entry: Entry) => Node | undefined;

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

function ruby(parts: RubyPart[]): (Node | string)[] {
  return parts.map(([text, rt]) =>
    rt ? h('ruby', null, text, h('rt', null, rt)) : text,
  );
}

/** A word with furigana over its kanji. */
export function rubyWord(word: Headword): HTMLElement {
  return h(
    'span',
    {class: 'word', lang: 'ja'},
    word.reading ? ruby(furigana(word.text, word.reading)) : word.text,
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

export function posLabel(dict: Dict, tag: string): string {
  return SHORT_TAGS[tag] ?? capitalize(dict.tagDescription(tag));
}

/**
 * Splits furigana parts so the word at [start, end) of the plain text can be
 * highlighted: plain text is cut at the boundaries; a part with a reading is
 * kept whole and highlighted if the word touches it.
 */
export function highlightParts(
  parts: RubyPart[],
  start: number,
  end: number,
): [RubyPart, boolean][] {
  const out: [RubyPart, boolean][] = [];
  let pos = 0;
  for (const part of parts) {
    const [text, rt] = part;
    const a = pos;
    const b = pos + text.length;
    pos = b;
    if (rt || end <= a || start >= b) {
      out.push([part, start < b && end > a]);
      continue;
    }
    const cuts = [a, Math.max(a, start), Math.min(b, end), b];
    for (let i = 0; i < 3; i++) {
      const piece = text.slice(cuts[i] - a, cuts[i + 1] - a);
      if (piece) out.push([[piece], i === 1]);
    }
  }
  return out;
}

/** An example sentence with furigana, the word it illustrates highlighted. */
function exampleSentence(ex: Example): HTMLElement {
  const parts = ex.f ? parseFurigana(ex.f) : [[ex.ja] as RubyPart];
  const start = ex.w ? ex.ja.indexOf(ex.w) : -1;
  const pieces =
    start < 0
      ? parts.map(p => [p, false] as [RubyPart, boolean])
      : highlightParts(parts, start, start + ex.w.length);
  // Group consecutive highlighted pieces into one <mark>.
  const nodes: (Node | string)[] = [];
  let mark: HTMLElement | undefined;
  for (const [part, marked] of pieces) {
    const [node] = ruby([part]);
    if (marked) {
      if (!mark) nodes.push((mark = h('mark')));
      mark.append(node);
    } else {
      mark = undefined;
      nodes.push(node);
    }
  }
  return h(
    'li',
    {class: 'example'},
    h('p', {class: 'example-ja', lang: 'ja'}, nodes),
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
  actions?: EntryActions,
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
      actions?.(entry),
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

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(
  tag: string,
  attrs: Record<string, string | number>,
  ...children: Element[]
): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  el.append(...children);
  return el;
}

/** Where a stroke's path starts ("M52.75,10.5c…" → [52.75, 10.5]). */
export function strokeStart(d: string): [number, number] | undefined {
  const m = /^\s*M\s*(-?[\d.]+)[\s,]*(-?[\d.]+)/i.exec(d);
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}

/**
 * Stroke order as a row of frames, one per stroke: earlier strokes in gray,
 * the new stroke highlighted with a dot where it starts. Strokes are KanjiVG
 * paths in a 109×109 box.
 */
export function renderStrokeOrder(
  char: string,
  strokes: string[],
): HTMLElement {
  const frames = strokes.map((_, i) => {
    const start = strokeStart(strokes[i]);
    return svg(
      'svg',
      {
        class: 'stroke-frame',
        viewBox: '0 0 109 109',
        role: 'img',
        'aria-label': `Stroke ${i + 1} of ${strokes.length}`,
      },
      svg('line', {class: 'stroke-guide', x1: 54.5, y1: 0, x2: 54.5, y2: 109}),
      svg('line', {class: 'stroke-guide', x1: 0, y1: 54.5, x2: 109, y2: 54.5}),
      ...strokes.slice(0, i).map(d => svg('path', {class: 'stroke-done', d})),
      svg('path', {class: 'stroke-current', d: strokes[i]}),
      ...(start
        ? [
            svg('circle', {
              class: 'stroke-start',
              cx: start[0],
              cy: start[1],
              r: 4,
            }),
          ]
        : []),
    );
  });
  return h(
    'div',
    {class: 'stroke-order', 'aria-label': `Stroke order of ${char}`},
    ...frames,
  );
}

export function renderKanji(k: KanjiInfo, strokes?: string[]): HTMLElement {
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
    strokes && renderStrokeOrder(k.c, strokes),
  );
}

/** Senses shown on a sentence word before its details are expanded. */
const COMPACT_SENSES = 3;

/** The sentence as a row of words with furigana, each linking to its card. */
function renderSentenceBar(
  tokens: Token[],
  words: SentenceWord[],
): HTMLElement {
  const byToken = new Map(words.map(w => [w.token, w]));
  return h(
    'nav',
    {class: 'sentence', lang: 'ja', 'aria-label': 'Words in the sentence'},
    tokens.map((t, i) => {
      const word = byToken.get(i);
      if (!word) return h('span', {class: 'token unknown'}, t.text);
      return h(
        'a',
        {class: 'token', href: `#word-${i}`},
        ruby(surfaceFurigana(t.text, word.matches[0].entry, t.base)),
      );
    }),
  );
}

/** A compact card for one word of a sentence; the full entry is in <details>. */
function renderSentenceWord(
  dict: Dict,
  token: Token,
  word: SentenceWord,
  actions?: EntryActions,
): HTMLElement {
  const [best, ...others] = word.matches;
  const {entry, inflection} = best;
  const head = headword(entry);
  let prevPos: string | undefined;
  const senses = entry.s.slice(0, COMPACT_SENSES).map((s, i) => {
    const pos = s.p?.map(p => posLabel(dict, p)).join(', ');
    const el = h(
      'li',
      null,
      pos && pos !== prevPos && h('span', {class: 'pos'}, pos),
      h('span', {class: 'sense-num'}, `${i + 1}. `),
      s.g.join('; '),
    );
    prevPos = pos;
    return el;
  });
  const more = entry.s.length - COMPACT_SENSES;
  const summary = [
    more > 0 ? `${more} more meaning${more > 1 ? 's' : ''}` : 'Full entry',
    others.length > 0 &&
      `${others.length} other match${others.length > 1 ? 'es' : ''}`,
  ]
    .filter(Boolean)
    .join(' · ');
  return h(
    'article',
    {class: 'sentence-word', id: `word-${word.token}`},
    h(
      'div',
      {class: 'sentence-word-head'},
      h(
        'span',
        {class: 'sentence-word-text', lang: 'ja'},
        ruby(surfaceFurigana(token.text, entry, token.base)),
      ),
      head.text !== token.text &&
        h(
          'span',
          {class: 'dictionary-form'},
          '→ ',
          searchLink(head.text, rubyWord(head)),
        ),
      isCommon(entry) && h('span', {class: 'badge common'}, 'common'),
      actions?.(entry),
    ),
    inflection &&
      h(
        'p',
        {class: 'chain', lang: 'ja'},
        inflectionChain(inflection.to, inflection.reasons),
      ),
    h('ol', {class: 'compact-senses'}, senses),
    h(
      'details',
      {class: 'word-details'},
      h('summary', null, summary),
      renderEntry(dict, best, actions),
      others.map(o => renderEntry(dict, o, actions)),
    ),
  );
}

/** A sentence: the word bar, then a card for every word. */
export function renderSentence(
  dict: Dict,
  result: SearchResult,
  actions?: EntryActions,
): HTMLElement[] {
  const tokens = result.tokens ?? [];
  const words = (result.sentence ?? []).filter(w => w.matches.length > 0);
  return [
    renderSentenceBar(tokens, words),
    h(
      'section',
      {class: 'words'},
      h(
        'h2',
        {class: 'results-heading'},
        'Words in this sentence',
        h('span', {class: 'count'}, ` — ${words.length}`),
      ),
      words.map(w => renderSentenceWord(dict, tokens[w.token], w, actions)),
    ),
  ];
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
