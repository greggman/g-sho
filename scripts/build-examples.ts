/**
 * More example sentences, from Tatoeba's word index (jpn_indices.csv): about
 * 150,000 Japanese sentences, each with an English translation and the
 * dictionary words it contains, as Tanaka-corpus "B lines":
 *
 *   4707  1282  は 二十歳(はたち){２０歳} になる[01]{になりました}
 *
 * A word is written `word(reading)[sense]{form in the sentence}~`; the
 * reading, sense and form are optional, and ~ marks a checked, good example
 * of the word. JMdict links only a hand-picked few of these to its senses;
 * this gives every word up to MAX_PER_ENTRY more, best first.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {parseFurigana, plainText} from '../src/shared/furigana.ts';
import {normalizeJa} from '../src/shared/normalize.ts';
import type {Example} from '../src/shared/types.ts';

export const MAX_PER_ENTRY = 10;
/** Longer sentences are less useful as examples. */
const MAX_LENGTH = 60;

export interface ExampleWord {
  id: number;
  kanji: string[];
  kana: string[];
  common: boolean;
  /** sentences JMdict already shows for it */
  existing: Set<string>;
}

interface Term {
  word: string;
  reading?: string;
  /** how it's written in the sentence */
  form: string;
  good: boolean;
}

const TERM = /^([^([{~]+)(?:\(([^)]+)\))?(?:\[(\d+)\])?(?:\{([^}]+)\})?(~)?$/;

export function parseIndexLine(line: string): Term[] {
  const terms: Term[] = [];
  for (const token of line.trim().split(/\s+/)) {
    const m = TERM.exec(token);
    if (!m) continue;
    terms.push({
      word: m[1],
      ...(m[2] && {reading: m[2]}),
      form: m[4] ?? m[1],
      good: !!m[5],
    });
  }
  return terms;
}

/** id → text, for the sentences of one language file (id, lang, text). */
function readSentences(
  file: string,
  wanted?: Set<string>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const id = line.slice(0, tab);
    if (wanted && !wanted.has(id)) continue;
    out.set(id, line.slice(line.indexOf('\t', tab + 1) + 1));
  }
  return out;
}

/**
 * The extra examples for each entry, best first: checked examples (~),
 * then shorter sentences. Returns an empty map if the files are missing.
 */
export function buildExamples(
  dir: string,
  words: ExampleWord[],
  furigana: Map<string, string>,
): Map<number, Example[]> {
  const files = [
    'jpn_indices.csv',
    'jpn_sentences.tsv',
    'eng_sentences.tsv',
  ].map(f => path.join(dir, f));
  if (!files.every(f => fs.existsSync(f))) {
    console.warn('warning: Tatoeba index missing; no extra example sentences');
    return new Map();
  }
  const [indexFile, jpnFile, engFile] = files;

  // Which entries a written word can be.
  const byForm = new Map<string, ExampleWord[]>();
  for (const w of words) {
    for (const f of new Set([...w.kanji, ...w.kana])) {
      let list = byForm.get(f);
      if (!list) byForm.set(f, (list = []));
      list.push(w);
    }
  }
  const entryFor = (t: Term): ExampleWord | undefined => {
    let list = byForm.get(t.word) ?? [];
    if (t.reading) {
      const r = normalizeJa(t.reading);
      list = list.filter(w => w.kana.some(k => normalizeJa(k) === r));
    }
    if (list.length <= 1) return list[0];
    // The entry whose main spelling it is, then a common one.
    return (
      list.find(w => (w.kanji[0] ?? w.kana[0]) === t.word && w.common) ??
      list.find(w => (w.kanji[0] ?? w.kana[0]) === t.word) ??
      list.find(w => w.common) ??
      list[0]
    );
  };

  const lines = fs
    .readFileSync(indexFile, 'utf8')
    .split('\n')
    .map(l => l.split('\t'))
    .filter(cols => cols.length >= 3);
  const engIds = new Set(lines.map(cols => cols[1]));
  const jpn = readSentences(jpnFile);
  const eng = readSentences(engFile, engIds);

  interface Candidate {
    jaId: string;
    ja: string;
    en: string;
    form: string;
    good: boolean;
  }
  const candidates = new Map<ExampleWord, Candidate[]>();
  for (const [jaId, enId, index] of lines) {
    const ja = jpn.get(jaId);
    const en = eng.get(enId);
    if (!ja || !en || Array.from(ja).length > MAX_LENGTH) continue;
    const seen = new Set<ExampleWord>();
    for (const t of parseIndexLine(index)) {
      const w = entryFor(t);
      if (!w || seen.has(w) || w.existing.has(ja)) continue;
      seen.add(w);
      let list = candidates.get(w);
      if (!list) candidates.set(w, (list = []));
      list.push({jaId, ja, en, form: t.form, good: t.good});
    }
  }

  const out = new Map<number, Example[]>();
  for (const [w, list] of candidates) {
    list.sort(
      (a, b) =>
        Number(b.good) - Number(a.good) ||
        a.ja.length - b.ja.length ||
        Number(a.jaId) - Number(b.jaId),
    );
    const texts = new Set<string>();
    const examples: Example[] = [];
    for (const c of list) {
      if (texts.has(c.ja)) continue;
      texts.add(c.ja);
      const f = furigana.get(c.jaId);
      examples.push({
        ja: c.ja,
        en: c.en,
        // The highlight needs the form as it appears in the sentence.
        w: c.ja.includes(c.form) ? c.form : '',
        // Only if it's a transcription of this exact sentence.
        ...(f && plainText(parseFurigana(f)) === c.ja && {f}),
      });
      if (examples.length >= MAX_PER_ENTRY) break;
    }
    out.set(w.id, examples);
  }
  return out;
}
