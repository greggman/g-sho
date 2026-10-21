/**
 * English words explained in Japanese (英和), from the Japanese Wiktionary
 * (as extracted by wiktextract, kaikki.org): the same file as the Japanese
 * definitions (build-jawiktionary.ts), whose English entries those skip.
 *
 * Shards `enw/NNN.json` by the lowercased word: its entries, and the words
 * it's a form of ("went" → go, "apples" → apple), from the base words'
 * listed forms and from entries that just say "goの過去形".
 */
import * as fs from 'node:fs';
import * as readline from 'node:readline';
import * as zlib from 'node:zlib';
import type {
  EnglishEntry,
  EnglishSense,
  EnglishShard,
} from '../src/shared/types.ts';

interface RawSense {
  glosses?: string[];
  tags?: string[];
  raw_tags?: string[];
  form_of?: {word: string}[];
  examples?: {text?: string; translation?: string}[];
}

interface RawEntry {
  word: string;
  lang_code: string;
  pos_title?: string;
  senses?: RawSense[];
  forms?: {form: string; tags?: string[]}[] | null;
  sounds?: {ipa?: string; tags?: string[]}[] | null;
}

const MAX_SENSES = 12;
const MAX_EXAMPLES = 2;
const MAX_GLOSS = 300;
const MAX_EXAMPLE = 200;
const MAX_IPA = 2;

/** English inflections that are worth listing (and finding the word by). */
const FORM_LABELS: [string[], string][] = [
  [['plural'], '複数形'],
  [['third-person', 'singular', 'present'], '三人称単数現在形'],
  [['present', 'participle'], '現在分詞'],
  [['past', 'participle'], '過去分詞'],
  [['past'], '過去形'],
  [['comparative'], '比較級'],
  [['superlative'], '最上級'],
];

function formLabel(tags: string[] = []): string | undefined {
  // The most specific match: "past participle" before "past".
  for (const [want, label] of FORM_LABELS) {
    if (want.every(t => tags.includes(t)) && tags.length === want.length) {
      return label;
    }
  }
  return undefined;
}

/** "goの過去形", "apple の複数形。": the word it's a form of. */
const POINTER =
  /^([A-Za-z][A-Za-z' .-]*?)\s*の(複数形|過去形|過去分詞|現在分詞|三人称単数現在形?|比較級|最上級)。?$/;

const clip = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s;

function convertSense(s: RawSense): {sense?: EnglishSense; of?: string} {
  const gloss = s.glosses?.at(-1)?.trim();
  if (!gloss) return {};
  const of = s.form_of?.[0]?.word ?? POINTER.exec(gloss)?.[1];
  const sense: EnglishSense = {g: clip(gloss, MAX_GLOSS)};
  const labels = s.raw_tags?.filter(t => t.length <= 12);
  if (labels?.length) sense.t = labels.slice(0, 4);
  const ex = (s.examples ?? [])
    .filter(e => e.text)
    .slice(0, MAX_EXAMPLES)
    .map(
      e =>
        [
          clip(e.text!, MAX_EXAMPLE),
          clip(e.translation ?? '', MAX_EXAMPLE),
        ] as [string, string],
    );
  if (ex.length) sense.ex = ex;
  return {sense, of};
}

function convert(raw: RawEntry): {entry?: EnglishEntry; of: string[]} {
  const of = new Set<string>();
  const senses: EnglishSense[] = [];
  for (const s of raw.senses ?? []) {
    const c = convertSense(s);
    if (c.of && c.of.toLowerCase() !== raw.word.toLowerCase()) of.add(c.of);
    if (c.sense && senses.length < MAX_SENSES) senses.push(c.sense);
  }
  if (!senses.length) return {of: [...of]};
  const entry: EnglishEntry = {w: raw.word, p: raw.pos_title ?? '', s: senses};
  const ipa = [
    ...new Set(
      (raw.sounds ?? [])
        .filter(x => x.ipa && !x.tags?.includes('X-SAMPA'))
        .map(x => x.ipa!),
    ),
  ].slice(0, MAX_IPA);
  if (ipa.length) entry.ipa = ipa;
  const forms: [string, string][] = [];
  for (const f of raw.forms ?? []) {
    const label = formLabel(f.tags);
    if (label && f.form !== raw.word) forms.push([f.form, label]);
  }
  if (forms.length) entry.f = forms;
  return {entry, of: [...of]};
}

/**
 * Every English word in the file: entries by lowercased word, and for each
 * inflected form, the words it's a form of.
 */
export async function readEnglish(
  file: string,
): Promise<Map<string, EnglishShard[string]>> {
  const out = new Map<string, EnglishShard[string]>();
  const get = (key: string) => {
    let v = out.get(key);
    if (!v) out.set(key, (v = {}));
    return v;
  };
  const addOf = (form: string, word: string) => {
    const key = form.toLowerCase();
    if (key === word.toLowerCase()) return;
    const v = get(key);
    if (!v.of?.includes(word)) (v.of ??= []).push(word);
  };
  const lines = readline.createInterface({
    input: fs.createReadStream(file).pipe(zlib.createGunzip()),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    // Cheap test first: most lines are other languages.
    if (!line.includes('"lang_code": "en"')) continue;
    const raw = JSON.parse(line) as RawEntry;
    if (raw.lang_code !== 'en' || !raw.word) continue;
    const {entry, of} = convert(raw);
    if (entry) (get(raw.word.toLowerCase()).e ??= []).push(entry);
    for (const base of of) addOf(raw.word, base);
    for (const [form] of entry?.f ?? []) addOf(form, raw.word);
  }
  return out;
}
