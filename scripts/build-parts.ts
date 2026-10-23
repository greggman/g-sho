/**
 * What each kanji part (KRADFILE component) means, for the kanji panel:
 * 騒 is 馬 horse + 虫 insect + 又 hand + 丶 dot. Built into data/parts.json.
 *
 * KRADFILE writes some radical forms with a stand-in kanji (化 for 亻, 汁
 * for 氵, …): those are shown as the real form. The radical forms, and
 * parts whose dictionary meaning doesn't say what they mean as a part
 * (厂 "wild goose" is the cliff radical), have names here: English, and
 * the Japanese radical name (にんべん). Other parts take their first
 * KANJIDIC meaning, and in Japanese their kun reading (うま, むし).
 */
import type {PartInfo} from '../src/shared/types.ts';

/** KRADFILE's stand-ins → the radical form they stand for. */
const STAND_INS: Record<string, string> = {
  化: '亻',
  并: '丷',
  刈: '刂',
  込: '辶',
  尚: '⺌',
  忙: '忄',
  扎: '扌',
  汁: '氵',
  犯: '犭',
  艾: '艹',
  邦: '阝',
  阡: '阝',
  老: '耂',
  杰: '灬',
  礼: '礻',
  疔: '疒',
  禹: '禸',
  初: '衤',
  買: '罒',
  滴: '啇',
};

/**
 * Parts named by hand: [English, Japanese radical name], by the form shown
 * or (for 阝, which is two radicals) by KRADFILE's character. 个 and 乞
 * stand for 𠆢 and 𠂉, which few fonts have, so they're shown as they are.
 */
const NAMES: Record<string, [string, string]> = {
  亻: ['person', 'にんべん'],
  个: ['person (roof)', 'ひとやね'],
  丷: ['eight (horns)', 'はち'],
  刂: ['knife', 'りっとう'],
  辶: ['walk, road', 'しんにょう'],
  '⺌': ['small', 'しょう'],
  忄: ['heart', 'りっしんべん'],
  扌: ['hand', 'てへん'],
  氵: ['water', 'さんずい'],
  犭: ['animal, dog', 'けものへん'],
  艹: ['grass, plant', 'くさかんむり'],
  邦: ['village', 'おおざと'],
  阡: ['hill', 'こざとへん'],
  耂: ['old', 'おいかんむり'],
  灬: ['fire', 'れんが'],
  礻: ['altar, spirit', 'しめすへん'],
  疒: ['sickness', 'やまいだれ'],
  禸: ['track', 'ぐうのあし'],
  衤: ['clothing', 'ころもへん'],
  罒: ['net', 'あみがしら'],
  啇: ['root', 'てき'],
  乞: ['hook top (as in 年, 毎)', '年・毎の上'],
  ノ: ['slash', 'の'],
  '｜': ['line', 'ぼう'],
  丶: ['dot', 'てん'],
  ハ: ['eight', 'はち'],
  ヨ: ['snout', 'けいがしら'],
  マ: ['katakana ma shape', 'ま'],
  ユ: ['katakana yu shape', 'ゆ'],
  亠: ['lid', 'なべぶた'],
  冂: ['upside-down box', 'どうがまえ'],
  儿: ['legs', 'ひとあし'],
  幺: ['short thread', 'いとがしら'],
  冖: ['cover', 'わかんむり'],
  宀: ['roof', 'うかんむり'],
  冫: ['ice', 'にすい'],
  禾: ['grain', 'のぎへん'],
  广: ['dotted cliff, building', 'まだれ'],
  匚: ['box', 'はこがまえ'],
  卩: ['seal', 'ふしづくり'],
  爿: ['split wood', 'しょうへん'],
  巛: ['river', 'まがりがわ'],
  廴: ['long stride', 'えんにょう'],
  尢: ['lame', 'だいのまげあし'],
  舛: ['opposite feet', 'まいあし'],
  韋: ['tanned leather', 'なめしがわ'],
  癶: ['footsteps', 'はつがしら'],
  彑: ['snout', 'けいがしら'],
  韭: ['leek', 'にら'],
  鬥: ['fight', 'とうがまえ'],
  黹: ['embroidery', 'ふつ'],
  厂: ['cliff', 'がんだれ'],
  勹: ['wrap', 'つつみがまえ'],
  彡: ['hair, stripes', 'さんづくり'],
  亅: ['hook', 'はねぼう'],
  廾: ['two hands', 'にじゅうあし'],
  夂: ['go slowly', 'ふゆがしら'],
  攵: ['strike', 'ぼくづくり'],
  彳: ['step', 'ぎょうにんべん'],
  囗: ['enclosure', 'くにがまえ'],
  凵: ['open box', 'うけばこ'],
  几: ['table', 'つくえ'],
  弋: ['ceremony', 'しきがまえ'],
  戈: ['halberd', 'ほこづくり'],
  殳: ['weapon', 'るまた'],
  欠: ['yawn, lack', 'あくび'],
  歹: ['death', 'がつへん'],
  隹: ['old bird', 'ふるとり'],
  頁: ['head', 'おおがい'],
  疋: ['foot, bolt of cloth', 'ひき'],
  虍: ['tiger', 'とらがしら'],
  豸: ['badger', 'むじなへん'],
  髟: ['long hair', 'かみがしら'],
  鬯: ['herbs', 'ちょう'],
  隶: ['slave', 'れいづくり'],
  卜: ['divination', 'ぼく'],
  又: ['right hand', 'また'],
  厶: ['private', 'む'],
  匕: ['spoon', 'さじ'],
  寸: ['inch', 'すん'],
  斤: ['axe', 'おの'],
  酉: ['wine jar', 'ひよみのとり'],
  气: ['steam', 'きがまえ'],
  斗: ['dipper', 'とます'],
  曰: ['say', 'ひらび'],
  巾: ['cloth', 'はば'],
  士: ['scholar', 'さむらい'],
  工: ['craft', 'たくみ'],
  比: ['compare', 'くらべる'],
  艮: ['stopping', 'こんづくり'],
  而: ['beard', 'しこうして'],
  臣: ['retainer', 'しん'],
  豕: ['pig', 'いのこ'],
  缶: ['can, jar', 'ほとぎ'],
  屮: ['sprout', 'てつ'],
  爻: ['crossed lines', 'こう'],
  釆: ['separate', 'のごめ'],
  耒: ['plough', 'すきへん'],
  鬲: ['tripod', 'かなえ'],
  黽: ['frog', 'べん'],
  无: ['nothing', 'なし'],
  毋: ['do not', 'なかれ'],
  也: ['also', 'なり'],
  乃: ['from', 'の'],
  王: ['king, jewel', 'おう'],
  一: ['one', 'いち'],
  二: ['two', 'に'],
  十: ['ten', 'じゅう'],
  九: ['nine', 'きゅう'],
  五: ['five', 'ご'],
  大: ['big', 'だい'],
  小: ['small', 'しょう'],
  巨: ['big', 'きょ'],
};

/**
 * The kanji a radical form comes from, to look it up: 氵 is a form of 水.
 * By the form shown, or (阝, 个) by KRADFILE's character.
 */
const SOURCES: Record<string, string> = {
  亻: '人',
  个: '人',
  丷: '八',
  刂: '刀',
  辶: '辵',
  '⺌': '小',
  忄: '心',
  扌: '手',
  氵: '水',
  犭: '犬',
  艹: '艸',
  邦: '邑',
  阡: '阜',
  耂: '老',
  灬: '火',
  礻: '示',
  衤: '衣',
  罒: '网',
};

/**
 * What a part contains, as KRADFILE lists it: its own parts. A stand-in is
 * its radical form, which contains nothing (化 for 亻 doesn't contain 匕),
 * except 乞 for 𠂉, which is ノ and 一.
 */
function contains(krad: Record<string, string[]>, part: string): string[] {
  if (part === '乞') return ['ノ', '一'];
  if (STAND_INS[part]) return [];
  return (krad[part] ?? []).filter(p => p !== part);
}

/**
 * Shapes so alike that KRADFILE lists both for a kanji that has one, so it
 * can be found by either (数 has 攵, 冬 has 夂; both list both).
 */
const LOOKALIKES: [string, string][] = [
  ['攵', '夂'],
  ['口', '囗'],
  ['毋', '母'],
];

/**
 * A kanji's top-level parts: KRADFILE lists every shape you might look a
 * kanji up by, including the ones inside other parts (故: 口 十 攵, and 乞,
 * the top of 攵). Those are left out: 故 is 口, 十 and 攵. Of two
 * lookalikes, the one the kanji has (`elements`: its KanjiVG components)
 * is kept.
 */
export function topLevelParts(
  krad: Record<string, string[]>,
  parts: string[],
  elements?: Set<string>,
): string[] {
  let kept = parts;
  for (const [a, b] of LOOKALIKES) {
    if (!kept.includes(a) || !kept.includes(b) || !elements) continue;
    if (elements.has(a) && !elements.has(b)) kept = kept.filter(p => p !== b);
    if (elements.has(b) && !elements.has(a)) kept = kept.filter(p => p !== a);
  }
  // A part inside another listed part; not when each "contains" the other.
  const inside = new Set(
    kept.flatMap(p =>
      contains(krad, p).filter(
        q => kept.includes(q) && !contains(krad, q).includes(p),
      ),
    ),
  );
  return kept.filter(p => !inside.has(p));
}

/** The components KanjiVG records anywhere in a kanji (kvg:element). */
export function kanjiVgElements(svg: string): Set<string> {
  return new Set([...svg.matchAll(/kvg:element="([^"]+)"/g)].map(m => m[1]));
}

interface KanjidicChar {
  literal: string;
  readingMeaning?: null | {
    groups?: {
      meanings?: {lang: string; value: string}[];
      readings?: {type: string; value: string}[];
    }[];
  };
}

/** A part's first meaning, without "radical", "katakana …" or a second sense. */
function meaningOf(c: KanjidicChar | undefined): string | undefined {
  return c?.readingMeaning?.groups?.[0]?.meanings
    ?.filter(m => m.lang === 'en')
    .map(m => m.value)
    .find(m => !/radical|katakana|^kana /i.test(m));
}

/** A part's kun reading, whole, without its marks (うま, むし, なかれ). */
function kunOf(c: KanjidicChar | undefined): string | undefined {
  const kun = c?.readingMeaning?.groups?.[0]?.readings?.find(
    r => r.type === 'ja_kun',
  )?.value;
  return kun?.replace(/[.-]/g, '') || undefined;
}

/** Every part's form, meaning and Japanese name. */
export function buildParts(
  krad: Record<string, string[]>,
  characters: KanjidicChar[],
): Record<string, PartInfo> {
  const byChar = new Map(characters.map(c => [c.literal, c]));
  const parts = new Set(Object.values(krad).flat());
  const out: Record<string, PartInfo> = {};
  for (const part of parts) {
    const form = STAND_INS[part] ?? part;
    const named = NAMES[part] ?? NAMES[form];
    const c = byChar.get(part);
    const en = named?.[0] ?? meaningOf(c);
    const ja = named?.[1] ?? kunOf(c);
    const info: PartInfo = {};
    if (form !== part) info.f = form;
    const source = SOURCES[part] ?? SOURCES[form];
    if (source) info.s = source;
    if (en) info.en = en;
    if (ja) info.ja = ja;
    out[part] = info;
  }
  return out;
}
