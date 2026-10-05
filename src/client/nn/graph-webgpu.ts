/**
 * Runs a graph (graph.ts) on the GPU with WebGPU. Float tensors live on
 * the GPU; integer tensors (shapes, axes) and anything computed only from
 * constants are worked out on the CPU (graph-cpu.ts's evalNode), so every
 * shape is known before the GPU work is recorded. One run is one compute
 * pass; intermediate buffers are reused once their last reader has run.
 */
import {
  attr,
  axis,
  broadcastShape,
  evalNode,
  reshapeShape,
  sliceRange,
  strides,
} from './graph-cpu.ts';
import {
  isInt,
  sizeOf,
  type Graph,
  type GraphNode,
  type Tensor,
  type Value,
} from './graph.ts';

// WebGPU flag values (fixed by the spec); TypeScript's DOM library has the
// types but not these constants.
const STORAGE = 0x80;
const COPY_SRC = 0x4;
const COPY_DST = 0x8;
const MAP_READ = 0x1;

/** Every shader's parameters are u32s (floats bit-cast) at binding 0. */
const HEADER = /* wgsl */ `
@group(0) @binding(0) var<storage, read> p: array<u32>;
`;
/** For one thread per element: the element, from a 2-D dispatch. */
const FLAT = /* wgsl */ `
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u,
        @builtin(num_workgroups) nwg: vec3u) {
  let i = id.x + id.y * nwg.x * 256u;
  if (i >= p[0]) { return; }
  body(i);
}
`;

/** y[dst] = x[src] over an n-d box: transpose, slice, concat. */
const COPY =
  HEADER +
  /* wgsl */ `
@group(0) @binding(1) var<storage, read> x: array<f32>;
@group(0) @binding(2) var<storage, read_write> y: array<f32>;
// p: n, srcBase, dstBase, shape[6], srcStrides[6], dstStrides[6]
fn body(i: u32) {
  var rem = i;
  var src = p[1];
  var dst = p[2];
  for (var d = 5u; d < 6u; d--) {
    let s = p[3u + d];
    let c = rem % s;
    rem = rem / s;
    src += c * p[9u + d];
    dst += c * p[15u + d];
  }
  y[dst] = x[src];
}
` +
  FLAT;

const BINARY =
  HEADER +
  /* wgsl */ `
@group(0) @binding(1) var<storage, read> a: array<f32>;
@group(0) @binding(2) var<storage, read> b: array<f32>;
@group(0) @binding(3) var<storage, read_write> y: array<f32>;
// p: n, op, shape[6], aStrides[6], bStrides[6]
fn body(i: u32) {
  var rem = i;
  var ia = 0u;
  var ib = 0u;
  for (var d = 5u; d < 6u; d--) {
    let s = p[2u + d];
    let c = rem % s;
    rem = rem / s;
    ia += c * p[8u + d];
    ib += c * p[14u + d];
  }
  let u = a[ia];
  let v = b[ib];
  var r: f32;
  switch p[1] {
    case 0u: { r = u + v; }
    case 1u: { r = u - v; }
    case 2u: { r = u * v; }
    case 3u: { r = u / v; }
    default: { if (v == 2.0) { r = u * u; } else { r = pow(u, v); } }
  }
  y[i] = r;
}
` +
  FLAT;

const UNARY =
  HEADER +
  /* wgsl */ `
@group(0) @binding(1) var<storage, read> x: array<f32>;
@group(0) @binding(2) var<storage, read_write> y: array<f32>;
// Numerical Recipes' erfc approximation (as graph-cpu.ts).
fn erf(v: f32) -> f32 {
  let z = abs(v);
  let t = 1.0 / (1.0 + 0.5 * z);
  let c = t * exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 +
    t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 +
    t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return select(c - 1.0, 1.0 - c, v >= 0.0);
}
// p: n, op, alpha, beta
fn body(i: u32) {
  let v = x[i];
  var r: f32;
  switch p[1] {
    case 0u: { r = max(v, 0.0); }
    case 1u: { r = 1.0 / (1.0 + exp(-v)); }
    case 2u: { r = clamp(bitcast<f32>(p[2]) * v + bitcast<f32>(p[3]), 0.0, 1.0); }
    case 3u: { r = erf(v); }
    default: { r = sqrt(v); }
  }
  y[i] = r;
}
` +
  FLAT;

const AFFINE =
  HEADER +
  /* wgsl */ `
@group(0) @binding(1) var<storage, read> x: array<f32>;
@group(0) @binding(2) var<storage, read> scale: array<f32>;
@group(0) @binding(3) var<storage, read> shift: array<f32>;
@group(0) @binding(4) var<storage, read_write> y: array<f32>;
// p: n, channels, plane
fn body(i: u32) {
  let c = (i / p[2]) % p[1];
  y[i] = x[i] * scale[c] + shift[c];
}
` +
  FLAT;

// Convolution parameters, shared by both kernels.
const CONV_PARAMS = /* wgsl */ `
// p: c, h, w, m, oh, ow, kh, kw, sh, sw, dh, dw, pt, pl, cg, mg
fn inY(oy: u32, ky: u32) -> i32 { return i32(oy * p[8] + ky * p[10]) - i32(p[12]); }
fn inX(ox: u32, kx: u32) -> i32 { return i32(ox * p[9] + kx * p[11]) - i32(p[13]); }
`;

/** One output value per thread. */
const CONV1 =
  HEADER +
  CONV_PARAMS +
  /* wgsl */ `
@group(0) @binding(1) var<storage, read> x: array<f32>;
@group(0) @binding(2) var<storage, read> wt: array<f32>;
@group(0) @binding(3) var<storage, read> bias: array<f32>;
@group(0) @binding(4) var<storage, read_write> y: array<f32>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let c = p[0]; let h = p[1]; let w = p[2]; let m = p[3];
  let oh = p[4]; let ow = p[5]; let kh = p[6]; let kw = p[7];
  let cg = p[14]; let mg = p[15];
  let ox = id.x; let oy = id.y;
  if (ox >= ow || oy >= oh) { return; }
  let o = id.z % m;
  let n = id.z / m;
  let g = o / mg;
  var sum = bias[o];
  for (var i = 0u; i < cg; i++) {
    let xb = (n * c + g * cg + i) * h;
    let wb = (o * cg + i) * kh;
    for (var ky = 0u; ky < kh; ky++) {
      let iy = inY(oy, ky);
      if (iy < 0 || iy >= i32(h)) { continue; }
      for (var kx = 0u; kx < kw; kx++) {
        let ix = inX(ox, kx);
        if (ix < 0 || ix >= i32(w)) { continue; }
        sum += x[(xb + u32(iy)) * w + u32(ix)] * wt[(wb + ky) * kw + kx];
      }
    }
  }
  y[((n * m + o) * oh + oy) * ow + ox] = sum;
}
`;

/**
 * Four output channels per thread (weights packed as vec4s, see pack4), so
 * each input value read is used four times.
 */
const CONV4 =
  HEADER +
  CONV_PARAMS +
  /* wgsl */ `
@group(0) @binding(1) var<storage, read> x: array<f32>;
@group(0) @binding(2) var<storage, read> wt: array<vec4f>;
@group(0) @binding(3) var<storage, read> bias: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> y: array<f32>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let c = p[0]; let h = p[1]; let w = p[2]; let m = p[3];
  let oh = p[4]; let ow = p[5]; let kh = p[6]; let kw = p[7];
  let cg = p[14]; let mg = p[15];
  let ox = id.x; let oy = id.y;
  if (ox >= ow || oy >= oh) { return; }
  let blocks = m / 4u;
  let blk = id.z % blocks;
  let n = id.z / blocks;
  let g = (blk * 4u) / mg;
  var sum = bias[blk];
  for (var i = 0u; i < cg; i++) {
    let xb = (n * c + g * cg + i) * h;
    let wb = (blk * cg + i) * kh;
    for (var ky = 0u; ky < kh; ky++) {
      let iy = inY(oy, ky);
      if (iy < 0 || iy >= i32(h)) { continue; }
      for (var kx = 0u; kx < kw; kx++) {
        let ix = inX(ox, kx);
        if (ix < 0 || ix >= i32(w)) { continue; }
        sum += x[(xb + u32(iy)) * w + u32(ix)] * wt[(wb + ky) * kw + kx];
      }
    }
  }
  let plane = oh * ow;
  let o = (n * m + blk * 4u) * plane + oy * ow + ox;
  y[o] = sum.x;
  y[o + plane] = sum.y;
  y[o + 2u * plane] = sum.z;
  y[o + 3u * plane] = sum.w;
}
`;

const CONV_TRANSPOSE =
  HEADER +
  /* wgsl */ `
@group(0) @binding(1) var<storage, read> x: array<f32>;
@group(0) @binding(2) var<storage, read> wt: array<f32>;
@group(0) @binding(3) var<storage, read> bias: array<f32>;
@group(0) @binding(4) var<storage, read_write> y: array<f32>;
// p: c, h, w, m, oh, ow, kh, kw, sh, sw, pt, pl
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let c = p[0]; let h = p[1]; let w = p[2]; let m = p[3];
  let oh = p[4]; let ow = p[5]; let kh = p[6]; let kw = p[7];
  let sh = i32(p[8]); let sw = i32(p[9]);
  let ox = id.x; let oy = id.y;
  if (ox >= ow || oy >= oh) { return; }
  let o = id.z % m;
  let n = id.z / m;
  var sum = bias[o];
  for (var ci = 0u; ci < c; ci++) {
    for (var ky = 0u; ky < kh; ky++) {
      let ty = i32(oy) + i32(p[10]) - i32(ky);
      if (ty < 0 || ty % sh != 0 || ty / sh >= i32(h)) { continue; }
      let iy = u32(ty / sh);
      for (var kx = 0u; kx < kw; kx++) {
        let tx = i32(ox) + i32(p[11]) - i32(kx);
        if (tx < 0 || tx % sw != 0 || tx / sw >= i32(w)) { continue; }
        let ix = u32(tx / sw);
        sum += x[((n * c + ci) * h + iy) * w + ix] *
          wt[((ci * m + o) * kh + ky) * kw + kx];
      }
    }
  }
  y[((n * m + o) * oh + oy) * ow + ox] = sum;
}
`;

const POOL =
  HEADER +
  /* wgsl */ `
@group(0) @binding(1) var<storage, read> x: array<f32>;
@group(0) @binding(2) var<storage, read_write> y: array<f32>;
// p: planes, h, w, oh, ow, kh, kw, sh, sw, pt, pl, isMax, countPad
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let h = p[1]; let w = p[2]; let oh = p[3]; let ow = p[4];
  let ox = id.x; let oy = id.y; let pl = id.z;
  if (ox >= ow || oy >= oh) { return; }
  let isMax = p[11] == 1u;
  var acc = select(0.0, -3.4e38, isMax);
  var count = 0u;
  for (var ky = 0u; ky < p[5]; ky++) {
    let iy = i32(oy * p[7] + ky) - i32(p[9]);
    for (var kx = 0u; kx < p[6]; kx++) {
      let ix = i32(ox * p[8] + kx) - i32(p[10]);
      if (iy < 0 || iy >= i32(h) || ix < 0 || ix >= i32(w)) {
        if (p[12] == 1u) { count++; }
        continue;
      }
      let v = x[(pl * h + u32(iy)) * w + u32(ix)];
      if (isMax) { acc = max(acc, v); } else { acc += v; }
      count++;
    }
  }
  y[(pl * oh + oy) * ow + ox] = select(acc / f32(count), acc, isMax);
}
`;

/** One workgroup per output: threads share the sum. */
const REDUCE_MEAN =
  HEADER +
  /* wgsl */ `
@group(0) @binding(1) var<storage, read> x: array<f32>;
@group(0) @binding(2) var<storage, read_write> y: array<f32>;
var<workgroup> part: array<f32, 256>;
// p: outputs, reduced, inner
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u,
        @builtin(local_invocation_index) l: u32) {
  let i = wg.x + wg.y * nwg.x;
  let red = p[1]; let inner = p[2];
  let base = (i / inner) * red * inner + i % inner;
  var s = 0.0;
  if (i < p[0]) {
    for (var r = l; r < red; r += 256u) { s += x[base + r * inner]; }
  }
  part[l] = s;
  workgroupBarrier();
  for (var k = 128u; k > 0u; k >>= 1u) {
    if (l < k) { part[l] += part[l + k]; }
    workgroupBarrier();
  }
  if (l == 0u && i < p[0]) { y[i] = part[0] / f32(red); }
}
`;

/** Softmax over each row (the last axis); one workgroup per row. */
const SOFTMAX =
  HEADER +
  /* wgsl */ `
@group(0) @binding(1) var<storage, read> x: array<f32>;
@group(0) @binding(2) var<storage, read_write> y: array<f32>;
var<workgroup> part: array<f32, 256>;
// p: rows, length
@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(num_workgroups) nwg: vec3u,
        @builtin(local_invocation_index) l: u32) {
  let row = wg.x + wg.y * nwg.x;
  let n = p[1];
  let base = row * n;
  let ok = row < p[0];
  var m = -3.4e38;
  if (ok) { for (var i = l; i < n; i += 256u) { m = max(m, x[base + i]); } }
  part[l] = m;
  workgroupBarrier();
  for (var k = 128u; k > 0u; k >>= 1u) {
    if (l < k) { part[l] = max(part[l], part[l + k]); }
    workgroupBarrier();
  }
  let top = part[0];
  workgroupBarrier();
  var s = 0.0;
  if (ok) { for (var i = l; i < n; i += 256u) { s += exp(x[base + i] - top); } }
  part[l] = s;
  workgroupBarrier();
  for (var k = 128u; k > 0u; k >>= 1u) {
    if (l < k) { part[l] += part[l + k]; }
    workgroupBarrier();
  }
  let sum = part[0];
  if (ok) {
    for (var i = l; i < n; i += 256u) { y[base + i] = exp(x[base + i] - top) / sum; }
  }
}
`;

/** Batched matrix product, 16×16 tiles through workgroup memory. */
const MATMUL =
  HEADER +
  /* wgsl */ `
@group(0) @binding(1) var<storage, read> a: array<f32>;
@group(0) @binding(2) var<storage, read> b: array<f32>;
@group(0) @binding(3) var<storage, read_write> y: array<f32>;
var<workgroup> ta: array<array<f32, 16>, 16>;
var<workgroup> tb: array<array<f32, 16>, 16>;
// p: M, N, K, aBatchStride, bBatchStride
@compute @workgroup_size(16, 16, 1)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_id) l: vec3u) {
  let M = p[0]; let N = p[1]; let K = p[2];
  let row = wg.y * 16u + l.y;
  let col = wg.x * 16u + l.x;
  let ao = wg.z * p[3];
  let bo = wg.z * p[4];
  var sum = 0.0;
  for (var t = 0u; t < K; t += 16u) {
    let ak = t + l.x;
    var av = 0.0;
    if (row < M && ak < K) { av = a[ao + row * K + ak]; }
    ta[l.y][l.x] = av;
    let bk = t + l.y;
    var bv = 0.0;
    if (bk < K && col < N) { bv = b[bo + bk * N + col]; }
    tb[l.y][l.x] = bv;
    workgroupBarrier();
    for (var k = 0u; k < 16u; k++) { sum += ta[l.y][k] * tb[k][l.x]; }
    workgroupBarrier();
  }
  if (row < M && col < N) { y[(wg.z * M + row) * N + col] = sum; }
}
`;

/** Nearest-neighbor resize (asymmetric coordinates, floor). */
const RESIZE =
  HEADER +
  /* wgsl */ `
@group(0) @binding(1) var<storage, read> x: array<f32>;
@group(0) @binding(2) var<storage, read_write> y: array<f32>;
// p: n, inShape[6], outShape[6], scales[6] (f32)
fn body(i: u32) {
  var rem = i;
  var src = 0u;
  var stride = 1u;
  for (var d = 5u; d < 6u; d--) {
    let os = p[7u + d];
    let c = rem % os;
    rem = rem / os;
    let ins = p[1u + d];
    let s = min(ins - 1u, u32(floor(f32(c) / bitcast<f32>(p[13u + d]))));
    src += s * stride;
    stride *= ins;
  }
  y[i] = x[src];
}
` +
  FLAT;

const UNARY_OPS: Record<string, number> = {
  Relu: 0,
  Sigmoid: 1,
  HardSigmoid: 2,
  Erf: 3,
  Sqrt: 4,
};
const BINARY_OPS: Record<string, number> = {
  Add: 0,
  Sub: 1,
  Mul: 2,
  Div: 3,
  Pow: 4,
};

const RANK = 6;

/**
 * Merges dimensions that are contiguous in every stride list (and drops
 * size-1 ones), then pads to RANK: fewer index steps per element.
 */
function collapse(shape: number[], ...lists: number[][]) {
  const dims: {size: number; st: number[]}[] = [];
  shape.forEach((size, d) => {
    if (size === 1) return;
    const st = lists.map(l => l[d]);
    const last = dims[dims.length - 1];
    if (last && st.every((s, k) => last.st[k] === s * size)) {
      last.size *= size;
      last.st = st;
    } else {
      dims.push({size, st});
    }
  });
  if (dims.length > RANK) throw new Error(`rank ${dims.length} > ${RANK}`);
  while (dims.length < RANK) dims.unshift({size: 1, st: lists.map(() => 0)});
  return {
    shape: dims.map(d => d.size),
    strides: lists.map((_, k) => dims.map(d => d.st[k])),
  };
}

/** Strides of `from` read as `to` under broadcasting (0 where repeated). */
function broadcastStrides(from: number[], to: number[]) {
  const st = strides(from);
  const pad = to.length - from.length;
  return to.map((_, d) => (d < pad || from[d - pad] === 1 ? 0 : st[d - pad]));
}

/** [m][cg][kh][kw] → [m/4][cg][kh][kw] of vec4 (four output channels). */
function pack4(w: Float32Array, m: number): Float32Array {
  const per = w.length / m;
  const out = new Float32Array(w.length);
  for (let o = 0; o < m; o++) {
    const blk = o >> 2;
    const lane = o & 3;
    for (let i = 0; i < per; i++) {
      out[(blk * per + i) * 4 + lane] = w[o * per + i];
    }
  }
  return out;
}

const f32bits = (v: number) => new Uint32Array(new Float32Array([v]).buffer)[0];

/** A tensor on the GPU. */
interface GpuTensor {
  shape: number[];
  buf: GPUBuffer;
}

interface Step {
  pipeline: GPUComputePipeline;
  params: number[];
  buffers: GPUBuffer[];
  workgroups: [number, number, number];
}

export class GraphGpu {
  private readonly pipelines = new Map<string, GPUComputePipeline>();
  /** constants (and packed conv weights) uploaded once */
  private readonly constBuffers = new Map<string, GPUBuffer>();
  /** free intermediate buffers, by size class */
  private readonly pool = new Map<number, GPUBuffer[]>();
  /** for each value, the last node that reads it */
  private readonly lastUse = new Map<string, number>();
  private readonly align: number;
  private readonly device: GPUDevice;
  private readonly graph: Graph;

  private constructor(device: GPUDevice, graph: Graph) {
    this.device = device;
    this.graph = graph;
    this.align = device.limits.minStorageBufferOffsetAlignment;
    graph.spec.nodes.forEach((n, k) => {
      for (const i of n.inputs) if (i) this.lastUse.set(i, k);
    });
    for (const o of graph.spec.outputs) this.lastUse.set(o, Infinity);
  }

  /**
   * A GPU engine for the graph, or null if WebGPU isn't available. Pass
   * another engine's device to share it.
   */
  static async create(
    graph: Graph,
    device?: GPUDevice,
  ): Promise<GraphGpu | null> {
    if (!device) {
      const adapter = await navigator.gpu?.requestAdapter();
      if (!adapter) return null;
      device = await adapter.requestDevice({
        requiredLimits: {
          maxStorageBufferBindingSize:
            adapter.limits.maxStorageBufferBindingSize,
          maxBufferSize: adapter.limits.maxBufferSize,
        },
      });
    }
    return new GraphGpu(device, graph);
  }

  get gpuDevice(): GPUDevice {
    return this.device;
  }

  private pipeline(code: string) {
    let p = this.pipelines.get(code);
    if (!p) {
      p = this.device.createComputePipeline({
        layout: 'auto',
        compute: {module: this.device.createShaderModule({code})},
      });
      this.pipelines.set(code, p);
    }
    return p;
  }

  private upload(data: Float32Array): GPUBuffer {
    const b = this.device.createBuffer({
      size: Math.max(16, Math.ceil(data.byteLength / 16) * 16),
      usage: STORAGE | COPY_DST,
      mappedAtCreation: true,
    });
    new Float32Array(b.getMappedRange()).set(data);
    b.unmap();
    return b;
  }

  private constant(key: string, make: () => Float32Array): GPUBuffer {
    let b = this.constBuffers.get(key);
    if (!b) {
      b = this.upload(make());
      this.constBuffers.set(key, b);
    }
    return b;
  }

  private acquire(floats: number): GPUBuffer {
    const bytes = Math.max(256, 2 ** Math.ceil(Math.log2(floats * 4)));
    const free = this.pool.get(bytes);
    if (free?.length) return free.pop()!;
    return this.device.createBuffer({
      size: bytes,
      usage: STORAGE | COPY_SRC | COPY_DST,
    });
  }

  private release(buf: GPUBuffer) {
    const list = this.pool.get(buf.size) ?? [];
    list.push(buf);
    this.pool.set(buf.size, list);
  }

  /** Runs the graph; returns its outputs, read back from the GPU. */
  async run(inputs: Record<string, Tensor>): Promise<Map<string, Tensor>> {
    const {graph, device} = this;
    const host = new Map<string, Value>(graph.consts);
    const gpu = new Map<string, GpuTensor>();
    /** how many names share each pooled buffer (Reshape aliases) */
    const refs = new Map<GPUBuffer, number>();
    /** one-off uploads of values computed on the CPU */
    const temps: GPUBuffer[] = [];
    const steps: Step[] = [];

    const own = (shape: number[]): GpuTensor => {
      const buf = this.acquire(sizeOf(shape));
      refs.set(buf, (refs.get(buf) ?? 0) + 1);
      return {shape, buf};
    };
    for (const [name, t] of Object.entries(inputs)) {
      const v = own(t.shape);
      device.queue.writeBuffer(v.buf, 0, t.data);
      gpu.set(name, v);
    }
    /** An input of a GPU op, uploading CPU values. */
    const input = (name: string): GpuTensor => {
      const g = gpu.get(name);
      if (g) return g;
      const v = host.get(name);
      if (!v) throw new Error(`missing value ${name}`);
      const data = isInt(v) ? new Float32Array(v.ints) : v.data;
      if (graph.consts.has(name)) {
        return {shape: v.shape, buf: this.constant(name, () => data)};
      }
      const buf = this.upload(data);
      temps.push(buf);
      return {shape: v.shape, buf};
    };
    const ints = (name: string): number[] => {
      const v = host.get(name);
      if (!v) throw new Error(`${name} must be known on the CPU`);
      return isInt(v) ? v.ints : Array.from(v.data);
    };
    const step = (
      code: string,
      params: number[],
      buffers: GPUBuffer[],
      workgroups: [number, number, number],
    ) => {
      steps.push({pipeline: this.pipeline(code), params, buffers, workgroups});
    };
    /** Workgroups for n threads (or n workgroups) in a 2-D grid. */
    const grid = (groups: number): [number, number, number] => {
      const x = Math.min(groups, 65535);
      return [x, Math.ceil(groups / x), 1];
    };
    const flat = (n: number) => grid(Math.ceil(n / 256));

    for (const [k, node] of graph.spec.nodes.entries()) {
      const data = node.inputs.filter(i => i);
      if (data.every(i => !gpu.has(i))) {
        // All on the CPU: shapes, integer arithmetic, constants.
        host.set(
          node.outputs[0],
          evalNode(node, n => host.get(n)!),
        );
      } else {
        const out = this.record(node, input, ints, own, step, flat, grid);
        if ('buf' in out) {
          // An alias shares its input's buffer (if pooled; constants aren't).
          if (!out.fresh && refs.has(out.buf)) {
            refs.set(out.buf, refs.get(out.buf)! + 1);
          }
          gpu.set(node.outputs[0], {shape: out.shape, buf: out.buf});
        } else {
          host.set(node.outputs[0], out.value);
        }
      }
      // Buffers whose last reader this was can be reused.
      for (const i of new Set(data)) {
        if (this.lastUse.get(i) !== k) continue;
        const g = gpu.get(i);
        if (!g || !refs.has(g.buf)) continue;
        const r = refs.get(g.buf)! - 1;
        refs.set(g.buf, r);
        if (r === 0) {
          refs.delete(g.buf);
          this.release(g.buf);
        }
      }
    }

    // Parameters, all in one buffer.
    const words = this.align / 4;
    const offsets: number[] = [];
    let total = 0;
    for (const s of steps) {
      offsets.push(total);
      total += Math.ceil(Math.max(1, s.params.length) / words) * words;
    }
    const params = new Uint32Array(Math.max(total, words));
    steps.forEach((s, i) => params.set(s.params, offsets[i]));
    const paramBuf = device.createBuffer({
      size: params.byteLength,
      usage: STORAGE | COPY_DST,
    });
    device.queue.writeBuffer(paramBuf, 0, params);

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    steps.forEach((s, i) => {
      pass.setPipeline(s.pipeline);
      pass.setBindGroup(
        0,
        device.createBindGroup({
          layout: s.pipeline.getBindGroupLayout(0),
          entries: [
            {
              binding: 0,
              resource: {
                buffer: paramBuf,
                offset: offsets[i] * 4,
                size: Math.max(1, s.params.length) * 4,
              },
            },
            ...s.buffers.map((buffer, b) => ({
              binding: b + 1,
              resource: {buffer},
            })),
          ],
        }),
      );
      pass.dispatchWorkgroups(...s.workgroups);
    });
    pass.end();

    const results = new Map<string, Tensor>();
    const reads: {name: string; shape: number[]; buf: GPUBuffer}[] = [];
    for (const name of graph.spec.outputs) {
      const g = gpu.get(name);
      if (!g) {
        const v = host.get(name)!;
        results.set(name, {
          shape: v.shape,
          data: isInt(v) ? new Float32Array(v.ints) : v.data,
        });
        continue;
      }
      const bytes = sizeOf(g.shape) * 4;
      const buf = device.createBuffer({
        size: Math.max(4, bytes),
        usage: MAP_READ | COPY_DST,
      });
      if (bytes) encoder.copyBufferToBuffer(g.buf, 0, buf, 0, bytes);
      reads.push({name, shape: g.shape, buf});
    }
    device.queue.submit([encoder.finish()]);
    for (const {name, shape, buf} of reads) {
      await buf.mapAsync(MAP_READ);
      const data = new Float32Array(buf.getMappedRange()).slice(
        0,
        sizeOf(shape),
      );
      buf.destroy();
      results.set(name, {shape, data});
    }
    for (const name of graph.spec.outputs) {
      const g = gpu.get(name);
      if (g && refs.has(g.buf)) {
        refs.delete(g.buf);
        this.release(g.buf);
      }
    }
    paramBuf.destroy();
    for (const b of temps) b.destroy();
    return results;
  }

  /**
   * Records one node's GPU work. Returns its output buffer (fresh: newly
   * owned; otherwise an alias of an input's), or a CPU value (Shape).
   */
  private record(
    node: GraphNode,
    input: (name: string) => GpuTensor,
    ints: (name: string) => number[],
    own: (shape: number[]) => GpuTensor,
    step: (
      code: string,
      params: number[],
      buffers: GPUBuffer[],
      workgroups: [number, number, number],
    ) => void,
    flat: (n: number) => [number, number, number],
    grid: (groups: number) => [number, number, number],
  ): {shape: number[]; buf: GPUBuffer; fresh: boolean} | {value: Value} {
    const [i0, i1, i2] = node.inputs;
    const fresh = (t: GpuTensor) => ({...t, fresh: true});
    const alias = (t: GpuTensor, shape: number[]) => ({
      shape,
      buf: t.buf,
      fresh: false,
    });
    /** Copies an n-d box of x into y. */
    const copy = (
      x: GpuTensor,
      y: GpuTensor,
      shape: number[],
      srcBase: number,
      srcStrides: number[],
      dstBase: number,
      dstStrides: number[],
    ) => {
      const n = sizeOf(shape);
      if (!n) return;
      const c = collapse(shape, srcStrides, dstStrides);
      step(
        COPY,
        [n, srcBase, dstBase, ...c.shape, ...c.strides[0], ...c.strides[1]],
        [x.buf, y.buf],
        flat(n),
      );
    };

    switch (node.op) {
      case 'Conv': {
        const x = input(i0);
        const [n, c, h, w] = x.shape;
        const wShape = this.graph.consts.get(i1)!.shape;
        const [m, cg, kh, kw] = wShape;
        const group = attr(node, 'group', 1);
        const [sh, sw] = attr(node, 'strides', [1, 1]);
        const [dh, dw] = attr(node, 'dilations', [1, 1]);
        let [pt, pl, pb, pr] = attr(node, 'pads', [0, 0, 0, 0]);
        const autoPad = attr<string>(node, 'auto_pad', 'NOTSET');
        if (autoPad === 'SAME_UPPER' || autoPad === 'SAME_LOWER') {
          const total = (size: number, s: number, k: number, d: number) =>
            Math.max(0, (Math.ceil(size / s) - 1) * s + (k - 1) * d + 1 - size);
          const ph = total(h, sh, kh, dh);
          const pw = total(w, sw, kw, dw);
          const upper = autoPad === 'SAME_UPPER';
          [pt, pb] = upper
            ? [ph >> 1, ph - (ph >> 1)]
            : [ph - (ph >> 1), ph >> 1];
          [pl, pr] = upper
            ? [pw >> 1, pw - (pw >> 1)]
            : [pw - (pw >> 1), pw >> 1];
        }
        const oh = Math.floor((h + pt + pb - (kh - 1) * dh - 1) / sh) + 1;
        const ow = Math.floor((w + pl + pr - (kw - 1) * dw - 1) / sw) + 1;
        const mg = m / group;
        const y = own([n, m, oh, ow]);
        const params = [
          c,
          h,
          w,
          m,
          oh,
          ow,
          kh,
          kw,
          sh,
          sw,
          dh,
          dw,
          pt,
          pl,
          cg,
          mg,
        ];
        const wt = this.graph.consts.get(i1) as Tensor;
        const bias = () =>
          i2 ? (this.graph.consts.get(i2) as Tensor).data : new Float32Array(m);
        const tiles: [number, number] = [Math.ceil(ow / 8), Math.ceil(oh / 8)];
        if (m % 4 === 0 && mg % 4 === 0) {
          step(
            CONV4,
            params,
            [
              x.buf,
              this.constant(`${i1}#4`, () => pack4(wt.data, m)),
              this.constant(`${node.outputs[0]}#bias`, bias),
              y.buf,
            ],
            [...tiles, (n * m) / 4],
          );
        } else {
          step(
            CONV1,
            params,
            [
              x.buf,
              input(i1).buf,
              this.constant(`${node.outputs[0]}#bias`, bias),
              y.buf,
            ],
            [...tiles, n * m],
          );
        }
        return fresh(y);
      }
      case 'ConvTranspose': {
        const x = input(i0);
        const [n, c, h, w] = x.shape;
        const [, m, kh, kw] = this.graph.consts.get(i1)!.shape;
        if (attr(node, 'group', 1) !== 1)
          throw new Error('ConvTranspose: groups');
        const [sh, sw] = attr(node, 'strides', [1, 1]);
        const [pt, pl, pb, pr] = attr(node, 'pads', [0, 0, 0, 0]);
        const [oph, opw] = attr(node, 'output_padding', [0, 0]);
        const oh = (h - 1) * sh - pt - pb + kh + oph;
        const ow = (w - 1) * sw - pl - pr + kw + opw;
        const y = own([n, m, oh, ow]);
        step(
          CONV_TRANSPOSE,
          [c, h, w, m, oh, ow, kh, kw, sh, sw, pt, pl],
          [
            x.buf,
            input(i1).buf,
            this.constant(`${node.outputs[0]}#bias`, () =>
              i2
                ? (this.graph.consts.get(i2) as Tensor).data
                : new Float32Array(m),
            ),
            y.buf,
          ],
          [Math.ceil(ow / 8), Math.ceil(oh / 8), n * m],
        );
        return fresh(y);
      }
      case 'Add':
      case 'Sub':
      case 'Mul':
      case 'Div':
      case 'Pow': {
        const a = input(i0);
        const b = input(i1);
        const shape = broadcastShape(a.shape, b.shape);
        const y = own(shape);
        const n = sizeOf(shape);
        const c = collapse(
          shape,
          broadcastStrides(a.shape, shape),
          broadcastStrides(b.shape, shape),
        );
        step(
          BINARY,
          [
            n,
            BINARY_OPS[node.op],
            ...c.shape,
            ...c.strides[0],
            ...c.strides[1],
          ],
          [a.buf, b.buf, y.buf],
          flat(n),
        );
        return fresh(y);
      }
      case 'Relu':
      case 'Sigmoid':
      case 'HardSigmoid':
      case 'Erf':
      case 'Sqrt': {
        const x = input(i0);
        const y = own(x.shape);
        const n = sizeOf(x.shape);
        step(
          UNARY,
          [
            n,
            UNARY_OPS[node.op],
            f32bits(attr(node, 'alpha', 0.2)),
            f32bits(attr(node, 'beta', 0.5)),
          ],
          [x.buf, y.buf],
          flat(n),
        );
        return fresh(y);
      }
      case 'ChannelAffine': {
        const x = input(i0);
        const y = own(x.shape);
        const n = sizeOf(x.shape);
        step(
          AFFINE,
          [n, x.shape[1], sizeOf(x.shape.slice(2))],
          [x.buf, input(i1).buf, input(node.inputs[2]).buf, y.buf],
          flat(n),
        );
        return fresh(y);
      }
      case 'GlobalAveragePool':
      case 'ReduceMean': {
        const x = input(i0);
        const rank = x.shape.length;
        const axes = (
          node.op === 'GlobalAveragePool'
            ? x.shape.slice(2).map((_, i) => i + 2)
            : attr(
                node,
                'axes',
                x.shape.map((_, i) => i),
              )
        )
          .map(a => axis(a, rank))
          .sort((a, b) => a - b);
        for (let i = 1; i < axes.length; i++) {
          if (axes[i] !== axes[i - 1] + 1) {
            throw new Error('ReduceMean: axes not contiguous');
          }
        }
        const first = axes[0];
        const last = axes[axes.length - 1];
        const red = sizeOf(x.shape.slice(first, last + 1));
        const inner = sizeOf(x.shape.slice(last + 1));
        const keep =
          node.op === 'GlobalAveragePool' || attr(node, 'keepdims', 1) === 1;
        const shape = keep
          ? x.shape.map((d, i) => (axes.includes(i) ? 1 : d))
          : x.shape.filter((_, i) => !axes.includes(i));
        const y = own(shape);
        const outputs = sizeOf(shape);
        step(REDUCE_MEAN, [outputs, red, inner], [x.buf, y.buf], grid(outputs));
        return fresh(y);
      }
      case 'AveragePool':
      case 'MaxPool': {
        const x = input(i0);
        const [n, c, h, w] = x.shape;
        const [kh, kw] = attr(node, 'kernel_shape', [1, 1]);
        const [sh, sw] = attr(node, 'strides', [1, 1]);
        let [pt, pl, pb, pr] = attr(node, 'pads', [0, 0, 0, 0]);
        const autoPad = attr<string>(node, 'auto_pad', 'NOTSET');
        let oh: number;
        let ow: number;
        if (autoPad === 'SAME_UPPER' || autoPad === 'SAME_LOWER') {
          oh = Math.ceil(h / sh);
          ow = Math.ceil(w / sw);
          const ph = Math.max(0, (oh - 1) * sh + kh - h);
          const pw = Math.max(0, (ow - 1) * sw + kw - w);
          const upper = autoPad === 'SAME_UPPER';
          [pt, pb] = upper
            ? [ph >> 1, ph - (ph >> 1)]
            : [ph - (ph >> 1), ph >> 1];
          [pl, pr] = upper
            ? [pw >> 1, pw - (pw >> 1)]
            : [pw - (pw >> 1), pw >> 1];
        } else {
          const r = attr(node, 'ceil_mode', 0) ? Math.ceil : Math.floor;
          oh = r((h + pt + pb - kh) / sh) + 1;
          ow = r((w + pl + pr - kw) / sw) + 1;
        }
        const y = own([n, c, oh, ow]);
        step(
          POOL,
          [
            n * c,
            h,
            w,
            oh,
            ow,
            kh,
            kw,
            sh,
            sw,
            pt,
            pl,
            node.op === 'MaxPool' ? 1 : 0,
            attr(node, 'count_include_pad', 0),
          ],
          [x.buf, y.buf],
          [Math.ceil(ow / 8), Math.ceil(oh / 8), n * c],
        );
        return fresh(y);
      }
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
        const x = input(i0);
        const sizes = node.inputs[3] ? ints(node.inputs[3]) : undefined;
        const scales = sizes ? sizes.map((d, i) => d / x.shape[i]) : ints(i2);
        const shape = sizes ?? x.shape.map((d, i) => Math.floor(d * scales[i]));
        const y = own(shape);
        const pad = (a: number[], v: number) => [
          ...new Array(RANK - a.length).fill(v),
          ...a,
        ];
        const n = sizeOf(shape);
        step(
          RESIZE,
          [
            n,
            ...pad(x.shape, 1),
            ...pad(shape, 1),
            ...pad(scales, 1).map(f32bits),
          ],
          [x.buf, y.buf],
          flat(n),
        );
        return fresh(y);
      }
      case 'Concat': {
        const parts = node.inputs.map(input);
        const rank = parts[0].shape.length;
        const a = axis(attr(node, 'axis', 0), rank);
        const shape = [...parts[0].shape];
        shape[a] = parts.reduce((s, p) => s + p.shape[a], 0);
        const y = own(shape);
        const ys = strides(shape);
        let offset = 0;
        for (const p of parts) {
          copy(p, y, p.shape, 0, strides(p.shape), offset * ys[a], ys);
          offset += p.shape[a];
        }
        return fresh(y);
      }
      case 'MatMul': {
        const a = input(i0);
        const b = input(i1);
        const ar = a.shape.length;
        const br = b.shape.length;
        if (ar < 2 || br < 2) throw new Error('MatMul: rank < 2');
        const [m, k] = a.shape.slice(-2);
        const n = b.shape[br - 1];
        const aBatch = a.shape.slice(0, -2);
        const bBatch = b.shape.slice(0, -2);
        const batch = broadcastShape(aBatch, bBatch);
        const nb = sizeOf(batch);
        const stride = (own: number[], size: number) => {
          if (sizeOf(own) === nb) return size;
          if (sizeOf(own) === 1) return 0;
          throw new Error('MatMul: partial batch broadcast');
        };
        const y = own([...batch, m, n]);
        step(
          MATMUL,
          [m, n, k, stride(aBatch, m * k), stride(bBatch, k * n)],
          [a.buf, b.buf, y.buf],
          [Math.ceil(n / 16), Math.ceil(m / 16), nb],
        );
        return fresh(y);
      }
      case 'Softmax': {
        const x = input(i0);
        const rank = x.shape.length;
        if (axis(attr(node, 'axis', -1), rank) !== rank - 1) {
          throw new Error('Softmax: not the last axis');
        }
        const y = own(x.shape);
        const len = x.shape[rank - 1];
        const rows = sizeOf(x.shape) / len;
        step(SOFTMAX, [rows, len], [x.buf, y.buf], grid(rows));
        return fresh(y);
      }
      case 'Transpose': {
        const x = input(i0);
        const perm = attr(node, 'perm', x.shape.map((_, i) => i).reverse());
        const shape = perm.map(p => x.shape[p]);
        const xs = strides(x.shape);
        const y = own(shape);
        copy(
          x,
          y,
          shape,
          0,
          perm.map(p => xs[p]),
          0,
          strides(shape),
        );
        return fresh(y);
      }
      case 'Reshape': {
        const x = input(i0);
        return alias(x, reshapeShape(x.shape, ints(i1)));
      }
      case 'Squeeze': {
        const x = input(i0);
        const rank = x.shape.length;
        const axes = new Set(
          attr(
            node,
            'axes',
            x.shape.flatMap((d, i) => (d === 1 ? [i] : [])),
          ).map(a => axis(a, rank)),
        );
        return alias(
          x,
          x.shape.filter((_, i) => !axes.has(i)),
        );
      }
      case 'Unsqueeze': {
        const x = input(i0);
        const list = attr<number[]>(node, 'axes', []);
        const rank = x.shape.length + list.length;
        const shape = [...x.shape];
        for (const a of list.map(a => axis(a, rank)).sort((p, q) => p - q)) {
          shape.splice(a, 0, 1);
        }
        return alias(x, shape);
      }
      case 'Slice': {
        const x = input(i0);
        const rank = x.shape.length;
        const starts = ints(i1);
        const ends = ints(i2);
        const axesList = node.inputs[3] ? ints(node.inputs[3]) : undefined;
        const stepList = node.inputs[4] ? ints(node.inputs[4]) : undefined;
        const ranges = x.shape.map(d => ({start: 0, step: 1, count: d}));
        starts.forEach((s, i) => {
          const a = axis(axesList?.[i] ?? i, rank);
          ranges[a] = sliceRange(x.shape[a], s, ends[i], stepList?.[i] ?? 1);
        });
        if (ranges.some(r => r.step < 0))
          throw new Error('Slice: negative step');
        const shape = ranges.map(r => r.count);
        const xs = strides(x.shape);
        const y = own(shape);
        copy(
          x,
          y,
          shape,
          ranges.reduce((s, r, d) => s + r.start * xs[d], 0),
          ranges.map((r, d) => r.step * xs[d]),
          0,
          strides(shape),
        );
        return fresh(y);
      }
      case 'Shape':
        return {
          value: {shape: [input(i0).shape.length], ints: [...input(i0).shape]},
        };
      default:
        throw new Error(`unsupported operator ${node.op}`);
    }
  }
}
