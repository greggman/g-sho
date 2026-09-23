import assert from 'node:assert/strict';
import * as http from 'node:http';
import type {AddressInfo} from 'node:net';
import {after, before, describe, test} from 'node:test';
import {AnkiConnect, AnkiNotes} from '../src/client/anki/connect.ts';
import {
  DEFAULT_NOTE_TYPE,
  OWN_FIELD_MAP,
  ankiFurigana,
  duplicateQuery,
  guessFieldMap,
  noteFields,
} from '../src/client/anki/note.ts';
import type {Entry} from '../src/shared/types.ts';

const taberu: Entry = {
  id: 1358280,
  k: [{t: '食べる', c: 1}],
  r: [{t: 'たべる', c: 1}],
  s: [
    {
      g: ['to eat'],
      p: ['v1', 'vt'],
      ex: [
        {
          ja: 'もっと果物を食べるべきです。',
          en: 'You should eat more fruit.',
          w: '食べる',
        },
      ],
    },
    {g: ['to live on (e.g. a salary)', 'to live off']},
  ],
};

const context = {
  posLabel: (t: string) =>
    ({v1: 'Ichidan verb', vt: 'Transitive verb'})[t] ?? t,
  link: 'https://example.com/?q=食べる',
};

describe('Anki note contents', () => {
  test('furigana in Anki syntax', () => {
    assert.equal(ankiFurigana('食べる', 'たべる'), '食[た]べる');
    assert.equal(ankiFurigana('食べ物', 'たべもの'), '食[た]べ 物[もの]');
    assert.equal(ankiFurigana('お茶', 'おちゃ'), 'お 茶[ちゃ]');
    assert.equal(ankiFurigana('ラーメン'), 'ラーメン');
  });

  test('our note type fields', () => {
    const f = noteFields(taberu, OWN_FIELD_MAP, context);
    assert.equal(f.Word, '食べる');
    assert.equal(f.Reading, 'たべる');
    assert.equal(f.Furigana, '食[た]べる');
    assert.equal(
      f.Meaning,
      '<ol><li>to eat</li><li>to live on (e.g. a salary); to live off</li></ol>',
    );
    assert.equal(f.PartOfSpeech, 'Ichidan verb, Transitive verb');
    assert.equal(
      f.Example,
      'もっと果物を食べるべきです。<br>You should eat more fruit.',
    );
    assert.equal(f.JMdictId, '1358280');
    assert.equal(f.Link, context.link);
  });

  test('field mapping guesses', () => {
    assert.deepEqual(guessFieldMap(['Front', 'Back']), {
      Front: 'word',
      Back: 'readingMeaning',
    });
    assert.deepEqual(
      guessFieldMap(['Expression', 'Reading', 'Meaning', 'Notes']),
      {
        Expression: 'word',
        Reading: 'reading',
        Meaning: 'meaning',
        Notes: 'none',
      },
    );
  });

  test('duplicate query uses the JMdict ID, else the word', () => {
    assert.equal(
      duplicateQuery(taberu, DEFAULT_NOTE_TYPE, OWN_FIELD_MAP),
      '"note:g-sho (Japanese)" "JMdictId:1358280"',
    );
    assert.equal(
      duplicateQuery(taberu, 'Basic', {Front: 'word', Back: 'meaning'}),
      '"note:Basic" "Front:食べる"',
    );
    assert.equal(
      duplicateQuery(taberu, 'Basic', {Front: 'meaning'}),
      undefined,
    );
  });
});

/** A fake AnkiConnect that records requests, with a tiny in-memory collection. */
function fakeAnki() {
  const requests: {action: string; params: Record<string, unknown>}[] = [];
  const decks = new Set(['Default']);
  const models = new Set(['Basic']);
  const notes = new Map<
    number,
    {model: string; fields: Record<string, string>}
  >();
  let nextId = 100;

  const run = (action: string, params: Record<string, unknown>): unknown => {
    switch (action) {
      case 'requestPermission':
        return {permission: 'granted', requireApikey: false, version: 6};
      case 'deckNames':
        return [...decks];
      case 'modelNames':
        return [...models];
      case 'createDeck':
        decks.add(params.deck as string);
        return 1;
      case 'createModel':
        models.add(params.modelName as string);
        return {};
      case 'addNote': {
        const note = params.note as {
          modelName: string;
          fields: Record<string, string>;
        };
        if (!models.has(note.modelName)) throw new Error('model was not found');
        notes.set(nextId, {model: note.modelName, fields: note.fields});
        return nextId++;
      }
      case 'updateNoteFields': {
        const note = params.note as {
          id: number;
          fields: Record<string, string>;
        };
        notes.get(note.id)!.fields = note.fields;
        return null;
      }
      case 'findNotes': {
        // Only the queries we generate: "note:X" "Field:value"
        const [, model, field, value] = /^"note:(.*)" "([^:]*):(.*)"$/.exec(
          params.query as string,
        )!;
        return [...notes]
          .filter(([, n]) => n.model === model && n.fields[field] === value)
          .map(([id]) => id);
      }
      case 'multi':
        return (
          params.actions as {action: string; params: Record<string, unknown>}[]
        ).map(a => {
          try {
            return {result: run(a.action, a.params ?? {}), error: null};
          } catch (e) {
            return {result: null, error: (e as Error).message};
          }
        });
      default:
        throw new Error(`unsupported action ${action}`);
    }
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      const {action, params = {}} = JSON.parse(body);
      requests.push({action, params});
      let reply;
      try {
        reply = {result: run(action, params), error: null};
      } catch (e) {
        reply = {result: null, error: (e as Error).message};
      }
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.end(JSON.stringify(reply));
    });
  });
  return {server, requests, notes, decks, models};
}

describe('AnkiNotes against a fake AnkiConnect', () => {
  const fake = fakeAnki();
  let notes: AnkiNotes;

  before(async () => {
    await new Promise<void>(r => fake.server.listen(0, '127.0.0.1', r));
    const {port} = fake.server.address() as AddressInfo;
    notes = new AnkiNotes(
      new AnkiConnect(`http://127.0.0.1:${port}`),
      {deck: 'g-sho', noteType: DEFAULT_NOTE_TYPE, fields: OWN_FIELD_MAP},
      () => context,
    );
  });
  after(() => fake.server.close());

  test('a word not in Anki has no notes', async () => {
    const existing = await notes.existing([taberu]);
    assert.deepEqual(existing.get(taberu.id), []);
  });

  test('adding creates the deck and note type, then the note', async () => {
    const id = await notes.add(taberu);
    assert.ok(fake.decks.has('g-sho'));
    assert.ok(fake.models.has(DEFAULT_NOTE_TYPE));
    assert.equal(fake.notes.get(id)?.fields.Word, '食べる');
    const existing = await notes.existing([taberu]);
    assert.deepEqual(existing.get(taberu.id), [id]);
  });

  test('update overwrites the fields', async () => {
    const [id] = (await notes.existing([taberu])).get(taberu.id)!;
    fake.notes.get(id)!.fields.Meaning = 'edited';
    await notes.update(id, taberu);
    assert.match(fake.notes.get(id)!.fields.Meaning, /to eat/);
  });

  test('checks many entries in one request', async () => {
    const before = fake.requests.length;
    await notes.existing([taberu, {...taberu, id: 1}, {...taberu, id: 2}]);
    assert.equal(fake.requests.length, before + 1);
    assert.equal(fake.requests.at(-1)!.action, 'multi');
  });
});
