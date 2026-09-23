import {h} from '../dom.ts';
import {AnkiConnect, AnkiUnreachable} from './connect.ts';
import {
  DEFAULT_DECK,
  DEFAULT_NOTE_TYPE,
  OWN_FIELD_MAP,
  SOURCES,
  guessFieldMap,
  type Source,
} from './note.ts';
import {saveSettings, type AnkiSettings} from './settings.ts';

const ADDON_URL = 'https://ankiweb.net/shared/info/2055492159';

/**
 * Anki settings: connect (Anki asks you to allow this site), then choose the
 * deck and note type. Every change is saved and reported to onChange.
 */
export function createAnkiPanel(
  initial: AnkiSettings,
  onChange: (settings: AnkiSettings) => void,
): HTMLElement {
  let settings = {...initial};
  const body = h('div', {class: 'anki-settings'});
  const panel = h(
    'div',
    {class: 'anki-panel'},
    h('h2', {class: 'panel-title'}, 'Anki'),
    body,
  );

  const update = (changes: Partial<AnkiSettings>) => {
    settings = {...settings, ...changes};
    saveSettings(settings);
    onChange(settings);
  };

  const status = (text: string, kind = '') =>
    h('p', {class: `anki-status ${kind}`}, text);

  function showDisconnected(message?: HTMLElement) {
    const url = h('input', {
      type: 'url',
      value: settings.url,
      'aria-label': 'AnkiConnect address',
    });
    const key = h('input', {
      type: 'password',
      value: settings.apiKey ?? '',
      placeholder: 'only if you set one in AnkiConnect',
      'aria-label': 'AnkiConnect API key',
    });
    body.replaceChildren(
      h(
        'p',
        null,
        'Add words to Anki with one click. This needs the Anki app running with the ',
        h(
          'a',
          {href: ADDON_URL, target: '_blank', rel: 'noopener'},
          'AnkiConnect add-on',
        ),
        '. When you connect, Anki asks whether to allow this site.',
      ),
      ...(message ? [message] : []),
      h(
        'button',
        {
          type: 'button',
          class: 'primary',
          onclick: () =>
            void connect(
              url.value.trim() || settings.url,
              key.value.trim() || undefined,
            ),
        },
        'Connect to Anki',
      ),
      h(
        'details',
        {class: 'anki-advanced'},
        h('summary', null, 'Advanced'),
        h('label', null, 'AnkiConnect address', url),
        h('label', null, 'API key', key),
      ),
    );
  }

  async function connect(url: string, apiKey?: string) {
    body.replaceChildren(
      status('Connecting… (check Anki for a permission dialog)'),
    );
    const anki = new AnkiConnect(url, apiKey);
    try {
      const permission = await anki.requestPermission();
      if (permission.permission !== 'granted') {
        showDisconnected(
          status(
            'Anki didn’t allow this site. Try again and choose Yes in Anki.',
            'error',
          ),
        );
        return;
      }
      if (permission.requireApikey && !apiKey) {
        showDisconnected(
          status(
            'Your AnkiConnect needs an API key. Enter it under Advanced.',
            'error',
          ),
        );
        return;
      }
      update({enabled: true, url, apiKey});
      await showConnected(anki);
    } catch (e) {
      showDisconnected(
        status(
          e instanceof AnkiUnreachable
            ? 'Couldn’t reach Anki. Make sure Anki is running with AnkiConnect installed. ' +
                'If your browser asks to allow access to devices on your local network, allow it.'
            : `Anki: ${(e as Error).message}`,
          'error',
        ),
      );
    }
  }

  async function showConnected(anki: AnkiConnect) {
    const [decks, models] = await Promise.all([
      anki.deckNames(),
      anki.modelNames(),
    ]);

    const deckSelect = h(
      'select',
      {
        onchange: () => update({deck: deckSelect.value}),
      },
      !decks.includes(DEFAULT_DECK) &&
        h('option', {value: DEFAULT_DECK}, `${DEFAULT_DECK} (new)`),
      decks.map(d => h('option', {value: d}, d)),
    );
    deckSelect.value = settings.deck;

    const fieldsTable = h('div', {class: 'anki-fields'});
    const showFields = async (noteType: string, keep: boolean) => {
      if (noteType === DEFAULT_NOTE_TYPE) {
        fieldsTable.replaceChildren(
          h(
            'p',
            {class: 'hint'},
            'Fields: word, reading, furigana, meanings, part of speech, an example ' +
              'sentence, JMdict ID and a link back here. Cards show the word and ' +
              'ask for its reading and meaning.',
          ),
        );
        if (!keep) update({noteType, fields: OWN_FIELD_MAP});
        return;
      }
      const names = await anki.modelFieldNames(noteType);
      const fields =
        keep && names.every(n => n in settings.fields)
          ? settings.fields
          : guessFieldMap(names);
      if (!keep || fields !== settings.fields) update({noteType, fields});
      fieldsTable.replaceChildren(
        h('p', {class: 'hint'}, 'What to put in each field:'),
        ...names.map(name => {
          const select = h(
            'select',
            {
              onchange: () =>
                update({
                  fields: {...settings.fields, [name]: select.value as Source},
                }),
            },
            Object.entries(SOURCES).map(([value, label]) =>
              h('option', {value}, label),
            ),
          );
          select.value = fields[name];
          return h('label', null, name, select);
        }),
      );
    };

    const modelSelect = h(
      'select',
      {onchange: () => void showFields(modelSelect.value, false)},
      h(
        'option',
        {value: DEFAULT_NOTE_TYPE},
        `${DEFAULT_NOTE_TYPE} — recommended`,
      ),
      models
        .filter(m => m !== DEFAULT_NOTE_TYPE)
        .map(m => h('option', {value: m}, m)),
    );
    modelSelect.value = settings.noteType;

    body.replaceChildren(
      status(
        'Connected. Use + on any word to add it to Anki; ✓ means it’s already there.',
        'ok',
      ),
      h('label', null, 'Deck', deckSelect),
      h('label', null, 'Note type', modelSelect),
      fieldsTable,
      h(
        'button',
        {
          type: 'button',
          onclick: () => {
            update({enabled: false});
            showDisconnected();
          },
        },
        'Disconnect',
      ),
    );
    await showFields(settings.noteType, true);
  }

  if (settings.enabled) {
    void connect(settings.url, settings.apiKey);
  } else {
    showDisconnected();
  }
  return panel;
}
