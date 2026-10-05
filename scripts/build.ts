/**
 * Bundles the client with esbuild and copies static/ into dist/.
 *
 *   node scripts/build.ts            production build
 *   node scripts/build.ts --watch    rebuild on change
 *   node scripts/build.ts --serve    also serve dist/ at http://localhost:8000
 *
 * The dictionary data (dist/data) is built separately by build-data.ts.
 */
import * as crypto from 'node:crypto';
import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {buildHandwriting} from './build-handwriting.ts';
import {buildWasm} from './build-wasm.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const STATIC = path.join(ROOT, 'static');

const watch = process.argv.includes('--watch');
const serve = process.argv.includes('--serve');

/**
 * Copies the files served as-is (static/, the handwriting model) and builds
 * the WebAssembly kernels.
 */
function copyStatic() {
  fs.cpSync(STATIC, DIST, {recursive: true});
  // SQLite for Anki packages (export and import), loaded only when used.
  fs.copyFileSync(
    path.join(ROOT, 'node_modules/sql.js/dist/sql-wasm-browser.wasm'),
    path.join(DIST, 'sql-wasm.wasm'),
  );
  buildWasm(DIST);
  if (!buildHandwriting(DIST)) {
    console.warn('warning: handwriting model missing; run `npm run download`');
  }
}

/**
 * The service worker (src/client/sw.ts), with this build's id and the files
 * to save for offline use built in. A new build changes sw.js, which is how
 * browsers notice there's a new version.
 */
async function buildServiceWorker(outputs: string[]) {
  const files = [
    '/',
    '/about',
    '/privacy',
    ...[
      'app.js',
      'style.css',
      'handwriting-worker.js',
      'import-worker.js',
      'offline-worker.js',
      'nn.wasm',
      'favicon.svg',
      'manifest.webmanifest',
    ].filter(f => fs.existsSync(path.join(DIST, f))),
    ...fs.readdirSync(path.join(DIST, 'icons')).map(f => `icons/${f}`),
    // This build's chunks (dist/chunks may still hold older ones).
    ...outputs
      .map(f => path.relative(DIST, path.resolve(ROOT, f)))
      .filter(f => f.startsWith('chunks/') && f.endsWith('.js')),
  ].map(f => (f.startsWith('/') ? f : `/${f}`));
  // The build id: a hash of the files' contents.
  const hash = crypto.createHash('sha256');
  for (const f of files) {
    const file = path.join(DIST, f === '/' ? 'index.html' : f);
    const real = fs.existsSync(file) ? file : `${file}.html`;
    if (fs.existsSync(real)) hash.update(f).update(fs.readFileSync(real));
  }
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/client/sw.ts')],
    outfile: path.join(DIST, 'sw.js'),
    bundle: true,
    format: 'iife',
    target: ['es2022', 'chrome100', 'firefox100', 'safari15'],
    minify: !watch,
    define: {
      BUILD: JSON.stringify(hash.digest('base64url').slice(0, 12)),
      FILES: JSON.stringify(files),
    },
    logLevel: 'warning',
  });
}

/** Copies static/ again after every rebuild, so edits to it show up in watch mode. */
const copyStaticPlugin: esbuild.Plugin = {
  name: 'copy-static',
  setup(build) {
    build.onEnd(async result => {
      if (result.errors.length === 0) {
        copyStatic();
        await buildServiceWorker(Object.keys(result.metafile?.outputs ?? {}));
      }
    });
  },
};

const options: esbuild.BuildOptions = {
  entryPoints: {
    app: path.join(ROOT, 'src/client/main.ts'),
    'handwriting-worker': path.join(ROOT, 'src/client/handwriting/worker.ts'),
    'import-worker': path.join(ROOT, 'src/client/anki/import-worker.ts'),
    'offline-worker': path.join(ROOT, 'src/client/offline/download-worker.ts'),
  },
  outdir: DIST,
  // Code that's only needed later (handwriting recognition) goes in chunks
  // loaded by dynamic import().
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  bundle: true,
  format: 'esm',
  target: ['es2022', 'chrome100', 'firefox100', 'safari15'],
  minify: !watch,
  sourcemap: true,
  logLevel: 'info',
  plugins: [copyStaticPlugin],
  // Lists the outputs, for the service worker's file list.
  metafile: true,
};

fs.mkdirSync(DIST, {recursive: true});
if (!fs.existsSync(path.join(DIST, 'data', 'meta.json'))) {
  console.warn(
    'warning: dist/data is missing; run `npm run download && npm run build:data`',
  );
}

if (watch || serve) {
  const ctx = await esbuild.context(options);
  if (watch) await ctx.watch();
  if (serve) {
    const {port} = await ctx.serve({servedir: DIST, port: 8000});
    console.log(`serving http://localhost:${port}/`);
  }
} else {
  await esbuild.build(options);
}
