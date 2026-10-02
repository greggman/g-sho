import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import {
  addToHistory,
  clearHistory,
  historyItems,
  removeFromHistory,
} from '../src/client/history.ts';
import {loadDisplaySettings} from '../src/client/settings.ts';
import {
  createStore,
  migrateLocalStorage,
  type NoteRow,
} from '../src/client/store/store.ts';
import {MemoryBackend, Table} from '../src/client/store/table.ts';

/** Lets pending backend writes finish. */
const settle = () => new Promise(r => setTimeout(r));

function table(backend = new MemoryBackend(), start = 1000) {
  const t = new Table<NoteRow>('notes', backend);
  let clock = start;
  t.now = () => clock;
  return {
    t,
    backend,
    tick: (ms = 1) => (clock += ms),
    setClock: (ms: number) => (clock = ms),
  };
}

describe('Table', () => {
  test('put, get, all, delete', () => {
    const {t} = table();
    t.put({id: '1', wordId: 1, text: 'a'}, {id: '2', wordId: 2, text: 'b'});
    assert.equal(t.get('1')?.text, 'a');
    assert.equal(t.all().length, 2);
    t.delete('1');
    assert.equal(t.get('1'), undefined);
    assert.deepEqual(
      t.all().map(r => r.id),
      ['2'],
    );
  });

  test('changes are dirty, with increasing change times', () => {
    const {t} = table();
    const [a] = t.put({id: '1', wordId: 1, text: 'a'});
    // Same clock reading: still later than the last change.
    const [b] = t.put({id: '1', wordId: 1, text: 'b'});
    assert.equal(a.dirty, 1);
    assert.ok(b.mtime > a.mtime);
    t.delete('1');
    const [tomb] = t.dirty();
    assert.equal(tomb.deleted, 1);
    assert.ok(tomb.mtime > b.mtime);
  });

  test('the clock going backwards still moves change times forward', () => {
    const {t, setClock} = table();
    const [a] = t.put({id: '1', wordId: 1, text: 'a'});
    setClock(5);
    const [b] = t.put({id: '1', wordId: 1, text: 'b'});
    assert.equal(b.mtime, a.mtime + 1);
  });

  test('deleting what is not there does nothing', () => {
    const {t} = table();
    let changes = 0;
    t.onChange(() => changes++);
    t.delete('nope');
    assert.equal(changes, 0);
    assert.equal(t.dirty().length, 0);
  });

  test('markClean keeps rows changed after they were sent', () => {
    const {t, tick} = table();
    t.put({id: '1', wordId: 1, text: 'a'}, {id: '2', wordId: 2, text: 'b'});
    const sent = t.dirty();
    tick();
    t.put({id: '2', wordId: 2, text: 'b2'});
    t.markClean(sent);
    assert.deepEqual(
      t.dirty().map(r => r.id),
      ['2'],
    );
  });

  test('applyRemote: the later change wins', () => {
    const {t} = table(new MemoryBackend(), 1000);
    t.put({id: '1', wordId: 1, text: 'local'});
    // Older than ours: ignored.
    assert.equal(
      t.applyRemote([{id: '1', mtime: 500, wordId: 1, text: 'old'}]),
      false,
    );
    assert.equal(t.get('1')?.text, 'local');
    // Newer: replaces ours, and isn't dirty (the server already has it).
    t.applyRemote([{id: '1', mtime: 2000, wordId: 1, text: 'new'}]);
    assert.equal(t.get('1')?.text, 'new');
    assert.equal(t.dirty().length, 0);
    // A remote deletion.
    t.applyRemote([{id: '1', mtime: 3000, deleted: 1} as NoteRow]);
    assert.equal(t.get('1'), undefined);
  });

  test('applyRemote: a tie keeps an unsynced local change', () => {
    const {t} = table(new MemoryBackend(), 1000);
    t.put({id: '1', wordId: 1, text: 'local'});
    t.applyRemote([{id: '1', mtime: 1000, wordId: 1, text: 'remote'}]);
    assert.equal(t.get('1')?.text, 'local');
  });

  test('rows survive a reload, dirty flags and tombstones included', async () => {
    const {t, backend} = table();
    t.put({id: '1', wordId: 1, text: 'a'}, {id: '2', wordId: 2, text: 'b'});
    t.delete('2');
    await settle();
    const again = new Table<NoteRow>('notes', backend);
    await again.load();
    assert.deepEqual(
      again.all().map(r => r.text),
      ['a'],
    );
    assert.deepEqual(
      again
        .dirty()
        .map(r => r.id)
        .sort(),
      ['1', '2'],
    );
  });
});

describe('history', () => {
  test('newest first; searching again moves it to the top', async () => {
    const store = await createStore(new MemoryBackend(), true);
    addToHistory(store.history, {q: '猫', t: 1});
    addToHistory(store.history, {q: '犬', t: 2});
    addToHistory(store.history, {q: '猫', t: 3});
    assert.deepEqual(
      historyItems(store.history).map(i => i.q),
      ['猫', '犬'],
    );
    removeFromHistory(store.history, '猫');
    assert.deepEqual(
      historyItems(store.history).map(i => i.q),
      ['犬'],
    );
    clearHistory(store.history);
    assert.equal(historyItems(store.history).length, 0);
    // Deletions are kept as tombstones, to sync.
    assert.equal(store.history.dirty().length, 2);
  });
});

function fakeStorage(items: Record<string, string>): Storage {
  const map = new Map(Object.entries(items));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    get length() {
      return map.size;
    },
  };
}

describe('moving from localStorage', () => {
  test('copies history and settings once, then removes them', async () => {
    const backend = new MemoryBackend();
    const store = await createStore(backend, true);
    const storage = fakeStorage({
      'g-sho.history': JSON.stringify([
        {q: '猫', t: 200, word: {text: '猫', reading: 'ねこ', meaning: 'cat'}},
        {q: '犬', t: 100},
      ]),
      'g-sho.settings': JSON.stringify({meanings: false}),
      'g-sho.anki': '{"enabled":true}',
    });
    await migrateLocalStorage(store, storage);

    const items = historyItems(store.history);
    assert.deepEqual(
      items.map(i => i.q),
      ['猫', '犬'],
    );
    assert.equal(items[0].word?.reading, 'ねこ');
    // The search time is the change time, for merging with other devices.
    assert.equal(store.history.get('猫')?.mtime, 200);
    assert.equal(store.history.dirty().length, 2);
    const display = loadDisplaySettings(store.settings);
    assert.equal(display.meanings, false);
    assert.equal(display.furigana, true);

    assert.equal(storage.getItem('g-sho.history'), null);
    assert.equal(storage.getItem('g-sho.settings'), null);
    // Anki settings are per device and stay where they were.
    assert.ok(storage.getItem('g-sho.anki'));

    // Only once: a second run doesn't bring anything back.
    clearHistory(store.history);
    storage.setItem('g-sho.history', JSON.stringify([{q: 'x', t: 1}]));
    await migrateLocalStorage(store, storage);
    assert.equal(historyItems(store.history).length, 0);
  });

  test('corrupt data is left in place', async () => {
    const store = await createStore(new MemoryBackend(), true);
    const storage = fakeStorage({'g-sho.history': '{not json'});
    await migrateLocalStorage(store, storage);
    assert.equal(storage.getItem('g-sho.history'), '{not json');
    assert.equal(
      await store.backend.getMeta('migratedLocalStorage'),
      undefined,
    );
  });
});

describe('sync helpers', () => {
  test('markAllDirty queues every row to send again', async () => {
    const {t} = table();
    t.put({id: '1', wordId: 1, text: 'a'});
    t.delete('1');
    t.put({id: '2', wordId: 2, text: 'b'});
    t.markClean(t.dirty());
    assert.equal(t.dirty().length, 0);
    await t.markAllDirty();
    assert.deepEqual(
      t
        .dirty()
        .map(r => r.id)
        .sort(),
      ['1', '2'],
    );
  });

  test('refresh picks up what another tab saved', async () => {
    const backend = new MemoryBackend();
    const tab1 = new Table<NoteRow>('notes', backend);
    const tab2 = new Table<NoteRow>('notes', backend);
    let changes = 0;
    tab2.onChange(() => changes++);
    tab1.put({id: '1', wordId: 1, text: 'from tab 1'});
    await settle();
    await tab2.refresh();
    assert.equal(tab2.get('1')?.text, 'from tab 1');
    assert.equal(changes, 1);
    // Nothing new: no change event.
    await tab2.refresh();
    assert.equal(changes, 1);
    // Synced in tab 1: tab 2 sees it's no longer dirty.
    tab1.markClean(tab1.dirty());
    await settle();
    await tab2.refresh();
    assert.equal(tab2.dirty().length, 0);
  });
});
