/**
 * Recovering from a deploy: a page loaded before a new version went live
 * asks for code chunks by their old names, which are gone. When that
 * happens, reload once to get the new version (not again within a minute,
 * so a real bug can't cause a reload loop).
 */

const KEY = 'g-sho.staleReload';

/** True for the error browsers give when a dynamic import's file is missing. */
export function isStaleChunk(err: unknown): boolean {
  const message = String((err as Error | undefined)?.message ?? err);
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(
    message,
  );
}

/** Reloads the page if `err` means the code changed under it. */
export function reloadIfStale(err: unknown): boolean {
  if (!isStaleChunk(err)) return false;
  try {
    const last = Number(sessionStorage.getItem(KEY) ?? 0);
    if (Date.now() - last < 60_000) return false;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    // No session storage: reload anyway, once per page.
  }
  location.reload();
  return true;
}
