import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fnv1a, jaBucket} from '../src/shared/hash.ts';
import {glossCore, normalizeJa, tokenizeEn} from '../src/shared/normalize.ts';

test('normalizeJa folds katakana, width and case', () => {
  assert.equal(normalizeJa('ラーメン'), 'らーめん');
  assert.equal(normalizeJa('ｱｲｽ'), 'あいす');
  assert.equal(normalizeJa('ＣＤ'), 'cd');
});

test('glossCore strips "to" and parentheticals', () => {
  assert.equal(glossCore('to eat (a meal)'), 'eat');
  assert.equal(glossCore('the sun'), 'sun');
});

test('tokenizeEn', () => {
  assert.deepEqual(tokenizeEn("Ice-cream, one's (e.g.) dog"), [
    'ice-cream',
    "one's",
    'e',
    'g',
    'dog',
  ]);
});

test('hash is stable', () => {
  // The data files are laid out with this hash; changing it needs a data rebuild.
  assert.equal(fnv1a(''), 0x811c9dc5);
  assert.equal(fnv1a('a'), 0xe40c292c);
  assert.equal(jaBucket('食べる'), '食べ');
  assert.equal(jaBucket('𠮟る'), '𠮟る');
});

test('glossCore handles nested parentheses', () => {
  assert.equal(glossCore('dog (Canis (lupus) familiaris)'), 'dog');
});
