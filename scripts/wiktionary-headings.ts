/**
 * Which kanji each word on a Japanese Wiktionary kana page is, from the
 * page's own section headings, which the kaikki.org extract leaves out:
 *
 *   ==={{verb}}:買う===
 *   #[[代価]]を払って[[品物]]や[[情報]]を[[手に入れる]]。
 *   ==={{verb}}:飼う===
 *   #[[動物]]の世話をして育てる。
 *
 * Read from Wikimedia's dump of the Japanese Wiktionary (pages-articles,
 * bz2). For each hiragana page: its sections that name a word in kanji, with
 * their definitions as plain text, to tell which section an extract entry
 * is by its first definition (build-jawiktionary.ts).
 */
import {spawn} from 'node:child_process';
import * as readline from 'node:readline';

export interface Section {
  /**
   * the spellings the heading names: 炒る／煎る → ["炒る", "煎る"]; or
   * their kanji alone: 耐・堪 (たえる) → ["耐", "堪"]
   */
  w: string[];
  /** its definitions, as plain text (plainKey), cut short */
  d: string;
}

/** Definitions kept per section: enough to find a first definition in. */
const MAX_DEFS = 600;

const HEADING = /^(={2,6})\s*(.*?)\s*\1\s*$/;
const KANJI = /[\u3400-\u9fff\uf900-\ufaff々]/;
/**
 * Pages read: hiragana ones, whose headings name spellings. Katakana
 * pages' name a field instead: バス's "{{noun}}:車両", "{{noun}}:音楽".
 */
const HIRAGANA = /^[ぁ-ゖー]+$/;

/**
 * Whether a heading's word can be a spelling of the page's: it has kanji,
 * and its kana end is the page's (買う for かう).
 */
function spells(word: string, title: string): boolean {
  if (!KANJI.test(word)) return false;
  const tail = /[ぁ-ゖー]*$/.exec(word)![0];
  return title.endsWith(tail) && title.length > tail.length;
}

/** Wiki markup to plain text: [[a|b]] → b, templates and tags dropped. */
export function plainWiki(s: string): string {
  let out = s
    .replace(/<ref[^>]*\/>|<ref[^>]*>[\s\S]*?<\/ref>/g, '')
    // Furigana: {{ruby|足り|たり}} → 足り.
    .replace(/\{\{(?:ruby|r|ふりがな)\|([^|{}]*)[^{}]*\}\}/gi, '$1');
  // Other templates, innermost first.
  for (let i = 0; i < 5 && out.includes('{{'); i++) {
    out = out.replace(/\{\{[^{}]*\}\}/g, '');
  }
  return out
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/'{2,}/g, '')
    .replace(/<[^>]+>/g, '');
}

/** Text to compare definitions by: no spaces or punctuation. */
export function plainKey(s: string): string {
  return s.replace(
    /[\s。、，,．.・「」『』（）()【】［］[\]:：;；!！?？"'“”…-]/g,
    '',
  );
}

/**
 * The Japanese section's word sections of a page's wikitext: headings
 * like "{{verb}}:買う" naming a word with kanji, each with its
 * definitions (# lines, not examples).
 */
export function pageSections(wikitext: string, title: string): Section[] {
  const out: Section[] = [];
  let inJapanese = false;
  let current: {section: Section; level: number; defs: string[]} | undefined;
  const finish = () => {
    if (!current) return;
    current.section.d = plainKey(current.defs.join('')).slice(0, MAX_DEFS);
    if (current.section.d) out.push(current.section);
    current = undefined;
  };
  for (const line of wikitext.split('\n')) {
    const h = HEADING.exec(line);
    if (h) {
      const level = h[1].length;
      if (level === 2) {
        finish();
        inJapanese = /^(\{\{L\|ja\}\}|\{\{ja\}\}|日本語)$/.test(h[2]);
        continue;
      }
      if (!inJapanese) continue;
      if (current && level > current.level) continue; // its subsections
      finish();
      // "{{verb}}:買う"; not "{{etym}}:いる（ヤ行）", a variant, not a word.
      const named = /^\{\{([^}|]+)[^}]*\}\}\s*[:：]\s*(.+)$/.exec(h[2]);
      const name = named && !/^etym/.test(named[1]) ? named[2] : '';
      // "会う（逢う）" names both.
      const words = name
        .split(/[／/、,，・（）()]/)
        .map(w => plainWiki(w).trim())
        .filter(w => spells(w, title));
      if (words.length) current = {section: {w: words, d: ''}, level, defs: []};
      continue;
    }
    // Definitions, not their examples (#*) or notes (#:).
    if (current && /^#+(?![*:])/.test(line)) {
      current.defs.push(plainWiki(line.replace(/^#+/, '')));
    }
  }
  finish();
  return out;
}

const ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
};

function decodeXml(s: string): string {
  return s.replace(/&(lt|gt|amp|quot|apos);/g, (_, e: string) => ENTITIES[e]);
}

/**
 * The word sections of every kana page in a pages-articles dump (.bz2,
 * read with bzcat), by title; pages with none are left out.
 */
export async function readDumpSections(
  file: string,
): Promise<Record<string, Section[]>> {
  const bzcat = spawn('bzcat', [file], {stdio: ['ignore', 'pipe', 'inherit']});
  const exited = new Promise<void>((resolve, reject) => {
    bzcat.on('error', reject);
    bzcat.on('close', code =>
      code === 0 ? resolve() : reject(new Error(`bzcat ${file}: ${code}`)),
    );
  });
  const out: Record<string, Section[]> = {};
  let title = '';
  let ns = '';
  let text: string[] | undefined;
  const lines = readline.createInterface({
    input: bzcat.stdout,
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (text) {
      const end = line.indexOf('</text>');
      text.push(end < 0 ? line : line.slice(0, end));
      if (end < 0) continue;
      if (ns === '0' && HIRAGANA.test(title)) {
        const sections = pageSections(decodeXml(text.join('\n')), title);
        if (sections.length) out[title] = sections;
      }
      text = undefined;
      continue;
    }
    const t = /<title>(.*)<\/title>/.exec(line);
    if (t) {
      title = decodeXml(t[1]);
      continue;
    }
    const n = /<ns>(\d+)<\/ns>/.exec(line);
    if (n) {
      ns = n[1];
      continue;
    }
    const start = line.indexOf('<text');
    if (start >= 0) {
      const open = line.indexOf('>', start);
      if (line[open - 1] === '/') continue; // <text ... /> (empty)
      const rest = line.slice(open + 1);
      const end = rest.indexOf('</text>');
      text = [end < 0 ? rest : rest.slice(0, end)];
      if (end >= 0) {
        if (ns === '0' && HIRAGANA.test(title)) {
          const sections = pageSections(decodeXml(text.join('\n')), title);
          if (sections.length) out[title] = sections;
        }
        text = undefined;
      }
    }
  }
  await exited;
  return out;
}

/**
 * The section an entry is, by its first definition (as the extract has
 * it); undefined when none or several have it.
 */
export function sectionFor(
  gloss: string,
  sections: Section[],
): Section | undefined {
  const key = plainKey(plainWiki(gloss));
  // Its start, or a little further in, shorter if need be: a template the
  // extract expanded and this dropped ("[[困る|困っ]]") can cut it here.
  for (const [from, n] of [
    [0, 16],
    [0, 8],
    [2, 10],
    [4, 8],
    [0, 5],
  ]) {
    const part = key.slice(from, from + n);
    if (part.length < 4 && !(from === 0 && part === key)) continue;
    const found = sections.filter(s => s.d.includes(part));
    if (found.length === 1) return found[0];
    if (found.length > 1) return undefined;
  }
  return undefined;
}
