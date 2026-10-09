import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMsgStore } from '../msg/msg-store.js';
import { checkLoopNeighbors, emitLoopHeartbeat, SEAT_NEIGHBORS } from './neighbor-runtime.js';

const start = new Date('2026-10-05T00:00:00Z');
const at = (minutes: number) => new Date(start.getTime() + minutes * 60_000);

test('a stopped seat cron is observed within two ticks and executes the configured onAbsent once', () => {
  const root = mkdtempSync(join(tmpdir(), 'neighbor-contract-'));
  try {
    const neighbors = SEAT_NEIGHBORS.TC!.filter(peer => peer.id === 'op-seat');
    emitLoopHeartbeat(root, 'op-seat', 'healthy', start);
    expect(checkLoopNeighbors(root, 'tc-seat', neighbors, start)).toEqual([]);
    expect(checkLoopNeighbors(root, 'tc-seat', neighbors, at(15))).toEqual([]);
    const [incident] = checkLoopNeighbors(root, 'tc-seat', neighbors, at(30));
    expect(incident).toMatchObject({ observer: 'tc-seat', neighbor: 'op-seat', state: 'absent', reason: 'heartbeat-missed', action: 'delegate', to: 'steward' });
    expect(checkLoopNeighbors(root, 'tc-seat', neighbors, at(45))).toEqual([]);
    const store = openMsgStore(join(root, 'msg', 'messages.db'));
    try {
      expect(store.listByRecipient('steward').filter(row => row.kind === 'neighbor-delegate')).toHaveLength(1);
      expect(store.listByRecipient('steward')[0]?.body).toContain('op-seat heartbeat-missed');
      expect(store.db.query('SELECT reason, action FROM loop_incidents').all()).toEqual([{ reason: 'heartbeat-missed', action: 'delegate' }]);
    } finally { store.close(); }
    emitLoopHeartbeat(root, 'op-seat', 'healthy', at(46));
    expect(checkLoopNeighbors(root, 'tc-seat', neighbors, at(47))).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('missing first signal, degraded and expired signals take the peer-specific policy without repeating receipts', () => {
  const root = mkdtempSync(join(tmpdir(), 'neighbor-policy-'));
  try {
    const neighbors = SEAT_NEIGHBORS.OP!.filter(peer => ['cmo-seat', 'ux-seat', 'tc-seat'].includes(peer.id));
    expect(checkLoopNeighbors(root, 'op-seat', neighbors, start)).toEqual([]);
    expect(checkLoopNeighbors(root, 'op-seat', neighbors, at(30)).map(row => [row.neighbor, row.action, row.to]))
      .toEqual([['tc-seat', 'escalate', 'orchestrator'], ['cmo-seat', 'defer', 'orchestrator'], ['ux-seat', 'defer', 'orchestrator']]);
    emitLoopHeartbeat(root, 'tc-seat', 'degraded', at(31));
    expect(checkLoopNeighbors(root, 'op-seat', neighbors, at(31)).filter(row => row.neighbor === 'tc-seat'))
      .toMatchObject([{ reason: 'degraded', action: 'escalate' }]);
    emitLoopHeartbeat(root, 'cmo-seat', 'healthy', at(32), at(33).toISOString());
    expect(checkLoopNeighbors(root, 'op-seat', neighbors, at(33)).filter(row => row.neighbor === 'cmo-seat'))
      .toMatchObject([{ reason: 'end-expired', action: 'defer' }]);
    expect(checkLoopNeighbors(root, 'op-seat', neighbors, at(34))).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('missing orchestrator is sent to human, not silently treated as a healthy neighbor', () => {
  const root = mkdtempSync(join(tmpdir(), 'neighbor-human-'));
  try {
    const neighbors = SEAT_NEIGHBORS.MK!.filter(peer => peer.id === 'orchestrator');
    checkLoopNeighbors(root, 'mk-seat', neighbors, start);
    expect(checkLoopNeighbors(root, 'mk-seat', neighbors, at(240))).toMatchObject([
      { neighbor: 'orchestrator', action: 'escalate', to: 'human', reason: 'heartbeat-missed' },
    ]);
    const store = openMsgStore(join(root, 'msg', 'messages.db'));
    try { expect(store.listByRecipient('human').filter(row => row.kind === 'neighbor-escalate')).toHaveLength(1); }
    finally { store.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
