import {h} from './dom.ts';
import {
  SETTING_LABELS,
  saveDisplaySettings,
  type DisplaySettings,
} from './settings.ts';

/**
 * The settings panel: display toggles, then the Anki section (loaded on
 * demand, since it talks to Anki).
 */
export function createSettingsPanel(
  initial: DisplaySettings,
  onChange: (settings: DisplaySettings) => void,
  anki: () => Promise<HTMLElement>,
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
        saveDisplaySettings(settings);
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
  return h(
    'div',
    {class: 'settings-panel'},
    h('h2', {class: 'panel-title'}, 'Show'),
    h('div', {class: 'settings-toggles'}, toggles),
    ankiSection,
  );
}
