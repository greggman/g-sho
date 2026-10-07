import {h} from './dom.ts';
import {SETTING_LABELS, type DisplaySettings} from './settings.ts';
import {createVersionPanel} from './version-panel.ts';

/**
 * The settings panel: display toggles, then the account and Anki sections
 * (each loaded on demand, since they talk to the server and to Anki).
 */
export function createSettingsPanel(
  initial: DisplaySettings,
  onChange: (settings: DisplaySettings) => void,
  anki: () => Promise<HTMLElement>,
  /** null when the site has no account server */
  account: () => Promise<HTMLElement | null>,
  /** the Offline section; null when offline use isn't set up */
  offline: HTMLElement | null,
): HTMLElement {
  let settings = {...initial};
  const toggles = (
    Object.keys(SETTING_LABELS) as (keyof DisplaySettings)[]
  ).map(key => {
    const [label, hint] = SETTING_LABELS[key];
    const box = h('input', {
      type: 'checkbox',
      checked: settings[key],
      onchange: () => {
        settings = {...settings, [key]: box.checked};
        onChange(settings);
      },
    });
    return h(
      'label',
      {class: 'setting'},
      box,
      h('span', null, label, hint && h('span', {class: 'hint'}, ` — ${hint}`)),
    );
  });
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
    h('h2', {class: 'panel-title'}, 'Show'),
    h('div', {class: 'settings-toggles'}, toggles),
    accountSection,
    offline && h('div', {class: 'settings-offline'}, offline),
    ankiSection,
    h('div', {class: 'settings-version'}, createVersionPanel()),
  );
}
