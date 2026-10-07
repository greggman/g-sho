/**
 * The saved dictionary data (data/… files and meta.json), in IndexedDB.
 * Shared by the service worker, which serves data from it, and the offline
 * download (download-worker.ts), which fills it.
 *
 * Not in Cache Storage: Safari reads the whole cache index the first time
 * it's opened after a launch, and with the whole dictionary saved (~17,000
 * files) that took about 6 seconds, before the page could even show.
 * IndexedDB looks up one file without reading the rest.
 *
 * Files are keyed by their path under data/ ("ent/123.json"), with the
 * version they were saved at: a file of another version is a miss, and the
 * new one replaces it.
 */

const DB = 'g-sho-data';
const FILES = 'files';
/** offline download: packs saved ("ent-3-<version>") */
const PACKS = 'packs';

interface SavedFile {
  v: string;
  text: string;
}

let opened: Promise<IDBDatabase> | undefined;

function db(): Promise<IDBDatabase> {
  opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(FILES);
      req.result.createObjectStore(PACKS);
    };
    req.onsuccess = () => {
      const d = req.result;
      // Another context deleting or upgrading it: let go, reopen next time.
      d.onversionchange = () => {
        d.close();
        opened = undefined;
      };
      resolve(d);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('data store blocked'));
  });
  opened.catch(() => (opened = undefined));
  return opened;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** A saved file's text, if saved at this version. */
export async function getFile(
  path: string,
  version: string,
): Promise<string | undefined> {
  const tx = (await db()).transaction(FILES, 'readonly');
  const saved = (await request(tx.objectStore(FILES).get(path))) as
    SavedFile | undefined;
  return saved?.v === version ? saved.text : undefined;
}

/** Saves files (path, text) at a version, in one transaction. */
export async function putFiles(
  files: [path: string, text: string][],
  version: string,
): Promise<void> {
  const tx = (await db()).transaction(FILES, 'readwrite');
  const store = tx.objectStore(FILES);
  for (const [path, text] of files) {
    store.put({v: version, text} satisfies SavedFile, path);
  }
  await done(tx);
}

export async function hasPack(key: string): Promise<boolean> {
  const tx = (await db()).transaction(PACKS, 'readonly');
  return (await request(tx.objectStore(PACKS).count(key))) > 0;
}

export async function putPack(key: string): Promise<void> {
  const tx = (await db()).transaction(PACKS, 'readwrite');
  tx.objectStore(PACKS).put(1, key);
  await done(tx);
}

/**
 * Deletes files saved at other versions than meta.json's (`versions`, by
 * data set: the path's first part, or the file name for top-level files
 * like "radk.json"), and the record of packs of other versions.
 */
export async function prune(versions: Record<string, string>): Promise<void> {
  const tx = (await db()).transaction([FILES, PACKS], 'readwrite');
  const files = tx.objectStore(FILES).openCursor();
  files.onsuccess = () => {
    const cursor = files.result;
    if (!cursor) return;
    const path = String(cursor.key);
    const set = path.includes('/')
      ? path.split('/')[0]
      : path.replace(/\.json$/, '');
    const want = versions[set];
    if (want && (cursor.value as SavedFile).v !== want) cursor.delete();
    cursor.continue();
  };
  const packs = tx.objectStore(PACKS).openCursor();
  packs.onsuccess = () => {
    const cursor = packs.result;
    if (!cursor) return;
    const m = /^\/?([^-]+)-\d+-(.+)$/.exec(String(cursor.key));
    if (m && versions[m[1]] && versions[m[1]] !== m[2]) cursor.delete();
    cursor.continue();
  };
  await done(tx);
}

/** Deletes everything saved (offline use turned off). */
export async function clearAll(): Promise<void> {
  const tx = (await db()).transaction([FILES, PACKS], 'readwrite');
  tx.objectStore(FILES).clear();
  tx.objectStore(PACKS).clear();
  await done(tx);
}
