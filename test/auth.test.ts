import assert from 'node:assert/strict';
import {afterEach, beforeEach, describe, test} from 'node:test';
import {SESSION_LIFETIME} from '../src/server/auth.ts';
import {safeReturnPath} from '../src/server/http.ts';
import {handle, type Env} from '../src/server/worker.ts';
import {createTestDb, testUserStores} from './d1-shim.ts';

const ORIGIN = 'https://g-sho.org';

let env: Env & {DB: ReturnType<typeof createTestDb>};
let realFetch: typeof fetch;
/** what the fake GitHub returns for /user */
let githubUser: {id: number; login: string; name: string | null};
let revoked: string[];

beforeEach(() => {
  env = {
    ASSETS: {fetch: async () => new Response('static')},
    DB: createTestDb(),
    USER_STORE: testUserStores(),
    GITHUB_CLIENT_ID: 'client-id',
    GITHUB_CLIENT_SECRET: 'client-secret',
  };
  githubUser = {id: 42, login: 'octocat', name: 'The Octocat'};
  revoked = [];
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

/** Signs in through the GitHub flow; returns the session cookie. */
async function signIn(returnPath = '/?q=猫'): Promise<string> {
  const start = await request(
    `/api/auth/github/start?return=${encodeURIComponent(returnPath)}`,
  );
  assert.equal(start.status, 302);
  const authorize = new URL(start.headers.get('location')!);
  const state = authorize.searchParams.get('state')!;
  const stateCookie = `oauth-state=${setCookies(start).get('oauth-state')}`;
  const back = await request(
    `/api/auth/github/callback?code=good-code&state=${state}`,
    {cookies: [stateCookie]},
  );
  assert.equal(back.status, 302);
  assert.equal(back.headers.get('location'), safeReturnPath(returnPath));
  const token = setCookies(back).get('__Host-session');
  assert.ok(token);
  return `__Host-session=${token}`;
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
    assert.match(cookie, /^oauth-state=[\w-]+\.%2Fabout\.html;/);
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
      {cookies: ['oauth-state=real./']},
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
      cookies: ['oauth-state=s./'],
    });
    assert.equal(res.status, 400);
  });

  test('cancelling on GitHub goes back without signing in', async () => {
    const res = await request(
      '/api/auth/github/callback?error=access_denied&state=s',
      {cookies: ['oauth-state=s.%2Fabout.html']},
    );
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/about.html');
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
