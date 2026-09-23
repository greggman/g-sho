import type {Entry} from '../../shared/types.ts';
import type {Dict} from '../dict.ts';
import {h} from '../dom.ts';
import {headword} from '../forms.ts';
import {posLabel, type EntryActions} from '../render.ts';
import {AnkiConnect, AnkiNotes} from './connect.ts';
import type {AnkiSettings} from './settings.ts';

type State =
  | {kind: 'checking'}
  | {kind: 'absent'}
  | {kind: 'present'; noteIds: number[]}
  | {kind: 'busy'}
  | {kind: 'error'; message: string};

/**
 * The add-to-Anki control on each entry: "+" adds the word; once it's in
 * Anki, "✓" opens a menu to overwrite the note or show it in Anki. Existence
 * is checked for all entries on the page in one request.
 */
class AnkiButtons {
  private readonly notes: AnkiNotes;
  /** controls on the page, by entry id (an entry can appear twice) */
  private readonly controls = new Map<number, Set<HTMLElement>>();
  private readonly states = new Map<number, State>();
  private readonly entries = new Map<number, Entry>();
  private toCheck: Entry[] = [];

  constructor(notes: AnkiNotes) {
    this.notes = notes;
  }

  readonly actions: EntryActions = entry => {
    const el = h('span', {class: 'anki'});
    let set = this.controls.get(entry.id);
    if (!set) {
      set = new Set();
      this.controls.set(entry.id, set);
    }
    set.add(el);
    this.entries.set(entry.id, entry);
    const known = this.states.get(entry.id);
    if (known && known.kind !== 'error') {
      this.render(el, entry, known);
    } else {
      this.render(el, entry, {kind: 'checking'});
      if (this.toCheck.length === 0) setTimeout(() => void this.check());
      this.toCheck.push(entry);
    }
    return el;
  };

  private async check() {
    const entries = [...new Map(this.toCheck.map(e => [e.id, e])).values()];
    this.toCheck = [];
    try {
      const existing = await this.notes.existing(entries);
      for (const e of entries) {
        const noteIds = existing.get(e.id) ?? [];
        this.set(
          e,
          noteIds.length ? {kind: 'present', noteIds} : {kind: 'absent'},
        );
      }
    } catch (err) {
      for (const e of entries) {
        this.set(e, {kind: 'error', message: (err as Error).message});
      }
    }
  }

  private set(entry: Entry, state: State) {
    this.states.set(entry.id, state);
    const set = this.controls.get(entry.id) ?? new Set();
    for (const el of set) {
      // A check can finish before new results are put on the page, so render
      // controls that aren't attached yet too. Forget ones that were on the
      // page and have been removed by a later search.
      if (el.isConnected) el.dataset.shown = '';
      else if (el.dataset.shown !== undefined) {
        set.delete(el);
        continue;
      }
      this.render(el, entry, state);
    }
  }

  private async act(entry: Entry, work: () => Promise<State>) {
    const before = this.states.get(entry.id);
    this.set(entry, {kind: 'busy'});
    try {
      this.set(entry, await work());
    } catch (err) {
      const message = (err as Error).message;
      this.set(entry, {kind: 'error', message});
      // Put the working state back after showing the error for a moment.
      setTimeout(() => before && this.set(entry, before), 4000);
    }
  }

  private render(el: HTMLElement, entry: Entry, state: State) {
    const word = headword(entry).text;
    el.dataset.state = state.kind;
    switch (state.kind) {
      case 'checking':
      case 'busy':
        el.replaceChildren(
          h(
            'button',
            {
              type: 'button',
              class: 'anki-button',
              disabled: true,
              title: 'Checking Anki…',
            },
            '+',
          ),
        );
        break;
      case 'absent':
        el.replaceChildren(
          h(
            'button',
            {
              type: 'button',
              class: 'anki-button',
              title: `Add ${word} to Anki`,
              'aria-label': `Add ${word} to Anki`,
              onclick: () =>
                void this.act(entry, async () => ({
                  kind: 'present',
                  noteIds: [await this.notes.add(entry)],
                })),
            },
            '+',
          ),
        );
        break;
      case 'present': {
        const [noteId] = state.noteIds;
        el.replaceChildren(
          h(
            'details',
            {class: 'anki-menu'},
            h(
              'summary',
              {class: 'anki-button', title: `${word} is in Anki`},
              '✓',
            ),
            h(
              'div',
              {class: 'anki-menu-items'},
              h(
                'button',
                {
                  type: 'button',
                  onclick: () =>
                    void this.act(entry, async () => {
                      await this.notes.update(noteId, entry);
                      return state;
                    }),
                },
                'Update in Anki',
              ),
              h(
                'button',
                {type: 'button', onclick: () => void this.notes.show(noteId)},
                'Show in Anki',
              ),
            ),
          ),
        );
        break;
      }
      case 'error':
        el.replaceChildren(
          h(
            'button',
            {
              type: 'button',
              class: 'anki-button',
              title: `Anki: ${state.message}`,
              onclick: () => {
                this.states.delete(entry.id);
                this.toCheck.push(entry);
                void this.check();
              },
            },
            '!',
          ),
        );
        break;
    }
  }
}

/** Entry controls for the current Anki settings. */
export function createAnkiActions(
  settings: AnkiSettings,
  dict: Dict,
): EntryActions {
  const anki = new AnkiConnect(settings.url, settings.apiKey);
  const site = new URL(location.pathname, location.origin);
  const notes = new AnkiNotes(
    anki,
    {deck: settings.deck, noteType: settings.noteType, fields: settings.fields},
    entry => ({
      posLabel: tag => posLabel(dict, tag),
      link: `${site.href}?q=${encodeURIComponent(headword(entry).text)}`,
    }),
  );
  return new AnkiButtons(notes).actions;
}
