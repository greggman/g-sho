import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildParts} from '../scripts/build-parts.ts';

const char = (literal: string, meanings: string[], kun?: string) => ({
  literal,
  readingMeaning: {
    groups: [
      {
        meanings: meanings.map(value => ({lang: 'en', value})),
        readings: kun ? [{type: 'ja_kun', value: kun}] : [],
      },
    ],
  },
});

test('kanji parts: meanings, Japanese names, and real radical forms', () => {
  const parts = buildParts(
    {騒: ['馬', '虫', '又', '丶'], 何: ['化', '口'], 院: ['阡', '宀']},
    [
      char('馬', ['horse'], 'うま'),
      char('虫', ['insect', 'bug'], 'むし'),
      char('化', ['change', 'take the form of'], 'ば.ける'),
      char('口', ['mouth'], 'くち'),
      char('又', ['or again', 'furthermore'], 'また'),
    ],
  );
  assert.deepEqual(parts['馬'], {en: 'horse', ja: 'うま'});
  assert.deepEqual(parts['虫'], {en: 'insect', ja: 'むし'});
  // Named by hand where the dictionary's meaning isn't the part's.
  assert.deepEqual(parts['又'], {en: 'right hand', ja: 'また'});
  // KRADFILE's stand-in 化 is the person radical 亻.
  assert.deepEqual(parts['化'], {f: '亻', en: 'person', ja: 'にんべん'});
  // 阝 on the left is the hill radical.
  assert.deepEqual(parts['阡'], {f: '阝', en: 'hill', ja: 'こざとへん'});
  assert.equal(parts['丶'].en, 'dot');
});
