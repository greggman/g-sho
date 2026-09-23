/**
 * The compact on-disk formats under dist/data/. Short property names keep the
 * shards small; empty or default fields are omitted.
 */

/** A kanji spelling of a word. */
export interface KanjiForm {
  /** text */
  t: string;
  /** 1 if common */
  c?: 1;
  /** tags such as "ateji", "rK" */
  tg?: string[];
}

/** A kana reading of a word. */
export interface ReadingForm {
  t: string;
  c?: 1;
  tg?: string[];
  /**
   * Kanji forms this reading applies to. Omitted means all of them;
   * an empty array means the reading has no kanji form.
   */
  a?: string[];
}

export interface LanguageSource {
  /** ISO 639-2 language code */
  l: string;
  /** source word */
  t?: string;
  /** 1 if only part of the word comes from this source */
  p?: 1;
  /** 1 if wasei (made in Japan) */
  w?: 1;
}

export interface Example {
  /** Japanese sentence */
  ja: string;
  /** English translation */
  en: string;
  /** the form of the word as it appears in the sentence */
  w: string;
}

export interface Sense {
  /** glosses */
  g: string[];
  /** part of speech tags */
  p?: string[];
  /** kanji forms this sense applies to (omitted = all) */
  ak?: string[];
  /** readings this sense applies to (omitted = all) */
  ar?: string[];
  /** field tags ("comp", "med") */
  f?: string[];
  /** dialect tags */
  d?: string[];
  /** misc tags ("uk", "abbr") */
  m?: string[];
  /** free-form notes */
  i?: string[];
  /** related entries: [kanji or kana, optional kana, optional sense number] */
  rel?: (string | number)[][];
  /** antonyms, same shape as rel */
  ant?: (string | number)[][];
  ls?: LanguageSource[];
  ex?: Example[];
}

export interface Entry {
  id: number;
  k?: KanjiForm[];
  r: ReadingForm[];
  s: Sense[];
}

/** ent/NNNN.json: entry id → entry */
export type EntryShard = Record<string, Entry>;

/**
 * ja/NNNN.json: normalized key → entry ids, most relevant first.
 * An id is stored negated when the matching form is marked common, so the
 * client can rank matches before fetching the entries.
 */
export type JaIndexShard = Record<string, number[]>;

/** en/NNNN.json: word → [entry id, score][], best first */
export type EnIndexShard = Record<string, [number, number][]>;

export interface KanjiInfo {
  /** the kanji */
  c: string;
  /** English meanings */
  m: string[];
  /** on readings (katakana) */
  on?: string[];
  /** kun readings (hiragana, "." marks okurigana) */
  kun?: string[];
  /** name readings */
  nanori?: string[];
  /** stroke count */
  s?: number;
  /** school grade (1-6 kyōiku, 8 jōyō, 9-10 jinmeiyō) */
  g?: number;
  /** old 4-level JLPT */
  j?: number;
  /** newspaper frequency rank (1-2500) */
  f?: number;
  /** classical radical number */
  rad?: number;
  /** components from KRADFILE */
  parts?: string[];
}

/** kanji/NNNN.json: kanji → info */
export type KanjiShard = Record<string, KanjiInfo>;

/** radk.json */
export interface RadicalData {
  /** radicals in stroke order: [radical, stroke count] */
  radicals: [string, number][];
  /** radical → kanji containing it (as one string) */
  kanji: Record<string, string>;
  /** kanji → stroke count, for sorting results */
  strokes: Record<string, number>;
}

/** meta.json */
export interface Meta {
  version: string;
  dictDate: string;
  builtAt: string;
  entryCount: number;
  kanjiCount: number;
  shards: {
    entries: number;
    ja: number;
    en: number;
    kanji: number;
  };
  /** tag → human readable description */
  tags: Record<string, string>;
}
