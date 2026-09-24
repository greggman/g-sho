import {hasJapanese, isKanji} from '../shared/kana.ts';
import {loadSettings, type AnkiSettings} from './anki/settings.ts';
import {Dict} from './dict.ts';
import {h, searchLink} from './dom.ts';
import {headword} from './forms.ts';
import {HistoryStore, HistoryView} from './history-view.ts';
import {RadicalPicker} from './radicals.ts';
import {
  renderEntry,
  renderKanji,
  renderSentence,
  type EntryActions,
  resultsHeading,
} from './render.ts';
import {search, type SearchResult} from './search.ts';
import {
  MEANING_SELECTOR,
  applyDisplaySettings,
  loadDisplaySettings,
} from './settings.ts';
import {attachUndo} from './undo.ts';

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
const settingsToggle = $<HTMLButtonElement>('settings-toggle');
const settingsPanel = $<HTMLElement>('settings-panel');
const content = $<HTMLElement>('content');
const dataInfo = $<HTMLElement>('data-info');
const undo = attachUndo(input);
let display = loadDisplaySettings();
const historyStore = new HistoryStore();
/**
 * The history column beside the page, on screens wide enough for it (CSS
 * shows it there and shows the home page's copy otherwise).
 */
const historyColumn = new HistoryView(historyStore, true);
$<HTMLElement>('history-column').append(historyColumn.element);

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

/** Remembers a search in the history, with a snapshot of its top result. */
function recordHistory(query: string, result: SearchResult) {
  const top = result.words[0];
  if (!top && !result.sentence) return;
  const word = top && headword(top.entry);
  historyStore.add({
    q: query,
    t: Date.now(),
    ...(word && {
      word: {
        text: word.text,
        ...(word.reading && {reading: word.reading}),
        meaning: top.entry.s[0].g.slice(0, 3).join('; '),
      },
    }),
  });
}

function renderHome(): HTMLElement {
  return h(
    'div',
    {class: 'home'},
    // For narrow screens, where there's no history column.
    display.history && new HistoryView(historyStore).element,
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
    sidebarKanji(query, result).map(async k => {
      const [info, strokes] = await Promise.all([
        dict.kanji(k),
        // Stroke order is a nice-to-have: don't fail the page without it.
        dict.strokes(k).catch(() => undefined),
      ]);
      return info && {info, strokes};
    }),
  );
  const [sentenceBar, sentenceWords] = result.sentence
    ? renderSentence(dict, result, entryActions)
    : [];
  const main =
    sentenceWords ??
    h(
      'section',
      {class: 'words'},
      resultsHeading(result),
      result.words.length === 0 &&
        h(
          'p',
          {class: 'no-results'},
          `Sorry, couldn't find anything matching ${query}.`,
        ),
      result.words.map(w => renderEntry(dict, w, entryActions)),
      result.words.length < result.total &&
        h(
          'a',
          {class: 'more-words', href: searchUrl(query, {p: pages + 1})},
          'More words',
        ),
    );
  const found = kanji.filter(k => k !== undefined);
  return h(
    'div',
    {class: 'results'},
    sentenceBar,
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
          found.map(k => renderKanji(k.info, k.strokes)),
        ),
    ),
  );
}

/** Controls added to every entry; set when Anki is connected. */
let entryActions: EntryActions | undefined;

let currentSearch = 0;

/**
 * Shows the page for the current URL. `record` adds the search to the
 * history (not done for back/forward, which revisit it).
 */
async function route(dict: Dict, record = false) {
  const params = new URLSearchParams(location.search);
  const query = params.get('q')?.trim() ?? '';
  const pages = Math.max(1, Number(params.get('p') ?? 1) || 1);
  // An undo step, so what was typed before the search can be brought back.
  undo.set(query);
  historyColumn.setCurrent(query);
  document.title = query ? `${query} - g-sho` : 'g-sho — Japanese dictionary';

  if (!query) {
    content.replaceChildren(renderHome());
    return;
  }
  const id = ++currentSearch;
  content.setAttribute('aria-busy', 'true');
  try {
    const result = await search(dict, query, {pages});
    const view = await renderResults(dict, query, result, pages);
    if (id !== currentSearch) return;
    content.replaceChildren(view);
    if (record && pages === 1) recordHistory(query, result);
    historyColumn.setCurrent(query);
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

function navigate(dict: Dict, url: string, scroll = true, record = true) {
  history.pushState(null, '', url);
  if (scroll) window.scrollTo(0, 0);
  void route(dict, record);
}

/** Inserts text at the search box's cursor, as its own undo step. */
function insertAtCursor(text: string) {
  undo.insert(text);
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
  [settingsToggle, settingsPanel],
];

/** Turns the add-to-Anki buttons on or off for the settings. */
async function applyAnki(dict: Dict, settings: AnkiSettings) {
  entryActions = settings.enabled
    ? (await import('./anki/controller.ts')).createAnkiActions(settings, dict)
    : undefined;
}

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
  setupPanel(settingsToggle, settingsPanel, async () => {
    const {createSettingsPanel} = await import('./settings-panel.ts');
    return createSettingsPanel(
      display,
      settings => {
        const historyChanged = settings.history !== display.history;
        display = settings;
        applyDisplaySettings(display);
        document.documentElement.classList.toggle(
          'hide-history',
          !settings.history,
        );
        if (historyChanged && !location.search) void route(dict);
      },
      async () => {
        const {createAnkiPanel} = await import('./anki/panel.ts');
        return createAnkiPanel(loadSettings(), async settings => {
          await applyAnki(dict, settings);
          void route(dict);
        });
      },
    );
  });
}

async function main() {
  applyDisplaySettings(display);
  document.documentElement.classList.toggle('hide-history', !display.history);
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
    // Links within the page (#word-3) just scroll.
    if (a?.getAttribute('href')?.startsWith('#')) return;
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
    // Picking a word from the history doesn't move it to the top: the list
    // shouldn't reshuffle under you while you look back at earlier words.
    navigate(
      dict,
      a.search,
      !a.classList.contains('more-words'),
      !a.closest('.history'),
    );
  });

  // With meanings hidden (for practice), tapping one reveals it.
  document.addEventListener(
    'click',
    e => {
      if (!document.documentElement.classList.contains('hide-meanings')) return;
      const meaning = (e.target as Element).closest(MEANING_SELECTOR);
      if (meaning && !meaning.classList.contains('revealed')) {
        meaning.classList.add('revealed');
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true,
  );

  window.addEventListener('popstate', () => void route(dict));
  setupPanels(dict);
  await applyAnki(dict, loadSettings());
  // A search opened from a link counts as a lookup too.
  await route(dict, true);
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
