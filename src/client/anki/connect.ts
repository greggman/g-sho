/**
 * Talks to Anki through the AnkiConnect add-on, which serves a JSON API on
 * http://127.0.0.1:8765. Requests from a web page need the site's origin in
 * AnkiConnect's allow list; requestPermission asks the user (in Anki) to add
 * it. See https://git.foosoft.net/alex/anki-connect
 */
import type {Entry} from '../../shared/types.ts';
import {
  DEFAULT_NOTE_TYPE,
  duplicateQuery,
  noteFields,
  ownNoteType,
  type FieldMap,
  type NoteContext,
} from './note.ts';

export const DEFAULT_URL = 'http://127.0.0.1:8765';
const VERSION = 6;

export class AnkiError extends Error {}

/** Thrown when Anki can't be reached at all (not running, or blocked). */
export class AnkiUnreachable extends AnkiError {}

export class AnkiConnect {
  readonly url: string;
  apiKey: string | undefined;

  constructor(url = DEFAULT_URL, apiKey?: string) {
    this.url = url;
    this.apiKey = apiKey;
  }

  async invoke<T>(action: string, params: object = {}): Promise<T> {
    let res: Response;
    try {
      // No Content-Type header: a "simple" request, so no CORS preflight.
      res = await fetch(this.url, {
        method: 'POST',
        body: JSON.stringify({
          action,
          version: VERSION,
          params,
          ...(this.apiKey && {key: this.apiKey}),
        }),
      });
    } catch (e) {
      throw new AnkiUnreachable(`Couldn't reach Anki at ${this.url}: ${e}`);
    }
    if (res.status === 403) {
      throw new AnkiError(
        'Anki refused the request (this site is not allowed)',
      );
    }
    const reply = (await res.json()) as {result: T; error: string | null};
    if (reply.error) throw new AnkiError(reply.error);
    return reply.result;
  }

  /** Asks Anki (with a dialog there, the first time) to let this site in. */
  requestPermission() {
    return this.invoke<{
      permission: 'granted' | 'denied';
      requireApikey?: boolean;
      version?: number;
    }>('requestPermission');
  }

  deckNames() {
    return this.invoke<string[]>('deckNames');
  }

  modelNames() {
    return this.invoke<string[]>('modelNames');
  }

  modelFieldNames(modelName: string) {
    return this.invoke<string[]>('modelFieldNames', {modelName});
  }
}

/** Where and how notes are added. */
export interface NoteTarget {
  deck: string;
  noteType: string;
  fields: FieldMap;
}

/** Adding, finding, and updating notes for dictionary entries. */
export class AnkiNotes {
  readonly anki: AnkiConnect;
  readonly target: NoteTarget;
  readonly context: (entry: Entry) => NoteContext;
  private setup: Promise<void> | undefined;

  constructor(
    anki: AnkiConnect,
    target: NoteTarget,
    context: (entry: Entry) => NoteContext,
  ) {
    this.anki = anki;
    this.target = target;
    this.context = context;
  }

  /** Creates the deck, and our note type if it's the one in use, if missing. */
  private ensureSetup(): Promise<void> {
    this.setup ??= (async () => {
      await this.anki.invoke('createDeck', {deck: this.target.deck});
      if (this.target.noteType === DEFAULT_NOTE_TYPE) {
        const models = await this.anki.modelNames();
        if (!models.includes(DEFAULT_NOTE_TYPE)) {
          await this.anki.invoke('createModel', ownNoteType());
        }
      }
    })();
    this.setup.catch(() => (this.setup = undefined));
    return this.setup;
  }

  /**
   * Existing note ids for each entry, in one request. Entries whose note
   * type doesn't exist yet have none.
   */
  async existing(entries: Entry[]): Promise<Map<number, number[]>> {
    const queries = entries.map(e =>
      duplicateQuery(e, this.target.noteType, this.target.fields),
    );
    const actions = queries.flatMap(q =>
      q ? [{action: 'findNotes', version: VERSION, params: {query: q}}] : [],
    );
    const results = actions.length
      ? await this.anki.invoke<
          {result: number[] | null; error: string | null}[]
        >('multi', {actions})
      : [];
    const out = new Map<number, number[]>();
    let r = 0;
    entries.forEach((e, i) => {
      // An error here (e.g. the note type doesn't exist yet) means no notes.
      out.set(e.id, queries[i] ? (results[r++]?.result ?? []) : []);
    });
    return out;
  }

  fields(entry: Entry) {
    return noteFields(entry, this.target.fields, this.context(entry));
  }

  async add(entry: Entry): Promise<number> {
    await this.ensureSetup();
    return this.anki.invoke<number>('addNote', {
      note: {
        deckName: this.target.deck,
        modelName: this.target.noteType,
        fields: this.fields(entry),
        tags: ['g-sho'],
        // We check for duplicates ourselves (existing()), by JMdict ID when
        // the note type has one. Anki's check compares only the first field,
        // which would refuse a second word spelled the same (下 した / しも).
        options: {allowDuplicate: true},
      },
    });
  }

  /** Overwrites an existing note's fields with the entry. */
  update(noteId: number, entry: Entry) {
    return this.anki.invoke('updateNoteFields', {
      note: {id: noteId, fields: this.fields(entry)},
    });
  }

  /** Opens Anki's browser on the note. */
  show(noteId: number) {
    return this.anki.invoke('guiBrowse', {query: `nid:${noteId}`});
  }
}
