/**
 * The whole dictionary on this device, for offline use: downloaded in the
 * background (download-worker.ts) once the app has started, unless turned
 * off here, or the browser says it's saving data or on mobile data (where it
 * can tell). About a 35 MB download; ~120 MB stored.
 */
import type {Meta} from '../../shared/types.ts';
import {h} from '../dom.ts';
import type {DownloadMessage, DownloadRequest} from './download-worker.ts';
import {trackWorker} from '../versions.ts';

export type OfflineState =
  | {kind: 'unsupported'}
  | {kind: 'off'}
  | {kind: 'waiting'}
  | {kind: 'metered'}
  | {kind: 'downloading'; done: number; total: number}
  | {kind: 'saved'}
  | {kind: 'error'; message: string; quota: boolean};

/** What's needed first: search indexes, words, kanji, then the rest. */
const ORDER = ['ja', 'en', 'ent', 'kanji', 'radk', 'strokes', 'jadef', 'tex'];
const KEY = 'g-sho.offline';
/** Give the page a moment to finish starting first. */
const START_DELAY = 3000;

interface Connection {
  saveData?: boolean;
  type?: string;
}

export class OfflineDictionary {
  state: OfflineState = {kind: 'waiting'};
  private readonly meta: Meta;
  private readonly listeners = new Set<(s: OfflineState) => void>();
  private worker?: Worker;

  constructor(meta: Meta) {
    this.meta = meta;
    if (!('caches' in window) || !meta.packs || !meta.versions) {
      this.state = {kind: 'unsupported'};
    } else if (!this.enabled) {
      this.state = {kind: 'off'};
    }
  }

  get enabled(): boolean {
    try {
      return localStorage.getItem(KEY) !== 'off';
    } catch {
      return true;
    }
  }

  /** Starts in the background, unless off or on metered data. */
  autoStart() {
    if (this.state.kind !== 'waiting') return;
    const c = (navigator as {connection?: Connection}).connection;
    if (c?.saveData || c?.type === 'cellular') {
      this.set({kind: 'metered'});
      return;
    }
    setTimeout(() => this.start(), START_DELAY);
  }

  /** Starts (or resumes) the download now. */
  start() {
    if (this.worker || this.state.kind === 'unsupported') return;
    try {
      localStorage.removeItem(KEY);
    } catch {
      // Not remembered; it's on for now.
    }
    // Ask the browser not to clear it when space runs low.
    void navigator.storage?.persist?.().catch(() => {});
    const worker = new Worker(new URL('offline-worker.js', document.baseURI), {
      type: 'module',
    });
    this.worker = worker;
    trackWorker('Offline download', worker);
    worker.onmessage = (e: MessageEvent<DownloadMessage>) => {
      const m = e.data;
      if (m.type === 'progress') {
        this.set({kind: 'downloading', done: m.done, total: m.total});
      } else {
        worker.terminate();
        this.worker = undefined;
        this.set(
          m.type === 'complete'
            ? {kind: 'saved'}
            : {kind: 'error', message: m.message, quota: m.quota},
        );
      }
    };
    const request: DownloadRequest = {
      base: new URL('data/', document.baseURI).href,
      versions: this.meta.versions!,
      packs: this.meta.packs!,
      order: ORDER,
    };
    worker.postMessage(request);
    this.set({kind: 'downloading', done: 0, total: 0});
  }

  /** Stops, frees the space, and doesn't download again on this device. */
  async turnOff() {
    this.worker?.terminate();
    this.worker = undefined;
    try {
      localStorage.setItem(KEY, 'off');
    } catch {
      // Not remembered.
    }
    await caches.delete('g-sho-data');
    await caches.delete('g-sho-offline');
    this.set({kind: 'off'});
  }

  onChange(fn: (s: OfflineState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(state: OfflineState) {
    this.state = state;
    for (const fn of this.listeners) fn(state);
  }
}

function describe(s: OfflineState): string {
  switch (s.kind) {
    case 'unsupported':
      return 'This browser can’t save the dictionary for offline use.';
    case 'off':
      return 'Off: only words you look up are saved on this device.';
    case 'waiting':
      return 'Will download in the background shortly.';
    case 'metered':
      return 'Waiting: you’re on mobile data or saving data. Start it now if you like (about a 35 MB download).';
    case 'downloading':
      return s.total
        ? `Downloading in the background… ${Math.round((100 * s.done) / s.total)}%`
        : 'Downloading in the background…';
    case 'saved':
      return 'Saved on this device: every word works offline.';
    case 'error':
      return s.quota
        ? 'Not enough storage on this device to save the whole dictionary.'
        : `The download stopped (${s.message}). It will try again next time.`;
  }
}

/** The Offline section of Settings. */
export function createOfflinePanel(offline: OfflineDictionary): HTMLElement {
  const status = h('p', {class: 'hint offline-status'});
  const box = h('input', {
    type: 'checkbox',
    checked: offline.enabled && offline.state.kind !== 'unsupported',
    disabled: offline.state.kind === 'unsupported',
    onchange: () => {
      if (box.checked) offline.start();
      else void offline.turnOff();
    },
  });
  const startNow = h(
    'button',
    {type: 'button', onclick: () => offline.start()},
    'Download now',
  );
  const show = (s: OfflineState) => {
    status.textContent = describe(s);
    startNow.hidden = s.kind !== 'metered' && s.kind !== 'error';
  };
  show(offline.state);
  offline.onChange(show);
  return h(
    'div',
    {class: 'offline-panel'},
    h('h2', {class: 'panel-title'}, 'Offline'),
    h(
      'label',
      {class: 'setting'},
      box,
      h(
        'span',
        null,
        'Keep the whole dictionary on this device',
        h(
          'span',
          {class: 'hint'},
          ' — about 120 MB, so every word works offline.',
        ),
      ),
    ),
    status,
    startNow,
  );
}
