/**
 * Display settings: what to show. Turning things off is useful when
 * practicing (hide meanings or furigana and test yourself). Hidden meanings
 * are blurred rather than removed; tapping one reveals it.
 *
 * Settings are applied as classes on <html> (hide-meanings, …), so toggling
 * one doesn't need a re-render.
 */

export interface DisplaySettings {
  meanings: boolean;
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
  furigana: true,
  examples: true,
  kanji: true,
  strokeOrder: true,
  history: true,
};

const KEY = 'g-sho.settings';

export function loadDisplaySettings(): DisplaySettings {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) return {...DEFAULTS, ...JSON.parse(saved)};
  } catch {
    // Storage unavailable or corrupt: defaults.
  }
  return {...DEFAULTS};
}

export function saveDisplaySettings(settings: DisplaySettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Storage unavailable: settings last until the page is closed.
  }
}

/** Sets hide-* classes on <html> for the settings that are off. */
export function applyDisplaySettings(settings: DisplaySettings) {
  const root = document.documentElement.classList;
  root.toggle('hide-meanings', !settings.meanings);
  root.toggle('hide-furigana', !settings.furigana);
  root.toggle('hide-examples', !settings.examples);
  root.toggle('hide-kanji', !settings.kanji);
  root.toggle('hide-strokes', !settings.strokeOrder);
}

/** Selector for text blurred by hide-meanings. */
export const MEANING_SELECTOR =
  '.glosses, .compact-gloss, .kanji-meanings, .example-en, .history-meaning';
