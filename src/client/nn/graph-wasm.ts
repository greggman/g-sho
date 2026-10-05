/**
 * WebAssembly SIMD kernels (src/wasm/nn.rs) for the graph engine's heaviest
 * operators, convolution and matrix product, for browsers without WebGPU.
 * The rest of the graph runs in graph-cpu.ts, which calls these through its
 * Kernels hook.
 *
 * Memory: a graph's constant weights are copied (packed) into the module's
 * memory on first use and stay there; each call's activations go in a
 * scratch area above them.
 */
import {convGeometry, runGraphCpu, type Kernels} from './graph-cpu.ts';
import type {Graph, GraphNode, Tensor, Value} from './graph.ts';

interface Exports {
  memory: WebAssembly.Memory;
  __heap_base: WebAssembly.Global;
  conv_group(
    x: number,
    cg: number,
    ph: number,
    pw: number,
    w: number,
    bias: number,
    mg: number,
    kh: number,
    kw: number,
    sh: number,
    sw: number,
    dh: number,
    dw: number,
    oh: number,
    ow: number,
    y: number,
  ): void;
  conv_depthwise(
    x: number,
    c: number,
    ph: number,
    pw: number,
    w: number,
    bias: number,
    kh: number,
    kw: number,
    sh: number,
    sw: number,
    dh: number,
    dw: number,
    oh: number,
    ow: number,
    y: number,
  ): void;
  matmul(
    a: number,
    b: number,
    m: number,
    k: number,
    n: number,
    y: number,
  ): void;
}

/** [m][cg][kh][kw] → [m / 8][cg][kh·kw][8], the layout conv_group expects. */
function pack8(w: Float32Array, m: number): Float32Array {
  const per = w.length / m;
  const out = new Float32Array(w.length);
  for (let o = 0; o < m; o++) {
    const base = (o >> 3) * per * 8 + (o & 7);
    for (let i = 0; i < per; i++) out[base + i * 8] = w[o * per + i];
  }
  return out;
}

const align = (p: number) => Math.ceil(p / 16) * 16;

export class WasmKernels {
  private readonly e: Exports;
  /** end of the weights; scratch starts here */
  private top: number;
  /** where each constant (packed or not) is, by its data and layout */
  private readonly placed = new Map<string, WeakMap<Float32Array, number>>();

  private constructor(e: Exports) {
    this.e = e;
    this.top = align(e.__heap_base.value as number);
  }

  static async create(
    wasm: BufferSource | WebAssembly.Module,
  ): Promise<WasmKernels> {
    const module =
      wasm instanceof WebAssembly.Module
        ? wasm
        : await WebAssembly.compile(wasm);
    const instance = await WebAssembly.instantiate(module);
    const e = instance.exports as unknown as Exports;
    if (!e.__heap_base || !e.conv_group) {
      throw new Error('nn.wasm is missing the graph kernels');
    }
    return new WasmKernels(e);
  }

  /** Makes memory reach `end` bytes. */
  private ensure(end: number) {
    const have = this.e.memory.buffer.byteLength;
    if (end > have) this.e.memory.grow(Math.ceil((end - have) / 65536));
  }

  private heap() {
    return new Float32Array(this.e.memory.buffer);
  }

  /** A constant in memory (laid out by `make`), placed once. */
  private constant(
    data: Float32Array,
    layout: string,
    make: () => Float32Array = () => data,
  ): number {
    let map = this.placed.get(layout);
    if (!map) this.placed.set(layout, (map = new WeakMap()));
    let ptr = map.get(data);
    if (ptr === undefined) {
      const v = make();
      ptr = this.top;
      this.top = align(ptr + v.length * 4);
      this.ensure(this.top);
      this.heap().set(v, ptr / 4);
      map.set(data, ptr);
    }
    return ptr;
  }

  /**
   * Kernels for one graph: its constants stay in memory; anything else is
   * copied in for each call.
   */
  kernelsFor(graph: Graph): Kernels {
    const consts = new Set<Float32Array>();
    for (const v of graph.consts.values()) {
      if ('data' in v) consts.add(v.data);
    }
    /** Scratch space for one call, above the weights. */
    const scratch = () => {
      let at = this.top;
      return (floats: number) => {
        const ptr = at;
        at = align(at + floats * 4);
        this.ensure(at);
        return ptr;
      };
    };
    /** zero biases for convolutions without one, by their weights */
    const noBias = new WeakMap<Float32Array, Float32Array>();
    /** Copies a value into scratch space. */
    const copyIn = (t: Float32Array, alloc: (n: number) => number) => {
      const ptr = alloc(t.length);
      this.heap().set(t, ptr / 4);
      return ptr;
    };

    const conv = (
      node: GraphNode,
      x: Tensor,
      w: Tensor,
      b?: Tensor,
    ): Tensor | undefined => {
      const [n, c, h, wd] = x.shape;
      const [m, cg, kh, kw] = w.shape;
      const g = convGeometry(node, x.shape, w.shape);
      const mg = m / g.group;
      const depthwise = cg === 1 && mg === 1;
      if (!depthwise && mg % 8 !== 0) return undefined;
      if (!consts.has(w.data) || (b && !consts.has(b.data))) return undefined;
      // Constants before scratch: placing one moves the scratch start.
      const wPtr = depthwise
        ? this.constant(w.data, 'raw')
        : this.constant(w.data, 'pack8', () => pack8(w.data, m));
      let bias = b?.data ?? noBias.get(w.data);
      if (!bias) noBias.set(w.data, (bias = new Float32Array(m)));
      const bPtr = this.constant(bias, 'raw');
      const alloc = scratch();
      const ph = h + g.pt + g.pb;
      const pw = wd + g.pl + g.pr;
      const {oh, ow} = g;
      const xPtr = alloc(n * c * ph * pw);
      const yPtr = alloc(n * m * oh * ow);
      // The input, padded with zeros.
      const heap = this.heap();
      const x0 = xPtr / 4;
      if (ph === h && pw === wd) {
        heap.set(x.data, x0);
      } else {
        heap.fill(0, x0, x0 + n * c * ph * pw);
        for (let p = 0; p < n * c; p++) {
          for (let y = 0; y < h; y++) {
            const src = (p * h + y) * wd;
            heap.set(
              x.data.subarray(src, src + wd),
              x0 + (p * ph + y + g.pt) * pw + g.pl,
            );
          }
        }
      }
      const e = this.e;
      for (let ni = 0; ni < n; ni++) {
        const xn = xPtr + ni * c * ph * pw * 4;
        const yn = yPtr + ni * m * oh * ow * 4;
        if (depthwise) {
          e.conv_depthwise(
            xn,
            c,
            ph,
            pw,
            wPtr,
            bPtr,
            kh,
            kw,
            g.sh,
            g.sw,
            g.dh,
            g.dw,
            oh,
            ow,
            yn,
          );
          continue;
        }
        for (let gi = 0; gi < g.group; gi++) {
          e.conv_group(
            xn + gi * cg * ph * pw * 4,
            cg,
            ph,
            pw,
            wPtr + gi * mg * cg * kh * kw * 4,
            bPtr + gi * mg * 4,
            mg,
            kh,
            kw,
            g.sh,
            g.sw,
            g.dh,
            g.dw,
            oh,
            ow,
            yn + gi * mg * oh * ow * 4,
          );
        }
      }
      const y0 = yPtr / 4;
      return {
        shape: [n, m, oh, ow],
        data: this.heap().slice(y0, y0 + n * m * oh * ow),
      };
    };

    const matmul = (a: Tensor, b: Tensor): Tensor | undefined => {
      const ar = a.shape.length;
      const br = b.shape.length;
      if (ar < 2 || br < 2) return undefined;
      const [m, k] = a.shape.slice(-2);
      const n = b.shape[br - 1];
      const aBatch = a.data.length / (m * k);
      const bBatch = b.data.length / (k * n);
      const batch = Math.max(aBatch, bBatch);
      if (
        (aBatch !== batch && aBatch !== 1) ||
        (bBatch !== batch && bBatch !== 1)
      ) {
        return undefined;
      }
      const shape = [
        ...(aBatch >= bBatch ? a.shape : b.shape).slice(0, -2),
        m,
        n,
      ];
      if (shape.slice(0, -2).reduce((p, q) => p * q, 1) !== batch) {
        return undefined;
      }
      // Constants first (they move the scratch start), then scratch.
      const bConst = consts.has(b.data) ? this.constant(b.data, 'raw') : -1;
      const aConst = consts.has(a.data) ? this.constant(a.data, 'raw') : -1;
      const alloc = scratch();
      const aPtr = aConst >= 0 ? aConst : copyIn(a.data, alloc);
      const bPtr = bConst >= 0 ? bConst : copyIn(b.data, alloc);
      const yPtr = alloc(batch * m * n);
      for (let i = 0; i < batch; i++) {
        this.e.matmul(
          aPtr + (aBatch === 1 ? 0 : i * m * k * 4),
          bPtr + (bBatch === 1 ? 0 : i * k * n * 4),
          m,
          k,
          n,
          yPtr + i * m * n * 4,
        );
      }
      const y0 = yPtr / 4;
      return {shape, data: this.heap().slice(y0, y0 + batch * m * n)};
    };

    return {conv, matmul};
  }

  /** Runs a graph with these kernels (and graph-cpu.ts for the rest). */
  runner(graph: Graph) {
    const kernels = this.kernelsFor(graph);
    return (inputs: Record<string, Tensor>): Map<string, Value> =>
      runGraphCpu(graph, inputs, undefined, kernels);
  }
}
