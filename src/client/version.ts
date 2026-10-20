/**
 * Which build this code is: the commit it was built from (with "-dirty" if
 * there were uncommitted changes) and that commit's date (for "-dirty", when
 * it was built, so test builds can be told apart). scripts/build.ts
 * swaps the `declare` below for the build's version, in the app, every
 * worker and the service worker, so each can say which build it's running
 * (see versions.ts).
 */

export interface Version {
  commit: string;
  /** the commit's date (or, "-dirty", the build's), ISO 8601 */
  date: string;
}

declare const VERSION: Version;

export const version: Version =
  typeof VERSION === 'undefined' ? {commit: 'dev', date: ''} : VERSION;

/** "abc1234 (2026-10-07)", or "abc1234-dirty (2026-10-07 14:05:09)" */
export function versionText(v: Version): string {
  if (!v.date) return v.commit;
  if (!v.commit.endsWith('-dirty'))
    return `${v.commit} (${v.date.slice(0, 10)})`;
  const d = new Date(v.date);
  const p = (n: number) => String(n).padStart(2, '0');
  const when = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return `${v.commit} (${when})`;
}

/** The message that asks a worker for its version, with a port to answer on. */
export const VERSION_REQUEST = 'g-sho-version';

/**
 * Whether two parts are the same build: the commit, and its date (for a
 * build with uncommitted changes, when it was built).
 */
export function sameBuild(a: Version, b: Version) {
  return a.commit === b.commit && a.date === b.date;
}
