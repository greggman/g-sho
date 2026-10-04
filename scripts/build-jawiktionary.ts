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
import type {JaDefinition, JaSense} from '../src/shared/types.ts';

export interface WordForms {
  id: number;
  kanji: string[];
  kana: string[];
  /** the word is usually written in kana */
  usuallyKana: boolean;
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
  /** for a "の漢字表記" pointer: the kana words it points to */
  formOf: string[];
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
      parts.every(p => isAllKana(p) || p.length <= 6) &&
      parts.some(
        p => isAllKana(p) || kanji.has(p) || /[\u4e00-\u9fff]/.test(p),
      ) &&
      !parts.some(p => /[a-zA-Zなどでにはをの]{2,}/.test(p) && !isAllKana(p));
    if (!m || !isMark) {
      if (unmarkedApply) out.push(s);
      continue;
    }
    const applies = parts.some(p =>
      isAllKana(p) ? readings.has(normalizeJa(p)) : kanji.has(p),
    );
    if (applies) out.push({...s, g: s.g.slice(m[0].length) || s.g});
  }
  return out;
}

/** The Japanese definitions of this JMdict word, if Wiktionary has it. */
export function matchWord(
  w: WordForms,
  byWord: Map<string, WiktEntry[]>,
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
  const real = (list: WiktEntry[] | undefined) =>
    (list ?? []).filter(e => !e.formOf.length || e.senses.length);

  for (const k of w.kanji.slice(0, 4)) {
    for (const e of byWord.get(k) ?? []) {
      if (e.formOf.length) {
        for (const target of e.formOf) {
          if (!readings.has(normalizeJa(target))) continue;
          for (const t of real(byWord.get(target))) {
            if (!t.kanji.size || t.kanji.has(k)) add(t);
          }
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
    for (const e of real(byWord.get(r))) {
      const kanjiMatch = [...e.kanji].some(k => kanji.has(k));
      if (!kanji.size || kanjiMatch || (w.usuallyKana && !e.kanji.size)) add(e);
    }
  }
  return found;
}
