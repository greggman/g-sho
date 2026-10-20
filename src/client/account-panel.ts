import {
  deleteAccount,
  loadAccount,
  PROVIDERS,
  providerLabel,
  signInUrl,
  signOut,
  unlink,
  type Account,
  type AccountState,
} from './account.ts';
import {h} from './dom.ts';
import type {Sync, SyncStatus} from './sync.ts';

function syncText(s: SyncStatus): string {
  switch (s.state) {
    case 'syncing':
      return 'Syncing…';
    case 'synced':
      return (
        'Your history, marks, notes and settings sync to this account. ' +
        `Last synced at ${new Date(s.lastSynced ?? Date.now()).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'})}.`
      );
    case 'offline':
      return 'Offline. Changes will sync when you’re back online.';
    case 'error':
      return `Couldn’t sync (${s.message ?? 'unknown error'}). It will try again.`;
  }
}

/**
 * The Account section of Settings: sign in with Google, GitHub or LINE, or
 * (signed in) add or remove sign-ins, sign out, download your data, delete
 * the account. null when the site has no account server.
 */
export async function createAccountPanel(
  /** the running sync, if signed in */
  sync: () => Sync | undefined,
  /** stops syncing (signed out, or the account was deleted) */
  stopSync: () => void,
): Promise<HTMLElement | null> {
  const panel = h('div', {class: 'account-panel'});
  let unwatch: (() => void) | undefined;

  const show = (state: AccountState) => {
    unwatch?.();
    unwatch = undefined;
    panel.replaceChildren(
      h(
        'h2',
        {class: 'panel-title'},
        state.kind === 'signed-in' ? 'Account: signed in' : 'Account',
      ),
      ...(state.kind === 'signed-in' ? signedIn(state.account) : signedOut()),
    );
  };

  const signedOut = () => [
    h(
      'p',
      null,
      'Optional. Sign in to keep your history, starred and known words, ' +
        'notes and settings in sync across your devices.',
    ),
    h(
      'div',
      {class: 'account-buttons'},
      ...PROVIDERS.map(p =>
        h(
          'a',
          {class: 'button primary', href: signInUrl(p.id)},
          `Sign in with ${p.label}`,
        ),
      ),
    ),
    h(
      'p',
      {class: 'hint'},
      'We store only your user ID and name there (and your GitHub username), ' +
        'not your email address. ',
      h('a', {href: '/privacy.html'}, 'Privacy'),
    ),
  ];

  const signedIn = (account: Account) => {
    const status = h('p', {class: 'account-status'});
    const syncLine = h('p', {class: 'sync-status hint'});
    const showSync = (s: SyncStatus | undefined) => {
      syncLine.textContent = s ? syncText(s) : '';
      syncLine.classList.toggle('error', s?.state === 'error');
    };
    const current = sync();
    showSync(current?.status);
    unwatch = current?.onStatus(showSync);
    const act = async (fn: () => Promise<void>, failed: string) => {
      try {
        await fn();
        await show(await loadAccount());
      } catch {
        status.textContent = failed;
        status.classList.add('error');
      }
    };
    return [
      signIns(account, act),
      h(
        'div',
        {class: 'account-buttons'},
        h(
          'button',
          {
            type: 'button',
            onclick: () =>
              void act(async () => {
                await signOut();
                stopSync();
              }, 'Couldn’t sign out. Try again.'),
          },
          'Sign out',
        ),
        h(
          'a',
          {class: 'button', href: '/api/export', download: 'g-sho-export.json'},
          'Download my data',
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'danger',
            onclick: () => {
              if (
                confirm(
                  'Delete your g-sho account and everything stored with it? ' +
                    'This can’t be undone. (What’s saved in this browser stays.)',
                )
              ) {
                void act(async () => {
                  stopSync();
                  await deleteAccount();
                }, 'Couldn’t delete the account. Try again.');
              }
            },
          },
          'Delete account',
        ),
      ),
      syncLine,
      status,
    ];
  };

  /**
   * A row for each way to sign in: linked ones with who you are there (and
   * Remove, unless it's the only one), the others with Link.
   */
  const signIns = (
    account: Account,
    act: (fn: () => Promise<void>, failed: string) => Promise<void>,
  ) => {
    const ids = account.identities;
    const providers = [
      ...PROVIDERS.map(p => p.id),
      // e.g. the dev sign-in
      ...ids
        .map(i => i.provider)
        .filter(id => !PROVIDERS.some(p => p.id === id)),
    ];
    const row = (provider: string) => {
      const label = providerLabel(provider);
      const i = ids.find(i => i.provider === provider);
      const who = !i
        ? h('span', {class: 'hint'}, '—')
        : (i.name ?? (i.login ? `@${i.login}` : ''));
      const action = !i
        ? h('a', {class: 'button', href: signInUrl(provider, true)}, 'Link')
        : ids.length > 1 &&
          h(
            'button',
            {
              type: 'button',
              onclick: () => {
                if (confirm(`Stop signing in with ${label}?`)) {
                  void act(
                    () => unlink(provider),
                    `Couldn’t remove ${label}. Try again.`,
                  );
                }
              },
            },
            'Remove',
          );
      return h(
        'tr',
        null,
        h('th', {scope: 'row'}, label),
        h('td', null, who),
        h('td', null, action),
      );
    };
    return h(
      'div',
      {class: 'sign-ins'},
      h('table', null, h('tbody', null, ...providers.map(row))),
      ids.length < 2 &&
        h(
          'p',
          {class: 'hint'},
          'Link more than one, in case you lose access to one.',
        ),
    );
  };

  const state = await loadAccount();
  if (state.kind === 'unavailable') return null;
  show(state);
  return panel;
}
