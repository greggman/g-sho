import assert from 'node:assert/strict';
import {test} from 'node:test';
import {romajiToKana} from '../src/client/romaji.ts';

test('converts Hepburn romaji', () => {
  assert.equal(romajiToKana('taberu'), 'たべる');
  assert.equal(romajiToKana('shinbun'), 'しんぶん');
  assert.equal(romajiToKana('kitte'), 'きって');
  assert.equal(romajiToKana('matcha'), 'まっちゃ');
  assert.equal(romajiToKana('kyouto'), 'きょうと');
  assert.equal(romajiToKana('tsukue'), 'つくえ');
  assert.equal(romajiToKana('ja'), 'じゃ');
});

test('converts wapuro spellings and n', () => {
  assert.equal(romajiToKana('sinbun'), 'しんぶん');
  assert.equal(romajiToKana("kan'i"), 'かんい');
  assert.equal(romajiToKana('konnichiha'), 'こんにちは');
  assert.equal(romajiToKana('hon'), 'ほん');
  assert.equal(romajiToKana('ra-men'), 'らーめん');
});

test('rejects text that is not romaji', () => {
  assert.equal(romajiToKana('rhythm'), undefined);
  assert.equal(romajiToKana('dog!'), undefined);
  assert.equal(romajiToKana('食べる'), undefined);
});
