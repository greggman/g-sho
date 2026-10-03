/**
 * Writes an Anki package (.apkg): a zip holding a SQLite collection and a
 * media list. We write the legacy format (collection.anki2, schema 11),
 * which every Anki version imports. Cards keep their schedule: Anki's own
 * fields are filled in from FSRS state, the FSRS memory state goes in the
 * card's data (Anki 23.10+ reads it), and the review log comes along so Anki
 * can recompute it.
 *
 * The SQLite engine (sql.js) is passed in, so the same code runs in the
 * browser and in tests.
 */
import {strToU8, zipSync} from 'fflate';

/** The parts of sql.js we use. */
export interface SqlJs {
  Database: new (data?: Uint8Array) => SqlJsDatabase;
}

export interface SqlJsDatabase {
  run(sql: string, params?: unknown[]): void;
  exec(sql: string): {columns: string[]; values: unknown[][]}[];
  export(): Uint8Array;
  close(): void;
}

export interface ApkgNoteType {
  /** Anki's model id: keep it the same between exports */
  id: number;
  name: string;
  fields: string[];
  templates: {name: string; front: string; back: string}[];
  css: string;
}

export interface ApkgCard {
  ord: number;
  /** FSRS state (0 new, 1 learning, 2 review, 3 relearning) */
  state: number;
  due: number;
  stability: number;
  difficulty: number;
  scheduledDays: number;
  reps: number;
  lapses: number;
  suspended?: boolean;
  /** desired retention of its deck */
  retention: number;
  reviews: {t: number; rating: number; durationMs: number; state: number}[];
}

export interface ApkgNote {
  guid: string;
  fields: string[];
  tags: string[];
  /** last change (ms) */
  mtime: number;
  cards: ApkgCard[];
}

export interface ApkgInput {
  deckName: string;
  noteType: ApkgNoteType;
  notes: ApkgNote[];
  now?: number;
}

const DAY_MS = 86_400_000;

const SCHEMA = `
CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null,
  scm integer not null, ver integer not null, dty integer not null, usn integer not null,
  ls integer not null, conf text not null, models text not null, decks text not null,
  dconf text not null, tags text not null);
CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null,
  mod integer not null, usn integer not null, tags text not null, flds text not null,
  sfld integer not null, csum integer not null, flags integer not null, data text not null);
CREATE TABLE cards (id integer primary key, nid integer not null, did integer not null,
  ord integer not null, mod integer not null, usn integer not null, type integer not null,
  queue integer not null, due integer not null, ivl integer not null, factor integer not null,
  reps integer not null, lapses integer not null, left integer not null, odue integer not null,
  odid integer not null, flags integer not null, data text not null);
CREATE TABLE revlog (id integer primary key, cid integer not null, usn integer not null,
  ease integer not null, ivl integer not null, lastIvl integer not null, factor integer not null,
  time integer not null, type integer not null);
CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);
CREATE INDEX ix_notes_usn on notes (usn);
CREATE INDEX ix_cards_usn on cards (usn);
CREATE INDEX ix_revlog_usn on revlog (usn);
CREATE INDEX ix_cards_nid on cards (nid);
CREATE INDEX ix_cards_sched on cards (did, queue, due);
CREATE INDEX ix_revlog_cid on revlog (cid);
CREATE INDEX ix_notes_csum on notes (csum);
`;

/** The collection's defaults, as Anki itself writes them in schema 11. */
const CONF = {
  activeDecks: [1],
  curDeck: 1,
  newSpread: 0,
  collapseTime: 1200,
  timeLim: 0,
  estTimes: true,
  dueCounts: true,
  curModel: null,
  nextPos: 1,
  sortType: 'noteFld',
  sortBackwards: false,
  addToCur: true,
};

const DCONF = {
  '1': {
    id: 1,
    name: 'Default',
    mod: 0,
    usn: 0,
    maxTaken: 60,
    autoplay: true,
    timer: 0,
    replayq: true,
    dyn: false,
    new: {
      bury: false,
      delays: [1, 10],
      initialFactor: 2500,
      ints: [1, 4, 0],
      order: 1,
      perDay: 20,
    },
    lapse: {delays: [10], leechAction: 1, leechFails: 8, minInt: 1, mult: 0},
    rev: {
      bury: false,
      ease4: 1.3,
      ivlFct: 1,
      maxIvl: 36500,
      perDay: 200,
      hardFactor: 1.2,
    },
  },
};

function deckJson(id: number, name: string, mod: number) {
  return {
    id,
    name,
    mod,
    usn: -1,
    desc: '',
    dyn: 0,
    conf: 1,
    collapsed: false,
    browserCollapsed: false,
    extendNew: 0,
    extendRev: 0,
    newToday: [0, 0],
    revToday: [0, 0],
    lrnToday: [0, 0],
    timeToday: [0, 0],
  };
}

function modelJson(t: ApkgNoteType, did: number, mod: number) {
  return {
    id: t.id,
    name: t.name,
    type: 0,
    mod,
    usn: -1,
    sortf: 0,
    did,
    tmpls: t.templates.map((tm, ord) => ({
      name: tm.name,
      ord,
      qfmt: tm.front,
      afmt: tm.back,
      bqfmt: '',
      bafmt: '',
      did: null,
      bfont: '',
      bsize: 0,
    })),
    flds: t.fields.map((name, ord) => ({
      name,
      ord,
      sticky: false,
      rtl: false,
      font: 'Arial',
      size: 20,
      media: [],
    })),
    css: t.css,
    latexPre:
      '\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n',
    latexPost: '\\end{document}',
    latexsvg: false,
    req: t.templates.map((_, ord) => [ord, 'any', [0]]),
    tags: [],
    vers: [],
  };
}

/** Text without HTML, as Anki compares and sorts it. */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .trim();
}

/** Anki's note checksum: the first 8 hex digits of the SHA-1 of field 1. */
async function checksum(text: string): Promise<number> {
  const digest = await crypto.subtle.digest('SHA-1', strToU8(text));
  const b = new Uint8Array(digest);
  return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
}

/**
 * Anki's card type/queue for an FSRS state. A review card's due is a day
 * number counted from the collection's creation (crtDay); `today` is
 * today's.
 */
function ankiSchedule(
  card: ApkgCard,
  crtDay: number,
  now: number,
  position: number,
) {
  const today = Math.floor(now / DAY_MS) - crtDay;
  const reviewDue = today + Math.round((card.due - now) / DAY_MS);
  const ivl = Math.max(1, Math.round(card.scheduledDays));
  switch (card.state) {
    case 1: // learning: due is a time (seconds)
      return {type: 1, queue: 1, due: Math.floor(card.due / 1000), ivl: 0};
    case 2:
      return {type: 2, queue: 2, due: reviewDue, ivl};
    case 3: // relearning
      return {type: 3, queue: 1, due: Math.floor(card.due / 1000), ivl};
    default:
      return {type: 0, queue: 0, due: position, ivl: 0};
  }
}

export async function writeApkg(
  SQL: SqlJs,
  input: ApkgInput,
): Promise<Uint8Array> {
  const now = input.now ?? Date.now();
  const nowS = Math.floor(now / 1000);
  // The collection was "created" at the start of the earliest day needed,
  // so review due days (counted from it) aren't negative.
  const earliest = Math.min(
    now,
    ...input.notes.flatMap(n => n.cards.map(c => c.due)),
  );
  const crtDay = Math.floor(earliest / DAY_MS);
  const did = 1_700_000_000_000 + (input.noteType.id % 1_000_000);

  const db = new SQL.Database();
  try {
    db.exec(SCHEMA);
    db.run('INSERT INTO col VALUES (1, ?, ?, ?, 11, 0, 0, 0, ?, ?, ?, ?, ?)', [
      crtDay * 86_400,
      now,
      now,
      JSON.stringify(CONF),
      JSON.stringify({
        [input.noteType.id]: modelJson(input.noteType, did, nowS),
      }),
      JSON.stringify({
        '1': deckJson(1, 'Default', nowS),
        [did]: deckJson(did, input.deckName, nowS),
      }),
      JSON.stringify(DCONF),
      '{}',
    ]);

    // Ids are millisecond timestamps in Anki; any unique numbers work.
    let nextId = now;
    const usedRevlog = new Set<number>();
    let position = 0;
    for (const note of input.notes) {
      const nid = nextId++;
      const first = stripHtml(note.fields[0] ?? '');
      db.run('INSERT INTO notes VALUES (?, ?, ?, ?, -1, ?, ?, ?, ?, 0, ?)', [
        nid,
        note.guid,
        input.noteType.id,
        Math.floor(note.mtime / 1000),
        note.tags.length ? ` ${note.tags.join(' ')} ` : '',
        note.fields.join('\x1f'),
        first,
        await checksum(first),
        '',
      ]);
      for (const card of note.cards) {
        const cid = nextId++;
        const s = ankiSchedule(card, crtDay, now, position++);
        const memory =
          card.state === 0
            ? {}
            : {
                s: Math.round(card.stability * 1000) / 1000,
                d: Math.round(card.difficulty * 1000) / 1000,
                dr: card.retention,
              };
        db.run(
          'INSERT INTO cards VALUES (?, ?, ?, ?, ?, -1, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?)',
          [
            cid,
            nid,
            did,
            card.ord,
            nowS,
            s.type,
            card.suspended ? -1 : s.queue,
            s.due,
            s.ivl,
            card.state === 0 ? 0 : 2500,
            card.reps,
            card.lapses,
            card.state === 1 || card.state === 3 ? 1001 : 0,
            JSON.stringify(memory),
          ],
        );
        for (const r of card.reviews) {
          let id = r.t;
          while (usedRevlog.has(id)) id++;
          usedRevlog.add(id);
          db.run('INSERT INTO revlog VALUES (?, ?, -1, ?, 0, 0, 0, ?, ?)', [
            id,
            cid,
            r.rating,
            Math.min(60_000, Math.round(r.durationMs)),
            // learn, review, relearn
            r.state === 2 ? 1 : r.state === 3 ? 2 : 0,
          ]);
        }
      }
    }
    return zipSync({
      'collection.anki2': db.export(),
      media: strToU8('{}'),
    });
  } finally {
    db.close();
  }
}
