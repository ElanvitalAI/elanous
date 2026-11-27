// SIM — THROTTLE-AUDIT (CEO 11-27 11:0x): the mail back-pressure turns/h ceiling scales with the receiver's span.
// 11-27 live: TC (hub of 13 hands ⊕ UX · MK · JUD) was folded 275 times in 12 h on the fixed 20 turns/h — 24 UX requests,
// 17 MK requests and hand reports included; the folded digest shows only the last 3 heads. Independent literals below.
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MsgStore } from './msg-store.js';
import { correspondentsLastHour, gatePost, storeGateDeps } from './post-gate.js';
import { appendDiverted, noteTurnStamp } from './diverted-mail.js';
import { backpressureConfigFrom, backpressureVerdict, turnsCeiling } from './post-discipline.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function tmp(): string { const d = mkdtempSync(join(tmpdir(), 'post-gate-span-')); dirs.push(d); return d; }

const HANDS = ['TC-H-CX-1', 'TC-H-CX-2', 'TC-H-CX-3', 'TC-H-CX-4', 'TC-H-CX-5', 'TC-H-CX-6', 'TC-H-CX-7',
  'TC-H-CC-1', 'TC-H-CC-2', 'TC-H-POOL-1', 'TC-H-POOL-2', 'TC-H-POOL-3', 'HAND-TUI-D'];

test('11-27 replay: TC at 30 mail turns/h with 16 correspondents → a UX request passes (was folded at the fixed 20)', () => {
  const dir = tmp();
  const store = new MsgStore(join(dir, 'messages.db'));
  const root = join(dir, 'diverted');
  const now = Date.now();
  for (let i = 0; i < 30; i += 1) noteTurnStamp('TC', now - 55 * 60_000 + i * 60_000, root, true);
  for (const h of HANDS) store.post({ from: h, to: 'TC', body: `report from ${h}`, kind: 'report', needsAck: true });
  // MK and JUD were folded earlier this hour — they still count as correspondents.
  appendDiverted('folded', { seat: 'TC', from: 'MK', kind: 'request', body: 'deck review', at: new Date(now - 20 * 60_000).toISOString() }, root);
  appendDiverted('folded', { seat: 'TC', from: 'JUD', kind: 'request', body: 'sign', at: new Date(now - 10 * 60_000).toISOString() }, root);
  // A fold older than the hour does not count.
  appendDiverted('folded', { seat: 'TC', from: 'REL', kind: 'info', body: 'old', at: new Date(now - 3 * 60 * 60_000).toISOString() }, root);
  store.post({ from: 'UX', to: 'TC', body: 'earlier', kind: 'info', needsAck: false });
  expect(correspondentsLastHour(store.db, 'TC', now, root)).toBe(16);
  const logs: string[] = [];
  const deps = { ...storeGateDeps(store, root), log: (e: string, d: Record<string, unknown>) => { logs.push(`${e} ${JSON.stringify(d)}`); } };
  const r = gatePost({ envelope: { from: 'UX', to: 'TC', body: 'need TC to split SURFACE-7', kind: 'request' }, entrance: 'cli' }, deps);
  expect(r.action).toBe('post');
  expect(logs.some((l) => l.startsWith('msg.backpressure '))).toBe(false);
  // Control: the same post with the span unknown (old fixed 20 turns/h) is folded.
  const { correspondentsLastHour: _drop, ...fixed } = deps;
  const old = gatePost({ envelope: { from: 'UX', to: 'TC', body: 'need TC to split SURFACE-8', kind: 'request' }, entrance: 'cli' }, fixed);
  expect(old.action === 'divert' && old.ledger).toBe('folded');
  store.close();
});

test('the scaled ceiling still folds a truly saturated hub (33 turns/h > 2 × 16)', () => {
  const dir = tmp();
  const store = new MsgStore(join(dir, 'messages.db'));
  const root = join(dir, 'diverted');
  const now = Date.now();
  for (let i = 0; i < 33; i += 1) noteTurnStamp('TC', now - 58 * 60_000 + i * 60_000, root, true);
  for (const h of HANDS) store.post({ from: h, to: 'TC', body: `r ${h}`, kind: 'report', needsAck: true });
  store.post({ from: 'MK', to: 'TC', body: 'm', kind: 'info', needsAck: false });
  store.post({ from: 'JUD', to: 'TC', body: 'j', kind: 'info', needsAck: false });
  store.post({ from: 'UX', to: 'TC', body: 'u', kind: 'info', needsAck: false });
  const logs: string[] = [];
  const deps = { ...storeGateDeps(store, root), log: (e: string, d: Record<string, unknown>) => { logs.push(`${e} ${JSON.stringify(d)}`); } };
  const r = gatePost({ envelope: { from: 'MK', to: 'TC', body: 'fyi', kind: 'info' }, entrance: 'cli' }, deps);
  expect(r.action === 'divert' && r.ledger).toBe('folded');
  expect(logs.some((l) => l.includes('"reason":"turns"') && l.includes('"correspondents":16'))).toBe(true);
  store.close();
});

test('a self-post does not count the receiver as its own correspondent', () => {
  const dir = tmp();
  const store = new MsgStore(join(dir, 'messages.db'));
  const root = join(dir, 'diverted');
  store.post({ from: 'TC', to: 'TC', body: 'self', kind: 'info', needsAck: false });
  store.post({ from: 'MK', to: 'TC', body: 'x', kind: 'info', needsAck: false });
  expect(correspondentsLastHour(store.db, 'TC', Date.now(), root)).toBe(1);
  store.close();
});

test('pure: ceiling = max(20, 2 × correspondents) · unknown → floor · config can set the slope', () => {
  const cfg = { maxPendingPassive: 30, maxTurnsPerHour: 20, turnsPerCorrespondent: 2 };
  expect(turnsCeiling(cfg, 16)).toBe(32);
  expect(turnsCeiling(cfg, 3)).toBe(20);
  expect(turnsCeiling(cfg, null)).toBe(20);
  expect(turnsCeiling(cfg, undefined)).toBe(20);
  expect(turnsCeiling({ maxPendingPassive: 30, maxTurnsPerHour: 20 }, 16)).toBe(32);
  expect(backpressureVerdict({ urgent: false, pendingPassive: 0, turnsLastHour: 30, correspondentsLastHour: 16 }, cfg)).toEqual({ fold: false, reason: 'below' });
  expect(backpressureVerdict({ urgent: false, pendingPassive: 0, turnsLastHour: 30 }, cfg)).toEqual({ fold: true, reason: 'turns' });
  expect(backpressureConfigFrom({ turnsPerCorrespondent: 3 })).toEqual({ maxPendingPassive: 30, maxTurnsPerHour: 20, turnsPerCorrespondent: 3 });
  expect(backpressureConfigFrom({ turnsPerCorrespondent: 0 }).turnsPerCorrespondent).toBe(0);
  expect(turnsCeiling(backpressureConfigFrom({ turnsPerCorrespondent: 0 }), 16)).toBe(20);
});
