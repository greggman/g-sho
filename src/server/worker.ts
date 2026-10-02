/**
 * The g-sho Worker: serves the API under /api/. Everything else is a static
 * file from dist/, served by Cloudflare without running this code.
 */

export interface Env {
  ASSETS: {fetch(request: Request): Promise<Response>};
  /** In local dev, where static files come from (the esbuild dev server). */
  STATIC_ORIGIN?: string;
}

function json(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, {
    ...init,
    headers: {'cache-control': 'no-store', ...init?.headers},
  });
}

export async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/api/health') return json({ok: true});
  if (url.pathname.startsWith('/api/')) {
    return json({error: 'not found'}, {status: 404});
  }
  if (env.STATIC_ORIGIN) {
    return fetch(
      new Request(env.STATIC_ORIGIN + url.pathname + url.search, request),
    );
  }
  return env.ASSETS.fetch(request);
}

export default {fetch: handle};
