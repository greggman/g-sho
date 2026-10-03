/**
 * Puts a read Anki collection into the store: note types, decks (matched
 * by name), facts (matched by GUID, so importing an updated deck updates
 * it), cards and, if wanted, their schedule and review history. Media is
 * kept on this device.
 *
 * Re-importing never touches the schedule of cards you already have.
 */
import type {Dict} from '../../dict.ts';
import {
  CardState,
  type CardRow,
  type DeckRow,
  type FactRow,
  type NoteTypeRow,
  type ReviewRow,
  type Store,
} from '../../store/store.ts';
import type {Fields, Row, Table} from '../../store/table.ts';
import {
  DECK_DEFAULTS,
  NOTE_TYPE,
  cardId,
  newCard,
  randomId,
  wordFactId,
} from '../../study/model.ts';
import type {AnkiCard, AnkiCollection, AnkiNoteType} from './read.ts';
import {linkAll, noteWord, type LinkFields} from './link.ts';
import {
  cardDirection,
  findDuplicates,
  resolveCard,
  type Candidate,
  type DuplicateChoice,
  type DuplicateReport,
  type KnownChoice,
} from '../../study/duplicates.ts';

export interface ImportOptions {
  /** keep cards' schedules and review history (if the deck has them) */
  keepScheduling: boolean;
  /** word and reading fields, by Anki note type id */
  linkFields: Map<number, LinkFields>;
}

export interface ImportSummary {
  added: number;
  updated: number;
  cards: number;
  decks: string[];
  linked: number;
  media: number;
}

const DAY = 86_400_000;
/** Our own export's note type, whose notes are dictionary words. */
const OWN_NOTE_TYPE = 'g-sho (Japanese)';

function hash(s: string): string {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.codePointAt(0)!, 16777619);
  return (h >>> 0).toString(36);
}

/** The same note type (name and fields) always gets the same id. */
export function noteTypeId(t: AnkiNoteType): string {
  return `nt-${hash([t.name, ...t.fields].join('\x1f'))}`;
}

function base64url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** An imported note's fact id: from its GUID. */
export const factIdFor = (guid: string) => `a-${base64url(guid)}`;

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

export function mimeType(name: string): string {
  return (
    MIME[name.split('.').pop()?.toLowerCase() ?? ''] ??
    'application/octet-stream'
  );
}

/** An Anki card's schedule as FSRS card fields. */
export function scheduleOf(
  c: AnkiCard,
  crt: number,
  lastReview: number | undefined,
): Partial<Fields<CardRow>> {
  const state =
    (
      [
        CardState.New,
        CardState.Learning,
        CardState.Review,
        CardState.Relearning,
      ] as const
    )[c.type] ?? CardState.New;
  if (state === CardState.New) return {};
  const due =
    state === CardState.Review
      ? (crt + c.due * 86_400) * 1000
      : // Learning: seconds, or a day number for steps of a day or more.
        c.due > 1e9
        ? c.due * 1000
        : (crt + c.due * 86_400) * 1000;
  const ivl = Math.max(0, c.ivl);
  const last =
    c.memory?.lastReview ??
    lastReview ??
    (state === CardState.Review ? due - ivl * DAY : due);
  return {
    state,
    due,
    stability: c.memory?.s ?? Math.max(0.1, ivl),
    difficulty: c.memory?.d ?? 5,
    scheduledDays: ivl,
    elapsedDays: 0,
    reps: c.reps,
    lapses: c.lapses,
    lastReview: last,
  };
}

/** Puts rows in the store a thousand at a time. */
function putAll<T extends Row>(table: Table<T>, rows: Fields<T>[]) {
  for (let i = 0; i < rows.length; i += 1000) {
    table.put(...rows.slice(i, i + 1000));
  }
}

/** An import worked out but not saved: what it would write, and its duplicates. */
export interface PreparedImport {
  noteTypes: Fields<NoteTypeRow>[];
  decks: Fields<DeckRow>[];
  facts: Fields<FactRow>[];
  cards: Fields<CardRow>[];
  reviews: Fields<ReviewRow>[];
  media: AnkiCollection['media'];
  duplicates: DuplicateReport;
  summary: ImportSummary;
}

/** What to do with duplicates when saving. */
export interface DuplicateChoices {
  duplicates: DuplicateChoice;
  known: KnownChoice;
}

export const DEFAULT_CHOICES: DuplicateChoices = {
  duplicates: 'copy',
  known: 'suspend',
};

/**
 * Works out the import (linking notes to the dictionary on the way) and
 * which new cards duplicate words you know, without saving anything.
 */
export async function prepareImport(
  store: Store,
  dict: Dict,
  col: AnkiCollection,
  options: ImportOptions,
  progress: (text: string) => void = () => {},
  now = Date.now(),
): Promise<PreparedImport> {
  const usedTypes = new Set(col.notes.map(n => n.noteTypeId));
  const types = new Map(col.noteTypes.map(t => [t.ankiId, t]));

  // Note types.
  const noteTypeRows: Fields<NoteTypeRow>[] = [];
  for (const t of col.noteTypes) {
    if (!usedTypes.has(t.ankiId) || t.name === OWN_NOTE_TYPE) continue;
    noteTypeRows.push({
      id: noteTypeId(t),
      name: t.name,
      kind: t.kind,
      fields: t.fields,
      templates: t.templates,
      css: t.css,
      ankiId: t.ankiId,
    });
  }

  // Decks, matched by name; created as needed.
  const cardDecks = new Set(col.cards.map(c => c.deckId));
  const byName = new Map(store.decks.all().map(d => [d.name, d.id]));
  const deckIds = new Map<number, string>();
  const deckNames: string[] = [];
  const deckRows: Fields<DeckRow>[] = [];
  for (const d of col.decks) {
    if (!cardDecks.has(d.ankiId)) continue;
    let id = byName.get(d.name);
    if (!id) {
      id = randomId();
      deckRows.push({id, name: d.name, ...DECK_DEFAULTS});
      byName.set(d.name, id);
    }
    deckIds.set(d.ankiId, id);
    deckNames.push(d.name);
  }

  // Facts. Our own exported words go back to being dictionary words.
  progress('Linking words to the dictionary…');
  const facts = col.notes.map(n => {
    const t = types.get(n.noteTypeId);
    const own = t?.name === OWN_NOTE_TYPE && /^g-sho-(\d+)$/.exec(n.guid);
    return {note: n, type: t, ownWordId: own ? Number(own[1]) : undefined};
  });
  const linkFieldsOf = (t: AnkiNoteType) =>
    options.linkFields.get(t.ankiId) ?? {word: 0, reading: -1};
  const toLink = facts.filter(f => f.ownWordId === undefined && f.type);
  const links = await linkAll(
    dict,
    toLink.map(f => noteWord(f.note.fields, linkFieldsOf(f.type!))),
    done =>
      progress(
        `Linking words to the dictionary (${done} of ${toLink.length})…`,
      ),
  );
  const linkOf = new Map(toLink.map((f, i) => [f.note.ankiId, links[i]]));

  let added = 0;
  let updated = 0;
  let linked = 0;
  const factRows: Fields<FactRow>[] = [];
  /** by Anki note id: our fact id, its word, its note type, a sample */
  const factInfo = new Map<
    number,
    {
      id: string;
      wordId?: number;
      type: AnkiNoteType;
      fields: string[];
      own: boolean;
    }
  >();
  for (const {note, type, ownWordId} of facts) {
    if (!type) continue;
    if (ownWordId !== undefined) {
      const field = (name: string) =>
        note.fields[type.fields.indexOf(name)] ?? '';
      const id = wordFactId(ownWordId);
      factInfo.set(note.ankiId, {
        id,
        wordId: ownWordId,
        type,
        fields: note.fields,
        own: true,
      });
      if (store.facts.get(id)) updated++;
      else added++;
      linked++;
      factRows.push({
        id,
        noteType: NOTE_TYPE,
        fields: [field('Word'), field('Reading'), field('Meaning')],
        tags: note.tags.filter(t => t !== 'g-sho'),
        guid: note.guid,
        wordId: ownWordId,
        linkConfidence: 'exact',
      });
      continue;
    }
    const id = factIdFor(note.guid);
    const existing = store.facts.get(id);
    if (existing) updated++;
    else added++;
    const link =
      linkOf.get(note.ankiId) ??
      (existing?.wordId
        ? {
            wordId: existing.wordId,
            confidence: existing.linkConfidence ?? 'word',
          }
        : undefined);
    if (link) linked++;
    factInfo.set(note.ankiId, {
      id,
      wordId: link?.wordId,
      type,
      fields: note.fields,
      own: false,
    });
    factRows.push({
      id,
      noteType: noteTypeId(type),
      fields: note.fields,
      tags: note.tags,
      guid: note.guid,
      ...(link && {wordId: link.wordId, linkConfidence: link.confidence}),
    });
  }

  // Cards: new ones only; cards you already have keep their schedule.
  const lastReviews = new Map<number, number>();
  for (const r of col.reviews) {
    lastReviews.set(
      r.cardId,
      Math.max(lastReviews.get(r.cardId) ?? 0, r.ankiId),
    );
  }
  const cards = [...col.cards].sort((a, b) =>
    // New cards in Anki's order (their due is a position).
    a.type === 0 && b.type === 0 ? a.due - b.due : a.ankiId - b.ankiId,
  );
  const cardRows: Fields<CardRow>[] = [];
  const candidates: Candidate[] = [];
  const created = new Map<number, string>();
  let position = 0;
  for (const c of cards) {
    const info = factInfo.get(c.noteId);
    const deckId = deckIds.get(c.deckId);
    if (!info || !deckId) continue;
    const id = cardId(info.id, c.ord);
    if (store.cards.get(id)) continue;
    const base = newCard(info.id, deckId, c.ord, now + position++);
    const schedule = options.keepScheduling
      ? scheduleOf(c, col.crt, lastReviews.get(c.ankiId))
      : {};
    const row: Fields<CardRow> = {
      ...base,
      ...schedule,
      direction: info.own
        ? 'recognition'
        : cardDirection(info.type, c.ord, linkFieldsOf(info.type), info.fields),
      ...(c.queue === -1 && {suspended: 1 as const}),
    };
    cardRows.push(row);
    candidates.push({card: row, wordId: info.wordId});
    created.set(c.ankiId, id);
  }

  // Review history of the cards being added.
  const reviewRows: Fields<ReviewRow>[] = [];
  if (options.keepScheduling) {
    const seen = new Set<number>();
    for (const r of [...col.reviews].sort((a, b) => a.ankiId - b.ankiId)) {
      const id = created.get(r.cardId);
      if (!id || r.type > 3 || r.ease < 1 || r.ease > 4) continue;
      const first = !seen.has(r.cardId);
      seen.add(r.cardId);
      reviewRows.push({
        id: `a${r.ankiId}-${r.cardId}`,
        cardId: id,
        t: r.ankiId,
        rating: r.ease,
        durationMs: Math.max(0, Math.min(600_000, r.time)),
        state:
          r.type === 0
            ? first
              ? CardState.New
              : CardState.Learning
            : r.type === 2
              ? CardState.Relearning
              : CardState.Review,
        stability: 0,
        difficulty: 0,
        elapsedDays: 0,
        scheduledDays: 0,
      });
    }
  }

  return {
    noteTypes: noteTypeRows,
    decks: deckRows,
    facts: factRows,
    cards: cardRows,
    reviews: reviewRows,
    media: col.media,
    duplicates: findDuplicates(store, candidates),
    summary: {
      added,
      updated,
      cards: cardRows.length,
      decks: deckNames,
      linked,
      media: col.media.length,
    },
  };
}

/** Saves a prepared import, with the choices for duplicates. */
export async function commitImport(
  store: Store,
  prepared: PreparedImport,
  choices: DuplicateChoices = DEFAULT_CHOICES,
  progress: (text: string) => void = () => {},
): Promise<ImportSummary> {
  progress('Saving…');
  putAll(store.noteTypes, prepared.noteTypes);
  putAll(store.decks, prepared.decks);
  putAll(store.facts, prepared.facts);
  putAll(
    store.cards,
    prepared.cards.map(c =>
      resolveCard(c, prepared.duplicates, choices.duplicates, choices.known),
    ),
  );
  putAll(store.reviews, prepared.reviews);
  if (prepared.media.length) {
    progress('Saving images and sounds…');
    await store.backend.putMedia(
      prepared.media.map(m => ({
        name: m.name,
        data: new Blob([m.data as Uint8Array<ArrayBuffer>], {
          type: mimeType(m.name),
        }),
      })),
    );
  }
  return prepared.summary;
}

/** Prepares and saves an import in one go. */
export async function importCollection(
  store: Store,
  dict: Dict,
  col: AnkiCollection,
  options: ImportOptions,
  progress: (text: string) => void = () => {},
  choices: DuplicateChoices = DEFAULT_CHOICES,
): Promise<ImportSummary> {
  const prepared = await prepareImport(store, dict, col, options, progress);
  return commitImport(store, prepared, choices, progress);
}
