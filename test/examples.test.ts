import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {describe, test} from 'node:test';
import {
  MAX_PER_ENTRY,
  buildExamples,
  parseIndexLine,
  type ExampleWord,
} from '../scripts/build-examples.ts';

describe('Tatoeba word index', () => {
  test('parses words, readings, sense numbers, forms and the good mark', () => {
    assert.deepEqual(
      parseIndexLine('は 二十歳(はたち){２０歳} になる[01]{になりました}~'),
      [
        {word: 'は', form: 'は', good: false},
        {word: '二十歳', reading: 'はたち', form: '２０歳', good: false},
        {word: 'になる', form: 'になりました', good: true},
      ],
    );
  });

  const word = (
    id: number,
    kanji: string[],
    kana: string[],
    existing: string[] = [],
  ): ExampleWord => ({
    id,
    kanji,
    kana,
    common: true,
    existing: new Set(existing),
  });

  function files(index: string[], jpn: string[], eng: string[]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tatoeba-'));
    fs.writeFileSync(path.join(dir, 'jpn_indices.csv'), index.join('\n'));
    fs.writeFileSync(path.join(dir, 'jpn_sentences.tsv'), jpn.join('\n'));
    fs.writeFileSync(path.join(dir, 'eng_sentences.tsv'), eng.join('\n'));
    return dir;
  }

  test('picks each word’s entry, best sentences first, and skips JMdict’s own', () => {
    const dir = files(
      [
        '1\t101\t猫 が 魚 を 食べる{食べた}',
        '2\t102\t猫{ネコ}~ が いる',
        '3\t103\t上(うえ) に 猫 が いる',
        '4\t104\t上(じょう){上} の 部',
      ],
      [
        '1\tjpn\t猫が魚を食べた。',
        '2\tjpn\tネコがいる。',
        '3\tjpn\t上に猫がいる。',
        '4\tjpn\t上の部。',
      ],
      [
        '101\teng\tThe cat ate a fish.',
        '102\teng\tThere is a cat.',
        '103\teng\tA cat is on top.',
        '104\teng\tThe top part.',
        '999\teng\tunused',
      ],
    );
    const words = [
      word(1, ['猫'], ['ねこ'], ['上に猫がいる。']),
      word(2, ['上'], ['うえ']),
      word(3, ['上'], ['じょう']),
      word(4, ['食べる'], ['たべる']),
    ];
    const furigana = new Map([['2', 'ネコがいる。']]);
    const ex = buildExamples(dir, words, furigana);
    // 猫: the checked (~) sentence first; JMdict's own sentence left out.
    assert.deepEqual(
      ex.get(1)?.map(e => [e.ja, e.en, e.w]),
      [
        ['ネコがいる。', 'There is a cat.', 'ネコ'],
        ['猫が魚を食べた。', 'The cat ate a fish.', '猫'],
      ],
    );
    assert.equal(ex.get(1)?.[0].f, 'ネコがいる。');
    // The reading in parentheses chooses between 上 (うえ) and 上 (じょう).
    assert.deepEqual(
      ex.get(2)?.map(e => e.ja),
      ['上に猫がいる。'],
    );
    assert.deepEqual(
      ex.get(3)?.map(e => e.ja),
      ['上の部。'],
    );
    // The form in braces is what's highlighted.
    assert.equal(ex.get(4)?.[0].w, '食べた');
  });

  test('at most MAX_PER_ENTRY per word', () => {
    const n = MAX_PER_ENTRY + 5;
    const ids = Array.from({length: n}, (_, i) => i + 1);
    const dir = files(
      ids.map(i => `${i}\t${1000 + i}\t猫`),
      ids.map(i => `${i}\tjpn\t猫${'だ'.repeat(i)}。`),
      ids.map(i => `${1000 + i}\teng\tcat ${i}`),
    );
    const ex = buildExamples(dir, [word(1, ['猫'], ['ねこ'])], new Map());
    assert.equal(ex.get(1)?.length, MAX_PER_ENTRY);
    // Shorter sentences first.
    assert.equal(ex.get(1)?.[0].ja, '猫だ。');
  });

  test('missing files: no extra examples', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'tatoeba-'));
    assert.equal(buildExamples(empty, [], new Map()).size, 0);
  });
});
