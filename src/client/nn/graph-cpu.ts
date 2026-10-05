/**
 * Runs a graph (graph.ts) in plain JavaScript, with ONNX's semantics for
 * each operator. Straightforward rather than fast: it's the reference the
 * faster engines are tested against. Integer tensors (shapes, axes) are
 * computed here too, in every engine.
 */
import {
  isInt,
  sizeOf,
  type AttrValue,
  type Graph,
  type GraphNode,
  type IntTensor,
  type Tensor,
  type Value,
} from './graph.ts';

export const strides = (shape: number[]) => {
  const s = new Array<number>(shape.length);
  let n = 1;
  for (let i = shape.length - 1; i >= 0; i--) {
    s[i] = n;
    n *= shape[i];
  }
  return s;
};

export const axis = (a: number, rank: number) => (a < 0 ? a + rank : a);

export function attr<T extends AttrValue>(
  node: GraphNode,
  name: string,
  fallback: T,
): T {
  return (node.attrs?.[name] as T | undefined) ?? fallback;
}

/**
 * The error function, accurate to ~1.2e-7 everywhere (Numerical Recipes'
 * erfc approximation, via Chebyshev fitting). Needed for GELU.
 */
export function erf(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const erfc =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t *
                              (-1.13520398 +
                                t *
                                  (1.48851587 +
                                    t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? 1 - erfc : erfc - 1;
}

/** The shape two shapes broadcast to (numpy rules). */
export function broadcastShape(a: number[], b: number[]): number[] {
  const rank = Math.max(a.length, b.length);
  const out: number[] = [];
  for (let i = 0; i < rank; i++) {
    const x = a[a.length - rank + i] ?? 1;
    const y = b[b.length - rank + i] ?? 1;
    if (x !== y && x !== 1 && y !== 1) {
      throw new Error(`can't broadcast [${a}] and [${b}]`);
    }
    out.push(Math.max(x, y));
  }
  return out;
}

/** For each output index, the input's index under broadcasting. */
function broadcastIndex(from: number[], to: number[]): Int32Array {
  const n = sizeOf(to);
  const out = new Int32Array(n);
  const rank = to.length;
  const fs = strides(from);
  const padded = new Array(rank).fill(1);
  const pstr = new Array(rank).fill(0);
  for (let i = 0; i < from.length; i++) {
    padded[rank - from.length + i] = from[i];
    pstr[rank - from.length + i] = fs[i];
  }
  const ts = strides(to);
  for (let i = 0; i < n; i++) {
    let rem = i;
    let idx = 0;
    for (let d = 0; d < rank; d++) {
      const c = Math.floor(rem / ts[d]);
      rem -= c * ts[d];
      if (padded[d] !== 1) idx += c * pstr[d];
    }
    out[i] = idx;
  }
  return out;
}

/**
 * If broadcasting `from` to `to` repeats a block of values (e.g. one per
 * channel), the block's size and how many times each value repeats:
 * index = floor(i / inner) % count.
 */
function repeatPattern(from: number[], to: number[]) {
  const padded = [...new Array(to.length - from.length).fill(1), ...from];
  const kept = padded.flatMap((d, i) => (d === 1 ? [] : [i]));
  if (!kept.length) return {count: 1, inner: sizeOf(to)}; // one value
  const first = kept[0];
  const last = kept[kept.length - 1];
  for (let i = first; i <= last; i++) if (padded[i] !== to[i]) return null;
  return {
    count: sizeOf(to.slice(first, last + 1)),
    inner: sizeOf(to.slice(last + 1)),
  };
}

type BinaryOp = 'Add' | 'Sub' | 'Mul' | 'Div' | 'Pow';

/** One of the arithmetic ops, without a call per element. */
function binaryOp(op: BinaryOp, a: Tensor, b: Tensor): Tensor {
  const shape = broadcastShape(a.shape, b.shape);
  const n = sizeOf(shape);
  const full = (t: Tensor) => t.data.length === n;
  const pa = full(a) ? null : repeatPattern(a.shape, shape);
  const pb = full(b) ? null : repeatPattern(b.shape, shape);
  if (op === 'Pow' || (!full(a) && !pa) || (!full(b) && !pb) || (pa && pb)) {
    return binary(a, b, BINARY[op]);
  }
  // At most one side repeats; run over its blocks.
  const out = new Float32Array(n);
  const ad = a.data;
  const bd = b.data;
  const pat = pa ?? pb ?? {count: 1, inner: n};
  const {count, inner} = pat;
  const repeated = !!(pa || pb);
  for (let base = 0; base < n; base += count * inner) {
    for (let k = 0; k < count; k++) {
      const s = base + k * inner;
      const e = s + inner;
      if (!repeated) {
        if (op === 'Add') for (let i = s; i < e; i++) out[i] = ad[i] + bd[i];
        else if (op === 'Sub')
          for (let i = s; i < e; i++) out[i] = ad[i] - bd[i];
        else if (op === 'Mul')
          for (let i = s; i < e; i++) out[i] = ad[i] * bd[i];
        else for (let i = s; i < e; i++) out[i] = ad[i] / bd[i];
      } else if (pb) {
        const v = bd[k];
        if (op === 'Add') for (let i = s; i < e; i++) out[i] = ad[i] + v;
        else if (op === 'Sub') for (let i = s; i < e; i++) out[i] = ad[i] - v;
        else if (op === 'Mul') for (let i = s; i < e; i++) out[i] = ad[i] * v;
        else for (let i = s; i < e; i++) out[i] = ad[i] / v;
      } else {
        const v = ad[k];
        if (op === 'Add') for (let i = s; i < e; i++) out[i] = v + bd[i];
        else if (op === 'Sub') for (let i = s; i < e; i++) out[i] = v - bd[i];
        else if (op === 'Mul') for (let i = s; i < e; i++) out[i] = v * bd[i];
        else for (let i = s; i < e; i++) out[i] = v / bd[i];
      }
    }
  }
  return {shape, data: out};
}

const BINARY: Record<BinaryOp, (x: number, y: number) => number> = {
  Add: (x, y) => x + y,
  Sub: (x, y) => x - y,
  Mul: (x, y) => x * y,
  Div: (x, y) => x / y,
  Pow: (x, y) => (y === 2 ? x * x : x ** y),
};

function binary(
  a: Tensor,
  b: Tensor,
  f: (x: number, y: number) => number,
): Tensor {
  const shape = broadcastShape(a.shape, b.shape);
  const n = sizeOf(shape);
  const out = new Float32Array(n);
  if (a.data.length === n && b.data.length === n) {
    for (let i = 0; i < n; i++) out[i] = f(a.data[i], b.data[i]);
  } else if (a.data.length === n && b.data.length === 1) {
    const y = b.data[0];
    for (let i = 0; i < n; i++) out[i] = f(a.data[i], y);
  } else {
    const ia = a.data.length === n ? null : broadcastIndex(a.shape, shape);
    const ib = b.data.length === n ? null : broadcastIndex(b.shape, shape);
    for (let i = 0; i < n; i++) {
      out[i] = f(a.data[ia ? ia[i] : i], b.data[ib ? ib[i] : i]);
    }
  }
  return {shape, data: out};
}

/** The one-input ops, a loop each (a call per element is slow). */
function unaryOp(op: string, x: Tensor, alpha: number, beta: number): Tensor {
  const d = x.data;
  const out = new Float32Array(d.length);
  const n = d.length;
  switch (op) {
    case 'Relu':
      for (let i = 0; i < n; i++) out[i] = d[i] > 0 ? d[i] : 0;
      break;
    case 'Sigmoid':
      for (let i = 0; i < n; i++) out[i] = 1 / (1 + Math.exp(-d[i]));
      break;
    case 'HardSigmoid':
      for (let i = 0; i < n; i++) {
        const v = alpha * d[i] + beta;
        out[i] = v < 0 ? 0 : v > 1 ? 1 : v;
      }
      break;
    case 'Erf':
      for (let i = 0; i < n; i++) out[i] = erf(d[i]);
      break;
    case 'Sqrt':
      for (let i = 0; i < n; i++) out[i] = Math.sqrt(d[i]);
      break;
    default:
      throw new Error(`unary ${op}`);
  }
  return {shape: x.shape, data: out};
}

/** A convolution's padding, strides and output size (ONNX Conv). */
export function convGeometry(node: GraphNode, x: number[], w: number[]) {
  const [, c, h, wd] = x;
  const [, cg, kh, kw] = w;
  const group = attr(node, 'group', 1);
  const [sh, sw] = attr(node, 'strides', [1, 1]);
  const [dh, dw] = attr(node, 'dilations', [1, 1]);
  let [pt, pl, pb, pr] = attr(node, 'pads', [0, 0, 0, 0]);
  const autoPad = attr<string>(node, 'auto_pad', 'NOTSET');
  if (autoPad === 'SAME_UPPER' || autoPad === 'SAME_LOWER') {
    const padTotal = (size: number, s: number, k: number, d: number) =>
      Math.max(0, (Math.ceil(size / s) - 1) * s + (k - 1) * d + 1 - size);
    const ph = padTotal(h, sh, kh, dh);
    const pw = padTotal(wd, sw, kw, dw);
    [pt, pb] =
      autoPad === 'SAME_UPPER'
        ? [ph >> 1, ph - (ph >> 1)]
        : [ph - (ph >> 1), ph >> 1];
    [pl, pr] =
      autoPad === 'SAME_UPPER'
        ? [pw >> 1, pw - (pw >> 1)]
        : [pw - (pw >> 1), pw >> 1];
  }
  if (cg * group !== c) {
    throw new Error(`Conv: ${c} channels, weight for ${cg}×${group}`);
  }
  return {
    group,
    sh,
    sw,
    dh,
    dw,
    pt,
    pl,
    pb,
    pr,
    oh: Math.floor((h + pt + pb - (kh - 1) * dh - 1) / sh) + 1,
    ow: Math.floor((wd + pl + pr - (kw - 1) * dw - 1) / sw) + 1,
  };
}

function conv(node: GraphNode, x: Tensor, w: Tensor, b?: Tensor): Tensor {
  const [n, c, h, wd] = x.shape;
  const [m, cg, kh, kw] = w.shape;
  const {group, sh, sw, dh, dw, pt, pl, pb, pr, oh, ow} = convGeometry(
    node,
    x.shape,
    w.shape,
  );
  const mg = m / group;
  const out = new Float32Array(n * m * oh * ow);
  const xd = x.data;
  const wdat = w.data;
  const plane = oh * ow;
  if (
    kh === 1 &&
    kw === 1 &&
    sh === 1 &&
    sw === 1 &&
    !pt &&
    !pl &&
    !pb &&
    !pr
  ) {
    // 1×1: a matrix product; four input channels per pass over the output.
    for (let ni = 0; ni < n; ni++) {
      for (let o = 0; o < m; o++) {
        const g = Math.floor(o / mg);
        const ob = (ni * m + o) * plane;
        if (b) out.fill(b.data[o], ob, ob + plane);
        const wb = o * cg;
        const xb = (ni * c + g * cg) * plane;
        let i = 0;
        for (; i + 4 <= cg; i += 4) {
          const w0 = wdat[wb + i];
          const w1 = wdat[wb + i + 1];
          const w2 = wdat[wb + i + 2];
          const w3 = wdat[wb + i + 3];
          const x0 = xb + i * plane;
          const x1 = x0 + plane;
          const x2 = x1 + plane;
          const x3 = x2 + plane;
          for (let p = 0; p < plane; p++) {
            out[ob + p] +=
              w0 * xd[x0 + p] +
              w1 * xd[x1 + p] +
              w2 * xd[x2 + p] +
              w3 * xd[x3 + p];
          }
        }
        for (; i < cg; i++) {
          const wv = wdat[wb + i];
          const x0 = xb + i * plane;
          for (let p = 0; p < plane; p++) out[ob + p] += wv * xd[x0 + p];
        }
      }
    }
    return {shape: [n, m, oh, ow], data: out};
  }
  // Each weight in turn, added into the whole output plane: the inner loop
  // runs along a row with one weight and no bounds checks.
  for (let ni = 0; ni < n; ni++) {
    for (let o = 0; o < m; o++) {
      const g = Math.floor(o / mg);
      const ob = (ni * m + o) * plane;
      if (b) out.fill(b.data[o], ob, ob + plane);
      for (let i = 0; i < cg; i++) {
        const xBase = (ni * c + g * cg + i) * h;
        for (let ky = 0; ky < kh; ky++) {
          for (let kx = 0; kx < kw; kx++) {
            const wv = wdat[((o * cg + i) * kh + ky) * kw + kx];
            if (wv === 0) continue;
            const offX = kx * dw - pl;
            // Output columns whose input column is inside the image.
            const x0 = Math.max(0, Math.ceil(-offX / sw));
            const x1 = Math.min(ow, Math.floor((wd - 1 - offX) / sw) + 1);
            if (x0 >= x1) continue;
            for (let y = 0; y < oh; y++) {
              const iy = y * sh - pt + ky * dh;
              if (iy < 0 || iy >= h) continue;
              const row = (xBase + iy) * wd + offX;
              const orow = ob + y * ow;
              if (sw === 1) {
                for (let xx = x0; xx < x1; xx++) {
                  out[orow + xx] += wv * xd[row + xx];
                }
              } else {
                for (let xx = x0; xx < x1; xx++) {
                  out[orow + xx] += wv * xd[row + xx * sw];
                }
              }
            }
          }
        }
      }
    }
  }
  return {shape: [n, m, oh, ow], data: out};
}

function convTranspose(
  node: GraphNode,
  x: Tensor,
  w: Tensor,
  b?: Tensor,
): Tensor {
  const [n, c, h, wd] = x.shape;
  const [, mg, kh, kw] = w.shape;
  const group = attr(node, 'group', 1);
  if (group !== 1) throw new Error('ConvTranspose: groups');
  const [sh, sw] = attr(node, 'strides', [1, 1]);
  const [pt, pl, pb, pr] = attr(node, 'pads', [0, 0, 0, 0]);
  const [oph, opw] = attr(node, 'output_padding', [0, 0]);
  const m = mg;
  const oh = (h - 1) * sh - pt - pb + kh + oph;
  const ow = (wd - 1) * sw - pl - pr + kw + opw;
  const out = new Float32Array(n * m * oh * ow);
  const plane = oh * ow;
  // Each weight in turn, added along whole rows (as in conv).
  for (let ni = 0; ni < n; ni++) {
    for (let o = 0; o < m; o++) {
      const ob = (ni * m + o) * plane;
      if (b) out.fill(b.data[o], ob, ob + plane);
      for (let ci = 0; ci < c; ci++) {
        const xb = (ni * c + ci) * h * wd;
        for (let ky = 0; ky < kh; ky++) {
          for (let kx = 0; kx < kw; kx++) {
            const wv = w.data[((ci * m + o) * kh + ky) * kw + kx];
            if (wv === 0) continue;
            const offX = kx - pl;
            const x0 = Math.max(0, Math.ceil(-offX / sw));
            const x1 = Math.min(wd, Math.floor((ow - 1 - offX) / sw) + 1);
            for (let y = 0; y < h; y++) {
              const oy = y * sh - pt + ky;
              if (oy < 0 || oy >= oh) continue;
              const orow = ob + oy * ow + offX;
              const xrow = xb + y * wd;
              for (let xx = x0; xx < x1; xx++) {
                out[orow + xx * sw] += wv * x.data[xrow + xx];
              }
            }
          }
        }
      }
    }
  }
  return {shape: [n, m, oh, ow], data: out};
}

function pool(node: GraphNode, x: Tensor, kind: 'avg' | 'max'): Tensor {
  const [n, c, h, wd] = x.shape;
  const [kh, kw] = attr(node, 'kernel_shape', [1, 1]);
  const [sh, sw] = attr(node, 'strides', [1, 1]);
  let [pt, pl, pb, pr] = attr(node, 'pads', [0, 0, 0, 0]);
  const autoPad = attr<string>(node, 'auto_pad', 'NOTSET');
  const ceil = attr(node, 'ceil_mode', 0);
  const countPad = attr(node, 'count_include_pad', 0);
  let oh: number;
  let ow: number;
  if (autoPad === 'SAME_UPPER' || autoPad === 'SAME_LOWER') {
    oh = Math.ceil(h / sh);
    ow = Math.ceil(wd / sw);
    const ph = Math.max(0, (oh - 1) * sh + kh - h);
    const pw = Math.max(0, (ow - 1) * sw + kw - wd);
    [pt, pb] =
      autoPad === 'SAME_UPPER'
        ? [ph >> 1, ph - (ph >> 1)]
        : [ph - (ph >> 1), ph >> 1];
    [pl, pr] =
      autoPad === 'SAME_UPPER'
        ? [pw >> 1, pw - (pw >> 1)]
        : [pw - (pw >> 1), pw >> 1];
  } else {
    const r = ceil ? Math.ceil : Math.floor;
    oh = r((h + pt + pb - kh) / sh) + 1;
    ow = r((wd + pl + pr - kw) / sw) + 1;
  }
  const out = new Float32Array(n * c * oh * ow);
  for (let p = 0; p < n * c; p++) {
    for (let y = 0; y < oh; y++) {
      for (let xx = 0; xx < ow; xx++) {
        let acc = kind === 'max' ? -Infinity : 0;
        let count = 0;
        for (let ky = 0; ky < kh; ky++) {
          const iy = y * sh - pt + ky;
          for (let kx = 0; kx < kw; kx++) {
            const ix = xx * sw - pl + kx;
            if (iy < 0 || iy >= h || ix < 0 || ix >= wd) {
              if (countPad) count++;
              continue;
            }
            const v = x.data[(p * h + iy) * wd + ix];
            if (kind === 'max') acc = Math.max(acc, v);
            else acc += v;
            count++;
          }
        }
        out[(p * oh + y) * ow + xx] = kind === 'max' ? acc : acc / count;
      }
    }
  }
  return {shape: [n, c, oh, ow], data: out};
}

function reduceMean(x: Tensor, axes: number[], keep: boolean): Tensor {
  const rank = x.shape.length;
  const ax = new Set(axes.map(a => axis(a, rank)));
  const outShape = x.shape.map((d, i) => (ax.has(i) ? 1 : d));
  const n = sizeOf(outShape);
  const sorted = [...ax].sort((a, b) => a - b);
  if (sorted.every((a, i) => i === 0 || a === sorted[i - 1] + 1)) {
    // Contiguous axes: outer × reduced × inner.
    const red = sizeOf(x.shape.slice(sorted[0], sorted[sorted.length - 1] + 1));
    const inner = sizeOf(x.shape.slice(sorted[sorted.length - 1] + 1));
    const out = new Float32Array(n);
    for (let o = 0; o < n / inner; o++) {
      for (let r = 0; r < red; r++) {
        const src = (o * red + r) * inner;
        for (let k = 0; k < inner; k++) out[o * inner + k] += x.data[src + k];
      }
    }
    for (let i = 0; i < n; i++) out[i] /= red;
    return {
      shape: keep ? outShape : x.shape.filter((_, i) => !ax.has(i)),
      data: out,
    };
  }
  const sums = new Float32Array(n);
  const xs = strides(x.shape);
  const os = strides(outShape);
  for (let i = 0; i < x.data.length; i++) {
    let rem = i;
    let o = 0;
    for (let d = 0; d < rank; d++) {
      const c = Math.floor(rem / xs[d]);
      rem -= c * xs[d];
      if (!ax.has(d)) o += c * os[d];
    }
    sums[o] += x.data[i];
  }
  const count = x.data.length / n;
  for (let i = 0; i < n; i++) sums[i] /= count;
  return {
    shape: keep ? outShape : x.shape.filter((_, i) => !ax.has(i)),
    data: sums,
  };
}

function transpose(x: Tensor, perm: number[]): Tensor {
  const rank = x.shape.length;
  const shape = perm.map(p => x.shape[p]);
  const xs = strides(x.shape);
  const os = strides(shape);
  const out = new Float32Array(x.data.length);
  for (let i = 0; i < out.length; i++) {
    let rem = i;
    let src = 0;
    for (let d = 0; d < rank; d++) {
      const c = Math.floor(rem / os[d]);
      rem -= c * os[d];
      src += c * xs[perm[d]];
    }
    out[i] = x.data[src];
  }
  return {shape, data: out};
}

/** ONNX Reshape: 0 copies the input's dimension, -1 is inferred. */
export function reshapeShape(from: number[], to: number[]): number[] {
  const shape = to.map((d, i) => (d === 0 ? from[i] : d));
  const known = shape.filter(d => d !== -1).reduce((a, b) => a * b, 1);
  return shape.map(d => (d === -1 ? sizeOf(from) / known : d));
}

/** ONNX Slice's ranges for one axis, clamped like ONNX does. */
export function sliceRange(
  dim: number,
  start: number,
  end: number,
  step: number,
) {
  const clamp = (v: number, lo: number, hi: number) =>
    Math.min(Math.max(v, lo), hi);
  if (start < 0) start += dim;
  if (end < 0) end += dim;
  if (step > 0) {
    start = clamp(start, 0, dim);
    end = clamp(end, 0, dim);
  } else {
    start = clamp(start, 0, dim - 1);
    end = clamp(end, -1, dim - 1);
  }
  const count = Math.max(0, Math.ceil((end - start) / step));
  return {start, step, count};
}

function slice<T extends Value>(
  x: T,
  starts: number[],
  ends: number[],
  axes: number[] | undefined,
  steps: number[] | undefined,
): T {
  const rank = x.shape.length;
  const ranges = x.shape.map(d => ({start: 0, step: 1, count: d}));
  starts.forEach((s, i) => {
    const a = axis(axes?.[i] ?? i, rank);
    ranges[a] = sliceRange(x.shape[a], s, ends[i], steps?.[i] ?? 1);
  });
  const shape = ranges.map(r => r.count);
  const xs = strides(x.shape);
  const os = strides(shape);
  const n = sizeOf(shape);
  const src = isInt(x) ? x.ints : x.data;
  const out: number[] | Float32Array = isInt(x)
    ? new Array(n)
    : new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let rem = i;
    let idx = 0;
    for (let d = 0; d < rank; d++) {
      const c = Math.floor(rem / os[d]);
      rem -= c * os[d];
      idx += (ranges[d].start + c * ranges[d].step) * xs[d];
    }
    out[i] = src[idx];
  }
  return (isInt(x) ? {shape, ints: out} : {shape, data: out}) as T;
}

function concat<T extends Value>(values: T[], ax: number): T {
  const rank = values[0].shape.length;
  const a = axis(ax, rank);
  const shape = [...values[0].shape];
  shape[a] = values.reduce((n, v) => n + v.shape[a], 0);
  const outer = sizeOf(shape.slice(0, a));
  const int = isInt(values[0]);
  const out: number[] | Float32Array = int
    ? []
    : new Float32Array(sizeOf(shape));
  let pos = 0;
  for (let o = 0; o < outer; o++) {
    for (const v of values) {
      const chunk = sizeOf(v.shape.slice(a));
      const src = isInt(v) ? v.ints : v.data;
      for (let i = 0; i < chunk; i++) out[pos++] = src[o * chunk + i];
    }
  }
  return (int ? {shape, ints: out} : {shape, data: out}) as T;
}

function matmul(a: Tensor, b: Tensor): Tensor {
  const ar = a.shape.length;
  const br = b.shape.length;
  const [m, k] = [a.shape[ar - 2] ?? 1, a.shape[ar - 1]];
  const n = b.shape[br - 1];
  if ((b.shape[br - 2] ?? 1) !== k) throw new Error('MatMul: inner sizes');
  const batch = broadcastShape(a.shape.slice(0, -2), b.shape.slice(0, -2));
  const nb = sizeOf(batch);
  const ia = broadcastIndex(a.shape.slice(0, -2), batch);
  const ib = broadcastIndex(b.shape.slice(0, -2), batch);
  const out = new Float32Array(nb * m * n);
  for (let p = 0; p < nb; p++) {
    const ao = ia[p] * m * k;
    const bo = ib[p] * k * n;
    const oo = p * m * n;
    for (let i = 0; i < m; i++) {
      for (let kk = 0; kk < k; kk++) {
        const av = a.data[ao + i * k + kk];
        if (av === 0) continue;
        const brow = bo + kk * n;
        const orow = oo + i * n;
        for (let j = 0; j < n; j++) out[orow + j] += av * b.data[brow + j];
      }
    }
  }
  const shape = [...batch, ...(ar > 1 ? [m] : []), ...(br > 1 ? [n] : [])];
  return {shape, data: out};
}

function softmaxLast(x: Tensor): Tensor {
  const n = x.shape[x.shape.length - 1];
  const out = new Float32Array(x.data.length);
  for (let r = 0; r < x.data.length; r += n) {
    let max = -Infinity;
    for (let i = 0; i < n; i++) max = Math.max(max, x.data[r + i]);
    let sum = 0;
    for (let i = 0; i < n; i++)
      sum += out[r + i] = Math.exp(x.data[r + i] - max);
    for (let i = 0; i < n; i++) out[r + i] /= sum;
  }
  return {shape: x.shape, data: out};
}

function resizeNearest(
  x: Tensor,
  outShape: number[],
  scales: number[],
): Tensor {
  // coordinate_transformation_mode asymmetric, nearest_mode floor.
  const rank = x.shape.length;
  if (rank === 4 && scales[0] === 1 && scales[1] === 1) {
    // Images: per plane, rows of precomputed source columns.
    const [n, c, h, w] = x.shape;
    const [, , oh, ow] = outShape;
    const cols = Int32Array.from({length: ow}, (_, i) =>
      Math.min(w - 1, Math.floor(i / scales[3])),
    );
    const out = new Float32Array(sizeOf(outShape));
    for (let p = 0; p < n * c; p++) {
      for (let y = 0; y < oh; y++) {
        const src = (p * h + Math.min(h - 1, Math.floor(y / scales[2]))) * w;
        const dst = (p * oh + y) * ow;
        for (let i = 0; i < ow; i++) out[dst + i] = x.data[src + cols[i]];
      }
    }
    return {shape: outShape, data: out};
  }
  const xs = strides(x.shape);
  const os = strides(outShape);
  const out = new Float32Array(sizeOf(outShape));
  for (let i = 0; i < out.length; i++) {
    let rem = i;
    let src = 0;
    for (let d = 0; d < rank; d++) {
      const c = Math.floor(rem / os[d]);
      rem -= c * os[d];
      src += Math.min(x.shape[d] - 1, Math.floor(c / scales[d])) * xs[d];
    }
    out[i] = x.data[src];
  }
  return {shape: outShape, data: out};
}

/**
 * Faster versions of the heaviest operators (graph-wasm.ts); each returns
 * undefined for a case it doesn't handle, which then runs here.
 */
export interface Kernels {
  conv?(node: GraphNode, x: Tensor, w: Tensor, b?: Tensor): Tensor | undefined;
  matmul?(a: Tensor, b: Tensor): Tensor | undefined;
}

/** Runs the graph on the inputs; returns every output, by name. */
export function runGraphCpu(
  graph: Graph,
  inputs: Record<string, Tensor>,
  /** to inspect intermediate values (tests) */
  onValue?: (name: string, v: Value) => void,
  kernels?: Kernels,
): Map<string, Value> {
  const values = new Map<string, Value>(graph.consts);
  for (const [k, v] of Object.entries(inputs)) values.set(k, v);
  const get = (name: string): Value => {
    const v = values.get(name);
    if (!v) throw new Error(`missing value ${name}`);
    return v;
  };
  for (const node of graph.spec.nodes) {
    const out = evalNode(node, get, kernels);
    values.set(node.outputs[0], out);
    onValue?.(node.outputs[0], out);
  }
  return new Map(graph.spec.outputs.map(o => [o, get(o)]));
}

/** One node's output, given its inputs. */
export function evalNode(
  node: GraphNode,
  get: (name: string) => Value,
  kernels?: Kernels,
): Value {
  const f = (name: string): Tensor => {
    const v = get(name);
    if (isInt(v)) return {shape: v.shape, data: new Float32Array(v.ints)};
    return v;
  };
  const ints = (name: string): number[] => {
    const v = get(name);
    return isInt(v) ? v.ints : Array.from(v.data);
  };

  const [i0, i1, i2] = node.inputs;
  let out: Value;
  switch (node.op) {
    case 'Conv': {
      const args = [f(i0), f(i1), i2 ? f(i2) : undefined] as const;
      out = kernels?.conv?.(node, ...args) ?? conv(node, ...args);
      break;
    }
    case 'ConvTranspose':
      out = convTranspose(node, f(i0), f(i1), i2 ? f(i2) : undefined);
      break;
    case 'Add':
    case 'Sub':
    case 'Mul':
    case 'Div':
    case 'Pow': {
      const a = get(i0);
      const b = get(i1);
      const op = node.op as BinaryOp;
      if (isInt(a) && isInt(b)) {
        const t = binary(f(i0), f(i1), BINARY[op]);
        out = {shape: t.shape, ints: Array.from(t.data, Math.trunc)};
      } else {
        out = binaryOp(op, f(i0), f(i1));
      }
      break;
    }
    case 'Relu':
    case 'Sigmoid':
    case 'HardSigmoid':
    case 'Erf':
    case 'Sqrt':
      out = unaryOp(
        node.op,
        f(i0),
        attr(node, 'alpha', 0.2),
        attr(node, 'beta', 0.5),
      );
      break;
    case 'ChannelAffine': {
      const x = f(i0);
      const scale = f(i1).data;
      const shift = f(i2).data;
      const [n, c] = x.shape;
      const hw = sizeOf(x.shape.slice(2));
      const data = new Float32Array(x.data.length);
      for (let p = 0; p < n * c; p++) {
        const ch = p % c;
        for (let i = p * hw; i < (p + 1) * hw; i++) {
          data[i] = x.data[i] * scale[ch] + shift[ch];
        }
      }
      out = {shape: x.shape, data};
      break;
    }
    case 'GlobalAveragePool':
      out = reduceMean(f(i0), [2, 3], true);
      break;
    case 'ReduceMean': {
      const x = f(i0);
      const axes = attr(
        node,
        'axes',
        x.shape.map((_, i) => i),
      );
      out = reduceMean(x, axes, attr(node, 'keepdims', 1) === 1);
      break;
    }
    case 'AveragePool':
      out = pool(node, f(i0), 'avg');
      break;
    case 'MaxPool':
      out = pool(node, f(i0), 'max');
      break;
    case 'Resize': {
      const mode = attr<string>(node, 'mode', 'nearest');
      const ct = attr<string>(
        node,
        'coordinate_transformation_mode',
        'half_pixel',
      );
      const nm = attr<string>(node, 'nearest_mode', 'round_prefer_floor');
      if (mode !== 'nearest' || ct !== 'asymmetric' || nm !== 'floor') {
        throw new Error(`Resize ${mode}/${ct}/${nm}`);
      }
      const x = f(i0);
      const scales = i2 ? Array.from(f(i2).data) : [];
      const sizes = node.inputs[3] ? ints(node.inputs[3]) : undefined;
      const shape = sizes ?? x.shape.map((d, i) => Math.floor(d * scales[i]));
      out = resizeNearest(
        x,
        shape,
        sizes ? shape.map((d, i) => d / x.shape[i]) : scales,
      );
      break;
    }
    case 'Concat':
      out = concat(node.inputs.map(get), attr(node, 'axis', 0));
      break;
    case 'MatMul':
      out = kernels?.matmul?.(f(i0), f(i1)) ?? matmul(f(i0), f(i1));
      break;
    case 'Softmax': {
      const x = f(i0);
      const ax = axis(attr(node, 'axis', -1), x.shape.length);
      if (ax !== x.shape.length - 1)
        throw new Error('Softmax: not the last axis');
      out = softmaxLast(x);
      break;
    }
    case 'Transpose': {
      const x = f(i0);
      out = transpose(
        x,
        attr(node, 'perm', x.shape.map((_, i) => i).reverse()),
      );
      break;
    }
    case 'Reshape': {
      const x = get(i0);
      const shape = reshapeShape(x.shape, ints(i1));
      out = isInt(x) ? {shape, ints: x.ints} : {shape, data: x.data};
      break;
    }
    case 'Squeeze': {
      const x = get(i0);
      const rank = x.shape.length;
      const axes = new Set(
        attr(
          node,
          'axes',
          x.shape.flatMap((d, i) => (d === 1 ? [i] : [])),
        ).map(a => axis(a, rank)),
      );
      const shape = x.shape.filter((_, i) => !axes.has(i));
      out = isInt(x) ? {shape, ints: x.ints} : {shape, data: x.data};
      break;
    }
    case 'Unsqueeze': {
      const x = get(i0);
      const rank = x.shape.length + attr<number[]>(node, 'axes', []).length;
      const axes = attr<number[]>(node, 'axes', [])
        .map(a => axis(a, rank))
        .sort((a, b) => a - b);
      const shape = [...x.shape];
      for (const a of axes) shape.splice(a, 0, 1);
      out = isInt(x) ? {shape, ints: x.ints} : {shape, data: x.data};
      break;
    }
    case 'Slice':
      out = slice(
        get(i0),
        ints(i1),
        ints(i2),
        node.inputs[3] ? ints(node.inputs[3]) : undefined,
        node.inputs[4] ? ints(node.inputs[4]) : undefined,
      );
      break;
    case 'Shape': {
      const x = get(i0);
      out = {shape: [x.shape.length], ints: [...x.shape]} as IntTensor;
      break;
    }
    default:
      throw new Error(`unsupported operator ${node.op}`);
  }
  return out;
}
