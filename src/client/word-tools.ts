/**
 * Controls on each entry for your own data about the word: star it, mark it
 * known (so study decks can skip it later), and keep a note on it. Saved in
 * the store, so they sync when signed in.
 *
 * Every control on the page is refreshed when the store changes, so a word
 * that appears twice (or changes on another device) stays in step.
 */
import type {Entry} from '../shared/types.ts';
import {h} from './dom.ts';
import {NOTE_MAX_LENGTH, type MarkKind, type Store} from './store/store.ts';

const markId = (kind: MarkKind, wordId: number) => `${kind}:${wordId}`;

export class WordTools {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
    const refresh = () => this.refreshAll();
    store.marks.onChange(refresh);
    store.notes.onChange(refresh);
  }

  /** The controls for an entry: buttons, then its note (if any). */
  readonly actions = (entry: Entry): Node => {
    const el = h('div', {class: 'word-tools', 'data-word': entry.id});
    this.render(el, entry.id);
    return el;
  };

  isMarked(kind: MarkKind, wordId: number): boolean {
    return !!this.store.marks.get(markId(kind, wordId));
  }

  toggle(kind: MarkKind, wordId: number) {
    const id = markId(kind, wordId);
    if (this.store.marks.get(id)) this.store.marks.delete(id);
    else this.store.marks.put({id, wordId, kind});
  }

  note(wordId: number): string {
    return this.store.notes.get(String(wordId))?.text ?? '';
  }

  setNote(wordId: number, text: string) {
    const id = String(wordId);
    text = text.slice(0, NOTE_MAX_LENGTH);
    if (text.trim()) {
      if (text !== this.note(wordId)) this.store.notes.put({id, wordId, text});
    } else {
      this.store.notes.delete(id);
    }
  }

  private refreshAll() {
    for (const el of document.querySelectorAll<HTMLElement>('.word-tools')) {
      // Leave a note that's being typed alone.
      if (el.querySelector('textarea') === document.activeElement) continue;
      this.render(el, Number(el.dataset.word));
    }
  }

  private render(el: HTMLElement, wordId: number) {
    const starred = this.isMarked('star', wordId);
    const known = this.isMarked('known', wordId);
    const note = this.note(wordId);
    el.replaceChildren(
      h(
        'button',
        {
          type: 'button',
          class: 'word-tool star',
          'aria-pressed': String(starred),
          title: starred ? 'Unstar' : 'Star this word',
          'aria-label': 'Star',
          onclick: () => this.toggle('star', wordId),
        },
        starred ? '★' : '☆',
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'word-tool known',
          'aria-pressed': String(known),
          title: known
            ? 'Marked as known. Click to unmark.'
            : 'I know this word: study decks can skip it',
          onclick: () => this.toggle('known', wordId),
        },
        known ? '✓ known' : 'known',
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'word-tool note-button',
          'aria-pressed': String(!!note),
          title: note ? 'Edit your note' : 'Add a note',
          'aria-label': 'Note',
          onclick: () => this.edit(el, wordId),
        },
        '✎',
      ),
      note &&
        h(
          'p',
          {
            class: 'word-note',
            title: 'Your note. Click to edit.',
            onclick: () => this.edit(el, wordId),
          },
          note,
        ),
    );
  }

  /**
   * Swaps the note for a text box until it loses focus. Saved as you type
   * too, in case the page changes without a blur.
   */
  private edit(el: HTMLElement, wordId: number) {
    const open = el.querySelector('textarea');
    if (open) {
      open.focus();
      return;
    }
    el.querySelector('.word-note')?.remove();
    const box = h('textarea', {
      class: 'word-note-edit',
      rows: 3,
      maxlength: NOTE_MAX_LENGTH,
      placeholder: 'Your note on this word',
      'aria-label': 'Your note',
    });
    box.value = this.note(wordId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    box.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => this.setNote(wordId, box.value), 500);
    });
    box.addEventListener('blur', () => {
      clearTimeout(timer);
      this.setNote(wordId, box.value);
      // setNote doesn't notify when nothing changed.
      this.render(el, wordId);
    });
    box.addEventListener('keydown', e => {
      if (e.key === 'Escape') box.blur();
    });
    el.append(box);
    box.focus();
  }
}
