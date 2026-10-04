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
  meanings: boolean;
  /** definitions in Japanese (Japanese Wiktionary) */
  japanese: boolean;
  furigana: boolean;
  examples: boolean;
  kanji: boolean;
  strokeOrder: boolean;
  history: boolean;
}

export const SETTING_LABELS: Record<keyof DisplaySettings, [string, string]> = {
  meanings: [
    'English meanings',
    'When off, meanings are blurred; tap one to see it.',
  ],
  japanese: [
    'Japanese definitions (国語)',
    'From the Japanese Wiktionary. Every word in them links to its entry. To study in Japanese only, also turn off English meanings.',
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

const DEFAULTS: DisplaySettings = {
  meanings: true,
  japanese: false,
  furigana: true,
  examples: true,
  kanji: true,
  strokeOrder: true,
  history: true,
};

/** The display settings saved in the store (synced when signed in). */
export function loadDisplaySettings(
  table: Table<SettingsRow> | undefined,
): DisplaySettings {
  const saved = table?.get('display')?.value as
    Partial<DisplaySettings> | undefined;
  return {...DEFAULTS, ...saved};
}

export function saveDisplaySettings(
  table: Table<SettingsRow>,
  settings: DisplaySettings,
) {
  table.put({id: 'display', value: settings});
}

/** Sets hide-* classes on <html> for the settings that are off. */
export function applyDisplaySettings(settings: DisplaySettings) {
  const root = document.documentElement.classList;
  root.toggle('hide-meanings', !settings.meanings);
  root.toggle('show-japanese', settings.japanese);
  root.toggle('hide-furigana', !settings.furigana);
  root.toggle('hide-examples', !settings.examples);
  root.toggle('hide-kanji', !settings.kanji);
  root.toggle('hide-strokes', !settings.strokeOrder);
}

/** Selector for text blurred by hide-meanings. */
export const MEANING_SELECTOR =
  '.glosses, .compact-gloss, .kanji-meanings, .example-en, .history-meaning';
