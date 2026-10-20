/**
 * Settings → Version: which build this page is, and whether the server has
 * a newer one (update.ts), asked whenever it's shown and by a button. Below, for tracking down
 * problems: which builds the service worker and the running workers are
 * (flagged if different from the page).
 */
import {h} from './dom.ts';
import {applyUpdate, serverVersion} from './update.ts';
import {sameBuild, version, versionText} from './version.ts';
import {
  serviceWorkerVersions,
  workerVersions,
  type PartVersion,
} from './versions.ts';

export function createVersionPanel(): HTMLElement {
  const parts = h('ul', {class: 'version-parts'});
  const status = h('p', {class: 'version-status', role: 'status'});
  const check = h(
    'button',
    {type: 'button', onclick: () => void checkForUpdate()},
    'Check for update',
  );
  const panel = h(
    'div',
    {class: 'version-panel'},
    h('h2', {class: 'panel-title'}, 'Version'),
    h('p', {class: 'version-page'}, `g-sho ${versionText(version)}`),
    check,
    status,
    parts,
  );

  const row = ({name, version: v, note}: PartVersion) => {
    const differs = v && !sameBuild(v, version);
    return h(
      'li',
      {class: differs ? 'differs' : undefined},
      h('span', {class: 'version-name'}, name),
      ' ',
      v ? versionText(v) : h('span', {class: 'hint'}, note ?? 'not running'),
      v?.build && h('span', {class: 'hint'}, ` · saved copy ${v.build}`),
      differs && h('span', {class: 'version-warning'}, ' · different build'),
    );
  };

  async function refresh() {
    const [sw, workers] = await Promise.all([
      serviceWorkerVersions(),
      workerVersions(),
    ]);
    const all = [...sw, ...workers];
    parts.replaceChildren(
      ...(all.length
        ? all.map(row)
        : [h('li', {class: 'hint'}, 'No service worker or workers running.')]),
    );
  }

  async function checkForUpdate() {
    if (check.disabled) return;
    check.disabled = true;
    status.textContent = 'Checking…';
    const latest = await serverVersion();
    check.disabled = false;
    if (!latest) {
      status.textContent = 'Couldn’t reach g-sho to check. Are you offline?';
    } else if (sameBuild(latest, version)) {
      status.textContent = 'You have the latest version.';
    } else {
      const update = h(
        'button',
        {
          type: 'button',
          onclick: () => {
            update.disabled = true;
            status.textContent = 'Updating…';
            void applyUpdate();
          },
        },
        'Update',
      );
      status.replaceChildren(
        `A new version is available: ${versionText(latest)}. `,
        update,
      );
    }
  }

  // Up to date whenever it's shown.
  new IntersectionObserver(entries => {
    if (entries.some(e => e.isIntersecting)) {
      void refresh();
      void checkForUpdate();
    }
  }).observe(panel);
  return panel;
}
