/**
 * Display settings: what to show. Turning things off is useful when
 * practicing (hide meanings or furigana and test yourself). Hidden meanings
 * are blurred rather than removed; tapping one reveals it.
 *
 * Settings are applied as classes on <html> (hide-meanings, …), so toggling
 * one doesn't need a re-render.
 */
import {prefersJapanese, t, type Language} from './i18n.ts';
import type {SettingsRow} from './store/store.ts';
import type {Table} from './store/table.ts';

export interface DisplaySettings {
  /** Japanese words: their English meanings (JMdict) */
  meanings: boolean;
  /** Japanese words: definitions in Japanese (Japanese Wiktionary) */
  japanese: boolean;
  /** English words: their meanings in Japanese (英和; Japanese Wiktionary) */
  englishJapanese: boolean;
  /** English words: definitions in English (Open English WordNet) */
  englishEnglish: boolean;
  furigana: boolean;
  examples: boolean;
  kanji: boolean;
  strokeOrder: boolean;
  history: boolean;
}

export type SettingKey = keyof DisplaySettings;

/** Each setting's label and hint, in the interface's language. */
export function settingLabels(): Record<SettingKey, [string, string]> {
  return {
    meanings: [
      t('English meanings'),
      t('When off, meanings are blurred; tap one to see it.'),
    ],
    japanese: [
      t('Japanese definitions (国語)'),
      t(
        'From the Japanese Wiktionary. Every word in them links to its entry. To study in Japanese only, also turn off English meanings.',
      ),
    ],
    englishJapanese: [
      t('Japanese meanings (英和)'),
      t(
        'When you search in English: the word explained in Japanese, above the Japanese words. From the Japanese Wiktionary.',
      ),
    ],
    englishEnglish: [
      t('English definitions'),
      t(
        'When you search in English: the word defined in English, with synonyms. From Open English WordNet.',
      ),
    ],
    furigana: [
      t('Furigana'),
      t('When off, readings show when you hover over a word.'),
    ],
    examples: [t('Example sentences'), ''],
    kanji: [
      t('Kanji details'),
      t('The panel with each kanji’s readings and meanings.'),
    ],
    strokeOrder: [t('Stroke order'), ''],
    history: [t('History'), t('The words you’ve looked up.')],
  };
}

/** The settings panel's groups, in order. */
export function settingGroups(): [string, SettingKey[]][] {
  return [
    [t('Japanese words'), ['meanings', 'japanese']],
    [t('English words'), ['englishJapanese', 'englishEnglish']],
    [t('Show'), ['furigana', 'examples', 'kanji', 'strokeOrder', 'history']],
  ];
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
    englishEnglish: false,
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

/** The interface language you chose; undefined if you haven't. */
export function loadLanguage(
  table: Table<SettingsRow> | undefined,
): Language | undefined {
  const v = (table?.get('language')?.value as {v?: unknown} | undefined)?.v;
  return v === 'en' || v === 'ja' ? v : undefined;
}

export function saveLanguage(table: Table<SettingsRow>, lang: Language) {
  table.put({id: 'language', value: {v: lang}});
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
  root.toggle('show-english-english', settings.englishEnglish);
  root.toggle('hide-furigana', !settings.furigana);
  root.toggle('hide-examples', !settings.examples);
  root.toggle('hide-kanji', !settings.kanji);
  root.toggle('hide-strokes', !settings.strokeOrder);
}

/** Selector for text blurred by hide-meanings. */
export const MEANING_SELECTOR =
  '.glosses, .compact-gloss, .kanji-meanings, .example-en, .history-meaning';
