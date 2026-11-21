import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { WORKER_STATES, WORKER_TERMINAL_STATES } from '../worker/contract.js';
import { createMissionOutStore, registerMissionOutCommand, type MissionOutStatus } from './mission-out.js';
import {
  agentMissionResultWorkerView, isMissionWorkerTerminal, MISSION_CANONICAL_NAME, MISSION_OUT_WORKER_STATE,
  missionOutPublicStatus, missionOutWorkerView, resolveMissionName,
} from './mission-name.js';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const makeRoot = (): string => { const r = mkdtempSync(join(tmpdir(), 'mission-name-')); roots.push(r); return r; };

test('name round trip: canonical, legacy alias and eln mission door all resolve to agent-mission', () => {
  expect(resolveMissionName('agent-mission')).toEqual({ ok: true, canonical: 'agent-mission', surface: 'pty', deprecated: false });
  expect(resolveMissionName(' Codex ')).toEqual({ ok: true, canonical: MISSION_CANONICAL_NAME, surface: 'pty', deprecated: true });
  expect(resolveMissionName('mission')).toEqual({ ok: true, canonical: MISSION_CANONICAL_NAME, surface: 'process', deprecated: false });
});

test('foreign, empty and prototype names are refused with a reason', () => {
  for (const bad of ['', '  ', 'harness', 'constructor', '__proto__', 'toString']) {
    const r = resolveMissionName(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBeTruthy();
  }
});

test('lifecycle parity: every mission-out status maps to a contract state; terminal iff terminal', () => {
  const statuses: MissionOutStatus[] = ['running', 'completed', 'cancelled', 'failed', 'timeout'];
  expect(Object.keys(MISSION_OUT_WORKER_STATE).sort()).toEqual([...statuses].sort());
  for (const s of statuses) {
    const v = missionOutWorkerView(s);
    expect(WORKER_STATES).toContain(v.state);
    expect(isMissionWorkerTerminal(v.state)).toBe(s !== 'running');
    // 실패 계열은 사유 필수(WORKER-CONTRACT §2)
    if (v.state === 'failed') expect(v.reason).toBeTruthy();
  }
  expect(WORKER_TERMINAL_STATES).toEqual(['done', 'failed']);
  expect(missionOutPublicStatus('completed')).toBe('done');
  expect(missionOutPublicStatus('timeout')).toBe('timeout');
});

test('agent-mission PTY result maps onto the same states', () => {
  expect(agentMissionResultWorkerView({ ok: true })).toEqual({ state: 'done' });
  expect(agentMissionResultWorkerView({ ok: false, reason: 'aborted' })).toEqual({ state: 'failed', reason: 'aborted' });
  expect(agentMissionResultWorkerView({ ok: false })).toEqual({ state: 'failed', reason: 'not-ok' });
});

test('test-universe scenario: status/cancel JSON carries workerState; second cancel is refused as non-transition', async () => {
  const root = makeRoot();
  const store = createMissionOutStore(root);
  const rec = store.create({ agent: 'codex', prompt: 'p', cwd: '/repo', outputPath: '/tmp/o.tmp', targetOutputPath: '/tmp/o.md' });
  const lines: string[] = [];
  const run = async (...args: string[]) => {
    const program = new Command();
    program.exitOverride();
    registerMissionOutCommand(program, { stateRoot: () => root, write: (s: string) => { lines.push(s); } });
    await program.parseAsync(['node', 'eln', 'mission', ...args, '--json']);
  };
  await run('status', rec.missionId);
  expect(JSON.parse(lines.at(-1)!)).toMatchObject({ status: 'running', workerState: { state: 'working' } });
  await run('cancel', rec.missionId);
  expect(JSON.parse(lines.at(-1)!)).toMatchObject({ status: 'cancelled', cancelled: true, workerState: { state: 'failed', reason: 'cancelled' } });
  const again = await store.cancel(rec.missionId);
  expect(again.transitioned).toBe(false);
  await run('status', rec.missionId);
  expect(JSON.parse(lines.at(-1)!)).toMatchObject({ status: 'cancelled', workerState: { state: 'failed', reason: 'cancelled' } });
});
