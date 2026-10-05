/**
 * A pack: several data files in one, for downloading the whole dictionary
 * in a few requests (see scripts/build-data.ts and
 * src/client/offline/download-worker.ts). A header line, a JSON list of
 * [file, length], then each file's text followed by a newline. Lengths are
 * JavaScript string lengths, which is what both sides measure.
 */

export function makePack(files: [name: string, text: string][]): string {
  const header = JSON.stringify(
    files.map(([name, text]) => [name, text.length]),
  );
  return [header, ...files.map(([, text]) => text)].join('\n');
}

export function readPack(pack: string): [name: string, text: string][] {
  const nl = pack.indexOf('\n');
  const header = JSON.parse(pack.slice(0, nl)) as [string, number][];
  let pos = nl + 1;
  return header.map(([name, length]) => {
    const text = pack.slice(pos, pos + length);
    pos += length + 1;
    return [name, text];
  });
}
