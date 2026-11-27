// WORLD-REGISTRY control + auto-registration — planning per kind, authority, audit lines, reversibility, fold effect.
// The runner is injected (no launchctl · no ssh · no schedule CRUD); the ledger is a temp file.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readResourceLedger, recordWorldEvents } from './resource-ledger.js';
import { controlActor, mayControl, planControl, type ControlRunner } from './world-control.js';
import { foldWorld, eventsFor } from './world-registry.js';
import { callingSeat, registerCronQuietly, registerLaunchdQuietly } from './world-register.js';
import type { WorldActor } from './world-types.js';

let dir: string; let path: string;
const T0 = new Date('2026-11-27T01:00:00.000Z');
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'world-ctl-')); path = join(dir, 'resource-ledger', 'events.jsonl'); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const actor = (over: Partial<WorldActor> & Pick<WorldActor, 'id' | 'kind'>): WorldActor => ({
  purpose: null, owner: 'TC', subject: null, wake: null, kpi: null, heartbeatSource: null, heartbeatAt: null, slaMin: null, host: 'mshq', registered: true,
  declaredState: 'live', state: 'live', reason: null, present: true, seenAt: null, createdAt: T0.toISOString(), updatedAt: T0.toISOString(), retire: 'never', meta: {}, ...over });
const base = { localHost: 'mshq', uid: 501, by: 'OP' };

describe('planControl', () => {
  test('loop: pause = trigger demote · resume = trigger promote · demote = loop agent level', () => {
    const a = actor({ id: 'loop:land-graph', kind: 'loop', host: null });
    expect(planControl(a, 'pause', base)).toEqual({ ok: true, argv: ['elanous', 'loop', 'trigger', 'demote', 'land-graph', '--yes'], host: null, declaredState: 'shadow', undo: 'eln world control loop:land-graph resume' });
    expect(planControl(a, 'resume', base)).toMatchObject({ ok: true, argv: ['elanous', 'loop', 'trigger', 'promote', 'land-graph', '--reason', 'world control resume'], declaredState: 'live' });
    expect(planControl(a, 'demote', { ...base, to: 'off' })).toMatchObject({ ok: true, argv: ['elanous', 'loop', 'demote', 'land-graph', '--to', 'off', '--by', 'OP', '--reason', 'world control demote'], declaredState: 'off', undo: 'eln loop promote land-graph' });
    expect(planControl(a, 'demote', { ...base, to: 'live' })).toEqual({ ok: false, why: '--to must be L1 · shadow · off' });
  });
  test('launchd: elanous-owned only · remote host goes over ssh · resume needs the plist', () => {
    const tm = actor({ id: 'launchd:com.elanous.train-manager@node-b', kind: 'launchd', host: 'node-b', meta: { plist: '/U/LaunchAgents/com.elanous.train-manager.plist' } });
    expect(planControl(tm, 'pause', base)).toEqual({ ok: true, argv: ['launchctl', 'bootout', 'gui/501/com.elanous.train-manager'], host: 'node-b', declaredState: 'off', undo: 'eln world control launchd:com.elanous.train-manager@node-b resume' });
    expect(planControl(tm, 'resume', base)).toMatchObject({ ok: true, argv: ['launchctl', 'bootstrap', 'gui/501', '/U/LaunchAgents/com.elanous.train-manager.plist'], declaredState: 'live' });
    expect(planControl(actor({ id: 'launchd:com.elanous.x@mshq', kind: 'launchd' }), 'resume', base).ok).toBe(false);
    expect(planControl(actor({ id: 'launchd:com.apple.Siri@mshq', kind: 'launchd' }), 'pause', base)).toEqual({ ok: false, why: 'launchd com.apple.Siri is not elanous-owned — no control path' });
  });
  test('cron: schedule disable/enable by the shared content-hash id · other kinds refused', () => {
    expect(planControl(actor({ id: 'cron:0123456789ab@mshq', kind: 'cron' }), 'pause', base)).toMatchObject({ ok: true, argv: ['elanous', 'schedule', 'disable', '0123456789ab', '--json'], host: null, declaredState: 'off' });
    expect(planControl(actor({ id: 'process:abc@mshq', kind: 'process' }), 'pause', base)).toEqual({ ok: false, why: 'process has no control path through the ledger (owner TC)' });
  });
});

describe('authority', () => {
  test('guardian · RES · OP · CLAUDE-OP · CEO control any actor; an owner its own; others nothing', () => {
    expect(mayControl('loop:guardian', { owner: 'TC' })).toBe(true);
    expect(mayControl('CEO', { owner: 'TC' })).toBe(true);
    expect(mayControl('tc', { owner: 'TC' })).toBe(true);
    expect(mayControl('MK', { owner: 'TC' })).toBe(false);
  });
});

describe('controlActor → ledger', () => {
  const ok: ControlRunner = () => ({ ok: true, output: '' });
  test('applied: audit line with undo ⊕ declaredState; the fold shows off; the trail shows the control', () => {
    recordWorldEvents([{ event: 'world-actor', at: T0.toISOString(), by: 'TC', actor: { id: 'launchd:com.elanous.train-manager@mshq', kind: 'launchd', mode: 'owner', registered: true, owner: 'TC', host: 'mshq' } }], path);
    const before = foldWorld(readResourceLedger(path), T0).actors[0]!;
    const out = controlActor(before, before.id, 'pause', { ...base, reason: 'zombie since 11-26', now: T0, run: ok });
    recordWorldEvents(out.lines, path);
    expect(out.result).toBe('applied');
    const events = readResourceLedger(path);
    expect(foldWorld(events, T0).actors[0]!.state).toBe('off');
    const trail = eventsFor(events, before.id).map(e => e.event);
    expect(trail).toEqual(['world-actor', 'world-control', 'world-actor']);
  });
  test('refused (no authority) and failed (command error) are audited and change nothing', () => {
    const a = actor({ id: 'cron:0123456789ab@mshq', kind: 'cron' });
    const refused = controlActor(a, a.id, 'pause', { ...base, by: 'MK', reason: 'r', now: T0, run: ok });
    expect(refused.result).toBe('refused');
    expect(refused.lines.map(l => l.event)).toEqual(['world-control']);
    const failed = controlActor(a, a.id, 'pause', { ...base, reason: 'r', now: T0, run: () => ({ ok: false, output: 'no such job' }) });
    expect(failed.result).toBe('failed');
    expect(failed.detail).toBe('elanous schedule disable 0123456789ab --json → failed: no such job');
    expect(failed.lines.map(l => l.event)).toEqual(['world-control']);
    expect(controlActor(undefined, 'loop:ghost', 'pause', { ...base, reason: 'r', now: T0, run: ok }).detail).toBe('no actor loop:ghost');
  });
});

describe('auto-registration', () => {
  test('a cron line made by the schedule CRUD is registered, owned by the calling seat', () => {
    expect(registerCronQuietly({ scheduleId: '0123456789ab', cron: '*/5 * * * *', name: 'loop-check', command: 'sh x.sh' }, { path, now: T0, host: 'mshq', env: { ELANOUS_TRACK: 'tc' } })).toBe(true);
    const a = foldWorld(readResourceLedger(path), T0).actors[0]!;
    expect([a.id, a.registered, a.owner, a.wake]).toEqual(['cron:0123456789ab@mshq', true, 'TC', '*/5 * * * *']);
  });
  test('a launchd job an elanous installer bootstrapped is registered with its plist (so resume can bootstrap it)', () => {
    registerLaunchdQuietly({ label: 'dev.elanous.els', plist: '/U/LaunchAgents/dev.elanous.els.plist', purpose: 'els server', owner: 'TC' }, { path, now: T0, host: 'mshq' });
    const a = foldWorld(readResourceLedger(path), T0).actors[0]!;
    expect([a.id, a.registered, a.meta.plist]).toEqual(['launchd:dev.elanous.els@mshq', true, '/U/LaunchAgents/dev.elanous.els.plist']);
  });
  test('no calling seat → no owner (the ledger flags no-owner rather than guessing)', () => {
    expect(callingSeat({})).toBeNull();
  });
});
