import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {describe, test} from 'node:test';
import {edits, readMisspellings} from '../scripts/build-spelling.ts';
import {Speller, type SpellData} from '../src/client/spell.ts';

describe('spelling error model', () => {
  test('edits name what a misspelling did', () => {
    assert.deepEqual(edits('receive', 'recieve'), ['t:ei']);
    assert.deepEqual(edits('abandoned', 'abandonned'), ['di:n']);
    assert.deepEqual(edits('accommodate', 'accomodate'), ['dd:m']);
    assert.deepEqual(edits('grammar', 'grammer'), ['s:ae']);
    assert.deepEqual(edits('knowledge', 'knowlege'), ['d:d']);
  });

  test('the list is read as misspelling → corrections', () => {
    const list = readMisspellings(
      ' abandonned->abandoned\n achive->achieve, archive\n<pre>\n',
    );
    assert.deepEqual(list.get('abandonned'), ['abandoned']);
    assert.deepEqual(list.get('achive'), ['achieve', 'archive']);
    assert.equal(list.size, 2);
  });
});

describe('speller', () => {
  const data: SpellData = {
    words: '75 the\n55 study friend\n50 friends\n45 betterment\n30 abatement',
    costs: {'dd:m': 0.3},
    known: {wierd: ['weird']},
  };
  const speller = new Speller(data);

  test('suggests the likeliest words, common ones first', () => {
    const s = speller.suggest('frend');
    assert.equal(s[0].word, 'friend');
    assert.ok(s.some(x => x.word === 'friends'));
    assert.equal(speller.suggest('beterment')[0].word, 'betterment');
  });

  test('a known misspelling comes first', () => {
    assert.equal(speller.suggest('wierd')[0].word, 'weird');
  });

  test('a clear winner, unless another word is close', () => {
    assert.equal(Speller.clearWinner(speller.suggest('frend')), 'friend');
    assert.equal(
      Speller.clearWinner([
        {word: 'leaning', score: 0},
        {word: 'learning', score: 0.1},
      ]),
      undefined,
    );
  });

  test('nothing for what isn’t a word', () => {
    assert.deepEqual(speller.suggest('猫'), []);
    assert.deepEqual(speller.suggest('x'), []);
  });
});

const SPELL = path.resolve(import.meta.dirname, '../dist/data/spell.json');

describe(
  'speller on the built data',
  {skip: !fs.existsSync(SPELL) && 'data not built'},
  () => {
    test('real misspellings find the word meant', () => {
      const speller = new Speller(JSON.parse(fs.readFileSync(SPELL, 'utf8')));
      const cases: [string, string][] = [
        ['beterment', 'betterment'],
        ['imporvement', 'improvement'],
        ['recieve', 'receive'],
        ['kniwledge', 'knowledge'],
        ['dictonary', 'dictionary'],
        ['beautifull', 'beautiful'],
        ['frend', 'friend'],
        ['lerning', 'learning'],
        ['tommorow', 'tomorrow'],
        ['enviroment', 'environment'],
      ];
      for (const [typed, meant] of cases) {
        assert.equal(Speller.clearWinner(speller.suggest(typed)), meant, typed);
      }
    });
  },
);
