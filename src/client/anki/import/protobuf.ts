/**
 * Just enough protobuf reading for the parts of Anki's newer packages that
 * are stored as protobuf (note type and template config, the media list).
 * Returns each field number's values; nested messages stay as bytes, to be
 * read with readProto again.
 */
export type ProtoValue = number | Uint8Array;

export function readProto(bytes: Uint8Array): Map<number, ProtoValue[]> {
  const out = new Map<number, ProtoValue[]>();
  let i = 0;
  const varint = () => {
    let result = 0;
    let shift = 1;
    for (;;) {
      const b = bytes[i++];
      if (b === undefined) throw new Error('truncated protobuf');
      result += (b & 0x7f) * shift;
      if (b < 0x80) return result;
      shift *= 128;
    }
  };
  while (i < bytes.length) {
    const key = varint();
    const field = Math.floor(key / 8);
    let value: ProtoValue;
    switch (key & 7) {
      case 0:
        value = varint();
        break;
      case 1:
        value = bytes.subarray(i, (i += 8));
        break;
      case 2: {
        const n = varint();
        value = bytes.subarray(i, (i += n));
        break;
      }
      case 5:
        value = bytes.subarray(i, (i += 4));
        break;
      default:
        throw new Error(`unsupported protobuf wire type ${key & 7}`);
    }
    let list = out.get(field);
    if (!list) out.set(field, (list = []));
    list.push(value);
  }
  return out;
}

const decoder = new TextDecoder();

/** A string field (the last value, as protobuf does), or ''. */
export function protoString(m: Map<number, ProtoValue[]>, field: number) {
  const v = m.get(field)?.at(-1);
  return v instanceof Uint8Array ? decoder.decode(v) : '';
}

/** A number field (the last value), or 0. */
export function protoNumber(m: Map<number, ProtoValue[]>, field: number) {
  const v = m.get(field)?.at(-1);
  return typeof v === 'number' ? v : 0;
}
