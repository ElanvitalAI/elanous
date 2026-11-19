import { expect, test } from 'bun:test';
import { removeSeatPaneDirectoryEntry, updateSeatPaneDirectory } from './seat-pane-directory.js';

test('registers, updates and deduplicates one seat without altering others', () => {
  const before = 'OP\tw1:p1\nHAND-A\tw8:p1\tw8\nHAND-B\tretired\tw2\nHAND-A\tw8:p2\n';
  const after = updateSeatPaneDirectory(before, 'HAND-A', 'w8:p3');
  expect(after).toBe('OP\tw1:p1\nHAND-A\tw8:p3\tw8\nHAND-B\tretired\tw2\n');
  expect(updateSeatPaneDirectory(after, 'HAND-A', 'w8:p3')).toBe(after);
  expect(updateSeatPaneDirectory(after, 'HAND-A', 'w9:p3')).toContain('HAND-A\tw9:p3\tw9\n');
  expect(updateSeatPaneDirectory(after, 'HAND-C', 'w9:p1')).toEndWith('HAND-C\tw9:p1\n');
});

test('rejects malformed fields that could inject another row', () => {
  expect(() => updateSeatPaneDirectory('', 'HAND-A\nOP', 'w8:p3')).toThrow();
  expect(() => updateSeatPaneDirectory('', 'HAND-A', 'w8:p3\tother')).toThrow();
});

test('a remote rebind removes stale local rows without creating a route', () => {
  expect(removeSeatPaneDirectoryEntry('A\tw1:p1\nB\tw2:p2\nA\tw1:p3\n', 'A')).toBe('B\tw2:p2\n');
});
