import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {describe, test} from 'node:test';
import {decompress} from 'fzstd';
import initSqlJs from 'sql.js';
import type {Entry} from '../src/shared/types.ts';
import type {Dict} from '../src/client/dict.ts';
import {
  factIdFor,
  importCollection,
  prepareImport,
} from '../src/client/anki/import/apply.ts';
import {guessLinkFields} from '../src/client/anki/import/link.ts';
import {readApkg} from '../src/client/anki/import/read.ts';
import {createStore, CardState} from '../src/client/store/store.ts';
import {MemoryBackend} from '../src/client/store/table.ts';
import {addWord, buildQueue} from '../src/client/study/model.ts';
import {answer} from '../src/client/study/scheduler.ts';
import {
  applyDeckDuplicates,
  cardDirection,
  deckDuplicates,
} from '../src/client/study/duplicates.ts';
import {validateRow} from '../src/server/schema.ts';

const SQL = await initSqlJs();
const FIXTURES = path.resolve(import.meta.dirname, 'fixtures/anki');
const read = (name: string) =>
  readApkg(fs.readFileSync(path.join(FIXTURES, name)), SQL, decompress);

function entry(id: number, k: string[], r: string[]): Entry {
  return {
    id,
    ...(k.length && {k: k.map(t => ({t, c: 1 as const}))}),
    r: r.map(t => ({t, c: 1 as const})),
    s: [{g: ['x']}],
  } as Entry;
}
const NEKO = entry(1467640, ['猫'], ['ねこ']);
const WORDS = [
  entry(1358280, ['食べる'], ['たべる']),
  NEKO,
  entry(1000000, [], ['ありがとう']),
  entry(1464530, ['日本語'], ['にほんご']),
  entry(1500000, ['犬'], ['いぬ']),
];
const dict = {
  async lookupJa(key: string) {
    return WORDS.filter(w =>
      [...(w.k ?? []), ...w.r].some(f => f.t === key),
    ).map(w => ({
      id: w.id,
      common: true,
    }));
  },
  async entries(ids: number[]) {
    return WORDS.filter(w => ids.includes(w.id));
  },
} as unknown as Dict;

const options = (col: ReturnType<typeof read>) => ({
  keepScheduling: true,
  linkFields: new Map(
    col.noteTypes.map(t => [t.ankiId, guessLinkFields(t.fields)]),
  ),
});

describe('card direction', () => {
  const jp = {
    kind: 'standard' as const,
    fields: ['Expression', 'Reading', 'Meaning', 'Audio'],
    templates: [
      {name: 'Recognition', front: '<div>{{Expression}}</div>', back: ''},
      {name: 'Production', front: '{{Meaning}}', back: ''},
      {name: 'Listening', front: '{{Audio}}', back: ''},
      {
        name: 'Furigana',
        front: '{{furigana:Reading}} {{Expression}}',
        back: '',
      },
    ],
  };
  const link = {word: 0, reading: 1};

  test('from what the front shows', () => {
    assert.equal(cardDirection(jp, 0, link), 'recognition');
    assert.equal(cardDirection(jp, 1, link), 'production');
    assert.equal(cardDirection(jp, 2, link), 'listening');
    assert.equal(cardDirection(jp, 3, link), 'recognition');
    const basic = {
      kind: 'standard' as const,
      fields: ['Front', 'Back'],
      templates: [{name: 'Card 1', front: '{{Front}}', back: ''}],
    };
    assert.equal(
      cardDirection(basic, 0, {word: 0, reading: -1}),
      'recognition',
    );
    const cloze = {...basic, kind: 'cloze' as const};
    assert.equal(cardDirection(cloze, 0, {word: 0, reading: -1}), 'other');
  });
});

describe('words you already know', () => {
  async function storeKnowingNeko() {
    const store = await createStore(new MemoryBackend(), true);
    // 猫 studied as a dictionary word (recognition).
    addWord(store, NEKO);
    answer(store, store.cards.get('w:1467640:0')!, 4, Date.now(), 1000);
    // ありがとう marked known.
    store.marks.put({id: 'known:1000000', wordId: 1000000, kind: 'known'});
    return store;
  }

  test('an import finds them, by word and direction', async () => {
    const store = await storeKnowingNeko();
    const col = read('shared-deck.apkg');
    const prepared = await prepareImport(store, dict, col, options(col));
    const nekoNote = col.notes.find(n => n.fields[0] === '猫')!;
    const nekoFact = factIdFor(nekoNote.guid);
    // 猫's recognition card matches; its production card doesn't.
    assert.deepEqual(
      [...prepared.duplicates.studied.keys()],
      [`${nekoFact}:0`],
    );
    // Both of ありがとう's cards: known, whichever way they ask.
    assert.equal(prepared.duplicates.known.size, 2);
    // Nothing is saved yet.
    assert.equal(store.facts.get(nekoFact), undefined);
  });

  test('copy schedule (default) and suspend known', async () => {
    const store = await storeKnowingNeko();
    const col = read('shared-deck.apkg');
    await importCollection(store, dict, col, options(col));
    const neko = factIdFor(col.notes.find(n => n.fields[0] === '猫')!.guid);
    const studied = store.cards.get('w:1467640:0')!;
    const copied = store.cards.get(`${neko}:0`)!;
    assert.equal(copied.state, CardState.Review);
    assert.equal(copied.due, studied.due);
    assert.equal(copied.stability, studied.stability);
    assert.equal(store.cards.get(`${neko}:1`)!.state, CardState.New);
    const arigatou = factIdFor(
      col.notes.find(n => n.fields[0] === 'ありがとう')!.guid,
    );
    assert.equal(store.cards.get(`${arigatou}:0`)!.suspended, 1);
    assert.equal(store.cards.get(`${arigatou}:1`)!.suspended, 1);
  });

  test('or suspend duplicates, or keep everything', async () => {
    const store = await storeKnowingNeko();
    const col = read('shared-deck.apkg');
    await importCollection(store, dict, col, options(col), undefined, {
      duplicates: 'suspend',
      known: 'keep',
    });
    const neko = factIdFor(col.notes.find(n => n.fields[0] === '猫')!.guid);
    const card = store.cards.get(`${neko}:0`)!;
    assert.equal(card.suspended, 1);
    assert.equal(card.dupOf, 'w:1467640:0');
    assert.equal(card.state, CardState.New);
    const arigatou = factIdFor(
      col.notes.find(n => n.fields[0] === 'ありがとう')!.guid,
    );
    assert.equal(store.cards.get(`${arigatou}:0`)!.suspended, undefined);
  });

  test('a deck already imported can be checked later', async () => {
    const store = await createStore(new MemoryBackend(), true);
    const col = read('shared-deck.apkg');
    await importCollection(store, dict, col, options(col), undefined, {
      duplicates: 'keep',
      known: 'keep',
    });
    const deck = store.decks.all().find(d => d.name === 'Japanese::Core')!;
    assert.equal(deckDuplicates(store, deck.id).studied.size, 0);
    // Then 猫 gets studied as a dictionary word...
    addWord(store, NEKO);
    answer(store, store.cards.get('w:1467640:0')!, 4, Date.now(), 1000);
    const report = deckDuplicates(store, deck.id);
    assert.equal(report.studied.size, 1);
    assert.equal(applyDeckDuplicates(store, report, 'copy', 'suspend'), 1);
    const neko = factIdFor(col.notes.find(n => n.fields[0] === '猫')!.guid);
    assert.equal(store.cards.get(`${neko}:0`)!.state, CardState.Review);
    // Done: checking again finds nothing.
    assert.equal(deckDuplicates(store, deck.id).studied.size, 0);
    store.marks.put({id: 'known:1000000', wordId: 1000000, kind: 'known'});
    const known = deckDuplicates(store, deck.id);
    assert.equal(known.known.size, 2);
    applyDeckDuplicates(store, known, 'copy', 'suspend');
    assert.equal(deckDuplicates(store, deck.id).known.size, 0);
  });

  test('new cards for words marked known are left out of study', async () => {
    const store = await createStore(new MemoryBackend(), true);
    addWord(store, NEKO);
    assert.equal(buildQueue(store).new, 1);
    store.marks.put({id: 'known:1467640', wordId: 1467640, kind: 'known'});
    assert.equal(buildQueue(store).new, 0);
  });

  test('the server accepts direction and dupOf', () => {
    validateRow('cards', {
      id: 'f:0',
      mtime: 1,
      factId: 'f',
      deckId: 'd',
      ord: 0,
      due: 1,
      stability: 0,
      difficulty: 0,
      elapsedDays: 0,
      scheduledDays: 0,
      learningSteps: 0,
      reps: 0,
      lapses: 0,
      state: 0,
      added: 1,
      suspended: 1,
      direction: 'production',
      dupOf: 'w:1:0',
    });
    assert.throws(() =>
      validateRow('cards', {
        id: 'f:0',
        mtime: 1,
        factId: 'f',
        deckId: 'd',
        ord: 0,
        due: 1,
        stability: 0,
        difficulty: 0,
        elapsedDays: 0,
        scheduledDays: 0,
        learningSteps: 0,
        reps: 0,
        lapses: 0,
        state: 0,
        added: 1,
        direction: 'sideways',
      }),
    );
  });
});
