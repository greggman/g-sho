/**
 * Display settings: what to show. Turning things off is useful when
 * practicing (hide meanings or furigana and test yourself). Hidden meanings
 * are blurred rather than removed; tapping one reveals it.
 *
 * Settings are applied as classes on <html> (hide-meanings, …), so toggling
 * one doesn't need a re-render.
 */
import type {SettingsRow} from './store/store.ts';
import type {Table} from './store/table.ts';

export interface DisplaySettings {
  /** Japanese words: their English meanings (JMdict) */
  meanings: boolean;
  /** Japanese words: definitions in Japanese (Japanese Wiktionary) */
  japanese: boolean;
  /** English words: their meanings in Japanese (英和; Japanese Wiktionary) */
  englishJapanese: boolean;
  furigana: boolean;
  examples: boolean;
  kanji: boolean;
  strokeOrder: boolean;
  history: boolean;
}

export type SettingKey = keyof DisplaySettings;

export const SETTING_LABELS: Record<SettingKey, [string, string]> = {
  meanings: [
    'English meanings',
    'When off, meanings are blurred; tap one to see it.',
  ],
  japanese: [
    'Japanese definitions (国語)',
    'From the Japanese Wiktionary. Every word in them links to its entry. To study in Japanese only, also turn off English meanings.',
  ],
  englishJapanese: [
    'Japanese meanings (英和)',
    'When you search in English: the English word explained in Japanese, above the Japanese words. From the Japanese Wiktionary.',
  ],
  furigana: ['Furigana', 'When off, readings show when you hover over a word.'],
  examples: ['Example sentences', ''],
  kanji: [
    'Kanji details',
    'The panel with each kanji’s readings and meanings.',
  ],
  strokeOrder: ['Stroke order', ''],
  history: ['History', 'The words you’ve looked up.'],
};

/** The settings panel's groups, in order. */
export const SETTING_GROUPS: [string, SettingKey[]][] = [
  ['Japanese words', ['meanings', 'japanese']],
  ['English words', ['englishJapanese']],
  ['Show', ['furigana', 'examples', 'kanji', 'strokeOrder', 'history']],
];

/** The browser prefers Japanese (only a guess at what someone wants). */
function prefersJapanese(): boolean {
  const langs =
    typeof navigator === 'undefined'
      ? []
      : (navigator.languages ?? [navigator.language]);
  return /^ja\b/i.test(langs[0] ?? '');
}

/**
 * The starting values, before you change anything. Worked out each time,
 * never saved, so a guess here can't override the choices you made on
 * another device.
 */
function defaults(): DisplaySettings {
  return {
    meanings: true,
    japanese: false,
    englishJapanese: prefersJapanese(),
    furigana: true,
    examples: true,
    kanji: true,
    strokeOrder: true,
    history: true,
  };
}

/** Each setting is its own row ("showFurigana"), so changes made to
 * different settings on different devices don't overwrite each other. */
const rowId = (key: SettingKey) => `show${key[0].toUpperCase()}${key.slice(1)}`;

/** Before each setting had its own row, they were all in this one. */
const LEGACY_ROW = 'display';

/**
 * The display settings saved in the store (synced when signed in): each
 * setting's own row, or the older all-in-one row if that changed later (an
 * older version of the app on another device), or the default.
 */
export function loadDisplaySettings(
  table: Table<SettingsRow> | undefined,
): DisplaySettings {
  const out = defaults();
  const legacy = table?.get(LEGACY_ROW);
  const old = legacy?.value as Partial<DisplaySettings> | undefined;
  for (const key of Object.keys(out) as SettingKey[]) {
    const row = table?.get(rowId(key));
    const own = (row?.value as {on?: unknown} | undefined)?.on;
    if (typeof own === 'boolean' && (!legacy || row!.mtime >= legacy.mtime)) {
      out[key] = own;
    } else if (typeof old?.[key] === 'boolean') {
      out[key] = old[key];
    }
  }
  return out;
}

/** Saves one setting you changed. */
export function saveDisplaySetting(
  table: Table<SettingsRow>,
  key: SettingKey,
  on: boolean,
) {
  table.put({id: rowId(key), value: {on}});
}

/** Sets hide-* classes on <html> for the settings that are off. */
export function applyDisplaySettings(settings: DisplaySettings) {
  const root = document.documentElement.classList;
  root.toggle('hide-meanings', !settings.meanings);
  root.toggle('show-japanese', settings.japanese);
  root.toggle('show-english-japanese', settings.englishJapanese);
  root.toggle('hide-furigana', !settings.furigana);
  root.toggle('hide-examples', !settings.examples);
  root.toggle('hide-kanji', !settings.kanji);
  root.toggle('hide-strokes', !settings.strokeOrder);
}

/** Selector for text blurred by hide-meanings. */
export const MEANING_SELECTOR =
  '.glosses, .compact-gloss, .kanji-meanings, .example-en, .history-meaning';
