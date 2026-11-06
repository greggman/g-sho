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
 * definitions, .cache/jawiktionary/), with which kanji each word on its kana
 * pages is, from Wikimedia's dump (.cache/jawiktionary/headings.json.gz),
 * and PaddleOCR's text detection and
 * recognition models as converted by RapidOCR (.cache/ocr/), pinned by hash,
 * Open English WordNet (English definitions, .cache/wordnet/), pinned by
 * hash, and for spelling suggestions, wordfreq's English frequencies and
 * Wikipedia's list of common misspellings (.cache/spelling/), pinned.
 *
 * A copy of every file is kept in the data repo, g-sho-data/ (its own git
 * repository), so a build doesn't depend on a dozen sites being up, or
 * still there. Pinned files (the models, WordNet, …) are taken from it when
 * it has them. Sources that change (JMdict, Tatoeba, …) are downloaded, and
 * each new version is saved into it (commit it there); when a source can't
 * be reached, its copy there is used instead; with --offline, every file
 * comes from there. g-sho-data/SOURCES.json says where each came from.
 */
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import {readDumpSections} from './wiktionary-headings.ts';

// Node gives each of a host's addresses (IPv6, then IPv4) only 250ms to
// connect, too little for some sites (kaikki.org) on a slow connection.
net.setDefaultAutoSelectFamilyAttemptTimeout(2000);

const REPO = 'scriptin/jmdict-simplified';
const CACHE_DIR = path.resolve(import.meta.dirname, '..', '.cache');
/** The data repo: our copy of every source and model. */
const DATA_DIR = path.resolve(import.meta.dirname, '..', 'g-sho-data');
const MANIFEST = path.join(DATA_DIR, 'SOURCES.json');

/** asset name prefix → the name we store it under (its archive in g-sho-data/sources/ adds .tgz) */
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
  files: [
    {
      file: 'model.fp16.onnx',
      sha256:
        '5db35edaf98b482e3e1c6e62edc6d78daf0e7d72720509ddff4aee08b707ce1d',
    },
    {
      file: 'labels.json',
      sha256:
        'aa1aad5748608ab129181118aaedefacfed8b5d09174f3f15cf6a92ad4281233',
    },
  ],
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

/**
 * `--offline`: nothing is downloaded; every file comes from g-sho-data, so
 * the data built is exactly what its commit holds (the deploy workflow).
 */
const OFFLINE = process.argv.includes('--offline');

function get(url: string, init?: RequestInit): Promise<Response> {
  if (OFFLINE) return Promise.reject(new Error(`${url}: offline`));
  return fetch(url, init);
}

async function fetchOk(url: string, init?: RequestInit): Promise<Response> {
  const res = await get(url, init);
  if (!res.ok) {
    throw new Error(`${url}: ${res.status} ${res.statusText}`);
  }
  return res;
}

const sha256 = (data: Uint8Array) =>
  createHash('sha256').update(data).digest('hex');

/** Where each file in g-sho-data/ came from. */
interface ManifestEntry {
  url: string;
  sha256: string;
  /** the source's release, for those that have them */
  version?: string;
  /** when this copy was downloaded (YYYY-MM-DD) */
  date: string;
}

function readManifest(): Record<string, ManifestEntry> {
  return fs.existsSync(MANIFEST)
    ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
    : {};
}

/** g-sho-data/`name`, if the data repo has it. */
function dataCopy(name: string): Uint8Array | undefined {
  const file = path.join(DATA_DIR, name);
  return fs.existsSync(file) ? fs.readFileSync(file) : undefined;
}

/**
 * Saves a downloaded file into the data repo (when it's checked out) as
 * `name`, and notes where it came from. Unchanged files aren't rewritten.
 */
function saveDataCopy(
  name: string,
  url: string,
  data: Uint8Array,
  version?: string,
) {
  if (!fs.existsSync(DATA_DIR)) return;
  const manifest = readManifest();
  const hash = sha256(data);
  if (manifest[name]?.sha256 === hash && dataCopy(name)) return;
  const file = path.join(DATA_DIR, name);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, data);
  manifest[name] = {
    url,
    sha256: hash,
    ...(version && {version}),
    date: new Date().toISOString().slice(0, 10),
  };
  const sorted = Object.fromEntries(
    Object.entries(manifest).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  fs.writeFileSync(MANIFEST, JSON.stringify(sorted, null, 2) + '\n');
  console.log(`saved g-sho-data/${name} (commit it in g-sho-data)`);
}

/**
 * A pinned file: from the data repo when it has it, else downloaded (and
 * saved there). Either way it must match its hash.
 */
async function pinned(
  name: string,
  url: string,
  want: string,
  init?: RequestInit,
): Promise<Uint8Array> {
  const copy = dataCopy(name);
  if (copy && sha256(copy) === want) return copy;
  console.log(`downloading ${url}`);
  const data = new Uint8Array(await (await fetchOk(url, init)).arrayBuffer());
  const got = sha256(data);
  if (got !== want) throw new Error(`${url}: sha256 ${got}, expected ${want}`);
  saveDataCopy(name, url, data);
  return data;
}

/**
 * A source that changes: downloaded (and a new version saved to the data
 * repo as `name`), or, when it can't be, the data repo's copy. With an
 * ETag, undefined means unchanged since. The ETag is only sent when the
 * data repo already has the file, so a new checkout of it gets filled in.
 */
async function latest(
  name: string,
  url: string,
  {etag, version}: {etag?: string; version?: string} = {},
): Promise<{data: Uint8Array; etag?: string} | undefined> {
  const send = etag && (!fs.existsSync(DATA_DIR) || dataCopy(name));
  try {
    const res = await get(url, {
      headers: send ? {'If-None-Match': etag} : {},
    });
    if (res.status === 304) return undefined;
    if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
    const data = new Uint8Array(await res.arrayBuffer());
    console.log(`downloaded ${url}`);
    saveDataCopy(name, url, data, version);
    return {data, etag: res.headers.get('etag') ?? undefined};
  } catch (e) {
    const copy = dataCopy(name);
    if (!copy) throw e;
    if (OFFLINE) console.log(`using g-sho-data/${name}`);
    else console.warn(`${(e as Error).message}: using g-sho-data/${name}`);
    // No ETag, so the source is tried again next time.
    return {data: copy};
  }
}

/** Saves an ETag beside the file it's for, or removes a stale one. */
function writeEtag(file: string, etag: string | undefined) {
  if (etag) fs.writeFileSync(file, etag);
  else fs.rmSync(file, {force: true});
}

async function downloadHandwritingModel() {
  const {repo, revision, files} = HANDWRITING_MODEL;
  const dir = path.join(CACHE_DIR, 'handwriting', revision);
  fs.mkdirSync(dir, {recursive: true});
  for (const {file, sha256: want} of files) {
    const out = path.join(dir, file);
    if (fs.existsSync(out) && sha256(fs.readFileSync(out)) === want) continue;
    const data = await pinned(
      `models/handwriting/${file}`,
      `https://huggingface.co/${repo}/resolve/${revision}/${file}`,
      want,
    );
    fs.writeFileSync(out, data);
  }
  fs.writeFileSync(
    path.join(CACHE_DIR, 'handwriting', 'current.json'),
    JSON.stringify({repo, revision}, null, 2) + '\n',
  );
}

async function downloadOcrModels() {
  const dir = path.join(CACHE_DIR, 'ocr');
  fs.mkdirSync(dir, {recursive: true});
  for (const {file, url, sha256: want} of OCR_FILES) {
    const out = path.join(dir, file);
    if (fs.existsSync(out) && sha256(fs.readFileSync(out)) === want) continue;
    fs.writeFileSync(out, await pinned(`models/ocr/${file}`, url, want));
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

/** True unless the data repo is checked out and lacks one of `names`. */
function hasDataCopies(names: string[]): boolean {
  return !fs.existsSync(DATA_DIR) || names.every(n => dataCopy(n));
}

/**
 * A GitHub repo's latest release (`assets` to download it from), or when
 * GitHub can't be reached, the version the data repo has a copy of (no
 * `assets`: use the copies of `names`).
 */
async function latestReleaseOrCopy(
  repo: string,
  names: string[],
): Promise<{version: string; assets?: Release['assets']}> {
  try {
    const release = await latestRelease(repo);
    return {version: release.tag_name, assets: release.assets};
  } catch (e) {
    const version = readManifest()[names[0]]?.version;
    if (!version || !names.every(n => dataCopy(n))) throw e;
    if (OFFLINE) console.log(`using g-sho-data (${repo} ${version})`);
    else console.warn(`${(e as Error).message}: using g-sho-data (${version})`);
    return {version};
  }
}

/** KanjiVG stroke data (SVG per character) for stroke order diagrams. */
async function downloadKanjiVG() {
  const name = 'sources/kanjivg.zip';
  const release = await latestReleaseOrCopy('KanjiVG/kanjivg', [name]);
  const dir = path.join(CACHE_DIR, 'kanjivg');
  const versionFile = path.join(dir, 'version.json');
  const have = fs.existsSync(versionFile)
    ? JSON.parse(fs.readFileSync(versionFile, 'utf8')).version
    : undefined;
  if (have === release.version && hasDataCopies([name])) {
    console.log(`KanjiVG ${release.version} already downloaded`);
    return;
  }
  let data: Uint8Array;
  if (release.assets) {
    const asset = release.assets.find(a => a.name.endsWith('-main.zip'));
    if (!asset) throw new Error(`no -main.zip in KanjiVG ${release.version}`);
    console.log(`downloading ${asset.name}`);
    data = (await latest(name, asset.browser_download_url, release))!.data;
  } else {
    data = dataCopy(name)!;
  }
  fs.rmSync(dir, {recursive: true, force: true});
  fs.mkdirSync(dir, {recursive: true});
  const zip = path.join(dir, 'kanjivg.zip');
  fs.writeFileSync(zip, data);
  execFileSync('unzip', ['-q', zip, '-d', dir]);
  fs.rmSync(zip);
  fs.writeFileSync(
    versionFile,
    JSON.stringify({version: release.version}, null, 2) + '\n',
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
  const got = await latest('sources/JMdict_e.gz', url, {etag});
  if (!got) {
    console.log('JMdict XML already downloaded');
    return;
  }
  fs.mkdirSync(CACHE_DIR, {recursive: true});
  fs.writeFileSync(out, got.data);
  writeEtag(etagFile, got.etag);
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
  const base = path.basename(new URL(url).pathname);
  const got = await latest(`sources/tatoeba/${base}`, url, {etag});
  if (!got) {
    console.log(`Tatoeba ${file} already downloaded`);
    return;
  }
  fs.mkdirSync(dir, {recursive: true});
  const archive = path.join(dir, base);
  fs.writeFileSync(archive, got.data);
  if (archive.endsWith('.tar.bz2')) {
    execFileSync('tar', ['xjf', archive, '-C', dir]);
    fs.rmSync(archive);
  } else {
    execFileSync('bunzip2', ['-f', archive]);
  }
  writeEtag(etagFile, got.etag);
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
  const got = await latest('sources/ja-extract.jsonl.gz', url, {etag});
  if (!got) {
    console.log('Japanese Wiktionary already downloaded');
    return;
  }
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(out, got.data);
  writeEtag(etagFile, got.etag);
}

/**
 * Which kanji each word on a Japanese Wiktionary kana page is, read from
 * the page headings the extract leaves out ("{{verb}}:買う"), in Wikimedia's
 * dump of the Japanese Wiktionary (about 95 MB, monthly; CC BY-SA). Only
 * what's read from it goes in g-sho-data, not the dump. The dump isn't
 * downloaded again while its ETag is unchanged, but is always read again
 * (10s), in case how it's read has changed.
 */
async function downloadJaHeadings() {
  const url =
    'https://dumps.wikimedia.org/jawiktionary/latest/jawiktionary-latest-pages-articles.xml.bz2';
  const name = 'sources/ja-headings.json.gz';
  const dir = path.join(CACHE_DIR, 'jawiktionary');
  const out = path.join(dir, 'headings.json.gz');
  const dump = path.join(dir, 'dump.xml.bz2');
  const etagFile = `${dump}.etag`;
  fs.mkdirSync(dir, {recursive: true});
  const useCopy = (error?: Error) => {
    const copy = dataCopy(name);
    if (!copy) throw error ?? new Error(`no g-sho-data/${name}`);
    if (error) console.warn(`${error.message}: using g-sho-data/${name}`);
    else console.log(`using g-sho-data/${name}`);
    fs.writeFileSync(out, copy);
  };
  if (OFFLINE) return useCopy();
  const etag =
    fs.existsSync(etagFile) && fs.existsSync(dump)
      ? fs.readFileSync(etagFile, 'utf8')
      : undefined;
  try {
    const res = await get(url, {
      headers: etag ? {'If-None-Match': etag} : {},
    });
    if (res.status !== 304) {
      if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
      console.log(`downloading ${url}`);
      fs.writeFileSync(dump, Buffer.from(await res.arrayBuffer()));
      writeEtag(etagFile, res.headers.get('etag') ?? undefined);
      const modified = res.headers.get('last-modified');
      fs.writeFileSync(
        `${dump}.date`,
        modified ? new Date(modified).toISOString().slice(0, 10) : '',
      );
    }
  } catch (e) {
    return useCopy(e as Error);
  }
  const sections = await readDumpSections(dump);
  const data = zlib.gzipSync(JSON.stringify(sections));
  fs.writeFileSync(out, data);
  const date = fs.existsSync(`${dump}.date`)
    ? fs.readFileSync(`${dump}.date`, 'utf8')
    : '';
  saveDataCopy(name, url, data, date || undefined);
}

/**
 * Wikipedia's list of common English misspellings, in its machine-readable
 * form ("abandonned->abandoned"): what real spelling mistakes look like, to
 * learn the spelling suggestions' error model from (CC BY-SA 4.0). Pinned
 * to a revision, and by hash.
 */
const MISSPELLINGS = {
  url: 'https://en.wikipedia.org/w/index.php?oldid=1199637275&action=raw',
  file: 'misspellings.txt',
  sha256: '3b6a9290e5aaad968da7ec769a5174adb45247688ef7ae097fd2dd80237a3050',
};

async function downloadMisspellings() {
  const dir = path.join(CACHE_DIR, 'spelling');
  const out = path.join(dir, MISSPELLINGS.file);
  if (
    fs.existsSync(out) &&
    sha256(fs.readFileSync(out)) === MISSPELLINGS.sha256 &&
    hasDataCopies([`sources/${MISSPELLINGS.file}`])
  ) {
    return;
  }
  const data = await pinned(
    `sources/${MISSPELLINGS.file}`,
    MISSPELLINGS.url,
    MISSPELLINGS.sha256,
    {headers: {'user-agent': 'g-sho build (https://g-sho.org)'}},
  );
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(out, data);
}

/**
 * Open English WordNet, for English definitions of English words (CC BY
 * 4.0). The JSON edition, about 10 MB; pinned by hash, like the models.
 */
const WORDNET = {
  url: 'https://github.com/globalwordnet/english-wordnet/releases/download/2025-edition/english-wordnet-2025-json.zip',
  file: 'english-wordnet-json.zip',
  sha256: '7d749f6e2c39e6970e4997839dcf6e42fd281f3c2fae0171d2192bae8cfa4b51',
};

async function downloadWordNet() {
  const dir = path.join(CACHE_DIR, 'wordnet');
  const out = path.join(dir, WORDNET.file);
  if (
    fs.existsSync(out) &&
    sha256(fs.readFileSync(out)) === WORDNET.sha256 &&
    hasDataCopies([`sources/${WORDNET.file}`])
  ) {
    console.log('Open English WordNet already downloaded');
    return;
  }
  const data = await pinned(
    `sources/${WORDNET.file}`,
    WORDNET.url,
    WORDNET.sha256,
  );
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(out, data);
}

/**
 * wordfreq's Japanese word frequencies (subtitles, Wikipedia, web text, …),
 * a broader frequency signal than JMdict's newspaper-based tags.
 * CC BY-SA 4.0: https://github.com/rspeer/wordfreq
 */
const WORDFREQ = {
  commit: '912caf64b657478d1dff1138efdc078947d54bb1',
  file: 'large_ja.msgpack.gz',
  sha256: 'e6ab743b939c1802fc03791f1d58dee2861e822ceecdcdee3f0e05b863ef26d8',
};

/** wordfreq's English list, from the same commit: how common English words are (spelling suggestions). */
const WORDFREQ_EN = {
  file: 'large_en.msgpack.gz',
  sha256: 'dffae8066b78dce0a6667cf5f58e567054f902674667090a7ac8a8a44628b05c',
};

async function downloadWordfreq() {
  const dir = path.join(CACHE_DIR, 'wordfreq', WORDFREQ.commit);
  fs.mkdirSync(dir, {recursive: true});
  for (const {file, sha256: want} of [WORDFREQ_EN, WORDFREQ]) {
    const out = path.join(dir, file);
    const name = `sources/wordfreq/${file}`;
    if (
      fs.existsSync(out) &&
      sha256(fs.readFileSync(out)) === want &&
      hasDataCopies([name])
    ) {
      continue;
    }
    const url = `https://raw.githubusercontent.com/rspeer/wordfreq/${WORDFREQ.commit}/wordfreq/data/${file}`;
    fs.writeFileSync(out, await pinned(name, url, want));
  }
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
  const got = await latest('sources/tatoeba/transcriptions.tar.bz2', url, {
    etag,
  });
  if (!got) {
    console.log('Tatoeba transcriptions already downloaded');
    return;
  }
  fs.mkdirSync(dir, {recursive: true});
  const archive = path.join(dir, 'transcriptions.tar.bz2');
  fs.writeFileSync(archive, got.data);
  execFileSync('tar', ['xjf', archive, '-C', dir]);
  fs.rmSync(archive);
  writeEtag(etagFile, got.etag);
}

async function downloadDictionary() {
  const names = Object.values(ASSETS).map(f => `sources/${f}.tgz`);
  const release = await latestReleaseOrCopy(REPO, names);

  fs.mkdirSync(CACHE_DIR, {recursive: true});
  const versionFile = path.join(CACHE_DIR, 'version.json');
  const have = fs.existsSync(versionFile)
    ? JSON.parse(fs.readFileSync(versionFile, 'utf8')).version
    : undefined;
  const allPresent = Object.values(ASSETS).every(f =>
    fs.existsSync(path.join(CACHE_DIR, f)),
  );
  if (have === release.version && allPresent && hasDataCopies(names)) {
    console.log(`data ${release.version} already downloaded`);
    return;
  }

  await Promise.all(
    Object.entries(ASSETS).map(async ([prefix, outName]) => {
      const name = `sources/${outName}.tgz`;
      let data: Uint8Array;
      if (release.assets) {
        const asset = release.assets.find(
          a => a.name.startsWith(prefix) && a.name.endsWith('.json.tgz'),
        );
        if (!asset) {
          throw new Error(
            `no asset starting with ${prefix} in ${release.version}`,
          );
        }
        console.log(`downloading ${asset.name}`);
        data = (await latest(name, asset.browser_download_url, release))!.data;
      } else {
        data = dataCopy(name)!;
      }
      const tgz = path.join(CACHE_DIR, `${outName}.tgz`);
      fs.writeFileSync(tgz, data);

      // Each archive holds a single JSON file. Extract it to its own
      // directory, then move it to the stable name.
      const tmpDir = path.join(CACHE_DIR, `${outName}.tmp`);
      fs.rmSync(tmpDir, {recursive: true, force: true});
      fs.mkdirSync(tmpDir);
      execFileSync('tar', ['xzf', tgz, '-C', tmpDir]);
      const [json] = fs.readdirSync(tmpDir).filter(f => f.endsWith('.json'));
      if (!json) throw new Error(`no json in ${name}`);
      fs.renameSync(path.join(tmpDir, json), path.join(CACHE_DIR, outName));
      fs.rmSync(tmpDir, {recursive: true});
      fs.rmSync(tgz);
    }),
  );

  fs.writeFileSync(
    versionFile,
    JSON.stringify({version: release.version}, null, 2) + '\n',
  );
  console.log(`jmdict-simplified ${release.version} in .cache/`);
}

// `--models`: only the (pinned) handwriting and OCR models, for building the
// app with dictionary data from a data release (.github/workflows/deploy.yml).
// They come from g-sho-data when it's checked out.
if (process.argv.includes('--models')) {
  await Promise.all([downloadHandwritingModel(), downloadOcrModels()]);
  process.exit(0);
}

// All of them, even when one fails, so the data repo gets what it can.
const results = await Promise.allSettled([
  downloadDictionary(),
  downloadJmdictXml(),
  downloadJaWiktionary(),
  downloadJaHeadings(),
  downloadWordNet(),
  downloadMisspellings(),
  downloadTatoebaExamples(),
  downloadWordfreq(),
  downloadTatoebaTranscriptions(),
  downloadHandwritingModel(),
  downloadOcrModels(),
  downloadKanjiVG(),
]);
const failed = results.filter(r => r.status === 'rejected');
for (const r of failed) console.error(r.reason);
if (failed.length) process.exit(1);
