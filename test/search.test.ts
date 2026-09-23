/**
 * End-to-end search tests against the real built data in dist/data.
 * Skipped when the data hasn't been built (npm run download && npm run build:data).
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {before, describe, test} from 'node:test';
import {Dict} from '../src/client/dict.ts';
import {headword} from '../src/client/forms.ts';
import {search} from '../src/client/search.ts';

const DATA_DIR = path.resolve(import.meta.dirname, '..', 'dist', 'data');
const haveData = fs.existsSync(path.join(DATA_DIR, 'meta.json'));

describe('search', {skip: !haveData && 'data not built'}, () => {
  let dict: Dict;
  before(async () => {
    dict = await Dict.open(async p =>
      JSON.parse(await fs.promises.readFile(path.join(DATA_DIR, p), 'utf8')),
    );
  });

  const firstWord = async (q: string) => {
    const r = await search(dict, q);
    assert.ok(r.words.length > 0, `no results for ${q}`);
    const e = r.words[0].entry;
    return {r, e, text: headword(e).text};
  };

  test('kanji word', async () => {
    assert.equal((await firstWord('食べる')).text, '食べる');
  });

  test('kana word finds the kanji entry', async () => {
    assert.equal((await firstWord('たべる')).text, '食べる');
  });

  test('katakana', async () => {
    assert.equal((await firstWord('ラーメン')).text, 'ラーメン');
  });

  test('romaji', async () => {
    const {r, text} = await firstWord('taberu');
    assert.equal(text, '食べる');
    assert.equal(r.kana, 'たべる');
  });

  test('English', async () => {
    const {e} = await firstWord('eat');
    assert.ok(e.s.some(s => s.g.includes('to eat')));
  });

  test('English phrase', async () => {
    const {text} = await firstWord('ice cream');
    assert.equal(text, 'アイスクリーム');
  });

  test('inflected word', async () => {
    const {r, text} = await firstWord('食べました');
    assert.equal(text, '食べる');
    assert.deepEqual(r.words[0].inflection?.reasons, ['past', 'polite']);
  });

  test('prefix matches follow exact ones', async () => {
    const r = await search(dict, 'たべ');
    const texts = r.words.map(w => headword(w.entry).text);
    assert.ok(texts.includes('食べる'));
    assert.ok(texts.includes('食べ物'));
  });

  test('sentence is split into words', async () => {
    const r = await search(dict, '私は日本語を勉強しています。');
    assert.deepEqual(
      r.tokens?.map(t => t.text),
      ['私', 'は', '日本語', 'を', '勉強しています', '。'],
    );
    assert.equal(r.tokens?.[4].base, '勉強');
  });

  test('every word of a sentence has matches', async () => {
    const r = await search(dict, '私は日本語を勉強しています。');
    const heads = r.sentence?.map(w => headword(w.matches[0].entry).text);
    // は and を are the particles, not 歯 (tooth) or 葉 (leaf).
    assert.deepEqual(heads, ['私', 'は', '日本語', 'を', '勉強']);
    assert.deepEqual(r.sentence?.[4].matches[0].inflection?.reasons, [
      'polite',
      'progressive',
      'suru verb',
    ]);
  });

  test('stroke order matches the stroke count', async () => {
    for (const k of '食日書語学犬猫木一鬱') {
      const [info, strokes] = await Promise.all([
        dict.kanji(k),
        dict.strokes(k),
      ]);
      assert.equal(strokes?.length, info?.s, k);
      assert.match(strokes![0], /^M/);
    }
  });

  test('kanji info', async () => {
    const k = await dict.kanji('食');
    assert.equal(k?.s, 9);
    assert.ok(k?.m.includes('eat'));
  });
});
