/**
 * Downloads the latest jmdict-simplified release (JMdict with examples,
 * KANJIDIC2, RADKFILE, KRADFILE) into .cache/ and extracts it to stable
 * file names: .cache/jmdict.json, kanjidic.json, radkfile.json, kradfile.json.
 * Skips the download when .cache/version.json already matches the latest release.
 *
 * Also downloads the handwriting recognition model into .cache/handwriting/,
 * pinned to a Hugging Face revision, the latest KanjiVG stroke data into
 * .cache/kanjivg/, and EDRDG's JMdict XML (.cache/JMdict_e.gz), which has the
 * word frequency ranks the JSON version leaves out.
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

/** LT8/japanese-handwriting-onnx, pinned so a model update can't change results unnoticed. */
const HANDWRITING_MODEL = {
  repo: 'LT8/japanese-handwriting-onnx',
  revision: '7e4fa1096b1fd4dc1afb9f8ffc5b9d936adb2839',
  files: ['model.fp16.onnx', 'labels.json'],
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

async function downloadHandwritingModel() {
  const {repo, revision, files} = HANDWRITING_MODEL;
  const dir = path.join(CACHE_DIR, 'handwriting', revision);
  fs.mkdirSync(dir, {recursive: true});
  for (const file of files) {
    const out = path.join(dir, file);
    if (fs.existsSync(out)) continue;
    console.log(`downloading ${repo}/${file}`);
    const res = await fetchOk(
      `https://huggingface.co/${repo}/resolve/${revision}/${file}`,
    );
    fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  }
  fs.writeFileSync(
    path.join(CACHE_DIR, 'handwriting', 'current.json'),
    JSON.stringify({repo, revision}, null, 2) + '\n',
  );
}

async function latestRelease(repo: string): Promise<Release> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const res = await fetchOk(
    `https://api.github.com/repos/${repo}/releases/latest`,
    {headers},
  );
  return (await res.json()) as Release;
}

/** KanjiVG stroke data (SVG per character) for stroke order diagrams. */
async function downloadKanjiVG() {
  const release = await latestRelease('KanjiVG/kanjivg');
  const dir = path.join(CACHE_DIR, 'kanjivg');
  const versionFile = path.join(dir, 'version.json');
  const have = fs.existsSync(versionFile)
    ? JSON.parse(fs.readFileSync(versionFile, 'utf8')).version
    : undefined;
  if (have === release.tag_name) {
    console.log(`KanjiVG ${release.tag_name} already downloaded`);
    return;
  }
  const asset = release.assets.find(a => a.name.endsWith('-main.zip'));
  if (!asset) throw new Error(`no -main.zip in KanjiVG ${release.tag_name}`);
  console.log(`downloading ${asset.name}`);
  const res = await fetchOk(asset.browser_download_url);
  fs.rmSync(dir, {recursive: true, force: true});
  fs.mkdirSync(dir, {recursive: true});
  const zip = path.join(dir, 'kanjivg.zip');
  fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  execFileSync('unzip', ['-q', zip, '-d', dir]);
  fs.rmSync(zip);
  fs.writeFileSync(
    versionFile,
    JSON.stringify({version: release.tag_name}, null, 2) + '\n',
  );
}

/**
 * The original JMdict XML, for its priority tags (newspaper frequency bands
 * nf01–nf48 and the ichi/spec/gai lists). Skipped when the ETag is unchanged.
 */
async function downloadJmdictXml() {
  const url = 'https://www.edrdg.org/pub/Nihongo/JMdict_e.gz';
  const out = path.join(CACHE_DIR, 'JMdict_e.gz');
  const etagFile = `${out}.etag`;
  const etag =
    fs.existsSync(etagFile) && fs.existsSync(out)
      ? fs.readFileSync(etagFile, 'utf8')
      : undefined;
  const res = await fetch(url, {headers: etag ? {'If-None-Match': etag} : {}});
  if (res.status === 304) {
    console.log('JMdict XML already downloaded');
    return;
  }
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  console.log('downloading JMdict_e.gz');
  fs.mkdirSync(CACHE_DIR, {recursive: true});
  fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  const newEtag = res.headers.get('etag');
  if (newEtag) fs.writeFileSync(etagFile, newEtag);
}

async function downloadDictionary() {
  const release = await latestRelease(REPO);

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

await Promise.all([
  downloadDictionary(),
  downloadJmdictXml(),
  downloadHandwritingModel(),
  downloadKanjiVG(),
]);
