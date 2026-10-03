/**
 * Reads an Anki package off the main thread (unzip, zstd, SQLite), so a
 * big deck doesn't freeze the page. Gets the file's bytes; answers with the
 * collection, or an error message.
 */
import {decompress} from 'fzstd';
import initSqlJs from 'sql.js';
import {readApkg} from './import/read.ts';

self.onmessage = async (e: MessageEvent<ArrayBuffer>) => {
  try {
    const SQL = await initSqlJs({
      locateFile: () => new URL('sql-wasm.wasm', self.location.href).href,
    });
    const collection = readApkg(new Uint8Array(e.data), SQL, decompress);
    self.postMessage(
      {collection},
      {transfer: collection.media.map(m => m.data.buffer as ArrayBuffer)},
    );
  } catch (err) {
    self.postMessage({error: (err as Error).message});
  }
};
