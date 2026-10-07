import { expect, test } from 'bun:test';
import { LOOPS_INTERACT_HREF, loopsView } from './loops-view';

test('only ?view=interact opens the interaction map; everything else keeps the status table', () => {
  expect(LOOPS_INTERACT_HREF).toBe('/loops?view=interact');
  expect(loopsView(new URLSearchParams('view=interact'))).toBe('interact');
  expect(loopsView(new URLSearchParams('view=interact&journey=card-1'))).toBe('interact');
  for (const search of ['', 'view=', 'view=INTERACT', 'view=status', 'journey=card-1']) expect(loopsView(new URLSearchParams(search))).toBe('status');
  expect(loopsView(null)).toBe('status');
  expect(loopsView(undefined)).toBe('status');
});
