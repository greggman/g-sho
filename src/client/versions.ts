/**
 * The versions of the parts of the app that are running: this page, the
 * service worker and the workers. After a deploy they can briefly differ
 * (an open page keeps its workers); if they stay different, something is
 * serving old files.
 */
import {VERSION_REQUEST, type Version} from './version.ts';

/** The workers the page has started, by name (the latest of each). */
const workers = new Map<string, Worker>();

export function trackWorker(name: string, worker: Worker) {
  workers.set(name, worker);
}

/** Asks a worker or service worker for its version; undefined if no answer. */
function ask<T extends Version>(
  target: Worker | ServiceWorker,
  timeout = 1500,
): Promise<T | undefined> {
  return new Promise(resolve => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      resolve(undefined);
    }, timeout);
    channel.port1.onmessage = e => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(e.data as T);
    };
    target.postMessage({type: VERSION_REQUEST}, [channel.port2]);
  });
}

export interface PartVersion {
  name: string;
  /** undefined: not running (or didn't answer) */
  version?: Version & {build?: string};
}

/** The service worker in charge, and one being installed or waiting. */
export async function serviceWorkerVersions(): Promise<PartVersion[]> {
  const reg = await navigator.serviceWorker?.getRegistration();
  if (!reg) return [];
  const parts: PartVersion[] = [];
  const controller = navigator.serviceWorker.controller;
  parts.push({
    name: 'Service worker (offline copy)',
    version: controller ? await ask(controller) : undefined,
  });
  if (reg.installing) {
    parts.push({
      name: 'Update being installed',
      version: await ask(reg.installing),
    });
  }
  if (reg.waiting) {
    parts.push({name: 'Update waiting', version: await ask(reg.waiting)});
  }
  return parts;
}

/** Every worker the page has started. */
export async function workerVersions(): Promise<PartVersion[]> {
  return Promise.all(
    [...workers].map(async ([name, w]) => ({name, version: await ask(w)})),
  );
}
