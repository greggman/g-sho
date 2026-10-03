/**
 * The numbers on the stats page, worked out from the store: today, the
 * streak, retention, card counts, reviews per day, and what's coming due.
 * Days start at 4 am, like study days.
 */
import {CardState, type Store} from '../store/store.ts';
import {dayStart} from './model.ts';

const DAY = 86_400_000;
/** Cards whose interval is at least this many days are "mature", as in Anki. */
const MATURE_DAYS = 21;

export interface DayCount {
  /** when the day starts (ms) */
  day: number;
  count: number;
}

export interface ReviewDay extends DayCount {
  learn: number;
  review: number;
  relearn: number;
  minutes: number;
}

export interface Stats {
  today: {reviews: number; minutes: number; newCards: number};
  /** days in a row with reviews, up to today (or yesterday, if none yet today) */
  streak: number;
  /** answers other than Again to review cards in the last 30 days */
  retention: {passed: number; total: number};
  cards: {
    total: number;
    new: number;
    learning: number;
    young: number;
    mature: number;
    suspended: number;
  };
  /** oldest first, ending today */
  history: ReviewDay[];
  /** today (with anything overdue) first */
  forecast: DayCount[];
}

export function computeStats(
  store: Store,
  deckIds?: string[],
  now = Date.now(),
  historyDays = 30,
  forecastDays = 30,
): Stats {
  const cards = store.cards
    .all()
    .filter(c => !deckIds || deckIds.includes(c.deckId));
  const cardIds = new Set(cards.map(c => c.id));
  const reviews = store.reviews.all().filter(r => cardIds.has(r.cardId));
  const today = dayStart(now);
  const dayIndex = (t: number) => Math.floor((today - dayStart(t)) / DAY + 0.5);

  const history: ReviewDay[] = Array.from({length: historyDays}, (_, i) => ({
    day: today - (historyDays - 1 - i) * DAY,
    count: 0,
    learn: 0,
    review: 0,
    relearn: 0,
    minutes: 0,
  }));
  const studiedDays = new Set<number>();
  const stats: Stats = {
    today: {reviews: 0, minutes: 0, newCards: 0},
    streak: 0,
    retention: {passed: 0, total: 0},
    cards: {
      total: cards.length,
      new: 0,
      learning: 0,
      young: 0,
      mature: 0,
      suspended: 0,
    },
    history,
    forecast: Array.from({length: forecastDays}, (_, i) => ({
      day: today + i * DAY,
      count: 0,
    })),
  };

  for (const r of reviews) {
    const ago = dayIndex(r.t);
    studiedDays.add(ago);
    if (ago === 0) {
      stats.today.reviews++;
      stats.today.minutes += r.durationMs / 60_000;
      if (r.state === CardState.New) stats.today.newCards++;
    }
    if (ago < 30 && r.state === CardState.Review) {
      stats.retention.total++;
      if (r.rating > 1) stats.retention.passed++;
    }
    const slot = history[historyDays - 1 - ago];
    if (slot) {
      slot.count++;
      slot.minutes += r.durationMs / 60_000;
      if (r.state === CardState.Review) slot.review++;
      else if (r.state === CardState.Relearning) slot.relearn++;
      else slot.learn++;
    }
  }
  for (let d = studiedDays.has(0) ? 0 : 1; studiedDays.has(d); d++)
    stats.streak++;

  for (const c of cards) {
    if (c.suspended) {
      stats.cards.suspended++;
      continue;
    }
    if (c.state === CardState.New) {
      stats.cards.new++;
      continue;
    }
    if (c.state === CardState.Review) {
      if (c.scheduledDays >= MATURE_DAYS) stats.cards.mature++;
      else stats.cards.young++;
    } else {
      stats.cards.learning++;
    }
    const ahead = Math.max(0, Math.floor((c.due - today) / DAY));
    if (ahead < forecastDays) stats.forecast[ahead].count++;
  }
  return stats;
}
