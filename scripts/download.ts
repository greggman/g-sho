/**
 * Downloads the latest jmdict-simplified release (JMdict with examples,
 * KANJIDIC2, RADKFILE, KRADFILE) into .cache/ and extracts it to stable
 * file names: .cache/jmdict.json, kanjidic.json, radkfile.json, kradfile.json.
 * Skips the download when .cache/version.json already matches the latest release.
 *
 * Also downloads the handwriting recognition model into .cache/handwriting/,
 * pinned to a Hugging Face revision, the latest KanjiVG stroke data into
 * .cache/kanjivg/, EDRDG's JMdict XML (.cache/JMdict_e.gz), which has the
 * word frequency ranks the JSON version leaves out, wordfreq's Japanese
 * word frequencies (.cache/wordfreq/), pinned to a commit, and Tatoeba's
 * sentence transcriptions (furigana for example sentences, .cache/tatoeba/),
 * Tatoeba's word index with its Japanese and English sentences (more example
 * sentences, .cache/tatoeba/),
 * and the Japanese Wiktionary as extracted by kaikki.org (Japanese
 * definitions, .cache/jawiktionary/), and PaddleOCR's text detection and
 * recognition models as converted by RapidOCR (.cache/ocr/), pinned by hash.
 */
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
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

/**
 * PaddleOCR PP-OCRv6 (Apache 2.0), as ONNX by RapidOCR: the tiny text
 * detector, the small recognizer and its character list. Pinned by hash.
 */
const RAPIDOCR =
  'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.9.2';
const OCR_FILES = [
  {
    file: 'det.onnx',
    url: `${RAPIDOCR}/onnx/PP-OCRv6/det/PP-OCRv6_det_tiny.onnx`,
    sha256: 'f42c0fbd294d95eac1a550e131b277dac97462c8025fa4b6c3cec1b7894bd3d5',
  },
  {
    file: 'rec.onnx',
    url: `${RAPIDOCR}/onnx/PP-OCRv6/rec/PP-OCRv6_rec_small.onnx`,
    sha256: '6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884',
  },
  {
    file: 'dict.txt',
    url: `${RAPIDOCR}/paddle/PP-OCRv6/rec/PP-OCRv6_rec_small/ppocrv6_dict.txt`,
    sha256: 'b5f2bfe2bdd9448429e3e82b51c789775d9b42f2403d082b00662eb77e401c5d',
  },
];

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

const sha256 = (data: Uint8Array) =>
  createHash('sha256').update(data).digest('hex');

async function downloadOcrModels() {
  const dir = path.join(CACHE_DIR, 'ocr');
  fs.mkdirSync(dir, {recursive: true});
  for (const {file, url, sha256: want} of OCR_FILES) {
    const out = path.join(dir, file);
    if (fs.existsSync(out) && sha256(fs.readFileSync(out)) === want) continue;
    console.log(`downloading ${url}`);
    const data = new Uint8Array(await (await fetchOk(url)).arrayBuffer());
    const got = sha256(data);
    if (got !== want)
      throw new Error(`${url}: sha256 ${got}, expected ${want}`);
    fs.writeFileSync(out, data);
  }
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

/**
 * One Tatoeba export (.tar.bz2 or .bz2), unpacked into .cache/tatoeba/ as
 * `file`. Skipped when the ETag is unchanged.
 */
async function downloadTatoebaFile(url: string, file: string) {
  const dir = path.join(CACHE_DIR, 'tatoeba');
  const out = path.join(dir, file);
  const etagFile = `${out}.etag`;
  const etag =
    fs.existsSync(etagFile) && fs.existsSync(out)
      ? fs.readFileSync(etagFile, 'utf8')
      : undefined;
  const res = await fetch(url, {headers: etag ? {'If-None-Match': etag} : {}});
  if (res.status === 304) {
    console.log(`Tatoeba ${file} already downloaded`);
    return;
  }
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  console.log(`downloading Tatoeba ${file}`);
  fs.mkdirSync(dir, {recursive: true});
  const archive = path.join(dir, path.basename(new URL(url).pathname));
  fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  if (archive.endsWith('.tar.bz2')) {
    execFileSync('tar', ['xjf', archive, '-C', dir]);
    fs.rmSync(archive);
  } else {
    execFileSync('bunzip2', ['-f', archive]);
  }
  const newEtag = res.headers.get('etag');
  if (newEtag) fs.writeFileSync(etagFile, newEtag);
}

/** Tatoeba's word index and its sentences, for more example sentences. */
async function downloadTatoebaExamples() {
  const base = 'https://downloads.tatoeba.org/exports';
  await downloadTatoebaFile(`${base}/jpn_indices.tar.bz2`, 'jpn_indices.csv');
  await downloadTatoebaFile(
    `${base}/per_language/jpn/jpn_sentences.tsv.bz2`,
    'jpn_sentences.tsv',
  );
  await downloadTatoebaFile(
    `${base}/per_language/eng/eng_sentences.tsv.bz2`,
    'eng_sentences.tsv',
  );
}

/**
 * The Japanese Wiktionary, extracted to JSON by wiktextract (kaikki.org),
 * for Japanese definitions (CC BY-SA). About 65 MB; skipped when the ETag
 * is unchanged.
 */
async function downloadJaWiktionary() {
  const url = 'https://kaikki.org/jawiktionary/raw-wiktextract-data.jsonl.gz';
  const dir = path.join(CACHE_DIR, 'jawiktionary');
  const out = path.join(dir, 'ja-extract.jsonl.gz');
  const etagFile = `${out}.etag`;
  const etag =
    fs.existsSync(etagFile) && fs.existsSync(out)
      ? fs.readFileSync(etagFile, 'utf8')
      : undefined;
  const res = await fetch(url, {headers: etag ? {'If-None-Match': etag} : {}});
  if (res.status === 304) {
    console.log('Japanese Wiktionary already downloaded');
    return;
  }
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  console.log('downloading the Japanese Wiktionary (kaikki.org)');
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  const newEtag = res.headers.get('etag');
  if (newEtag) fs.writeFileSync(etagFile, newEtag);
}

/**
 * wordfreq's Japanese word frequencies (subtitles, Wikipedia, web text, …),
 * a broader frequency signal than JMdict's newspaper-based tags.
 * CC BY-SA 4.0: https://github.com/rspeer/wordfreq
 */
const WORDFREQ = {
  commit: '912caf64b657478d1dff1138efdc078947d54bb1',
  file: 'large_ja.msgpack.gz',
};

async function downloadWordfreq() {
  const dir = path.join(CACHE_DIR, 'wordfreq', WORDFREQ.commit);
  const out = path.join(dir, WORDFREQ.file);
  if (fs.existsSync(out)) return;
  console.log(`downloading wordfreq ${WORDFREQ.file}`);
  const res = await fetchOk(
    `https://raw.githubusercontent.com/rspeer/wordfreq/${WORDFREQ.commit}/wordfreq/data/${WORDFREQ.file}`,
  );
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  fs.writeFileSync(
    path.join(CACHE_DIR, 'wordfreq', 'current.json'),
    JSON.stringify({commit: WORDFREQ.commit, file: WORDFREQ.file}, null, 2) +
      '\n',
  );
}

/**
 * Tatoeba's transcriptions export, which has furigana for Japanese
 * sentences ("[世界|せ|かい]に…"). Skipped when the ETag is unchanged.
 */
async function downloadTatoebaTranscriptions() {
  const url = 'https://downloads.tatoeba.org/exports/transcriptions.tar.bz2';
  const dir = path.join(CACHE_DIR, 'tatoeba');
  const csv = path.join(dir, 'transcriptions.csv');
  const etagFile = path.join(dir, 'transcriptions.etag');
  const etag =
    fs.existsSync(etagFile) && fs.existsSync(csv)
      ? fs.readFileSync(etagFile, 'utf8')
      : undefined;
  const res = await fetch(url, {headers: etag ? {'If-None-Match': etag} : {}});
  if (res.status === 304) {
    console.log('Tatoeba transcriptions already downloaded');
    return;
  }
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  console.log('downloading Tatoeba transcriptions');
  fs.mkdirSync(dir, {recursive: true});
  const archive = path.join(dir, 'transcriptions.tar.bz2');
  fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  execFileSync('tar', ['xjf', archive, '-C', dir]);
  fs.rmSync(archive);
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

// `--models`: only the (pinned) handwriting and OCR models, for building the
// app with dictionary data from a data release (.github/workflows/deploy.yml).
if (process.argv.includes('--models')) {
  await Promise.all([downloadHandwritingModel(), downloadOcrModels()]);
  process.exit(0);
}

await Promise.all([
  downloadDictionary(),
  downloadJmdictXml(),
  downloadJaWiktionary(),
  downloadTatoebaExamples(),
  downloadWordfreq(),
  downloadTatoebaTranscriptions(),
  downloadHandwritingModel(),
  downloadOcrModels(),
  downloadKanjiVG(),
]);
