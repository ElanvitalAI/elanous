// CEO 11-23 (ELS-ELN-SECURITY-RELAX): who may read/status any pane across spaces. Literal journals, no product constants.
import { expect, test } from 'bun:test';
import { coordinatorAuthority, hqObserver, hqReadObserver, hqTypingRequest, paneSeatOf } from './server-auth.js';

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

test('COORD-RIGHTS: a workspace coordinator (TC) reads every pane; it is still not the HQ typer · a hand keeps its own scope', () => {
  expect(hqReadObserver('TC', 'pTC', journal)).toBe(true);
  expect(hqObserver('TC', 'pTC', journal)).toBe(false);
  expect(hqReadObserver('HAND-A', 'pOP', journal)).toBe(false);
});

// The live 07:38 journal (OP #189879 · UX #189881): no ownerSeat anywhere, no hqCoordinatorSeat, the OP workspace has no
// coordinator; the OP pane has only seatIdentity, the UX pane only its seat cwd.
const live = {
  workspaces: [{ id: 'w91e0d95d' }, { id: 'w8171b7a4', coordinatorSeat: 'UX' }, { id: 'w7b30349f', coordinatorSeat: 'TC' }],
  tabs: [{ id: 'tOP', workspaceId: 'w91e0d95d' }, { id: 'tUX', workspaceId: 'w8171b7a4' }, { id: 'tH', workspaceId: 'w7b30349f' }, { id: 'tW', workspaceId: 'w8171b7a4' }],
  panes: [
    { id: 'p299c5366', tabId: 'tOP', seatIdentity: 'OP', cwd: '/opt/fed/elanous-hq/seats/OP' },
    { id: 'p141958ad', tabId: 'tUX', cwd: '/opt/fed/elanous-hq/seats/UX' },
    { id: 'p22b0dd1a', tabId: 'tH', cwd: '/opt/fed/elanous-hq/seats/TC-H-CX-6' },
    { id: 'pc460ff60', tabId: 'tW', cwd: '/opt/fed/elanous-hq/seat-state/OPS' },
    { id: 'pwt', tabId: 'tUX', cwd: '/opt/fed/elanous-hq/seats/UX/.claude/wt/x' },
  ],
};

test('COORD-RIGHTS live repro: the seatless OP pane (seatIdentity) and UX pane (seat cwd) read other panes; a hand and a worktree child do not', () => {
  expect(hqReadObserver('unknown', 'p299c5366', live)).toBe(true);
  expect(hqObserver('unknown', 'p299c5366', live)).toBe(true);
  expect(hqReadObserver('unknown', 'p141958ad', live)).toBe(true);
  expect(hqObserver('unknown', 'p141958ad', live)).toBe(false);
  expect(hqReadObserver('unknown', 'p22b0dd1a', live)).toBe(false);
  expect(hqReadObserver('unknown', 'pc460ff60', live)).toBe(false);
  expect(hqReadObserver('unknown', 'pwt', live)).toBe(false);
  // A worker pane OP spawned is OP-owned but is not OP: ownership is not caller identity.
  const worker = { ...live, panes: [...live.panes, { id: 'pworker', tabId: 'tUX', ownerSeat: 'OP', cwd: '/tmp/w1' }] };
  expect(hqReadObserver('unknown', 'pworker', worker)).toBe(false);
});

test('COORD-RIGHTS: pane seat = ownerSeat → seatIdentity → exact seat cwd; coordinator authority follows it', () => {
  expect(paneSeatOf({ ownerSeat: 'tc', seatIdentity: 'X' })).toBe('TC');
  expect(paneSeatOf({ ownerSeat: 'unknown', seatIdentity: 'op' })).toBe('OP');
  expect(paneSeatOf({ cwd: '/opt/fed/elanous-hq/seats/TC-H-CX-6/' })).toBe('TC-H-CX-6');
  expect(paneSeatOf({ cwd: '/opt/fed/elanous-hq/seats/UX/.claude/wt/x' })).toBeUndefined();
  expect(paneSeatOf(undefined)).toBeUndefined();
  const j = { ...live, workspaces: live.workspaces.map(w => ({ ...w, name: w.id })) };
  expect(coordinatorAuthority('unknown', 'p299c5366', j)).toEqual({ scope: 'hq', seat: 'OP' });
  expect(coordinatorAuthority('unknown', 'p141958ad', j)).toEqual({ scope: 'space', seat: 'UX', workspaceIds: ['w8171b7a4'] });
  expect(coordinatorAuthority('unknown', 'p22b0dd1a', j)).toBeUndefined();
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
