/**
 * Reading text in a photo with PaddleOCR's two models, as RapidOCR does it
 * (its Python code was the reference, and the tests compare with it):
 *
 * 1. Detection: the photo, scaled down, goes through the detector, which
 *    gives each pixel's probability of being text. Thresholded, each
 *    connected region of text becomes a rotated rectangle (the smallest that
 *    holds it), grown a little (the detector marks text tightly).
 * 2. Recognition: each rectangle is cut out of the full-size photo and
 *    straightened (tall ones, vertical text, are turned on their side),
 *    scaled to the recognizer's height, and read. The recognizer gives a
 *    probability for every character at each step along the line; take the
 *    best at each step, merge repeats and drop blanks (CTC decoding).
 *
 * The models are run by whoever calls this (RunModel): the CPU engine in
 * tests, a worker in the app.
 */
import type {Tensor} from '../nn/graph.ts';

/** An image, as ImageData has it: RGBA, row by row. */
export interface Rgba {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

export type Point = [number, number];
/** A line's corners: top left, top right, bottom right, bottom left. */
export type Quad = [Point, Point, Point, Point];

export interface Line {
  box: Quad;
  text: string;
  /** mean probability of the characters read */
  score: number;
}

export type RunModel = (input: Tensor) => Tensor | Promise<Tensor>;

export const OPTIONS = {
  /** detection size: the short side scaled to this… */
  detSide: 736,
  /** …but the long side no more than this (RapidOCR allows 2000) */
  detMax: 960,
  /** a pixel is text above this probability */
  thresh: 0.3,
  /** a region is a line if its mean probability is above this */
  boxThresh: 0.5,
  /** how much to grow regions: by area * ratio / perimeter on each side */
  unclipRatio: 1.6,
  minSize: 3,
  maxCandidates: 1000,
  /** lines read with a lower mean probability are dropped */
  textScore: 0.5,
  recHeight: 48,
  /** lines narrower than this (at recHeight) are padded to it */
  recMinWidth: 320,
};

export type Options = typeof OPTIONS;

// ---------------------------------------------------------------------------
// Image helpers

/**
 * Scales an image to w × h: linear interpolation when enlarging, averaging
 * (a tent filter as wide as the scale) when shrinking. Returns RGB floats,
 * 0–255, interleaved.
 */
export function resize(img: Rgba, w: number, h: number): Float32Array {
  const {width: sw, height: sh, data} = img;
  // Rows first: sh rows of w pixels.
  const xs = taps(sw, w);
  const mid = new Float32Array(w * sh * 3);
  for (let y = 0; y < sh; y++) {
    const row = y * sw * 4;
    for (let x = 0; x < w; x++) {
      const {index, weight} = xs[x];
      let r = 0;
      let g = 0;
      let b = 0;
      for (let k = 0; k < index.length; k++) {
        const p = row + index[k] * 4;
        const wt = weight[k];
        r += data[p] * wt;
        g += data[p + 1] * wt;
        b += data[p + 2] * wt;
      }
      const o = (y * w + x) * 3;
      mid[o] = r;
      mid[o + 1] = g;
      mid[o + 2] = b;
    }
  }
  const ys = taps(sh, h);
  const out = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const {index, weight} = ys[y];
    for (let k = 0; k < index.length; k++) {
      const src = index[k] * w * 3;
      const wt = weight[k];
      const dst = y * w * 3;
      for (let i = 0; i < w * 3; i++) out[dst + i] += mid[src + i] * wt;
    }
  }
  return out;
}

/** For each of n outputs, the source pixels (of size) and their weights. */
function taps(size: number, n: number) {
  const scale = size / n;
  const support = Math.max(1, scale);
  const all = [];
  for (let i = 0; i < n; i++) {
    const c = (i + 0.5) * scale - 0.5;
    const index: number[] = [];
    const weight: number[] = [];
    let sum = 0;
    for (let j = Math.ceil(c - support); j <= Math.floor(c + support); j++) {
      const wt = 1 - Math.abs(j - c) / support;
      if (wt <= 0) continue;
      index.push(Math.min(size - 1, Math.max(0, j)));
      weight.push(wt);
      sum += wt;
    }
    all.push({index, weight: weight.map(wt => wt / sum)});
  }
  return all;
}

/**
 * RGB floats (w × h) to a model input, 1 × 3 × h × width: BGR order (the
 * models were trained on OpenCV's images), scaled to [-1, 1], zero beyond w.
 */
function toInput(rgb: Float32Array, w: number, h: number, width = w): Tensor {
  const data = new Float32Array(3 * h * width);
  const plane = h * width;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const o = y * width + x;
      data[o] = rgb[i + 2] / 127.5 - 1;
      data[plane + o] = rgb[i + 1] / 127.5 - 1;
      data[2 * plane + o] = rgb[i] / 127.5 - 1;
    }
  }
  return {shape: [1, 3, h, width], data};
}

/**
 * Cuts a quadrilateral out of an image, straightened to a rectangle the
 * size of its longer sides (bilinear sampling; edges repeat outward).
 */
export function cropQuad(img: Rgba, quad: Quad): Rgba {
  const [p0, p1, p2, p3] = quad;
  const w = Math.trunc(Math.max(dist(p0, p1), dist(p2, p3)));
  const h = Math.trunc(Math.max(dist(p0, p3), dist(p1, p2)));
  const out = new Uint8ClampedArray(Math.max(w, 1) * Math.max(h, 1) * 4);
  const map = squareToQuad(quad);
  const {width: sw, height: sh, data} = img;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [sx, sy] = map(x / w, y / h);
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      const cx0 = Math.min(sw - 1, Math.max(0, x0));
      const cx1 = Math.min(sw - 1, Math.max(0, x0 + 1));
      const cy0 = Math.min(sh - 1, Math.max(0, y0));
      const cy1 = Math.min(sh - 1, Math.max(0, y0 + 1));
      const a = (cy0 * sw + cx0) * 4;
      const b = (cy0 * sw + cx1) * 4;
      const c = (cy1 * sw + cx0) * 4;
      const d = (cy1 * sw + cx1) * 4;
      const o = (y * w + x) * 4;
      for (let k = 0; k < 3; k++) {
        const top = data[a + k] + (data[b + k] - data[a + k]) * fx;
        const bottom = data[c + k] + (data[d + k] - data[c + k]) * fx;
        out[o + k] = top + (bottom - top) * fy;
      }
      out[o + 3] = 255;
    }
  }
  return {width: w, height: h, data: out};
}

/** The projective map from the unit square onto a quad (corners in order). */
function squareToQuad([[x0, y0], [x1, y1], [x2, y2], [x3, y3]]: Quad) {
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const sx = x0 - x1 + x2 - x3;
  const sy = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = den ? (sx * dy2 - dx2 * sy) / den : 0;
  const h = den ? (dx1 * sy - sx * dy1) / den : 0;
  const a = x1 - x0 + g * x1;
  const b = x3 - x0 + h * x3;
  const d = y1 - y0 + g * y1;
  const e = y3 - y0 + h * y3;
  return (u: number, v: number): Point => {
    const z = g * u + h * v + 1;
    return [(a * u + b * v + x0) / z, (d * u + e * v + y0) / z];
  };
}

/** Turns an image a quarter turn counter-clockwise. */
export function rotateLeft(img: Rgba): Rgba {
  const {width: w, height: h, data} = img;
  const out = new Uint8ClampedArray(data.length);
  // New (x, y) is old (w - 1 - y, x); the new image is h wide.
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < h; x++) {
      const s = (x * w + (w - 1 - y)) * 4;
      const o = (y * h + x) * 4;
      out[o] = data[s];
      out[o + 1] = data[s + 1];
      out[o + 2] = data[s + 2];
      out[o + 3] = data[s + 3];
    }
  }
  return {width: h, height: w, data: out};
}

const dist = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// ---------------------------------------------------------------------------
// Detection

/** The detector's input size for an image: multiples of 32. */
export function detSize(w: number, h: number, opts = OPTIONS) {
  const scale = Math.min(
    opts.detSide / Math.min(w, h),
    opts.detMax / Math.max(w, h),
  );
  const round = (v: number) => Math.max(32, Math.round((v * scale) / 32) * 32);
  return {w: round(w), h: round(h)};
}

/** Finds the lines of text in an image, in reading order (rows). */
export async function detect(
  img: Rgba,
  det: RunModel,
  opts = OPTIONS,
): Promise<Quad[]> {
  const {w, h} = detSize(img.width, img.height, opts);
  const out = await det(toInput(resize(img, w, h), w, h));
  const boxes = boxesFromMap(out.data, w, h, opts).map(box =>
    box.map(([x, y]) => [
      clamp(Math.round((x / w) * img.width), 0, img.width),
      clamp(Math.round((y / h) * img.height), 0, img.height),
    ]),
  );
  const lines: Quad[] = [];
  for (const box of boxes) {
    const quad = orderClockwise(box as Point[]).map(([x, y]) => [
      Math.trunc(clamp(x, 0, img.width - 1)),
      Math.trunc(clamp(y, 0, img.height - 1)),
    ]) as Quad;
    if (
      Math.trunc(dist(quad[0], quad[1])) <= 3 ||
      Math.trunc(dist(quad[0], quad[3])) <= 3
    ) {
      continue;
    }
    lines.push(quad);
  }
  return readingOrder(lines);
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

/**
 * The detector's probability map (w × h) to boxes, in its coordinates
 * (RapidOCR's DBPostProcess).
 */
export function boxesFromMap(
  pred: Float32Array,
  w: number,
  h: number,
  opts = OPTIONS,
): Point[][] {
  // Text pixels, dilated by one pixel up and left (OpenCV's 2×2 kernel).
  const text = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const on = (xx: number, yy: number) =>
        xx >= 0 && yy >= 0 && pred[yy * w + xx] > opts.thresh;
      text[y * w + x] =
        on(x, y) || on(x - 1, y) || on(x, y - 1) || on(x - 1, y - 1) ? 1 : 0;
    }
  }
  const boxes: Point[][] = [];
  for (const points of regions(text, w, h).slice(0, opts.maxCandidates)) {
    const rect = minAreaRect(convexHull(points));
    if (Math.min(rect.w, rect.h) < opts.minSize) continue;
    const box = miniBox(rect);
    if (boxScore(pred, w, h, box) < opts.boxThresh) continue;
    // Growing a rectangle by d on every side (the rounded corners of
    // Clipper's offset don't change the smallest rectangle around it).
    const d = (rect.w * rect.h * opts.unclipRatio) / (2 * (rect.w + rect.h));
    const grown = {...rect, w: rect.w + 2 * d, h: rect.h + 2 * d};
    if (Math.min(grown.w, grown.h) < opts.minSize + 2) continue;
    boxes.push(miniBox(grown));
  }
  return boxes;
}

/**
 * The connected regions (8-neighbor) of a bitmap, each as the points on
 * its left and right edges row by row (enough for its convex hull).
 */
function regions(bits: Uint8Array, w: number, h: number): Point[][] {
  const seen = new Uint8Array(w * h);
  const out: Point[][] = [];
  const stack: number[] = [];
  for (let start = 0; start < w * h; start++) {
    if (!bits[start] || seen[start]) continue;
    const rows = new Map<number, [number, number]>();
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w;
      const y = (i - x) / w;
      const r = rows.get(y);
      if (!r) rows.set(y, [x, x]);
      else {
        if (x < r[0]) r[0] = x;
        if (x > r[1]) r[1] = x;
      }
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (bits[j] && !seen[j]) {
            seen[j] = 1;
            stack.push(j);
          }
        }
      }
    }
    const points: Point[] = [];
    for (const [y, [a, b]] of rows) {
      points.push([a, y]);
      if (b !== a) points.push([b, y]);
    }
    out.push(points);
  }
  return out;
}

/** Andrew's monotone chain; counter-clockwise (in y-up terms). */
export function convexHull(points: Point[]): Point[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: Point, a: Point, b: Point) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Point[] = [];
  for (const q of p) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0
    ) {
      lower.pop();
    }
    lower.push(q);
  }
  const upper: Point[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0
    ) {
      upper.pop();
    }
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** A rotated rectangle: center, side lengths, direction of the w side. */
export interface Rect {
  cx: number;
  cy: number;
  w: number;
  h: number;
  /** unit vector along w */
  ux: number;
  uy: number;
}

/** The smallest rectangle around a convex hull (one side lies on an edge). */
export function minAreaRect(hull: Point[]): Rect {
  if (hull.length === 0) return {cx: 0, cy: 0, w: 0, h: 0, ux: 1, uy: 0};
  if (hull.length === 1) {
    return {cx: hull[0][0], cy: hull[0][1], w: 0, h: 0, ux: 1, uy: 0};
  }
  let best: Rect | undefined;
  let bestArea = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const len = dist(a, b);
    if (!len) continue;
    const ux = (b[0] - a[0]) / len;
    const uy = (b[1] - a[1]) / len;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const [x, y] of hull) {
      const u = x * ux + y * uy;
      const v = -x * uy + y * ux;
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area < bestArea) {
      bestArea = area;
      const cu = (minU + maxU) / 2;
      const cv = (minV + maxV) / 2;
      best = {
        cx: cu * ux - cv * uy,
        cy: cu * uy + cv * ux,
        w: maxU - minU,
        h: maxV - minV,
        ux,
        uy,
      };
    }
  }
  return best!;
}

/** A rectangle's corners in RapidOCR's get_mini_boxes order. */
function miniBox(r: Rect): Point[] {
  const hw = r.w / 2;
  const hh = r.h / 2;
  const corner = (su: number, sv: number): Point => [
    r.cx + su * hw * r.ux - sv * hh * r.uy,
    r.cy + su * hw * r.uy + sv * hh * r.ux,
  ];
  const p = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)].sort(
    (a, b) => a[0] - b[0],
  );
  const [i1, i4] = p[1][1] > p[0][1] ? [0, 1] : [1, 0];
  const [i2, i3] = p[3][1] > p[2][1] ? [2, 3] : [3, 2];
  return [p[i1], p[i2], p[i3], p[i4]];
}

/** Mean probability inside a box (corners truncated, as OpenCV fills). */
function boxScore(pred: Float32Array, w: number, h: number, box: Point[]) {
  const q = box.map(([x, y]) => [Math.trunc(x), Math.trunc(y)] as Point);
  const x0 = clamp(Math.floor(Math.min(...box.map(p => p[0]))), 0, w - 1);
  const x1 = clamp(Math.ceil(Math.max(...box.map(p => p[0]))), 0, w - 1);
  const y0 = clamp(Math.floor(Math.min(...box.map(p => p[1]))), 0, h - 1);
  const y1 = clamp(Math.ceil(Math.max(...box.map(p => p[1]))), 0, h - 1);
  let sum = 0;
  let n = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (inConvex(q, x, y)) {
        sum += pred[y * w + x];
        n++;
      }
    }
  }
  return n ? sum / n : 0;
}

/** Whether a point is inside (or on) a convex polygon, either winding. */
function inConvex(poly: Point[], x: number, y: number): boolean {
  let pos = false;
  let neg = false;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[(i + 1) % poly.length];
    const c = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (c > 1e-9) pos = true;
    else if (c < -1e-9) neg = true;
    if (pos && neg) return false;
  }
  return true;
}

/** Top left, top right, bottom right, bottom left (by x, then y). */
function orderClockwise(pts: Point[]): Point[] {
  const byX = [...pts].sort((a, b) => a[0] - b[0]);
  const [tl, bl] = byX.slice(0, 2).sort((a, b) => a[1] - b[1]);
  const [tr, br] = byX.slice(2).sort((a, b) => a[1] - b[1]);
  return [tl, tr, br, bl];
}

/** Top to bottom; lines at about the same height, left to right. */
function readingOrder(lines: Quad[]): Quad[] {
  const out = [...lines].sort((a, b) => a[0][1] - b[0][1] || a[0][0] - b[0][0]);
  for (let i = 0; i < out.length - 1; i++) {
    for (let j = i; j >= 0; j--) {
      const [a, b] = [out[j], out[j + 1]];
      if (Math.abs(b[0][1] - a[0][1]) < 10 && b[0][0] < a[0][0]) {
        out[j] = b;
        out[j + 1] = a;
      } else break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Recognition

/** The recognizer's input for one line (already cut out and straightened). */
export function recInput(line: Rgba, opts = OPTIONS): Tensor {
  const h = opts.recHeight;
  const ratio = line.width / line.height;
  const width = Math.trunc(h * Math.max(opts.recMinWidth / h, ratio));
  const w = Math.min(Math.ceil(h * ratio), width);
  return toInput(resize(line, w, h), w, h, width);
}

/**
 * CTC decoding: the best character at each step; repeats merged, blanks
 * (class 0) dropped. Classes are blank, the dictionary, then a space.
 */
export function ctcDecode(
  probs: Tensor,
  dict: string[],
): {text: string; score: number} {
  const [, steps, classes] = probs.shape;
  let text = '';
  let sum = 0;
  let n = 0;
  let last = -1;
  for (let t = 0; t < steps; t++) {
    const row = t * classes;
    let best = 0;
    for (let c = 1; c < classes; c++) {
      if (probs.data[row + c] > probs.data[row + best]) best = c;
    }
    if (best !== 0 && best !== last) {
      text += best <= dict.length ? dict[best - 1] : ' ';
      sum += probs.data[row + best];
      n++;
    }
    last = best;
  }
  return {text, score: n ? sum / n : 0};
}

/** Reads one line of text inside a quad of the image. */
export async function readLine(
  img: Rgba,
  quad: Quad,
  rec: RunModel,
  dict: string[],
  opts = OPTIONS,
): Promise<{text: string; score: number}> {
  let crop = cropQuad(img, quad);
  if (crop.width < 1 || crop.height < 1) return {text: '', score: 0};
  if (crop.height / crop.width >= 1.5) crop = rotateLeft(crop);
  return ctcDecode(await rec(recInput(crop, opts)), dict);
}

/** Every line of text in an image. */
export async function readText(
  img: Rgba,
  det: RunModel,
  rec: RunModel,
  dict: string[],
  opts = OPTIONS,
): Promise<Line[]> {
  const lines: Line[] = [];
  for (const box of await detect(img, det, opts)) {
    const {text, score} = await readLine(img, box, rec, dict, opts);
    if (text && score >= opts.textScore) lines.push({box, text, score});
  }
  return lines;
}
