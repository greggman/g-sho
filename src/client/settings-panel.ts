import {h} from './dom.ts';
import {
  settingGroups,
  settingLabels,
  type DisplaySettings,
  type SettingKey,
} from './settings.ts';
import {language, t, type Language} from './i18n.ts';
import {createVersionPanel} from './version-panel.ts';

/**
 * The settings panel: display toggles, then the account and Anki sections
 * (each loaded on demand, since they talk to the server and to Anki).
 */
export function createSettingsPanel(
  initial: DisplaySettings,
  onChange: (key: SettingKey, on: boolean) => void,
  anki: () => Promise<HTMLElement>,
  /** null when the site has no account server */
  account: () => Promise<HTMLElement | null>,
  /** the Offline section; null when offline use isn't set up */
  offline: HTMLElement | null,
  /** the interface language was changed */
  onLanguage: (lang: Language) => void,
): HTMLElement {
  const choose = h(
    'select',
    {
      'aria-label': 'Language / 表示言語',
      onchange: () => onLanguage(choose.value as Language),
    },
    h('option', {value: 'en', selected: language === 'en'}, 'English'),
    h('option', {value: 'ja', selected: language === 'ja'}, '日本語'),
  );
  // In both languages, so it can be found in either.
  const languageSection = h(
    'div',
    {class: 'settings-group settings-language'},
    h('h2', {class: 'panel-title'}, 'Language / 表示言語'),
    h(
      'label',
      {class: 'setting'},
      choose,
      h(
        'span',
        {class: 'hint'},
        ` ${t('The language of buttons, labels and messages. The dictionary itself doesn’t change.')}`,
      ),
    ),
  );
  const labels = settingLabels();
  const toggle = (key: SettingKey) => {
    const [label, hint] = labels[key];
    const box = h('input', {
      type: 'checkbox',
      checked: initial[key],
      onchange: () => onChange(key, box.checked),
    });
    return h(
      'label',
      {class: 'setting'},
      box,
      h('span', null, label, hint && h('span', {class: 'hint'}, ` — ${hint}`)),
    );
  };
  const groups = settingGroups().map(([title, keys]) =>
    h(
      'div',
      {class: 'settings-group'},
      h('h2', {class: 'panel-title'}, title),
      h('div', {class: 'settings-toggles'}, keys.map(toggle)),
    ),
  );
  const ankiSection = h(
    'div',
    {class: 'settings-anki'},
    h('p', {class: 'hint'}, t('Loading…')),
  );
  void anki().then(
    el => ankiSection.replaceChildren(el),
    () =>
      ankiSection.replaceChildren(
        h('p', {class: 'error'}, t('Couldn’t load the Anki settings.')),
      ),
  );
  // Shown only once we know there's an account server.
  const accountSection = h('div', {class: 'settings-account', hidden: true});
  void account().then(
    el => {
      if (!el) return;
      accountSection.replaceChildren(el);
      accountSection.hidden = false;
    },
    () => {},
  );
  return h(
    'div',
    {class: 'settings-panel'},
    languageSection,
    groups,
    accountSection,
    offline && h('div', {class: 'settings-offline'}, offline),
    ankiSection,
    h('div', {class: 'settings-version'}, createVersionPanel()),
  );
}
