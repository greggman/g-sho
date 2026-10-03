/**
 * Duplicates and known words: nothing wastes study time like a deck full
 * of words you already know.
 *
 * Two cards are duplicates when they're about the same dictionary word and
 * ask the same way (their direction). A word is known if you marked it
 * known. When a new card duplicates one you've studied, it can take that
 * card's schedule (so it comes up when you'd see the word anyway), or be
 * suspended.
 */
import type {LinkFields} from '../anki/import/link.ts';
import {
  type CardDirection,
  type CardRow,
  type NoteTypeRow,
  type Store,
} from '../store/store.ts';
import {fieldsOf, type Fields} from '../store/table.ts';
import {NOTE_TYPE} from './model.ts';

/** What to do with a new card whose word you already study. */
export type DuplicateChoice = 'copy' | 'suspend' | 'keep';
/** What to do with a new card whose word you marked known. */
export type KnownChoice = 'suspend' | 'keep';

/** The field names a template shows ({{Name}}, {{filter:Name}}). */
function templateFields(template: string): Set<string> {
  const out = new Set<string>();
  for (const m of template.matchAll(/\{\{([^#^/{}][^{}]*?)\}\}/g)) {
    out.add(m[1].split(':').pop()!.trim());
  }
  return out;
}

/**
 * What a card of the note type asks, from what its front shows: the word
 * field means recognition; only sound fields, listening; otherwise
 * production. Cloze cards ask about a sentence: "other".
 */
export function cardDirection(
  nt: Pick<NoteTypeRow, 'kind' | 'fields' | 'templates'>,
  ord: number,
  link: LinkFields,
  sample: string[] = [],
): CardDirection {
  if (nt.kind === 'cloze') return 'other';
  const template = nt.templates[ord] ?? nt.templates[0];
  if (!template) return 'other';
  const shown = templateFields(template.front);
  const word = nt.fields[link.word];
  if (word && shown.has(word)) return 'recognition';
  const fields = [...shown].filter(f => nt.fields.includes(f));
  if (!fields.length) return 'other';
  const isSound = (f: string) =>
    /audio|sound|voice/i.test(f) ||
    /^\s*\[sound:[^\]]+\]\s*$/.test(sample[nt.fields.indexOf(f)] ?? '');
  if (fields.every(isSound)) return 'listening';
  return 'production';
}

/** A card's direction; built-in word cards are recognition. */
export function directionOf(
  store: Store,
  card: CardRow,
): CardDirection | undefined {
  if (card.direction) return card.direction;
  const fact = store.facts.get(card.factId);
  return fact?.noteType === NOTE_TYPE ? 'recognition' : undefined;
}

/** Words marked known. */
export function knownWords(store: Store): Set<number> {
  return new Set(
    store.marks
      .all()
      .filter(m => m.kind === 'known')
      .map(m => m.wordId),
  );
}

/**
 * The cards you have for each word and direction: the most-studied one
 * (most stable). Keys are `${wordId}/${direction}`.
 */
export function studiedCards(
  store: Store,
  except: Set<string> = new Set(),
): Map<string, CardRow> {
  const out = new Map<string, CardRow>();
  for (const c of store.cards.all()) {
    if (except.has(c.id) || c.suspended || c.reps === 0) continue;
    const wordId = store.facts.get(c.factId)?.wordId;
    const dir = directionOf(store, c);
    if (!wordId || !dir || dir === 'other') continue;
    const key = `${wordId}/${dir}`;
    const best = out.get(key);
    if (!best || c.stability > best.stability) out.set(key, c);
  }
  return out;
}

/** The FSRS fields of a card, to give another card the same schedule. */
export function scheduleFields(c: CardRow): Partial<Fields<CardRow>> {
  return {
    state: c.state,
    due: c.due,
    stability: c.stability,
    difficulty: c.difficulty,
    elapsedDays: c.elapsedDays,
    scheduledDays: c.scheduledDays,
    learningSteps: c.learningSteps,
    reps: c.reps,
    lapses: c.lapses,
    ...(c.lastReview !== undefined && {lastReview: c.lastReview}),
  };
}

export interface Candidate {
  card: Fields<CardRow>;
  wordId?: number;
}

export interface DuplicateReport {
  /** new cards for a word and direction you've studied: card id → studied card */
  studied: Map<string, CardRow>;
  /** new cards for words marked known (and not in `studied`) */
  known: Set<string>;
  /** cards repeating a word and direction earlier in the same list */
  repeats: number;
}

/** Which of these new cards duplicate what you know. */
export function findDuplicates(
  store: Store,
  candidates: Candidate[],
  except: Set<string> = new Set(),
): DuplicateReport {
  const studied = studiedCards(store, except);
  const known = knownWords(store);
  const report: DuplicateReport = {
    studied: new Map(),
    known: new Set(),
    repeats: 0,
  };
  const seen = new Set<string>();
  for (const {card, wordId} of candidates) {
    if (!wordId || card.reps > 0) continue;
    const dir = card.direction;
    if (dir && dir !== 'other') {
      const key = `${wordId}/${dir}`;
      if (seen.has(key)) report.repeats++;
      seen.add(key);
      const match = studied.get(key);
      if (match) {
        report.studied.set(card.id, match);
        continue;
      }
    }
    if (known.has(wordId)) report.known.add(card.id);
  }
  return report;
}

/** A new card, as the duplicate choices make it. */
export function resolveCard(
  card: Fields<CardRow>,
  report: DuplicateReport,
  duplicates: DuplicateChoice,
  knownChoice: KnownChoice,
): Fields<CardRow> {
  const match = report.studied.get(card.id);
  if (match) {
    if (duplicates === 'copy') return {...card, ...scheduleFields(match)};
    if (duplicates === 'suspend')
      return {...card, suspended: 1, dupOf: match.id};
    return card;
  }
  if (report.known.has(card.id) && knownChoice === 'suspend') {
    return {...card, suspended: 1};
  }
  return card;
}

/** For a deck already in the store: its new cards that duplicate what you know. */
export function deckDuplicates(store: Store, deckId: string): DuplicateReport {
  const cards = store.cards.all().filter(c => c.deckId === deckId);
  return findDuplicates(
    store,
    // Suspended cards are dealt with already.
    cards
      .filter(c => !c.suspended)
      .map(c => ({
        card: {...c, direction: directionOf(store, c)},
        wordId: store.facts.get(c.factId)?.wordId,
      })),
    // Compare with cards in other decks (and studied ones in this deck).
    new Set(cards.filter(c => c.reps === 0).map(c => c.id)),
  );
}

/** Applies the choices to a deck's duplicates; returns how many changed. */
export function applyDeckDuplicates(
  store: Store,
  report: DuplicateReport,
  duplicates: DuplicateChoice,
  knownChoice: KnownChoice,
): number {
  const changed: Fields<CardRow>[] = [];
  for (const id of [...report.studied.keys(), ...report.known]) {
    const card = store.cards.get(id);
    if (!card) continue;
    const fields = fieldsOf(card);
    const next = resolveCard(fields, report, duplicates, knownChoice);
    if (next !== fields) changed.push(next);
  }
  if (changed.length) store.cards.put(...changed);
  return changed.length;
}
