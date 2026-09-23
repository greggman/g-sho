import type {Model} from './model.ts';
import {inferShapes} from './webgpu.ts';

interface Exports {
  memory: WebAssembly.Memory;
  __heap_base: WebAssembly.Global;
  pad(x: number, c: number, h: number, w: number, p: number, out: number): void;
  conv(
    x: number,
    ic: number,
    ih: number,
    iw: number,
    w: number,
    bias: number,
    oc: number,
    k: number,
    stride: number,
    oh: number,
    ow: number,
    relu: number,
    y: number,
  ): void;
  add(a: number, b: number, n: number, out: number): void;
  scale_shift(
    x: number,
    c: number,
    hw: number,
    scale: number,
    shift: number,
    relu: number,
    out: number,
  ): void;
  global_avg_pool(x: number, c: number, hw: number, out: number): void;
  linear(
    x: number,
    inF: number,
    w: number,
    b: number,
    outF: number,
    out: number,
  ): void;
}

/** OIHW conv weights → [oc / 8][ic][k * k][8], the layout nn.rs expects. */
function packConvWeights8(w: Float32Array, oc: number, ic: number, kk: number) {
  const out = new Float32Array(oc * ic * kk);
  for (let o = 0; o < oc; o++) {
    const ob = o >> 3;
    const lane = o & 7;
    for (let i = 0; i < ic; i++) {
      for (let t = 0; t < kk; t++) {
        out[((ob * ic + i) * kk + t) * 8 + lane] = w[(o * ic + i) * kk + t];
      }
    }
  }
  return out;
}

/**
 * Runs a model with the WebAssembly SIMD kernels in src/wasm/nn.rs, for
 * browsers without WebGPU. All buffers (weights, activations, scratch) are
 * laid out once in the module's memory; a run is then a sequence of calls.
 */
export class WasmEngine {
  private readonly steps: (() => void)[];
  private readonly exports: Exports;
  private readonly inputPtr: number;
  private readonly inputSize: number;
  private readonly outputPtr: number;
  private readonly outputSize: number;

  private constructor(
    exports: Exports,
    steps: (() => void)[],
    input: [number, number],
    output: [number, number],
  ) {
    this.exports = exports;
    this.steps = steps;
    [this.inputPtr, this.inputSize] = input;
    [this.outputPtr, this.outputSize] = output;
  }

  static async create(
    model: Model,
    wasm: BufferSource | WebAssembly.Module,
  ): Promise<WasmEngine> {
    const module =
      wasm instanceof WebAssembly.Module
        ? wasm
        : await WebAssembly.compile(wasm);
    const instance = await WebAssembly.instantiate(module);
    const e = instance.exports as unknown as Exports;
    const shapes = inferShapes(model);
    const {spec} = model;

    // Plan the memory layout: a bump allocator above the Rust heap base.
    let top = e.__heap_base.value as number;
    const pending: [number, Float32Array][] = [];
    const alloc = (floats: number, data?: Float32Array) => {
      const ptr = Math.ceil(top / 16) * 16;
      top = ptr + floats * 4;
      if (data) pending.push([ptr, data]);
      return ptr;
    };
    const t = (name: string) => model.tensors.get(name)!;
    const values = new Map<string, number>();
    const size = (name: string) => {
      const s = shapes.get(name)!;
      return s.c * s.h * s.w;
    };
    const value = (name: string) => values.get(name)!;
    const input = alloc(size(spec.input.name));
    values.set(spec.input.name, input);

    let scratchSize = 0;
    const scratchUsers: ((scratch: number) => () => void)[] = [];
    for (const op of spec.ops) {
      const out = alloc(size(op.output));
      values.set(op.output, out);
      switch (op.op) {
        case 'conv': {
          const x = shapes.get(op.input)!;
          const o = shapes.get(op.output)!;
          if (o.c % 8 !== 0)
            throw new Error('conv output channels must be a multiple of 8');
          const kk = op.kernel * op.kernel;
          const w = alloc(
            o.c * x.c * kk,
            packConvWeights8(t(op.weight), o.c, x.c, kk),
          );
          const bias = alloc(o.c, op.bias ? t(op.bias) : new Float32Array(o.c));
          const ph = x.h + 2 * op.pad;
          const pw = x.w + 2 * op.pad;
          scratchSize = Math.max(scratchSize, x.c * ph * pw);
          const xIn = value(op.input);
          scratchUsers.push(scratch => () => {
            let src = xIn;
            if (op.pad > 0) {
              e.pad(xIn, x.c, x.h, x.w, op.pad, scratch);
              src = scratch;
            }
            e.conv(
              src,
              x.c,
              ph,
              pw,
              w,
              bias,
              o.c,
              op.kernel,
              op.stride,
              o.h,
              o.w,
              op.relu ? 1 : 0,
              out,
            );
          });
          break;
        }
        case 'add': {
          const a = value(op.a);
          const b = value(op.b);
          const n = size(op.output);
          scratchUsers.push(() => () => e.add(a, b, n, out));
          break;
        }
        case 'scaleShift': {
          const s = shapes.get(op.output)!;
          const x = value(op.input);
          const scale = alloc(s.c, t(op.scale));
          const shift = alloc(s.c, t(op.shift));
          scratchUsers.push(
            () => () =>
              e.scale_shift(
                x,
                s.c,
                s.h * s.w,
                scale,
                shift,
                op.relu ? 1 : 0,
                out,
              ),
          );
          break;
        }
        case 'globalAvgPool': {
          const s = shapes.get(op.input)!;
          const x = value(op.input);
          scratchUsers.push(
            () => () => e.global_avg_pool(x, s.c, s.h * s.w, out),
          );
          break;
        }
        case 'linear': {
          const [outF, inF] = spec.tensors[op.weight].shape;
          const x = value(op.input);
          const w = alloc(outF * inF, t(op.weight));
          const b = alloc(outF, t(op.bias));
          scratchUsers.push(() => () => e.linear(x, inF, w, b, outF, out));
          break;
        }
      }
    }
    const scratch = alloc(scratchSize);

    // Grow memory to fit, then copy the weights in.
    const needed = Math.ceil(top / 65536) - e.memory.buffer.byteLength / 65536;
    if (needed > 0) e.memory.grow(needed);
    const heap = new Float32Array(e.memory.buffer);
    for (const [ptr, data] of pending) heap.set(data, ptr / 4);

    return new WasmEngine(
      e,
      scratchUsers.map(make => make(scratch)),
      [input, size(spec.input.name)],
      [value(spec.output), size(spec.output)],
    );
  }

  run(input: Float32Array): Float32Array {
    const heap = () => new Float32Array(this.exports.memory.buffer);
    heap().set(input.subarray(0, this.inputSize), this.inputPtr / 4);
    for (const step of this.steps) step();
    return heap().slice(
      this.outputPtr / 4,
      this.outputPtr / 4 + this.outputSize,
    );
  }
}
