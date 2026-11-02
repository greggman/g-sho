import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  furigana,
  headword,
  onlyCommonReading,
  surfaceFurigana,
} from '../src/client/forms.ts';
import type {Entry} from '../src/shared/types.ts';

test('furigana over kanji only', () => {
  assert.deepEqual(furigana('食べる', 'たべる'), [['食', 'た'], ['べる']]);
  assert.deepEqual(furigana('食べ物', 'たべもの'), [
    ['食', 'た'],
    ['べ'],
    ['物', 'もの'],
  ]);
  assert.deepEqual(furigana('日本語', 'にほんご'), [['日本語', 'にほんご']]);
  assert.deepEqual(furigana('お茶', 'おちゃ'), [['お'], ['茶', 'ちゃ']]);
});

test('furigana falls back to the whole word', () => {
  assert.deepEqual(furigana('ＣＤ', 'シーディー'), [['ＣＤ', 'シーディー']]);
});

test('headword prefers kana for usually-kana words', () => {
  const e: Entry = {
    id: 1,
    k: [{t: '拉麺', tg: ['rK']}],
    r: [{t: 'ラーメン'}],
    s: [{g: ['ramen'], m: ['uk']}],
  };
  assert.deepEqual(headword(e), {text: 'ラーメン'});
});

test('headword uses the reading that applies to the kanji', () => {
  const e: Entry = {
    id: 1,
    k: [{t: '今日'}],
    r: [{t: 'きょう'}, {t: 'こんにち'}],
    s: [{g: ['today']}],
  };
  assert.deepEqual(headword(e), {text: '今日', reading: 'きょう'});
});

test('surfaceFurigana carries furigana onto inflected forms', () => {
  const taberu: Entry = {
    id: 1,
    k: [{t: '食べる'}],
    r: [{t: 'たべる'}],
    s: [{g: ['to eat']}],
  };
  assert.deepEqual(surfaceFurigana('食べました', taberu, '食べる'), [
    ['食', 'た'],
    ['べました'],
  ]);
  assert.deepEqual(surfaceFurigana('食べる', taberu), [['食', 'た'], ['べる']]);
  assert.deepEqual(surfaceFurigana('たべた', taberu, '食べる'), [['たべた']]);
});

test('onlyCommonReading: one common reading, else none', () => {
  const e = (id: number, k: string, r: string[], c = true): Entry => ({
    id,
    k: [{t: k, ...(c && {c: 1})}],
    r: r.map(t => ({t, ...(c && {c: 1})})),
    s: [{g: ['x']}],
  });
  // 飴 (candy) is common; 飴 (chisel, たがね) isn't.
  assert.equal(
    onlyCommonReading(
      [e(1, '飴', ['あめ']), e(2, '飴', ['たがね'], false)],
      '飴',
    ),
    'あめ',
  );
  assert.equal(
    onlyCommonReading(
      [e(1, '今日', ['きょう']), e(2, '今日', ['こんにち'])],
      '今日',
    ),
    undefined,
  );
  assert.equal(
    onlyCommonReading([e(1, '日本', ['にほん', 'にっぽん'])], '日本'),
    undefined,
  );
  assert.equal(
    onlyCommonReading([e(1, '擬', ['もどき'], false)], '擬'),
    undefined,
  );
});
