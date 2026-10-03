import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {unzipSync, strFromU8} from 'fflate';
import initSqlJs from 'sql.js';
import {writeApkg, stripHtml} from '../src/client/anki/apkg.ts';
import {apkgNoteType} from '../src/client/study/export.ts';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 3, 12);

async function makePackage() {
  const SQL = await initSqlJs();
  return writeApkg(SQL, {
    deckName: 'JLPT::N5',
    now: NOW,
    noteType: apkgNoteType(),
    notes: [
      {
        guid: 'g-sho-1',
        fields: ['猫', 'ねこ', '猫[ねこ]', '<b>cat</b>', 'Noun', '', '1', ''],
        tags: ['g-sho', 'animals'],
        mtime: NOW - DAY,
        cards: [
          {
            ord: 0,
            state: 2,
            due: NOW + 8 * DAY,
            stability: 8.25,
            difficulty: 3.5,
            scheduledDays: 8,
            reps: 3,
            lapses: 1,
            retention: 0.9,
            reviews: [
              {t: NOW - 2 * DAY, rating: 3, durationMs: 4000, state: 0},
              // Same millisecond: still gets its own revlog id.
              {t: NOW - 2 * DAY, rating: 1, durationMs: 90_000, state: 2},
            ],
          },
        ],
      },
      {
        guid: 'g-sho-2',
        fields: ['犬', 'いぬ', '犬[いぬ]', 'dog', '', '', '2', ''],
        tags: [],
        mtime: NOW,
        cards: [
          {
            ord: 0,
            state: 0,
            due: NOW,
            stability: 0,
            difficulty: 0,
            scheduledDays: 0,
            reps: 0,
            lapses: 0,
            suspended: true,
            retention: 0.9,
            reviews: [],
          },
        ],
      },
    ],
  });
}

test('an .apkg holds a schema 11 collection Anki can read', async () => {
  const files = unzipSync(await makePackage());
  assert.deepEqual(Object.keys(files).sort(), ['collection.anki2', 'media']);
  assert.equal(strFromU8(files.media), '{}');

  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'apkg-')),
    'c.anki2',
  );
  fs.writeFileSync(file, files['collection.anki2']);
  const db = new DatabaseSync(file);
  type Row = Record<string, string | number>;
  const col = db.prepare('SELECT * FROM col').get() as Row;
  assert.equal(col.ver, 11);
  const models = JSON.parse(String(col.models));
  const model = models[String(apkgNoteType().id)];
  assert.equal(model.name, 'g-sho (Japanese)');
  assert.equal(model.flds.length, 8);
  assert.match(model.tmpls[0].afmt, /furigana:Furigana/);
  const decks = Object.values(JSON.parse(String(col.decks))) as {
    id: number;
    name: string;
  }[];
  const deck = decks.find(d => d.name === 'JLPT::N5');
  assert.ok(deck);

  const notes = db.prepare('SELECT * FROM notes ORDER BY id').all() as Row[];
  assert.equal(notes.length, 2);
  assert.equal(notes[0].guid, 'g-sho-1');
  assert.equal(String(notes[0].flds).split('\x1f')[3], '<b>cat</b>');
  assert.equal(notes[0].tags, ' g-sho animals ');
  assert.equal(notes[0].sfld, '猫');
  // Anki's field_checksum: int(sha1(text).hexdigest()[:8], 16).
  assert.equal(notes[0].csum, 3775650288);

  const cards = db.prepare('SELECT * FROM cards ORDER BY id').all() as Row[];
  const [review, fresh] = cards;
  assert.equal(review.did, deck.id);
  assert.equal(review.type, 2);
  assert.equal(review.queue, 2);
  assert.equal(review.ivl, 8);
  // Due in 8 days, counted from the collection's creation day.
  const crtDay = Number(col.crt) / 86_400;
  assert.equal(Number(review.due) - (Math.floor(NOW / DAY) - crtDay), 8);
  assert.deepEqual(JSON.parse(String(review.data)), {s: 8.25, d: 3.5, dr: 0.9});
  assert.equal(fresh.type, 0);
  assert.equal(fresh.queue, -1); // suspended

  const revlog = db.prepare('SELECT * FROM revlog ORDER BY id').all() as Row[];
  assert.equal(revlog.length, 2);
  assert.notEqual(revlog[0].id, revlog[1].id);
  assert.equal(revlog[0].type, 0); // learning
  assert.equal(revlog[1].type, 1); // review
  assert.equal(revlog[1].time, 60_000); // capped like Anki
  db.close();
});

test('stripHtml', () => {
  assert.equal(stripHtml('<b>cat</b>&nbsp;&amp; dog'), 'cat & dog');
});
