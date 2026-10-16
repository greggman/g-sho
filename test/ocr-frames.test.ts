/** Choosing a sharp camera frame (src/client/ocr/frames.ts). */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sharpness} from '../src/client/ocr/frames.ts';

/** A w × h checkerboard (RGBA), box-blurred `blur` pixels each way. */
function board(w: number, h: number, blur: number) {
  const g = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) g[y * w + x] = ((x >> 3) + (y >> 3)) & 1;
  }
  const b = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = -blur; dy <= blur; dy++) {
        for (let dx = -blur; dx <= blur; dx++) {
          const yy = Math.min(h - 1, Math.max(0, y + dy));
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          sum += g[yy * w + xx];
          n++;
        }
      }
      b[y * w + x] = sum / n;
    }
  }
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    px.fill(Math.round(b[i] * 255), i * 4, i * 4 + 3);
    px[i * 4 + 3] = 255;
  }
  return px;
}

test('sharpness: blur lowers it, more blur more', () => {
  const [a, b, c] = [0, 1, 3].map(blur =>
    sharpness(board(64, 48, blur), 64, 48),
  );
  assert.ok(a > b && b > c, `${a} ${b} ${c}`);
  assert.equal(
    sharpness(new Uint8ClampedArray(64 * 48 * 4).fill(128), 64, 48),
    0,
  );
});
