/**
 * Passkeys in the browser (WebAuthn): making one (a new account, or one more
 * sign-in for this account) and signing in with one. The server checks them
 * (src/server/passkey.ts).
 */
import {t} from './i18n.ts';

/** Something went wrong that the person should read. */
export class PasskeyError extends Error {
  /** the server doesn't know this passkey */
  unknown = false;
}

/** Whether this browser can make passkeys the server can check. */
export function passkeysSupported(): boolean {
  return (
    typeof PublicKeyCredential !== 'undefined' &&
    typeof AuthenticatorAttestationResponse !== 'undefined' &&
    'getPublicKey' in AuthenticatorAttestationResponse.prototype
  );
}

function b64url(bytes: ArrayBuffer): string {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & {
    error?: string;
    unknown?: boolean;
  };
  if (!res.ok) {
    const e = new PasskeyError(
      data.error ?? t('Something went wrong ({status}).', {status: res.status}),
    );
    e.unknown = !!data.unknown;
    throw e;
  }
  return data;
}

interface Options {
  challenge: string;
  rpId: string;
  exclude: string[];
  algorithms: number[];
}

/** Cancelled, or timed out, in the browser's passkey dialog. */
function cancelled(e: unknown) {
  return e instanceof DOMException && e.name === 'NotAllowedError';
}

/**
 * Makes a passkey: a new account named `name` (with a Turnstile token), or
 * with `link`, one more sign-in for this account. False if cancelled.
 */
export async function createPasskey({
  name,
  turnstile,
  link = false,
}: {
  name: string;
  turnstile?: string;
  link?: boolean;
}): Promise<boolean> {
  // A new account's Turnstile check comes first: if it fails, no passkey
  // is made.
  const o = await post<Options>('/api/auth/passkey/options', {
    signUp: !link,
    turnstile,
  });
  let credential: PublicKeyCredential;
  try {
    credential = (await navigator.credentials.create({
      publicKey: {
        challenge: fromB64url(o.challenge),
        rp: {id: o.rpId, name: 'g-sho'},
        // Sign-in finds the account by the passkey, so this is only for
        // the password manager.
        user: {
          id: crypto.getRandomValues(new Uint8Array(16)),
          name: name || 'g-sho',
          displayName: name || 'g-sho',
        },
        pubKeyCredParams: o.algorithms.map(alg => ({type: 'public-key', alg})),
        authenticatorSelection: {
          residentKey: 'required',
          requireResidentKey: true,
          userVerification: 'preferred',
        },
        attestation: 'none',
        excludeCredentials: o.exclude.map(id => ({
          type: 'public-key',
          id: fromB64url(id),
        })),
        timeout: 120_000,
      },
    })) as PublicKeyCredential;
  } catch (e) {
    if (cancelled(e)) return false;
    if (e instanceof DOMException && e.name === 'InvalidStateError') {
      throw new PasskeyError(
        t('This device already has a passkey for your account.'),
      );
    }
    throw e;
  }
  const response = credential.response as AuthenticatorAttestationResponse;
  const publicKey = response.getPublicKey();
  if (!publicKey) {
    throw new PasskeyError(
      t('This passkey uses a kind of key g-sho doesn’t support.'),
    );
  }
  await post('/api/auth/passkey/register', {
    name,
    link,
    credential: {
      id: b64url(credential.rawId),
      clientDataJSON: b64url(response.clientDataJSON),
      authenticatorData: b64url(response.getAuthenticatorData()),
      publicKey: b64url(publicKey),
      algorithm: response.getPublicKeyAlgorithm(),
    },
  });
  return true;
}

/** Signs in with a passkey the browser offers. False if cancelled. */
export async function signInWithPasskey(): Promise<boolean> {
  const o = await post<Options>('/api/auth/passkey/options', {});
  let credential: PublicKeyCredential;
  try {
    credential = (await navigator.credentials.get({
      publicKey: {
        challenge: fromB64url(o.challenge),
        rpId: o.rpId,
        userVerification: 'preferred',
        timeout: 120_000,
      },
    })) as PublicKeyCredential;
  } catch (e) {
    if (cancelled(e)) return false;
    throw e;
  }
  const response = credential.response as AuthenticatorAssertionResponse;
  const id = b64url(credential.rawId);
  try {
    await post('/api/auth/passkey/signin', {
      credential: {
        id,
        clientDataJSON: b64url(response.clientDataJSON),
        authenticatorData: b64url(response.authenticatorData),
        signature: b64url(response.signature),
      },
    });
  } catch (e) {
    // A passkey for a deleted account, or one that was removed: let the
    // password manager drop it (where browsers support it).
    if (e instanceof PasskeyError && e.unknown) {
      const signal = (
        PublicKeyCredential as unknown as {
          signalUnknownCredential?: (o: {
            rpId: string;
            credentialId: string;
          }) => Promise<void>;
        }
      ).signalUnknownCredential;
      void signal
        ?.call(PublicKeyCredential, {rpId: o.rpId, credentialId: id})
        .catch(() => {});
    }
    throw e;
  }
  return true;
}
