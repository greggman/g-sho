/**
 * Exporting a deck to Anki: as an .apkg file, or straight into Anki through
 * AnkiConnect. Words use our own note type, "g-sho (Japanese)", with its
 * fields filled from the dictionary like the add-to-Anki button does.
 */
import {AnkiConnect} from '../anki/connect.ts';
import {
  type ApkgCard,
  type ApkgNote,
  type ApkgNoteType,
  writeApkg,
} from '../anki/apkg.ts';
import {
  DEFAULT_NOTE_TYPE,
  OWN_FIELD_MAP,
  ankiFurigana,
  ownNoteType,
  sourceValues,
} from '../anki/note.ts';
import type {Dict} from '../dict.ts';
import {posLabel} from '../render.ts';
import {CardState, type DeckRow, type Store} from '../store/store.ts';
import {NOTE_TYPE} from './model.ts';

/** Kept the same in every export, so Anki recognizes the note type. */
const NOTE_TYPE_ID = 1_790_000_000_001;
const FIELDS = Object.keys(OWN_FIELD_MAP);

export function apkgNoteType(): ApkgNoteType {
  const t = ownNoteType();
  return {
    id: NOTE_TYPE_ID,
    name: t.modelName,
    fields: t.inOrderFields,
    css: t.css,
    templates: t.cardTemplates.map(c => ({
      name: c.Name,
      front: c.Front,
      back: c.Back,
    })),
  };
}

/** A deck's words as notes, with their cards and reviews. */
export async function deckNotes(
  store: Store,
  dict: Dict,
  deck: DeckRow,
): Promise<{notes: ApkgNote[]; wordIds: number[]; skipped: number}> {
  const cards = store.cards.all().filter(c => c.deckId === deck.id);
  const reviews = new Map<string, ApkgCard['reviews']>();
  for (const r of store.reviews.all()) {
    let list = reviews.get(r.cardId);
    if (!list) reviews.set(r.cardId, (list = []));
    list.push({
      t: r.t,
      rating: r.rating,
      durationMs: r.durationMs,
      state: r.state,
    });
  }
  const facts = [...new Set(cards.map(c => c.factId))]
    .map(id => store.facts.get(id))
    .filter(f => f !== undefined);
  // Only words for now; imported decks bring their own note types later.
  const words = facts.filter(f => f.noteType === NOTE_TYPE && f.wordId);
  const entries = new Map(
    (await dict.entries(words.map(f => f.wordId!))).map(e => [e.id, e]),
  );
  const site = new URL('/', location.origin).href;
  const notes = words.map(fact => {
    const entry = entries.get(fact.wordId!);
    const [word = '', reading = '', meaning = ''] = fact.fields;
    const link = `${site}?q=${encodeURIComponent(word)}`;
    const values = entry
      ? sourceValues(entry, {posLabel: tag => posLabel(dict, tag), link})
      : {
          word,
          reading: reading || word,
          furigana: ankiFurigana(word, reading || undefined),
          meaning,
          pos: '',
          example: '',
          id: String(fact.wordId),
          link,
        };
    return {
      guid: fact.guid,
      fields: FIELDS.map(
        f => (values as Record<string, string>)[OWN_FIELD_MAP[f]] ?? '',
      ),
      tags: fact.tags,
      mtime: fact.mtime,
      cards: cards
        .filter(c => c.factId === fact.id)
        .map(c => ({
          ord: c.ord,
          state: c.state,
          due: c.due,
          stability: c.stability,
          difficulty: c.difficulty,
          scheduledDays: c.scheduledDays,
          reps: c.reps,
          lapses: c.lapses,
          suspended: !!c.suspended,
          retention: deck.retention,
          reviews: (reviews.get(c.id) ?? []).sort((a, b) => a.t - b.t),
        })),
    };
  });
  return {
    notes,
    wordIds: words.map(f => f.wordId!),
    skipped: facts.length - words.length,
  };
}

/**
 * The deck as an .apkg file. Notes from imported decks aren't included yet
 * (`skipped` counts them).
 */
export async function exportApkg(
  store: Store,
  dict: Dict,
  deck: DeckRow,
): Promise<{blob: Blob; skipped: number}> {
  const initSqlJs = (await import('sql.js')).default;
  const SQL = await initSqlJs({locateFile: () => '/sql-wasm.wasm'});
  const {notes, skipped} = await deckNotes(store, dict, deck);
  const bytes = await writeApkg(SQL, {
    deckName: deck.name,
    noteType: apkgNoteType(),
    notes,
  });
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], {
    type: 'application/octet-stream',
  });
  return {blob, skipped};
}

/** Saves a file with the browser's download. */
export function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

export interface SendResult {
  added: number;
  updated: number;
  failed: number;
  /** notes from imported decks, not sent (not supported yet) */
  skipped: number;
}

/**
 * Sends the deck's words into Anki: notes already there (same JMdict ID)
 * are updated, others added to a deck of the same name. Review cards get
 * their due date; full FSRS state only travels in an .apkg.
 */
export async function sendToAnki(
  anki: AnkiConnect,
  store: Store,
  dict: Dict,
  deck: DeckRow,
  progress: (text: string) => void,
): Promise<SendResult> {
  progress('Connecting to Anki…');
  await anki.requestPermission();
  const models = await anki.modelNames();
  if (!models.includes(DEFAULT_NOTE_TYPE)) {
    await anki.invoke('createModel', ownNoteType());
  }
  await anki.invoke('createDeck', {deck: deck.name});
  const {notes, wordIds, skipped} = await deckNotes(store, dict, deck);

  progress('Looking for words already in Anki…');
  const found = await anki.invoke<{result: number[] | null}[]>('multi', {
    actions: wordIds.map(id => ({
      action: 'findNotes',
      params: {query: `"note:${DEFAULT_NOTE_TYPE}" JMdictId:${id}`},
    })),
  });
  const result: SendResult = {added: 0, updated: 0, failed: 0, skipped};
  const toAdd: {note: ApkgNote; index: number}[] = [];
  const noteIds: (number | null)[] = notes.map(() => null);
  for (const [i, note] of notes.entries()) {
    const existing = found[i]?.result?.[0];
    if (existing) {
      noteIds[i] = existing;
      await anki.invoke('updateNoteFields', {
        note: {
          id: existing,
          fields: Object.fromEntries(FIELDS.map((f, j) => [f, note.fields[j]])),
        },
      });
      result.updated++;
    } else {
      toAdd.push({note, index: i});
    }
  }
  for (let start = 0; start < toAdd.length; start += 100) {
    progress(`Adding words (${start} of ${toAdd.length})…`);
    const batch = toAdd.slice(start, start + 100);
    const ids = await anki.invoke<(number | null)[]>('addNotes', {
      notes: batch.map(({note}) => ({
        deckName: deck.name,
        modelName: DEFAULT_NOTE_TYPE,
        fields: Object.fromEntries(FIELDS.map((f, j) => [f, note.fields[j]])),
        tags: ['g-sho', ...note.tags],
        options: {allowDuplicate: true},
      })),
    });
    ids.forEach((id, j) => {
      noteIds[batch[j].index] = id;
      if (id) result.added++;
      else result.failed++;
    });
  }

  // Due dates for cards that have been studied.
  progress('Setting due dates…');
  const known = noteIds.filter((id): id is number => id !== null);
  const info = await anki.invoke<{noteId: number; cards: number[]}[]>(
    'notesInfo',
    {notes: known},
  );
  const cardsOf = new Map(info.map(n => [n.noteId, n.cards]));
  const byDays = new Map<string, number[]>();
  const suspend: number[] = [];
  const now = Date.now();
  notes.forEach((note, i) => {
    const ankiCards = cardsOf.get(noteIds[i] ?? -1) ?? [];
    for (const c of note.cards) {
      const cid = ankiCards[c.ord];
      if (!cid) continue;
      if (c.suspended) suspend.push(cid);
      if (c.state === CardState.New) continue;
      const days = Math.max(0, Math.round((c.due - now) / 86_400_000));
      // "N!" also sets the interval to N days.
      const key = c.state === CardState.Review ? `${days}!` : '0';
      let list = byDays.get(key);
      if (!list) byDays.set(key, (list = []));
      list.push(cid);
    }
  });
  for (const [days, cards] of byDays) {
    await anki.invoke('setDueDate', {cards, days});
  }
  if (suspend.length) await anki.invoke('suspend', {cards: suspend});
  return result;
}
