import type {Model, Op} from './model.ts';

// WebGPU flag values (fixed by the spec). TypeScript's DOM library has the
// WebGPU types but not these constants.
const BufferUsage = {
  MAP_READ: 0x1,
  COPY_SRC: 0x4,
  COPY_DST: 0x8,
  UNIFORM: 0x40,
  STORAGE: 0x80,
} as const;
const MAP_READ = 0x1;

/** Shape of an activation: channels × height × width. */
interface Shape {
  c: number;
  h: number;
  w: number;
}

/** Output shapes of every value, computed from the model spec. */
export function inferShapes(model: Model): Map<string, Shape> {
  const {spec} = model;
  const [c, h, w] = spec.input.shape;
  const shapes = new Map<string, Shape>([[spec.input.name, {c, h, w}]]);
  for (const op of spec.ops) {
    switch (op.op) {
      case 'conv': {
        const x = shapes.get(op.input)!;
        const [oc] = spec.tensors[op.weight].shape;
        shapes.set(op.output, {
          c: oc,
          h: Math.floor((x.h + 2 * op.pad - op.kernel) / op.stride) + 1,
          w: Math.floor((x.w + 2 * op.pad - op.kernel) / op.stride) + 1,
        });
        break;
      }
      case 'add':
        shapes.set(op.output, shapes.get(op.a)!);
        break;
      case 'scaleShift':
        shapes.set(op.output, shapes.get(op.input)!);
        break;
      case 'globalAvgPool':
        shapes.set(op.output, {c: shapes.get(op.input)!.c, h: 1, w: 1});
        break;
      case 'linear':
        shapes.set(op.output, {
          c: spec.tensors[op.weight].shape[0],
          h: 1,
          w: 1,
        });
        break;
    }
  }
  return shapes;
}

/**
 * Each invocation computes four output channels of one output pixel, so
 * every input value read is used four times. Weights are laid out as
 * [oc / 4][ic][k * k] vec4s (see packConvWeights).
 */
const CONV = /* wgsl */ `
struct Params {
  ic: u32, ih: u32, iw: u32,
  oc: u32, oh: u32, ow: u32,
  k: u32, stride: u32, pad: u32, relu: u32,
}
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> x: array<f32>;
@group(0) @binding(2) var<storage, read> w: array<vec4f>;
@group(0) @binding(3) var<storage, read> bias: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> y: array<f32>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let ox = id.x;
  let oy = id.y;
  let ob = id.z;
  if (ox >= p.ow || oy >= p.oh) { return; }
  var acc = bias[ob];
  let kk = p.k * p.k;
  let x0 = i32(ox * p.stride) - i32(p.pad);
  let y0 = i32(oy * p.stride) - i32(p.pad);
  for (var i = 0u; i < p.ic; i++) {
    let wBase = (ob * p.ic + i) * kk;
    let xBase = i * p.ih;
    for (var ky = 0u; ky < p.k; ky++) {
      let iy = y0 + i32(ky);
      if (iy < 0 || iy >= i32(p.ih)) { continue; }
      let row = (xBase + u32(iy)) * p.iw;
      for (var kx = 0u; kx < p.k; kx++) {
        let ix = x0 + i32(kx);
        if (ix < 0 || ix >= i32(p.iw)) { continue; }
        acc += x[row + u32(ix)] * w[wBase + ky * p.k + kx];
      }
    }
  }
  if (p.relu != 0u) { acc = max(acc, vec4f(0.0)); }
  let plane = p.oh * p.ow;
  let o = (ob * 4u * p.oh + oy) * p.ow + ox;
  y[o] = acc.x;
  y[o + plane] = acc.y;
  y[o + 2u * plane] = acc.z;
  y[o + 3u * plane] = acc.w;
}`;

const ADD = /* wgsl */ `
struct Params { n: u32 }
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> a: array<f32>;
@group(0) @binding(2) var<storage, read> b: array<f32>;
@group(0) @binding(3) var<storage, read_write> y: array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x < p.n) { y[id.x] = a[id.x] + b[id.x]; }
}`;

const SCALE_SHIFT = /* wgsl */ `
struct Params { n: u32, hw: u32, relu: u32 }
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> x: array<f32>;
@group(0) @binding(2) var<storage, read> scale: array<f32>;
@group(0) @binding(3) var<storage, read> shift: array<f32>;
@group(0) @binding(4) var<storage, read_write> y: array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= p.n) { return; }
  let c = id.x / p.hw;
  var v = x[id.x] * scale[c] + shift[c];
  if (p.relu != 0u) { v = max(v, 0.0); }
  y[id.x] = v;
}`;

const GLOBAL_AVG_POOL = /* wgsl */ `
struct Params { c: u32, hw: u32 }
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> x: array<f32>;
@group(0) @binding(2) var<storage, read_write> y: array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= p.c) { return; }
  var sum = 0.0;
  for (var i = 0u; i < p.hw; i++) { sum += x[id.x * p.hw + i]; }
  y[id.x] = sum / f32(p.hw);
}`;

const LINEAR = /* wgsl */ `
struct Params { inF: u32, outF: u32 }
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> x: array<f32>;
@group(0) @binding(2) var<storage, read> w: array<f32>;
@group(0) @binding(3) var<storage, read> b: array<f32>;
@group(0) @binding(4) var<storage, read_write> y: array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= p.outF) { return; }
  var sum = b[id.x];
  let base = id.x * p.inF;
  for (var i = 0u; i < p.inF; i++) { sum += w[base + i] * x[i]; }
  y[id.x] = sum;
}`;

/** OIHW conv weights → [oc / 4][ic][k * k][4], padding oc to a multiple of 4. */
export function packConvWeights(
  w: Float32Array,
  oc: number,
  ic: number,
  kk: number,
): Float32Array {
  const blocks = Math.ceil(oc / 4);
  const out = new Float32Array(blocks * ic * kk * 4);
  for (let o = 0; o < oc; o++) {
    const ob = o >> 2;
    const lane = o & 3;
    for (let i = 0; i < ic; i++) {
      for (let t = 0; t < kk; t++) {
        out[((ob * ic + i) * kk + t) * 4 + lane] = w[(o * ic + i) * kk + t];
      }
    }
  }
  return out;
}

interface Step {
  pipeline: GPUComputePipeline;
  bindGroup: GPUBindGroup;
  workgroups: [number, number, number];
}

/** Runs a model with WebGPU compute shaders. */
export class WebGpuEngine {
  private readonly device: GPUDevice;
  private readonly steps: Step[];
  private readonly input: GPUBuffer;
  private readonly output: GPUBuffer;
  private readonly readback: GPUBuffer;
  private readonly outputSize: number;

  private constructor(
    device: GPUDevice,
    steps: Step[],
    input: GPUBuffer,
    output: GPUBuffer,
    outputSize: number,
  ) {
    this.device = device;
    this.steps = steps;
    this.input = input;
    this.output = output;
    this.outputSize = outputSize;
    this.readback = device.createBuffer({
      size: outputSize * 4,
      usage: BufferUsage.MAP_READ | BufferUsage.COPY_DST,
    });
  }

  /** Returns undefined if WebGPU isn't available. */
  static async create(model: Model): Promise<WebGpuEngine | undefined> {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) return undefined;
    const device = await adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      },
    });
    const shapes = inferShapes(model);
    const size = (s: Shape) => s.c * s.h * s.w;

    const buffer = (data: Float32Array | number, usage = 0) => {
      const bytes = typeof data === 'number' ? data * 4 : data.byteLength;
      const b = device.createBuffer({
        size: Math.max(16, Math.ceil(bytes / 16) * 16),
        usage: BufferUsage.STORAGE | usage,
        mappedAtCreation: typeof data !== 'number',
      });
      if (typeof data !== 'number') {
        new Float32Array(b.getMappedRange()).set(data);
        b.unmap();
      }
      return b;
    };
    const uniform = (values: number[]) => {
      const b = device.createBuffer({
        size: Math.ceil((values.length * 4) / 16) * 16,
        usage: BufferUsage.UNIFORM,
        mappedAtCreation: true,
      });
      new Uint32Array(b.getMappedRange()).set(values);
      b.unmap();
      return b;
    };
    const pipelines = new Map<string, GPUComputePipeline>();
    const pipeline = (code: string) => {
      let p = pipelines.get(code);
      if (!p) {
        p = device.createComputePipeline({
          layout: 'auto',
          compute: {
            module: device.createShaderModule({code}),
            entryPoint: 'main',
          },
        });
        pipelines.set(code, p);
      }
      return p;
    };

    const values = new Map<string, GPUBuffer>();
    const input = buffer(
      size(shapes.get(model.spec.input.name)!),
      BufferUsage.COPY_DST,
    );
    values.set(model.spec.input.name, input);
    const value = (name: string) => {
      const v = values.get(name);
      if (!v) throw new Error(`missing value ${name}`);
      return v;
    };
    const out = (op: Op, usage = 0) => {
      const b = buffer(size(shapes.get(op.output)!), usage);
      values.set(op.output, b);
      return b;
    };
    const tensor = (name: string) => model.tensors.get(name)!;

    const steps: Step[] = [];
    const step = (
      code: string,
      params: number[],
      buffers: GPUBuffer[],
      workgroups: [number, number, number],
    ) => {
      const p = pipeline(code);
      const entries = [uniform(params), ...buffers].map((b, binding) => ({
        binding,
        resource: {buffer: b},
      }));
      steps.push({
        pipeline: p,
        bindGroup: device.createBindGroup({
          layout: p.getBindGroupLayout(0),
          entries,
        }),
        workgroups,
      });
    };

    const outputName = model.spec.output;
    for (const op of model.spec.ops) {
      const outUsage = op.output === outputName ? BufferUsage.COPY_SRC : 0;
      switch (op.op) {
        case 'conv': {
          const x = shapes.get(op.input)!;
          const o = shapes.get(op.output)!;
          const kk = op.kernel * op.kernel;
          if (o.c % 4 !== 0)
            throw new Error('conv output channels must be a multiple of 4');
          const blocks = o.c / 4;
          const bias = new Float32Array(blocks * 4);
          if (op.bias) bias.set(tensor(op.bias));
          step(
            CONV,
            [
              x.c,
              x.h,
              x.w,
              o.c,
              o.h,
              o.w,
              op.kernel,
              op.stride,
              op.pad,
              op.relu ? 1 : 0,
            ],
            [
              value(op.input),
              buffer(packConvWeights(tensor(op.weight), o.c, x.c, kk)),
              buffer(bias),
              out(op, outUsage),
            ],
            [Math.ceil(o.w / 8), Math.ceil(o.h / 8), blocks],
          );
          break;
        }
        case 'add': {
          const n = size(shapes.get(op.output)!);
          step(
            ADD,
            [n],
            [value(op.a), value(op.b), out(op, outUsage)],
            [Math.ceil(n / 64), 1, 1],
          );
          break;
        }
        case 'scaleShift': {
          const s = shapes.get(op.output)!;
          const n = size(s);
          step(
            SCALE_SHIFT,
            [n, s.h * s.w, op.relu ? 1 : 0],
            [
              value(op.input),
              buffer(tensor(op.scale)),
              buffer(tensor(op.shift)),
              out(op, outUsage),
            ],
            [Math.ceil(n / 64), 1, 1],
          );
          break;
        }
        case 'globalAvgPool': {
          const x = shapes.get(op.input)!;
          step(
            GLOBAL_AVG_POOL,
            [x.c, x.h * x.w],
            [value(op.input), out(op, outUsage)],
            [Math.ceil(x.c / 64), 1, 1],
          );
          break;
        }
        case 'linear': {
          const [outF, inF] = model.spec.tensors[op.weight].shape;
          step(
            LINEAR,
            [inF, outF],
            [
              value(op.input),
              buffer(tensor(op.weight)),
              buffer(tensor(op.bias)),
              out(op, outUsage),
            ],
            [Math.ceil(outF / 64), 1, 1],
          );
          break;
        }
      }
    }
    return new WebGpuEngine(
      device,
      steps,
      input,
      value(outputName),
      size(shapes.get(outputName)!),
    );
  }

  async run(input: Float32Array): Promise<Float32Array> {
    const {device} = this;
    device.queue.writeBuffer(this.input, 0, input);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    for (const s of this.steps) {
      pass.setPipeline(s.pipeline);
      pass.setBindGroup(0, s.bindGroup);
      pass.dispatchWorkgroups(...s.workgroups);
    }
    pass.end();
    encoder.copyBufferToBuffer(
      this.output,
      0,
      this.readback,
      0,
      this.outputSize * 4,
    );
    device.queue.submit([encoder.finish()]);
    await this.readback.mapAsync(MAP_READ);
    const result = new Float32Array(this.readback.getMappedRange()).slice();
    this.readback.unmap();
    return result;
  }
}
