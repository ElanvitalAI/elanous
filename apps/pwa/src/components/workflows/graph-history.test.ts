import { describe, expect, test } from 'bun:test';
import { GraphHistory } from './graph-history';

describe('GraphHistory', () => {
  test('record/undo/redo returns exact YAML strings and reports empty history', () => {
    const history = new GraphHistory();
    const first = 'name: first\n# preserve comment\n';
    const second = 'name: second\n';
    const third = 'name: third\n';

    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
    expect(history.undo(first)).toBeNull();
    expect(history.redo(first)).toBeNull();

    history.record(first);
    history.record(second);
    expect(history.canUndo).toBe(true);
    expect(history.undo(third)).toBe(second);
    expect(history.undo(second)).toBe(first);
    expect(history.undo(first)).toBeNull();
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(true);
    expect(history.redo(first)).toBe(second);
    expect(history.redo(second)).toBe(third);
    expect(history.redo(third)).toBeNull();
    expect(history.canRedo).toBe(false);
  });

  test('keeps only the most recent 50 undo steps', () => {
    const history = new GraphHistory();
    for (let i = 0; i < 51; i += 1) history.record(`name: ${i}\n`);

    for (let i = 50; i >= 1; i -= 1) {
      expect(history.undo(`name: ${i + 1}\n`)).toBe(`name: ${i}\n`);
    }
    expect(history.undo('name: 1\n')).toBeNull();
  });

  test('ignores consecutive duplicate records', () => {
    const history = new GraphHistory();
    history.record('name: same\n');
    history.record('name: same\n');
    expect(history.undo('name: changed\n')).toBe('name: same\n');
    expect(history.undo('name: same\n')).toBeNull();
  });

  test('a new record after undo clears redo, but a duplicate record does not', () => {
    const history = new GraphHistory();
    history.record('name: one\n');
    history.record('name: two\n');
    expect(history.undo('name: three\n')).toBe('name: two\n');
    history.record('name: one\n');
    expect(history.canRedo).toBe(true);
    history.record('name: branch\n');
    expect(history.canRedo).toBe(false);
    expect(history.redo('name: branch\n')).toBeNull();
    expect(history.undo('name: newer\n')).toBe('name: branch\n');
  });
});
