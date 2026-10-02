/** Small helpers for responses, cookies and random tokens. */

export function json(body: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set('cache-control', 'no-store');
  return Response.json(body, {...init, headers});
}

export function error(status: number, message: string): Response {
  return json({error: message}, {status});
}

/** A redirect that sets (or clears) cookies. */
export function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({location, 'cache-control': 'no-store'});
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(null, {status: 302, headers});
}

export function parseCookies(request: Request): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return out;
}

export interface CookieOptions {
  path?: string;
  /** seconds; 0 deletes the cookie */
  maxAge?: number;
  /** false only for plain-http local dev */
  secure: boolean;
}

export function cookie(
  name: string,
  value: string,
  {path = '/', maxAge, secure}: CookieOptions,
): string {
  let c = `${name}=${value}; Path=${path}; HttpOnly; SameSite=Lax`;
  if (secure) c += '; Secure';
  if (maxAge !== undefined) c += `; Max-Age=${maxAge}`;
  return c;
}

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A random URL-safe string with `bytes` bytes of entropy. */
export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  );
  return base64url(new Uint8Array(digest));
}

/**
 * Where to go after signing in: a path on this site, or "/". Anything else
 * ("//evil.example", "https://…") would make sign-in an open redirect.
 */
export function safeReturnPath(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || /^\/[/\\]/.test(value)) return '/';
  // Percent-encodes anything that isn't ASCII (/?q=猫), since it goes in a
  // Location header.
  const url = new URL(value, 'https://x.invalid');
  return url.pathname + url.search + url.hash;
}
