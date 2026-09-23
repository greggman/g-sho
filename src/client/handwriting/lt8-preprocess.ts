/**
 * The LT8 model's preprocessing, which its ONNX graph does in-graph and we
 * do here instead (see ml/lt8_reference.py, which checks this algorithm
 * against the real graph):
 *
 * 1. Make ink bright: if the median pixel is lighter than the midpoint of the
 *    darkest and lightest pixels, invert.
 * 2. Stretch contrast between the 50th and 99.9th percentile pixels, clamp to [0, 1].
 * 3. Threshold at 0.3 and clean the mask with a 3×3 erode then dilate.
 * 4. Take the mask's bounding box (the raw mask's if cleaning erased it), pad
 *    it by 2px, and make it a square 1.16× its longer side.
 * 5. Bilinearly sample that square to 96×96.
 */

export const SOURCE_SIZE = 128;
export const OUTPUT_SIZE = 96;

const N = SOURCE_SIZE;

function erodeOrDilate(mask: Uint8Array, dilate: boolean): Uint8Array {
  const out = new Uint8Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      // Out-of-bounds neighbors are ignored, like max pooling with padding.
      let v = dilate ? 0 : 1;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= N) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= N) continue;
          const m = mask[yy * N + xx];
          v = dilate ? v | m : v & m;
        }
      }
      out[y * N + x] = v;
    }
  }
  return out;
}

type Box = [x0: number, x1: number, y0: number, y1: number];

function boundingBox(mask: Uint8Array): Box | undefined {
  let x0 = N;
  let x1 = -1;
  let y0 = N;
  let y1 = -1;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (!mask[y * N + x]) continue;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  }
  return x1 < 0 ? undefined : [x0, x1, y0, y1];
}

/** 128×128 luminance (0–255) → 96×96 model input in [0, 1], ink bright. */
export function preprocess(pixels: Float32Array): Float32Array {
  const sorted = Float32Array.from(pixels).sort();
  const mn = sorted[0];
  const mx = sorted[sorted.length - 1];
  const x =
    sorted[8192] > (mn + mx) * 0.5 ? pixels.map(p => mn + mx - p) : pixels;

  const sorted2 = Float32Array.from(x).sort();
  const lo = sorted2[8191];
  // 1049 / 2^20 is 0.001 rounded to fp16, as in the graph.
  const range = Math.max(sorted2[16366] - lo, 1049 / 2 ** 20);
  const norm = x.map(p => Math.min(1, Math.max(0, (p - lo) / range)));

  const mask = new Uint8Array(N * N);
  for (let i = 0; i < mask.length; i++)
    mask[i] = norm[i] > 0.300048828125 ? 1 : 0;
  const opened = erodeOrDilate(erodeOrDilate(mask, false), true);
  const box = boundingBox(opened) ??
    boundingBox(mask) ?? [10000, -10000, 10000, -10000];
  const clamp = (v: number) => Math.min(N - 1, Math.max(0, v));
  const x0 = clamp(box[0] - 2);
  const x1 = clamp(box[1] + 2);
  const y0 = clamp(box[2] - 2);
  const y1 = clamp(box[3] + 2);

  const cx = (x0 + x1) * 0.5;
  const cy = (y0 + y1) * 0.5;
  const scale = (Math.max(x1 - x0 + 1, y1 - y0 + 1) * 1.16015625) / N;
  const tx = (cx * 2 + 1) / N - 1;
  const ty = (cy * 2 + 1) / N - 1;

  // affine_grid (align_corners=false) then bilinear grid_sample, zero padding.
  const at = (yy: number, xx: number) =>
    xx >= 0 && xx < N && yy >= 0 && yy < N ? norm[yy * N + xx] : 0;
  const out = new Float32Array(OUTPUT_SIZE * OUTPUT_SIZE);
  for (let j = 0; j < OUTPUT_SIZE; j++) {
    const gy = scale * ((2 * j + 1) / OUTPUT_SIZE - 1) + ty;
    const iy = ((gy + 1) * N - 1) / 2;
    const iy0 = Math.floor(iy);
    const fy = iy - iy0;
    for (let i = 0; i < OUTPUT_SIZE; i++) {
      const gx = scale * ((2 * i + 1) / OUTPUT_SIZE - 1) + tx;
      const ix = ((gx + 1) * N - 1) / 2;
      const ix0 = Math.floor(ix);
      const fx = ix - ix0;
      out[j * OUTPUT_SIZE + i] =
        (1 - fx) * (1 - fy) * at(iy0, ix0) +
        fx * (1 - fy) * at(iy0, ix0 + 1) +
        (1 - fx) * fy * at(iy0 + 1, ix0) +
        fx * fy * at(iy0 + 1, ix0 + 1);
    }
  }
  return out;
}
