/**
 * Prints the key of the dictionary data this checkout builds: a hash of
 * the g-sho-data commit (the sources) and of every file the data build
 * runs (scripts/download.ts, scripts/build-data.ts and what they import,
 * as esbuild finds them). The deploy workflow names data releases by it
 * ("data-<key>"), so a push that changes either builds new data, and any
 * other push reuses the data already built.
 */
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(import.meta.dirname, '..');

/** The files the data build runs, relative to the repo, sorted. */
export async function dataBuildInputs(): Promise<string[]> {
  const result = await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: ['scripts/download.ts', 'scripts/build-data.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    write: false,
    outdir: 'out',
    metafile: true,
    logLevel: 'silent',
  });
  return Object.keys(result.metafile.inputs).sort();
}

export async function dataKey(): Promise<string> {
  const hash = createHash('sha256');
  // The submodule's commit as recorded here, not whatever is checked out.
  hash.update(
    execFileSync('git', ['rev-parse', 'HEAD:g-sho-data'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim(),
  );
  // npm packages the build uses, by version.
  hash.update(fs.readFileSync(path.join(ROOT, 'package-lock.json')));
  for (const file of await dataBuildInputs()) {
    hash.update(`\0${file}\0`);
    hash.update(fs.readFileSync(path.join(ROOT, file)));
  }
  return hash.digest('hex').slice(0, 12);
}

if (import.meta.main) {
  if (process.argv.includes('--inputs')) {
    console.log((await dataBuildInputs()).join('\n'));
  } else {
    console.log(await dataKey());
  }
}
