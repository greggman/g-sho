/**
 * Japanese definitions (国語) from the Japanese Wiktionary, as extracted by
 * wiktextract (kaikki.org), matched to JMdict entries.
 *
 * Wiktionary often keeps a native word's definition under its kana
 * spelling; the kanji spelling's entry just says "たべるの漢字表記" and
 * points there (form_of). So a JMdict entry is matched by:
 *
 *   1. a kanji form: a form_of pointer to one of the entry's readings, or a
 *      real entry whose listed readings include one of them (or lists none);
 *   2. failing that, a reading: accepted when its listed kanji spellings
 *      include one of the entry's, or the word is written in kana (so
 *      homophones like かみ 紙/神/髪 don't get each other's definitions).
 *
 * A kana page can hold several words (かう: 買う, 飼う, 支う, 交う), each
 * kanji spelling pointing to the page. The page's headings say which is
 * which ("{{verb}}:買う"), but the extract leaves them out, so they're read
 * from Wikimedia's dump (wiktionary-headings.ts).
 *
 * Without them (the headings don't name the word), it's a guess. Several
 * entries with the same part of speech are different words (one word's
 * adverb and adjective are one word), so each of those goes to the word
 * pointing there whose English glosses share the most of its English
 * translations (buy, purchase → 買う; see, meet, encounter → 会う, not 合う,
 * which also means "to meet") (assignKanaPages). The rest, with no English
 * to tell them by, go to the words that didn't get one of those.
 *
 * A kanji spelling's entry often covers several readings, marking each
 * sense with them: "【うえ、かみ】頭の方向" or "（セイ）いのち". Only the senses
 * for the word's own readings (or spellings) are kept, without the mark.
 *
 * Kanji-character entries (pos "character") and names are left out.
 */
import * as fs from 'node:fs';
import * as readline from 'node:readline';
import * as zlib from 'node:zlib';
import {isAllKana} from '../src/shared/kana.ts';
import {normalizeJa} from '../src/shared/normalize.ts';
import {sectionFor, type Section} from './wiktionary-headings.ts';
import type {JaDefinition, JaSense} from '../src/shared/types.ts';

export interface WordForms {
  id: number;
  kanji: string[];
  kana: string[];
  /** the word is usually written in kana */
  usuallyKana: boolean;
  /** its English glosses (JMdict), to tell a kana page's words apart */
  glosses?: string[];
  /** its parts of speech (JMdict's: v5u, n, adj-i, …), for the same */
  pos?: string[];
}

/** JMdict parts of speech → the Wiktionary ones they can be. */
function wiktionaryPos(jmdict: string): string[] {
  if (/^v(s|z)/.test(jmdict)) return ['verb', 'noun'];
  if (/^(v|aux-v)/.test(jmdict)) return ['verb'];
  if (/^adj-(na|nari|t)$/.test(jmdict)) return ['adj_noun', 'noun'];
  if (jmdict === 'adj-pn') return ['adnominal'];
  if (/^(adj|aux-adj)/.test(jmdict)) return ['adj'];
  if (/^adv/.test(jmdict)) return ['adv'];
  if (jmdict === 'int') return ['intj'];
  if (/^(n|pn|num|ctr|adj-no)/.test(jmdict)) return ['noun', 'pron', 'num'];
  return [];
}

/** Parts of speech a JMdict word and a Wiktionary entry are compared by. */
const COMPARED = new Set(['verb', 'noun', 'adj', 'adj_noun', 'adv', 'intj']);

/**
 * Whether a Wiktionary entry's part of speech can be the word's; true
 * when either isn't one that's compared.
 */
function samePos(w: WordForms, e: WiktEntry): boolean {
  if (!w.pos?.length || !COMPARED.has(e.pos)) return true;
  return w.pos.some(p => wiktionaryPos(p).includes(e.pos));
}

interface WiktEntry {
  pos: string;
  posTitle: string;
  senses: JaSense[];
  /** readings (normalized) */
  readings: Set<string>;
  /**
   * For an entry about a kanji (its readings tagged on/kun): its kun
   * readings. Unmarked senses then belong to the word only if it's read
   * with the entry's one kun reading.
   */
  kun?: Set<string>;
  /** kanji spellings listed for a kana word */
  kanji: Set<string>;
  /** the kanji are from the page's headings: it's that word, not the kana one */
  kanjiFromHeading?: boolean;
  /** for a "の漢字表記" pointer: the kana words it points to */
  formOf: string[];
  /** its English translations, normalized (englishKey) */
  english: Set<string>;
}

interface RawSense {
  glosses?: string[];
  examples?: {text?: string}[];
  raw_tags?: string[];
  ruby?: [string, string][];
  form_of?: {word: string}[];
}

interface RawEntry {
  word: string;
  lang_code: string;
  pos: string;
  pos_title?: string;
  senses?: RawSense[];
  forms?: {form: string; tags?: string[]}[];
  translations?: {lang_code?: string; word?: string}[];
}

/** Translations too general to tell words apart ("be": 居る and 要る). */
const GENERIC = new Set(['be', 'have', 'do', 'get', 'take', 'make', 'go']);

/**
 * An English word or gloss, comparable: "to buy (something)" → "buy",
 * "to be needed" → "needed".
 */
export function englishKey(s: string): string {
  return s
    .replace(/\([^)]*\)/g, '')
    .toLowerCase()
    .replace(/^\s*to\s+/, '')
    .replace(/^be\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const MAX_SENSES = 10;
const MAX_EXAMPLES = 2;
const MAX_GLOSS = 400;
const MAX_EXAMPLE = 150;
/** A gloss that only says "kanji spelling of …". */
const POINTER = /の(漢字|かな|仮名)?表記。?$/;

function convertSense(s: RawSense): JaSense | undefined {
  // Sub-senses list the parent's gloss first; the last is this sense's own.
  const gloss = s.glosses?.at(-1)?.trim();
  if (!gloss || POINTER.test(gloss)) return undefined;
  // Cross-references with nothing else in them.
  if (/^[:：]/.test(gloss) || /^(詳細は)?.{0,10}同項を参照/.test(gloss))
    return undefined;
  const out: JaSense = {g: gloss.slice(0, MAX_GLOSS)};
  const ex = (s.examples ?? [])
    .map(e => e.text?.trim())
    .filter((t): t is string => !!t && t.length <= MAX_EXAMPLE)
    .slice(0, MAX_EXAMPLES);
  if (ex.length) out.ex = ex;
  const tags = (s.raw_tags ?? []).filter(t => t.length <= 12).slice(0, 3);
  if (tags.length) out.t = tags;
  // Furigana hints for hard words in the gloss.
  const ruby = (s.ruby ?? []).filter(
    ([base, rt]) => base && rt && gloss.includes(base),
  );
  if (ruby.length) out.r = ruby;
  return out;
}

/** Reads the Japanese entries of the extract, by word. */
export async function readWiktionary(
  file: string,
  /** each kana page's word sections (wiktionary-headings.ts), if read */
  sections: Record<string, Section[]> = {},
  /**
   * Whether a word is a spelling of a reading (JMdict's), to tell a
   * heading's spelling (買う) from the field some name (料理, 相撲)
   */
  isSpelling: (word: string, reading: string) => boolean = () => true,
): Promise<Map<string, WiktEntry[]>> {
  const byWord = new Map<string, WiktEntry[]>();
  const lines = readline.createInterface({
    input: fs.createReadStream(file).pipe(zlib.createGunzip()),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    // Skip other languages without parsing every line in full.
    if (
      !line.includes('"lang_code": "ja"') &&
      !line.includes('"lang_code":"ja"')
    ) {
      continue;
    }
    const raw = JSON.parse(line) as RawEntry;
    if (raw.lang_code !== 'ja' || raw.pos === 'name') continue;
    const formOf = (raw.senses ?? []).flatMap(s =>
      (s.form_of ?? []).map(f => f.word),
    );
    const senses = (raw.senses ?? [])
      .map(convertSense)
      .filter((s): s is JaSense => !!s)
      .slice(0, MAX_SENSES);
    if (!senses.length && !formOf.length) continue;
    // Kanji-character entries describe the character, not a word.
    if (raw.pos === 'character' && !formOf.length) continue;
    const forms = raw.forms ?? [];
    const entry: WiktEntry = {
      pos: raw.pos,
      posTitle: raw.pos_title ?? '',
      senses,
      readings: new Set(
        forms
          .filter(f => f.tags?.includes('transliteration'))
          .map(f => normalizeJa(f.form)),
      ),
      kanji: new Set(
        forms.filter(f => f.tags?.includes('kanji')).map(f => f.form),
      ),
      formOf,
      english: new Set(
        (raw.translations ?? [])
          .filter(t => t.lang_code === 'en' && t.word)
          .map(t => englishKey(t.word!))
          .filter(t => t && !GENERIC.has(t)),
      ),
    };
    const tagged = forms.filter(f =>
      f.tags?.some(
        t => t === 'kun' || t === 'go-on' || t === 'kan-on' || t === 'on',
      ),
    );
    if (tagged.length) {
      entry.kun = new Set(
        tagged
          .filter(f => f.tags?.includes('kun'))
          .map(f => normalizeJa(f.form)),
      );
    }
    let list = byWord.get(raw.word);
    if (!list) byWord.set(raw.word, (list = []));
    list.push(entry);
  }
  // The kanji of entries that don't say, from their page's headings: the
  // ones that are its spellings, in JMdict or by a Wiktionary page of
  // theirs pointing to it.
  const spelling = (k: string, reading: string) =>
    isSpelling(k, reading) ||
    (byWord.get(k) ?? []).some(e => e.formOf.includes(reading));
  for (const [word, list] of byWord) {
    const page = sections[word];
    if (!page) continue;
    for (const e of list) {
      if (e.kanji.size || !e.senses.length) continue;
      const kanji = sectionFor(e.senses[0].g, page)?.w.filter(k =>
        spelling(k, word),
      );
      if (kanji?.length) {
        e.kanji = new Set(kanji);
        e.kanjiFromHeading = true;
      }
    }
  }
  return byWord;
}

/** A sense's leading "【うえ、かみ】" / "（セイ）": the readings or spellings it's for. */
const MARK = /^\s*[【（(]([^】）)]{1,30})[】）)]\s*/;

/**
 * The entry's senses that apply to the word: unmarked ones, and ones marked
 * with one of its readings or spellings (the mark removed).
 */
function sensesFor(
  e: WiktEntry,
  readings: Set<string>,
  kanji: Set<string>,
): JaSense[] {
  const out: JaSense[] = [];
  const unmarkedApply =
    !e.kun || (e.kun.size === 1 && readings.has([...e.kun][0]));
  for (const s of e.senses) {
    const m = MARK.exec(s.g);
    const parts = m?.[1].split(/[、,・，\s]+/).filter(Boolean) ?? [];
    // Only a list of readings or spellings is a mark; "（広告などで）" isn't.
    const isMark =
      parts.length > 0 &&
      // Readings, or spellings: kanji and a little kana (上る), not
      // "（生物がそこに）存在する".
      parts.every(
        p =>
          isAllKana(p) ||
          /^[\u3400-\u9fff\uf900-\ufaff々]+[ぁ-ん]{0,3}$/.test(p),
      ) &&
      parts.some(
        p => isAllKana(p) || kanji.has(p) || /[\u4e00-\u9fff]/.test(p),
      ) &&
      !parts.some(p => /[a-zA-Zなどでにはをの]{2,}/.test(p) && !isAllKana(p));
    if (!m || !isMark) {
      if (unmarkedApply) out.push(s);
      continue;
    }
    // A spelling, or its first kanji: 【耐、堪】 is for 耐える and 堪える.
    const applies = parts.some(p =>
      isAllKana(p)
        ? readings.has(normalizeJa(p))
        : kanji.has(p) ||
          (Array.from(p).length === 1 && [...kanji].some(k => k[0] === p)),
    );
    if (applies) out.push({...s, g: s.g.slice(m[0].length) || s.g});
  }
  return out;
}

/**
 * Whether an entry's kanji are for this spelling: it, or its first kanji
 * alone (たえる's heading names 耐・堪 for 耐える, 堪える).
 */
function writes(kanji: Set<string>, spelling: string): boolean {
  return (
    kanji.has(spelling) ||
    [...kanji].some(k => Array.from(k).length === 1 && spelling[0] === k)
  );
}

const real = (list: WiktEntry[] | undefined) =>
  (list ?? []).filter(e => !e.formOf.length || e.senses.length);

/** The kana words `k` (one of w's spellings) points to that w is read as. */
function pointers(
  w: WordForms,
  k: string,
  byWord: Map<string, WiktEntry[]>,
): string[] {
  const readings = new Set(w.kana.map(normalizeJa));
  return (byWord.get(k) ?? []).flatMap(e =>
    e.formOf.filter(t => readings.has(normalizeJa(t))),
  );
}

/**
 * Whether a page's entry is one of several that don't say which kanji
 * they're for and have the same part of speech: different words, which
 * need telling apart (assignKanaPages).
 */
function ambiguous(e: WiktEntry, page: WiktEntry[]): boolean {
  if (e.kanji.size) return false;
  return page.filter(t => t.pos === e.pos).length > 1;
}

/** How many of the entry's English translations the glosses share. */
function sharedEnglish(e: WiktEntry, glosses: string[]): number {
  return [...e.english].filter(t =>
    glosses.some(g => g === t || g.startsWith(`${t} `)),
  ).length;
}

/**
 * For kana pages with several entries that don't say which kanji they're
 * for: which word (id) each entry is, of the words whose spellings point
 * to the page. The one sharing the most English; none on a tie or none.
 */
export function assignKanaPages(
  words: WordForms[],
  byWord: Map<string, WiktEntry[]>,
): Map<WiktEntry, number> {
  const best = new Map<WiktEntry, {id?: number; score: number}>();
  for (const w of words) {
    const glosses = (w.glosses ?? []).map(englishKey);
    const targets = new Set(
      w.kanji.slice(0, 4).flatMap(k => pointers(w, k, byWord)),
    );
    // A word written in kana is matched by its reading too.
    if (!w.kanji.length || w.usuallyKana) {
      for (const r of w.kana.slice(0, 3)) targets.add(r);
    }
    for (const target of targets) {
      const page = real(byWord.get(target));
      for (const e of page.filter(t => ambiguous(t, page))) {
        const score = sharedEnglish(e, glosses);
        if (!score) continue;
        const b = best.get(e);
        if (!b || score > b.score) best.set(e, {id: w.id, score});
        else if (score === b.score && b.id !== w.id) b.id = undefined;
      }
    }
  }
  const out = new Map<WiktEntry, number>();
  for (const [e, {id}] of best) if (id !== undefined) out.set(e, id);
  return out;
}

/**
 * The Japanese definitions of this JMdict word, if Wiktionary has it.
 * `owners`: assignKanaPages.
 */
export function matchWord(
  w: WordForms,
  byWord: Map<string, WiktEntry[]>,
  owners: Map<WiktEntry, number> = new Map(),
): JaDefinition[] {
  const readings = new Set(w.kana.map(normalizeJa));
  const kanji = new Set(w.kanji);
  const found: JaDefinition[] = [];
  const seen = new Set<WiktEntry>();
  const add = (e: WiktEntry) => {
    if (seen.has(e)) return;
    seen.add(e);
    const senses = sensesFor(e, readings, kanji);
    if (senses.length) found.push({p: e.posTitle, s: senses});
  };
  /**
   * Whether an entry that doesn't say its kanji is this word's: when it's
   * the only one of its part of speech on the page; of several, when it
   * was assigned to this word, or to none and this word got none of them
   * (by English, or by its headings) and can be its part of speech.
   */
  const mine = (e: WiktEntry, page: WiktEntry[]): boolean => {
    if (!ambiguous(e, page)) return true;
    const owner = owners.get(e);
    if (owner !== undefined) return owner === w.id;
    if (!samePos(w, e)) return false;
    return !page.some(
      o =>
        o.pos === e.pos &&
        (owners.get(o) === w.id || w.kanji.some(k => writes(o.kanji, k))),
    );
  };
  /** A kana page's entries that a kanji spelling's pointer there means. */
  const pointedTo = (k: string, target: string): WiktEntry[] => {
    const page = real(byWord.get(target));
    return page.filter(t =>
      t.kanji.size ? writes(t.kanji, k) : mine(t, page),
    );
  };

  for (const k of w.kanji.slice(0, 4)) {
    for (const e of byWord.get(k) ?? []) {
      if (e.formOf.length) {
        for (const target of e.formOf) {
          if (!readings.has(normalizeJa(target))) continue;
          for (const t of pointedTo(k, target)) add(t);
        }
      } else if (
        !e.readings.size ||
        [...e.readings].some(r => readings.has(r))
      ) {
        add(e);
      }
    }
  }
  if (found.length) return found;
  for (const r of w.kana.slice(0, 3)) {
    const page = real(byWord.get(r));
    for (const e of page) {
      const kanjiMatch = w.kanji.some(k => writes(e.kanji, k));
      const kanaWord = !kanji.size || (w.usuallyKana && !e.kanji.size);
      if (
        kanjiMatch ||
        (kanaWord && (e.kanji.size ? !e.kanjiFromHeading : mine(e, page)))
      ) {
        add(e);
      }
    }
  }
  return found;
}
