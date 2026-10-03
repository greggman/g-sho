import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {describe, test} from 'node:test';
import {decompress} from 'fzstd';
import initSqlJs from 'sql.js';
import type {Entry} from '../src/shared/types.ts';
import type {Dict} from '../src/client/dict.ts';
import {writeApkg} from '../src/client/anki/apkg.ts';
import {factIdFor, importCollection} from '../src/client/anki/import/apply.ts';
import {
  guessLinkFields,
  linkWord,
  noteWord,
  parseFurigana,
} from '../src/client/anki/import/link.ts';
import {readApkg, type AnkiCollection} from '../src/client/anki/import/read.ts';
import {readAnkiText, splitLine} from '../src/client/anki/import/read-text.ts';
import {renderTemplate} from '../src/client/anki/template.ts';
import {createStore, CardState} from '../src/client/store/store.ts';
import {MemoryBackend} from '../src/client/store/table.ts';
import {addWord} from '../src/client/study/model.ts';
import {answer} from '../src/client/study/scheduler.ts';
import {apkgNoteType, deckNotes} from '../src/client/study/export.ts';
import {validateRow} from '../src/server/schema.ts';

const FIXTURES = path.resolve(import.meta.dirname, 'fixtures/anki');
const SQL = await initSqlJs();
const read = (name: string) =>
  readApkg(fs.readFileSync(path.join(FIXTURES, name)), SQL, decompress);

/** A tiny dictionary: just the words the fixtures use. */
function entry(id: number, k: string[], r: string[], gloss: string): Entry {
  return {
    id,
    ...(k.length && {k: k.map(t => ({t, c: 1 as const}))}),
    r: r.map(t => ({t, c: 1 as const})),
    s: [{g: [gloss]}],
  } as Entry;
}
const WORDS = [
  entry(1358280, ['食べる'], ['たべる'], 'to eat'),
  entry(1467640, ['猫'], ['ねこ'], 'cat'),
  entry(1101000, ['猫'], ['みょう'], 'not this one'),
  entry(1000000, [], ['ありがとう'], 'thank you'),
  entry(1464530, ['日本語'], ['にほんご'], 'Japanese'),
  entry(1500000, ['犬'], ['いぬ'], 'dog'),
];
const fakeDict = {
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
  async entry(id: number) {
    return WORDS.find(w => w.id === id);
  },
  tagDescription: (t: string) => t,
} as unknown as Dict;

function options(col: AnkiCollection, keepScheduling = true) {
  return {
    keepScheduling,
    linkFields: new Map(
      col.noteTypes.map(t => [t.ankiId, guessLinkFields(t.fields)]),
    ),
  };
}

describe('reading packages', () => {
  for (const file of ['legacy.apkg', 'modern.apkg']) {
    test(`${file}: note types, decks, notes, cards, reviews, media`, () => {
      const col = read(file);
      const jp = col.noteTypes.find(t => t.name === 'Japanese (recognition)')!;
      assert.deepEqual(jp.fields, [
        'Expression',
        'Reading',
        'Meaning',
        'Audio',
        'Picture',
      ]);
      assert.deepEqual(
        jp.templates.map(t => t.name),
        ['Recognition', 'Production'],
      );
      assert.match(jp.templates[1].back, /kana:Reading/);
      assert.match(jp.css, /\.expr/);
      assert.equal(col.noteTypes.find(t => t.name === 'Cloze')?.kind, 'cloze');
      assert.ok(col.decks.some(d => d.name === 'Japanese::Core'));
      assert.equal(col.notes.length, 6);
      assert.equal(col.cards.length, 11);
      assert.equal(col.reviews.length, 4);
      const neko = col.notes.find(n => n.fields[0] === '猫')!;
      assert.equal(neko.fields[3], '[sound:neko.mp3]');
      assert.deepEqual(neko.tags.sort(), ['fixture', 'jp']);
      assert.ok(col.cards.some(c => c.memory && c.memory.s > 0));
      assert.ok(col.cards.some(c => c.queue === -1));
      assert.deepEqual(col.media.map(m => m.name).sort(), [
        'neko.mp3',
        'neko.png',
      ]);
      const png = col.media.find(m => m.name === 'neko.png')!;
      assert.deepEqual([...png.data.slice(1, 4)], [0x50, 0x4e, 0x47]); // "PNG"
    });
  }

  test('a shared deck has no scheduling', () => {
    const col = read('shared-deck.apkg');
    assert.equal(col.reviews.length, 0);
    assert.ok(col.cards.every(c => c.type === 0));
  });

  test('not a package', () => {
    assert.throws(
      () => readApkg(new Uint8Array([1, 2, 3]), SQL, decompress),
      Error,
    );
  });
});

describe('reading text', () => {
  test("Anki's plain-text export", () => {
    const col = readAnkiText(
      fs.readFileSync(path.join(FIXTURES, 'notes.txt'), 'utf8'),
    );
    assert.deepEqual(
      col.noteTypes.map(t => t.name),
      ['Japanese (recognition)', 'Basic', 'Cloze'],
    );
    assert.equal(col.notes.length, 6);
    assert.equal(col.notes[1].guid, 'Bb:,eTCx:w');
    assert.equal(col.notes[1].fields[4], '<img src="neko.png">');
    assert.deepEqual(
      col.decks.map(d => d.name),
      ['Japanese::Core', 'Japanese'],
    );
    // The cloze note makes a card per cloze.
    const cloze = col.notes.find(n => n.fields[0].includes('{{c1::'))!;
    assert.deepEqual(
      col.cards.filter(c => c.noteId === cloze.ankiId).map(c => c.ord),
      [0, 1],
    );
  });

  test('plain lines become Basic notes', () => {
    const col = readAnkiText('猫\tcat\n犬\t"dog,\nhound"\n', 'Mine');
    assert.deepEqual(col.noteTypes[0].fields, ['Front', 'Back']);
    assert.deepEqual(
      col.notes.map(n => n.fields),
      [
        ['猫', 'cat'],
        ['犬', 'dog,\nhound'],
      ],
    );
    assert.equal(col.decks[0].name, 'Mine');
    // The same text gives the same GUIDs, so importing it twice updates.
    assert.equal(readAnkiText('猫\tcat').notes[0].guid, col.notes[0].guid);
  });

  test('splitLine handles quotes', () => {
    assert.deepEqual(splitLine('a,"b,c","d ""e"""', ','), [
      'a',
      'b,c',
      'd "e"',
    ]);
  });
});

describe('linking to the dictionary', () => {
  test('parseFurigana', () => {
    assert.deepEqual(parseFurigana('食[た]べる'), {
      text: '食べる',
      reading: 'たべる',
    });
    assert.deepEqual(parseFurigana('日本[にほん] 語[ご]'), {
      text: '日本語',
      reading: 'にほんご',
    });
    assert.deepEqual(parseFurigana('<b>猫</b>'), {text: '猫'});
  });

  test('guessLinkFields and noteWord', () => {
    const link = guessLinkFields(['Expression', 'Reading', 'Meaning']);
    assert.deepEqual(link, {word: 0, reading: 1});
    assert.deepEqual(noteWord(['猫', '猫[ねこ]', 'cat'], link), {
      text: '猫',
      reading: 'ねこ',
    });
    assert.deepEqual(noteWord(['猫', 'ねこ', 'cat'], link), {
      text: '猫',
      reading: 'ねこ',
    });
    assert.deepEqual(guessLinkFields(['Front', 'Back']), {
      word: 0,
      reading: -1,
    });
  });

  test('linkWord prefers word and reading, then word alone', async () => {
    assert.deepEqual(await linkWord(fakeDict, '猫', 'ねこ'), {
      wordId: 1467640,
      confidence: 'exact',
    });
    assert.deepEqual(await linkWord(fakeDict, '猫'), {
      wordId: 1467640,
      confidence: 'word',
    });
    assert.deepEqual(await linkWord(fakeDict, 'ありがとう'), {
      wordId: 1000000,
      confidence: 'exact',
    });
    assert.equal(await linkWord(fakeDict, '猫が好きです'), undefined);
  });
});

describe('importing', () => {
  test('a deck with its schedule, history and media', async () => {
    const store = await createStore(new MemoryBackend(), true);
    const col = read('modern.apkg');
    const r = await importCollection(store, fakeDict, col, options(col));
    assert.equal(r.added, 6);
    assert.equal(r.cards, 11);
    assert.deepEqual(r.decks.sort(), ['Japanese', 'Japanese::Core']);
    assert.equal(r.media, 2);
    // 食べる, 猫, ありがとう, 日本語 and 犬 (Basic) link; the cloze sentence doesn't.
    assert.equal(r.linked, 5);

    const neko = col.notes.find(n => n.fields[0] === '猫')!;
    const fact = store.facts.get(factIdFor(neko.guid))!;
    assert.equal(fact.wordId, 1467640);
    assert.equal(fact.linkConfidence, 'exact');
    const nt = store.noteTypes.get(fact.noteType)!;
    assert.equal(nt.name, 'Japanese (recognition)');

    const cards = store.cards.all();
    assert.equal(cards.length, 11);
    const studied = cards.filter(c => c.state !== CardState.New);
    assert.equal(studied.length, 4);
    const review = cards.find(c => c.state === CardState.Review)!;
    assert.ok(review.stability > 8 && review.due > Date.now());
    assert.ok(cards.some(c => c.suspended));
    assert.equal(store.reviews.all().length, 4);
    assert.ok(await store.backend.getMedia('neko.png'));
  });

  test('without the schedule, everything is new', async () => {
    const store = await createStore(new MemoryBackend(), true);
    const col = read('modern.apkg');
    await importCollection(store, fakeDict, col, options(col, false));
    assert.ok(store.cards.all().every(c => c.state === CardState.New));
    assert.equal(store.reviews.all().length, 0);
  });

  test('importing again updates notes and keeps your progress', async () => {
    const store = await createStore(new MemoryBackend(), true);
    const col = read('shared-deck.apkg');
    await importCollection(store, fakeDict, col, options(col));
    const first = store.cards.all()[0];
    answer(store, first, 3, Date.now(), 1000);
    const studied = store.cards.get(first.id)!;
    const again = await importCollection(
      store,
      fakeDict,
      read('shared-deck.apkg'),
      options(col),
    );
    assert.equal(again.added, 0);
    assert.equal(again.updated, 6);
    assert.equal(again.cards, 0);
    assert.deepEqual(store.cards.get(first.id), studied);
    assert.equal(
      store.decks.all().filter(d => d.name === 'Japanese').length,
      1,
    );
  });

  test('our own export comes back as dictionary words', async () => {
    const source = await createStore(new MemoryBackend(), true);
    addWord(source, WORDS[1]);
    answer(source, source.cards.get('w:1467640:0')!, 4, Date.now(), 1000);
    const deck = source.decks.get('default')!;
    const globals = globalThis as {location?: unknown};
    globals.location ??= {origin: 'https://g-sho.org'};
    const {notes} = await deckNotes(source, fakeDict, deck);
    const bytes = await writeApkg(SQL, {
      deckName: deck.name,
      noteType: apkgNoteType(),
      notes,
    });

    const store = await createStore(new MemoryBackend(), true);
    const col = readApkg(bytes, SQL, decompress);
    await importCollection(store, fakeDict, col, options(col));
    const fact = store.facts.get('w:1467640')!;
    assert.equal(fact.noteType, 'g-sho');
    assert.deepEqual(fact.fields.slice(0, 2), ['猫', 'ねこ']);
    const card = store.cards.get('w:1467640:0')!;
    assert.equal(card.state, CardState.Review);
    assert.equal(store.noteTypes.all().length, 0);
  });

  test('what an import writes, the server accepts', async () => {
    const store = await createStore(new MemoryBackend(), true);
    const col = read('modern.apkg');
    await importCollection(store, fakeDict, col, options(col));
    for (const table of [
      'noteTypes',
      'decks',
      'facts',
      'cards',
      'reviews',
    ] as const) {
      for (const row of store[table].dirty()) {
        const sent: Record<string, unknown> = {...row};
        delete sent.dirty;
        validateRow(table, sent);
      }
    }
  });
});

describe('templates', () => {
  const ctx = {
    fields: {
      Expression: '食べる',
      Reading: '食[た]べる',
      Audio: '[sound:a.mp3]',
      Picture: '',
    },
    tags: ['jp'],
    deck: 'Japanese::Core',
    noteType: 'J',
    cardName: 'Recognition',
    ord: 0,
    side: 'front' as const,
  };

  test('fields, sections, FrontSide and filters', () => {
    const front = renderTemplate(
      '{{Expression}}{{#Picture}}P{{/Picture}}{{^Picture}}-{{/Picture}}',
      ctx,
    );
    assert.equal(front, '食べる-');
    const back = renderTemplate(
      '{{FrontSide}}|{{furigana:Reading}}|{{kana:Reading}}|{{kanji:Reading}}|{{Subdeck}}|{{Missing}}',
      {...ctx, side: 'back', frontSide: front},
    );
    assert.equal(
      back,
      '食べる-|<ruby><rb>食</rb><rt>た</rt></ruby>べる|たべる|食べる|Core|',
    );
    assert.match(renderTemplate('{{Audio}}', ctx), /data-sound="a.mp3"/);
    // An image alone counts as content.
    const pic = {
      ...ctx,
      fields: {...ctx.fields, Picture: '<img src="neko.png">'},
    };
    assert.equal(
      renderTemplate('{{#Picture}}[{{Picture}}]{{/Picture}}', pic),
      '[<img src="neko.png">]',
    );
  });

  test('cloze', () => {
    const c = {
      ...ctx,
      fields: {Text: '{{c1::猫}}が{{c2::好き::like}}'},
      ord: 1,
    };
    assert.equal(
      renderTemplate('{{cloze:Text}}', c),
      '猫が<span class="cloze" data-cloze="好き">[like]</span>',
    );
    assert.equal(
      renderTemplate('{{cloze:Text}}', {...c, side: 'back'}),
      '猫が<span class="cloze">好き</span>',
    );
  });
});
