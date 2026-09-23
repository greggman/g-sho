/**
 * Bundles the client with esbuild and copies static/ into dist/.
 *
 *   node scripts/build.ts            production build
 *   node scripts/build.ts --watch    rebuild on change
 *   node scripts/build.ts --serve    also serve dist/ at http://localhost:8000
 *
 * The dictionary data (dist/data) is built separately by build-data.ts.
 */
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
  buildWasm(DIST);
  if (!buildHandwriting(DIST)) {
    console.warn('warning: handwriting model missing; run `npm run download`');
  }
}

/** Copies static/ again after every rebuild, so edits to it show up in watch mode. */
const copyStaticPlugin: esbuild.Plugin = {
  name: 'copy-static',
  setup(build) {
    build.onEnd(result => {
      if (result.errors.length === 0) copyStatic();
    });
  },
};

const options: esbuild.BuildOptions = {
  entryPoints: {
    app: path.join(ROOT, 'src/client/main.ts'),
    'handwriting-worker': path.join(ROOT, 'src/client/handwriting/worker.ts'),
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
