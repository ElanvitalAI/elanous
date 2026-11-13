import { expect, test } from 'bun:test';
import type { Key } from '../../tui-key.js';
import { sidetabPointerAction, sidetabRowMenu } from './interaction.js';

const mouse = (type: 'click' | 'right-click', row: number, col: number): Key => ({
  name: 'mouse', ctrl: false, shift: false, mouse: { type, row, col },
});

test('sidetab pointer uses the actual rect and distinguishes select from context menu', () => {
  const regions = [{ rowId: 'pty:a', rect: { row: 3, col: 60, width: 20, height: 2 } }];
  expect(sidetabPointerAction(mouse('click', 3, 60), regions)).toEqual({ kind: 'select', rowId: 'pty:a' });
  expect(sidetabPointerAction(mouse('right-click', 4, 79), regions)).toEqual({
    kind: 'context-menu', rowId: 'pty:a', row: 4, col: 79,
  });
  expect(sidetabPointerAction(mouse('click', 5, 60), regions)).toBeUndefined();
  expect(sidetabPointerAction(mouse('right-click', 4, 80), regions)).toBeUndefined();
  expect(sidetabPointerAction({ name: 'enter', ctrl: false, shift: false }, regions)).toBeUndefined();
  expect(sidetabPointerAction({ name: 'mouse', ctrl: false, shift: false,
    mouse: { type: 'motion', row: 3, col: 60 } }, regions)).toBeUndefined();
  expect(sidetabPointerAction(mouse('click', 3, 60), [])).toBeUndefined();
  expect(sidetabRowMenu({ id: 'pty:a', kind: 'codex', label: 'Agent', badge: 'busy' }).items
    .filter((item) => item.kind !== 'separator').map((item) => item.id))
    .toEqual(['open', 'rename', 'close']);
});
