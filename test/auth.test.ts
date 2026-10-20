import assert from 'node:assert/strict';
import {afterEach, beforeEach, describe, test} from 'node:test';
import {SESSION_LIFETIME} from '../src/server/auth.ts';
import {safeReturnPath, sha256} from '../src/server/http.ts';
import {handle, type Env} from '../src/server/worker.ts';
import {createTestDb, testUserStores} from './d1-shim.ts';

const ORIGIN = 'https://g-sho.org';

let env: Env & {DB: ReturnType<typeof createTestDb>};
let realFetch: typeof fetch;
/** what the fake GitHub returns for /user */
let githubUser: {id: number; login: string; name: string | null};
let revoked: string[];
/**
 * what the fake Google (or LINE) puts in the ID token (nonce: the one asked
 * for; issuer and audience: that provider's)
 */
let googleClaims: Record<string, unknown>;
/** the last OpenID Connect authorize request's nonce and code_challenge */
let googleAsked: {nonce: string; challenge: string};

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
  };
  githubUser = {id: 42, login: 'octocat', name: 'The Octocat'};
  revoked = [];
  googleClaims = {
    iss: 'https://accounts.google.com',
    aud: 'google-id',
    sub: '1001',
    name: '山田 花子',
  };
  googleAsked = {nonce: '', challenge: ''};
  realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === 'https://github.com/login/oauth/access_token') {
      const body = JSON.parse(String(init?.body));
      if (body.code !== 'good-code' || body.client_secret !== 'client-secret') {
        return Response.json({error: 'bad_verification_code'});
      }
      return Response.json({access_token: 'gh-token'});
    }
    if (url === 'https://api.github.com/user') {
      assert.equal(
        new Headers(init?.headers).get('authorization'),
        'Bearer gh-token',
      );
      return Response.json(githubUser);
    }
    if (url === 'https://api.github.com/applications/client-id/token') {
      revoked.push(JSON.parse(String(init?.body)).access_token);
      return new Response(null, {status: 204});
    }
    const oidc = {
      'https://oauth2.googleapis.com/token': {
        secret: 'google-secret',
        iss: 'https://accounts.google.com',
        aud: 'google-id',
      },
      'https://api.line.me/oauth2/v2.1/token': {
        secret: 'line-secret',
        iss: 'https://access.line.me',
        aud: 'line-id',
      },
    }[url];
    if (oidc) {
      const body = new URLSearchParams(String(init?.body));
      if (
        body.get('code') !== 'good-code' ||
        body.get('client_secret') !== oidc.secret ||
        (await sha256(body.get('code_verifier') ?? '')) !==
          googleAsked.challenge
      ) {
        return Response.json({error: 'invalid_grant'}, {status: 400});
      }
      const claims = {
        iss: oidc.iss,
        aud: oidc.aud,
        nonce: googleAsked.nonce,
        exp: Math.floor(Date.now() / 1000) + 3600,
        ...googleClaims,
      };
      const part = (o: object) =>
        Buffer.from(JSON.stringify(o)).toString('base64url');
      return Response.json({
        id_token: `${part({alg: 'RS256'})}.${part(claims)}.sig`,
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Runs a request through the Worker, waiting for any waitUntil work. */
async function request(
  path: string,
  init: RequestInit & {cookies?: string[]} = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.cookies?.length) headers.set('cookie', init.cookies.join('; '));
  const pending: Promise<unknown>[] = [];
  const res = await handle(
    new Request(ORIGIN + path, {...init, headers}),
    env,
    {
      waitUntil: p => pending.push(p),
    },
  );
  await Promise.all(pending);
  return res;
}

/** "name=value" pairs from a response's Set-Cookie headers. */
function setCookies(res: Response): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    out.set(pair.slice(0, i), pair.slice(i + 1));
  }
  return out;
}

/**
 * Goes through a provider's sign-in, to its callback's response. `session`:
 * already signed in (to link).
 */
async function roundTrip(
  provider: string,
  {
    returnPath = '/?q=猫',
    link = false,
    session,
  }: {returnPath?: string; link?: boolean; session?: string} = {},
): Promise<Response> {
  const start = await request(
    `/api/auth/${provider}/start?return=${encodeURIComponent(returnPath)}` +
      (link ? '&link=1' : ''),
  );
  assert.equal(start.status, 302);
  const authorize = new URL(start.headers.get('location')!);
  const state = authorize.searchParams.get('state')!;
  if (provider === 'google' || provider === 'line') {
    googleAsked = {
      nonce: authorize.searchParams.get('nonce')!,
      challenge: authorize.searchParams.get('code_challenge')!,
    };
  }
  const stateCookie = `oauth-state=${setCookies(start).get('oauth-state')}`;
  return request(
    `/api/auth/${provider}/callback?code=good-code&state=${state}`,
    {cookies: [stateCookie, ...(session ? [session] : [])]},
  );
}

/** Signs in through a provider's flow; returns the session cookie. */
async function signIn(
  returnPath = '/?q=猫',
  provider = 'github',
): Promise<string> {
  const back = await roundTrip(provider, {returnPath});
  assert.equal(back.status, 302);
  assert.equal(back.headers.get('location'), safeReturnPath(returnPath));
  const token = setCookies(back).get('__Host-session');
  assert.ok(token);
  return `__Host-session=${token}`;
}

/** A state cookie for a flow, as a start request would set it. */
const flowCookie = (state: string, back = '/') =>
  `oauth-state=${state}.${encodeURIComponent(JSON.stringify({back}))}`;

async function me(cookie: string) {
  return (await request('/api/me', {cookies: [cookie]})).json();
}

describe('GitHub sign-in', () => {
  test('start redirects to GitHub with a state cookie', async () => {
    const res = await request('/api/auth/github/start?return=/about.html');
    const url = new URL(res.headers.get('location')!);
    assert.equal(
      url.origin + url.pathname,
      'https://github.com/login/oauth/authorize',
    );
    assert.equal(url.searchParams.get('client_id'), 'client-id');
    assert.equal(
      url.searchParams.get('redirect_uri'),
      'https://g-sho.org/api/auth/github/callback',
    );
    assert.equal(url.searchParams.has('scope'), false);
    const cookie = res.headers.getSetCookie()[0];
    const value = cookie.slice('oauth-state='.length, cookie.indexOf(';'));
    const flow = JSON.parse(
      decodeURIComponent(value.slice(value.indexOf('.') + 1)),
    );
    assert.deepEqual(flow, {back: '/about.html'});
    assert.match(cookie, /Path=\/api\/auth\/; HttpOnly; SameSite=Lax; Secure/);
  });

  test('callback creates the user and a session, then returns', async () => {
    const cookie = await signIn('/?q=猫');
    const me = await request('/api/me', {cookies: [cookie]});
    assert.equal(me.status, 200);
    const body = await me.json();
    assert.equal(body.name, 'The Octocat');
    assert.deepEqual(
      body.identities.map((i: {provider: string; login: string}) => [
        i.provider,
        i.login,
      ]),
      [['github', 'octocat']],
    );
    // GitHub's token was only needed once.
    assert.deepEqual(revoked, ['gh-token']);
    // Only a hash of the session token is stored.
    const [row] = env.DB.raw.prepare('SELECT token_hash FROM sessions').all();
    assert.notEqual(row.token_hash, cookie.split('=')[1]);
  });

  test('signing in again finds the same user', async () => {
    const a = await (
      await request('/api/me', {cookies: [await signIn()]})
    ).json();
    githubUser.login = 'renamed';
    const b = await (
      await request('/api/me', {cookies: [await signIn()]})
    ).json();
    assert.equal(a.id, b.id);
    assert.equal(b.identities[0].login, 'renamed');
    const users = env.DB.raw.prepare('SELECT COUNT(*) AS n FROM users').get();
    assert.equal(users?.n, 1);
  });

  test('a different GitHub user gets a different account', async () => {
    const a = await (
      await request('/api/me', {cookies: [await signIn()]})
    ).json();
    githubUser = {id: 7, login: 'other', name: null};
    const b = await (
      await request('/api/me', {cookies: [await signIn()]})
    ).json();
    assert.notEqual(a.id, b.id);
    assert.equal(b.name, 'other');
  });

  test('a wrong or missing state is refused', async () => {
    const res = await request(
      '/api/auth/github/callback?code=good-code&state=forged',
      {cookies: [flowCookie('real')]},
    );
    assert.equal(res.status, 400);
    assert.equal(setCookies(res).has('__Host-session'), false);
    const none = await request(
      '/api/auth/github/callback?code=good-code&state=x',
    );
    assert.equal(none.status, 400);
  });

  test('a code GitHub rejects fails', async () => {
    const res = await request('/api/auth/github/callback?code=bad&state=s', {
      cookies: [flowCookie('s')],
    });
    assert.equal(res.status, 400);
  });

  test('cancelling on GitHub goes back without signing in', async () => {
    const res = await request(
      '/api/auth/github/callback?error=access_denied&state=s',
      {cookies: [flowCookie('s', '/about.html')]},
    );
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/about.html');
  });
});

describe('Google sign-in', () => {
  test('start asks for openid profile, with PKCE and a nonce', async () => {
    const res = await request('/api/auth/google/start?return=/x');
    const url = new URL(res.headers.get('location')!);
    assert.equal(
      url.origin + url.pathname,
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    const p = url.searchParams;
    assert.equal(p.get('client_id'), 'google-id');
    assert.equal(p.get('scope'), 'openid profile');
    assert.equal(p.get('response_type'), 'code');
    assert.equal(p.get('code_challenge_method'), 'S256');
    assert.ok(p.get('nonce') && p.get('code_challenge'));
    assert.equal(
      p.get('redirect_uri'),
      'https://g-sho.org/api/auth/google/callback',
    );
  });

  test('callback creates the user from the ID token', async () => {
    const body = await me(await signIn('/', 'google'));
    assert.equal(body.name, '山田 花子');
    assert.deepEqual(
      body.identities.map((i: {provider: string}) => i.provider),
      ['google'],
    );
    const row = env.DB.raw.prepare('SELECT subject FROM identities').get();
    assert.equal(row?.subject, '1001');
    // Same Google account, same user.
    assert.equal((await me(await signIn('/', 'google'))).id, body.id);
  });

  test('an ID token that is not for us is refused', async () => {
    const bad: Record<string, unknown>[] = [
      {aud: 'someone-else'},
      {iss: 'https://evil.example'},
      {exp: 1},
      {nonce: 'replayed'},
      {sub: undefined},
    ];
    for (const claims of bad) {
      googleClaims = {...googleClaims, ...claims};
      const res = await roundTrip('google');
      assert.equal(res.status, 400, JSON.stringify(claims));
      assert.equal(setCookies(res).has('__Host-session'), false);
      googleClaims = {
        iss: 'https://accounts.google.com',
        aud: 'google-id',
        sub: '1001',
      };
    }
  });

  test('a code redeemed without the PKCE verifier fails', async () => {
    const start = await request('/api/auth/google/start');
    const state = new URL(start.headers.get('location')!).searchParams.get(
      'state',
    );
    googleAsked = {nonce: '', challenge: 'not-this-one'};
    const res = await request(
      `/api/auth/google/callback?code=good-code&state=${state}`,
      {cookies: [`oauth-state=${setCookies(start).get('oauth-state')}`]},
    );
    assert.equal(res.status, 400);
  });
});

describe('LINE sign-in', () => {
  test('signs in with the LINE channel, separately from Google', async () => {
    const start = await request('/api/auth/line/start');
    const url = new URL(start.headers.get('location')!);
    assert.equal(
      url.origin + url.pathname,
      'https://access.line.me/oauth2/v2.1/authorize',
    );
    assert.equal(url.searchParams.get('client_id'), 'line-id');
    assert.equal(url.searchParams.get('scope'), 'openid profile');
    googleClaims = {sub: 'U4af4980629', name: 'ライン'};
    const a = await me(await signIn('/', 'line'));
    assert.equal(a.name, 'ライン');
    assert.deepEqual(
      a.identities.map((i: {provider: string}) => i.provider),
      ['line'],
    );
    // The same subject at Google is someone else.
    googleClaims = {sub: 'U4af4980629'};
    assert.notEqual((await me(await signIn('/', 'google'))).id, a.id);
  });

  test('an ID token from Google is refused for LINE', async () => {
    googleClaims = {iss: 'https://accounts.google.com', sub: '1'};
    assert.equal((await roundTrip('line')).status, 400);
  });
});

describe('linking sign-ins', () => {
  test('a signed-in user can add Google, then sign in with either', async () => {
    const github = await signIn();
    const res = await roundTrip('google', {link: true, session: github});
    assert.equal(res.status, 302);
    // Linking doesn't start another session.
    assert.equal(setCookies(res).has('__Host-session'), false);
    const a = await me(github);
    // Each keeps its own name there.
    assert.deepEqual(
      a.identities.map((i: {provider: string; name: string}) => [
        i.provider,
        i.name,
      ]),
      [
        ['github', 'The Octocat'],
        ['google', '山田 花子'],
      ],
    );
    assert.equal((await me(await signIn('/', 'google'))).id, a.id);
  });

  test('a sign-in that belongs to another account is not moved', async () => {
    const other = await me(await signIn('/', 'google'));
    const github = await signIn();
    const res = await roundTrip('google', {link: true, session: github});
    assert.equal(res.status, 400);
    assert.match(await res.text(), /different g-sho account/);
    assert.equal((await me(await signIn('/', 'google'))).id, other.id);
  });

  test('only one sign-in per provider', async () => {
    const github = await signIn();
    await roundTrip('google', {link: true, session: github});
    googleClaims.sub = '2002';
    const res = await roundTrip('google', {link: true, session: github});
    assert.equal(res.status, 400);
    assert.match(await res.text(), /already has a Google sign-in/);
  });

  test('linking when signed out fails without signing in', async () => {
    const res = await roundTrip('google', {link: true});
    assert.equal(res.status, 400);
    assert.equal(setCookies(res).has('__Host-session'), false);
  });

  test('a sign-in can be removed, but not the last one', async () => {
    const github = await signIn();
    await roundTrip('google', {link: true, session: github});
    const remove = (provider: string) =>
      request(`/api/me/identities/${provider}`, {
        method: 'DELETE',
        headers: {origin: ORIGIN},
        cookies: [github],
      });
    const res = await remove('github');
    assert.equal(res.status, 200);
    assert.deepEqual(
      (await res.json()).identities.map((i: {provider: string}) => i.provider),
      ['google'],
    );
    assert.equal((await remove('google')).status, 409);
    assert.equal((await me(github)).identities.length, 1);
  });
});

describe('sessions', () => {
  test('/api/me without a session is 401', async () => {
    const res = await request('/api/me');
    assert.equal(res.status, 401);
    const bad = await request('/api/me', {cookies: ['__Host-session=nope']});
    assert.equal(bad.status, 401);
  });

  test('expired sessions are refused', async () => {
    const cookie = await signIn();
    env.DB.raw.exec('UPDATE sessions SET expires_at = 1');
    assert.equal((await request('/api/me', {cookies: [cookie]})).status, 401);
  });

  test('a session used after 30 days is extended', async () => {
    const cookie = await signIn();
    const fresh = await request('/api/me', {cookies: [cookie]});
    assert.equal(fresh.headers.getSetCookie().length, 0);
    const soon = Date.now() + 10 * 24 * 60 * 60 * 1000;
    env.DB.raw.prepare('UPDATE sessions SET expires_at = ?').run(soon);
    const res = await request('/api/me', {cookies: [cookie]});
    assert.equal(res.status, 200);
    assert.match(
      res.headers.getSetCookie()[0],
      /^__Host-session=.*Max-Age=7776000/,
    );
    const row = env.DB.raw.prepare('SELECT expires_at FROM sessions').get();
    assert.ok(Number(row?.expires_at) > Date.now() + SESSION_LIFETIME - 60_000);
  });

  test('logout ends the session', async () => {
    const cookie = await signIn();
    const res = await request('/api/auth/logout', {
      method: 'POST',
      headers: {origin: ORIGIN},
      cookies: [cookie],
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.getSetCookie()[0], /^__Host-session=;.*Max-Age=0/);
    assert.equal((await request('/api/me', {cookies: [cookie]})).status, 401);
  });

  test('changes from another origin are refused', async () => {
    const cookie = await signIn();
    const tries: Record<string, string>[] = [
      {origin: 'https://evil.example'},
      {},
    ];
    for (const headers of tries) {
      const res = await request('/api/me', {
        method: 'DELETE',
        headers,
        cookies: [cookie],
      });
      assert.equal(res.status, 403);
    }
    assert.equal((await request('/api/me', {cookies: [cookie]})).status, 200);
  });

  test('plain-http local dev uses a non-Secure cookie', async () => {
    const res = await handle(
      new Request('http://localhost:8787/api/auth/github/start'),
      env,
    );
    assert.doesNotMatch(res.headers.getSetCookie()[0], /Secure/);
    assert.equal(
      new URL(res.headers.get('location')!).searchParams.get('redirect_uri'),
      'http://localhost:8787/api/auth/github/callback',
    );
  });
});

describe('account', () => {
  test('delete removes the user and everything linked to it', async () => {
    const cookie = await signIn();
    await signIn(); // a second session
    const res = await request('/api/me', {
      method: 'DELETE',
      headers: {origin: ORIGIN},
      cookies: [cookie],
    });
    assert.equal(res.status, 200);
    for (const table of ['users', 'identities', 'sessions']) {
      const row = env.DB.raw
        .prepare(`SELECT COUNT(*) AS n FROM ${table}`)
        .get();
      assert.equal(row?.n, 0, table);
    }
  });

  test('export downloads the account as JSON', async () => {
    const cookie = await signIn();
    const res = await request('/api/export', {cookies: [cookie]});
    assert.match(res.headers.get('content-disposition')!, /attachment/);
    const body = await res.json();
    assert.equal(body.account.name, 'The Octocat');
  });
});

describe('dev sign-in', () => {
  test('only exists when DEV_LOGIN is set', async () => {
    assert.equal((await request('/api/auth/dev/start?name=amy')).status, 404);
    env.DEV_LOGIN = '1';
    const res = await request('/api/auth/dev/start?name=amy&return=/x');
    assert.equal(res.headers.get('location'), '/x');
    const cookie = `__Host-session=${setCookies(res).get('__Host-session')}`;
    const me = await (await request('/api/me', {cookies: [cookie]})).json();
    assert.equal(me.name, 'amy');
  });
});

test('rate limits', async () => {
  env.AUTH_LIMIT = {limit: async () => ({success: false})};
  assert.equal((await request('/api/auth/github/start')).status, 429);
});

test('safeReturnPath keeps sign-in from redirecting off the site', () => {
  assert.equal(safeReturnPath('/?q=猫'), '/?q=%E7%8C%AB');
  assert.equal(safeReturnPath('/?q=%E7%8C%AB#x'), '/?q=%E7%8C%AB#x');
  assert.equal(safeReturnPath('/about.html'), '/about.html');
  for (const bad of [
    null,
    '',
    'https://evil.example',
    '//evil.example',
    '/\\evil.example',
    'about.html',
  ]) {
    assert.equal(safeReturnPath(bad), '/', String(bad));
  }
});
