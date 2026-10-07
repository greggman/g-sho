/**
 * Imported first by every worker: answers version requests (versions.ts)
 * before the worker's own message handler sees them.
 */
import {VERSION_REQUEST, version} from './version.ts';

addEventListener('message', (e: MessageEvent) => {
  if ((e.data as {type?: string})?.type !== VERSION_REQUEST || !e.ports[0]) {
    return;
  }
  e.stopImmediatePropagation();
  e.ports[0].postMessage(version);
});
