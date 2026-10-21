/**
 * Every piece of interface text passed to t() has Japanese, with the same
 * {placeholders}.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {test} from 'node:test';
import {JA} from '../src/client/i18n/ja/index.ts';

const SRC = path.resolve(import.meta.dirname, '../src/client');

function sources(dir: string): string[] {
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'i18n' ? [] : sources(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}

/** The text of each t('…') call: a single string literal, as required. */
function calls(): {text: string; where: string}[] {
  const out: {text: string; where: string}[] = [];
  const call = /\bt\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1\s*[,)]/g;
  for (const file of sources(SRC)) {
    const code = fs.readFileSync(file, 'utf8');
    for (const m of code.matchAll(call)) {
      // The literal's value, as JavaScript reads it.
      const text =
        m[1] === '`'
          ? m[2]
          : (JSON.parse(
              `"${m[2].replace(/\\'/g, "'").replace(/"/g, '\\"')}"`,
            ) as string);
      const line = code.slice(0, m.index).split('\n').length;
      out.push({text, where: `${path.relative(SRC, file)}:${line}`});
    }
  }
  return out;
}

const placeholders = (s: string) =>
  [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();

test('all interface text has Japanese', () => {
  const missing = calls()
    .filter(c => !(c.text in JA))
    .map(c => `${c.where}: ${JSON.stringify(c.text)}`);
  assert.deepEqual(missing, []);
});

test('Japanese keeps the placeholders', () => {
  const wrong = Object.entries(JA)
    .filter(([en, ja]) => {
      const a = placeholders(en);
      const b = placeholders(ja);
      return a.length !== b.length || a.some((x, i) => x !== b[i]);
    })
    .map(([en]) => en);
  assert.deepEqual(wrong, []);
});

test('no template literal with ${} is passed to t()', () => {
  // t(`Hello ${name}`) can't be looked up: use t('Hello {name}', {name}).
  const bad = calls()
    .filter(c => c.text.includes('${'))
    .map(c => c.where);
  assert.deepEqual(bad, []);
});
