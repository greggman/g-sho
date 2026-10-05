import assert from 'node:assert/strict';
import {test} from 'node:test';
import {makePack, readPack} from '../src/shared/pack.ts';

test('a pack holds its files exactly, Japanese and newlines included', () => {
  const files: [string, string][] = [
    ['ent/0000.json', '{"1":{"k":[{"t":"猫"}]}}'],
    ['ent/0001.json', 'line one\nline two\n'],
    ['radk.json', ''],
    ['ent/0002.json', '{"x":"黒煎り七味 😀"}'],
  ];
  assert.deepEqual(readPack(makePack(files)), files);
});

test('the build’s packs read back into the files they came from', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = path.resolve(import.meta.dirname, '../dist/data');
  const first = path.join(dir, 'pack', 'kanji-0.txt');
  if (!fs.existsSync(first)) return; // data not built
  for (const [file, text] of readPack(fs.readFileSync(first, 'utf8'))) {
    assert.equal(text, fs.readFileSync(path.join(dir, file), 'utf8'), file);
  }
});
