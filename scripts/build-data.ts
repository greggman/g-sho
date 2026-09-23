/**
 * Turns the downloaded jmdict-simplified JSON in .cache/ into the static,
 * sharded data files the site fetches (dist/data/). See PLAN.md and
 * src/shared/types.ts for the formats.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import {
  enShard,
  entryShard,
  jaShard,
  kanjiShard,
  shardName,
} from '../src/shared/hash.ts';
import {parseFurigana, plainText} from '../src/shared/furigana.ts';
import {decodeMsgpack} from './msgpack.ts';
import {
  EN_STOP_WORDS,
  glossCore,
  normalizeJa,
  tokenizeEn,
} from '../src/shared/normalize.ts';
import type {
  EnIndexShard,
  Entry,
  EntryShard,
  JaIndexShard,
  KanjiInfo,
  KanjiShard,
  Meta,
  RadicalData,
  Sense,
  StrokeShard,
} from '../src/shared/types.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE_DIR = path.join(ROOT, '.cache');
const OUT_DIR = path.join(ROOT, 'dist', 'data');

const SHARDS = {entries: 8192, ja: 2048, en: 1024, kanji: 128, strokes: 1024};

/** Longest English phrase (in words) indexed as a whole. */
const MAX_PHRASE_WORDS = 4;
/** Max entries kept per English word. */
const MAX_EN_IDS = 300;

/** Sense tags for words that are a worse answer to "what's the word for X". */
const MARKED_SENSE_TAGS = new Set([
  'arch',
  'obs',
  'rare',
  'dated',
  'hon',
  'hum',
  'sl',
  'col',
  'derog',
  'vulg',
  'chn',
  'euph',
  'joc',
  'poet',
]);

/** Kanji/kana form tags that mark rare or irregular spellings. */
const RARE_FORM_TAGS = new Set([
  'rK',
  'sK',
  'iK',
  'oK',
  'ik',
  'ok',
  'rk',
  'sk',
]);

// ---- jmdict-simplified input types (only the parts used) ----

interface JmForm {
  common: boolean;
  text: string;
  tags: string[];
  appliesToKanji?: string[];
}

interface JmSense {
  partOfSpeech: string[];
  appliesToKanji: string[];
  appliesToKana: string[];
  related: (string | number)[][];
  antonym: (string | number)[][];
  field: string[];
  dialect: string[];
  misc: string[];
  info: string[];
  languageSource: {
    lang: string;
    full: boolean;
    wasei: boolean;
    text: string | null;
  }[];
  gloss: {text: string; type: string | null}[];
  examples: {
    source: {type: string; value: string};
    text: string;
    sentences: {lang: string; text: string}[];
  }[];
}

interface JmWord {
  id: string;
  kanji: JmForm[];
  kana: JmForm[];
  sense: JmSense[];
}

interface JmDict {
  dictDate: string;
  tags: Record<string, string>;
  words: JmWord[];
}

interface KdReading {
  type: string;
  value: string;
}

interface KdChar {
  literal: string;
  radicals: {type: string; value: number}[];
  misc: {
    grade: number | null;
    strokeCounts: number[];
    frequency: number | null;
    jlptLevel: number | null;
  };
  readingMeaning: {
    groups: {
      readings: KdReading[];
      meanings: {lang: string; value: string}[];
    }[];
    nanori: string[];
  } | null;
}

// ---- helpers ----

function readJson<T>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, name), 'utf8')) as T;
}

function nonEmpty<T>(a: T[] | undefined): T[] | undefined {
  return a && a.length > 0 ? a : undefined;
}

/** Omit an "applies to" list that is ["*"] (meaning all forms). */
function appliesTo(a: string[]): string[] | undefined {
  return a.length === 1 && a[0] === '*' ? undefined : a;
}

function writeShards<T>(dir: string, shards: Map<number, T>) {
  fs.mkdirSync(path.join(OUT_DIR, dir), {recursive: true});
  let bytes = 0;
  let max = 0;
  for (const [n, data] of shards) {
    const json = JSON.stringify(data);
    bytes += json.length;
    max = Math.max(max, json.length);
    fs.writeFileSync(path.join(OUT_DIR, dir, `${shardName(n)}.json`), json);
  }
  const kb = (n: number) => `${(n / 1024).toFixed(0)}KB`;
  console.log(
    `${dir}: ${shards.size} shards, ${kb(bytes)} total, avg ${kb(bytes / shards.size)}, max ${kb(max)}`,
  );
}

function getShard<T>(
  shards: Map<number, T>,
  n: number,
  make: () => NoInfer<T>,
): T {
  let s = shards.get(n);
  if (!s) {
    s = make();
    shards.set(n, s);
  }
  return s;
}

// ---- words ----

/**
 * Tatoeba's furigana transcriptions of Japanese sentences, by sentence id.
 * Empty if not downloaded.
 */
function readFurigana(): Map<string, string> {
  const file = path.join(CACHE_DIR, 'tatoeba', 'transcriptions.csv');
  const out = new Map<string, string>();
  if (!fs.existsSync(file)) {
    console.warn(
      'warning: Tatoeba transcriptions missing; no example furigana',
    );
    return out;
  }
  // id, language, script, user, transcription (tab-separated)
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const [id, lang, , , text] = line.split('\t');
    if (lang === 'jpn' && text) out.set(id, text);
  }
  return out;
}

function convertWord(w: JmWord, furigana: Map<string, string>): Entry {
  const entry: Entry = {
    id: Number(w.id),
    r: w.kana.map(r => ({
      t: r.text,
      ...(r.common && {c: 1 as const}),
      ...(r.tags.length > 0 && {tg: r.tags}),
      ...(r.appliesToKanji &&
        appliesTo(r.appliesToKanji) && {a: r.appliesToKanji}),
    })),
    s: w.sense.map(s => {
      const sense: Sense = {g: s.gloss.map(g => g.text)};
      sense.p = nonEmpty(s.partOfSpeech);
      sense.ak = appliesTo(s.appliesToKanji);
      sense.ar = appliesTo(s.appliesToKana);
      sense.f = nonEmpty(s.field);
      sense.d = nonEmpty(s.dialect);
      sense.m = nonEmpty(s.misc);
      sense.i = nonEmpty(s.info);
      sense.rel = nonEmpty(s.related);
      sense.ant = nonEmpty(s.antonym);
      sense.ls = nonEmpty(
        s.languageSource.map(l => ({
          l: l.lang,
          ...(l.text && {t: l.text}),
          ...(!l.full && {p: 1 as const}),
          ...(l.wasei && {w: 1 as const}),
        })),
      );
      sense.ex = nonEmpty(
        s.examples.map(e => {
          const ja = e.sentences.find(x => x.lang === 'jpn')?.text ?? '';
          const f =
            e.source.type === 'tatoeba'
              ? furigana.get(e.source.value)
              : undefined;
          return {
            ja,
            en: e.sentences.find(x => x.lang === 'eng')?.text ?? '',
            w: e.text,
            // Only if it's a transcription of this exact sentence.
            ...(f && plainText(parseFurigana(f)) === ja && {f}),
          };
        }),
      );
      // Drop the undefined properties so JSON.stringify output is minimal
      // and the key order is stable.
      for (const k of Object.keys(sense) as (keyof Sense)[]) {
        if (sense[k] === undefined) delete sense[k];
      }
      return sense;
    }),
  };
  if (w.kanji.length > 0) {
    entry.k = w.kanji.map(k => ({
      t: k.text,
      ...(k.common && {c: 1 as const}),
      ...(k.tags.length > 0 && {tg: k.tags}),
    }));
  }
  return entry;
}

/** How well a form represents its entry; higher is better. */
// ---- word frequency (priority tags from the JMdict XML) ----

/** entry id → spelling or reading → its priority tags ("news1", "nf03", …) */
type Priorities = Map<number, Map<string, string[]>>;

/**
 * Reads the priority tags from .cache/JMdict_e.gz. jmdict-simplified keeps
 * only a common/not-common flag; the tags rank words by frequency. Returns
 * an empty map if the file hasn't been downloaded.
 */
function readPriorities(): Priorities {
  const file = path.join(CACHE_DIR, 'JMdict_e.gz');
  const out: Priorities = new Map();
  if (!fs.existsSync(file)) {
    console.warn('warning: JMdict_e.gz missing; ranking without frequencies');
    return out;
  }
  const xml = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
  const entryRe = /<ent_seq>(\d+)<\/ent_seq>([\s\S]*?)<\/entry>/g;
  const formRe =
    /<(?:k_ele|r_ele)>\s*<(?:keb|reb)>([^<]+)<\/(?:keb|reb)>([\s\S]*?)<\/(?:k_ele|r_ele)>/g;
  const priRe = /<(?:ke|re)_pri>([^<]+)</g;
  for (const [, id, body] of xml.matchAll(entryRe)) {
    let forms: Map<string, string[]> | undefined;
    for (const [, text, rest] of body.matchAll(formRe)) {
      const pri = [...rest.matchAll(priRe)].map(m => m[1]);
      if (pri.length === 0) continue;
      forms ??= new Map();
      forms.set(text, pri);
    }
    if (forms) out.set(Number(id), forms);
  }
  return out;
}

/**
 * How common a word is, from its priority tags. The newspaper frequency
 * bands (nf01 = top 500 words … nf48) order words, and being on the ichi1
 * list of basic words counts a lot. The news list misses many basic words
 * (行く, 家 and 下 (した) have no band), so an ichi1 word without a band is
 * given band 10 (tuned on a set of common queries). news1/news2 add
 * nothing: the band already says it.
 */
export function priorityScore(tags: string[] | undefined): number {
  const WEIGHTS: Record<string, number> = {
    ichi1: 35,
    ichi2: 10,
    spec1: 10,
    spec2: 3,
    gai1: 10,
    gai2: 3,
  };
  let score = 0;
  let band: number | undefined;
  for (const t of tags ?? []) {
    const nf = /^nf(\d+)$/.exec(t);
    if (nf) band = Number(nf[1]);
    else score += WEIGHTS[t] ?? 0;
  }
  if (band === undefined && tags?.includes('ichi1')) band = 10;
  if (band !== undefined) score += (48 - band) / 2;
  return score;
}

/**
 * wordfreq's Japanese frequencies: spelling → Zipf score (log10 of uses per
 * billion words; ~6 very common, ~3 rare). Empty if not downloaded.
 */
function readWordfreq(): Map<string, number> {
  const out = new Map<string, number>();
  const current = path.join(CACHE_DIR, 'wordfreq', 'current.json');
  if (!fs.existsSync(current)) {
    console.warn('warning: wordfreq data missing; ranking without it');
    return out;
  }
  const {commit, file} = JSON.parse(fs.readFileSync(current, 'utf8'));
  const buckets = decodeMsgpack(
    zlib.gunzipSync(
      fs.readFileSync(path.join(CACHE_DIR, 'wordfreq', commit, file)),
    ),
  ) as unknown[];
  // Bucket i (after the header) holds words with frequency 10^(-i/100).
  buckets.forEach((words, i) => {
    if (i === 0 || !Array.isArray(words)) return;
    for (const w of words as string[]) out.set(w, 9 - i / 100);
  });
  return out;
}

/** The spelling a word is usually written with. */
function mainSpelling(w: JmWord): string {
  const usuallyKana = w.sense[0]?.misc.includes('uk') ?? false;
  const kanji = w.kanji.find(k => !k.tags.some(t => RARE_FORM_TAGS.has(t)));
  return kanji && !usuallyKana ? kanji.text : (w.kana[0]?.text ?? '');
}

/**
 * How common each word is when written a given way, for ranking:
 * 10 × the spelling's wordfreq Zipf score, plus half its JMdict priority
 * score, plus a little for words with many senses. wordfreq counts
 * spellings, not words, so when entries share a spelling (上 is うえ, かみ,
 * じょう…) only its "owner" gets full credit: the entry whose main spelling
 * it is, with the best JMdict priority. The others get 1.5 less Zipf (about
 * a thirtieth), so かみ lists 紙 before 上 (かみ) even though 上 is common.
 */
function spellingPriorities(
  dict: JmDict,
  priorities: Priorities,
  zipf: Map<string, number>,
) {
  const tagScore = (w: JmWord, spelling: string) =>
    priorityScore(priorities.get(Number(w.id))?.get(spelling));
  // Tie-breaker: basic words have many senses (行く, 見る), rarer words
  // sharing their spelling or tags have few (幾, 看る).
  const senseBonus = (w: JmWord) => Math.min(w.sense.length, 10) / 2;

  const spellings = (w: JmWord) =>
    new Set([mainSpelling(w), ...w.kanji.map(k => k.text)]);
  const ownerRank = (w: JmWord, s: string) =>
    (mainSpelling(w) === s ? 1000 : 0) + tagScore(w, s) + senseBonus(w);
  const owners = new Map<string, {id: string; rank: number}>();
  for (const w of dict.words) {
    for (const s of spellings(w)) {
      const rank = ownerRank(w, s);
      const o = owners.get(s);
      if (!o || rank > o.rank) owners.set(s, {id: w.id, rank});
    }
  }

  return (w: JmWord, spelling: string): number => {
    const z = zipf.get(spelling) ?? 0;
    const shared = owners.get(spelling)?.id !== w.id;
    return (
      10 * Math.max(0, z - (shared ? 1.5 : 0)) +
      tagScore(w, spelling) / 2 +
      senseBonus(w)
    );
  };
}

function formScore(
  form: JmForm,
  index: number,
  entryCommon: boolean,
  priority: number,
): number {
  let score = priority;
  if (form.common) score += 100;
  if (entryCommon) score += 10;
  // An entry's main spelling beats another entry's alternative spelling,
  // even a common word's: 書 is 書 (しょ) before 文 (ふみ), also written 書.
  if (index > 0) score -= 20 + index * 3;
  if (form.tags.some(t => RARE_FORM_TAGS.has(t))) score -= 30;
  return score;
}

function buildWords(
  dict: JmDict,
  priorities: Priorities,
  zipf: Map<string, number>,
  furigana: Map<string, string>,
) {
  const spellingPriority = spellingPriorities(dict, priorities, zipf);
  const entryShards = new Map<number, EntryShard>();
  // key → [id, score, common]
  const jaKeys = new Map<string, [number, number, boolean][]>();
  // word or phrase → id → score
  const enKeys = new Map<string, Map<number, number>>();

  const addJa = (key: string, id: number, score: number, common: boolean) => {
    let list = jaKeys.get(key);
    if (!list) {
      list = [];
      jaKeys.set(key, list);
    }
    const existing = list.find(e => e[0] === id);
    if (existing) {
      // Same key from two forms (e.g. katakana and hiragana spellings).
      if (score > existing[1]) {
        existing[1] = score;
        existing[2] = common;
      }
    } else {
      list.push([id, score, common]);
    }
  };

  const addEn = (key: string, id: number, score: number) => {
    let m = enKeys.get(key);
    if (!m) {
      m = new Map();
      enKeys.set(key, m);
    }
    m.set(id, Math.max(m.get(id) ?? -Infinity, score));
  };

  for (const w of dict.words) {
    const entry = convertWord(w, furigana);
    getShard(entryShards, entryShard(entry.id, SHARDS.entries), () => ({}))[
      entry.id
    ] = entry;

    const entryCommon =
      w.kanji.some(k => k.common) || w.kana.some(k => k.common);
    // Readings rank by the word's main spelling: a reading's own tags pool
    // every spelling of the entry (かえる in 替える/換える/代える).
    const entryPriority = spellingPriority(w, mainSpelling(w));

    w.kanji.forEach((k, i) =>
      addJa(
        normalizeJa(k.text),
        entry.id,
        formScore(k, i, entryCommon, spellingPriority(w, k.text)),
        k.common,
      ),
    );
    // Readings rank a little below kanji forms, so searching たべる finds
    // 食べる before an entry whose kanji form happens to be written たべる.
    w.kana.forEach((k, i) =>
      addJa(
        normalizeJa(k.text),
        entry.id,
        formScore(k, i, entryCommon, entryPriority) - 1,
        k.common,
      ),
    );

    w.sense.forEach((s, si) => {
      s.gloss.forEach((g, gi) => {
        const core = glossCore(g.text);
        const words = tokenizeEn(core).filter(t => !EN_STOP_WORDS.has(t));
        let base = 10 - Math.min(si, 8) * 3 - Math.min(gi, 5);
        // A match in the first sense is what the word primarily means:
        // "ice cream" is アイスクリーム before アイス (ice; ice cream).
        if (si === 0) base += 10;
        if (entryCommon) base += 30;
        // More frequent words first, but never above an exact gloss match (+50).
        base += Math.round(entryPriority / 2);
        if (s.misc.some(m => MARKED_SENSE_TAGS.has(m))) base -= 15;
        for (const t of new Set(words)) {
          // Shorter glosses are a better match for a single word:
          // "eat" beats "eat a large meal".
          const exact = core === t ? 50 : 0;
          addEn(t, entry.id, base + exact - (words.length - 1) * 2);
        }
        // Whole short phrases, so "ice cream" finds アイスクリーム directly
        // instead of relying on intersecting "ice" and "cream".
        const phrase = tokenizeEn(core).join(' ');
        if (words.length > 1 && words.length <= MAX_PHRASE_WORDS) {
          addEn(phrase, entry.id, base + 50);
        }
      });
    });
  }

  writeShards('ent', entryShards);

  const jaShards = new Map<number, JaIndexShard>();
  for (const [key, list] of jaKeys) {
    list.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    getShard(jaShards, jaShard(key, SHARDS.ja), () => ({}))[key] = list.map(
      ([id, , common]) => (common ? -id : id),
    );
  }
  writeShards('ja', jaShards);

  const enShards = new Map<number, EnIndexShard>();
  for (const [key, m] of enKeys) {
    const list = [...m]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, MAX_EN_IDS);
    getShard(enShards, enShard(key, SHARDS.en), () => ({}))[key] = list;
  }
  writeShards('en', enShards);

  return dict.words.length;
}

// ---- kanji ----

function buildKanji(): {count: number; strokes: Record<string, number>} {
  const kd = readJson<{characters: KdChar[]}>('kanjidic.json');
  const krad = readJson<{kanji: Record<string, string[]>}>('kradfile.json');
  const shards = new Map<number, KanjiShard>();
  const strokes: Record<string, number> = {};

  for (const c of kd.characters) {
    const readings = c.readingMeaning?.groups.flatMap(g => g.readings) ?? [];
    const byType = (type: string) =>
      nonEmpty(readings.filter(r => r.type === type).map(r => r.value));
    const info: KanjiInfo = {
      c: c.literal,
      m:
        c.readingMeaning?.groups.flatMap(g =>
          g.meanings.filter(m => m.lang === 'en').map(m => m.value),
        ) ?? [],
    };
    const on = byType('ja_on');
    const kun = byType('ja_kun');
    const nanori = nonEmpty(c.readingMeaning?.nanori);
    if (on) info.on = on;
    if (kun) info.kun = kun;
    if (nanori) info.nanori = nanori;
    const s = c.misc.strokeCounts[0];
    if (s) {
      info.s = s;
      strokes[c.literal] = s;
    }
    if (c.misc.grade) info.g = c.misc.grade;
    if (c.misc.jlptLevel) info.j = c.misc.jlptLevel;
    if (c.misc.frequency) info.f = c.misc.frequency;
    const rad = c.radicals.find(r => r.type === 'classical');
    if (rad) info.rad = rad.value;
    const parts = krad.kanji[c.literal];
    if (parts) info.parts = parts;
    getShard(shards, kanjiShard(c.literal, SHARDS.kanji), () => ({}))[
      c.literal
    ] = info;
  }
  writeShards('kanji', shards);
  return {count: kd.characters.length, strokes};
}

function buildRadicals(strokes: Record<string, number>) {
  const radk = readJson<{
    radicals: Record<string, {strokeCount: number; kanji: string[]}>;
  }>('radkfile.json');
  const entries = Object.entries(radk.radicals).sort(
    (a, b) => a[1].strokeCount - b[1].strokeCount,
  );
  const allKanji = new Set<string>();
  const data: RadicalData = {
    radicals: entries.map(([r, v]) => [r, v.strokeCount]),
    kanji: Object.fromEntries(
      entries.map(([r, v]) => {
        v.kanji.forEach(k => allKanji.add(k));
        return [r, v.kanji.join('')];
      }),
    ),
    strokes: {},
  };
  for (const k of allKanji) {
    if (strokes[k]) data.strokes[k] = strokes[k];
  }
  fs.writeFileSync(path.join(OUT_DIR, 'radk.json'), JSON.stringify(data));
}

// ---- stroke order (KanjiVG) ----

/** <path id="kvg:098df-s3" ... d="M52.25,29.25c1,1,..."/> */
const STROKE_PATH = /<path\s+id="kvg:[0-9a-f]+-s(\d+)"[^>]*?\sd="([^"]+)"/g;

function buildStrokes() {
  const dir = path.join(CACHE_DIR, 'kanjivg', 'kanji');
  const shards = new Map<number, StrokeShard>();
  let count = 0;
  for (const file of fs.readdirSync(dir)) {
    // Skip variants like 05b57-Kaisho.svg; the base file is the standard form.
    const m = /^([0-9a-f]+)\.svg$/.exec(file);
    if (!m) continue;
    const char = String.fromCodePoint(parseInt(m[1], 16));
    const svg = fs.readFileSync(path.join(dir, file), 'utf8');
    const strokes = [...svg.matchAll(STROKE_PATH)]
      .map(([, n, d]) => [Number(n), d] as const)
      .sort((a, b) => a[0] - b[0])
      .map(([, d]) => d);
    if (strokes.length === 0) continue;
    getShard(shards, kanjiShard(char, SHARDS.strokes), () => ({}))[char] =
      strokes;
    count++;
  }
  writeShards('strokes', shards);
  return count;
}

function main() {
  const start = Date.now();
  fs.rmSync(OUT_DIR, {recursive: true, force: true});
  fs.mkdirSync(OUT_DIR, {recursive: true});

  const version = readJson<{version: string}>('version.json').version;
  const dict = readJson<JmDict>('jmdict.json');
  const entryCount = buildWords(
    dict,
    readPriorities(),
    readWordfreq(),
    readFurigana(),
  );
  const {count: kanjiCount, strokes} = buildKanji();
  buildRadicals(strokes);
  buildStrokes();

  const meta: Meta = {
    version,
    dictDate: dict.dictDate,
    builtAt: new Date().toISOString(),
    entryCount,
    kanjiCount,
    shards: SHARDS,
    tags: dict.tags,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'meta.json'), JSON.stringify(meta));
  console.log(`built data in ${((Date.now() - start) / 1000).toFixed(1)}s`);
}

main();
