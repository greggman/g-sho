import assert from 'node:assert/strict';
import {test} from 'node:test';
import {handle, type Env} from '../src/server/worker.ts';
import {createTestDb} from './d1-shim.ts';

const env: Env = {
  ASSETS: {fetch: async () => new Response('static')},
  DB: createTestDb(),
  GITHUB_CLIENT_ID: 'id',
  GITHUB_CLIENT_SECRET: 'secret',
};

test('health', async () => {
  const res = await handle(new Request('https://g-sho.org/api/health'), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {ok: true});
});

test('unknown api path is a JSON 404', async () => {
  const res = await handle(new Request('https://g-sho.org/api/auth/nope'), env);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, 'not found');
});

test('other api paths need a session', async () => {
  const res = await handle(new Request('https://g-sho.org/api/nope'), env);
  assert.equal(res.status, 401);
});

test('other paths go to static assets', async () => {
  const res = await handle(new Request('https://g-sho.org/about.html'), env);
  assert.equal(await res.text(), 'static');
});
