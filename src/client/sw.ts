/**
 * The service worker: lets g-sho open and work offline.
 *
 * - App files (the pages, app.js, style.css, workers, icons): network first,
 *   so you always get the current deploy when online; the saved copy when
 *   offline. The whole current build is saved when this worker installs,
 *   so every screen opens offline, not only ones you've visited.
 * - Code chunks (content-hashed names): saved copy first. Old builds' chunks
 *   are kept for a week, so a page opened before a deploy can still load
 *   its chunks.
 * - Dictionary data (/data/…?v=<version>): saved copy first; the URLs change
 *   when the data does. When meta.json lists new versions, older copies are
 *   deleted. meta.json itself is network first.
 * - The handwriting model and sql.js's wasm: saved copy, refreshed in the
 *   background.
 * - /api/ (sign-in, sync): never cached, nor the packs the offline download
 *   unpacks into the data cache (offline/download-worker.ts).
 *
 * Built by scripts/build.ts, which defines BUILD (this build's id) and
 * FILES (the files to save at install).
 */

declare const BUILD: string;
declare const FILES: string[];

// The service worker types we use. (TypeScript's "webworker" lib clashes
// with the DOM lib the rest of the client is checked with.)
interface ExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
  readonly request: Request;
  respondWith(response: Response | Promise<Response>): void;
}
interface ServiceWorkerScope {
  addEventListener(
    type: 'install' | 'activate',
    listener: (event: ExtendableEvent) => void,
  ): void;
  addEventListener(type: 'fetch', listener: (event: FetchEvent) => void): void;
  skipWaiting(): Promise<void>;
  clients: {claim(): Promise<void>};
}

const sw = self as unknown as ServiceWorkerScope;

const APP_CACHE = `g-sho-app-${BUILD}`;
const CHUNKS = 'g-sho-chunks';
const DATA = 'g-sho-data';
const RUNTIME = 'g-sho-runtime';
const KEEP_OLD_CHUNKS_MS = 7 * 24 * 60 * 60 * 1000;

sw.addEventListener('install', event => {
  event.waitUntil(
    (async () => {
      const app = await caches.open(APP_CACHE);
      const chunks = await caches.open(CHUNKS);
      await Promise.all(
        FILES.map(async file => {
          const res = await fetch(file, {cache: 'no-cache'});
          // Pages (/about) are nice to have; code must all be there.
          const page = !/\.\w+$/.test(file);
          if (!res.ok || res.redirected) {
            if (page) return;
            throw new Error(`${file}: ${res.status}`);
          }
          await (file.startsWith('/chunks/') ? chunks : app).put(file, res);
        }),
      );
      // meta.json too: the page that installed this worker fetched it
      // before the worker was running, and the app can't start without it.
      const meta = await fetch('/data/meta.json', {cache: 'no-cache'});
      if (meta.ok) await (await caches.open(DATA)).put('/data/meta.json', meta);
      // Take over right away; pages already open keep working (their
      // chunks are kept, and a missing one makes them reload once).
      await sw.skipWaiting();
    })(),
  );
});

sw.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith('g-sho-app-') && name !== APP_CACHE) {
          await caches.delete(name);
        }
      }
      // Old builds' chunks, a week after they were saved.
      const current = new Set(FILES.filter(f => f.startsWith('/chunks/')));
      const chunks = await caches.open(CHUNKS);
      for (const req of await chunks.keys()) {
        if (current.has(new URL(req.url).pathname)) continue;
        const res = await chunks.match(req);
        const saved = Date.parse(res?.headers.get('date') ?? '');
        if (!saved || Date.now() - saved > KEEP_OLD_CHUNKS_MS) {
          await chunks.delete(req);
        }
      }
      await sw.clients.claim();
    })(),
  );
});

/** From the network, saving a copy; the saved copy if offline. */
async function networkFirst(
  request: Request,
  cacheName: string,
  fallbacks: string[] = [],
): Promise<Response> {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    if (res.ok && res.type === 'basic') {
      await cache.put(request, res.clone());
    }
    return res;
  } catch (e) {
    for (const key of [request, ...fallbacks]) {
      const saved = await cache.match(key, {ignoreSearch: true});
      if (saved) return saved;
    }
    throw e;
  }
}

/** The saved copy, or from the network (then saved). */
async function cacheFirst(
  request: Request,
  cacheName: string,
): Promise<Response> {
  const cache = await caches.open(cacheName);
  const saved = await cache.match(request);
  if (saved) return saved;
  const res = await fetch(request);
  if (res.ok) await cache.put(request, res.clone());
  return res;
}

/** The saved copy (refreshed in the background), or from the network. */
async function staleWhileRevalidate(
  request: Request,
  cacheName: string,
  wait: (p: Promise<unknown>) => void,
): Promise<Response> {
  const cache = await caches.open(cacheName);
  const saved = await cache.match(request);
  const update = fetch(request).then(async res => {
    if (res.ok) await cache.put(request, res.clone());
    return res;
  });
  if (saved) {
    wait(update.catch(() => {}));
    return saved;
  }
  return update;
}

/**
 * meta.json lists each data set's version; saved data files of other
 * versions are out of date.
 */
async function pruneData(meta: Response) {
  const versions = ((await meta.json()) as {versions?: Record<string, string>})
    .versions;
  if (!versions) return;
  const cache = await caches.open(DATA);
  for (const req of await cache.keys()) {
    const url = new URL(req.url);
    const rest = url.pathname.slice('/data/'.length);
    const set = rest.includes('/')
      ? rest.split('/')[0]
      : rest.replace(/\.json$/, '');
    const v = url.searchParams.get('v');
    if (versions[set] && v && v !== versions[set]) await cache.delete(req);
  }
}

/** Where a page's saved copy is: /about.html and /about are the same page. */
function pageKey(url: URL): string {
  const path = url.pathname.replace(/\.html$/, '').replace(/\/index$/, '/');
  return path || '/';
}

sw.addEventListener('fetch', event => {
  const {request} = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;
  const path = url.pathname;
  if (path.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(request);
          if (res.ok && !res.redirected) {
            const cache = await caches.open(APP_CACHE);
            await cache.put(pageKey(url), res.clone());
          }
          return res;
        } catch (e) {
          const cache = await caches.open(APP_CACHE);
          // Any search (/?q=…) is the app's page; it reads the URL itself.
          const saved =
            (await cache.match(pageKey(url))) ?? (await cache.match('/'));
          if (saved) return saved;
          throw e;
        }
      })(),
    );
    return;
  }
  if (path.startsWith('/chunks/')) {
    event.respondWith(cacheFirst(request, CHUNKS));
  } else if (path === '/data/meta.json') {
    event.respondWith(
      networkFirst(request, DATA).then(res => {
        if (res.ok) event.waitUntil(pruneData(res.clone()).catch(() => {}));
        return res;
      }),
    );
  } else if (path.startsWith('/data/pack/')) {
    // Packs are unpacked into the data cache by the offline download; no
    // need to keep them too.
    return;
  } else if (path.startsWith('/data/')) {
    event.respondWith(cacheFirst(request, DATA));
  } else if (path.startsWith('/handwriting/') || path === '/sql-wasm.wasm') {
    event.respondWith(
      staleWhileRevalidate(request, RUNTIME, p => event.waitUntil(p)),
    );
  } else {
    event.respondWith(networkFirst(request, APP_CACHE));
  }
});
