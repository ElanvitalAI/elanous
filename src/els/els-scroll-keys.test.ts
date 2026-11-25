// ELS-SCROLL-MOUSE: after ctrl+b, PgUp/PgDn/Home/End page the side list and ←/→ scroll the tab row; alone they stay the pane's.
import { expect, test } from 'bun:test';
import { createKeyRouter } from './attach-keys.js';

const actions = (text: string) => createKeyRouter().feed(text).map((event) => event.kind === 'action' ? event.action : event.kind === 'input' ? `input:${JSON.stringify(event.bytes)}` : event.kind);

test('ctrl+b then a paging key is a list/tab scroll action', () => {
  expect(actions('\u0002\u001b[5~')).toEqual(['list-page-up']);
  expect(actions('\u0002\u001b[6~')).toEqual(['list-page-down']);
  expect(actions('\u0002\u001b[H')).toEqual(['list-home']);
  expect(actions('\u0002\u001b[F')).toEqual(['list-end']);
  expect(actions('\u0002\u001b[1~')).toEqual(['list-home']);
  expect(actions('\u0002\u001b[4~')).toEqual(['list-end']);
  expect(actions('\u0002\u001b[D')).toEqual(['tabs-left']);
  expect(actions('\u0002\u001b[C')).toEqual(['tabs-right']);
  expect(actions('\u0002\u001b[Cab')).toEqual(['tabs-right', 'input:"ab"']);
});

test('without the prefix the keys go to the pane untouched', () => {
  expect(actions('\u001b[5~')).toEqual(['input:"\\u001b[5~"']);
  expect(actions('\u001b[D')).toEqual(['input:"\\u001b[D"']);
});
