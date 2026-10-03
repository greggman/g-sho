import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import type {Entry} from '../src/shared/types.ts';
import {createStore, CardState} from '../src/client/store/store.ts';
import {MemoryBackend} from '../src/client/store/table.ts';
import {addWord, dayStart} from '../src/client/study/model.ts';
import {computeStats} from '../src/client/study/stats-data.ts';
import {niceTicks} from '../src/client/study/chart.ts';
import {plain} from '../src/client/study/browse.ts';

const DAY = 86_400_000;
const NOW = new Date(2026, 9, 4, 12).getTime();
const word = (id: number) =>
  ({id, r: [{t: `w${id}`}], s: [{g: ['x']}]}) as unknown as Entry;

async function setup() {
  const store = await createStore(new MemoryBackend(), true);
  for (let i = 1; i <= 6; i++)
    addWord(store, word(i), undefined, NOW - 40 * DAY);
  const card = (i: number) => store.cards.get(`w:${i}:0`)!;
  const set = (i: number, fields: object) =>
    store.cards.put({...card(i), ...fields});
  // 1: young review due tomorrow; 2: mature, due in 10 days; 3: overdue;
  // 4: learning; 5: suspended; 6: new.
  set(1, {state: CardState.Review, scheduledDays: 3, due: NOW + DAY, reps: 2});
  set(2, {
    state: CardState.Review,
    scheduledDays: 30,
    due: NOW + 10 * DAY,
    reps: 5,
  });
  set(3, {
    state: CardState.Review,
    scheduledDays: 5,
    due: NOW - 2 * DAY,
    reps: 3,
  });
  set(4, {state: CardState.Learning, due: NOW + 600_000, reps: 1});
  set(5, {suspended: 1});
  let n = 0;
  const review = (cardNo: number, t: number, rating: number, state: number) =>
    store.reviews.put({
      id: `r${n++}`,
      cardId: `w:${cardNo}:0`,
      t,
      rating,
      durationMs: 30_000,
      state: state as 0,
      stability: 0,
      difficulty: 0,
      elapsedDays: 0,
      scheduledDays: 0,
    });
  // Today: a new card learned, two reviews (one forgotten).
  review(4, NOW - 3600_000, 3, CardState.New);
  review(1, NOW - 1800_000, 3, CardState.Review);
  review(3, NOW - 900_000, 1, CardState.Review);
  // Yesterday and the day before: reviews; then a gap.
  review(2, NOW - DAY, 4, CardState.Review);
  review(2, NOW - 2 * DAY, 3, CardState.Review);
  review(1, NOW - 5 * DAY, 3, CardState.Learning);
  return store;
}

describe('computeStats', () => {
  test('today, streak and retention', async () => {
    const s = computeStats(await setup(), undefined, NOW);
    assert.deepEqual(s.today, {reviews: 3, minutes: 1.5, newCards: 1});
    assert.equal(s.streak, 3);
    // Review-state answers in 30 days: 4, one of them Again.
    assert.deepEqual(s.retention, {passed: 3, total: 4});
  });

  test('card counts', async () => {
    const s = computeStats(await setup(), undefined, NOW);
    assert.deepEqual(s.cards, {
      total: 6,
      new: 1,
      learning: 1,
      young: 2,
      mature: 1,
      suspended: 1,
    });
  });

  test('reviews per day, oldest first', async () => {
    const s = computeStats(await setup(), undefined, NOW, 7);
    assert.equal(s.history.length, 7);
    assert.equal(s.history[6].day, dayStart(NOW));
    assert.deepEqual(
      s.history.map(d => d.count),
      [0, 1, 0, 0, 1, 1, 3],
    );
    assert.deepEqual([s.history[6].learn, s.history[6].review], [1, 2]);
  });

  test('forecast: overdue counts as today', async () => {
    const s = computeStats(await setup(), undefined, NOW);
    assert.equal(s.forecast[0].count, 2); // overdue review + learning card
    assert.equal(s.forecast[1].count, 1);
    assert.equal(s.forecast[10].count, 1);
    assert.equal(
      s.forecast.reduce((n, d) => n + d.count, 0),
      4,
    );
  });

  test('a streak counts back from yesterday if nothing yet today', async () => {
    const store = await setup();
    // The next day, before studying: the same three days still count.
    const s = computeStats(store, undefined, NOW + DAY);
    assert.equal(s.streak, 3);
    const later = computeStats(store, undefined, NOW + 3 * DAY);
    assert.equal(later.streak, 0);
  });

  test('one deck', async () => {
    const store = await setup();
    const s = computeStats(store, ['nope'], NOW);
    assert.equal(s.cards.total, 0);
    assert.equal(s.today.reviews, 0);
  });
});

test('niceTicks', () => {
  assert.deepEqual(niceTicks(0), [0, 1]);
  assert.deepEqual(niceTicks(1), [0, 1]);
  assert.deepEqual(niceTicks(3), [0, 1, 2, 3]);
  assert.deepEqual(niceTicks(7), [0, 2, 4, 6, 8]);
  assert.deepEqual(niceTicks(130), [0, 50, 100, 150]);
});

test('plain text for the card list', () => {
  assert.equal(plain('<b>食[た]べる</b> [sound:a.mp3]'), '食べる');
  assert.equal(plain('{{c1::猫}}が好き<br>です'), '猫が好き です');
});
