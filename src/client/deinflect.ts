/**
 * Rule-based deinflection in the style of Yomichan / 10ten: repeatedly strip
 * known inflection suffixes to find candidate dictionary forms, tracking what
 * word class each candidate must be. The caller checks candidates against the
 * dictionary and keeps only those whose part of speech matches.
 *
 * Example: 食べなかった
 *   → 食べない  (ADJ, "past")     via かった → い
 *   → 食べる    (V1, "negative")  via ない → る
 */

/** Word classes, as bit flags. */
export const WordType = {
  V1: 1 << 0, // ichidan verb
  V5: 1 << 1, // godan verb
  VK: 1 << 2, // 来る
  VS: 1 << 3, // する and する verbs written with it (愛する)
  VSN: 1 << 4, // noun that takes する (勉強)
  ADJ: 1 << 5, // i-adjective
  // Intermediate forms that are not dictionary words themselves.
  MASU: 1 << 6, // ends in ます
  STEM: 1 << 7, // masu stem (食べ, 書き)
  TE: 1 << 8, // te form
  PAST: 1 << 9, // ends in た/だ
} as const;

const {V1, V5, VK, VS, VSN, ADJ, MASU, STEM, TE, PAST} = WordType;

/** Types that can be looked up in the dictionary. */
export const DICTIONARY_TYPES = V1 | V5 | VK | VS | VSN | ADJ;

/** What the typed word may be. STEM is excluded so "" → "る" can't fire on raw input. */
const INITIAL_TYPES = V1 | V5 | VK | VS | ADJ | MASU | TE | PAST;

interface Rule {
  from: string;
  to: string;
  /** the inflected form must be one of these types */
  in: number;
  /** the type of the result */
  out: number;
  reason: string;
}

const rules: Rule[] = [];

function add(reason: string, inType: number, list: [string, string, number][]) {
  for (const [from, to, out] of list) {
    rules.push({from, to, in: inType, out, reason});
    // 来る is usually written with its kanji: 来た, 来ない, 来させる…
    if (out === VK && to.startsWith('く')) {
      rules.push({
        from: '来' + from.slice(1),
        to: '来る',
        in: inType,
        out,
        reason,
      });
    }
  }
}

/** Godan endings: [dictionary ending, a-row, i-row, e-row, o-row] */
const GODAN: [string, string, string, string, string][] = [
  ['う', 'わ', 'い', 'え', 'お'],
  ['く', 'か', 'き', 'け', 'こ'],
  ['ぐ', 'が', 'ぎ', 'げ', 'ご'],
  ['す', 'さ', 'し', 'せ', 'そ'],
  ['つ', 'た', 'ち', 'て', 'と'],
  ['ぬ', 'な', 'に', 'ね', 'の'],
  ['ぶ', 'ば', 'び', 'べ', 'ぼ'],
  ['む', 'ま', 'み', 'め', 'も'],
  ['る', 'ら', 'り', 'れ', 'ろ'],
];

function godan(row: 1 | 2 | 3 | 4, suffix: string): [string, string, number][] {
  return GODAN.map(
    g => [g[row] + suffix, g[0], V5] as [string, string, number],
  );
}

// masu stem → dictionary form
add('masu stem', STEM, [
  ['', 'る', V1],
  ...godan(2, ''),
  ['し', 'する', VS],
  ['き', 'くる', VK],
]);

// Polite
add('polite', MASU, [['ます', '', STEM]]);
// Each rule names only its own part, so ました reads as "polite, past".
add('past', INITIAL_TYPES, [['ました', 'ます', MASU]]);
add('negative', INITIAL_TYPES, [['ません', 'ます', MASU]]);
add('negative past', INITIAL_TYPES, [['ませんでした', 'ます', MASU]]);
add('volitional', INITIAL_TYPES, [['ましょう', 'ます', MASU]]);
add('te-form', INITIAL_TYPES, [['まして', 'ます', MASU]]);

// Past
add('past', PAST, [
  ['た', 'る', V1],
  ['った', 'う', V5],
  ['った', 'つ', V5],
  ['った', 'る', V5],
  ['いた', 'く', V5],
  ['いだ', 'ぐ', V5],
  ['した', 'す', V5],
  ['んだ', 'ぬ', V5],
  ['んだ', 'ぶ', V5],
  ['んだ', 'む', V5],
  ['行った', '行く', V5],
  ['いった', 'いく', V5],
  ['した', 'する', VS],
  ['きた', 'くる', VK],
  ['かった', 'い', ADJ],
]);
add('-tara', INITIAL_TYPES, [
  ['たら', 'た', PAST],
  ['だら', 'だ', PAST],
]);
add('-tari', INITIAL_TYPES, [
  ['たり', 'た', PAST],
  ['だり', 'だ', PAST],
]);

// Te form
add('te-form', TE, [
  ['て', 'る', V1],
  ['って', 'う', V5],
  ['って', 'つ', V5],
  ['って', 'る', V5],
  ['いて', 'く', V5],
  ['いで', 'ぐ', V5],
  ['して', 'す', V5],
  ['んで', 'ぬ', V5],
  ['んで', 'ぶ', V5],
  ['んで', 'む', V5],
  ['行って', '行く', V5],
  ['いって', 'いく', V5],
  ['して', 'する', VS],
  ['きて', 'くる', VK],
  ['くて', 'い', ADJ],
]);
add('progressive', V1, [
  ['ている', 'て', TE],
  ['でいる', 'で', TE],
  ['てる', 'て', TE],
  ['でる', 'で', TE],
]);
add('-te shimau', V5, [
  ['てしまう', 'て', TE],
  ['でしまう', 'で', TE],
  ['ちゃう', 'て', TE],
  ['じゃう', 'で', TE],
]);
add('-te aru', V5, [
  ['てある', 'て', TE],
  ['である', 'で', TE],
]);
add('-te oku', V5, [
  ['ておく', 'て', TE],
  ['でおく', 'で', TE],
  ['とく', 'て', TE],
  ['どく', 'で', TE],
]);
add('request', INITIAL_TYPES, [
  ['てください', 'て', TE],
  ['でください', 'で', TE],
]);

// Negative (inflects like an i-adjective: 食べなかった, 食べなくて)
add('negative', ADJ, [
  ['ない', 'る', V1],
  ...godan(1, 'ない'),
  ['しない', 'する', VS],
  ['こない', 'くる', VK],
  ['くない', 'い', ADJ],
]);
add('negative', INITIAL_TYPES, [
  ['ず', 'る', V1],
  ...godan(1, 'ず'),
  ['せず', 'する', VS],
  ['ずに', 'ず', INITIAL_TYPES],
]);

// Desire: 食べたい (inflects like an i-adjective)
add('-tai', ADJ, [['たい', '', STEM]]);
add('-nagara', INITIAL_TYPES, [['ながら', '', STEM]]);
add('imperative', INITIAL_TYPES, [['なさい', '', STEM]]);
add('-sou', INITIAL_TYPES, [
  ['そう', '', STEM],
  ['そう', 'い', ADJ],
]);

// Potential and passive (both inflect as ichidan verbs)
add('potential or passive', V1, [
  ['られる', 'る', V1],
  ['こられる', 'くる', VK],
]);
add('potential', V1, [
  ...godan(3, 'る'),
  ['できる', 'する', VS],
  ['これる', 'くる', VK],
]);
add('passive', V1, [...godan(1, 'れる'), ['される', 'する', VS]]);
add('causative', V1, [
  ['させる', 'る', V1],
  ...godan(1, 'せる'),
  ['させる', 'する', VS],
  ['こさせる', 'くる', VK],
]);

// Volitional
add('volitional', INITIAL_TYPES, [
  ['よう', 'る', V1],
  ...godan(4, 'う'),
  ['しよう', 'する', VS],
  ['こよう', 'くる', VK],
]);

// Conditional
add('conditional', INITIAL_TYPES, [
  ['れば', 'る', V1],
  ...godan(3, 'ば'),
  ['すれば', 'する', VS],
  ['くれば', 'くる', VK],
  ['ければ', 'い', ADJ],
]);

// Imperative
add('imperative', INITIAL_TYPES, [
  ['ろ', 'る', V1],
  ['よ', 'る', V1],
  ...godan(3, ''),
  ['しろ', 'する', VS],
  ['せよ', 'する', VS],
  ['こい', 'くる', VK],
]);

// Adjectives
add('adverb', INITIAL_TYPES, [['く', 'い', ADJ]]);
add('noun', INITIAL_TYPES, [['さ', 'い', ADJ]]);

// する nouns: 勉強する → 勉強
add('suru verb', VS, [['する', '', VSN]]);

export interface Deinflection {
  /** candidate dictionary form */
  term: string;
  /** the word types the dictionary entry must have */
  type: number;
  /** inflections removed, outermost first ("polite", "past") */
  reasons: string[];
}

const MAX_DEPTH = 8;

/** Reasons that already imply the te-form, so it isn't listed again. */
const TE_AUXILIARIES = new Set([
  'progressive',
  '-te shimau',
  '-te aru',
  '-te oku',
  'request',
]);

/**
 * All candidate dictionary forms of `word`, including `word` itself (with no
 * reasons). Candidates whose type is only an intermediate form are dropped.
 */
export function deinflect(word: string): Deinflection[] {
  const results: Deinflection[] = [
    {term: word, type: INITIAL_TYPES, reasons: []},
  ];
  const seen = new Set([`${word}:${INITIAL_TYPES}`]);
  for (let i = 0; i < results.length; i++) {
    const {term, type, reasons} = results[i];
    if (reasons.length >= MAX_DEPTH) continue;
    for (const rule of rules) {
      if (!(type & rule.in) || !term.endsWith(rule.from)) continue;
      const stem = term.slice(0, term.length - rule.from.length);
      const next = stem + rule.to;
      if (next.length === 0) continue;
      const key = `${next}:${rule.out}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // The masu-stem step is an implementation detail, and "progressive"
      // already says te-form, so neither is worth showing.
      const implied =
        rule.reason === 'masu stem' ||
        (rule.reason === 'te-form' && TE_AUXILIARIES.has(reasons.at(-1)!));
      const newReasons = implied ? reasons : [...reasons, rule.reason];
      results.push({term: next, type: rule.out, reasons: newReasons});
    }
  }
  return results.filter((r, i) => i === 0 || (r.type & DICTIONARY_TYPES) !== 0);
}

/** The word types of a JMdict part-of-speech tag. */
export function posToType(pos: string): number {
  if (pos.startsWith('v1')) return V1;
  if (pos.startsWith('v5')) return V5;
  if (pos === 'vk') return VK;
  if (pos === 'vs-i' || pos === 'vs-s') return VS;
  if (pos === 'vs') return VSN;
  if (pos === 'adj-i' || pos === 'adj-ix') return ADJ;
  return 0;
}
