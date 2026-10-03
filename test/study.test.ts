import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import type {Entry} from '../src/shared/types.ts';
import {createStore, CardState} from '../src/client/store/store.ts';
import {MemoryBackend} from '../src/client/store/table.ts';
import {
  addToDeck,
  addWord,
  buildQueue,
  dayStart,
  defaultDeck,
  removeWord,
  setAddToDeck,
  studyingIn,
} from '../src/client/study/model.ts';
import {
  answer,
  formatInterval,
  preview,
} from '../src/client/study/scheduler.ts';
import {validateRow} from '../src/server/schema.ts';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

function word(
  id: number,
  kanji: string,
  reading: string,
  gloss: string,
): Entry {
  return {
    id,
    k: [{t: kanji, c: 1}],
    r: [{t: reading, c: 1}],
    s: [{g: [gloss], p: ['n']}],
  } as Entry;
}

const cat = word(1, '猫', 'ねこ', 'cat');
const dog = word(2, '犬', 'いぬ', 'dog');

/** Noon local time on some day, well clear of the 4 am rollover. */
const NOON = new Date(2026, 9, 3, 12, 0, 0).getTime();

async function store() {
  return createStore(new MemoryBackend(), true);
}

describe('decks and words', () => {
  test('adding a word makes a fact and a new card in the default deck', async () => {
    const s = await store();
    addWord(s, cat, undefined, NOON);
    assert.equal(studyingIn(s, 1)?.id, 'default');
    const fact = s.facts.get('w:1');
    assert.deepEqual(fact?.fields, ['猫', 'ねこ', 'cat']);
    assert.equal(fact?.guid, 'g-sho-1');
    const card = s.cards.get('w:1:0');
    assert.equal(card?.state, CardState.New);
    assert.equal(card?.added, NOON);
    removeWord(s, 1);
    assert.equal(studyingIn(s, 1), undefined);
    assert.equal(s.facts.get('w:1'), undefined);
  });

  test('words go to the chosen deck', async () => {
    const s = await store();
    defaultDeck(s);
    s.decks.put({
      id: 'jlpt',
      name: 'JLPT',
      newPerDay: 5,
      reviewsPerDay: 50,
      retention: 0.9,
    });
    setAddToDeck(s, 'jlpt');
    assert.equal(addToDeck(s).id, 'jlpt');
    addWord(s, cat);
    assert.equal(studyingIn(s, 1)?.name, 'JLPT');
    // A deleted deck falls back to the default.
    s.decks.delete('jlpt');
    assert.equal(addToDeck(s).id, 'default');
  });
});

describe('dayStart', () => {
  test('a day starts at 4 am', () => {
    const at = (h: number) => new Date(2026, 9, 3, h, 30).getTime();
    assert.equal(dayStart(at(12)), new Date(2026, 9, 3, 4).getTime());
    assert.equal(dayStart(at(4)), new Date(2026, 9, 3, 4).getTime());
    // Before 4 am still counts as yesterday.
    assert.equal(dayStart(at(2)), new Date(2026, 9, 2, 4).getTime());
  });
});

describe('the queue', () => {
  test('new cards, up to the daily limit, oldest first', async () => {
    const s = await store();
    s.decks.put({...defaultDeck(s), newPerDay: 2});
    for (let i = 1; i <= 5; i++) {
      addWord(s, word(i, `語${i}`, 'ご', `w${i}`), undefined, NOON + i);
    }
    const q = buildQueue(s, undefined, NOON + MIN);
    assert.deepEqual(
      q.cards.map(c => c.id),
      ['w:1:0', 'w:2:0'],
    );
    assert.equal(q.new, 2);
  });

  test('new cards studied today count against the limit', async () => {
    const s = await store();
    s.decks.put({...defaultDeck(s), newPerDay: 2});
    addWord(s, cat, undefined, NOON);
    addWord(s, dog, undefined, NOON + 1);
    addWord(s, word(3, '鳥', 'とり', 'bird'), undefined, NOON + 2);
    answer(s, s.cards.get('w:1:0')!, 4, NOON + MIN, 3000);
    const q = buildQueue(s, undefined, NOON + 2 * MIN);
    // 猫 went to review (Easy); one new card is left for today.
    assert.deepEqual(
      q.cards.map(c => c.id),
      ['w:2:0'],
    );
    // Tomorrow the limit resets.
    const tomorrow = buildQueue(s, undefined, NOON + DAY);
    assert.equal(tomorrow.new, 2);
  });

  test('learning cards come first; reviews only when due', async () => {
    const s = await store();
    addWord(s, cat, undefined, NOON);
    addWord(s, dog, undefined, NOON + 1);
    // 猫: Again (learning, due in a minute).
    answer(s, s.cards.get('w:1:0')!, 1, NOON, 1000);
    let q = buildQueue(s, undefined, NOON + 10);
    assert.deepEqual(
      q.cards.map(c => c.id),
      ['w:1:0', 'w:2:0'],
    );
    assert.equal(q.learning, 1);
    // 犬: Easy (review in days): not due now.
    answer(s, s.cards.get('w:2:0')!, 4, NOON, 1000);
    q = buildQueue(s, undefined, NOON + 10);
    assert.deepEqual(
      q.cards.map(c => c.id),
      ['w:1:0'],
    );
    const card = s.cards.get('w:2:0')!;
    assert.equal(card.state, CardState.Review);
    q = buildQueue(s, undefined, card.due);
    assert.ok(q.cards.some(c => c.id === 'w:2:0'));
  });

  test('suspended cards and other decks are left out', async () => {
    const s = await store();
    defaultDeck(s);
    s.decks.put({
      id: 'b',
      name: 'B',
      newPerDay: 20,
      reviewsPerDay: 200,
      retention: 0.9,
    });
    addWord(s, cat, undefined, NOON);
    addWord(s, dog, s.decks.get('b')!, NOON);
    assert.deepEqual(
      buildQueue(s, ['default'], NOON).cards.map(c => c.id),
      ['w:1:0'],
    );
    s.cards.put({...s.cards.get('w:1:0')!, suspended: 1});
    assert.equal(buildQueue(s, ['default'], NOON).cards.length, 0);
  });
});

describe('scheduler', () => {
  test('answers are logged, and better answers wait longer', async () => {
    const s = await store();
    addWord(s, cat, undefined, NOON);
    const card = s.cards.get('w:1:0')!;
    const due = preview(card, defaultDeck(s), NOON);
    const order = [1, 2, 3, 4].map(g => due.get(g as 1 | 2 | 3 | 4)!);
    assert.deepEqual(
      [...order].sort((a, b) => a - b),
      order,
    );
    const after = answer(s, card, 3, NOON, 4200);
    assert.equal(after.reps, 1);
    assert.equal(after.lastReview, NOON);
    const [log] = s.reviews.all();
    assert.equal(log.cardId, 'w:1:0');
    assert.equal(log.rating, 3);
    assert.equal(log.state, CardState.New);
    assert.equal(log.durationMs, 4200);
  });

  test('formatInterval', () => {
    assert.equal(formatInterval(30_000), '1m');
    assert.equal(formatInterval(10 * MIN), '10m');
    assert.equal(formatInterval(59.7 * MIN), '1h');
    assert.equal(formatInterval(23.9 * 60 * MIN), '1d');
    assert.equal(formatInterval(3 * 60 * MIN), '3h');
    assert.equal(formatInterval(8 * DAY), '8d');
    assert.equal(formatInterval(75 * DAY), '2.5mo');
    assert.equal(formatInterval(400 * DAY), '1.1y');
  });
});

describe('server schema for study data', () => {
  test('what the client writes is accepted', async () => {
    const s = await store();
    addWord(s, cat, undefined, NOON);
    answer(s, s.cards.get('w:1:0')!, 3, NOON, 1000);
    const strip = <T extends {dirty?: 1}>(r: T) => {
      const out = {...r};
      delete out.dirty;
      return out;
    };
    for (const [table, rows] of [
      ['decks', s.decks.dirty()],
      ['facts', s.facts.dirty()],
      ['cards', s.cards.dirty()],
      ['reviews', s.reviews.dirty()],
      ['settings', s.settings.dirty()],
    ] as const) {
      for (const r of rows) validateRow(table, strip(r));
    }
  });

  test('bad study rows are refused', () => {
    assert.throws(() =>
      validateRow('decks', {
        id: 'd',
        mtime: 1,
        name: 'x',
        newPerDay: 1,
        reviewsPerDay: 1,
        retention: 2,
      }),
    );
    assert.throws(() =>
      validateRow('reviews', {
        id: 'r',
        mtime: 1,
        cardId: 'c',
        t: 1,
        rating: 5,
        durationMs: 1,
        state: 0,
        stability: 0,
        difficulty: 0,
        elapsedDays: 0,
        scheduledDays: 0,
      }),
    );
  });
});
