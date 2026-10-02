/**
 * Sign-in with GitHub, and sessions.
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
        'UPDATE identities SET login = ? WHERE provider = ? AND subject = ?',
      )
      .bind(identity.login ?? null, identity.provider, identity.subject)
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
        'INSERT INTO identities (provider, subject, user_id, login, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .bind(
        identity.provider,
        identity.subject,
        userId,
        identity.login ?? null,
        now,
      ),
  ]);
  return userId;
}

// ---- GitHub ----

const STATE_COOKIE = 'oauth-state';
const STATE_PATH = '/api/auth/';

function callbackUrl(url: URL) {
  return `${url.origin}/api/auth/github/callback`;
}

/** GET /api/auth/github/start?return=/path — off to GitHub. */
export function githubStart(request: Request, env: Env): Response {
  const url = new URL(request.url);
  const state = randomToken(16);
  const back = safeReturnPath(url.searchParams.get('return'));
  const authorize = new URL(GITHUB_AUTHORIZE);
  authorize.search = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    // The app has more than one redirect URI (production and localhost),
    // so say which one.
    redirect_uri: callbackUrl(url),
    state,
    allow_signup: 'true',
  }).toString();
  return redirect(authorize.toString(), [
    cookie(STATE_COOKIE, `${state}.${encodeURIComponent(back)}`, {
      path: STATE_PATH,
      maxAge: STATE_LIFETIME_S,
      secure: isSecure(url),
    }),
  ]);
}

function failure(message: string): Response {
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
  const saved = parseCookies(request).get(STATE_COOKIE) ?? '';
  const dot = saved.indexOf('.');
  const savedState = dot > 0 ? saved.slice(0, dot) : '';
  const back = safeReturnPath(
    dot > 0 ? decodeURIComponent(saved.slice(dot + 1)) : '/',
  );
  const clearState = cookie(STATE_COOKIE, '', {
    path: STATE_PATH,
    maxAge: 0,
    secure: isSecure(url),
  });

  // Pressed "Cancel" on GitHub's page.
  if (url.searchParams.get('error') === 'access_denied') {
    return redirect(back, [clearState]);
  }
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state || state !== savedState) {
    return failure(
      'The sign-in request expired or came from somewhere else. Please try again.',
    );
  }

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
      redirect_uri: callbackUrl(url),
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

  const userId = await findOrCreateUser(
    env.DB,
    {
      provider: 'github',
      subject: String(gh.id),
      login: gh.login,
      name: gh.name || gh.login,
    },
    now,
  );
  return redirect(back, [
    clearState,
    await startSession(env.DB, url, userId, now),
  ]);
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
 * GET /api/auth/dev/start?name=alice&return=/ — local dev only (DEV_LOGIN):
 * signs in as a made-up user, to test without GitHub or with several users.
 */
export async function devStart(
  request: Request,
  env: Env,
  now = Date.now(),
): Promise<Response> {
  const url = new URL(request.url);
  const name = url.searchParams.get('name') || 'dev';
  const userId = await findOrCreateUser(
    env.DB,
    {provider: 'dev', subject: name, login: name, name},
    now,
  );
  return redirect(safeReturnPath(url.searchParams.get('return')), [
    await startSession(env.DB, url, userId, now),
  ]);
}
