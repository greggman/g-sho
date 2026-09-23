import {toHiragana} from './kana.ts';

/**
 * Normalizes a Japanese dictionary key or query so that different spellings
 * find the same index entry: NFKC (full-width ASCII → half-width, half-width
 * katakana → full-width), katakana → hiragana, lowercase.
 */
export function normalizeJa(s: string): string {
  return toHiragana(s.normalize('NFKC')).toLowerCase().trim();
}

/** Words that are too common in glosses to be worth indexing or searching. */
export const EN_STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'to',
  'of',
  'or',
  'and',
  'e.g.',
  'etc',
  'sth',
  'something',
  'someone',
  "one's",
]);

/** Splits English text into lowercase word tokens. */
export function tokenizeEn(s: string): string[] {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .split(/[^a-z0-9'-]+/)
    .map(w => w.replace(/^['-]+|['-]+$/g, ''))
    .filter(w => w.length > 0);
}

/**
 * The "core" of a gloss for exact-match comparison: parentheticals removed,
 * leading "to"/"a"/"an"/"the" removed, lowercased.
 * "to eat (a meal)" → "eat".
 */
export function glossCore(gloss: string): string {
  let s = gloss.toLowerCase();
  // Innermost parentheses first, for nesting like "dog (Canis (lupus) familiaris)".
  for (let prev = ''; prev !== s;) {
    prev = s;
    s = s.replace(/\([^()]*\)/g, ' ');
  }
  return s
    .replace(/^\s*(to|a|an|the)\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}
