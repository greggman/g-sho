import type {Model} from './model.ts';

/**
 * Straightforward JavaScript implementation of every op. Slow, but simple
 * enough to trust: it's the reference the faster engines are tested against.
 */
export function runCpu(model: Model, input: Float32Array): Float32Array {
  const {spec, tensors} = model;
  const values = new Map<
    string,
    {data: Float32Array; c: number; h: number; w: number}
  >();
  const [c0, h0, w0] = spec.input.shape;
  values.set(spec.input.name, {data: input, c: c0, h: h0, w: w0});
  const t = (name: string) => tensors.get(name)!;
  const v = (name: string) => {
    const x = values.get(name);
    if (!x) throw new Error(`missing value ${name}`);
    return x;
  };

  for (const op of spec.ops) {
    switch (op.op) {
      case 'conv': {
        const x = v(op.input);
        const w = t(op.weight);
        const bias = op.bias ? t(op.bias) : undefined;
        const [oc, ic, k] = spec.tensors[op.weight].shape;
        const oh = Math.floor((x.h + 2 * op.pad - k) / op.stride) + 1;
        const ow = Math.floor((x.w + 2 * op.pad - k) / op.stride) + 1;
        const out = new Float32Array(oc * oh * ow);
        for (let o = 0; o < oc; o++) {
          for (let y = 0; y < oh; y++) {
            for (let xx = 0; xx < ow; xx++) {
              let sum = bias ? bias[o] : 0;
              for (let i = 0; i < ic; i++) {
                for (let ky = 0; ky < k; ky++) {
                  const iy = y * op.stride - op.pad + ky;
                  if (iy < 0 || iy >= x.h) continue;
                  for (let kx = 0; kx < k; kx++) {
                    const ix = xx * op.stride - op.pad + kx;
                    if (ix < 0 || ix >= x.w) continue;
                    sum +=
                      x.data[(i * x.h + iy) * x.w + ix] *
                      w[((o * ic + i) * k + ky) * k + kx];
                  }
                }
              }
              out[(o * oh + y) * ow + xx] = op.relu ? Math.max(0, sum) : sum;
            }
          }
        }
        values.set(op.output, {data: out, c: oc, h: oh, w: ow});
        break;
      }
      case 'add': {
        const a = v(op.a);
        const b = v(op.b);
        const out = new Float32Array(a.data.length);
        for (let i = 0; i < out.length; i++) out[i] = a.data[i] + b.data[i];
        values.set(op.output, {...a, data: out});
        break;
      }
      case 'scaleShift': {
        const x = v(op.input);
        const scale = t(op.scale);
        const shift = t(op.shift);
        const out = new Float32Array(x.data.length);
        const hw = x.h * x.w;
        for (let c = 0; c < x.c; c++) {
          for (let i = c * hw; i < (c + 1) * hw; i++) {
            const y = x.data[i] * scale[c] + shift[c];
            out[i] = op.relu ? Math.max(0, y) : y;
          }
        }
        values.set(op.output, {...x, data: out});
        break;
      }
      case 'globalAvgPool': {
        const x = v(op.input);
        const hw = x.h * x.w;
        const out = new Float32Array(x.c);
        for (let c = 0; c < x.c; c++) {
          let sum = 0;
          for (let i = c * hw; i < (c + 1) * hw; i++) sum += x.data[i];
          out[c] = sum / hw;
        }
        values.set(op.output, {data: out, c: x.c, h: 1, w: 1});
        break;
      }
      case 'linear': {
        const x = v(op.input);
        const w = t(op.weight);
        const b = t(op.bias);
        const [outF, inF] = spec.tensors[op.weight].shape;
        const out = new Float32Array(outF);
        for (let o = 0; o < outF; o++) {
          let sum = b[o];
          for (let i = 0; i < inF; i++) sum += w[o * inF + i] * x.data[i];
          out[o] = sum;
        }
        values.set(op.output, {data: out, c: outF, h: 1, w: 1});
        break;
      }
    }
  }
  return v(spec.output).data;
}
