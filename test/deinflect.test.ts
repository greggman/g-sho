import assert from 'node:assert/strict';
import {test} from 'node:test';
import {deinflect, WordType} from '../src/client/deinflect.ts';

function find(word: string, base: string, type: number) {
  return deinflect(word).find(d => d.term === base && d.type & type);
}

const cases: [string, string, number, string[]][] = [
  ['食べました', '食べる', WordType.V1, ['past', 'polite']],
  ['食べなかった', '食べる', WordType.V1, ['past', 'negative']],
  ['食べている', '食べる', WordType.V1, ['progressive']],
  ['食べたい', '食べる', WordType.V1, ['-tai']],
  ['書いた', '書く', WordType.V5, ['past']],
  ['読んで', '読む', WordType.V5, ['te-form']],
  ['行った', '行く', WordType.V5, ['past']],
  ['話せる', '話す', WordType.V5, ['potential']],
  ['高かった', '高い', WordType.ADJ, ['past']],
  ['高くない', '高い', WordType.ADJ, ['negative']],
  ['来た', '来る', WordType.VK, ['past']],
  [
    '勉強しています',
    '勉強',
    WordType.VSN,
    ['polite', 'progressive', 'suru verb'],
  ],
];

for (const [word, base, type, reasons] of cases) {
  test(`${word} → ${base}`, () => {
    const d = find(word, base, type);
    assert.ok(d, `no deinflection of ${word} to ${base}`);
    assert.deepEqual(d.reasons, reasons);
  });
}

test('the word itself is the first candidate', () => {
  const [first] = deinflect('猫');
  assert.equal(first.term, '猫');
  assert.deepEqual(first.reasons, []);
});

test('a bare stem with kanji deinflects, and says so', () => {
  const find = (word: string, term: string) =>
    deinflect(word).find(d => d.term === term);
  assert.deepEqual(find('煎り', '煎る')?.reasons, ['masu stem']);
  assert.deepEqual(find('書き', '書く')?.reasons, ['masu stem']);
  assert.deepEqual(find('食べ', '食べる')?.reasons, ['masu stem']);
  // Inside a longer form, the stem step stays silent.
  assert.deepEqual(find('食べました', '食べる')?.reasons, ['past', 'polite']);
});

test('kana alone is never read as a stem (particles stay particles)', () => {
  const terms = (word: string) => deinflect(word).map(d => d.term);
  assert.ok(!terms('に').includes('にる'));
  assert.ok(!terms('で').includes('でる'));
  assert.ok(!terms('し').includes('する'));
});
