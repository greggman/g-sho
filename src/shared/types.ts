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
  /**
   * The sentence with furigana, in Tatoeba's markup: "[世界|せ|かい]に…"
   * (one reading per character) or "[今日|きょう]" (one for the group).
   */
  f?: string;
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
  /** how many more example sentences it has (tex/ and jadef/) */
  mx?: number;
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
  /** its top-level parts, from KRADFILE (build-parts.ts topLevelParts) */
  parts?: string[];
}

/** A kanji part (KRADFILE component), for the kanji panel. */
export interface PartInfo {
  /** the form to show, when KRADFILE uses a stand-in (化 for 亻) */
  f?: string;
  /** what it means, in English (horse, water) */
  en?: string;
  /** its Japanese name: a radical name (さんずい) or kun reading (うま) */
  ja?: string;
  /** for a radical form, the kanji it's a form of (氵: 水) */
  s?: string;
}

/** parts.json: KRADFILE component → what it is */
export type PartsData = Record<string, PartInfo>;

/** kanji/NNNN.json: kanji → info */
export type KanjiShard = Record<string, KanjiInfo>;

/**
 * strokes/NNNN.json: character → its strokes in stroke order, as SVG path
 * data in KanjiVG's 109×109 coordinate space.
 */
export type StrokeShard = Record<string, string[]>;

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
/**
 * A word's definitions in Japanese (from the Japanese Wiktionary), for one
 * part of speech.
 */
export interface JaDefinition {
  /** part of speech, in Japanese (名詞, 動詞, …) */
  p: string;
  s: JaSense[];
}

export interface JaSense {
  /** the definition */
  g: string;
  /** example sentences */
  ex?: string[];
  /** labels (口語, 挨拶, …) */
  t?: string[];
  /** furigana for hard words in the definition: [word, reading] */
  r?: [string, string][];
}

/** tex/NNNN.json: entry id → more example sentences (Tatoeba) */
export type ExampleShard = Record<number, Example[]>;

/** jadef/NNNN.json: entry id → its Japanese definitions */
export type JaDefinitionShard = Record<number, JaDefinition[]>;

/** An English word explained in Japanese (英和; Japanese Wiktionary). */
export interface EnglishEntry {
  /** the word as written ("apple", "New York") */
  w: string;
  /** part of speech, in Japanese (名詞) */
  p: string;
  /** pronunciations (IPA), British and American when they differ */
  ipa?: string[];
  s: EnglishSense[];
  /** inflected forms: [form, label] ("apples", "複数形") */
  f?: [string, string][];
}

export interface EnglishSense {
  /** the meaning, in Japanese */
  g: string;
  /** labels (口語, 米国, …) */
  t?: string[];
  /** examples: [English, Japanese] */
  ex?: [string, string][];
}

/** An English word's definitions in English (Open English WordNet), by part of speech. */
export interface EnglishDefinitions {
  /** noun, verb, adjective, adverb */
  p: string;
  s: {
    /** the definition */
    d: string;
    /** an example */
    ex?: string;
    /** other words with this meaning */
    syn?: string[];
  }[];
}

/**
 * enw/NNN.json: lowercased word → its entries in Japanese (e), definitions
 * in English (d), pronunciation from WordNet when the entries have none
 * (ipa), and the words it's a form of ("went" → ["go"]).
 */
export type EnglishShard = Record<
  string,
  {e?: EnglishEntry[]; d?: EnglishDefinitions[]; ipa?: string[]; of?: string[]}
>;

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
    strokes: number;
    /** Japanese definitions; absent when they weren't built */
    jadef?: number;
    /** more example sentences; absent when they weren't built */
    tex?: number;
    /** English words in Japanese (英和); absent when they weren't built */
    enw?: number;
  };
  /** tag → human readable description */
  tags: Record<string, string>;
  /**
   * Each data set's version (a hash of its files), by folder or file name
   * (ent, ja, en, kanji, strokes, jadef, radk): put in the files' URLs, so a
   * data set's files can be cached until it changes.
   */
  versions?: Record<string, string>;
  /**
   * How many packs each data set has (data/pack/<set>-<i>.txt): its files
   * bundled for downloading the whole dictionary (see build-data.ts).
   */
  packs?: Record<string, number>;
}
