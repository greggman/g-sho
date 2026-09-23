import {DEFAULT_URL} from './connect.ts';
import {
  DEFAULT_DECK,
  DEFAULT_NOTE_TYPE,
  OWN_FIELD_MAP,
  type FieldMap,
} from './note.ts';

export interface AnkiSettings {
  /** show the add-to-Anki buttons (set once connected) */
  enabled: boolean;
  url: string;
  apiKey?: string;
  deck: string;
  noteType: string;
  /** field → source, for the note type */
  fields: FieldMap;
}

const KEY = 'g-sho.anki';

export const DEFAULT_SETTINGS: AnkiSettings = {
  enabled: false,
  url: DEFAULT_URL,
  deck: DEFAULT_DECK,
  noteType: DEFAULT_NOTE_TYPE,
  fields: OWN_FIELD_MAP,
};

export function loadSettings(): AnkiSettings {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) return {...DEFAULT_SETTINGS, ...JSON.parse(saved)};
  } catch {
    // Storage unavailable (private mode) or corrupt: use defaults.
  }
  return {...DEFAULT_SETTINGS};
}

export function saveSettings(settings: AnkiSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Storage unavailable: settings last until the page is closed.
  }
}
