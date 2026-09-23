/**
 * A minimal reader for ONNX model files: just enough of the protobuf wire
 * format and the ONNX schema (graph, nodes, attributes, initializers) to
 * convert a simple convolutional network to our own format.
 * See https://github.com/onnx/onnx/blob/main/onnx/onnx.proto
 */

export interface OnnxTensor {
  name: string;
  dims: number[];
  dataType: number;
  /** little-endian element bytes (from raw_data, or re-encoded from typed fields) */
  raw: Uint8Array;
}

export type OnnxAttribute = number | string | number[] | OnnxTensor | undefined;

export interface OnnxNode {
  opType: string;
  inputs: string[];
  outputs: string[];
  attributes: Record<string, OnnxAttribute>;
}

export interface OnnxGraph {
  nodes: OnnxNode[];
  initializers: Map<string, OnnxTensor>;
  inputs: string[];
  outputs: string[];
}

export const DataType = {FLOAT: 1, INT64: 7, FLOAT16: 10} as const;

/** One protobuf field: its number, and either a varint value or a byte slice. */
interface Field {
  num: number;
  varint?: bigint;
  bytes?: Uint8Array;
  fixed32?: number;
}

function* fields(buf: Uint8Array): Generator<Field> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 0;
  const varint = (): bigint => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const b = buf[pos++];
      result |= BigInt(b & 0x7f) << shift;
      if (b < 0x80) return result;
      shift += 7n;
    }
  };
  while (pos < buf.length) {
    const key = Number(varint());
    const num = key >>> 3;
    switch (key & 7) {
      case 0:
        yield {num, varint: varint()};
        break;
      case 1:
        pos += 8; // fixed64: unused by the fields we read
        break;
      case 2: {
        const len = Number(varint());
        yield {num, bytes: buf.subarray(pos, pos + len)};
        pos += len;
        break;
      }
      case 5:
        yield {num, fixed32: view.getFloat32(pos, true)};
        pos += 4;
        break;
      default:
        throw new Error(`unsupported protobuf wire type ${key & 7}`);
    }
  }
}

const text = new TextDecoder();

/** Signed 64-bit varint → number. */
function int64(v: bigint): number {
  return Number(BigInt.asIntN(64, v));
}

/** Repeated int64s, packed or not. */
function packedInt64s(f: Field, into: number[]) {
  if (f.varint !== undefined) {
    into.push(int64(f.varint));
    return;
  }
  for (const inner of fields(prefixAsVarints(f.bytes!))) {
    into.push(int64(inner.varint!));
  }
}

/** Packed varints have no keys; give each one a key so fields() can read them. */
function prefixAsVarints(bytes: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < bytes.length;) {
    out.push(0x08); // field 1, varint
    do {
      out.push(bytes[i]);
    } while (bytes[i++] >= 0x80);
  }
  return new Uint8Array(out);
}

function readTensor(buf: Uint8Array): OnnxTensor {
  const t: OnnxTensor = {
    name: '',
    dims: [],
    dataType: 0,
    raw: new Uint8Array(),
  };
  const floats: number[] = [];
  const ints: number[] = [];
  for (const f of fields(buf)) {
    if (f.num === 1) packedInt64s(f, t.dims);
    else if (f.num === 2) t.dataType = Number(f.varint);
    else if (f.num === 4) {
      if (f.fixed32 !== undefined) floats.push(f.fixed32);
      else {
        const v = new DataView(
          f.bytes!.buffer,
          f.bytes!.byteOffset,
          f.bytes!.byteLength,
        );
        for (let i = 0; i < f.bytes!.length; i += 4)
          floats.push(v.getFloat32(i, true));
      }
    } else if (f.num === 7) packedInt64s(f, ints);
    else if (f.num === 8) t.name = text.decode(f.bytes);
    else if (f.num === 9) t.raw = f.bytes!;
    else if (f.num === 13 || (f.num === 14 && f.varint === 1n)) {
      throw new Error(`tensor ${t.name} uses external data`);
    }
  }
  if (t.raw.length === 0 && floats.length > 0) {
    t.raw = new Uint8Array(new Float32Array(floats).buffer);
  } else if (t.raw.length === 0 && ints.length > 0) {
    t.raw = new Uint8Array(new BigInt64Array(ints.map(BigInt)).buffer);
  }
  return t;
}

function readAttribute(buf: Uint8Array): [string, OnnxAttribute] {
  let name = '';
  let value: OnnxAttribute;
  const ints: number[] = [];
  const floats: number[] = [];
  let type = 0;
  for (const f of fields(buf)) {
    if (f.num === 1) name = text.decode(f.bytes);
    else if (f.num === 2) value = f.fixed32;
    else if (f.num === 3) value = int64(f.varint!);
    else if (f.num === 4) value = text.decode(f.bytes);
    else if (f.num === 5) value = readTensor(f.bytes!);
    else if (f.num === 7) floats.push(f.fixed32!);
    else if (f.num === 8) packedInt64s(f, ints);
    else if (f.num === 20) type = Number(f.varint);
  }
  if (type === 7) value = ints; // INTS
  if (type === 6) value = floats; // FLOATS
  return [name, value];
}

function readNode(buf: Uint8Array): OnnxNode {
  const node: OnnxNode = {opType: '', inputs: [], outputs: [], attributes: {}};
  for (const f of fields(buf)) {
    if (f.num === 1) node.inputs.push(text.decode(f.bytes));
    else if (f.num === 2) node.outputs.push(text.decode(f.bytes));
    else if (f.num === 4) node.opType = text.decode(f.bytes);
    else if (f.num === 5) {
      const [k, v] = readAttribute(f.bytes!);
      node.attributes[k] = v;
    }
  }
  return node;
}

/** ValueInfoProto: we only need the name. */
function readValueName(buf: Uint8Array): string {
  for (const f of fields(buf)) if (f.num === 1) return text.decode(f.bytes);
  return '';
}

export function readOnnx(bytes: Uint8Array): OnnxGraph {
  // A plain Uint8Array view, so slice() copies (Node's Buffer.slice doesn't).
  const model = new Uint8Array(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );
  let graphBytes: Uint8Array | undefined;
  for (const f of fields(model)) if (f.num === 7) graphBytes = f.bytes;
  if (!graphBytes) throw new Error('no graph in ONNX model');
  const graph: OnnxGraph = {
    nodes: [],
    initializers: new Map(),
    inputs: [],
    outputs: [],
  };
  for (const f of fields(graphBytes)) {
    if (f.num === 1) graph.nodes.push(readNode(f.bytes!));
    else if (f.num === 5) {
      const t = readTensor(f.bytes!);
      graph.initializers.set(t.name, t);
    } else if (f.num === 11) graph.inputs.push(readValueName(f.bytes!));
    else if (f.num === 12) graph.outputs.push(readValueName(f.bytes!));
  }
  return graph;
}
