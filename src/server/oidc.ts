/**
 * Sign-in with OpenID Connect providers (Google, LINE): the authorization code
 * flow with PKCE and a nonce, asking only for `openid profile` (an ID and a
 * name, no email address).
 *
 * The ID token comes straight from the provider's token endpoint over TLS,
 * in exchange for the code and our client secret, so its signature isn't
 * checked: OpenID Connect Core 3.1.3.7 allows TLS to stand in for it there.
 * Its issuer, audience, expiry and nonce are checked.
 */
import {
  callbackUrl,
  failure,
  finishSignIn,
  newFlow,
  resumeFlow,
  stateCookie,
} from './auth.ts';
import type {Env} from './env.ts';
import {randomToken, redirect, sha256} from './http.ts';

export interface OidcProvider {
  /** in URLs (/api/auth/<id>/…) and stored identities */
  id: string;
  label: string;
  authorize: string;
  token: string;
  /** the ID token's `iss` is one of these */
  issuers: string[];
  clientId(env: Env): string;
  clientSecret(env: Env): string;
  /** more authorize parameters */
  params?: Record<string, string>;
}

export const google: OidcProvider = {
  id: 'google',
  label: 'Google',
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  issuers: ['https://accounts.google.com', 'accounts.google.com'],
  clientId: env => env.GOOGLE_CLIENT_ID,
  clientSecret: env => env.GOOGLE_CLIENT_SECRET,
  // Lets people with several Google accounts pick one (and link a
  // different one than they're signed in to Google with).
  params: {prompt: 'select_account'},
};

export const line: OidcProvider = {
  id: 'line',
  label: 'LINE',
  authorize: 'https://access.line.me/oauth2/v2.1/authorize',
  token: 'https://api.line.me/oauth2/v2.1/token',
  issuers: ['https://access.line.me'],
  // LINE calls the client ID the channel ID.
  clientId: env => env.LINE_CHANNEL_ID,
  clientSecret: env => env.LINE_CHANNEL_SECRET,
};

export const oidcProviders = [google, line];

/** GET /api/auth/<id>/start?return=/path[&link=1] — off to the provider. */
export async function oidcStart(
  provider: OidcProvider,
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const state = randomToken(16);
  const flow = newFlow(url, {nonce: randomToken(16), verifier: randomToken()});
  const authorize = new URL(provider.authorize);
  authorize.search = new URLSearchParams({
    client_id: provider.clientId(env),
    redirect_uri: callbackUrl(url, provider.id),
    response_type: 'code',
    scope: 'openid profile',
    state,
    nonce: flow.nonce!,
    code_challenge: await sha256(flow.verifier!),
    code_challenge_method: 'S256',
    ...provider.params,
  }).toString();
  return redirect(authorize.toString(), [stateCookie(url, state, flow)]);
}

/** The ID token's claims that we use. */
interface Claims {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nonce?: string;
  sub?: string;
  name?: string;
}

function decodeClaims(idToken: string): Claims | undefined {
  const payload = idToken.split('.')[1];
  if (!payload) return undefined;
  try {
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as Claims;
  } catch {
    return undefined;
  }
}

/** GET /api/auth/<id>/callback?code=…&state=… — back from the provider. */
export async function oidcCallback(
  provider: OidcProvider,
  request: Request,
  env: Env,
  now = Date.now(),
): Promise<Response> {
  const url = new URL(request.url);
  const resumed = resumeFlow(request);
  if (resumed instanceof Response) return resumed;
  const {flow, code} = resumed;
  const retry = `${provider.label} didn’t accept the sign-in. Please try again.`;
  if (!flow.nonce || !flow.verifier) return failure(retry);

  const tokenRes = await fetch(provider.token, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: callbackUrl(url, provider.id),
      client_id: provider.clientId(env),
      client_secret: provider.clientSecret(env),
      code_verifier: flow.verifier,
    }),
  });
  const token = (await tokenRes.json().catch(() => ({}))) as {
    id_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!tokenRes.ok || !token.id_token) {
    // e.g. invalid_client (wrong secret) or invalid_grant (wrong redirect
    // URI, or the code was used already); no secrets in it.
    console.error(
      `${provider.id} token: ${tokenRes.status} ${token.error ?? ''} ${token.error_description ?? ''}`,
    );
    return failure(retry);
  }

  const claims = decodeClaims(token.id_token);
  const aud = claims?.aud;
  const wrong = !claims?.sub
    ? 'no sub'
    : !provider.issuers.includes(claims.iss ?? '')
      ? `issuer ${claims.iss}`
      : !(Array.isArray(aud) ? aud : [aud]).includes(provider.clientId(env))
        ? `audience ${String(aud)}`
        : !(typeof claims.exp === 'number' && claims.exp * 1000 > now)
          ? 'expired'
          : claims.nonce !== flow.nonce
            ? 'nonce'
            : undefined;
  if (wrong || !claims?.sub) {
    console.error(`${provider.id} ID token refused: ${wrong}`);
    return failure(retry);
  }
  return finishSignIn(
    request,
    env,
    flow,
    {
      provider: provider.id,
      subject: claims.sub,
      name: claims.name || `${provider.label} user`,
    },
    now,
  );
}
