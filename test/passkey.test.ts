import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {beforeEach, describe, test} from 'node:test';
import {handle, type Env} from '../src/server/worker.ts';
import {createTestDb, testUserStores} from './d1-shim.ts';

const ORIGIN = 'https://g-sho.org';

let env: Env & {DB: ReturnType<typeof createTestDb>};

beforeEach(() => {
  env = {
    ASSETS: {fetch: async () => new Response('static')},
    DB: createTestDb(),
    USER_STORE: testUserStores(),
    GITHUB_CLIENT_ID: 'client-id',
    GITHUB_CLIENT_SECRET: 'client-secret',
    GOOGLE_CLIENT_ID: 'google-id',
    GOOGLE_CLIENT_SECRET: 'google-secret',
    LINE_CHANNEL_ID: 'line-id',
    LINE_CHANNEL_SECRET: 'line-secret',
    DEV_LOGIN: '1',
  };
});

const b64url = (b: Uint8Array | ArrayBuffer) =>
  Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString(
    'base64url',
  );
const sha256 = (data: string | Uint8Array) =>
  createHash('sha256').update(data).digest();

/** A browser with cookies, against the Worker. */
class Browser {
  cookies = new Map<string, string>();

  async fetch(path: string, body?: unknown, origin = ORIGIN) {
    const headers = new Headers({origin});
    if (this.cookies.size) {
      headers.set(
        'cookie',
        [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
      );
    }
    const res = await handle(
      new Request(origin + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env,
    );
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const value = pair.slice(i + 1);
      if (value) this.cookies.set(pair.slice(0, i), value);
      else this.cookies.delete(pair.slice(0, i));
    }
    return res;
  }

  async me() {
    return (await this.fetch('/api/me')).json();
  }
}

/** A passkey in a password manager: an ES256 key and a credential ID. */
class Authenticator {
  id = crypto.getRandomValues(new Uint8Array(16));
  keys!: CryptoKeyPair;
  count = 0;
  rpId = 'g-sho.org';

  async init() {
    this.keys = await crypto.subtle.generateKey(
      {name: 'ECDSA', namedCurve: 'P-256'},
      false,
      ['sign', 'verify'],
    );
    return this;
  }

  authData(attested: boolean) {
    const flags = attested ? 0x45 : 0x05; // UP, UV (and AT)
    const head = Buffer.alloc(37);
    sha256(this.rpId).copy(head, 0);
    head[32] = flags;
    head.writeUInt32BE(this.count, 33);
    if (!attested) return head;
    const length = Buffer.alloc(2);
    length.writeUInt16BE(this.id.length);
    // aaguid, ID length, ID; the COSE key isn't read by the server.
    return Buffer.concat([head, Buffer.alloc(16), length, this.id]);
  }

  clientData(type: string, challenge: string, origin = ORIGIN) {
    return Buffer.from(JSON.stringify({type, challenge, origin}));
  }

  /** What navigator.credentials.create() gives the page, as it sends it. */
  async create(challenge: string, overrides: {origin?: string} = {}) {
    const spki = await crypto.subtle.exportKey('spki', this.keys.publicKey);
    return {
      id: b64url(this.id),
      clientDataJSON: b64url(
        this.clientData('webauthn.create', challenge, overrides.origin),
      ),
      authenticatorData: b64url(this.authData(true)),
      publicKey: b64url(spki),
      algorithm: -7,
    };
  }

  /** What navigator.credentials.get() gives the page. */
  async get(challenge: string, overrides: {origin?: string} = {}) {
    const authData = this.authData(false);
    const clientData = this.clientData(
      'webauthn.get',
      challenge,
      overrides.origin,
    );
    const raw = new Uint8Array(
      await crypto.subtle.sign(
        {name: 'ECDSA', hash: 'SHA-256'},
        this.keys.privateKey,
        Buffer.concat([authData, sha256(clientData)]),
      ),
    );
    return {
      id: b64url(this.id),
      clientDataJSON: b64url(clientData),
      authenticatorData: b64url(authData),
      signature: b64url(toDer(raw)),
    };
  }
}

/** r||s to the DER that WebAuthn uses. */
function toDer(raw: Uint8Array) {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    const v = b.subarray(i);
    const bytes = v[0] & 0x80 ? Buffer.concat([Buffer.from([0]), v]) : v;
    return Buffer.concat([Buffer.from([0x02, bytes.length]), bytes]);
  };
  const body = Buffer.concat([int(raw.subarray(0, 32)), int(raw.subarray(32))]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

async function challenge(
  browser: Browser,
  body: {signUp?: boolean; turnstile?: string} = {},
) {
  const res = await browser.fetch('/api/auth/passkey/options', body);
  assert.equal(res.status, 200);
  return (await res.json()) as {
    challenge: string;
    rpId: string;
    exclude: string[];
  };
}

async function signUp(browser: Browser, key: Authenticator, name = 'Amy') {
  const {challenge: c} = await challenge(browser, {signUp: true});
  return browser.fetch('/api/auth/passkey/register', {
    name,
    credential: await key.create(c),
  });
}

async function signIn(browser: Browser, key: Authenticator) {
  const {challenge: c} = await challenge(browser);
  return browser.fetch('/api/auth/passkey/signin', {
    credential: await key.get(c),
  });
}

describe('passkeys', () => {
  test('options give a challenge for this site', async () => {
    const browser = new Browser();
    const o = await challenge(browser);
    assert.equal(o.rpId, 'g-sho.org');
    assert.ok(o.challenge.length > 20);
    assert.ok(browser.cookies.get('passkey-challenge'));
  });

  test('a passkey makes an account, and signs back in to it', async () => {
    const key = await new Authenticator().init();
    const a = new Browser();
    assert.equal((await signUp(a, key, 'Amy')).status, 200);
    const me = await a.me();
    assert.equal(me.name, 'Amy');
    assert.deepEqual(
      me.identities.map((i: {provider: string}) => i.provider),
      ['passkey'],
    );

    const b = new Browser();
    const res = await signIn(b, key);
    assert.equal(res.status, 200);
    assert.equal((await b.me()).id, me.id);
  });

  test('the challenge is only good once', async () => {
    const key = await new Authenticator().init();
    await signUp(new Browser(), key);
    const browser = new Browser();
    const {challenge: c} = await challenge(browser);
    const credential = await key.get(c);
    const first = await browser.fetch('/api/auth/passkey/signin', {credential});
    assert.equal(first.status, 200);
    browser.cookies.delete('__Host-session');
    const again = await browser.fetch('/api/auth/passkey/signin', {credential});
    assert.equal(again.status, 400);
  });

  test('a response for another site or challenge is refused', async () => {
    const key = await new Authenticator().init();
    await signUp(new Browser(), key);

    const wrongOrigin = new Browser();
    const {challenge: c} = await challenge(wrongOrigin);
    const res = await wrongOrigin.fetch('/api/auth/passkey/signin', {
      credential: await key.get(c, {origin: 'https://evil.example'}),
    });
    assert.equal(res.status, 400);

    const wrongChallenge = new Browser();
    await challenge(wrongChallenge);
    const res2 = await wrongChallenge.fetch('/api/auth/passkey/signin', {
      credential: await key.get('made-up'),
    });
    assert.equal(res2.status, 400);

    const otherRp = await new Authenticator().init();
    otherRp.rpId = 'evil.example';
    const res3 = await signUp(new Browser(), otherRp);
    assert.equal(res3.status, 400);
  });

  test('a signature from a different key is refused', async () => {
    const key = await new Authenticator().init();
    await signUp(new Browser(), key);
    const impostor = await new Authenticator().init();
    impostor.id = key.id;
    const res = await signIn(new Browser(), impostor);
    assert.equal(res.status, 400);
    assert.equal((await new Browser().me()).error, 'not signed in');
  });

  test('a counter going backwards is refused', async () => {
    const key = await new Authenticator().init();
    key.count = 5;
    await signUp(new Browser(), key);
    key.count = 7;
    assert.equal((await signIn(new Browser(), key)).status, 200);
    key.count = 3;
    const browser = new Browser();
    const {challenge: c} = await challenge(browser);
    const res = await browser.fetch('/api/auth/passkey/signin', {
      credential: await key.get(c),
    });
    assert.equal(res.status, 400);
  });

  test('an unknown passkey is refused', async () => {
    const key = await new Authenticator().init();
    const res = await signIn(new Browser(), key);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /doesn’t know that passkey/);
  });

  test('a signed-in user can add a passkey, and remove it', async () => {
    const browser = new Browser();
    await browser.fetch('/api/auth/dev/start?name=amy');
    const key = await new Authenticator().init();
    const {challenge: c} = await challenge(browser);
    const res = await browser.fetch('/api/auth/passkey/register', {
      link: true,
      credential: await key.create(c),
    });
    assert.equal(res.status, 200);
    const me = await browser.me();
    assert.deepEqual(
      me.identities.map((i: {provider: string}) => i.provider),
      ['dev', 'passkey'],
    );
    // Its ID is excluded from making another one here.
    assert.deepEqual((await challenge(browser)).exclude, [b64url(key.id)]);
    // And it signs in to the same account.
    const other = new Browser();
    await signIn(other, key);
    assert.equal((await other.me()).id, me.id);

    const del = await handle(
      new Request(`${ORIGIN}/api/me/identities/passkey`, {
        method: 'DELETE',
        headers: {
          origin: ORIGIN,
          cookie: `__Host-session=${browser.cookies.get('__Host-session')}`,
        },
      }),
      env,
    );
    assert.equal(del.status, 200);
    const n = env.DB.raw.prepare('SELECT COUNT(*) AS n FROM passkeys').get();
    assert.equal(n?.n, 0);
    assert.equal((await signIn(new Browser(), key)).status, 400);
  });

  test('deleting the account deletes its passkeys', async () => {
    const browser = new Browser();
    await signUp(browser, await new Authenticator().init());
    const res = await handle(
      new Request(`${ORIGIN}/api/me`, {
        method: 'DELETE',
        headers: {
          origin: ORIGIN,
          cookie: `__Host-session=${browser.cookies.get('__Host-session')}`,
        },
      }),
      env,
    );
    assert.equal(res.status, 200);
    const n = env.DB.raw.prepare('SELECT COUNT(*) AS n FROM passkeys').get();
    assert.equal(n?.n, 0);
  });

  test('a new account needs a sign-up challenge', async () => {
    // A sign-in challenge (no Turnstile check) can't make an account.
    const browser = new Browser();
    const {challenge: c} = await challenge(browser);
    const key = await new Authenticator().init();
    const res = await browser.fetch('/api/auth/passkey/register', {
      credential: await key.create(c),
    });
    assert.equal(res.status, 400);
    const n = env.DB.raw.prepare('SELECT COUNT(*) AS n FROM users').get();
    assert.equal(n?.n, 0);
  });

  test('with Turnstile on, sign-up needs a passing token first', async () => {
    env.TURNSTILE_SECRET = 'turnstile-secret';
    const realFetch = globalThis.fetch;
    const asked: string[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      assert.equal(
        url,
        'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      );
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get('secret'), 'turnstile-secret');
      asked.push(body.get('response')!);
      return Response.json({success: body.get('response') === 'good'});
    };
    try {
      // Refused before any passkey is made: no challenge.
      for (const turnstile of [undefined, 'bad']) {
        const browser = new Browser();
        const res = await browser.fetch('/api/auth/passkey/options', {
          signUp: true,
          turnstile,
        });
        assert.equal(res.status, 400, String(turnstile));
        assert.equal(browser.cookies.has('passkey-challenge'), false);
      }
      const browser = new Browser();
      const key = await new Authenticator().init();
      const {challenge: c} = await challenge(browser, {
        signUp: true,
        turnstile: 'good',
      });
      const res = await browser.fetch('/api/auth/passkey/register', {
        credential: await key.create(c),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(asked, ['bad', 'good']);
      // Signing in with it doesn't ask.
      assert.equal((await signIn(new Browser(), key)).status, 200);
      assert.equal(asked.length, 2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
