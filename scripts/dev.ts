/**
 * Local development: runs `npm run dev:server` (esbuild watch + static
 * server on :8000) and `npm run dev:worker` (the Worker on :8787, which
 * handles /api and proxies everything else to :8000) together. Open
 * http://localhost:8787/.
 *
 * Output is prefixed with the script's name. Ctrl+C stops both, and if one
 * exits the other is stopped too.
 */
import {spawn, type ChildProcess} from 'node:child_process';
import * as readline from 'node:readline';

const SCRIPTS = ['dev:server', 'dev:worker'];
const width = Math.max(...SCRIPTS.map(s => s.length));

const children: ChildProcess[] = [];
let stopping = false;

function stopAll(code: number) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    // Each child leads its own process group, so this also stops what npm
    // started (esbuild, wrangler, workerd).
    try {
      if (child.pid && child.exitCode === null) process.kill(-child.pid);
    } catch {
      // Already gone.
    }
  }
  process.exitCode = code;
}

for (const name of SCRIPTS) {
  const child = spawn('npm', ['run', '--silent', name], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: {...process.env, FORCE_COLOR: process.stdout.isTTY ? '1' : '0'},
  });
  children.push(child);
  const prefix = `[${name.padEnd(width)}] `;
  for (const [stream, out] of [
    [child.stdout!, process.stdout],
    [child.stderr!, process.stderr],
  ] as const) {
    readline
      .createInterface({input: stream})
      .on('line', line => out.write(prefix + line + '\n'));
  }
  child.on('exit', code => {
    if (!stopping) console.log(`${prefix}exited (${code ?? 'signal'})`);
    stopAll(code ?? 0);
  });
}

process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
