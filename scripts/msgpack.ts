/**
 * A minimal MessagePack decoder: nil, booleans, integers, floats, strings,
 * binary, arrays and maps. Enough for wordfreq's data files.
 * See https://github.com/msgpack/msgpack/blob/master/spec.md
 */
export function decodeMsgpack(bytes: Uint8Array): unknown {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = new TextDecoder();
  let pos = 0;

  const str = (n: number) => {
    const s = text.decode(bytes.subarray(pos, pos + n));
    pos += n;
    return s;
  };
  const arr = (n: number) => Array.from({length: n}, read);
  const map = (n: number) => {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < n; i++) {
      const k = read();
      out[String(k)] = read();
    }
    return out;
  };
  const u8 = () => view.getUint8(pos++);
  const u16 = () => ((pos += 2), view.getUint16(pos - 2));
  const u32 = () => ((pos += 4), view.getUint32(pos - 4));

  function read(): unknown {
    const b = u8();
    if (b <= 0x7f) return b;
    if (b >= 0xe0) return b - 0x100;
    if ((b & 0xf0) === 0x80) return map(b & 0x0f);
    if ((b & 0xf0) === 0x90) return arr(b & 0x0f);
    if ((b & 0xe0) === 0xa0) return str(b & 0x1f);
    switch (b) {
      case 0xc0:
        return null;
      case 0xc2:
        return false;
      case 0xc3:
        return true;
      case 0xc4:
        return bytes.slice(pos, (pos += u8()));
      case 0xc5:
        return bytes.slice(pos, (pos += u16()));
      case 0xc6:
        return bytes.slice(pos, (pos += u32()));
      case 0xca:
        return ((pos += 4), view.getFloat32(pos - 4));
      case 0xcb:
        return ((pos += 8), view.getFloat64(pos - 8));
      case 0xcc:
        return u8();
      case 0xcd:
        return u16();
      case 0xce:
        return u32();
      case 0xcf:
        return ((pos += 8), Number(view.getBigUint64(pos - 8)));
      case 0xd0:
        return ((pos += 1), view.getInt8(pos - 1));
      case 0xd1:
        return ((pos += 2), view.getInt16(pos - 2));
      case 0xd2:
        return ((pos += 4), view.getInt32(pos - 4));
      case 0xd3:
        return ((pos += 8), Number(view.getBigInt64(pos - 8)));
      case 0xd9:
        return str(u8());
      case 0xda:
        return str(u16());
      case 0xdb:
        return str(u32());
      case 0xdc:
        return arr(u16());
      case 0xdd:
        return arr(u32());
      case 0xde:
        return map(u16());
      case 0xdf:
        return map(u32());
      default:
        throw new Error(`unsupported msgpack type 0x${b.toString(16)}`);
    }
  }
  return read();
}
