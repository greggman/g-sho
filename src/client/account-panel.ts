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
import {t} from './i18n.ts';
import {
  createPasskey,
  PasskeyError,
  passkeysSupported,
  signInWithPasskey,
} from './passkey.ts';
import type {Sync, SyncStatus} from './sync.ts';
import {turnstileWidget} from './turnstile.ts';

/** What to tell the person when a passkey step fails. */
function passkeyMessage(e: unknown): string {
  return e instanceof PasskeyError
    ? e.message
    : t('Something went wrong with the passkey. Please try again.');
}

function syncText(s: SyncStatus): string {
  switch (s.state) {
    case 'syncing':
      return t('Syncing…');
    case 'synced':
      return t(
        'Your history, marks, notes and settings sync to this account. Last synced at {time}.',
        {
          time: new Date(s.lastSynced ?? Date.now()).toLocaleTimeString([], {
            hour: 'numeric',
            minute: '2-digit',
          }),
        },
      );
    case 'offline':
      return t('Offline. Changes will sync when you’re back online.');
    case 'error':
      return t('Couldn’t sync ({error}). It will try again.', {
        error: s.message ?? t('unknown error'),
      });
  }
}

/**
 * The Account section of Settings: sign in with Google, GitHub, LINE or a
 * passkey, or make an account with a passkey; or (signed in) add or remove
 * sign-ins, sign out, download your data, delete
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
        state.kind === 'signed-in' ? t('Account: signed in') : t('Account'),
      ),
      ...(state.kind === 'signed-in' ? signedIn(state.account) : signedOut()),
    );
  };

  const signedOut = () => {
    const status = h('p', {class: 'account-status', role: 'status'});
    const fail = (e: unknown) => {
      status.textContent = passkeyMessage(e);
      status.classList.add('error');
    };
    const passkeys = passkeysSupported();
    return [
      h(
        'p',
        null,
        t(
          'Optional. Sign in to keep your history, starred and known words, notes and settings in sync across your devices.',
        ),
      ),
      h(
        'div',
        {class: 'account-buttons'},
        ...PROVIDERS.map(p =>
          h(
            'a',
            {class: 'button primary', href: signInUrl(p.id)},
            t('Sign in with {provider}', {provider: p.label}),
          ),
        ),
        passkeys &&
          h(
            'button',
            {
              type: 'button',
              class: 'primary',
              onclick: async () => {
                try {
                  if (await signInWithPasskey()) show(await loadAccount());
                } catch (e) {
                  fail(e);
                }
              },
            },
            t('Sign in with a passkey'),
          ),
      ),
      ...(passkeys ? [passkeySignUp(fail)] : []),
      status,
      h(
        'p',
        {class: 'hint'},
        `${t('We store only your user ID and name there (and your GitHub username), not your email address. With a passkey, only its public key.')} `,
        h('a', {href: t('/privacy.html')}, t('Privacy')),
      ),
    ];
  };

  /**
   * "No account? Make one with a passkey": a name, the Turnstile check,
   * then the browser's passkey dialog.
   */
  const passkeySignUp = (fail: (e: unknown) => void) => {
    const form = h('form', {class: 'passkey-sign-up', hidden: true});
    const name = h('input', {
      type: 'text',
      maxlength: 60,
      autocomplete: 'name',
      placeholder: t('Your name (optional)'),
      'aria-label': t('Your name'),
    });
    const check = h('div', {class: 'turnstile'});
    const make = h(
      'button',
      {type: 'submit', class: 'primary', disabled: true},
      t('Make a passkey'),
    );
    form.append(name, check, make);
    let widget: Awaited<ReturnType<typeof turnstileWidget>> | undefined;
    form.addEventListener('submit', async e => {
      e.preventDefault();
      make.disabled = true;
      try {
        const made = await createPasskey({
          name: name.value.trim(),
          turnstile: widget?.token(),
        });
        if (made) {
          show(await loadAccount());
          return;
        }
      } catch (e) {
        fail(e);
      }
      // Each Turnstile token is good once.
      widget?.reset();
    });
    const open = h(
      'button',
      {
        type: 'button',
        class: 'link-button',
        onclick: async () => {
          open.hidden = true;
          form.hidden = false;
          name.focus();
          try {
            widget = await turnstileWidget(check, passed => {
              make.disabled = !passed;
            });
          } catch (e) {
            fail(e);
          }
        },
      },
      t('Make one with a passkey'),
    );
    return h('div', {class: 'passkey-new'}, `${t('No account?')} `, open, form);
  };

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
      } catch (e) {
        status.textContent = e instanceof PasskeyError ? e.message : failed;
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
              }, t('Couldn’t sign out. Try again.')),
          },
          t('Sign out'),
        ),
        h(
          'a',
          {class: 'button', href: '/api/export', download: 'g-sho-export.json'},
          t('Download my data'),
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'danger',
            onclick: () => {
              if (
                confirm(
                  t(
                    'Delete your g-sho account and everything stored with it? This can’t be undone. (What’s saved in this browser stays.)',
                  ),
                )
              ) {
                void act(async () => {
                  stopSync();
                  await deleteAccount();
                }, t('Couldn’t delete the account. Try again.'));
              }
            },
          },
          t('Delete account'),
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
      ...(passkeysSupported() || ids.some(i => i.provider === 'passkey')
        ? ['passkey']
        : []),
      // e.g. the dev sign-in
      ...ids
        .map(i => i.provider)
        .filter(id => id !== 'passkey' && !PROVIDERS.some(p => p.id === id)),
    ];
    const row = (provider: string) => {
      const label = providerLabel(provider);
      const i = ids.find(i => i.provider === provider);
      const who = !i
        ? h('span', {class: 'hint'}, '—')
        : provider === 'passkey'
          ? t('Added {date}', {
              date: new Date(i.createdAt).toLocaleDateString(),
            })
          : (i.name ?? (i.login ? `@${i.login}` : ''));
      const action = !i
        ? provider === 'passkey'
          ? h(
              'button',
              {
                type: 'button',
                onclick: () =>
                  void act(async () => {
                    await createPasskey({name: account.name, link: true});
                  }, t('Couldn’t add the passkey. Try again.')),
              },
              t('Add'),
            )
          : h(
              'a',
              {class: 'button', href: signInUrl(provider, true)},
              t('Link'),
            )
        : ids.length > 1 &&
          h(
            'button',
            {
              type: 'button',
              onclick: () => {
                if (
                  confirm(
                    t('Stop signing in with {provider}?', {provider: label}),
                  )
                ) {
                  void act(
                    () => unlink(provider),
                    t('Couldn’t remove {provider}. Try again.', {
                      provider: label,
                    }),
                  );
                }
              },
            },
            t('Remove'),
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
          t('Link more than one, in case you lose access to one.'),
        ),
    );
  };

  const state = await loadAccount();
  if (state.kind === 'unavailable') return null;
  show(state);
  return panel;
}
