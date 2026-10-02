/** The IndexedDB Backend: one object store per table, plus "meta". */
import type {Backend, Row} from './table.ts';

const DB_NAME = 'g-sho';

function done(req: IDBRequest | IDBTransaction): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (req instanceof IDBTransaction) {
      req.oncomplete = () => resolve(undefined);
      req.onerror = req.onabort = () => reject(req.error);
    } else {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }
  });
}

export class IdbBackend implements Backend {
  private readonly db: IDBDatabase;

  private constructor(db: IDBDatabase) {
    this.db = db;
  }

  /**
   * Opens (or creates) the database. Adding a table later means adding it
   * to `tables` and bumping `version`.
   */
  static async open(tables: string[], version: number): Promise<IdbBackend> {
    const req = indexedDB.open(DB_NAME, version);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of [...tables, 'meta']) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, {keyPath: 'id'});
        }
      }
    };
    return new IdbBackend((await done(req)) as IDBDatabase);
  }

  async load(table: string): Promise<Row[]> {
    const tx = this.db.transaction(table, 'readonly');
    return (await done(tx.objectStore(table).getAll())) as Row[];
  }

  async write(table: string, rows: Row[]) {
    const tx = this.db.transaction(table, 'readwrite');
    const store = tx.objectStore(table);
    for (const r of rows) store.put(r);
    await done(tx);
  }

  async getMeta<T>(key: string): Promise<T | undefined> {
    const tx = this.db.transaction('meta', 'readonly');
    const row = (await done(tx.objectStore('meta').get(key))) as
      {value: T} | undefined;
    return row?.value;
  }

  async setMeta(key: string, value: unknown) {
    const tx = this.db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put({id: key, value});
    await done(tx);
  }
}
