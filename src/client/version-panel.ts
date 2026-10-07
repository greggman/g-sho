/**
 * Settings → Version: which build this page is, which builds the service
 * worker and the running workers are (flagged if different), and a button
 * to look for an update.
 */
import {h} from './dom.ts';
import {version, versionText} from './version.ts';
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
    parts,
    'serviceWorker' in navigator && check,
    status,
  );

  const row = ({name, version: v}: PartVersion) => {
    const differs = v && v.commit !== version.commit;
    return h(
      'li',
      {class: differs ? 'differs' : undefined},
      h('span', {class: 'version-name'}, name),
      ' ',
      v ? versionText(v) : h('span', {class: 'hint'}, 'not running'),
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
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) {
      status.textContent =
        'Offline use isn’t on here, so there’s nothing to update.';
      return;
    }
    check.disabled = true;
    status.textContent = 'Checking…';
    try {
      await reg.update();
      const incoming = reg.installing ?? reg.waiting;
      if (incoming) {
        status.textContent = 'Downloading the new version…';
        await new Promise<void>(resolve => {
          const done = () => {
            if (
              incoming.state === 'activated' ||
              incoming.state === 'redundant'
            ) {
              resolve();
            }
          };
          incoming.addEventListener('statechange', done);
          done();
        });
        status.replaceChildren(
          incoming.state === 'activated'
            ? 'The new version is ready. '
            : 'The update didn’t install; it will be tried again later. ',
          h(
            'button',
            {type: 'button', onclick: () => location.reload()},
            'Reload',
          ),
        );
      } else {
        const [active] = await serviceWorkerVersions();
        status.textContent =
          active?.version?.commit === version.commit
            ? 'You have the latest version.'
            : 'No newer version found; reload to use the one saved for offline.';
      }
    } catch (e) {
      status.textContent = `Couldn’t check: ${(e as Error).message}`;
    } finally {
      check.disabled = false;
      void refresh();
    }
  }

  // Up to date whenever it's shown.
  new IntersectionObserver(entries => {
    if (entries.some(e => e.isIntersecting)) void refresh();
  }).observe(panel);
  return panel;
}
