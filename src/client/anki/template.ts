/**
 * Renders Anki card templates: {{Field}}, {{#Field}}…{{/Field}},
 * {{^Field}}…{{/Field}}, {{FrontSide}}, special fields (Tags, Deck,
 * Subdeck, Type, Card), and filters, applied right to left:
 * text, furigana, kana, kanji, cloze, cloze-only, type, hint, tts (dropped).
 * Sounds ([sound:x.mp3]) become play buttons for the card frame.
 *
 * Like Anki, the result is HTML from the deck, to be shown in a sandbox.
 */

export interface TemplateContext {
  fields: Record<string, string>;
  tags: string[];
  deck: string;
  noteType: string;
  cardName: string;
  /** the card's ord (for cloze: the cloze number - 1) */
  ord: number;
  side: 'front' | 'back';
  /** the rendered front, for {{FrontSide}} on the back */
  frontSide?: string;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ');
}

/** Anki's furigana regex: " ?base[reading]". */
const FURIGANA = / ?([^ >]+?)\[(.+?)\]/g;

const escapeAttr = (s: string) =>
  s.replace(
    /[&"<>]/g,
    c => ({'&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;'})[c]!,
  );

/** {{c1::text::hint}} for the card whose cloze number is `n`. */
function cloze(text: string, n: number, side: 'front' | 'back', only = false) {
  const re = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;
  if (only) {
    return [...text.matchAll(re)]
      .filter(m => Number(m[1]) === n)
      .map(m => m[2])
      .join(', ');
  }
  return text.replace(re, (_, num: string, inner: string, hint?: string) => {
    if (Number(num) !== n) return inner;
    return side === 'front'
      ? `<span class="cloze" data-cloze="${escapeAttr(inner)}">[${hint ?? '...'}]</span>`
      : `<span class="cloze">${inner}</span>`;
  });
}

function applyFilter(
  filter: string,
  value: string,
  name: string,
  ctx: TemplateContext,
): string {
  const f = filter.trim();
  if (f === 'text') return stripHtml(value);
  if (f === 'furigana') {
    return value.replace(FURIGANA, '<ruby><rb>$1</rb><rt>$2</rt></ruby>');
  }
  if (f === 'kana') return value.replace(FURIGANA, '$2');
  if (f === 'kanji') return value.replace(FURIGANA, '$1');
  if (f === 'cloze') return cloze(value, ctx.ord + 1, ctx.side);
  if (f === 'cloze-only') return cloze(value, ctx.ord + 1, ctx.side, true);
  if (f === 'type' || f.startsWith('type')) {
    return ctx.side === 'front'
      ? '<input type="text" class="typeans" aria-label="Type the answer">'
      : value;
  }
  if (f === 'hint') {
    if (!value.trim()) return '';
    return (
      '<a class="hint" href="#" onclick="this.style.display=\'none\';' +
      "this.nextElementSibling.style.display='block';return false;\">" +
      `Show ${escapeAttr(name)}</a><div class="hint" style="display:none">${value}</div>`
    );
  }
  if (f.startsWith('tts')) return '';
  // An unknown filter (from an add-on): leave the value as is.
  return value;
}

function fieldValue(name: string, ctx: TemplateContext): string {
  switch (name) {
    case 'FrontSide':
      return ctx.side === 'back' ? (ctx.frontSide ?? '') : '';
    case 'Tags':
      return ctx.tags.join(' ');
    case 'Deck':
      return ctx.deck;
    case 'Subdeck':
      return ctx.deck.split('::').pop() ?? '';
    case 'Type':
      return ctx.noteType;
    case 'Card':
      return ctx.cardName;
    case 'CardFlag':
      return '';
  }
  return ctx.fields[name] ?? '';
}

/** Whether a field has content: text, or an image or sound (like Anki). */
const nonEmpty = (s: string) =>
  /<(img|audio|video|object|embed)\b|\[sound:/i.test(s) ||
  stripHtml(s).trim() !== '';

/** The template's HTML for the card. */
export function renderTemplate(template: string, ctx: TemplateContext): string {
  // Sections first, innermost first, so nesting works.
  let t = template;
  const section =
    /\{\{([#^])\s*([^}]+?)\s*\}\}((?:(?!\{\{[#^])[\s\S])*?)\{\{\/\s*\2\s*\}\}/;
  for (let guard = 0; guard < 1000; guard++) {
    const m = section.exec(t);
    if (!m) break;
    const [whole, kind, name, body] = m;
    // {{#c1}} on cloze cards: whether this is cloze 1.
    const clozeNum = /^c(\d+)$/.exec(name);
    const present = clozeNum
      ? Number(clozeNum[1]) === ctx.ord + 1
      : nonEmpty(fieldValue(name, ctx));
    const keep = kind === '#' ? present : !present;
    t =
      t.slice(0, m.index) +
      (keep ? body : '') +
      t.slice(m.index + whole.length);
  }
  const html = t.replace(/\{\{([^#^/{}][^{}]*?)\}\}/g, (_, inner: string) => {
    const parts = inner.split(':');
    const name = parts.pop()!.trim();
    let value = fieldValue(name, ctx);
    for (const filter of parts.reverse()) {
      value = applyFilter(filter, value, name, ctx);
    }
    return value;
  });
  return html.replace(
    /\[sound:([^\]]+)\]/g,
    (_, file: string) =>
      `<button type="button" class="g-sho-sound" data-sound="${escapeAttr(file)}" aria-label="Play">▶</button>`,
  );
}

/** Media files a card's HTML uses: images and sounds. */
export function mediaNames(html: string): string[] {
  const names = new Set<string>();
  for (const m of html.matchAll(/<img[^>]+src=["']?([^"' >]+)/gi))
    names.add(m[1]);
  for (const m of html.matchAll(/data-sound="([^"]+)"/g)) names.add(m[1]);
  return [...names]
    .map(n => n.replace(/&amp;/g, '&').replace(/&quot;/g, '"'))
    .filter(n => !/^(https?:|data:|blob:|\/\/)/i.test(n));
}
