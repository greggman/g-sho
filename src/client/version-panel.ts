/**
 * Settings → Version: which build this page is, which builds the service
 * worker and the running workers are (flagged if different), and a button
 * to look for an update.
 */
import {h} from './dom.ts';
import {version, versionText, type Version} from './version.ts';
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

  // A home-screen app has no browser controls, so reloading is offered
  // here whenever it would help.
  const reloadButton = () =>
    h('button', {type: 'button', onclick: () => location.reload()}, 'Reload');
  let checking = false;

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
    // The saved copy isn't this page (e.g. an update arrived while it was
    // open): offer to switch, unless a check is reporting or offered it.
    const saved = sw[0]?.version;
    if (
      !checking &&
      !status.querySelector('button') &&
      saved &&
      !sameBuild(saved, version)
    ) {
      status.replaceChildren('A newer version is downloaded. ', reloadButton());
    }
    parts.replaceChildren(
      ...(all.length
        ? all.map(row)
        : [h('li', {class: 'hint'}, 'No service worker or workers running.')]),
    );
  }

  async function checkForUpdate() {
    const sw = navigator.serviceWorker;
    const reg = await sw.getRegistration();
    if (!reg) {
      status.textContent =
        'Offline use isn’t on here, so there’s nothing to update.';
      return;
    }
    check.disabled = true;
    checking = true;
    status.textContent = 'Checking…';
    // A new version shows up as an installing worker (updatefound). Don't
    // wait for update() itself: Safari may not settle it until the new
    // version has installed, or at all.
    const found = new Promise<ServiceWorker | null>(resolve => {
      if (reg.installing ?? reg.waiting) resolve(reg.installing ?? reg.waiting);
      reg.addEventListener('updatefound', () => resolve(reg.installing), {
        once: true,
      });
    });
    const checked = reg.update().then(
      () => reg.installing ?? reg.waiting,
      (e: Error) => Promise.reject(e),
    );
    try {
      const incoming = await Promise.race([found, checked, timeout(15_000)]);
      if (incoming === 'timeout') {
        status.replaceChildren(
          'No answer about an update yet. Reloading gets whatever has arrived. ',
          reloadButton(),
        );
      } else if (incoming) {
        status.textContent = 'Downloading the new version…';
        const state = await Promise.race([settled(incoming), timeout(60_000)]);
        status.replaceChildren(
          state === 'activated'
            ? 'The new version is ready. '
            : state === 'redundant'
              ? 'The update didn’t install; it will be tried again later. '
              : 'The new version is still downloading. ',
          reloadButton(),
        );
      } else {
        const [active] = await serviceWorkerVersions();
        // Often the new version arrived already, in the background (the app
        // checks whenever it comes to the front): this page is the old one.
        if (!active?.version || sameBuild(active.version, version)) {
          status.textContent = 'You have the latest version.';
        } else {
          status.replaceChildren(
            'A newer version is downloaded. ',
            reloadButton(),
          );
        }
      }
    } catch (e) {
      status.textContent = `Couldn’t check: ${(e as Error).message}`;
    } finally {
      check.disabled = false;
      checking = false;
      void refresh();
    }
  }

  // Up to date whenever it's shown.
  new IntersectionObserver(entries => {
    if (entries.some(e => e.isIntersecting)) void refresh();
  }).observe(panel);
  return panel;
}

/** Resolves with 'timeout' after `ms`. */
function timeout(ms: number): Promise<'timeout'> {
  return new Promise(resolve => setTimeout(() => resolve('timeout'), ms));
}

/** A worker's state once it's activated or failed. */
function settled(worker: ServiceWorker): Promise<ServiceWorkerState> {
  return new Promise(resolve => {
    const done = () => {
      if (worker.state === 'activated' || worker.state === 'redundant') {
        resolve(worker.state);
      }
    };
    worker.addEventListener('statechange', done);
    done();
  });
}

/**
 * Whether two parts are the same build: the commit, and its date (for a
 * build with uncommitted changes, when it was built; version.ts).
 */
function sameBuild(a: Version, b: Version) {
  return a.commit === b.commit && a.date === b.date;
}
