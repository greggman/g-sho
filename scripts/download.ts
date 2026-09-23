/**
 * Downloads the latest jmdict-simplified release (JMdict with examples,
 * KANJIDIC2, RADKFILE, KRADFILE) into .cache/ and extracts it to stable
 * file names: .cache/jmdict.json, kanjidic.json, radkfile.json, kradfile.json.
 *
 * Skips the download when .cache/version.json already matches the latest release.
 */
import {execFileSync} from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO = 'scriptin/jmdict-simplified';
const CACHE_DIR = path.resolve(import.meta.dirname, '..', '.cache');

/** asset name prefix → the name we store it under */
const ASSETS: Record<string, string> = {
  'jmdict-examples-eng-': 'jmdict.json',
  'kanjidic2-en-': 'kanjidic.json',
  'radkfile-': 'radkfile.json',
  'kradfile-': 'kradfile.json',
};

interface Release {
  tag_name: string;
  assets: {name: string; browser_download_url: string}[];
}

async function fetchOk(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`${url}: ${res.status} ${res.statusText}`);
  }
  return res;
}

async function main() {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const release = (await (
    await fetchOk(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers,
    })
  ).json()) as Release;

  fs.mkdirSync(CACHE_DIR, {recursive: true});
  const versionFile = path.join(CACHE_DIR, 'version.json');
  const have = fs.existsSync(versionFile)
    ? JSON.parse(fs.readFileSync(versionFile, 'utf8')).version
    : undefined;
  const allPresent = Object.values(ASSETS).every(f =>
    fs.existsSync(path.join(CACHE_DIR, f)),
  );
  if (have === release.tag_name && allPresent) {
    console.log(`data ${release.tag_name} already downloaded`);
    return;
  }

  await Promise.all(
    Object.entries(ASSETS).map(async ([prefix, outName]) => {
      const asset = release.assets.find(
        a => a.name.startsWith(prefix) && a.name.endsWith('.json.tgz'),
      );
      if (!asset) {
        throw new Error(
          `no asset starting with ${prefix} in ${release.tag_name}`,
        );
      }
      console.log(`downloading ${asset.name}`);
      const res = await fetchOk(asset.browser_download_url);
      const tgz = path.join(CACHE_DIR, `${outName}.tgz`);
      fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));

      // Each archive holds a single JSON file. Extract it to its own
      // directory, then move it to the stable name.
      const tmpDir = path.join(CACHE_DIR, `${outName}.tmp`);
      fs.rmSync(tmpDir, {recursive: true, force: true});
      fs.mkdirSync(tmpDir);
      execFileSync('tar', ['xzf', tgz, '-C', tmpDir]);
      const [json] = fs.readdirSync(tmpDir).filter(f => f.endsWith('.json'));
      if (!json) throw new Error(`no json in ${asset.name}`);
      fs.renameSync(path.join(tmpDir, json), path.join(CACHE_DIR, outName));
      fs.rmSync(tmpDir, {recursive: true});
      fs.rmSync(tgz);
    }),
  );

  fs.writeFileSync(
    versionFile,
    JSON.stringify({version: release.tag_name}, null, 2) + '\n',
  );
  console.log(`downloaded ${release.tag_name}`);
}

await main();
