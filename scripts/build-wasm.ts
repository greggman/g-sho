/**
 * Compiles src/wasm/nn.rs to dist/nn.wasm with rustc (wasm32 target, SIMD).
 * Needs Rust with the target: `rustup target add wasm32-unknown-unknown`.
 * Skips the compile when the output is newer than the source.
 */
import {execFileSync} from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SOURCE = path.join(ROOT, 'src/wasm/nn.rs');

export function buildWasm(dist: string) {
  const out = path.join(dist, 'nn.wasm');
  if (
    fs.existsSync(out) &&
    fs.statSync(out).mtimeMs > fs.statSync(SOURCE).mtimeMs
  ) {
    return;
  }
  fs.mkdirSync(dist, {recursive: true});
  execFileSync(
    'rustc',
    [
      '--edition=2021',
      '--crate-type=cdylib',
      '--target=wasm32-unknown-unknown',
      '-Copt-level=3',
      '-Ctarget-feature=+simd128',
      '-Cpanic=abort',
      '-Cstrip=symbols',
      '-o',
      out,
      SOURCE,
    ],
    {stdio: 'inherit'},
  );
  console.log(`built nn.wasm (${fs.statSync(out).size} bytes)`);
}
