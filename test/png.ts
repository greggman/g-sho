/**
 * Reads a PNG for tests: 8-bit gray, RGB or RGBA, not interlaced (what our
 * fixtures and phone screenshots are). Returns RGBA, like ImageData.
 */
import * as zlib from 'node:zlib';

export function readPng(file: Uint8Array) {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  let pos = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Uint8Array[] = [];
  while (pos < file.length) {
    const len = view.getUint32(pos);
    const type = String.fromCharCode(...file.subarray(pos + 4, pos + 8));
    const body = file.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = view.getUint32(pos + 8);
      height = view.getUint32(pos + 12);
      const [depth, color, , , interlace] = body.subarray(8);
      channels = ({0: 1, 2: 3, 4: 2, 6: 4} as Record<number, number>)[color];
      if (depth !== 8 || !channels || interlace) {
        throw new Error(`unsupported PNG (depth ${depth}, color ${color})`);
      }
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = y * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? px[out + i - channels] : 0;
      const b = y ? px[out - stride + i] : 0;
      const c = y && i >= channels ? px[out - stride + i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[out + i] = v;
    }
  }
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    const gray = channels <= 2;
    data[i * 4] = px[s];
    data[i * 4 + 1] = gray ? px[s] : px[s + 1];
    data[i * 4 + 2] = gray ? px[s] : px[s + 2];
    data[i * 4 + 3] =
      channels === 4 ? px[s + 3] : channels === 2 ? px[s + 1] : 255;
  }
  return {width, height, data};
}
