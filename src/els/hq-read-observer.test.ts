// CEO 11-23 (ELS-ELN-SECURITY-RELAX): who may read/status any pane across spaces. Literal journals, no product constants.
import { expect, test } from 'bun:test';
import { hqReadObserver, hqTypingRequest } from './server-auth.js';

const journal = {
  workspaces: [
    { id: 'wOP', coordinatorSeat: 'OP' },
    { id: 'wTC', coordinatorSeat: 'TC' },
    { id: 'wFREE' },
  ],
  tabs: [{ id: 'tOP', workspaceId: 'wOP' }, { id: 'tTC', workspaceId: 'wTC' }, { id: 'tFREE', workspaceId: 'wFREE' }],
  panes: [{ id: 'pOP', tabId: 'tOP' }, { id: 'pTC', tabId: 'tTC' }, { id: 'pFREE', tabId: 'tFREE' }],
};

test('the OP seat is an HQ observer wherever it calls from', () => {
  expect(hqReadObserver('OP', undefined, journal)).toBe(true);
  expect(hqReadObserver('OP', 'pTC', journal)).toBe(true);
});

test('a seatless pane in the OP-coordinated workspace is an HQ observer', () => {
  expect(hqReadObserver('unknown', 'pOP', journal)).toBe(true);
  expect(hqReadObserver(undefined, 'pOP', journal)).toBe(true);
});

test('a seatless caller outside the OP space or without a pane is not', () => {
  expect(hqReadObserver('unknown', 'pTC', journal)).toBe(false);
  expect(hqReadObserver('unknown', 'pFREE', journal)).toBe(false);
  expect(hqReadObserver(undefined, undefined, journal)).toBe(false);
  expect(hqReadObserver('unknown', 'pGONE', journal)).toBe(false);
});

test('a named non-HQ seat keeps its own scope even inside the OP workspace', () => {
  expect(hqReadObserver('TC', 'pTC', journal)).toBe(false);
  expect(hqReadObserver('HAND-A', 'pOP', journal)).toBe(false);
});

test('the journal HQ coordinator seat and its workspace count as HQ', () => {
  const hq = { ...journal, hqCoordinatorSeat: 'TC' };
  expect(hqReadObserver('TC', undefined, hq)).toBe(true);
  expect(hqReadObserver('unknown', 'pTC', hq)).toBe(true);
  expect(hqReadObserver('HAND-A', undefined, hq)).toBe(false);
});

// ELS-OP-CROSS-SPACE-SEND: which requests count as non-destructive typing the HQ observer may send to any pane.
test('line typing counts; interrupt, close, snapshot and control keys do not', () => {
  expect(['do', 'input-line', 'send', 'send-verified'].map(op => hqTypingRequest({ op }))).toEqual([true, true, true, true]);
  expect(hqTypingRequest({ op: 'input', bytes: 'pwd\r' })).toBe(true);
  expect(['\x03', '\x1b', '\x04', '\x1a', '\x1c', 'a\x1b[A'].map(bytes => hqTypingRequest({ op: 'input', bytes }))).toEqual([false, false, false, false, false, false]);
  expect(['interrupt', 'close', 'snapshot', 'close-tab', 'record'].map(op => hqTypingRequest({ op }))).toEqual([false, false, false, false, false]);
});
