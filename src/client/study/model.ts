/**
 * Study data: decks, the facts and cards made from words, and what's due.
 * Scheduling itself (FSRS) is in scheduler.ts, loaded with the study page;
 * this module is small enough for every page (the "Study" button on
 * entries uses it).
 */
import type {Entry} from '../../shared/types.ts';
import {headword} from '../forms.ts';
import {
  CardState,
  type CardRow,
  type DeckRow,
  type FactRow,
  type Store,
} from '../store/store.ts';
import type {Fields} from '../store/table.ts';

export const DEFAULT_DECK = 'default';
/** The built-in note type: fields [word, reading, meaning]. */
export const NOTE_TYPE = 'g-sho';
/** Learning cards due within this long are shown now (Anki's default). */
export const LEARN_AHEAD = 20 * 60 * 1000;
/** A study day starts at 4 am local time, like Anki's. */
const ROLLOVER_HOUR = 4;

export const DECK_DEFAULTS = {
  newPerDay: 20,
  reviewsPerDay: 200,
  retention: 0.9,
};

/** When the current study day started. */
export function dayStart(now: number): number {
  const d = new Date(now);
  if (d.getHours() < ROLLOVER_HOUR) d.setDate(d.getDate() - 1);
  d.setHours(ROLLOVER_HOUR, 0, 0, 0);
  return d.getTime();
}

export function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/** The default deck, created the first time it's needed. */
export function defaultDeck(store: Store): DeckRow {
  return (
    store.decks.get(DEFAULT_DECK) ??
    store.decks.put({id: DEFAULT_DECK, name: 'My words', ...DECK_DEFAULTS})[0]
  );
}

/** The deck words are added to: chosen on the study page. */
export function addToDeck(store: Store): DeckRow {
  const chosen = (store.settings.get('study')?.value as {addTo?: string})
    ?.addTo;
  return (chosen && store.decks.get(chosen)) || defaultDeck(store);
}

export function setAddToDeck(store: Store, deckId: string) {
  store.settings.put({id: 'study', value: {addTo: deckId}});
}

export const wordFactId = (wordId: number) => `w:${wordId}`;
export const cardId = (factId: string, ord: number) => `${factId}:${ord}`;

/** The deck a word is being studied in, if any. */
export function studyingIn(store: Store, wordId: number): DeckRow | undefined {
  const card = store.cards.get(cardId(wordFactId(wordId), 0));
  return card && store.decks.get(card.deckId);
}

/** A card that hasn't been studied yet. */
export function newCard(
  factId: string,
  deckId: string,
  ord: number,
  now: number,
): Fields<CardRow> {
  return {
    id: cardId(factId, ord),
    factId,
    deckId,
    ord,
    due: now,
    stability: 0,
    difficulty: 0,
    elapsedDays: 0,
    scheduledDays: 0,
    learningSteps: 0,
    reps: 0,
    lapses: 0,
    state: CardState.New,
    added: now,
  };
}

/** Adds a dictionary word to a deck: a fact and its recognition card. */
export function addWord(
  store: Store,
  entry: Entry,
  deck = addToDeck(store),
  now = Date.now(),
) {
  const id = wordFactId(entry.id);
  const head = headword(entry);
  const fact: Fields<FactRow> = {
    id,
    noteType: NOTE_TYPE,
    fields: [
      head.text,
      head.reading ?? '',
      entry.s
        .slice(0, 3)
        .map(s => s.g.join('; '))
        .join(' / '),
    ],
    tags: [],
    guid: `g-sho-${entry.id}`,
    wordId: entry.id,
  };
  store.facts.put(fact);
  store.cards.put(newCard(id, deck.id, 0, now));
}

/** Stops studying a word: its fact and cards go (its reviews stay). */
export function removeWord(store: Store, wordId: number) {
  const id = wordFactId(wordId);
  store.facts.delete(id);
  store.cards.delete(
    ...store.cards
      .all()
      .filter(c => c.factId === id)
      .map(c => c.id),
  );
}

export interface DeckCounts {
  new: number;
  learning: number;
  review: number;
}

/** What to study now: learning cards first, then reviews, then new. */
export interface Queue extends DeckCounts {
  cards: CardRow[];
}

/**
 * The cards to study now in the given decks (all decks if omitted), within
 * each deck's daily limits.
 */
export function buildQueue(
  store: Store,
  deckIds?: string[],
  now = Date.now(),
): Queue {
  const decks = new Map(
    store.decks
      .all()
      .filter(d => !deckIds || deckIds.includes(d.id))
      .map(d => [d.id, d]),
  );
  const cards = store.cards.all().filter(c => decks.has(c.deckId));
  const byId = new Map(cards.map(c => [c.id, c]));

  // What each deck has used of today's limits.
  const since = dayStart(now);
  const newToday = new Map<string, Set<string>>();
  const reviewsToday = new Map<string, number>();
  for (const r of store.reviews.all()) {
    if (r.t < since) continue;
    const card = byId.get(r.cardId);
    if (!card) continue;
    if (r.state === CardState.New) {
      let set = newToday.get(card.deckId);
      if (!set) newToday.set(card.deckId, (set = new Set()));
      set.add(card.id);
    } else if (r.state === CardState.Review) {
      reviewsToday.set(card.deckId, (reviewsToday.get(card.deckId) ?? 0) + 1);
    }
  }

  const learning: CardRow[] = [];
  const review: CardRow[] = [];
  const fresh: CardRow[] = [];
  const perDeck = new Map<string, {review: CardRow[]; fresh: CardRow[]}>();
  for (const c of cards) {
    if (c.suspended) continue;
    if (c.state === CardState.Learning || c.state === CardState.Relearning) {
      if (c.due <= now + LEARN_AHEAD) learning.push(c);
      continue;
    }
    let d = perDeck.get(c.deckId);
    if (!d) perDeck.set(c.deckId, (d = {review: [], fresh: []}));
    if (c.state === CardState.Review && c.due <= now) d.review.push(c);
    else if (c.state === CardState.New) d.fresh.push(c);
  }
  for (const [deckId, d] of perDeck) {
    const deck = decks.get(deckId)!;
    d.review.sort((a, b) => a.due - b.due);
    d.fresh.sort((a, b) => a.added - b.added);
    const reviewsLeft = Math.max(
      0,
      deck.reviewsPerDay - (reviewsToday.get(deckId) ?? 0),
    );
    const newLeft = Math.max(
      0,
      deck.newPerDay - (newToday.get(deckId)?.size ?? 0),
    );
    review.push(...d.review.slice(0, reviewsLeft));
    fresh.push(...d.fresh.slice(0, newLeft));
  }
  learning.sort((a, b) => a.due - b.due);
  review.sort((a, b) => a.due - b.due);
  return {
    cards: [...learning, ...review, ...fresh],
    new: fresh.length,
    learning: learning.length,
    review: review.length,
  };
}
