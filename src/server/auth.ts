/**
 * Sign-in (GitHub here, OpenID Connect providers in oidc.ts), linking more
 * than one sign-in to an account, and sessions.
 *
 * A session is a random token in an HttpOnly cookie; D1 stores only its
 * SHA-256. Sessions last 90 days and are extended when used after 30.
 *
 * GitHub sign-in is the OAuth web flow with no scopes: we read the user's
 * public profile (ID, username, name) once, then revoke GitHub's token.
 */
import type {Context, D1Database, Env} from './env.ts';
import {
  cookie,
  json,
  parseCookies,
  randomToken,
  redirect,
  safeReturnPath,
  sha256,
} from './http.ts';

const DAY = 24 * 60 * 60 * 1000;
export const SESSION_LIFETIME = 90 * DAY;
/** A session used when it has less than this left is extended. */
const RENEW_BELOW = 60 * DAY;
const STATE_LIFETIME_S = 10 * 60;

const GITHUB_AUTHORIZE = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN = 'https://github.com/login/oauth/access_token';
const GITHUB_USER = 'https://api.github.com/user';
const USER_AGENT = 'g-sho (https://g-sho.org)';

export interface User {
  id: string;
  name: string;
  createdAt: number;
}

export interface Session {
  user: User;
  tokenHash: string;
  /** cookies to set on the response (when the session was extended) */
  setCookies: string[];
}

function isSecure(url: URL) {
  return url.protocol === 'https:';
}

/**
 * The __Host- prefix makes browsers refuse the cookie unless it's Secure,
 * for this exact host, with Path=/. Plain-http local dev can't use it.
 */
function sessionCookieName(url: URL) {
  return isSecure(url) ? '__Host-session' : 'session';
}

function sessionCookie(url: URL, token: string, maxAgeMs: number) {
  return cookie(sessionCookieName(url), token, {
    maxAge: Math.floor(maxAgeMs / 1000),
    secure: isSecure(url),
  });
}

export function clearSessionCookie(url: URL) {
  return cookie(sessionCookieName(url), '', {maxAge: 0, secure: isSecure(url)});
}

/** The signed-in user, or null. */
export async function getSession(
  request: Request,
  env: Env,
  now = Date.now(),
): Promise<Session | null> {
  const url = new URL(request.url);
  const token = parseCookies(request).get(sessionCookieName(url));
  if (!token) return null;
  const tokenHash = await sha256(token);
  const row = await env.DB.prepare(
    `SELECT s.expires_at, u.id, u.name, u.created_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
  )
    .bind(tokenHash)
    .first<{
      expires_at: number;
      id: string;
      name: string;
      created_at: number;
    }>();
  if (!row || row.expires_at <= now) return null;
  const setCookies: string[] = [];
  if (row.expires_at - now < RENEW_BELOW) {
    await env.DB.prepare(
      'UPDATE sessions SET expires_at = ? WHERE token_hash = ?',
    )
      .bind(now + SESSION_LIFETIME, tokenHash)
      .run();
    setCookies.push(sessionCookie(url, token, SESSION_LIFETIME));
  }
  return {
    user: {id: row.id, name: row.name, createdAt: row.created_at},
    tokenHash,
    setCookies,
  };
}

/** Starts a session for the user; returns its Set-Cookie header. */
async function startSession(
  db: D1Database,
  url: URL,
  userId: string,
  now: number,
): Promise<string> {
  const token = randomToken();
  await db.batch([
    // Tidy up this user's expired sessions while we're here.
    db
      .prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?')
      .bind(userId, now),
    db
      .prepare(
        'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      )
      .bind(await sha256(token), userId, now, now + SESSION_LIFETIME),
  ]);
  return sessionCookie(url, token, SESSION_LIFETIME);
}

export async function endSession(env: Env, session: Session) {
  await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?')
    .bind(session.tokenHash)
    .run();
}

/** Finds the user for a provider identity, creating one the first time. */
export async function findOrCreateUser(
  db: D1Database,
  identity: {provider: string; subject: string; login?: string; name: string},
  now: number,
): Promise<string> {
  const existing = await db
    .prepare(
      'SELECT user_id FROM identities WHERE provider = ? AND subject = ?',
    )
    .bind(identity.provider, identity.subject)
    .first<{user_id: string}>();
  if (existing) {
    await db
      .prepare(
        'UPDATE identities SET login = ?, name = ? WHERE provider = ? AND subject = ?',
      )
      .bind(
        identity.login ?? null,
        identity.name,
        identity.provider,
        identity.subject,
      )
      .run();
    return existing.user_id;
  }
  const userId = randomToken(16);
  await db.batch([
    db
      .prepare('INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)')
      .bind(userId, identity.name, now),
    db
      .prepare(
        'INSERT INTO identities (provider, subject, user_id, login, name, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(
        identity.provider,
        identity.subject,
        userId,
        identity.login ?? null,
        identity.name,
        now,
      ),
  ]);
  return userId;
}

// ---- The sign-in round trip, shared by every provider ----

const STATE_COOKIE = 'oauth-state';
const STATE_PATH = '/api/auth/';

/** Shown to users: "That Google account …". */
export const PROVIDER_LABELS: Record<string, string> = {
  github: 'GitHub',
  google: 'Google',
  line: 'LINE',
  passkey: 'passkey',
  dev: 'dev',
};

/** What a sign-in remembers (in the state cookie) until it comes back. */
export interface Flow {
  /** where to go afterwards */
  back: string;
  /** add this sign-in to the signed-in account, instead of signing in */
  link?: boolean;
  /** OpenID Connect: the ID token must carry this */
  nonce?: string;
  /** PKCE: proves the code is redeemed by whoever asked for it */
  verifier?: string;
}

export function callbackUrl(url: URL, provider: string) {
  return `${url.origin}/api/auth/${provider}/callback`;
}

/** A new flow for a start request (?return=/path&link=1). */
export function newFlow(url: URL, extra: Omit<Flow, 'back' | 'link'> = {}) {
  const flow: Flow = {
    back: safeReturnPath(url.searchParams.get('return')),
    ...extra,
  };
  if (url.searchParams.get('link') === '1') flow.link = true;
  return flow;
}

/** The state cookie for a flow: the state, then the flow. */
export function stateCookie(url: URL, state: string, flow: Flow) {
  return cookie(
    STATE_COOKIE,
    `${state}.${encodeURIComponent(JSON.stringify(flow))}`,
    {path: STATE_PATH, maxAge: STATE_LIFETIME_S, secure: isSecure(url)},
  );
}

function clearStateCookie(url: URL) {
  return cookie(STATE_COOKIE, '', {
    path: STATE_PATH,
    maxAge: 0,
    secure: isSecure(url),
  });
}

/** The flow this browser started, and its state; empty if none. */
function savedFlow(request: Request): {state: string; flow: Flow} {
  const saved = parseCookies(request).get(STATE_COOKIE) ?? '';
  const dot = saved.indexOf('.');
  let flow: Flow = {back: '/'};
  try {
    const parsed = JSON.parse(decodeURIComponent(saved.slice(dot + 1)));
    if (parsed && typeof parsed === 'object') flow = parsed as Flow;
  } catch {
    // Missing or mangled: start over.
  }
  return {
    state: dot > 0 ? saved.slice(0, dot) : '',
    flow: {...flow, back: safeReturnPath(flow.back)},
  };
}

/**
 * Checks a callback against the flow this browser started. Either the flow
 * to carry on with, or the response to send (cancelled, or a forged or
 * expired request).
 */
export function resumeFlow(
  request: Request,
): {flow: Flow; code: string} | Response {
  const url = new URL(request.url);
  const {state: savedState, flow} = savedFlow(request);
  // Pressed "Cancel" on the provider's page.
  if (url.searchParams.get('error') === 'access_denied') {
    return redirect(flow.back, [clearStateCookie(url)]);
  }
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state || state !== savedState) {
    return failure(
      'The sign-in request expired or came from somewhere else. Please try again.',
    );
  }
  return {flow, code};
}

/** A refused JSON request (passkeys): the message is for the person. */
export function failureJson(message: string): Response {
  return json({error: message}, {status: 400});
}

export function failure(message: string): Response {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign-in failed</title><link rel="stylesheet" href="/style.css">
<main class="content prose"><h1>Sign-in failed</h1><p>${message}</p><p><a href="/">Back to g-sho</a></p></main>`;
  return new Response(html, {
    status: 400,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export interface Identity {
  provider: string;
  subject: string;
  login?: string;
  name: string;
}

/**
 * The provider said who this is: sign in as them (creating the account the
 * first time), or, linking, add them to the signed-in account.
 */
export async function finishSignIn(
  request: Request,
  env: Env,
  flow: Flow,
  identity: Identity,
  now = Date.now(),
): Promise<Response> {
  const url = new URL(request.url);
  const cookies = [clearStateCookie(url)];
  if (!flow.link) {
    const {sessionCookie} = await startSessionFor(request, env, identity, now);
    cookies.unshift(sessionCookie);
    return redirect(flow.back, cookies);
  }

  const session = await getSession(request, env, now);
  if (!session) {
    return failure('You were signed out. Sign in, then add the sign-in again.');
  }
  const refused = await linkIdentity(env, session.user.id, identity, now);
  return refused ? failure(refused) : redirect(flow.back, cookies);
}

/** Signs in as the identity's user (creating it the first time). */
export async function startSessionFor(
  request: Request,
  env: Env,
  identity: Identity,
  now: number,
): Promise<{userId: string; sessionCookie: string}> {
  const userId = await findOrCreateUser(env.DB, identity, now);
  const url = new URL(request.url);
  return {userId, sessionCookie: await startSession(env.DB, url, userId, now)};
}

/**
 * Adds a sign-in to the user's account. Why not, if it can't be: it
 * already belongs to another account, or the account has one from that
 * provider.
 */
export async function linkIdentity(
  env: Env,
  userId: string,
  identity: Identity,
  now: number,
): Promise<string | undefined> {
  const label = PROVIDER_LABELS[identity.provider] ?? identity.provider;
  const owner = await env.DB.prepare(
    'SELECT user_id FROM identities WHERE provider = ? AND subject = ?',
  )
    .bind(identity.provider, identity.subject)
    .first<{user_id: string}>();
  if (owner && owner.user_id !== userId) {
    return (
      `That ${label} account already signs in to a different g-sho account. ` +
      'To use it here instead, sign in with it and delete that account first.'
    );
  }
  if (owner) return undefined;
  const already = await env.DB.prepare(
    'SELECT 1 AS x FROM identities WHERE user_id = ? AND provider = ?',
  )
    .bind(userId, identity.provider)
    .first();
  if (already) {
    return `Your account already has a ${label} sign-in. Remove it first to use a different one.`;
  }
  await env.DB.prepare(
    'INSERT INTO identities (provider, subject, user_id, login, name, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(
      identity.provider,
      identity.subject,
      userId,
      identity.login ?? null,
      identity.name,
      now,
    )
    .run();
  return undefined;
}

/**
 * Removes one of the user's sign-ins, unless it's their only one (they
 * couldn't sign in again). False if it was their only one.
 */
export async function unlinkProvider(
  env: Env,
  userId: string,
  provider: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM identities WHERE user_id = ? AND provider != ?',
  )
    .bind(userId, provider)
    .first<{n: number}>();
  if (!row?.n) return false;
  await env.DB.batch([
    env.DB.prepare(
      'DELETE FROM identities WHERE user_id = ? AND provider = ?',
    ).bind(userId, provider),
    // A passkey's key goes with it.
    ...(provider === 'passkey'
      ? [env.DB.prepare('DELETE FROM passkeys WHERE user_id = ?').bind(userId)]
      : []),
  ]);
  return true;
}

// ---- GitHub ----

/** GET /api/auth/github/start?return=/path[&link=1] — off to GitHub. */
export function githubStart(request: Request, env: Env): Response {
  const url = new URL(request.url);
  const state = randomToken(16);
  const authorize = new URL(GITHUB_AUTHORIZE);
  authorize.search = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    // The app has more than one redirect URI (production and localhost),
    // so say which one.
    redirect_uri: callbackUrl(url, 'github'),
    state,
    allow_signup: 'true',
  }).toString();
  return redirect(authorize.toString(), [
    stateCookie(url, state, newFlow(url)),
  ]);
}

interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
}

/** GET /api/auth/github/callback?code=…&state=… — back from GitHub. */
export async function githubCallback(
  request: Request,
  env: Env,
  ctx?: Context,
  now = Date.now(),
): Promise<Response> {
  const url = new URL(request.url);
  const resumed = resumeFlow(request);
  if (resumed instanceof Response) return resumed;
  const {flow, code} = resumed;

  const tokenRes = await fetch(GITHUB_TOKEN, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': USER_AGENT,
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: callbackUrl(url, 'github'),
    }),
  });
  const token = (await tokenRes.json().catch(() => ({}))) as {
    access_token?: string;
  };
  if (!tokenRes.ok || !token.access_token) {
    return failure('GitHub didn’t accept the sign-in. Please try again.');
  }

  const userRes = await fetch(GITHUB_USER, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token.access_token}`,
      'user-agent': USER_AGENT,
    },
  });
  // We only needed the token for that one request.
  ctx?.waitUntil(revokeGitHubToken(env, token.access_token).catch(() => {}));
  if (!userRes.ok) {
    return failure('Couldn’t read your GitHub profile. Please try again.');
  }
  const gh = (await userRes.json()) as GitHubUser;

  return finishSignIn(
    request,
    env,
    flow,
    {
      provider: 'github',
      subject: String(gh.id),
      login: gh.login,
      name: gh.name || gh.login,
    },
    now,
  );
}

async function revokeGitHubToken(env: Env, accessToken: string) {
  await fetch(
    `https://api.github.com/applications/${env.GITHUB_CLIENT_ID}/token`,
    {
      method: 'DELETE',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Basic ${btoa(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`)}`,
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify({access_token: accessToken}),
    },
  );
}

/**
 * GET /api/auth/dev/start?name=alice&return=/[&link=1] — local dev only (DEV_LOGIN):
 * signs in as a made-up user, to test without GitHub or with several users.
 */
export async function devStart(
  request: Request,
  env: Env,
  now = Date.now(),
): Promise<Response> {
  const url = new URL(request.url);
  const name = url.searchParams.get('name') || 'dev';
  return finishSignIn(
    request,
    env,
    newFlow(url),
    {provider: 'dev', subject: name, login: name, name},
    now,
  );
}
