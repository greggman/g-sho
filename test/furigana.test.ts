import assert from 'node:assert/strict';
import {test} from 'node:test';
import {highlightParts} from '../src/client/render.ts';
import {parseFurigana, plainText} from '../src/shared/furigana.ts';

test('parses readings, one per group', () => {
  assert.deepEqual(parseFurigana('[世界|せ|かい]に[行|い]く[今日|きょう]'), [
    ['世界', 'せかい'],
    ['に'],
    ['行', 'い'],
    ['く'],
    ['今日', 'きょう'],
  ]);
});

test('plain text round-trips', () => {
  const markup =
    '[世界|せ|かい][的|てき]に[過大|か|だい]に[評価|ひょう|か]された[中国|ちゅう|ごく][書|しょ]といえば、『[孫子|まご|こ]』ですかね。';
  assert.equal(
    plainText(parseFurigana(markup)),
    '世界的に過大に評価された中国書といえば、『孫子』ですかね。',
  );
});

test('highlight cuts plain text and keeps readings whole', () => {
  // もっと[果物|くだ|もの]を[食|た]べるべきです。 highlighting 食べる (6..9)
  const parts = parseFurigana('もっと[果物|くだ|もの]を[食|た]べるべきです。');
  const marked = highlightParts(parts, 6, 9)
    .filter(([, m]) => m)
    .map(([p]) => p);
  assert.deepEqual(marked, [['食', 'た'], ['べる']]);
});
