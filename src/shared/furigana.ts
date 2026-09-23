/** Text with an optional reading over it. */
export type RubyPart = [text: string, ruby?: string];

/**
 * Parses Tatoeba's furigana markup: "[世界|せ|かい]に[行|い]く". A bracket
 * holds the text and either one reading per character (世→せ, 界→かい) or one
 * for the whole group. Either way the group gets a single reading (世界 →
 * せかい): per-character readings longer than their kanji would spread the
 * characters of a word apart.
 */
export function parseFurigana(markup: string): RubyPart[] {
  const parts: RubyPart[] = [];
  const re = /\[([^|\]]+)((?:\|[^|\]]*)+)\]/g;
  let last = 0;
  for (const m of markup.matchAll(re)) {
    if (m.index > last) parts.push([markup.slice(last, m.index)]);
    const text = m[1];
    const reading = m[2].slice(1).split('|').join('');
    parts.push(reading ? [text, reading] : [text]);
    last = m.index + m[0].length;
  }
  if (last < markup.length) parts.push([markup.slice(last)]);
  return parts;
}

export function plainText(parts: RubyPart[]): string {
  return parts.map(([t]) => t).join('');
}
