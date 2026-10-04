import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import {before, describe, test} from 'node:test';
import {
  matchWord,
  readWiktionary,
  type WordForms,
} from '../scripts/build-jawiktionary.ts';

/** Entries shaped like kaikki.org's Japanese Wiktionary extract. */
const ENTRIES = [
  // A kanji spelling that only points at its kana word.
  {
    word: '食べる',
    pos: 'character',
    pos_title: '和語の漢字表記',
    senses: [{glosses: ['たべるの漢字表記。'], form_of: [{word: 'たべる'}]}],
    forms: [{form: 'たべる', tags: ['transliteration']}],
  },
  {
    word: 'たべる',
    pos: 'verb',
    pos_title: '動詞',
    senses: [
      {
        glosses: ['何かを口から飲み込む。'],
        examples: [{text: 'ご飯を食べる。'}],
      },
      {glosses: [':詳細は同項を参照。']},
    ],
    forms: [{form: '食べる', tags: ['kanji']}],
  },
  // Homophones: かみ is 紙 or 神, each with its own entry.
  {
    word: '紙',
    pos: 'noun',
    pos_title: '名詞',
    senses: [{glosses: ['植物の繊維で作った薄いもの。']}],
    forms: [{form: 'かみ', tags: ['transliteration']}],
  },
  {
    word: 'かみ',
    pos: 'noun',
    pos_title: '名詞',
    senses: [{glosses: ['信仰の対象。']}],
    forms: [{form: '神', tags: ['kanji']}],
  },
  // Senses marked with their readings.
  {
    word: '上',
    pos: 'noun',
    pos_title: '名詞',
    senses: [
      {glosses: ['【うえ、かみ】頭の方向。']},
      {glosses: ['【じょう】優れていること。']},
    ],
    forms: [
      {form: 'うえ', tags: ['transliteration']},
      {form: 'じょう', tags: ['transliteration']},
    ],
  },
  // An entry about a kanji: unmarked senses belong to its one kun reading.
  {
    word: '猫',
    pos: 'noun',
    pos_title: '名詞',
    senses: [
      {glosses: ['（ねこ、ネコ）小型の哺乳類。']},
      {glosses: ['我が儘な人の比喩。'], ruby: [['我が儘', 'わがまま']]},
    ],
    forms: [
      {form: 'ビョウ', tags: ['transliteration', 'kan-on']},
      {form: 'ねこ', tags: ['transliteration', 'kun']},
    ],
  },
  {
    word: '生',
    pos: 'noun',
    pos_title: '名詞',
    senses: [{glosses: ['（セイ）いのち。']}, {glosses: ['わたし。']}],
    forms: [
      {form: 'セイ', tags: ['transliteration', 'kan-on']},
      {form: 'いきる', tags: ['transliteration', 'kun']},
      {form: 'なま', tags: ['transliteration', 'kun']},
    ],
  },
  // A kanji-character entry and another language: left out.
  {
    word: '山',
    pos: 'character',
    pos_title: '漢字',
    senses: [{glosses: ['やま。']}],
  },
].map(e => ({lang_code: 'ja', lang: '日本語', ...e}));

let byWord: Awaited<ReturnType<typeof readWiktionary>>;

before(async () => {
  const lines = [
    ...ENTRIES.map(e => JSON.stringify(e)),
    JSON.stringify({
      word: 'cat',
      lang_code: 'en',
      pos: 'noun',
      senses: [{glosses: ['ネコ']}],
    }),
  ].join('\n');
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'jaw-')),
    'x.jsonl.gz',
  );
  fs.writeFileSync(file, zlib.gzipSync(lines));
  byWord = await readWiktionary(file);
});

const word = (
  kanji: string[],
  kana: string[],
  usuallyKana = false,
): WordForms => ({
  id: 1,
  kanji,
  kana,
  usuallyKana,
});
const glosses = (w: WordForms) =>
  matchWord(w, byWord).flatMap(d => d.s.map(s => s.g));

describe('matching JMdict words to Japanese Wiktionary', () => {
  test('a kanji spelling follows its pointer to the kana word', () => {
    const defs = matchWord(word(['食べる'], ['たべる']), byWord);
    assert.equal(defs.length, 1);
    assert.equal(defs[0].p, '動詞');
    // The cross-reference-only sense is dropped.
    assert.deepEqual(defs[0].s, [
      {g: '何かを口から飲み込む。', ex: ['ご飯を食べる。']},
    ]);
  });

  test("homophones don't get each other's definitions", () => {
    assert.deepEqual(glosses(word(['紙'], ['かみ'])), [
      '植物の繊維で作った薄いもの。',
    ]);
    assert.deepEqual(glosses(word(['神'], ['かみ'])), ['信仰の対象。']);
    // 髪 has no entry here; the kana かみ (神) must not be used for it.
    assert.deepEqual(glosses(word(['髪'], ['かみ'])), []);
  });

  test('senses marked with readings go to those readings, without the mark', () => {
    assert.deepEqual(glosses(word(['上'], ['うえ'])), ['頭の方向。']);
    assert.deepEqual(glosses(word(['上'], ['じょう'])), ['優れていること。']);
  });

  test('a kanji entry’s unmarked senses go to its one kun reading', () => {
    assert.deepEqual(glosses(word(['猫'], ['ねこ'])), [
      '小型の哺乳類。',
      '我が儘な人の比喩。',
    ]);
    // 生 has several kun readings: its unmarked senses fit none for sure.
    assert.deepEqual(glosses(word(['生'], ['なま'])), []);
    assert.deepEqual(glosses(word(['生'], ['せい'])), ['いのち。']);
  });

  test('furigana hints come along', () => {
    const [def] = matchWord(word(['猫'], ['ねこ']), byWord);
    assert.deepEqual(def.s[1].r, [['我が儘', 'わがまま']]);
  });

  test('kanji-character entries and other languages are left out', () => {
    assert.deepEqual(glosses(word(['山'], ['やま'])), []);
    assert.equal(byWord.has('cat'), false);
  });
});
