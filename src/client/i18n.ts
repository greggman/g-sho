/**
 * The interface's language: English, or Japanese. Text is written in
 * English and passed through t(), which looks it up in the Japanese table
 * (i18n/ja/) when the interface is in Japanese; anything missing stays in
 * English. Dictionary data (meanings, parts of speech, …) isn't translated.
 *
 * The language has to be known before anything is drawn, so it's read
 * synchronously from localStorage. The setting itself is in the store
 * (synced), and main.ts keeps the two in step.
 *
 * Never call t() when a module loads: only when drawing, so the language
 * is already set.
 */
import {JA} from './i18n/ja/index.ts';

export type Language = 'en' | 'ja';

const STORAGE_KEY = 'g-sho.language';

/** The browser prefers Japanese: only a guess at what someone wants. */
export function prefersJapanese(): boolean {
  const langs =
    typeof navigator === 'undefined'
      ? []
      : (navigator.languages ?? [navigator.language]);
  return /^ja\b/i.test(langs[0] ?? '');
}

function saved(): Language | undefined {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'en' || v === 'ja' ? v : undefined;
  } catch {
    return undefined;
  }
}

/** The interface's language for this page. */
export let language: Language = saved() ?? (prefersJapanese() ? 'ja' : 'en');

/**
 * Remembers the language for the next page (main.ts reloads when it
 * changes). For tests, also switches this page.
 */
export function rememberLanguage(lang: Language, now = false) {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // Not saved: the next page guesses again.
  }
  if (now) language = lang;
}

/**
 * `text` in the interface's language, with {name} placeholders filled in
 * from `vars`.
 */
export function t(
  text: string,
  vars?: Record<string, string | number>,
): string {
  let s = language === 'ja' ? (JA[text] ?? text) : text;
  if (vars) {
    s = s.replace(/\{(\w+)\}/g, (m, k: string) =>
      k in vars ? String(vars[k]) : m,
    );
  }
  return s;
}

/**
 * Translates the page's own HTML (index.html): elements with data-t (their
 * text), data-t-attrs ("title,aria-label,placeholder": those attributes),
 * and data-t-html (their HTML, from the table entry named by the value).
 */
export function translatePage(root: ParentNode = document) {
  document.documentElement.lang = language;
  if (language === 'en') return;
  for (const el of root.querySelectorAll<HTMLElement>('[data-t]')) {
    el.textContent = t(el.dataset.t || el.textContent!.trim());
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-t-attrs]')) {
    for (const name of el.dataset.tAttrs!.split(',')) {
      const v = el.getAttribute(name.trim());
      if (v) el.setAttribute(name.trim(), t(v));
    }
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-t-html]')) {
    const html = JA[`html:${el.dataset.tHtml}`];
    if (html) el.innerHTML = html;
  }
}
