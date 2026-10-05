/**
 * Saves the whole dictionary for offline use, in the background: downloads
 * each pack (data/pack/<set>-<i>.txt, see scripts/build-data.ts) and puts
 * its files in the cache the service worker serves data from, at the same
 * URLs the app asks for. One pack at a time, at low priority, so the user's
 * own lookups go first. Finished packs are recorded, so it resumes.
 */

import {readPack} from '../../shared/pack.ts';

export interface DownloadRequest {
  /** the data folder's URL, ending in / */
  base: string;
  versions: Record<string, string>;
  packs: Record<string, number>;
  /** data sets, most useful first */
  order: string[];
}

export type DownloadMessage =
  | {type: 'progress'; done: number; total: number}
  | {type: 'complete'; total: number}
  | {type: 'error'; message: string; quota: boolean};

const DATA = 'g-sho-data';
const DONE = 'g-sho-offline';

const post = (m: DownloadMessage) => self.postMessage(m);

self.onmessage = async (e: MessageEvent<DownloadRequest>) => {
  const {base, versions, packs, order} = e.data;
  const sets = order.filter(s => packs[s] && versions[s]);
  const total = sets.reduce((n, s) => n + packs[s], 0);
  let done = 0;
  try {
    const data = await caches.open(DATA);
    const finished = await caches.open(DONE);
    // The meta.json these versions came from, so the app can start offline.
    const meta = await fetch(`${base}meta.json`, {cache: 'no-cache'});
    if (meta.ok) await data.put(`${base}meta.json`, meta);
    for (const set of sets) {
      const v = versions[set];
      for (let i = 0; i < packs[set]; i++) {
        const key = `/${set}-${i}-${v}`;
        if (!(await finished.match(key))) {
          const res = await fetch(`${base}pack/${set}-${i}.txt?v=${v}`, {
            priority: 'low',
          } as RequestInit);
          if (!res.ok) throw new Error(`pack ${set}-${i}: ${res.status}`);
          for (const [file, text] of readPack(await res.text())) {
            await data.put(
              `${base}${file}?v=${v}`,
              new Response(text, {
                headers: {'content-type': 'application/json'},
              }),
            );
          }
          await finished.put(key, new Response('1'));
        }
        post({type: 'progress', done: ++done, total});
      }
    }
    post({type: 'complete', total});
  } catch (err) {
    post({
      type: 'error',
      message: (err as Error).message,
      quota: (err as Error).name === 'QuotaExceededError',
    });
  }
};
