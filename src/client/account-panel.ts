import {
  deleteAccount,
  loadAccount,
  signInUrl,
  signOut,
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
 * The Account section of Settings: sign in with GitHub, or (signed in) sign
 * out, download your data, delete the account. null when the site has no
 * account server.
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
      h('h2', {class: 'panel-title'}, 'Account'),
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
    h('a', {class: 'button primary', href: signInUrl()}, 'Sign in with GitHub'),
    h(
      'p',
      {class: 'hint'},
      'We store only your GitHub user ID, username and name. ',
      h('a', {href: '/privacy.html'}, 'Privacy'),
    ),
  ];

  const signedIn = (account: Account) => {
    const github = account.identities.find(i => i.provider === 'github');
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
      h(
        'p',
        null,
        'Signed in as ',
        h('strong', null, account.name),
        !github
          ? ''
          : github.login && github.login !== account.name
            ? ` (@${github.login} on GitHub)`
            : ' with GitHub',
        '.',
      ),
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

  const state = await loadAccount();
  if (state.kind === 'unavailable') return null;
  show(state);
  return panel;
}
