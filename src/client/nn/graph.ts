/**
 * A general network format: a graph of ONNX operators (with ONNX's
 * semantics) over n-dimensional tensors whose shapes are worked out on each
 * run, so inputs can vary in size. Used for OCR (PaddleOCR's models, see
 * scripts/convert-graph.ts); the handwriting model still uses the simpler
 * format in model.ts.
 *
 * model.json: the nodes in execution order, the inputs and outputs, small
 * constants (exactly, in the JSON) and where each weight is in weights.bin
 * (little-endian fp16).
 */
import {f16ToF32} from './model.ts';

export type AttrValue = number | string | number[];

export interface GraphNode {
  op: string;
  inputs: string[];
  outputs: string[];
  attrs?: Record<string, AttrValue>;
}

export interface GraphSpec {
  inputs: string[];
  outputs: string[];
  nodes: GraphNode[];
  /** weights in weights.bin: offset in fp16 elements, and shape */
  weights: Record<string, {offset: number; shape: number[]}>;
  /** small float constants, exactly */
  floats: Record<string, {shape: number[]; data: number[]}>;
  /** integer constants (shapes, axes, slice ranges) */
  ints: Record<string, {shape: number[]; data: number[]}>;
}

/** A float tensor. */
export interface Tensor {
  shape: number[];
  data: Float32Array;
}

/** An integer tensor: shapes and the like, always on the CPU. */
export interface IntTensor {
  shape: number[];
  ints: number[];
}

export type Value = Tensor | IntTensor;

export const isInt = (v: Value): v is IntTensor => 'ints' in v;

export interface Graph {
  spec: GraphSpec;
  /** every constant: weights decoded to float32, plus the small ones */
  consts: Map<string, Value>;
}

export function decodeGraph(spec: GraphSpec, weights: ArrayBuffer): Graph {
  const all = new Uint16Array(weights);
  const consts = new Map<string, Value>();
  for (const [name, w] of Object.entries(spec.weights)) {
    const size = w.shape.reduce((a, b) => a * b, 1);
    consts.set(name, {
      shape: w.shape,
      data: f16ToF32(all.subarray(w.offset, w.offset + size)),
    });
  }
  for (const [name, f] of Object.entries(spec.floats)) {
    consts.set(name, {shape: f.shape, data: new Float32Array(f.data)});
  }
  for (const [name, i] of Object.entries(spec.ints)) {
    consts.set(name, {shape: i.shape, ints: i.data});
  }
  return {spec, consts};
}

export async function loadGraph(baseUrl: URL): Promise<Graph> {
  const [spec, weights] = await Promise.all([
    fetch(new URL('model.json', baseUrl)).then(r => {
      if (!r.ok) throw new Error(`model.json: ${r.status}`);
      return r.json() as Promise<GraphSpec>;
    }),
    fetch(new URL('weights.bin', baseUrl)).then(r => {
      if (!r.ok) throw new Error(`weights.bin: ${r.status}`);
      return r.arrayBuffer();
    }),
  ]);
  return decodeGraph(spec, weights);
}

export const sizeOf = (shape: number[]) => shape.reduce((a, b) => a * b, 1);
