import {parseFurigana} from '../shared/furigana.ts';
import type {Entry, Example, KanjiInfo, Sense} from '../shared/types.ts';
import type {Dict} from './dict.ts';
import {fill, h, join, searchLink} from './dom.ts';
import {t} from './i18n.ts';
import {jaDefinitionsSlot, jaText, linkJapanese} from './japanese.ts';
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

/**
 * Names of the ISO 639-2 codes used in JMdict language sources (a function:
 * t() can't run when the module loads). Others show as the code.
 */
function languageNames(): Record<string, string> {
  return {
    afr: t('Afrikaans'),
    ain: t('Ainu'),
    ara: t('Arabic'),
    chi: t('Chinese'),
    dan: t('Danish'),
    dut: t('Dutch'),
    eng: t('English'),
    fin: t('Finnish'),
    fre: t('French'),
    ger: t('German'),
    gre: t('Greek'),
    heb: t('Hebrew'),
    hin: t('Hindi'),
    hun: t('Hungarian'),
    ind: t('Indonesian'),
    ita: t('Italian'),
    kor: t('Korean'),
    lat: t('Latin'),
    may: t('Malay'),
    mon: t('Mongolian'),
    nor: t('Norwegian'),
    per: t('Persian'),
    pol: t('Polish'),
    por: t('Portuguese'),
    rus: t('Russian'),
    san: t('Sanskrit'),
    spa: t('Spanish'),
    swe: t('Swedish'),
    tha: t('Thai'),
    tib: t('Tibetan'),
    tur: t('Turkish'),
    vie: t('Vietnamese'),
  };
}

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

/** Names of deinflect.ts's reasons, in the interface's language. */
function reasonNames(): Record<string, string> {
  return {
    '-nagara': t('-nagara'),
    '-sou': t('-sou'),
    '-tai': t('-tai'),
    '-tara': t('-tara'),
    '-tari': t('-tari'),
    '-te aru': t('-te aru'),
    '-te oku': t('-te oku'),
    '-te shimau': t('-te shimau'),
    adverb: t('adverb'),
    causative: t('causative'),
    conditional: t('conditional'),
    imperative: t('imperative'),
    'masu stem': t('masu stem'),
    'negative past': t('negative past'),
    negative: t('negative'),
    noun: t('noun'),
    passive: t('passive'),
    past: t('past'),
    polite: t('polite'),
    'potential or passive': t('potential or passive'),
    potential: t('potential'),
    progressive: t('progressive'),
    request: t('request'),
    'suru verb': t('suru verb'),
    'te-form': t('te-form'),
    volitional: t('volitional'),
  };
}

/** The steps from dictionary form to what was typed: "行く → -tai → negative → past". */
function inflectionChain(base: string, reasons: string[]): string {
  const names = reasonNames();
  return [base, ...[...reasons].reverse().map(r => names[r] ?? r)].join(' → ');
}

function inflectionNote(inf: Inflection): HTMLElement {
  return h(
    'p',
    {class: 'inflection'},
    fill(t('{from} is an inflection of {to}'), {
      from: h('span', {lang: 'ja'}, inf.from),
      to: h('span', {lang: 'ja'}, inf.to),
    }),
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
    sense !== undefined ? t(' (sense {n})', {n: sense}) : '',
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
    tag => capitalize(dict.tagDescription(tag)),
  );
  const restrictions = [...(sense.ak ?? []), ...(sense.ar ?? [])];
  const languages = languageNames();
  const sources = (sense.ls ?? []).map(ls => {
    const vars = {lang: languages[ls.l] ?? ls.l, word: ls.t ?? ''};
    if (ls.w) {
      return ls.t
        ? t('Wasei, from {lang} "{word}"', vars)
        : t('Wasei, from {lang}', vars);
    }
    if (ls.p) {
      return ls.t
        ? t('Partly from {lang} "{word}"', vars)
        : t('Partly from {lang}', vars);
    }
    return ls.t ? t('From {lang} "{word}"', vars) : t('From {lang}', vars);
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
          fill(t('Only applies to {forms}'), {
            forms: h('span', {lang: 'ja'}, restrictions.join('、')),
          }),
        ),
      sense.i?.map(i => h('span', {class: 'sense-info'}, i)),
      sources.map(s => h('span', {class: 'sense-info'}, s)),
      sense.rel &&
        h(
          'span',
          {class: 'sense-info'},
          fill(t('See also {words}'), {words: join(sense.rel.map(xref), ', ')}),
        ),
      sense.ant &&
        h(
          'span',
          {class: 'sense-info'},
          fill(t('Antonym: {words}'), {words: join(sense.ant.map(xref), ', ')}),
        ),
    ),
    sense.ex &&
      h(
        'details',
        {class: 'examples'},
        h(
          'summary',
          null,
          sense.ex.length === 1
            ? t('Example')
            : t('{n} examples', {n: sense.ex.length}),
        ),
        h('ul', null, sense.ex.map(exampleSentence)),
      ),
  );
}

function isCommon(entry: Entry): boolean {
  return (entry.k ?? []).some(k => k.c) || entry.r.some(r => r.c);
}

/**
 * "N more example sentences": Tatoeba's sentences for the word (with
 * English), then the Japanese Wiktionary's (Japanese only, every word
 * linked). Loaded when opened.
 */
function moreExamples(dict: Dict, entry: Entry): HTMLElement {
  const n = entry.mx ?? 0;
  const list = h('ul', null, h('li', {class: 'hint'}, t('Loading…')));
  const details = h(
    'details',
    {class: 'examples more-examples'},
    h(
      'summary',
      null,
      n === 1
        ? t('{n} more example sentence', {n})
        : t('{n} more example sentences', {n}),
    ),
    list,
  );
  details.addEventListener('toggle', () => {
    if (!details.open || details.dataset.loaded !== undefined) return;
    details.dataset.loaded = '';
    void (async () => {
      const [tatoeba, defs] = await Promise.all([
        dict.moreExamples(entry.id).catch(() => undefined),
        dict.jaDefinitions(entry.id).catch(() => undefined),
      ]);
      const wiktionary = (defs ?? []).flatMap(d =>
        d.s.flatMap(s => s.ex ?? []),
      );
      list.replaceChildren(
        ...(tatoeba ?? []).map(exampleSentence),
        ...wiktionary.map(text =>
          h(
            'li',
            {class: 'example'},
            h('p', {class: 'example-ja', lang: 'ja'}, jaText(text)),
            h(
              'p',
              {class: 'example-source'},
              t('Japanese Wiktionary (no translation)'),
            ),
          ),
        ),
      );
      await linkJapanese(dict, list);
    })();
  });
  return details;
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
      isCommon(entry) && h('span', {class: 'badge common'}, t('common word')),
      actions?.(entry),
    ),
    h(
      'div',
      {class: 'entry-body'},
      inflection && inflectionNote(inflection),
      jaDefinitionsSlot(entry.id),
      h(
        'ol',
        {class: 'senses'},
        entry.s.map((s, i) => {
          const el = renderSense(dict, s, i + 1, prevPos);
          prevPos = s.p?.map(p => posLabel(dict, p)).join(', ');
          return el;
        }),
      ),
      !!entry.mx && moreExamples(dict, entry),
      others.length > 0 &&
        h(
          'div',
          {class: 'other-forms'},
          h('span', {class: 'pos'}, t('Other forms')),
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
  if (g <= 6) return t('Taught in grade {g}', {g});
  if (g === 8) return t('Jōyō (taught in junior high)');
  return t('Jinmeiyō (used in names)');
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
        'aria-label': t('Stroke {i} of {n}', {i: i + 1, n: strokes.length}),
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
    {class: 'stroke-order', 'aria-label': t('Stroke order of {char}', {char})},
    ...frames,
  );
}

export function renderKanji(k: KanjiInfo, strokes?: string[]): HTMLElement {
  const stats = [
    k.s && t('{n} strokes', {n: k.s}),
    k.g && gradeText(k.g),
    k.j && t('Old JLPT level {n}', {n: k.j}),
    k.f && t('#{n} of 2,500 most used', {n: k.f}),
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
      readings(t('Kun:'), k.kun),
      readings(t('On:'), k.on),
      readings(t('Names:'), k.nanori),
      stats.length > 0 && h('p', {class: 'kanji-stats'}, stats.join(' · ')),
      k.parts &&
        h(
          'p',
          {class: 'kanji-parts'},
          h('span', {class: 'label'}, t('Parts: ')),
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
    {
      class: 'sentence',
      lang: 'ja',
      'aria-label': t('Words in the sentence'),
    },
    tokens.map((token, i) => {
      const word = byToken.get(i);
      if (!word) return h('span', {class: 'token unknown'}, token.text);
      return h(
        'a',
        {class: 'token', href: `#word-${i}`},
        ruby(surfaceFurigana(token.text, word.matches[0].entry, token.base)),
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
      h('span', {class: 'compact-gloss'}, s.g.join('; ')),
    );
    prevPos = pos;
    return el;
  });
  const more = entry.s.length - COMPACT_SENSES;
  const summary = [
    more > 0
      ? more > 1
        ? t('{n} more meanings', {n: more})
        : t('{n} more meaning', {n: more})
      : t('Full entry'),
    others.length > 0 &&
      (others.length > 1
        ? t('{n} other matches', {n: others.length})
        : t('{n} other match', {n: others.length})),
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
      isCommon(entry) && h('span', {class: 'badge common'}, t('common')),
      actions?.(entry),
    ),
    inflection &&
      h(
        'p',
        {class: 'chain', lang: 'ja'},
        inflectionChain(inflection.to, inflection.reasons),
      ),
    jaDefinitionsSlot(entry.id, true),
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
        t('Words in this sentence'),
        h('span', {class: 'count'}, ` — ${words.length}`),
      ),
      words.map(w => renderSentenceWord(dict, tokens[w.token], w, actions)),
    ),
  ];
}

export function resultsHeading(result: SearchResult): HTMLElement {
  const count =
    result.total === 1
      ? t('{n} word', {n: 1})
      : t('{n} words', {n: result.total.toLocaleString()});
  return h(
    'h2',
    {class: 'results-heading'},
    t('Words'),
    h('span', {class: 'count'}, ` — ${count}`),
    result.kana &&
      h(
        'span',
        {class: 'searched-as'},
        fill(t(' · also searched for {kana}'), {
          kana: searchLink(result.kana),
        }),
      ),
  );
}
