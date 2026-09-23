import {hasJapanese, isKanji} from '../shared/kana.ts';
import {Dict} from './dict.ts';
import {h, searchLink} from './dom.ts';
import {headword} from './forms.ts';
import {RadicalPicker} from './radicals.ts';
import {
  renderEntry,
  renderKanji,
  renderTokens,
  resultsHeading,
} from './render.ts';
import {search, type SearchResult} from './search.ts';

/** Most kanji shown in the sidebar. */
const MAX_SIDEBAR_KANJI = 10;

const EXAMPLES = [
  ['食べる', 'a word'],
  ['taberu', 'romaji'],
  ['dog', 'English'],
  ['行きたくなかった', 'an inflected word'],
  ['猫が好きです', 'a sentence'],
  ['たべ', 'the start of a word'],
];

function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const form = $<HTMLFormElement>('search-form');
const input = $<HTMLInputElement>('q');
const radicalToggle = $<HTMLButtonElement>('radical-toggle');
const radicalPanel = $<HTMLElement>('radical-panel');
const handwritingToggle = $<HTMLButtonElement>('handwriting-toggle');
const handwritingPanel = $<HTMLElement>('handwriting-panel');
const content = $<HTMLElement>('content');
const dataInfo = $<HTMLElement>('data-info');

let dataVersion = '';
const dataBase = new URL('data/', document.baseURI);

async function loadJson(path: string): Promise<unknown> {
  const url = new URL(path, dataBase);
  // Shards are immutable per data version, so version them for caching;
  // meta.json says which version is current, so always revalidate it.
  if (dataVersion) url.searchParams.set('v', dataVersion);
  const res = await fetch(url, path === 'meta.json' ? {cache: 'no-cache'} : {});
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

function searchUrl(
  q: string,
  extra: Record<string, string | number> = {},
): string {
  const params = new URLSearchParams({q});
  for (const [k, v] of Object.entries(extra)) params.set(k, String(v));
  return `?${params}`;
}

function renderHome(): HTMLElement {
  return h(
    'div',
    {class: 'home'},
    h(
      'p',
      {class: 'intro'},
      'Search in English, Japanese, or romaji. Paste a sentence to see its words.',
    ),
    h(
      'ul',
      {class: 'examples-list'},
      EXAMPLES.map(([q, what]) =>
        h(
          'li',
          null,
          searchLink(q, h('span', {lang: 'ja'}, q)),
          h('span', {class: 'hint'}, ` ${what}`),
        ),
      ),
    ),
  );
}

/** Kanji for the sidebar: those in the query, else those in the top results. */
function sidebarKanji(query: string, result: SearchResult): string[] {
  const source = hasJapanese(query)
    ? query
    : result.words
        .slice(0, 5)
        .map(w => headword(w.entry).text)
        .join('');
  return [...new Set(Array.from(source).filter(isKanji))].slice(
    0,
    MAX_SIDEBAR_KANJI,
  );
}

async function renderResults(
  dict: Dict,
  query: string,
  result: SearchResult,
  pages: number,
): Promise<HTMLElement> {
  const kanji = await Promise.all(
    sidebarKanji(query, result).map(k => dict.kanji(k)),
  );
  const main = h(
    'section',
    {class: 'words'},
    resultsHeading(result),
    result.words.length === 0 &&
      h(
        'p',
        {class: 'no-results'},
        `Sorry, couldn't find anything matching ${query}.`,
      ),
    result.words.map(w => renderEntry(dict, w)),
    result.words.length < result.total &&
      h(
        'a',
        {
          class: 'more-words',
          href: searchUrl(query, {
            ...(result.selectedToken !== undefined && {
              t: result.selectedToken,
            }),
            p: pages + 1,
          }),
        },
        'More words',
      ),
  );
  const found = kanji.filter(k => k !== undefined);
  return h(
    'div',
    {class: 'results'},
    result.tokens &&
      renderTokens(result.tokens, result.selectedToken ?? 0, i =>
        searchUrl(query, {t: i}),
      ),
    h(
      'div',
      {class: 'columns'},
      main,
      found.length > 0 &&
        h(
          'aside',
          {class: 'kanji-sidebar'},
          h(
            'h2',
            {class: 'results-heading'},
            'Kanji',
            h('span', {class: 'count'}, ` — ${found.length} found`),
          ),
          found.map(renderKanji),
        ),
    ),
  );
}

let currentSearch = 0;

async function route(dict: Dict) {
  const params = new URLSearchParams(location.search);
  const query = params.get('q')?.trim() ?? '';
  const token = params.has('t') ? Number(params.get('t')) : undefined;
  const pages = Math.max(1, Number(params.get('p') ?? 1) || 1);
  input.value = query;
  document.title = query ? `${query} - g-sho` : 'g-sho — Japanese dictionary';

  if (!query) {
    content.replaceChildren(renderHome());
    return;
  }
  const id = ++currentSearch;
  content.setAttribute('aria-busy', 'true');
  try {
    const result = await search(dict, query, {token, pages});
    const view = await renderResults(dict, query, result, pages);
    if (id !== currentSearch) return;
    content.replaceChildren(view);
  } catch (e) {
    if (id !== currentSearch) return;
    console.error(e);
    content.replaceChildren(
      h(
        'p',
        {class: 'error'},
        'Something went wrong loading the dictionary. Try again.',
      ),
    );
  } finally {
    if (id === currentSearch) content.removeAttribute('aria-busy');
  }
}

function navigate(dict: Dict, url: string, scroll = true) {
  history.pushState(null, '', url);
  if (scroll) window.scrollTo(0, 0);
  void route(dict);
}

/** Inserts text at the search box's cursor. */
function insertAtCursor(text: string) {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  input.setRangeText(text, start, end, 'end');
  input.focus();
}

/**
 * Makes a button toggle a panel, creating the panel's content the first
 * time it opens. Opening one panel closes the others.
 */
function setupPanel(
  toggle: HTMLButtonElement,
  panel: HTMLElement,
  create: () => Promise<HTMLElement>,
) {
  let created = false;
  toggle.addEventListener('click', async () => {
    const open = panel.hidden;
    for (const [t, p] of panels) {
      p.hidden = true;
      t.setAttribute('aria-expanded', 'false');
    }
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open && !created) {
      created = true;
      panel.replaceChildren(h('p', {class: 'panel-loading'}, 'Loading…'));
      try {
        panel.replaceChildren(await create());
      } catch (e) {
        created = false;
        console.error(e);
        panel.replaceChildren(
          h('p', {class: 'error'}, 'Couldn’t load this panel.'),
        );
      }
    }
  });
}

const panels: [HTMLButtonElement, HTMLElement][] = [
  [radicalToggle, radicalPanel],
  [handwritingToggle, handwritingPanel],
];

function setupPanels(dict: Dict) {
  setupPanel(radicalToggle, radicalPanel, async () => {
    const picker = new RadicalPicker(await dict.radicals(), insertAtCursor);
    return picker.element;
  });
  setupPanel(handwritingToggle, handwritingPanel, async () => {
    // Loaded on demand: the recognizer and its model aren't needed until now.
    const {createHandwritingPanel} = await import('./handwriting/panel.ts');
    const hw = createHandwritingPanel(char => {
      insertAtCursor(char);
      hw.clear();
    });
    return hw.element;
  });
}

async function main() {
  const dict = await Dict.open(loadJson);
  dataVersion = dict.meta.version;
  dataInfo.textContent = `JMdict ${dict.meta.dictDate} · ${dict.meta.entryCount.toLocaleString()} words · ${dict.meta.kanjiCount.toLocaleString()} kanji`;

  form.addEventListener('submit', e => {
    e.preventDefault();
    const q = input.value.trim();
    navigate(dict, q ? searchUrl(q) : location.pathname);
  });

  // Handle in-app search links without a page load.
  document.addEventListener('click', e => {
    if (
      e.defaultPrevented ||
      e.button !== 0 ||
      e.metaKey ||
      e.ctrlKey ||
      e.shiftKey ||
      e.altKey
    ) {
      return;
    }
    const a = (e.target as Element).closest('a');
    if (
      !a ||
      a.origin !== location.origin ||
      a.pathname !== location.pathname ||
      !a.search
    ) {
      return;
    }
    e.preventDefault();
    // "More words" appends results below, so stay where the reader is.
    navigate(dict, a.search, !a.classList.contains('more-words'));
  });

  window.addEventListener('popstate', () => void route(dict));
  setupPanels(dict);
  await route(dict);
}

main().catch(e => {
  console.error(e);
  content.replaceChildren(
    h(
      'p',
      {class: 'error'},
      "Couldn't load the dictionary data. ",
      h('a', {href: location.href}, 'Reload'),
    ),
  );
});
