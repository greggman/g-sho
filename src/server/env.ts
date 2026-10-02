/**
 * The Worker's bindings, and the small parts of Cloudflare's APIs we use.
 * Declared here rather than with @cloudflare/workers-types, whose globals
 * clash with the DOM types the client code uses. Real bindings match these
 * shapes, and tests pass in stand-ins (test/d1-shim.ts).
 */

export interface D1Result<T> {
  results: T[];
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<unknown>;
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  /** Runs the statements in one transaction. */
  batch(statements: D1PreparedStatement[]): Promise<unknown[]>;
}

export interface RateLimit {
  limit(options: {key: string}): Promise<{success: boolean}>;
}

export interface Env {
  ASSETS: {fetch(request: Request): Promise<Response>};
  DB: D1Database;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  /** sign-in endpoints, per IP */
  AUTH_LIMIT?: RateLimit;
  /** other API calls, per user (or IP when signed out) */
  API_LIMIT?: RateLimit;
  /** In local dev, where static files come from (the esbuild dev server). */
  STATIC_ORIGIN?: string;
  /** "1" in local dev only: enables /api/auth/dev/start (sign in as anyone). */
  DEV_LOGIN?: string;
}

export interface Context {
  waitUntil(promise: Promise<unknown>): void;
}
