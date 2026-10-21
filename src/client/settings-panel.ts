import {h} from './dom.ts';
import {
  SETTING_GROUPS,
  SETTING_LABELS,
  type DisplaySettings,
  type SettingKey,
} from './settings.ts';
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
): HTMLElement {
  const toggle = (key: SettingKey) => {
    const [label, hint] = SETTING_LABELS[key];
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
  const groups = SETTING_GROUPS.map(([title, keys]) =>
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
    h('p', {class: 'hint'}, 'Loading…'),
  );
  void anki().then(
    el => ankiSection.replaceChildren(el),
    () =>
      ankiSection.replaceChildren(
        h('p', {class: 'error'}, 'Couldn’t load the Anki settings.'),
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
    groups,
    accountSection,
    offline && h('div', {class: 'settings-offline'}, offline),
    ankiSection,
    h('div', {class: 'settings-version'}, createVersionPanel()),
  );
}
