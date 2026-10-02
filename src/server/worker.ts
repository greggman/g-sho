/**
 * The g-sho Worker: serves the API under /api/. Everything else is a static
 * file from dist/, served by Cloudflare without running this code.
 */
import {
  clearSessionCookie,
  devStart,
  endSession,
  getSession,
  githubCallback,
  githubStart,
  type Session,
} from './auth.ts';
import type {Context, Env, RateLimit} from './env.ts';
import {error, json} from './http.ts';

export type {Env} from './env.ts';

/** The signed-in user's account, as the client sees it. */
async function me(env: Env, session: Session) {
  const {results: identities} = await env.DB.prepare(
    'SELECT provider, login, created_at FROM identities WHERE user_id = ? ORDER BY created_at',
  )
    .bind(session.user.id)
    .all<{provider: string; login: string | null; created_at: number}>();
  return {
    id: session.user.id,
    name: session.user.name,
    createdAt: session.user.createdAt,
    identities: identities.map(i => ({
      provider: i.provider,
      login: i.login,
      createdAt: i.created_at,
    })),
  };
}

/** Deletes the account and everything stored for it. */
async function deleteAccount(env: Env, userId: string) {
  await env.DB.batch(
    ['sessions', 'identities']
      .map(table =>
        env.DB.prepare(`DELETE FROM ${table} WHERE user_id = ?`).bind(userId),
      )
      .concat(env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId)),
  );
}

async function limited(limiter: RateLimit | undefined, key: string) {
  if (!limiter) return false;
  const {success} = await limiter.limit({key});
  return !success;
}

/**
 * Requests that change something must come from our own pages. Browsers
 * always send Origin on these, and SameSite=Lax cookies already keep most
 * cross-site requests out; this closes the rest.
 */
function sameOrigin(request: Request, url: URL) {
  return request.headers.get('origin') === url.origin;
}

async function api(
  request: Request,
  env: Env,
  ctx: Context | undefined,
  url: URL,
): Promise<Response> {
  const path = url.pathname;
  const method = request.method;
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';

  if (path === '/api/health') return json({ok: true});

  if (method !== 'GET' && method !== 'HEAD' && !sameOrigin(request, url)) {
    return error(403, 'cross-origin request');
  }

  if (path.startsWith('/api/auth/')) {
    if (await limited(env.AUTH_LIMIT, ip)) {
      return error(429, 'too many requests');
    }
    if (path === '/api/auth/github/start' && method === 'GET') {
      return githubStart(request, env);
    }
    if (path === '/api/auth/github/callback' && method === 'GET') {
      return githubCallback(request, env, ctx);
    }
    if (
      path === '/api/auth/dev/start' &&
      method === 'GET' &&
      env.DEV_LOGIN === '1'
    ) {
      return devStart(request, env);
    }
    if (path === '/api/auth/logout' && method === 'POST') {
      const session = await getSession(request, env);
      if (session) await endSession(env, session);
      return json(
        {ok: true},
        {headers: {'set-cookie': clearSessionCookie(url)}},
      );
    }
    return error(404, 'not found');
  }

  const session = await getSession(request, env);
  if (await limited(env.API_LIMIT, session?.user.id ?? ip)) {
    return error(429, 'too many requests');
  }
  if (!session) return error(401, 'not signed in');
  const headers = new Headers();
  for (const c of session.setCookies) headers.append('set-cookie', c);

  if (path === '/api/me') {
    if (method === 'GET') return json(await me(env, session), {headers});
    if (method === 'DELETE') {
      await deleteAccount(env, session.user.id);
      return json(
        {ok: true},
        {headers: {'set-cookie': clearSessionCookie(url)}},
      );
    }
  }
  if (path === '/api/export' && method === 'GET') {
    headers.set(
      'content-disposition',
      'attachment; filename="g-sho-export.json"',
    );
    return json(
      {exportedAt: new Date().toISOString(), account: await me(env, session)},
      {headers},
    );
  }
  return error(404, 'not found');
}

export async function handle(
  request: Request,
  env: Env,
  ctx?: Context,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) {
    try {
      return await api(request, env, ctx, url);
    } catch (e) {
      console.error(e);
      return error(500, 'server error');
    }
  }
  if (env.STATIC_ORIGIN) {
    return fetch(
      new Request(env.STATIC_ORIGIN + url.pathname + url.search, request),
    );
  }
  return env.ASSETS.fetch(request);
}

export default {fetch: handle};
