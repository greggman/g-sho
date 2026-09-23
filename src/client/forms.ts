import {isAllKana, isKana, isKanji, toHiragana} from '../shared/kana.ts';
import type {Entry, KanjiForm, ReadingForm} from '../shared/types.ts';

/** Tags for spellings that shouldn't be shown as the headword. */
const HIDDEN_TAGS = new Set(['rK', 'sK', 'oK', 'iK', 'rk', 'sk', 'ok', 'ik']);

function isShown(f: KanjiForm | ReadingForm): boolean {
  return !f.tg?.some(t => HIDDEN_TAGS.has(t));
}

function readingAppliesTo(r: ReadingForm, kanji: string): boolean {
  return r.a === undefined || r.a.includes(kanji);
}

export interface Headword {
  /** how the word is written */
  text: string;
  /** its reading, when text isn't already kana */
  reading?: string;
}

/**
 * The form to show as the entry's headword: its first normal kanji spelling
 * with the matching reading, or its reading when the word is usually written
 * in kana or has no normal kanji spelling.
 */
export function headword(entry: Entry): Headword {
  const readings = entry.r.filter(isShown);
  const reading = readings[0] ?? entry.r[0];
  const kanji = entry.k?.find(isShown);
  const usuallyKana = entry.s[0]?.m?.includes('uk') ?? false;
  if (!kanji || usuallyKana) return {text: reading.t};
  const r = readings.find(r => readingAppliesTo(r, kanji.t)) ?? reading;
  return {text: kanji.t, reading: r.t};
}

/** Every spelling/reading pair other than the headword, like 喰べる【たべる】. */
export function otherForms(entry: Entry): Headword[] {
  const head = headword(entry);
  const out: Headword[] = [];
  for (const k of entry.k ?? []) {
    for (const r of entry.r) {
      if (!readingAppliesTo(r, k.t)) continue;
      if (k.t === head.text && r.t === head.reading) continue;
      out.push({text: k.t, reading: r.t});
    }
  }
  for (const r of entry.r) {
    if (r.t === head.text) continue;
    // Readings with no kanji spelling, or all readings when the headword is kana.
    if ((r.a && r.a.length === 0) || head.reading === undefined) {
      out.push({text: r.t});
    }
  }
  return out;
}

/** A piece of a word and the furigana over it (if any). */
export type {RubyPart} from '../shared/furigana.ts';
import type {RubyPart} from '../shared/furigana.ts';

/**
 * Splits a word into parts with furigana over just the kanji:
 * 食べる + たべる → [["食", "た"], ["べる"]].
 * Falls back to one part with the whole reading when they can't be aligned.
 */
export function furigana(text: string, reading: string): RubyPart[] {
  // Runs of kana and non-kana: 食べ物 → ["食", "べ", "物"]
  const runs: string[] = [];
  for (const ch of text) {
    const last = runs.length - 1;
    if (last >= 0 && isKana(runs[last][0]) === isKana(ch)) {
      runs[last] += ch;
    } else {
      runs.push(ch);
    }
  }
  const pattern = runs
    .map(run => (isKana(run[0]) ? escapeRegExp(toHiragana(run)) : '(.+?)'))
    .join('');
  // The "d" flag records where each group matched. Hiragana conversion
  // doesn't change string length, so the offsets also apply to `reading`.
  const m = new RegExp(`^${pattern}$`, 'd').exec(toHiragana(reading));
  if (!m?.indices) return [[text, reading]];
  const indices = m.indices;
  let group = 1;
  return runs.map(run => {
    if (isKana(run[0])) return [run];
    const [start, end] = indices[group++]!;
    return [run, reading.slice(start, end)];
  });
}

/**
 * Furigana for a word as it appears in text, using its dictionary entry.
 * For an inflected word, the dictionary form's furigana is carried over as
 * far as the two match: 食べました (base 食べる, read たべる) →
 * [["食", "た"], ["べました"]].
 */
export function surfaceFurigana(
  surface: string,
  entry: Entry,
  base = surface,
): RubyPart[] {
  if (isAllKana(surface)) return [[surface]];
  const kanji = entry.k?.find(k => k.t === base);
  const reading = kanji && entry.r.find(r => readingAppliesTo(r, kanji.t));
  if (!kanji || !reading) return [[surface]];
  const out: RubyPart[] = [];
  let pos = 0;
  for (const part of furigana(kanji.t, reading.t)) {
    if (!surface.startsWith(part[0], pos)) break;
    out.push(part);
    pos += part[0].length;
  }
  const rest = surface.slice(pos);
  // Kanji left without furigana means the forms diverged too early.
  if (Array.from(rest).some(isKanji)) return [[surface]];
  if (rest) out.push([rest]);
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
