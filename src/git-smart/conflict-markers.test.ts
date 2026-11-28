import { expect, test } from 'bun:test';
import { hasConflictMarkers, hasLadderConflictMarkers } from './conflict-markers.js';

test('marker contracts preserve separator and bare-marker differences', () => {
  for (const [text, selfImplement, ladder] of [
    ['clean\n', false, false],
    ['<<<<<<< ours\n', true, true],
    ['||||||| base\n', true, true],
    ['>>>>>>> theirs\n', true, true],
    ['=======\n', true, false],
    ['<<<<<<<\n', false, true],
    ['indented <<<<<<< ours\n', false, false],
  ] as const) {
    expect(hasConflictMarkers(text)).toBe(selfImplement);
    expect(hasLadderConflictMarkers(text)).toBe(ladder);
  }
});
