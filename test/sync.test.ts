import assert from 'node:assert/strict';
import {beforeEach, describe, test} from 'node:test';
import {historyItems, addToHistory} from '../src/client/history.ts';
import {createStore, type Store} from '../src/client/store/store.ts';
import {MemoryBackend} from '../src/client/store/table.ts';
import {Sync} from '../src/client/sync.ts';
import {SyncError, type SyncRow} from '../src/server/schema.ts';
import {PAGE_SIZE, UserData} from '../src/server/user-data.ts';
import {handle, type Env} from '../src/server/worker.ts';
import {createTestDb, testStorage, testUserStores} from './d1-shim.ts';

const note = (id: number, text: string, mtime: number): SyncRow => ({
  id: String(id),
  mtime,
  wordId: id,
  text,
});

describe('UserData (server)', () => {
  let data: UserData;
  beforeEach(() => {
    data = new UserData(testStorage());
  });

  test('stores pushed rows and returns other changes, not our own', () => {
    const a = data.sync({since: 0, push: {notes: [note(1, 'a', 100)]}});
    assert.deepEqual(a.rows, {});
    assert.equal(a.cursor, 1);
    // Another device, starting from scratch, gets it.
    const b = data.sync({since: 0, push: {notes: [note(2, 'b', 100)]}});
    assert.deepEqual(b.rows.notes, [note(1, 'a', 100)]);
    assert.equal(b.cursor, 2);
    // The first device gets the second's change.
    const a2 = data.sync({since: a.cursor});
    assert.deepEqual(a2.rows.notes, [note(2, 'b', 100)]);
    assert.equal(data.sync({since: a2.cursor}).rows.notes, undefined);
  });

  test('a later change wins; an earlier or equal one is ignored', () => {
    data.sync({since: 0, push: {notes: [note(1, 'v2', 200)]}});
    data.sync({since: 0, push: {notes: [note(1, 'older', 100)]}});
    data.sync({since: 0, push: {notes: [note(1, 'same time', 200)]}});
    assert.equal(data.export().notes[0].text, 'v2');
    data.sync({since: 0, push: {notes: [note(1, 'v3', 300)]}});
    assert.equal(data.export().notes[0].text, 'v3');
  });

  test('deletions sync as tombstones and leave the export', () => {
    data.sync({since: 0, push: {notes: [note(1, 'a', 100)]}});
    data.sync({since: 0, push: {notes: [{id: '1', mtime: 200, deleted: 1}]}});
    assert.deepEqual(data.sync({since: 0}).rows.notes, [
      {id: '1', mtime: 200, deleted: 1},
    ]);
    assert.equal(data.export().notes, undefined);
  });

  test('invalid rows are rejected; the rest are stored', () => {
    const res = data.sync({
      since: 0,
      push: {
        notes: [
          note(1, 'fine', 100),
          note(2, 'x'.repeat(2001), 100),
          {...note(3, 'c', 100), extra: 1},
          {...note(4, 'd', 100), id: '5'},
        ],
        marks: [{id: 'star:7', mtime: 1, wordId: 7, kind: 'star'}],
      },
    });
    assert.deepEqual(
      res.rejected?.map(r => r.id),
      ['2', '3', '5'],
    );
    assert.deepEqual(
      data.export().notes.map(r => r.id),
      ['1'],
    );
    assert.equal(data.export().marks.length, 1);
  });

  test('malformed requests are refused', () => {
    assert.throws(() => data.sync({since: -1}), SyncError);
    assert.throws(
      () => data.sync({since: 0, push: {secrets: []}}),
      /unknown table/,
    );
  });

  test('going over a table limit stores nothing from the request', () => {
    const settings = Array.from({length: 21}, (_, i) => ({
      id: `s${'abcdefghijklmnopqrstuvwxyz'[i]}`,
      mtime: 1,
      value: {},
    }));
    assert.throws(
      () => data.sync({since: 0, push: {settings}}),
      (e: SyncError) => e.status === 413,
    );
    assert.deepEqual(data.export(), {});
    assert.equal(data.sync({since: 0}).cursor, 0);
  });

  test('pulls come in pages', () => {
    const rows = Array.from({length: PAGE_SIZE}, (_, i) => note(i + 1, 't', 1));
    data.sync({since: 0, push: {notes: rows}});
    data.sync({since: 0, push: {notes: [note(PAGE_SIZE + 1, 't', 1)]}});
    const first = data.sync({since: 0});
    assert.equal(first.rows.notes.length, PAGE_SIZE);
    assert.equal(first.more, true);
    const second = data.sync({since: first.cursor});
    assert.equal(second.rows.notes.length, 1);
    assert.equal(second.more, false);
  });

  test('change times far in the future are pulled back to now', () => {
    data.sync({since: 0, push: {notes: [note(1, 'a', 9e12)]}}, 1000);
    assert.equal(data.export().notes[0].mtime, 61_000);
  });
});

describe('two devices syncing through the Worker', () => {
  let env: Env;
  beforeEach(() => {
    env = {
      ASSETS: {fetch: async () => new Response('static')},
      DB: createTestDb(),
      USER_STORE: testUserStores(),
      GITHUB_CLIENT_ID: 'id',
      GITHUB_CLIENT_SECRET: 'secret',
      DEV_LOGIN: '1',
    };
  });

  /** Signs in as `name`; returns a fetch that sends that session. */
  async function signIn(name: string) {
    const res = await handle(
      new Request(`https://g-sho.org/api/auth/dev/start?name=${name}`),
      env,
    );
    const cookie = res.headers.getSetCookie()[0].split(';')[0];
    const me = await (
      await handle(
        new Request('https://g-sho.org/api/me', {headers: {cookie}}),
        env,
      )
    ).json();
    const send: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set('cookie', cookie);
      headers.set('origin', 'https://g-sho.org');
      const body = String(init?.body ?? '');
      headers.set(
        'content-length',
        String(new TextEncoder().encode(body).length),
      );
      return handle(
        new Request(`https://g-sho.org${String(input)}`, {
          ...init,
          headers,
        }),
        env,
      );
    };
    return {userId: me.id as string, send};
  }

  async function device(name: string, store?: Store) {
    const {userId, send} = await signIn(name);
    store ??= await createStore(new MemoryBackend(), true);
    const sync = new Sync(store, userId);
    sync.fetch = send;
    return {store, sync};
  }

  test('changes on one device reach the other, both ways', async () => {
    const a = await device('amy');
    const b = await device('amy');
    a.store.marks.put({id: 'star:1', wordId: 1, kind: 'star'});
    a.store.notes.put({id: '1', wordId: 1, text: 'from A'});
    addToHistory(a.store.history, {q: '猫', t: 5});
    await a.sync.start();
    await b.sync.start();
    assert.ok(b.store.marks.get('star:1'));
    assert.equal(b.store.notes.get('1')?.text, 'from A');
    assert.deepEqual(
      historyItems(b.store.history).map(i => i.q),
      ['猫'],
    );
    assert.equal(b.sync.status.state, 'synced');

    // A deletion on B reaches A.
    b.store.notes.delete('1');
    await b.sync.now();
    await a.sync.now();
    assert.equal(a.store.notes.get('1'), undefined);
    // Nothing left to send.
    assert.equal(a.store.notes.dirty().length, 0);
    a.sync.stop();
    b.sync.stop();
  });

  test('edits made offline on both: the later one wins everywhere', async () => {
    const a = await device('amy');
    const b = await device('amy');
    await a.sync.start();
    await b.sync.start();
    a.store.notes.now = () => 1000;
    b.store.notes.now = () => 2000;
    a.store.notes.put({id: '1', wordId: 1, text: 'A, earlier'});
    b.store.notes.put({id: '1', wordId: 1, text: 'B, later'});
    await a.sync.now();
    await b.sync.now();
    await a.sync.now();
    assert.equal(a.store.notes.get('1')?.text, 'B, later');
    assert.equal(b.store.notes.get('1')?.text, 'B, later');
    a.sync.stop();
    b.sync.stop();
  });

  test('data from before signing in joins the account', async () => {
    const store = await createStore(new MemoryBackend(), true);
    store.notes.put({id: '9', wordId: 9, text: 'before'});
    // Pretend it was synced to someone else before.
    store.notes.markClean(store.notes.dirty());
    await store.backend.setMeta('syncUser', 'someone-else');
    const a = await device('amy', store);
    await a.sync.start();
    const b = await device('amy');
    await b.sync.start();
    assert.equal(b.store.notes.get('9')?.text, 'before');
    a.sync.stop();
    b.sync.stop();
  });

  test('accounts are separate', async () => {
    const amy = await device('amy');
    const bob = await device('bob');
    amy.store.notes.put({id: '1', wordId: 1, text: 'amy'});
    await amy.sync.start();
    await bob.sync.start();
    assert.equal(bob.store.notes.get('1'), undefined);
    amy.sync.stop();
    bob.sync.stop();
  });

  test('deleting the account deletes its synced data', async () => {
    const a = await device('amy');
    a.store.notes.put({id: '1', wordId: 1, text: 'x'});
    await a.sync.start();
    a.sync.stop();
    const {send} = await signIn('amy');
    assert.equal((await send('/api/me', {method: 'DELETE'})).status, 200);
    // Signing in again makes a new, empty account.
    const again = await device('amy');
    await again.sync.start();
    assert.equal(again.store.notes.all().length, 0);
    again.sync.stop();
  });

  test('a signed-out session stops syncing', async () => {
    const a = await device('amy');
    let signedOut = false;
    a.sync.onSignedOut = () => (signedOut = true);
    a.sync.fetch = async () => Response.json({error: 'x'}, {status: 401});
    await a.sync.start();
    assert.equal(signedOut, true);
  });

  test('export includes synced data', async () => {
    const a = await device('amy');
    a.store.notes.put({id: '1', wordId: 1, text: 'x'});
    await a.sync.start();
    a.sync.stop();
    const {send} = await signIn('amy');
    const body = await (await send('/api/export', {})).json();
    assert.equal(body.data.notes[0].text, 'x');
  });
});
