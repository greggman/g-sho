/**
 * Linking imported notes to dictionary entries, so a deck's words can be
 * matched with words you already know (duplicates) and looked up.
 */
import {normalizeJa} from '../../../shared/normalize.ts';
import {isAllKana} from '../../../shared/kana.ts';
import type {Dict} from '../../dict.ts';
import {guessSource} from '../note.ts';
import {stripHtml} from '../apkg.ts';

/** Which fields of a note type hold the word and its reading. */
export interface LinkFields {
  word: number;
  /** -1 if none */
  reading: number;
}

export interface Link {
  wordId: number;
  confidence: 'exact' | 'word';
}

/**
 * Guesses the word and reading fields from their names (Expression,
 * Reading, Front, …), like the add-to-Anki field mapping does.
 */
export function guessLinkFields(fields: string[]): LinkFields {
  const sources = fields.map((f, i) => guessSource(f, i));
  const word = sources.indexOf('word');
  const reading = sources.findIndex(s => s === 'reading' || s === 'furigana');
  return {word: word >= 0 ? word : 0, reading};
}

/** A field's text: no HTML, sounds, cloze markup or spaces. */
function clean(field: string): string {
  return stripHtml(
    field
      .replace(/\[sound:[^\]]*\]/g, '')
      .replace(/\{\{c\d+::(.*?)(::[^}]*)?\}\}/g, '$1'),
  );
}

/**
 * Anki's furigana syntax: "食[た]べる", "日本[にほん] 語[ご]" (a space before
 * a part whose reading follows). Returns the text and, if there were
 * readings, the whole word's reading.
 */
export function parseFurigana(field: string): {text: string; reading?: string} {
  const s = clean(field);
  if (!s.includes('[')) return {text: s.replace(/\s+/g, '')};
  let text = '';
  let reading = '';
  for (const part of s.split(/\s+/)) {
    const re = /([^[\]]*)\[([^\]]*)\]/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(part))) {
      text += m[1];
      reading += m[2];
      last = re.lastIndex;
    }
    const rest = part.slice(last);
    text += rest;
    reading += rest;
  }
  return {text, reading};
}

/** The word and reading in a note, by its link fields. */
export function noteWord(fields: string[], link: LinkFields) {
  const word = parseFurigana(fields[link.word] ?? '');
  const readingField =
    link.reading >= 0 ? parseFurigana(fields[link.reading] ?? '') : undefined;
  const reading =
    word.reading ??
    readingField?.reading ??
    (readingField && isAllKana(readingField.text)
      ? readingField.text
      : undefined);
  return {text: word.text || readingField?.text || '', reading};
}

/** The dictionary entry for a word, if there's a good match. */
export async function linkWord(
  dict: Dict,
  text: string,
  reading?: string,
): Promise<Link | undefined> {
  if (!text || text.length > 40) return undefined;
  const key = normalizeJa(text);
  const hits = (await dict.lookupJa(key)).slice(0, 12);
  if (!hits.length) return undefined;
  const entries = await dict.entries(hits.map(h => h.id));
  const wanted = reading ? normalizeJa(reading) : undefined;
  let fallback: Link | undefined;
  for (const e of entries) {
    const forms = [...(e.k ?? []), ...e.r].map(f => normalizeJa(f.t));
    if (!forms.includes(key)) continue;
    const readings = e.r.map(r => normalizeJa(r.t));
    if (wanted ? readings.includes(wanted) : isAllKana(text)) {
      return {wordId: e.id, confidence: 'exact'};
    }
    fallback ??= {wordId: e.id, confidence: 'word'};
  }
  return fallback;
}

/** Links many notes, a few lookups at a time. */
export async function linkAll(
  dict: Dict,
  words: {text: string; reading?: string}[],
  progress?: (done: number) => void,
): Promise<(Link | undefined)[]> {
  const out: (Link | undefined)[] = new Array(words.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < words.length) {
      const i = next++;
      try {
        out[i] = await linkWord(dict, words[i].text, words[i].reading);
      } catch {
        out[i] = undefined;
      }
      if (++done % 50 === 0) progress?.(done);
    }
  };
  await Promise.all(Array.from({length: 8}, worker));
  progress?.(done);
  return out;
}
