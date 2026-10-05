/**
 * Converts an ONNX model to our graph format (src/client/nn/graph.ts),
 * keeping ONNX's operators and semantics. Along the way:
 *
 * - Identity nodes are dropped (their outputs alias their inputs).
 * - A BatchNormalization right after a Conv (and only used there) is folded
 *   into the conv's weights and bias; any other becomes a per-channel
 *   scale/shift (op "ChannelAffine").
 * - Weights are stored as fp16; small float constants (≤ 64 values, e.g.
 *   LayerNorm's epsilon) and integer constants go in the JSON exactly.
 * - Only the operators the engine implements are accepted.
 */
import type {AttrValue, GraphNode, GraphSpec} from '../src/client/nn/graph.ts';
import {f16ToF32, f32ToF16} from '../src/client/nn/model.ts';
import {DataType, type OnnxGraph, type OnnxTensor} from './onnx.ts';

export const SUPPORTED = new Set([
  'Conv',
  'ConvTranspose',
  'Add',
  'Sub',
  'Mul',
  'Div',
  'Pow',
  'Relu',
  'Sigmoid',
  'HardSigmoid',
  'Erf',
  'Sqrt',
  'GlobalAveragePool',
  'AveragePool',
  'MaxPool',
  'ReduceMean',
  'Resize',
  'Concat',
  'MatMul',
  'Softmax',
  'Transpose',
  'Reshape',
  'Slice',
  'Squeeze',
  'Unsqueeze',
  'Shape',
  'ChannelAffine',
]);

const SMALL = 64;

function toFloat32(t: OnnxTensor): Float32Array {
  const bytes = t.raw.slice();
  if (t.dataType === DataType.FLOAT16) {
    return f16ToF32(new Uint16Array(bytes.buffer));
  }
  if (t.dataType === DataType.FLOAT) return new Float32Array(bytes.buffer);
  throw new Error(`tensor ${t.name}: unsupported data type ${t.dataType}`);
}

function toInts(t: OnnxTensor): number[] {
  if (t.dataType !== DataType.INT64) {
    throw new Error(`tensor ${t.name}: expected int64`);
  }
  return Array.from(new BigInt64Array(t.raw.slice().buffer), Number);
}

export function convertGraph(
  graph: OnnxGraph,
  /** keep every weight exactly (float32, in the JSON): for testing operators */
  exact = false,
): {
  spec: GraphSpec;
  weights: Uint8Array;
} {
  const alias = new Map<string, string>();
  const resolve = (name: string) => {
    while (alias.has(name)) name = alias.get(name)!;
    return name;
  };
  const uses = new Map<string, number>();
  for (const n of graph.nodes) {
    for (const i of n.inputs) uses.set(i, (uses.get(i) ?? 0) + 1);
  }
  for (const o of graph.outputs) uses.set(o, (uses.get(o) ?? 0) + 1);

  const halfs: number[] = [];
  const spec: GraphSpec = {
    inputs: graph.inputs.filter(i => !graph.initializers.has(i)),
    outputs: [],
    nodes: [],
    weights: {},
    floats: {},
    ints: {},
  };
  const addFloat = (name: string, data: Float32Array, shape: number[]) => {
    if (data.length <= SMALL || exact) {
      spec.floats[name] = {shape, data: Array.from(data)};
    } else {
      spec.weights[name] = {offset: halfs.length, shape};
      for (const v of data) halfs.push(f32ToF16(v));
    }
  };
  const used = new Set<string>();
  const constant = (name: string) => {
    if (!name || used.has(name)) return;
    const t = graph.initializers.get(name);
    if (!t) return;
    used.add(name);
    if (t.dataType === DataType.INT64) {
      spec.ints[name] = {shape: t.dims, data: toInts(t)};
    } else {
      addFloat(name, toFloat32(t), t.dims);
    }
  };

  // Batch norms folded into the conv before them: conv output → fold.
  const folded = new Map<string, {scale: Float32Array; shift: Float32Array}>();
  const bnParams = (n: (typeof graph.nodes)[number]) => {
    const eps = (n.attributes.epsilon as number | undefined) ?? 1e-5;
    const [gamma, beta, mean, variance] = n.inputs
      .slice(1)
      .map(i => toFloat32(graph.initializers.get(i)!));
    const scale = gamma.map((g, c) => g / Math.sqrt(variance[c] + eps));
    const shift = beta.map((b, c) => b - mean[c] * scale[c]);
    return {scale, shift};
  };
  const producer = new Map<string, (typeof graph.nodes)[number]>();
  for (const n of graph.nodes) for (const o of n.outputs) producer.set(o, n);
  for (const n of graph.nodes) {
    if (n.opType !== 'BatchNormalization') continue;
    const p = producer.get(n.inputs[0]);
    if (
      p?.opType === 'Conv' &&
      uses.get(n.inputs[0]) === 1 &&
      graph.initializers.has(p.inputs[1])
    ) {
      folded.set(p.outputs[0], bnParams(n));
      alias.set(n.outputs[0], p.outputs[0]);
    }
  }

  for (const n of graph.nodes) {
    if (n.opType === 'Identity') {
      alias.set(n.outputs[0], n.inputs[0]);
      continue;
    }
    if (n.opType === 'BatchNormalization') {
      if (alias.has(n.outputs[0])) continue; // folded
      const {scale, shift} = bnParams(n);
      const s = `${n.outputs[0]}.scale`;
      const h = `${n.outputs[0]}.shift`;
      addFloat(s, scale, [scale.length]);
      addFloat(h, shift, [shift.length]);
      spec.nodes.push({
        op: 'ChannelAffine',
        inputs: [resolve(n.inputs[0]), s, h],
        outputs: n.outputs,
      });
      continue;
    }
    if (!SUPPORTED.has(n.opType)) {
      throw new Error(`unsupported operator ${n.opType}`);
    }
    const inputs = n.inputs.map(i => (i ? resolve(i) : ''));
    const bn = n.opType === 'Conv' ? folded.get(n.outputs[0]) : undefined;
    if (bn) {
      // y = scale * (W x + b) + shift
      const w = toFloat32(graph.initializers.get(n.inputs[1])!);
      const dims = graph.initializers.get(n.inputs[1])!.dims;
      const per = w.length / dims[0];
      for (let o = 0; o < dims[0]; o++) {
        for (let i = 0; i < per; i++) w[o * per + i] *= bn.scale[o];
      }
      const b0 = n.inputs[2]
        ? toFloat32(graph.initializers.get(n.inputs[2])!)
        : new Float32Array(dims[0]);
      const b = b0.map((v, o) => v * bn.scale[o] + bn.shift[o]);
      const wName = `${n.outputs[0]}.w`;
      const bName = `${n.outputs[0]}.b`;
      addFloat(wName, w, dims);
      addFloat(bName, b, [b.length]);
      inputs[1] = wName;
      inputs[2] = bName;
    } else {
      for (const i of inputs) constant(i);
    }
    const attrs: Record<string, AttrValue> = {};
    for (const [k, v] of Object.entries(n.attributes)) {
      if (typeof v === 'number' || typeof v === 'string' || Array.isArray(v)) {
        attrs[k] = v;
      }
    }
    const node: GraphNode = {op: n.opType, inputs, outputs: n.outputs};
    if (Object.keys(attrs).length) node.attrs = attrs;
    spec.nodes.push(node);
  }
  spec.outputs = graph.outputs.map(resolve);
  return {spec, weights: new Uint8Array(new Uint16Array(halfs).buffer)};
}
