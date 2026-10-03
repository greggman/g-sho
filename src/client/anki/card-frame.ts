/**
 * Shows a rendered Anki card in a sandboxed iframe. Deck templates are
 * someone else's HTML, CSS and often scripts, so they run with
 * sandbox="allow-scripts" and no same-origin: they can't read our cookies,
 * storage or page. Images and sounds (kept on this device) are handed in
 * as data: URLs, since the frame can't load our files.
 */
import type {Store} from '../store/store.ts';
import {mediaNames} from './template.ts';

const BASE_CSS = `
html, body { margin: 0; padding: 0; background: transparent; }
body { overflow: hidden; }
.card { padding: 12px; }
img { max-width: 100%; height: auto; }
.g-sho-sound { font: inherit; font-size: 14px; border: 1px solid #8888; border-radius: 50%;
  width: 30px; height: 30px; background: transparent; color: inherit; cursor: pointer; }
`;

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** Runs in the frame: sounds, and telling the page how tall the card is. */
function frameScript(sounds: Record<string, string>) {
  const json = JSON.stringify(sounds).replace(/</g, '\\u003c');
  return `(() => {
  const sounds = ${json};
  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('.g-sho-sound');
    if (!b) return;
    const src = sounds[b.dataset.sound];
    if (src) new Audio(src).play();
  });
  // The content's height (the page's would never be less than the frame's).
  const report = () => parent.postMessage({gshoCardHeight: Math.ceil(document.body.getBoundingClientRect().height)}, '*');
  new ResizeObserver(report).observe(document.body);
  addEventListener('load', report);
  report();
})();`;
}

function isDark() {
  const theme = document.documentElement.dataset.theme;
  if (theme) return theme === 'dark';
  return matchMedia('(prefers-color-scheme: dark)').matches;
}

/** A frame showing the card's HTML with the note type's CSS. */
export async function cardFrame(
  store: Store,
  html: string,
  css: string,
  ord: number,
): Promise<HTMLIFrameElement> {
  const urls: Record<string, string> = {};
  for (const name of mediaNames(html)) {
    const blob = await store.backend.getMedia(name).catch(() => undefined);
    if (blob) urls[name] = await dataUrl(blob);
  }
  const withImages = html.replace(
    /(<img[^>]+src=["']?)([^"' >]+)/gi,
    (m, start: string, name: string) => {
      const url = urls[name.replace(/&amp;/g, '&')];
      return url ? start + url : m;
    },
  );
  const sounds = Object.fromEntries(
    Object.entries(urls).filter(
      ([n]) => !/\.(png|jpe?g|gif|webp|svg)$/i.test(n),
    ),
  );
  const night = isDark() ? 'nightMode night_mode' : '';
  const frame = document.createElement('iframe');
  frame.className = 'card-frame';
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('title', 'Card');
  frame.srcdoc =
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<style>${BASE_CSS}</style><style>${css}</style></head>` +
    `<body class="${night}"><div class="card card${ord + 1}">${withImages}</div>` +
    `<script>${frameScript(sounds)}</script></body></html>`;
  const onMessage = (e: MessageEvent) => {
    if (!frame.isConnected && frame.dataset.shown) {
      removeEventListener('message', onMessage);
      return;
    }
    if (e.source !== frame.contentWindow) return;
    const h = (e.data as {gshoCardHeight?: number})?.gshoCardHeight;
    if (typeof h === 'number') {
      frame.dataset.shown = '1';
      frame.style.height = `${Math.min(Math.max(h, 40), 5000)}px`;
    }
  };
  addEventListener('message', onMessage);
  return frame;
}
