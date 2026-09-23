const HIRAGANA_START = 0x3041;
const HIRAGANA_END = 0x3096;
const KATAKANA_START = 0x30a1;
const KATAKANA_END = 0x30f6;
const KANA_OFFSET = KATAKANA_START - HIRAGANA_START;

export function isHiragana(ch: string): boolean {
  const c = ch.codePointAt(0)!;
  return (
    (c >= HIRAGANA_START && c <= HIRAGANA_END) || c === 0x309d || c === 0x309e
  );
}

export function isKatakana(ch: string): boolean {
  const c = ch.codePointAt(0)!;
  return (c >= KATAKANA_START && c <= 0x30fa) || c === 0x30fd || c === 0x30fe;
}

/** Hiragana, katakana, or the prolonged sound mark ー. */
export function isKana(ch: string): boolean {
  return isHiragana(ch) || isKatakana(ch) || ch === 'ー';
}

export function isKanji(ch: string): boolean {
  const c = ch.codePointAt(0)!;
  return (
    (c >= 0x4e00 && c <= 0x9fff) || // CJK unified ideographs
    (c >= 0x3400 && c <= 0x4dbf) || // extension A
    (c >= 0x20000 && c <= 0x2ebef) || // extensions B-F
    (c >= 0xf900 && c <= 0xfaff) || // compatibility ideographs
    c === 0x3005 // 々
  );
}

/** True if the character is Japanese script (kana, kanji, or Japanese punctuation). */
export function isJapanese(ch: string): boolean {
  const c = ch.codePointAt(0)!;
  return isKana(ch) || isKanji(ch) || (c >= 0x3000 && c <= 0x303f);
}

export function hasJapanese(s: string): boolean {
  for (const ch of s) {
    if (isJapanese(ch)) return true;
  }
  return false;
}

export function isAllKana(s: string): boolean {
  for (const ch of s) {
    if (!isKana(ch)) return false;
  }
  return s.length > 0;
}

export function toHiragana(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    out +=
      c >= KATAKANA_START && c <= KATAKANA_END
        ? String.fromCodePoint(c - KANA_OFFSET)
        : ch;
  }
  return out;
}

export function toKatakana(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    out +=
      c >= HIRAGANA_START && c <= HIRAGANA_END
        ? String.fromCodePoint(c + KANA_OFFSET)
        : ch;
  }
  return out;
}
