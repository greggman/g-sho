/**
 * What goes into an Anki note for a dictionary entry: the values we can
 * provide ("sources"), our own note type, and the default mapping from an
 * existing note type's fields to sources.
 */
import type {Entry} from '../../shared/types.ts';
import {furigana, headword} from '../forms.ts';

/** Values we can put in a field. */
export const SOURCES = {
  none: 'Nothing',
  word: 'Word (食べる)',
  reading: 'Reading (たべる)',
  furigana: 'Word with furigana (食[た]べる)',
  meaning: 'Meanings',
  readingMeaning: 'Reading and meanings',
  pos: 'Part of speech',
  example: 'Example sentence',
  id: 'JMdict ID',
  link: 'Link to g-sho',
} as const;

export type Source = keyof typeof SOURCES;

/** Maps each Anki field name to what we put in it. */
export type FieldMap = Record<string, Source>;

export const DEFAULT_DECK = 'g-sho';
export const DEFAULT_NOTE_TYPE = 'g-sho (Japanese)';

/** Our note type's fields, in order, and what fills them. */
const OWN_FIELDS: [string, Source][] = [
  ['Word', 'word'],
  ['Reading', 'reading'],
  ['Furigana', 'furigana'],
  ['Meaning', 'meaning'],
  ['PartOfSpeech', 'pos'],
  ['Example', 'example'],
  ['JMdictId', 'id'],
  ['Link', 'link'],
];

export const OWN_FIELD_MAP: FieldMap = Object.fromEntries(OWN_FIELDS);

/** The createModel request for our note type: one recognition card. */
export function ownNoteType() {
  return {
    modelName: DEFAULT_NOTE_TYPE,
    inOrderFields: OWN_FIELDS.map(([name]) => name),
    css: `.card { font-family: "Hiragino Sans", "Noto Sans JP", sans-serif; font-size: 20px; text-align: center; color: black; background: white; }
.word { font-size: 48px; }
.meaning { text-align: left; display: inline-block; }
.pos { color: #777; font-size: 14px; }
.example { margin-top: 1em; color: #555; font-size: 16px; }
.link { margin-top: 1em; font-size: 12px; }
.nightMode .card { color: #eee; background: #222; }`,
    cardTemplates: [
      {
        Name: 'Recognition',
        Front: '<div class="word">{{Word}}</div>',
        Back:
          '<div class="word">{{furigana:Furigana}}</div>\n<hr id="answer">\n' +
          '<div class="pos">{{PartOfSpeech}}</div>\n<div class="meaning">{{Meaning}}</div>\n' +
          '{{#Example}}<div class="example">{{Example}}</div>{{/Example}}\n' +
          '<div class="link"><a href="{{Link}}">g-sho</a></div>',
      },
    ],
  };
}

/** Guesses what to put in an existing note type's field from its name. */
export function guessSource(field: string, index: number): Source {
  const f = field.toLowerCase();
  if (/furigana/.test(f)) return 'furigana';
  if (/reading|kana|yomi|pronunciation/.test(f)) return 'reading';
  if (/word|expression|vocab|kanji|term|japanese/.test(f)) return 'word';
  if (/meaning|definition|english|gloss|translation/.test(f)) return 'meaning';
  if (/part.?of.?speech|^pos$/.test(f)) return 'pos';
  if (/example|sentence/.test(f)) return 'example';
  if (/jmdict|^id$/.test(f)) return 'id';
  if (/link|url|source/.test(f)) return 'link';
  // "Basic": Front and Back.
  if (/front/.test(f)) return 'word';
  if (/back/.test(f)) return 'readingMeaning';
  return index === 0 ? 'word' : 'none';
}

export function guessFieldMap(fields: string[]): FieldMap {
  return Object.fromEntries(fields.map((f, i) => [f, guessSource(f, i)]));
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"]/g,
    c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]!,
  );
}

/**
 * Anki's furigana syntax: 食[た]べ 物[もの]. A space separates the text a
 * reading belongs to from what comes before it, and is not displayed.
 */
export function ankiFurigana(text: string, reading?: string): string {
  if (!reading) return text;
  return furigana(text, reading)
    .map(([t, r], i) => (r ? `${i > 0 ? ' ' : ''}${t}[${r}]` : t))
    .join('');
}

export interface NoteContext {
  /** part of speech tag → label */
  posLabel: (tag: string) => string;
  /** link to this word on the site */
  link: string;
}

/** The value of every source for an entry. */
export function sourceValues(
  entry: Entry,
  ctx: NoteContext,
): Record<Source, string> {
  const head = headword(entry);
  const reading = head.reading ?? head.text;
  const senses = entry.s.map(s => escapeHtml(s.g.join('; ')));
  const meaning =
    senses.length === 1
      ? senses[0]
      : `<ol>${senses.map(s => `<li>${s}</li>`).join('')}</ol>`;
  const ex = entry.s.flatMap(s => s.ex ?? [])[0];
  return {
    none: '',
    word: head.text,
    reading,
    furigana: ankiFurigana(head.text, head.reading),
    meaning,
    readingMeaning: `<div>${escapeHtml(reading)}</div>${meaning}`,
    pos: (entry.s[0]?.p ?? []).map(ctx.posLabel).join(', '),
    example: ex ? `${escapeHtml(ex.ja)}<br>${escapeHtml(ex.en)}` : '',
    id: String(entry.id),
    link: ctx.link,
  };
}

export function noteFields(
  entry: Entry,
  map: FieldMap,
  ctx: NoteContext,
): Record<string, string> {
  const values = sourceValues(entry, ctx);
  return Object.fromEntries(
    Object.entries(map).map(([field, source]) => [field, values[source]]),
  );
}

/** Quotes a value for an Anki search: "Field:value" with wildcards escaped. */
function searchTerm(field: string, value: string): string {
  const escaped = value.replace(/[\\"*_]/g, c => `\\${c}`);
  return `"${field}:${escaped}"`;
}

/**
 * The Anki search that finds an existing note for the entry, by the field
 * holding its JMdict ID or else the one holding the word. Undefined if no
 * field identifies it.
 */
export function duplicateQuery(
  entry: Entry,
  noteType: string,
  map: FieldMap,
): string | undefined {
  const fields = Object.entries(map);
  const byId = fields.find(([, s]) => s === 'id');
  const byWord = fields.find(([, s]) => s === 'word');
  const key = byId ?? byWord;
  if (!key) return undefined;
  const value = key === byId ? String(entry.id) : headword(entry).text;
  return `${searchTerm('note', noteType)} ${searchTerm(key[0], value)}`;
}
