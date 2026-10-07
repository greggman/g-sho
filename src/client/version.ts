/**
 * Which build this code is: the commit it was built from (with "-dirty" if
 * there were uncommitted changes) and that commit's date. scripts/build.ts
 * defines VERSION in the app, every worker and the service worker, so each
 * can say which build it's running (see versions.ts).
 */

export interface Version {
  commit: string;
  /** the commit's date, ISO 8601 */
  date: string;
}

declare const VERSION: Version;

export const version: Version =
  typeof VERSION === 'undefined' ? {commit: 'dev', date: ''} : VERSION;

/** "abc1234 (2026-10-07)" */
export function versionText(v: Version): string {
  return v.date ? `${v.commit} (${v.date.slice(0, 10)})` : v.commit;
}

/** The message that asks a worker for its version, with a port to answer on. */
export const VERSION_REQUEST = 'g-sho-version';
