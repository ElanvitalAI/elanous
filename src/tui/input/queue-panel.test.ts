import { expect, test } from 'bun:test';
import { formatInlinePanel } from './inline-panel.js';
import { QUEUE_PANEL_HINT, queuePanelKey, queuePanelMove, queuePanelOrder, queuePanelSpec, type QueuePanelItem } from './queue-panel.js';

const item = (id: string, seq: number, extra: Partial<QueuePanelItem> = {}): QueuePanelItem => ({
  id, seq, kind: 'user', delivery: 'queue', mode: 'chat', status: 'queued', text: `text ${id}`, ...extra,
});
const key = (name: string, shift = false) => ({ name, shift, alt: false, ctrl: false });

const items: QueuePanelItem[] = [
  item('n1', 1, { kind: 'notice', text: '하니스 자식 완료' }),
  item('q2', 2),
  item('s3', 3, { delivery: 'steer' }),
  item('q4', 4, { mode: 'command', text: '/status' }),
  item('d5', 5, { status: 'delivered' }),
  item('x6', 6, { replacementCandidateFor: 'q2', text: '아까 q2 대신 이걸로' }),
];

test('invariant 1: panel and drain order is user > notice, then steer > queue, then seq; only queued rows show', () => {
  expect(queuePanelOrder(items).map((row) => row.id)).toEqual(['s3', 'q2', 'q4', 'x6', 'n1']);
});


test('rows show delivery, kind, mode and the supersede hint in English', () => {
  const lines = formatInlinePanel(queuePanelSpec(items, 0), queuePanelOrder(items).length + 2).join('\n');
  expect(lines).toContain('▸ steer · text s3');
  expect(lines).toContain('queued · text q2');
  expect(lines).not.toContain('editing');
  expect(lines).toContain('queued · /status — command');
  expect(lines).toContain('queued · 아까 q2 대신 이걸로 — may replace q2');
  expect(lines).toContain('queued · 하니스 자식 완료 — notice');
  expect(lines).toContain(QUEUE_PANEL_HINT);
});

test('invariant 10: a supersede hint is only a mark — the panel never retires the old item by itself', () => {
  const order = queuePanelOrder(items);
  expect(order.find((row) => row.id === 'q2')?.status).toBe('queued');
  // Retiring needs an explicit person action on that row (cancel), never the hint alone.
  expect(queuePanelKey(key('delete'), items, order.findIndex((row) => row.id === 'q2'))).toEqual({ kind: 'cancel', id: 'q2' });
});

test('keys: Tab toggles steer↔queue, refuses steering a slash or shell item, Delete cancels, Enter edits, Esc closes, typing passes', () => {
  const order = queuePanelOrder(items);
  const at = (id: string) => order.findIndex((row) => row.id === id);
  expect(queuePanelKey(key('tab'), items, at('q2'))).toEqual({ kind: 'toggle-delivery', id: 'q2', to: 'steer' });
  expect(queuePanelKey(key('tab'), items, at('s3'))).toEqual({ kind: 'toggle-delivery', id: 's3', to: 'queue' });
  expect(queuePanelKey(key('tab'), items, at('q4'))).toMatchObject({ kind: 'refused', id: 'q4' });
  expect(queuePanelKey(key('enter'), items, at('x6'))).toEqual({ kind: 'edit', id: 'x6', text: '아까 q2 대신 이걸로' });
  expect(queuePanelKey(key('escape'), items, at('q2'))).toEqual({ kind: 'closed' });
  // Not a panel key → pass: the panel closes and the key is typed (#38095 r1). Backspace never cancels.
  for (const name of ['backspace', 'a', '/', 'space']) expect(queuePanelKey(key(name), items, at('q2'))).toEqual({ kind: 'pass' });
  expect(queuePanelKey(key('tab', true), items, at('q2'))).toEqual({ kind: 'pass' });
  expect(queuePanelKey(key('delete'), items, at('q2'))).toEqual({ kind: 'cancel', id: 'q2' });
  expect(queuePanelKey(key('mouse'), items, at('q2'))).toBeNull();
  expect(queuePanelMove(items, 0, 'up')).toBe(order.length - 1);
  expect(queuePanelMove(items, order.length - 1, 'down')).toBe(0);
});
