/**
 * FSRS scheduling with ts-fsrs: what each answer would do to a card, and
 * recording a review. Loaded with the study page only.
 */
import {
  fsrs,
  generatorParameters,
  type Card,
  type FSRS,
  type Grade,
} from 'ts-fsrs';
import type {CardRow, DeckRow, Store} from '../store/store.ts';
import {fieldsOf, type Fields} from '../store/table.ts';
import {randomId} from './model.ts';

export const RATINGS = [
  {grade: 1 as Grade, label: 'Again', key: '1'},
  {grade: 2 as Grade, label: 'Hard', key: '2'},
  {grade: 3 as Grade, label: 'Good', key: '3'},
  {grade: 4 as Grade, label: 'Easy', key: '4'},
];

const schedulers = new Map<number, FSRS>();

function scheduler(deck: DeckRow | undefined): FSRS {
  const retention = deck?.retention ?? 0.9;
  let f = schedulers.get(retention);
  if (!f) {
    f = fsrs(generatorParameters({request_retention: retention}));
    schedulers.set(retention, f);
  }
  return f;
}

function toFsrs(c: CardRow): Card {
  return {
    due: new Date(c.due),
    stability: c.stability,
    difficulty: c.difficulty,
    elapsed_days: c.elapsedDays,
    scheduled_days: c.scheduledDays,
    learning_steps: c.learningSteps,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state,
    ...(c.lastReview !== undefined && {last_review: new Date(c.lastReview)}),
  };
}

function fromFsrs(row: CardRow, c: Card): Fields<CardRow> {
  return {
    ...fieldsOf(row),
    due: c.due.getTime(),
    stability: c.stability,
    difficulty: c.difficulty,
    elapsedDays: c.elapsed_days,
    scheduledDays: c.scheduled_days,
    learningSteps: c.learning_steps,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state,
    ...(c.last_review && {lastReview: c.last_review.getTime()}),
  };
}

/** When the card would next be due for each answer. */
export function preview(
  card: CardRow,
  deck: DeckRow | undefined,
  now: number,
): Map<Grade, number> {
  const options = scheduler(deck).repeat(toFsrs(card), new Date(now));
  return new Map(
    RATINGS.map(r => [r.grade, options[r.grade].card.due.getTime()]),
  );
}

/** Records an answer: the card's new schedule, and a review row. */
export function answer(
  store: Store,
  card: CardRow,
  grade: Grade,
  now: number,
  durationMs: number,
): CardRow {
  const deck = store.decks.get(card.deckId);
  const {card: next, log} = scheduler(deck).next(
    toFsrs(card),
    new Date(now),
    grade,
  );
  store.reviews.put({
    id: randomId(),
    cardId: card.id,
    t: now,
    rating: grade,
    durationMs: Math.round(Math.min(durationMs, 10 * 60 * 1000)),
    state: card.state,
    stability: log.stability,
    difficulty: log.difficulty,
    elapsedDays: log.elapsed_days,
    scheduledDays: log.scheduled_days,
  });
  return store.cards.put(fromFsrs(card, next))[0];
}

/** "1m", "10m", "3h", "8d", "2.5mo", "1.2y". */
export function formatInterval(ms: number): string {
  // Each unit is used while it rounds to less than the next one.
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${Math.max(1, min)}m`;
  const h = Math.round(ms / 3_600_000);
  if (h < 24) return `${h}h`;
  const d = ms / 86_400_000;
  if (Math.round(d) < 30) return `${Math.round(d)}d`;
  if (d < 365) return `${Math.round((d / 30) * 10) / 10}mo`;
  return `${Math.round((d / 365) * 10) / 10}y`;
}
