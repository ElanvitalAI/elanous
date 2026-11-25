// ELS-EXIT-BG-BUTTONS literals (OP #102571): where the two buttons sit on an 80-column bottom line and which one a click hits.
import { expect, test } from 'bun:test';
import { buttonsLayout, hitButton } from './attach-buttons.js';

test('80 columns: « ⏏ 백그라운드  ✕ 종료 » ends at the right edge; a click on a label hits it, between them hits nothing', () => {
  const layout = buttonsLayout(80);
  expect(layout.text).toBe(' ⏏ Background  ✕ Quit ');
  expect(layout.at).toEqual([{ id: 'background', from: 60, to: 71 }, { id: 'quit', from: 74, to: 79 }]);
  expect([hitButton(60, 80), hitButton(71, 80), hitButton(72, 80), hitButton(74, 80), hitButton(80, 80), hitButton(10, 80)])
    .toEqual(['background', 'background', null, 'quit', null, null]);
  expect(hitButton(5, 20)).toBeNull();   // too narrow to draw them: no button
});
