/**
 * Our own format for small convolutional networks: model.json describes the
 * operations in execution order, and weights.bin holds every tensor as
 * little-endian fp16. Activations are single images in CHW layout.
 */

export interface TensorInfo {
  /** offset into weights.bin, in fp16 elements */
  offset: number;
  shape: number[];
}

export type Op =
  | {
      op: 'conv';
      input: string;
      output: string;
      /** [outChannels, inChannels, kernel, kernel] */
      weight: string;
      bias?: string;
      kernel: number;
      stride: number;
      pad: number;
      relu: boolean;
    }
  | {op: 'add'; a: string; b: string; output: string}
  /** Per-channel x * scale + shift (an inference-time batch norm). */
  | {
      op: 'scaleShift';
      input: string;
      output: string;
      scale: string;
      shift: string;
      relu: boolean;
    }
  | {op: 'globalAvgPool'; input: string; output: string}
  /** y = W x + b, W is [outFeatures, inFeatures] */
  | {op: 'linear'; input: string; output: string; weight: string; bias: string};

export interface ModelSpec {
  input: {
    name: string;
    shape: [channels: number, height: number, width: number];
  };
  output: string;
  ops: Op[];
  tensors: Record<string, TensorInfo>;
}

export interface Model {
  spec: ModelSpec;
  /** every tensor, decoded to float32 */
  tensors: Map<string, Float32Array>;
}

const f16Table = (() => {
  const t = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const sign = h & 0x8000 ? -1 : 1;
    const exp = (h >> 10) & 0x1f;
    const frac = h & 0x3ff;
    t[h] =
      exp === 0
        ? sign * 2 ** -14 * (frac / 1024)
        : exp === 31
          ? frac
            ? NaN
            : sign * Infinity
          : sign * 2 ** (exp - 15) * (1 + frac / 1024);
  }
  return t;
})();

export function f16ToF32(bits: Uint16Array): Float32Array {
  const out = new Float32Array(bits.length);
  for (let i = 0; i < bits.length; i++) out[i] = f16Table[bits[i]];
  return out;
}

const f32Scratch = new Float32Array(1);
const u32Scratch = new Uint32Array(f32Scratch.buffer);

/** float32 → fp16 bits, rounding to nearest even. */
export function f32ToF16(value: number): number {
  f32Scratch[0] = value;
  const x = u32Scratch[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
  let e = exp - 127 + 15;
  if (e >= 31) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - e;
    let half = mant >>> shift;
    const rem = mant & ((1 << shift) - 1);
    const mid = 1 << (shift - 1);
    if (rem > mid || (rem === mid && half & 1)) half++;
    return sign | half;
  }
  let half = (e << 10) | (mant >>> 13);
  const rem = mant & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && half & 1)) half++;
  e = half >>> 10;
  return sign | half;
}

/** Decodes weights.bin into one float32 array per tensor. */
export function decodeModel(spec: ModelSpec, weights: ArrayBuffer): Model {
  const all = new Uint16Array(weights);
  const tensors = new Map<string, Float32Array>();
  for (const [name, info] of Object.entries(spec.tensors)) {
    const size = info.shape.reduce((a, b) => a * b, 1);
    tensors.set(name, f16ToF32(all.subarray(info.offset, info.offset + size)));
  }
  return {spec, tensors};
}

export async function loadModel(baseUrl: URL): Promise<Model> {
  const [spec, weights] = await Promise.all([
    fetch(new URL('model.json', baseUrl)).then(
      r => r.json() as Promise<ModelSpec>,
    ),
    fetch(new URL('weights.bin', baseUrl)).then(r => {
      if (!r.ok) throw new Error(`weights.bin: ${r.status}`);
      return r.arrayBuffer();
    }),
  ]);
  return decodeModel(spec, weights);
}
