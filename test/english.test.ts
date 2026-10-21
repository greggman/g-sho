import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import {Dict} from '../src/client/dict.ts';
import {lookupEnglish, regularBases} from '../src/client/english.ts';
import {
  loadDisplaySettings,
  saveDisplaySetting,
} from '../src/client/settings.ts';
import {MemoryBackend, Table} from '../src/client/store/table.ts';
import type {SettingsRow} from '../src/client/store/store.ts';
import {enShard, shardName} from '../src/shared/hash.ts';
import type {EnglishEntry, EnglishShard} from '../src/shared/types.ts';

const entry = (w: string, g: string, p = '名詞'): EnglishEntry => ({
  w,
  p,
  s: [{g}],
});

/** A Dict with only these English words. */
async function englishDict(words: EnglishShard, shards = 4): Promise<Dict> {
  const files = new Map<string, EnglishShard>();
  for (const [word, value] of Object.entries(words)) {
    const name = `enw/${shardName(enShard(word, shards))}.json`;
    const shard = files.get(name) ?? {};
    shard[word] = value;
    files.set(name, shard);
  }
  return Dict.open(async path => {
    if (path === 'meta.json') return {shards: {enw: shards}};
    return files.get(path) ?? {};
  });
}

describe('English words (英和)', () => {
  test('regular endings give the words they could be', () => {
    assert.deepEqual(regularBases('cities'), ['city', 'citie']);
    assert.ok(regularBases('walked').includes('walk'));
    assert.ok(regularBases('baked').includes('bake'));
    assert.ok(regularBases('stopped').includes('stop'));
    assert.ok(regularBases('running').includes('run'));
    assert.ok(regularBases('boxes').includes('box'));
    assert.ok(regularBases('happier').includes('happy'));
    assert.deepEqual(regularBases('cat'), []);
  });

  test('a word, its forms from the data, and regular forms', async () => {
    const dict = await englishDict({
      go: {e: [entry('go', '行く。', '動詞')]},
      went: {e: [entry('went', 'goの過去形', '動詞')], of: ['go']},
      walk: {e: [entry('walk', '歩く。', '動詞')]},
      'ice cream': {e: [entry('ice cream', 'アイスクリーム。')]},
      cat: {e: [entry('cat', '猫。'), entry('CAT', '中央アフリカ時間の略。')]},
    });
    const words = async (q: string) =>
      (await lookupEnglish(dict, q)).map(w => [w.word, !!w.base]);

    assert.deepEqual(await words('Cat'), [['cat', false]]);
    assert.equal((await lookupEnglish(dict, 'cat'))[0].entries.length, 2);
    assert.deepEqual(await words('went'), [
      ['went', false],
      ['go', true],
    ]);
    assert.deepEqual(await words('walked'), [['walk', true]]);
    assert.deepEqual(await words('  ice   cream '), [['ice cream', false]]);
    assert.deepEqual(await words('猫'), []);
    assert.deepEqual(await words('unknownish'), []);
  });

  test('nothing without the data', async () => {
    const dict = await Dict.open(async () => ({shards: {}}));
    assert.deepEqual(await lookupEnglish(dict, 'cat'), []);
  });
});

describe('display settings', () => {
  const table = async () => {
    const t = new Table<SettingsRow>('settings', new MemoryBackend());
    await t.load();
    return t;
  };

  test('each setting is saved on its own; the rest stay unsaved', async () => {
    const t = await table();
    saveDisplaySetting(t, 'furigana', false);
    assert.equal(loadDisplaySettings(t).furigana, false);
    assert.deepEqual(
      t.all().map(r => r.id),
      ['showFurigana'],
    );
  });

  test('settings changed on two devices both survive', async () => {
    // As if synced: one device changed furigana, the other kanji.
    const t = await table();
    saveDisplaySetting(t, 'furigana', false);
    saveDisplaySetting(t, 'kanji', false);
    const s = loadDisplaySettings(t);
    assert.equal(s.furigana, false);
    assert.equal(s.kanji, false);
  });

  test('the older all-in-one row counts when it changed later', async () => {
    const t = await table();
    let now = 100;
    t.now = () => now;
    saveDisplaySetting(t, 'furigana', false);
    now = 200;
    // An older version of the app on another device saved everything.
    t.put({id: 'display', value: {furigana: true, meanings: false}});
    let s = loadDisplaySettings(t);
    assert.equal(s.furigana, true);
    assert.equal(s.meanings, false);
    now = 300;
    saveDisplaySetting(t, 'furigana', false);
    s = loadDisplaySettings(t);
    assert.equal(s.furigana, false);
    assert.equal(s.meanings, false);
  });
});
