/**
 * The optional g-sho account (sign in with Google, GitHub or LINE), via
 * the Worker's /api.
 * On a plain static host there's no /api, and the account is "unavailable":
 * the app works the same, just without sign-in.
 */

export interface Account {
  id: string;
  name: string;
  createdAt: number;
  identities: {
    provider: string;
    login: string | null;
    /** their name there (null: not signed in with it since that was kept) */
    name: string | null;
    createdAt: number;
  }[];
}

export type AccountState =
  | {kind: 'unavailable'}
  | {kind: 'signed-out'}
  | {kind: 'signed-in'; account: Account};

export async function loadAccount(): Promise<AccountState> {
  try {
    const res = await fetch('/api/me', {cache: 'no-store'});
    const isJson = res.headers
      .get('content-type')
      ?.startsWith('application/json');
    if (res.status === 401 && isJson) return {kind: 'signed-out'};
    if (res.ok && isJson) {
      return {kind: 'signed-in', account: (await res.json()) as Account};
    }
  } catch {
    // Offline, or no server.
  }
  return {kind: 'unavailable'};
}

/** The ways to sign in, as the server names them. */
export const PROVIDERS = [
  {id: 'google', label: 'Google'},
  {id: 'github', label: 'GitHub'},
  {id: 'line', label: 'LINE'},
] as const;

export function providerLabel(id: string): string {
  if (id === 'passkey') return 'Passkey';
  return PROVIDERS.find(p => p.id === id)?.label ?? id;
}

/**
 * Where "Sign in with …" goes, or (`link`) adding that sign-in to this
 * account; comes back to this page afterwards.
 */
export function signInUrl(provider: string, link = false): string {
  const back = location.pathname + location.search;
  return (
    `/api/auth/${provider}/start?return=${encodeURIComponent(back)}` +
    (link ? '&link=1' : '')
  );
}

async function send(method: string, path: string) {
  const res = await fetch(path, {method});
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status}`);
}

export const signOut = () => send('POST', '/api/auth/logout');
export const deleteAccount = () => send('DELETE', '/api/me');
export const unlink = (provider: string) =>
  send('DELETE', `/api/me/identities/${encodeURIComponent(provider)}`);
