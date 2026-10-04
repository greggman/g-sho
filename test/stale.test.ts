import assert from 'node:assert/strict';
import {test} from 'node:test';
import {isStaleChunk} from '../src/client/stale.ts';

test('recognizes each browser’s missing-chunk error', () => {
  for (const message of [
    'Failed to fetch dynamically imported module: https://g-sho.org/chunks/stats-OLD.js', // Chrome
    'error loading dynamically imported module: https://g-sho.org/chunks/a.js', // Firefox
    'Importing a module script failed.', // Safari
  ]) {
    assert.equal(isStaleChunk(new TypeError(message)), true, message);
  }
  assert.equal(isStaleChunk(new Error('Network request failed')), false);
  assert.equal(isStaleChunk(undefined), false);
});
