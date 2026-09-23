import {hasJapanese, isKana, isKanji} from '../shared/kana.ts';
import {
  EN_STOP_WORDS,
  glossCore,
  normalizeJa,
  tokenizeEn,
} from '../shared/normalize.ts';
import type {Entry} from '../shared/types.ts';
import {deinflect, posToType, type Deinflection} from './deinflect.ts';
import type {Dict, JaHit} from './dict.ts';
import {romajiToKana} from './romaji.ts';

export const PAGE_SIZE = 20;

/** Longest run of characters tried as one word when splitting a sentence. */
const MAX_WORD_LENGTH = 12;

/** An English index score at or above this means a gloss matched the query exactly. */
const EN_EXACT_SCORE = 55;

export interface Inflection {
  /** what was typed */
  from: string;
  /** the dictionary form it was matched to */
  to: string;
  /** inflections, outermost first */
  reasons: string[];
}

export interface WordResult {
  entry: Entry;
  inflection?: Inflection;
}

/** One word of a sentence. */
export interface Token {
  text: string;
  /** false for punctuation, latin text, and characters not in the dictionary */
  known: boolean;
  /** dictionary form, if the token is inflected */
  base?: string;
  reasons?: string[];
}

export interface SearchResult {
  query: string;
  /** the kana a romaji query was read as */
  kana?: string;
  /** set when the query was split into words */
  tokens?: Token[];
  /** which token the words are for */
  selectedToken?: number;
  words: WordResult[];
  /** total number of matching words (words holds one page of them) */
  total: number;
}

/** A ranked, not-yet-fetched result. */
interface Candidate {
  id: number;
  inflection?: Inflection;
}

function entryTypes(entry: Entry): number {
  let type = 0;
  for (const s of entry.s) {
    for (const p of s.p ?? []) type |= posToType(p);
  }
  return type;
}

/** Entries among `hits` whose part of speech allows the deinflection. */
async function matchingHits(
  dict: Dict,
  d: Deinflection,
  hits: JaHit[],
): Promise<JaHit[]> {
  if (d.reasons.length === 0) return hits;
  const entries = await dict.entries(hits.map(h => h.id));
  const ok = new Set(
    entries.filter(e => entryTypes(e) & d.type).map(e => e.id),
  );
  return hits.filter(h => ok.has(h.id));
}

/**
 * Ranked Japanese matches for `text`: exact and deinflected matches, then
 * words that start with it.
 */
async function rankJapanese(dict: Dict, text: string): Promise<Candidate[]> {
  const key = normalizeJa(text);
  if (!key) return [];

  // tier: 0 common exact/deinflected, 1 other exact/deinflected,
  // 2 common prefix, 3 other prefix
  const tiers: Candidate[][] = [[], [], [], []];
  const seen = new Set<number>();
  const push = (tier: number, c: Candidate) => {
    if (!seen.has(c.id)) {
      seen.add(c.id);
      tiers[tier].push(c);
    }
  };

  const deinflections = deinflect(key);
  const matches = await Promise.all(
    deinflections.map(async d => ({
      d,
      hits: await matchingHits(dict, d, await dict.lookupJa(d.term)),
    })),
  );
  // Exact matches before deinflected ones, fewer inflection steps first.
  matches.sort((a, b) => a.d.reasons.length - b.d.reasons.length);
  for (const {d, hits} of matches) {
    const inflection =
      d.reasons.length > 0
        ? {from: text, to: d.term, reasons: d.reasons}
        : undefined;
    for (const h of hits) {
      push(h.common ? 0 : 1, {id: h.id, inflection});
    }
  }

  const prefixed = await dict.jaKeysWithPrefix(key);
  prefixed.sort(
    ([ka], [kb]) => ka.length - kb.length || (ka < kb ? -1 : ka > kb ? 1 : 0),
  );
  for (const [, hits] of prefixed) {
    for (const h of hits) push(h.common ? 2 : 3, {id: h.id});
  }
  return tiers.flat();
}

/** Ranked English matches, and whether the best one is an exact gloss match. */
async function rankEnglish(
  dict: Dict,
  text: string,
): Promise<{candidates: Candidate[]; exact: boolean}> {
  const tokens = tokenizeEn(glossCore(text));
  const words = tokens.filter(t => !EN_STOP_WORDS.has(t));
  if (words.length === 0) return {candidates: [], exact: false};

  const scores = new Map<number, number>();
  if (words.length === 1) {
    for (const [id, score] of await dict.lookupEn(words[0])) {
      scores.set(id, score);
    }
  } else {
    // Exact phrase matches first, then entries by how many of the words
    // their glosses contain.
    const [phrase, ...lists] = await Promise.all([
      dict.lookupEn(tokens.join(' ')),
      ...words.map(w => dict.lookupEn(w)),
    ]);
    const matched = new Map<number, {count: number; total: number}>();
    for (const list of lists) {
      for (const [id, score] of list) {
        const m = matched.get(id) ?? {count: 0, total: 0};
        m.count++;
        m.total += score;
        matched.set(id, m);
      }
    }
    for (const [id, {count, total}] of matched) {
      scores.set(id, (count - words.length) * 100 + total / words.length);
    }
    for (const [id, score] of phrase) scores.set(id, score + 100);
  }
  const ranked = [...scores].sort((a, b) => b[1] - a[1]);
  return {
    candidates: ranked.map(([id]) => ({id})),
    exact: ranked.length > 0 && ranked[0][1] >= EN_EXACT_SCORE,
  };
}

/**
 * Finds the dictionary word that `surface` is, or is an inflection of.
 */
async function matchWord(
  dict: Dict,
  surface: string,
): Promise<Deinflection | undefined> {
  for (const d of deinflect(normalizeJa(surface))) {
    const hits = await dict.lookupJa(d.term);
    if (hits.length === 0) continue;
    if ((await matchingHits(dict, d, hits.slice(0, 5))).length > 0) return d;
  }
  return undefined;
}

function isWordChar(ch: string): boolean {
  return isKana(ch) || isKanji(ch);
}

/**
 * Splits Japanese text into words by greedy longest match: at each position,
 * take the longest run of characters that is a dictionary word or an
 * inflection of one.
 */
export async function segment(dict: Dict, text: string): Promise<Token[]> {
  const chars = Array.from(text);
  const tokens: Token[] = [];
  let i = 0;
  while (i < chars.length) {
    if (!isWordChar(chars[i])) {
      // Punctuation, spaces, latin text: one token per run.
      let j = i;
      while (j < chars.length && !isWordChar(chars[j])) j++;
      tokens.push({text: chars.slice(i, j).join(''), known: false});
      i = j;
      continue;
    }
    let end = i;
    while (
      end < chars.length &&
      end - i < MAX_WORD_LENGTH &&
      isWordChar(chars[end])
    ) {
      end++;
    }
    let token: Token = {text: chars[i], known: false};
    for (let len = end - i; len >= 1; len--) {
      const surface = chars.slice(i, i + len).join('');
      const match = await matchWord(dict, surface);
      if (match) {
        token = {text: surface, known: true};
        if (match.reasons.length > 0) {
          token.base = match.term;
          token.reasons = match.reasons;
        }
        break;
      }
    }
    tokens.push(token);
    i += Array.from(token.text).length;
  }
  return tokens;
}

async function fetchPage(
  dict: Dict,
  candidates: Candidate[],
  page: number,
): Promise<WordResult[]> {
  const slice = candidates.slice(0, PAGE_SIZE * page);
  const entries = await dict.entries(slice.map(c => c.id));
  const byId = new Map(entries.map(e => [e.id, e]));
  return slice.flatMap(c => {
    const entry = byId.get(c.id);
    return entry ? [{entry, inflection: c.inflection}] : [];
  });
}

export interface SearchOptions {
  /** number of pages of results to return */
  pages?: number;
  /** for sentences, which token to show words for */
  token?: number;
}

export async function search(
  dict: Dict,
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const pages = options.pages ?? 1;
  const q = query.trim();
  if (!q) return {query: q, words: [], total: 0};

  if (hasJapanese(q)) {
    const candidates = await rankJapanese(dict, q);
    // Text that isn't a word, an inflection of one, or the start of one is
    // treated as a sentence.
    if (candidates.length === 0 && Array.from(q).length > 1) {
      const tokens = await segment(dict, q);
      const known = tokens.filter(t => t.known);
      if (tokens.length > 1 && known.length > 0) {
        const selected =
          options.token !== undefined && tokens[options.token]?.known
            ? options.token
            : tokens.indexOf(known[0]);
        const token = tokens[selected];
        const words = await rankJapanese(dict, token.text);
        return {
          query: q,
          tokens,
          selectedToken: selected,
          words: await fetchPage(dict, words, pages),
          total: words.length,
        };
      }
    }
    return {
      query: q,
      words: await fetchPage(dict, candidates, pages),
      total: candidates.length,
    };
  }

  const kana = romajiToKana(q);
  const en = await rankEnglish(dict, q);
  if (!kana) {
    return {
      query: q,
      words: await fetchPage(dict, en.candidates, pages),
      total: en.candidates.length,
    };
  }

  // Could be romaji or English. Put the Japanese matches first unless the
  // query is an exact English gloss ("sushi" and "taberu" both read as kana,
  // but only "sushi" is also an English word).
  const ja = await rankJapanese(dict, kana);
  const jaExact = await isWholeWord(dict, kana);
  const first = jaExact && !en.exact ? ja : en.candidates;
  const second = first === ja ? en.candidates : ja;
  const seen = new Set<number>();
  const merged = [...first, ...second].filter(c => {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });
  return {
    query: q,
    kana: ja.length > 0 ? kana : undefined,
    words: await fetchPage(dict, merged, pages),
    total: merged.length,
  };
}

/** True if `text` is a dictionary word or an inflection of one. */
async function isWholeWord(dict: Dict, text: string): Promise<boolean> {
  return (await matchWord(dict, text)) !== undefined;
}
