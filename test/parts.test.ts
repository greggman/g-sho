import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  buildParts,
  kanjiVgElements,
  topLevelParts,
} from '../scripts/build-parts.ts';

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
  assert.deepEqual(parts['化'], {
    f: '亻',
    en: 'person',
    ja: 'にんべん',
    s: '人',
  });
  // 阝 on the left is the hill radical.
  assert.deepEqual(parts['阡'], {
    f: '阝',
    en: 'hill',
    ja: 'こざとへん',
    s: '阜',
  });
  assert.equal(parts['丶'].en, 'dot');
});

test('kanji parts: only the top level, not the parts inside parts', () => {
  const krad = {
    攵: ['攵', '乞'],
    貝: ['貝', '目', 'ハ'],
    化: ['化', '匕'],
    乞: ['ノ', '一', '乙', '人', '乞'],
  };
  assert.deepEqual(topLevelParts(krad, ['口', '十', '攵', '乞']), [
    '口',
    '十',
    '攵',
  ]);
  assert.deepEqual(topLevelParts(krad, ['貝', '目', 'ハ', '攵', '乞']), [
    '貝',
    '攵',
  ]);
  // 化 stands for 亻 here: it doesn't contain 匕.
  assert.deepEqual(topLevelParts(krad, ['化', '匕', '艾']), ['化', '匕', '艾']);
  // 乞 stands for 𠂉, which is ノ and 一.
  assert.deepEqual(topLevelParts(krad, ['ノ', '一', '干', '乞']), ['干', '乞']);
});

test('kanji parts: of two lookalikes, the one the kanji has', () => {
  const krad = {
    攵: ['攵', '乞'],
    夂: ['夂', '攵'],
    口: ['口', '囗'],
    囗: ['囗', '口'],
  };
  // 数 has 攵 (KanjiVG), though KRADFILE also lists 夂.
  const kazu = kanjiVgElements(
    '<g kvg:element="女"/><g kvg:element="攵" kvg:variant="true"/>',
  );
  assert.deepEqual(topLevelParts(krad, ['女', '米', '攵', '夂', '乞'], kazu), [
    '女',
    '米',
    '攵',
  ]);
  const fuyu = kanjiVgElements('<g kvg:element="夂"/><g kvg:element="冫"/>');
  assert.deepEqual(topLevelParts(krad, ['夂', '丶', '攵'], fuyu), ['夂', '丶']);
  // Parts that "contain" each other don't hide each other.
  assert.deepEqual(topLevelParts(krad, ['口', '囗']), ['口', '囗']);
});
