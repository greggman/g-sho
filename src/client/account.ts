/**
 * The optional g-sho account (sign in with GitHub), via the Worker's /api.
 * On a plain static host there's no /api, and the account is "unavailable":
 * the app works the same, just without sign-in.
 */

export interface Account {
  id: string;
  name: string;
  createdAt: number;
  identities: {provider: string; login: string | null; createdAt: number}[];
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

/** Where "Sign in with GitHub" goes; comes back to this page afterwards. */
export function signInUrl(): string {
  const back = location.pathname + location.search;
  return `/api/auth/github/start?return=${encodeURIComponent(back)}`;
}

async function send(method: string, path: string) {
  const res = await fetch(path, {method});
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status}`);
}

export const signOut = () => send('POST', '/api/auth/logout');
export const deleteAccount = () => send('DELETE', '/api/me');
