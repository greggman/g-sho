/**
 * Spelling suggestions for English searches that find nothing: a noisy
 * channel model, built into data/spell.json.
 *
 *   - Vocabulary: every single English word the app can show something for
 *     (the English-meanings index, en/, and the English words, enw/), with
 *     how common it is (wordfreq's English list, as a Zipf value ×10).
 *   - Error model: what real misspellings do, learned from Wikipedia's list
 *     of common misspellings. Each pair is aligned (Damerau–Levenshtein) and
 *     its edits counted: letters dropped, added, doubled or undoubled,
 *     swapped with a neighbour, or replaced by another. Common edits cost
 *     less (spell.ts).
 *   - Known misspellings: the list itself, for the ones that aren't simple
 *     typos ("accomodate").
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import {decodeMsgpack} from './msgpack.ts';

export interface SpellData {
  /**
   * Words by how common they are: lines of "<zipf×10> word word …", most
   * common first.
   */
  words: string;
  /** edit → cost (spell.ts): "s:ae" e typed as a, "d:e", "i:e", "t:ie", "dd:l", "di:l" */
  costs: Record<string, number>;
  /** a known misspelling → what it should be */
  known: Record<string, string[]>;
}

/** A single word: letters, maybe with an apostrophe or hyphen inside. */
const WORD = /^[a-z][a-z'-]{0,23}[a-z]$/;

/** wordfreq's English list: word → Zipf (log10 per billion words). */
function readFrequencies(file: string): Map<string, number> {
  const out = new Map<string, number>();
  const buckets = decodeMsgpack(
    zlib.gunzipSync(fs.readFileSync(file)),
  ) as unknown[];
  // Bucket i (after the header) holds words with frequency 10^(-i/100).
  buckets.forEach((words, i) => {
    if (i === 0 || !Array.isArray(words)) return;
    for (const w of words as string[]) out.set(w, 9 - i / 100);
  });
  return out;
}

/** The keys of every shard in a built data folder. */
function shardKeys(dir: string): Set<string> {
  const out = new Set<string>();
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    const shard = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const k of Object.keys(shard)) out.add(k);
  }
  return out;
}

/** The edits that turn `right` into `wrong`, as error-model keys. */
export function edits(right: string, wrong: string): string[] {
  const n = right.length;
  const m = wrong.length;
  const d = Array.from({length: n + 1}, () => new Array<number>(m + 1).fill(0));
  for (let i = 0; i <= n; i++) d[i][0] = i;
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const same = right[i - 1] === wrong[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + same,
      );
      if (
        i > 1 &&
        j > 1 &&
        right[i - 1] === wrong[j - 2] &&
        right[i - 2] === wrong[j - 1]
      ) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  // Walk back along a cheapest path.
  const out: string[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (
      i > 0 &&
      j > 0 &&
      right[i - 1] === wrong[j - 1] &&
      d[i][j] === d[i - 1][j - 1]
    ) {
      i--;
      j--;
    } else if (
      i > 1 &&
      j > 1 &&
      right[i - 1] === wrong[j - 2] &&
      right[i - 2] === wrong[j - 1] &&
      d[i][j] === d[i - 2][j - 2] + 1
    ) {
      out.push(`t:${right[i - 2]}${right[i - 1]}`);
      i -= 2;
      j -= 2;
    } else if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + 1) {
      out.push(`s:${right[i - 1]}${wrong[j - 1]}`);
      i--;
      j--;
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
      // A letter left out; a doubled one written once is its own kind.
      const c = right[i - 1];
      out.push(right[i - 2] === c || right[i] === c ? `dd:${c}` : `d:${c}`);
      i--;
    } else {
      // A letter added; doubling one is its own kind.
      const c = wrong[j - 1];
      out.push(wrong[j - 2] === c || wrong[j] === c ? `di:${c}` : `i:${c}`);
      j--;
    }
  }
  return out;
}

/** "abandonned->abandoned" lines: misspelling → what it should be. */
export function readMisspellings(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of text.split('\n')) {
    const m = /^\s*([^\s<>]+)->(.+)$/.exec(line);
    if (!m) continue;
    const wrong = m[1].toLowerCase();
    const right = m[2]
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(s => WORD.test(s));
    if (WORD.test(wrong) && right.length) out.set(wrong, right);
  }
  return out;
}

/**
 * An edit's cost from how often real misspellings make it: about 1 for an
 * edit never seen, down to 0.25 for the most common ones.
 */
function learnCosts(misspellings: Map<string, string[]>) {
  const counts = new Map<string, number>();
  for (const [wrong, rights] of misspellings) {
    for (const e of edits(rights[0], wrong)) {
      counts.set(e, (counts.get(e) ?? 0) + 1);
    }
  }
  const costs: Record<string, number> = {};
  const max = Math.max(...counts.values());
  for (const [e, n] of counts) {
    if (n < 2) continue;
    costs[e] =
      Math.round((1 - 0.75 * (Math.log(n) / Math.log(max))) * 100) / 100;
  }
  return costs;
}

export function buildSpelling(
  outDir: string,
  cacheDir: string,
  wordfreqFile: string | undefined,
): boolean {
  const misspellingsFile = path.join(cacheDir, 'spelling', 'misspellings.txt');
  if (
    !wordfreqFile ||
    !fs.existsSync(wordfreqFile) ||
    !fs.existsSync(misspellingsFile)
  ) {
    console.warn(
      'warning: wordfreq English or the misspellings list missing; run `npm run download`',
    );
    return false;
  }
  const freq = readFrequencies(wordfreqFile);
  const vocabulary = new Set(
    [
      ...shardKeys(path.join(outDir, 'en')),
      ...shardKeys(path.join(outDir, 'enw')),
    ]
      .map(w => w.toLowerCase())
      .filter(w => WORD.test(w)),
  );
  // By how common, in steps of 0.1: unknown to wordfreq is 0.
  const byZipf = new Map<number, string[]>();
  for (const w of vocabulary) {
    const z = Math.max(0, Math.round((freq.get(w) ?? 0) * 10));
    const list = byZipf.get(z) ?? [];
    list.push(w);
    byZipf.set(z, list);
  }
  const words = [...byZipf]
    .sort((a, b) => b[0] - a[0])
    .map(([z, list]) => `${z} ${list.sort().join(' ')}`)
    .join('\n');
  const misspellings = readMisspellings(
    fs.readFileSync(misspellingsFile, 'utf8'),
  );
  const known: Record<string, string[]> = {};
  for (const [wrong, rights] of misspellings) {
    const ok = rights.filter(r => vocabulary.has(r));
    if (ok.length) known[wrong] = ok;
  }
  const data: SpellData = {words, costs: learnCosts(misspellings), known};
  const json = JSON.stringify(data);
  fs.writeFileSync(path.join(outDir, 'spell.json'), json);
  console.log(
    `spell: ${vocabulary.size} words, ${Object.keys(data.costs).length} edit costs, ` +
      `${Object.keys(known).length} known misspellings, ${(json.length / 1024).toFixed(0)}KB`,
  );
  return true;
}
