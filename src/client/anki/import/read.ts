/**
 * Reads an Anki package (.apkg, or a whole collection's .colpkg) into plain
 * data. Handles every format Anki has written:
 *
 *   collection.anki2    old (schema 11): note types and decks are JSON in col
 *   collection.anki21   2.1 (schema 11)
 *   collection.anki21b  23.10+ (schema 18): zstd-compressed; note types,
 *                       fields, templates and decks in their own tables,
 *                       with protobuf config; media list and files zstd too
 *
 * A newer package also holds an old-style collection.anki2 that only says
 * "please update Anki", so the newest one present is used.
 *
 * The SQLite engine and zstd are passed in (sql.js and fzstd in the
 * browser), so this runs in a worker and in tests.
 */
import {strFromU8, unzipSync} from 'fflate';
import type {SqlJs, SqlJsDatabase} from '../apkg.ts';
import {protoNumber, protoString, readProto} from './protobuf.ts';

export interface AnkiNoteType {
  ankiId: number;
  name: string;
  kind: 'standard' | 'cloze';
  fields: string[];
  templates: {name: string; front: string; back: string}[];
  css: string;
}

export interface AnkiDeck {
  ankiId: number;
  /** with "::" between parent and child decks */
  name: string;
}

export interface AnkiNote {
  ankiId: number;
  guid: string;
  noteTypeId: number;
  fields: string[];
  tags: string[];
  /** last change (ms) */
  mtime: number;
}

export interface AnkiCard {
  ankiId: number;
  noteId: number;
  deckId: number;
  ord: number;
  /** 0 new, 1 learning, 2 review, 3 relearning */
  type: number;
  /** -1 suspended, -2/-3 buried */
  queue: number;
  /** new: position; review: day number from crt; learning: epoch seconds */
  due: number;
  ivl: number;
  reps: number;
  lapses: number;
  /** FSRS memory, when Anki has it (23.10+) */
  memory?: {s: number; d: number; lastReview?: number};
}

export interface AnkiReview {
  ankiId: number;
  cardId: number;
  /** 1–4 */
  ease: number;
  /** ms */
  time: number;
  /** 0 learn, 1 review, 2 relearn, 3 filtered, 4 manual */
  type: number;
}

export interface AnkiCollection {
  /** when the collection was created (s); review due days count from it */
  crt: number;
  noteTypes: AnkiNoteType[];
  decks: AnkiDeck[];
  notes: AnkiNote[];
  cards: AnkiCard[];
  reviews: AnkiReview[];
  media: {name: string; data: Uint8Array}[];
}

export type Zstd = (data: Uint8Array) => Uint8Array;

const isZstd = (b: Uint8Array) =>
  b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd;

function rows(db: SqlJsDatabase, sql: string): Record<string, unknown>[] {
  const [result] = db.exec(sql);
  if (!result) return [];
  return result.values.map(v =>
    Object.fromEntries(result.columns.map((c, i) => [c, v[i]])),
  );
}

export function readApkg(
  zip: Uint8Array,
  SQL: SqlJs,
  zstd: Zstd,
): AnkiCollection {
  const files = unzipSync(zip);
  const name = [
    'collection.anki21b',
    'collection.anki21',
    'collection.anki2',
  ].find(n => files[n]);
  if (!name)
    throw new Error('This isn’t an Anki package (no collection inside).');
  const packed: Uint8Array = files[name];
  const data = isZstd(packed) ? zstd(packed) : packed;

  const db = new SQL.Database(data);
  try {
    const [col] = rows(db, 'SELECT * FROM col');
    const crt = Number(col.crt);
    const modern = Number(col.ver) >= 15;
    const collection: AnkiCollection = {
      crt,
      noteTypes: modern ? modernNoteTypes(db) : legacyNoteTypes(col),
      decks: modern ? modernDecks(db) : legacyDecks(col),
      notes: rows(db, 'SELECT id, guid, mid, mod, tags, flds FROM notes').map(
        n => ({
          ankiId: Number(n.id),
          guid: String(n.guid),
          noteTypeId: Number(n.mid),
          fields: String(n.flds).split('\x1f'),
          tags: String(n.tags).split(' ').filter(Boolean),
          mtime: Number(n.mod) * 1000,
        }),
      ),
      cards: rows(
        db,
        'SELECT id, nid, did, ord, type, queue, due, ivl, reps, lapses, data FROM cards',
      ).map(c => {
        const card: AnkiCard = {
          ankiId: Number(c.id),
          noteId: Number(c.nid),
          deckId: Number(c.did),
          ord: Number(c.ord),
          type: Number(c.type),
          queue: Number(c.queue),
          due: Number(c.due),
          ivl: Number(c.ivl),
          reps: Number(c.reps),
          lapses: Number(c.lapses),
        };
        try {
          const d = JSON.parse(String(c.data || '{}')) as Record<
            string,
            number
          >;
          if (typeof d.s === 'number' && typeof d.d === 'number') {
            card.memory = {
              s: d.s,
              d: d.d,
              ...(typeof d.lrt === 'number' && {lastReview: d.lrt * 1000}),
            };
          }
        } catch {
          // No usable memory state.
        }
        return card;
      }),
      reviews: rows(db, 'SELECT id, cid, ease, time, type FROM revlog').map(
        r => ({
          ankiId: Number(r.id),
          cardId: Number(r.cid),
          ease: Number(r.ease),
          time: Number(r.time),
          type: Number(r.type),
        }),
      ),
      media: readMedia(files, zstd),
    };
    return collection;
  } finally {
    db.close();
  }
}

function legacyNoteTypes(col: Record<string, unknown>): AnkiNoteType[] {
  const models = JSON.parse(String(col.models)) as Record<
    string,
    {
      id: number;
      name: string;
      type: number;
      css: string;
      flds: {name: string; ord: number}[];
      tmpls: {name: string; ord: number; qfmt: string; afmt: string}[];
    }
  >;
  return Object.values(models).map(m => ({
    ankiId: Number(m.id),
    name: m.name,
    kind: m.type === 1 ? 'cloze' : 'standard',
    fields: [...m.flds].sort((a, b) => a.ord - b.ord).map(f => f.name),
    templates: [...m.tmpls]
      .sort((a, b) => a.ord - b.ord)
      .map(t => ({name: t.name, front: t.qfmt, back: t.afmt})),
    css: m.css ?? '',
  }));
}

function legacyDecks(col: Record<string, unknown>): AnkiDeck[] {
  const decks = JSON.parse(String(col.decks)) as Record<
    string,
    {id: number; name: string}
  >;
  return Object.values(decks).map(d => ({ankiId: Number(d.id), name: d.name}));
}

// Schema 18's protobuf config: NotetypeConfig {kind = 1, css = 3},
// TemplateConfig {q_format = 1, a_format = 2} (Anki's notetypes.proto).
function modernNoteTypes(db: SqlJsDatabase): AnkiNoteType[] {
  const fields = rows(
    db,
    'SELECT ntid, ord, name FROM fields ORDER BY ntid, ord',
  );
  const templates = rows(
    db,
    'SELECT ntid, ord, name, config FROM templates ORDER BY ntid, ord',
  );
  return rows(db, 'SELECT id, name, config FROM notetypes').map(nt => {
    const config = readProto(nt.config as Uint8Array);
    return {
      ankiId: Number(nt.id),
      name: String(nt.name),
      kind: protoNumber(config, 1) === 1 ? 'cloze' : 'standard',
      fields: fields.filter(f => f.ntid === nt.id).map(f => String(f.name)),
      templates: templates
        .filter(t => t.ntid === nt.id)
        .map(t => {
          const c = readProto(t.config as Uint8Array);
          return {
            name: String(t.name),
            front: protoString(c, 1),
            back: protoString(c, 2),
          };
        }),
      css: protoString(config, 3),
    };
  });
}

function modernDecks(db: SqlJsDatabase): AnkiDeck[] {
  return rows(db, 'SELECT id, name FROM decks').map(d => ({
    ankiId: Number(d.id),
    // Schema 18 separates deck levels with \x1f.
    name: String(d.name).split('\x1f').join('::'),
  }));
}

/**
 * The media files, by name. The "media" file maps the zip's numbered files
 * to names: JSON in old packages; in new ones zstd-compressed protobuf
 * MediaEntries {repeated MediaEntry entries = 1}, MediaEntry {name = 1},
 * entry i being file "i", itself zstd-compressed.
 */
function readMedia(files: Record<string, Uint8Array>, zstd: Zstd) {
  const map = files.media;
  if (!map) return [];
  let names: [string, string][];
  if (isZstd(map)) {
    const entries = readProto(zstd(map)).get(1) ?? [];
    names = entries.map((e, i) => [
      String(i),
      protoString(readProto(e as Uint8Array), 1),
    ]);
  } else {
    names = Object.entries(
      JSON.parse(strFromU8(map) || '{}') as Record<string, string>,
    );
  }
  return names
    .filter(([key, name]) => files[key] && name && !/[\\/]/.test(name))
    .map(([key, name]) => {
      const data = files[key];
      return {name, data: isZstd(data) ? zstd(data) : data};
    });
}
