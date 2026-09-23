/**
 * Converts the network part of an ONNX model to our own format
 * (src/client/nn/model.ts): Conv, Relu, Add, BatchNormalization, global
 * ReduceMean and Gemm, with ReLUs fused into the op before them and batch
 * norms turned into per-channel scale/shift.
 *
 * Everything before `startTensor` (e.g. in-graph preprocessing) is dropped;
 * the caller reimplements it.
 */
import type {ModelSpec, Op, TensorInfo} from '../src/client/nn/model.ts';
import {f16ToF32, f32ToF16} from '../src/client/nn/model.ts';
import {DataType, type OnnxGraph, type OnnxTensor} from './onnx.ts';

function toFloat32(t: OnnxTensor): Float32Array {
  const bytes = t.raw.slice(); // copy to get an aligned buffer
  if (t.dataType === DataType.FLOAT16)
    return f16ToF32(new Uint16Array(bytes.buffer));
  if (t.dataType === DataType.FLOAT) return new Float32Array(bytes.buffer);
  throw new Error(`tensor ${t.name}: unsupported data type ${t.dataType}`);
}

function ints(v: unknown, name: string): number[] {
  if (!Array.isArray(v)) throw new Error(`expected ints for ${name}`);
  return v as number[];
}

export function convertOnnx(
  graph: OnnxGraph,
  startTensor: string,
  inputShape: [number, number, number],
): {spec: ModelSpec; weights: Uint8Array} {
  // Casts and Reshapes are no-ops for us: follow them to the real tensor.
  const alias = new Map<string, string>();
  const resolve = (name: string) => {
    while (alias.has(name)) name = alias.get(name)!;
    return name;
  };

  const producedBy = new Map<string, number>();
  graph.nodes.forEach((n, i) => n.outputs.forEach(o => producedBy.set(o, i)));
  const consumers = new Map<string, number>();
  for (const n of graph.nodes) {
    for (const i of n.inputs) consumers.set(i, (consumers.get(i) ?? 0) + 1);
  }

  // Only nodes downstream of the start tensor are part of the network.
  const reachable = new Set([startTensor]);
  const nodes = graph.nodes.filter(n => {
    const inNet = n.inputs.some(i => reachable.has(i));
    if (inNet) n.outputs.forEach(o => reachable.add(o));
    return inNet;
  });

  const values: number[] = [];
  const tensors: Record<string, TensorInfo> = {};
  const addTensor = (name: string, data: Float32Array, shape: number[]) => {
    tensors[name] = {offset: values.length, shape};
    for (const v of data) values.push(f32ToF16(v));
    return name;
  };
  const init = (name: string) => {
    const t = graph.initializers.get(name);
    if (!t) throw new Error(`missing initializer ${name}`);
    return t;
  };
  const weightTensor = (name: string) => {
    const t = init(name);
    return tensors[name] ? name : addTensor(name, toFloat32(t), t.dims);
  };

  const ops: Op[] = [];
  const fusedRelu = new Set<number>();
  /** If the output feeds only a Relu, fuse it and return the Relu's output. */
  const maybeFuseRelu = (output: string): [string, boolean] => {
    if (consumers.get(output) !== 1) return [output, false];
    const idx = graph.nodes.findIndex(
      n => n.opType === 'Relu' && n.inputs[0] === output,
    );
    if (idx < 0) return [output, false];
    fusedRelu.add(idx);
    return [graph.nodes[idx].outputs[0], true];
  };

  for (const n of nodes) {
    const idx = graph.nodes.indexOf(n);
    const a = n.attributes;
    switch (n.opType) {
      case 'Cast':
      case 'Reshape':
      case 'Squeeze':
      case 'Unsqueeze':
        alias.set(n.outputs[0], n.inputs[0]);
        break;
      case 'Relu':
        if (!fusedRelu.has(idx)) {
          throw new Error(`unfused Relu on ${n.inputs[0]}`);
        }
        break;
      case 'Conv': {
        const kernel = ints(a.kernel_shape, 'kernel_shape');
        const strides = ints(a.strides ?? [1, 1], 'strides');
        const pads = ints(a.pads ?? [0, 0, 0, 0], 'pads');
        if ((a.group ?? 1) !== 1) throw new Error('grouped conv');
        if (kernel[0] !== kernel[1] || strides[0] !== strides[1]) {
          throw new Error('non-square conv');
        }
        if (new Set(pads).size !== 1) throw new Error('asymmetric padding');
        const [output, relu] = maybeFuseRelu(n.outputs[0]);
        ops.push({
          op: 'conv',
          input: resolve(n.inputs[0]),
          output,
          weight: weightTensor(n.inputs[1]),
          ...(n.inputs[2] && {bias: weightTensor(n.inputs[2])}),
          kernel: kernel[0],
          stride: strides[0],
          pad: pads[0],
          relu,
        });
        break;
      }
      case 'Add':
        ops.push({
          op: 'add',
          a: resolve(n.inputs[0]),
          b: resolve(n.inputs[1]),
          output: n.outputs[0],
        });
        break;
      case 'BatchNormalization': {
        const eps = (a.epsilon as number | undefined) ?? 1e-5;
        const [gamma, beta, mean, variance] = n.inputs
          .slice(1)
          .map(i => toFloat32(init(i)));
        const scale = gamma.map((g, c) => g / Math.sqrt(variance[c] + eps));
        const shift = beta.map((b, c) => b - mean[c] * scale[c]);
        const [output, relu] = maybeFuseRelu(n.outputs[0]);
        ops.push({
          op: 'scaleShift',
          input: resolve(n.inputs[0]),
          output,
          scale: addTensor(`${n.outputs[0]}.scale`, scale, [scale.length]),
          shift: addTensor(`${n.outputs[0]}.shift`, shift, [shift.length]),
          relu,
        });
        break;
      }
      case 'ReduceMean': {
        const axes = n.inputs[1]
          ? Array.from(
              new BigInt64Array(init(n.inputs[1]).raw.slice().buffer),
              Number,
            )
          : ints(a.axes, 'axes');
        const sortedAxes = axes.sort((x, y) => x - y).join();
        if (sortedAxes !== '-2,-1' && sortedAxes !== '2,3') {
          throw new Error(`ReduceMean over ${axes}`);
        }
        ops.push({
          op: 'globalAvgPool',
          input: resolve(n.inputs[0]),
          output: n.outputs[0],
        });
        break;
      }
      case 'Gemm':
        if (a.transB !== 1 || (a.transA ?? 0) !== 0)
          throw new Error('Gemm layout');
        ops.push({
          op: 'linear',
          input: resolve(n.inputs[0]),
          output: n.outputs[0],
          weight: weightTensor(n.inputs[1]),
          bias: weightTensor(n.inputs[2]),
        });
        break;
      default:
        throw new Error(`unsupported op ${n.opType}`);
    }
  }

  const output = resolve(graph.outputs[0]);
  if (!producedBy.has(output) && !ops.some(o => o.output === output)) {
    throw new Error(`graph output ${output} not produced`);
  }
  return {
    spec: {input: {name: startTensor, shape: inputShape}, output, ops, tensors},
    weights: new Uint8Array(new Uint16Array(values).buffer),
  };
}
