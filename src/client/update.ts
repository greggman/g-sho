/**
 * Is there a newer g-sho? The build writes /version.json (scripts/build.ts):
 * if the server's differs from this page's version, there is. Asked straight
 * from the server, past every cache, with or without the service worker.
 * Whichever check finds a new version (the logo's, Settings → Version)
 * tells everything listening (onNewVersion), so they all agree.
 */
import {sameBuild, version, type Version} from './version.ts';

const listeners: ((v: Version) => void)[] = [];

/** Calls `fn` whenever a check finds the server has a new version. */
export function onNewVersion(fn: (v: Version) => void) {
  listeners.push(fn);
}

/** The version the server has now; undefined if it couldn't be reached. */
export async function serverVersion(): Promise<Version | undefined> {
  const v = await fetchVersion();
  if (v && !sameBuild(v, version)) for (const fn of listeners) fn(v);
  return v;
}

async function fetchVersion(): Promise<Version | undefined> {
  try {
    // The query keeps an older service worker (which saved any file it
    // was asked for) from answering with a saved copy.
    const res = await fetch(`/version.json?t=${Date.now()}`, {
      cache: 'no-store',
    });
    if (!res.ok) return undefined;
    const v = (await res.json()) as Version;
    return typeof v?.commit === 'string' ? v : undefined;
  } catch {
    return undefined;
  }
}

/** The server's version if it isn't this page's; undefined if same or unknown. */
export async function newVersion(): Promise<Version | undefined> {
  const v = await serverVersion();
  return v && !sameBuild(v, version) ? v : undefined;
}

/**
 * Switches to the server's version: reloads, or opens `href`. With a
 * service worker, it gets the new files first (the page loads from them).
 */
export async function applyUpdate(href?: string): Promise<void> {
  const reg = await navigator.serviceWorker?.getRegistration();
  if (reg) {
    // Don't wait for update() itself: Safari may not settle it until the
    // new version has installed, or at all.
    const found = new Promise<ServiceWorker | null>(resolve => {
      reg.addEventListener('updatefound', () => resolve(reg.installing), {
        once: true,
      });
      reg.update().then(
        () => resolve(reg.installing ?? reg.waiting),
        () => resolve(null),
      );
    });
    const incoming =
      reg.installing ??
      reg.waiting ??
      (await Promise.race([found, timeout(15_000)]));
    if (incoming) await Promise.race([activated(incoming), timeout(60_000)]);
  }
  if (href) location.assign(href);
  else location.reload();
}

function timeout(ms: number): Promise<null> {
  return new Promise(resolve => setTimeout(() => resolve(null), ms));
}

/** Resolves once the worker has taken over (or failed). */
function activated(worker: ServiceWorker): Promise<void> {
  return new Promise(resolve => {
    const done = () => {
      if (worker.state === 'activated' || worker.state === 'redundant') {
        resolve();
      }
    };
    worker.addEventListener('statechange', done);
    done();
  });
}
