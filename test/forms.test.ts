import assert from 'node:assert/strict';
import {test} from 'node:test';
import {furigana, headword} from '../src/client/forms.ts';
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
