/**
 * Sign-in with passkeys (WebAuthn), with no outside service.
 *
 * The browser hands over the new passkey's public key (SPKI, from
 * getPublicKey()) along with its authenticator data, so nothing here
 * parses CBOR. Registration checks the client data (type, challenge,
 * origin) and the authenticator data (our RP ID, user present, the same
 * credential ID); we ask for no attestation, so the key itself is taken as
 * given. Sign-in checks the same, plus the signature over the
 * authenticator data and the client data's hash, with the stored key.
 *
 * A passkey is an identity ('passkey', credential ID) like any other, so
 * linking and removing work the same. Creating an account with only a
 * passkey costs nothing, so it needs a Turnstile token when TURNSTILE_SECRET
 * is set: checked before the browser makes the passkey (with the challenge),
 * so a failed check doesn't leave a passkey for an account that isn't.
 */
import {
  failureJson,
  linkIdentity,
  startSessionFor,
  getSession,
  type Identity,
} from './auth.ts';
import type {Env} from './env.ts';
import {cookie, json, parseCookies, randomToken} from './http.ts';

const CHALLENGE_COOKIE = 'passkey-challenge';
const CHALLENGE_LIFETIME_S = 5 * 60;
/** On a challenge cookie: Turnstile passed, so it may make an account. */
const SIGN_UP = 'sign-up';
const TURNSTILE_VERIFY =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** ES256 and RS256: what every passkey provider supports. */
const ES256 = -7;
const RS256 = -257;

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(text: unknown): Uint8Array<ArrayBuffer> {
  if (typeof text !== 'string' || !/^[\w-]*$/.test(text)) {
    throw new Error('not base64url');
  }
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

async function sha256Bytes(data: Uint8Array<ArrayBuffer>) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

function equalBytes(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function isSecure(url: URL) {
  return url.protocol === 'https:';
}

function challengeCookie(url: URL, value: string, maxAge: number) {
  return cookie(CHALLENGE_COOKIE, value, {
    path: '/api/auth/',
    maxAge,
    secure: isSecure(url),
  });
}

/**
 * POST /api/auth/passkey/options {signUp?, turnstile?} — a challenge (kept
 * in a cookie until it's used), and what the browser needs to create or use
 * a passkey. For a new account (signUp), only with a passing Turnstile
 * token; the cookie then says so.
 */
export async function passkeyOptions(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const body = (await request.json().catch(() => ({}))) as {
    signUp?: boolean;
    turnstile?: string;
  };
  const challenge = randomToken();
  if (
    body.signUp &&
    !(await turnstileOk(
      env,
      body.turnstile,
      request.headers.get('cf-connecting-ip'),
    ))
  ) {
    return failureJson(
      'The check that you’re a person didn’t pass. Please try again.',
    );
  }
  // Linking: don't let the browser make a second passkey for this account
  // in the same password manager.
  const session = await getSession(request, env);
  const exclude = session
    ? (
        await env.DB.prepare(
          'SELECT credential_id FROM passkeys WHERE user_id = ?',
        )
          .bind(session.user.id)
          .all<{credential_id: string}>()
      ).results.map(r => r.credential_id)
    : [];
  return json(
    {challenge, rpId: url.hostname, exclude, algorithms: [ES256, RS256]},
    {
      headers: {
        'set-cookie': challengeCookie(
          url,
          body.signUp ? `${challenge}.${SIGN_UP}` : challenge,
          CHALLENGE_LIFETIME_S,
        ),
      },
    },
  );
}

interface ClientData {
  type?: string;
  challenge?: string;
  origin?: string;
}

/**
 * Checks what every WebAuthn response carries: the client data (`type`,
 * our challenge, our origin) and the authenticator data (our RP ID, user
 * present). The authenticator data, or a reason it's refused.
 */
async function checkResponse(
  request: Request,
  type: 'webauthn.create' | 'webauthn.get',
  clientDataJSON: Uint8Array<ArrayBuffer>,
  authData: Uint8Array<ArrayBuffer>,
): Promise<string | undefined> {
  const url = new URL(request.url);
  let client: ClientData;
  try {
    client = JSON.parse(new TextDecoder().decode(clientDataJSON)) as ClientData;
  } catch {
    return 'bad client data';
  }
  const expected = parseCookies(request).get(CHALLENGE_COOKIE)?.split('.')[0];
  if (client.type !== type) return 'wrong type';
  if (!expected || client.challenge !== expected) return 'wrong challenge';
  if (client.origin !== url.origin) return 'wrong origin';
  if (authData.length < 37) return 'short authenticator data';
  const rpIdHash = await sha256Bytes(new TextEncoder().encode(url.hostname));
  if (!equalBytes(authData.subarray(0, 32), rpIdHash)) return 'wrong RP ID';
  if (!(authData[32] & 0x01)) return 'user not present';
  return undefined;
}

function signCount(authData: Uint8Array) {
  return new DataView(authData.buffer, authData.byteOffset).getUint32(33);
}

/** The credential ID in registration's authenticator data (attested data). */
function attestedCredentialId(authData: Uint8Array): Uint8Array | undefined {
  if (!(authData[32] & 0x40) || authData.length < 55) return undefined;
  const length = (authData[53] << 8) | authData[54];
  if (authData.length < 55 + length) return undefined;
  return authData.subarray(55, 55 + length);
}

async function importKey(spki: Uint8Array<ArrayBuffer>, alg: number) {
  return alg === ES256
    ? crypto.subtle.importKey(
        'spki',
        spki,
        {name: 'ECDSA', namedCurve: 'P-256'},
        false,
        ['verify'],
      )
    : crypto.subtle.importKey(
        'spki',
        spki,
        {name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256'},
        false,
        ['verify'],
      );
}

/**
 * WebAuthn's ECDSA signatures are DER (SEQUENCE of two INTEGERs);
 * WebCrypto wants r and s as 32 bytes each.
 */
function derToRaw(der: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(64);
  if (der[0] !== 0x30) throw new Error('not DER');
  let i = 2;
  for (const offset of [0, 32]) {
    if (der[i] !== 0x02) throw new Error('not DER');
    let length = der[i + 1];
    let start = i + 2;
    // Drop the sign byte, and any other leading zeros.
    while (length > 32 && der[start] === 0) {
      start++;
      length--;
    }
    if (length > 32) throw new Error('not DER');
    out.set(der.subarray(start, start + length), offset + 32 - length);
    i = start + length;
  }
  return out;
}

async function turnstileOk(
  env: Env,
  token: unknown,
  ip: string | null,
): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) return true;
  if (typeof token !== 'string' || !token) return false;
  const body = new URLSearchParams({
    secret: env.TURNSTILE_SECRET,
    response: token,
  });
  if (ip) body.set('remoteip', ip);
  const res = await fetch(TURNSTILE_VERIFY, {method: 'POST', body});
  const result = (await res.json().catch(() => ({}))) as {success?: boolean};
  return result.success === true;
}

interface RegisterBody {
  /** add to the signed-in account, instead of making one */
  link?: boolean;
  /** a new account's name */
  name?: string;
  credential?: {
    id?: string;
    clientDataJSON?: string;
    authenticatorData?: string;
    publicKey?: string;
    algorithm?: number;
  };
}

const NAME_MAX_LENGTH = 60;

/**
 * POST /api/auth/passkey/register — saves a new passkey: a new account
 * signed in with it, or (link) one more sign-in for this account.
 */
export async function passkeyRegister(
  request: Request,
  env: Env,
  now = Date.now(),
): Promise<Response> {
  const url = new URL(request.url);
  const body = (await request.json().catch(() => ({}))) as RegisterBody;
  const c = body.credential ?? {};
  let clientDataJSON, authData, publicKey, id;
  try {
    clientDataJSON = fromB64url(c.clientDataJSON);
    authData = fromB64url(c.authenticatorData);
    publicKey = fromB64url(c.publicKey);
    id = fromB64url(c.id);
  } catch {
    return failureJson('That passkey couldn’t be read.');
  }
  const wrong = await checkResponse(
    request,
    'webauthn.create',
    clientDataJSON,
    authData,
  );
  const attested = attestedCredentialId(authData);
  if (wrong || !attested || !equalBytes(attested, id) || !id.length) {
    console.error(`passkey registration refused: ${wrong ?? 'credential ID'}`);
    return failureJson('That passkey couldn’t be saved. Please try again.');
  }
  const algorithm = c.algorithm;
  if (algorithm !== ES256 && algorithm !== RS256) {
    return failureJson(
      'This passkey uses a kind of key g-sho doesn’t support.',
    );
  }
  try {
    await importKey(publicKey, algorithm);
  } catch {
    return failureJson('That passkey’s key couldn’t be read.');
  }

  const credentialId = b64url(id);
  const name =
    String(body.name ?? '')
      .trim()
      .slice(0, NAME_MAX_LENGTH) || 'g-sho user';
  const identity: Identity = {provider: 'passkey', subject: credentialId, name};
  const savePasskey = (userId: string) =>
    env.DB.prepare(
      'INSERT INTO passkeys (credential_id, user_id, public_key, algorithm, sign_count, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(
        credentialId,
        userId,
        b64url(publicKey),
        algorithm,
        signCount(authData),
        now,
      )
      .run();
  const clear = challengeCookie(url, '', 0);

  if (body.link) {
    const session = await getSession(request, env, now);
    if (!session)
      return failureJson(
        'You were signed out. Sign in, then add the passkey again.',
      );
    const refused = await linkIdentity(env, session.user.id, identity, now);
    if (refused) return failureJson(refused);
    await savePasskey(session.user.id);
    return json({ok: true}, {headers: {'set-cookie': clear}});
  }

  const signUp = parseCookies(request).get(CHALLENGE_COOKIE)?.split('.')[1];
  if (signUp !== SIGN_UP) {
    return failureJson('That passkey couldn’t be saved. Please try again.');
  }
  const {userId, sessionCookie} = await startSessionFor(
    request,
    env,
    identity,
    now,
  );
  await savePasskey(userId);
  const headers = new Headers({'cache-control': 'no-store'});
  headers.append('set-cookie', clear);
  headers.append('set-cookie', sessionCookie);
  return json({ok: true}, {headers});
}

interface SignInBody {
  credential?: {
    id?: string;
    clientDataJSON?: string;
    authenticatorData?: string;
    signature?: string;
  };
}

/** POST /api/auth/passkey/signin — signs in with a saved passkey. */
export async function passkeySignIn(
  request: Request,
  env: Env,
  now = Date.now(),
): Promise<Response> {
  const url = new URL(request.url);
  const body = (await request.json().catch(() => ({}))) as SignInBody;
  const c = body.credential ?? {};
  let clientDataJSON, authData, signature;
  try {
    clientDataJSON = fromB64url(c.clientDataJSON);
    authData = fromB64url(c.authenticatorData);
    signature = fromB64url(c.signature);
    fromB64url(c.id);
  } catch {
    return failureJson('That passkey couldn’t be read.');
  }
  // `unknown`: the page tells the password manager it can drop it.
  const unknown = json(
    {
      error:
        'g-sho doesn’t know that passkey. It may belong to an account that was deleted, or the passkey was removed.',
      unknown: true,
    },
    {status: 400},
  );
  const saved = await env.DB.prepare(
    'SELECT user_id, public_key, algorithm, sign_count FROM passkeys WHERE credential_id = ?',
  )
    .bind(c.id)
    .first<{
      user_id: string;
      public_key: string;
      algorithm: number;
      sign_count: number;
    }>();
  if (!saved) return unknown;

  const wrong = await checkResponse(
    request,
    'webauthn.get',
    clientDataJSON,
    authData,
  );
  if (wrong) {
    console.error(`passkey sign-in refused: ${wrong}`);
    return failureJson('That sign-in didn’t check out. Please try again.');
  }
  const key = await importKey(fromB64url(saved.public_key), saved.algorithm);
  const signed = new Uint8Array(authData.length + 32);
  signed.set(authData);
  signed.set(await sha256Bytes(clientDataJSON), authData.length);
  let valid = false;
  try {
    valid =
      saved.algorithm === ES256
        ? await crypto.subtle.verify(
            {name: 'ECDSA', hash: 'SHA-256'},
            key,
            derToRaw(signature),
            signed,
          )
        : await crypto.subtle.verify(
            'RSASSA-PKCS1-v1_5',
            key,
            signature,
            signed,
          );
  } catch {
    valid = false;
  }
  if (!valid) {
    console.error('passkey sign-in refused: bad signature');
    return failureJson('That sign-in didn’t check out. Please try again.');
  }
  // Synced passkeys always say 0. A counter that goes backwards means a
  // copied authenticator.
  const count = signCount(authData);
  if (count !== 0 || saved.sign_count !== 0) {
    if (count <= saved.sign_count) {
      console.error('passkey sign-in refused: sign count went backwards');
      return failureJson(
        'That passkey looks like a copy. Sign in another way.',
      );
    }
  }
  await env.DB.prepare(
    'UPDATE passkeys SET sign_count = ?, last_used_at = ? WHERE credential_id = ?',
  )
    .bind(count, now, c.id)
    .run();

  const identity = await env.DB.prepare(
    "SELECT name FROM identities WHERE provider = 'passkey' AND subject = ?",
  )
    .bind(c.id)
    .first<{name: string | null}>();
  if (!identity) return unknown;
  const {sessionCookie} = await startSessionFor(
    request,
    env,
    {provider: 'passkey', subject: c.id!, name: identity.name ?? 'g-sho user'},
    now,
  );
  const headers = new Headers({'cache-control': 'no-store'});
  headers.append('set-cookie', challengeCookie(url, '', 0));
  headers.append('set-cookie', sessionCookie);
  return json({ok: true}, {headers});
}
