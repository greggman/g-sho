import assert from 'node:assert/strict';
import {test} from 'node:test';
import {UndoStack, type InputState} from '../src/client/undo.ts';

const at = (value: string): InputState => ({
  value,
  start: value.length,
  end: value.length,
});

test('undoes a handwriting insert, typing and deleting as separate steps', () => {
  const s = new UndoStack(at(''));
  s.record(at('聞')); // inserted from the handwriting pad
  s.break();
  s.record(at('聞k'), 'insert', 1000);
  s.record(at('聞く'), 'insert', 1100); // IME composition, same group
  s.record(at('聞'), 'delete', 1500);
  s.record(at(''), 'delete', 1600); // oops, one backspace too many
  assert.equal(s.undo()?.value, '聞く');
  assert.equal(s.undo()?.value, '聞');
  assert.equal(s.undo()?.value, '');
  assert.equal(s.undo(), undefined);
  assert.equal(s.redo()?.value, '聞');
});

test('a pause starts a new step', () => {
  const s = new UndoStack(at(''));
  s.record(at('a'), 'insert', 0);
  s.record(at('ab'), 'insert', 100);
  s.record(at('abc'), 'insert', 5000);
  assert.equal(s.undo()?.value, 'ab');
});

test('a new edit after undo drops the redo branch', () => {
  const s = new UndoStack(at(''));
  s.record(at('猫'));
  s.record(at('犬'));
  s.undo();
  s.record(at('鳥'));
  assert.equal(s.redo(), undefined);
  assert.equal(s.undo()?.value, '猫');
});

test('cursor moves update the state without adding a step', () => {
  const s = new UndoStack(at('abc'));
  s.record({value: 'abc', start: 1, end: 1});
  assert.equal(s.undo(), undefined);
  assert.equal(s.current.start, 1);
});
