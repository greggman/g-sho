/**
 * Spelling suggestions for an English search that finds nothing: the words
 * it was most likely meant to be. A noisy channel model (data/spell.json,
 * built by scripts/build-spelling.ts): how cheaply the typed word is a
 * mistyping of each known word (edits real misspellings make cost less),
 * against how common that word is. Known misspellings ("accomodate") are
 * looked up first.
 */
import type {Dict} from './dict.ts';

export interface SpellData {
  words: string;
  costs: Record<string, number>;
  known: Record<string, string[]>;
}

export interface Suggestion {
  word: string;
  /** lower is likelier */
  score: number;
}

/** What a single English word can look like (as built). */
const WORD = /^[a-z][a-z'-]{0,23}[a-z]$/;
/** The letters words are made of, as numbers 0–27. */
const LETTERS = "abcdefghijklmnopqrstuvwxyz'-";
const N = LETTERS.length;
/** Edits that aren't in the learned costs. */
const DEFAULT_COST = {s: 1, d: 1, i: 1, t: 0.8, dd: 0.6, di: 0.6};
/** Neighbouring letters on a QWERTY keyboard: hitting one for the other. */
const KEYBOARD = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
const ADJACENT_COST = 0.75;
/** How much a word's commonness (Zipf, 0–8) counts against edit cost. */
const COMMON_WEIGHT = 0.15;
/** The most edit cost a suggestion may have. */
const MAX_COST = 2;
/** How far an alignment may drift: words differ by at most this in length. */
const BAND = 2;
/**
 * How much likelier the best suggestion must be than the next different
 * word, to search for it without asking.
 */
const CLEAR_MARGIN = 0.35;

function adjacent(a: string, b: string): boolean {
  for (let r = 0; r < KEYBOARD.length; r++) {
    const i = KEYBOARD[r].indexOf(a);
    if (i < 0) continue;
    for (let s = Math.max(0, r - 1); s <= Math.min(2, r + 1); s++) {
      const j = KEYBOARD[s].indexOf(b);
      if (j >= 0 && Math.abs(i - j) <= 1 && (s !== r || i !== j)) return true;
    }
  }
  return false;
}

const codes = (w: string) =>
  Uint8Array.from(w, c => Math.max(0, LETTERS.indexOf(c)));

/** Another form of the same word: improvement / improvements. */
const sameWord = (a: string, b: string) =>
  a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a));

export class Speller {
  /** every word's letters, one after another */
  private readonly letters: Uint8Array;
  private readonly start: Uint32Array;
  private readonly length: Uint8Array;
  private readonly zipf: Float32Array;
  private readonly words: string[] = [];
  private readonly known: Record<string, string[]>;
  // Edit costs by letter: s/t by pair (a*N+b), the rest by letter.
  private readonly sub = new Float32Array(N * N);
  private readonly swap = new Float32Array(N * N);
  private readonly del = new Float32Array(N);
  private readonly delDouble = new Float32Array(N);
  private readonly ins = new Float32Array(N);
  private readonly insDouble = new Float32Array(N);

  constructor(data: SpellData) {
    const zipf: number[] = [];
    for (const line of data.words.split('\n')) {
      const [z, ...words] = line.split(' ');
      for (const w of words) {
        this.words.push(w);
        zipf.push(Number(z) / 10);
      }
    }
    this.zipf = Float32Array.from(zipf);
    this.start = new Uint32Array(this.words.length);
    this.length = new Uint8Array(this.words.length);
    let total = 0;
    for (const w of this.words) total += w.length;
    this.letters = new Uint8Array(total);
    let at = 0;
    this.words.forEach((w, i) => {
      this.start[i] = at;
      this.length[i] = w.length;
      this.letters.set(codes(w), at);
      at += w.length;
    });
    this.known = data.known;
    const cost = (key: string, fallback: number) => data.costs[key] ?? fallback;
    for (let a = 0; a < N; a++) {
      const ca = LETTERS[a];
      this.del[a] = cost(`d:${ca}`, DEFAULT_COST.d);
      this.delDouble[a] = cost(`dd:${ca}`, DEFAULT_COST.dd);
      this.ins[a] = cost(`i:${ca}`, DEFAULT_COST.i);
      this.insDouble[a] = cost(`di:${ca}`, DEFAULT_COST.di);
      for (let b = 0; b < N; b++) {
        const cb = LETTERS[b];
        this.sub[a * N + b] =
          a === b
            ? 0
            : cost(
                `s:${ca}${cb}`,
                adjacent(ca, cb) ? ADJACENT_COST : DEFAULT_COST.s,
              );
        this.swap[a * N + b] = cost(`t:${ca}${cb}`, DEFAULT_COST.t);
      }
    }
  }

  /**
   * The cost of `typed` being a mistyping of word `k` (weighted Damerau–
   * Levenshtein within a band), or Infinity past `limit`.
   */
  private editCost(
    k: number,
    typed: Uint8Array,
    insCost: Float32Array,
    limit: number,
  ): number {
    const L = this.letters;
    const s0 = this.start[k];
    const n = this.length[k];
    const m = typed.length;
    if (Math.abs(n - m) > BAND) return Infinity;
    let prev2 = new Float64Array(m + 1).fill(Infinity);
    let prev = new Float64Array(m + 1).fill(Infinity);
    let row = new Float64Array(m + 1).fill(Infinity);
    prev[0] = 0;
    for (let j = 1; j <= Math.min(m, BAND); j++)
      prev[j] = prev[j - 1] + insCost[j - 1];
    for (let i = 1; i <= n; i++) {
      const a = L[s0 + i - 1];
      const doubled =
        (i > 1 && L[s0 + i - 2] === a) || (i < n && L[s0 + i] === a);
      const delCost = doubled ? this.delDouble[a] : this.del[a];
      row.fill(Infinity);
      const lo = Math.max(0, i - BAND);
      const hi = Math.min(m, i + BAND);
      let best = Infinity;
      for (let j = lo; j <= hi; j++) {
        let c = prev[j] + delCost;
        if (j > 0) {
          const b = typed[j - 1];
          c = Math.min(
            c,
            row[j - 1] + insCost[j - 1],
            prev[j - 1] + this.sub[a * N + b],
          );
          if (i > 1 && j > 1 && a === typed[j - 2] && L[s0 + i - 2] === b) {
            c = Math.min(c, prev2[j - 2] + this.swap[b * N + a]);
          }
        }
        row[j] = c;
        if (c < best) best = c;
      }
      if (best > limit) return Infinity;
      [prev2, prev, row] = [prev, row, prev2];
    }
    return prev[m] > limit ? Infinity : prev[m];
  }

  /** The likeliest words `typed` was meant to be, best first. */
  suggest(typed: string, limit = 5): Suggestion[] {
    const w = typed.trim().toLowerCase();
    if (!WORD.test(w)) return [];
    const out: Suggestion[] = [];
    // A known misspelling ("recieve") is answered even if it's in the data.
    for (const k of this.known[w] ?? []) {
      out.push({word: k, score: -100 + out.length});
    }
    const t = codes(w);
    // Typing t[j] that isn't in the word: cheaper when it doubles one.
    const insCost = Float32Array.from(t, (c, j) =>
      t[j - 1] === c || t[j + 1] === c ? this.insDouble[c] : this.ins[c],
    );
    // Short words have many neighbours: allow less.
    const maxCost = w.length <= 4 ? 1 : MAX_COST;
    for (let k = 0; k < this.words.length; k++) {
      const cost = this.editCost(k, t, insCost, maxCost);
      if (cost === 0 || cost === Infinity) continue;
      const word = this.words[k];
      if (out.some(o => o.word === word)) continue;
      out.push({word, score: cost - COMMON_WEIGHT * this.zipf[k]});
    }
    return out.sort((a, b) => a.score - b.score).slice(0, limit);
  }

  /**
   * The suggestion to search for without asking: one clearly likelier than
   * the next different word (forms of it, like plurals, don't count).
   */
  static clearWinner(suggestions: Suggestion[]): string | undefined {
    const [best, ...rest] = suggestions;
    if (!best) return undefined;
    const next = rest.find(s => !sameWord(s.word, best.word));
    if (!next || best.score + CLEAR_MARGIN <= next.score) return best.word;
    return undefined;
  }
}

let speller: Promise<Speller | undefined> | undefined;

/** The speller, loaded the first time it's needed (undefined without the data). */
export function loadSpeller(dict: Dict): Promise<Speller | undefined> {
  speller ??= dict.spelling().then(
    data => (data ? new Speller(data) : undefined),
    () => {
      speller = undefined;
      return undefined;
    },
  );
  return speller;
}
