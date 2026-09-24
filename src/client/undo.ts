/**
 * Undo for the search box that covers what the browser's own undo misses:
 * text inserted by the handwriting and radical pickers, and the query being
 * replaced when a search loads.
 */

export interface InputState {
  value: string;
  start: number;
  end: number;
}

/** What kind of edit made a state, for grouping keystrokes into one step. */
export type EditKind = 'insert' | 'delete' | 'other';

/** Edits of the same kind closer together than this are one undo step. */
const GROUP_MS = 1000;

/**
 * A linear undo history of input states. Consecutive typing (or deleting)
 * merges into one step, the way text editors do; anything else is its own.
 */
export class UndoStack {
  private states: InputState[];
  private index = 0;
  private lastKind: EditKind | undefined;
  private lastTime = 0;

  constructor(initial: InputState) {
    this.states = [initial];
  }

  get current(): InputState {
    return this.states[this.index];
  }

  /** Records the state after an edit. */
  record(state: InputState, kind: EditKind = 'other', now = Date.now()) {
    if (state.value === this.current.value) {
      // Just a cursor move: remember it so undo puts the cursor back there.
      this.states[this.index] = state;
      return;
    }
    const merge =
      kind !== 'other' &&
      kind === this.lastKind &&
      now - this.lastTime < GROUP_MS &&
      this.index > 0;
    this.states.length = this.index + 1; // drop the redo branch
    if (merge) {
      this.states[this.index] = state;
    } else {
      this.states.push(state);
      this.index++;
    }
    this.lastKind = kind;
    this.lastTime = now;
  }

  /** Ends the current typing group, so the next edit starts a new step. */
  break() {
    this.lastKind = undefined;
  }

  undo(): InputState | undefined {
    if (this.index === 0) return undefined;
    this.break();
    return this.states[--this.index];
  }

  redo(): InputState | undefined {
    if (this.index === this.states.length - 1) return undefined;
    this.break();
    return this.states[++this.index];
  }
}

function kindOf(inputType: string | undefined): EditKind {
  if (inputType?.startsWith('insert')) return 'insert';
  if (inputType?.startsWith('delete')) return 'delete';
  return 'other';
}

export interface InputUndo {
  /** Inserts text at the cursor as its own undo step. */
  insert(text: string): void;
  /** Replaces the whole value (e.g. with a loaded query) as an undo step. */
  set(value: string): void;
}

/**
 * Takes over undo/redo for an input: Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl+Y,
 * and the browser's own undo commands (menus, shake-to-undo), which arrive
 * as historyUndo/historyRedo input events.
 */
export function attachUndo(input: HTMLInputElement): InputUndo {
  const read = (): InputState => ({
    value: input.value,
    start: input.selectionStart ?? input.value.length,
    end: input.selectionEnd ?? input.value.length,
  });
  const stack = new UndoStack(read());
  const apply = (s: InputState | undefined) => {
    if (!s) return;
    input.value = s.value;
    input.setSelectionRange(s.start, s.end);
  };

  input.addEventListener('input', e => {
    stack.record(read(), kindOf((e as InputEvent).inputType));
  });
  input.addEventListener('beforeinput', e => {
    if (e.inputType === 'historyUndo') {
      e.preventDefault();
      apply(stack.undo());
    } else if (e.inputType === 'historyRedo') {
      e.preventDefault();
      apply(stack.redo());
    }
  });
  input.addEventListener('keydown', e => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key === 'z' && !e.shiftKey) {
      e.preventDefault();
      apply(stack.undo());
    } else if ((key === 'z' && e.shiftKey) || key === 'y') {
      e.preventDefault();
      apply(stack.redo());
    }
  });
  // Moving the cursor or leaving the box ends a typing group.
  for (const type of ['blur', 'mouseup', 'keyup'] as const) {
    input.addEventListener(type, e => {
      if (type !== 'keyup' || (e as KeyboardEvent).key.startsWith('Arrow')) {
        stack.break();
        stack.record(read());
      }
    });
  }

  return {
    insert(text) {
      const {start, end} = read();
      input.setRangeText(text, start, end, 'end');
      stack.break();
      stack.record(read());
      input.focus();
    },
    set(value) {
      if (value === input.value) return;
      input.value = value;
      stack.break();
      stack.record(read());
    },
  };
}
