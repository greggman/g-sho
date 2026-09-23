/**
 * Romaji → hiragana conversion. Accepts Hepburn (shi, chi, tsu, fu, ja),
 * Kunrei/wāpuro (si, ti, tu, hu, zya) and common IME spellings
 * (xtu, ltu, nn, n').
 */

// prettier-ignore
const TABLE: Record<string, string> = {
  a: 'あ', i: 'い', u: 'う', e: 'え', o: 'お',
  ka: 'か', ki: 'き', ku: 'く', ke: 'け', ko: 'こ',
  ga: 'が', gi: 'ぎ', gu: 'ぐ', ge: 'げ', go: 'ご',
  sa: 'さ', si: 'し', shi: 'し', su: 'す', se: 'せ', so: 'そ',
  za: 'ざ', zi: 'じ', ji: 'じ', zu: 'ず', ze: 'ぜ', zo: 'ぞ',
  ta: 'た', ti: 'ち', chi: 'ち', tu: 'つ', tsu: 'つ', te: 'て', to: 'と',
  da: 'だ', di: 'ぢ', du: 'づ', de: 'で', do: 'ど',
  na: 'な', ni: 'に', nu: 'ぬ', ne: 'ね', no: 'の',
  ha: 'は', hi: 'ひ', hu: 'ふ', fu: 'ふ', he: 'へ', ho: 'ほ',
  ba: 'ば', bi: 'び', bu: 'ぶ', be: 'べ', bo: 'ぼ',
  pa: 'ぱ', pi: 'ぴ', pu: 'ぷ', pe: 'ぺ', po: 'ぽ',
  ma: 'ま', mi: 'み', mu: 'む', me: 'め', mo: 'も',
  ya: 'や', yu: 'ゆ', yo: 'よ',
  ra: 'ら', ri: 'り', ru: 'る', re: 'れ', ro: 'ろ',
  la: 'ら', li: 'り', lu: 'る', le: 'れ', lo: 'ろ',
  wa: 'わ', wi: 'うぃ', we: 'うぇ', wo: 'を',
  nn: 'ん', "n'": 'ん',
  kya: 'きゃ', kyu: 'きゅ', kyo: 'きょ',
  gya: 'ぎゃ', gyu: 'ぎゅ', gyo: 'ぎょ',
  sha: 'しゃ', shu: 'しゅ', sho: 'しょ', she: 'しぇ',
  sya: 'しゃ', syu: 'しゅ', syo: 'しょ',
  ja: 'じゃ', ju: 'じゅ', jo: 'じょ', je: 'じぇ',
  jya: 'じゃ', jyu: 'じゅ', jyo: 'じょ',
  zya: 'じゃ', zyu: 'じゅ', zyo: 'じょ',
  cha: 'ちゃ', chu: 'ちゅ', cho: 'ちょ', che: 'ちぇ',
  tya: 'ちゃ', tyu: 'ちゅ', tyo: 'ちょ',
  cya: 'ちゃ', cyu: 'ちゅ', cyo: 'ちょ',
  dya: 'ぢゃ', dyu: 'ぢゅ', dyo: 'ぢょ',
  nya: 'にゃ', nyu: 'にゅ', nyo: 'にょ',
  hya: 'ひゃ', hyu: 'ひゅ', hyo: 'ひょ',
  bya: 'びゃ', byu: 'びゅ', byo: 'びょ',
  pya: 'ぴゃ', pyu: 'ぴゅ', pyo: 'ぴょ',
  mya: 'みゃ', myu: 'みゅ', myo: 'みょ',
  rya: 'りゃ', ryu: 'りゅ', ryo: 'りょ',
  fa: 'ふぁ', fi: 'ふぃ', fe: 'ふぇ', fo: 'ふぉ',
  thi: 'てぃ', dhi: 'でぃ', twu: 'とぅ', dwu: 'どぅ',
  va: 'ゔぁ', vi: 'ゔぃ', vu: 'ゔ', ve: 'ゔぇ', vo: 'ゔぉ',
  tsa: 'つぁ', tsi: 'つぃ', tse: 'つぇ', tso: 'つぉ',
  xa: 'ぁ', xi: 'ぃ', xu: 'ぅ', xe: 'ぇ', xo: 'ぉ',
  xya: 'ゃ', xyu: 'ゅ', xyo: 'ょ', xtu: 'っ', xtsu: 'っ', xwa: 'ゎ',
  ltu: 'っ', ltsu: 'っ', lya: 'ゃ', lyu: 'ゅ', lyo: 'ょ',
  '-': 'ー',
};

const MAX_KEY = 4;
const VOWELS = new Set(['a', 'i', 'u', 'e', 'o']);

function isVowelOrY(c: string | undefined): boolean {
  return c !== undefined && (VOWELS.has(c) || c === 'y');
}

/**
 * Converts romaji to hiragana. Returns undefined if the input can't be read
 * as romaji (so "hello" → undefined, since "ll" and a trailing "l" aren't kana).
 */
export function romajiToKana(input: string): string | undefined {
  const s = input.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
  if (!/^[a-z'-]+$/.test(s)) return undefined;
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const next = s[i + 1];
    // Doubled consonant → small っ ("kitte" → きって, "matcha" → まっちゃ).
    if (
      next !== undefined &&
      c !== 'n' &&
      !VOWELS.has(c) &&
      /[a-z]/.test(c) &&
      (c === next || (c === 't' && next === 'c'))
    ) {
      out += 'っ';
      i++;
      continue;
    }
    // "n" not followed by a vowel or "y" is ん ("kanji" → かんじ).
    if (
      c === 'n' &&
      (next === undefined ||
        (!VOWELS.has(next) && next !== 'y' && next !== 'n' && next !== "'"))
    ) {
      out += 'ん';
      i++;
      continue;
    }
    // "nn" before a vowel is ん plus an n-syllable ("konnichiha" → こんにちは);
    // elsewhere it's just ん ("hon'ya", "kinnnen").
    if (c === 'n' && next === 'n' && isVowelOrY(s[i + 2])) {
      out += 'ん';
      i++;
      continue;
    }
    let matched = false;
    for (let len = Math.min(MAX_KEY, s.length - i); len > 0; len--) {
      const kana = TABLE[s.slice(i, i + len)];
      if (kana) {
        out += kana;
        i += len;
        matched = true;
        break;
      }
    }
    if (!matched) return undefined;
  }
  return out;
}
