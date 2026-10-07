import { afterEach, expect, spyOn, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { cardIndexPath, taskCardsDir } from '../../task-cards/card-store.js';
import { debug } from '../../debug/log.js';
import { probeBoardWritable, probeDegradation } from './degradation.js';
import { degradationDeps, runOrchestratorNode } from './tick.js';
import { parseOrchestratorLoopConfig } from '../../user-config.js';
import { readdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) { try { chmodSync(join(dir, 'task-cards'), 0o700); } catch { /* not created */ } rmSync(dir, { recursive: true, force: true }); } });
const root = () => { const dir = mkdtempSync(join(tmpdir(), 'orch-degrade-')); scratch.push(dir); return dir; };

test('board probe: a fresh root is writable (the folder is made), an index takes a rolled-back write lock', () => {
  const dir = root();
  expect(probeBoardWritable(dir)).toEqual({ ok: true });
  expect(existsSync(taskCardsDir(dir))).toBe(true);
  const db = new Database(cardIndexPath(dir));
  db.exec('CREATE TABLE t (x INTEGER)');
  db.close();
  expect(probeBoardWritable(dir)).toEqual({ ok: true });
});

test('board probe: an index held by another writer, or a read-only folder, is not writable', () => {
  const dir = root();
  mkdirSync(taskCardsDir(dir), { recursive: true });
  const holder = new Database(cardIndexPath(dir));
  holder.exec('CREATE TABLE t (x INTEGER)');
  holder.exec('BEGIN IMMEDIATE');
  try {
    const held = probeBoardWritable(dir);
    expect(held.ok).toBe(false);
    expect(held.why).toContain('board index write lock');
  } finally { holder.exec('ROLLBACK'); holder.close(); }
  if (process.getuid?.() !== 0) {
    chmodSync(taskCardsDir(dir), 0o500);
    const readOnly = probeBoardWritable(dir);
    expect(readOnly.ok).toBe(false);
    expect(readOnly.why).toContain('board dir not writable');
  }
  // A writable regular file where the folder should be is not a board (review r1).
  const fileRoot = root();
  writeFileSync(taskCardsDir(fileRoot), 'not a dir', { mode: 0o600 });
  expect(probeBoardWritable(fileRoot)).toEqual({ ok: false, why: 'board dir not writable: not a directory' });
});

test('probeDegradation: false only on a measured failure; a throwing LLM check is unknown, not a degradation', () => {
  const dir = root();
  expect(probeDegradation(dir, { usableLlm: () => ({ usable: true, why: 'ok' }), board: () => ({ ok: true }) })).toEqual({ llm: true, board: true, why: [] });
  expect(probeDegradation(dir, { usableLlm: () => ({ usable: false, why: 'no usable LLM route selected' }), board: () => ({ ok: false, why: 'board dir not writable: EACCES' }) }))
    .toEqual({ llm: false, board: false, why: ['llm: no usable LLM route selected', 'board dir not writable: EACCES'] });
  const unknown = probeDegradation(dir, { usableLlm: () => { throw new Error('config unreadable'); }, board: () => ({ ok: true }) });
  expect(unknown.llm).toBe(true);
  expect(unknown.why[0]).toContain('llm unknown');
});

test('degradationDeps: off probes nothing · shadow (default) logs the level and hands nothing · live hands the signal', async () => {
  const events: Array<{ event: string; data: unknown }> = [];
  const spy = spyOn(debug, 'log').mockImplementation((category: string, event: string, data?: unknown) => { if (category === 'loop.orchestrator') events.push({ event, data }); });
  let probes = 0;
  const probe = () => { probes++; return { llm: false, board: true, why: ['llm: no usable LLM route selected'] }; };
  try {
    expect(await degradationDeps('delegate', { config: () => ({ degradationSignal: 'off' }), root: '/nowhere', probe })).toEqual({});
    expect(probes).toBe(0);
    // No setting at all reads as shadow.
    expect(await degradationDeps('delegate', { config: () => undefined, root: '/nowhere', probe })).toEqual({});
    expect(events).toEqual([{ event: 'degradation-signal', data: { node: 'delegate', mode: 'shadow', llm: false, board: true, level: 1, why: ['llm: no usable LLM route selected'] } }]);
    const live = await degradationDeps('delegate', { config: () => ({ degradationSignal: 'live' }), root: '/nowhere', probe });
    expect(live.degradation?.()).toEqual({ llm: false, board: true });
    expect(probes).toBe(2);
  } finally { spy.mockRestore(); }
});

test('a live signal reaches the tick: board not writable → the run records degradation L2 (review r1)', async () => {
  const dir = root();
  const live = await degradationDeps('intake', { config: () => ({ degradationSignal: 'live' }), root: dir, probe: () => ({ llm: true, board: false, why: ['board dir not writable: EACCES'] }) });
  const state = await runOrchestratorNode('intake', { root: dir, runId: 'degrade-live', window: '08', mode: 'shadow', now: new Date('2026-10-04T00:00:00Z'), cards: () => [], ...live });
  expect(state.degradation).toEqual({ level: 2, reason: 'board 불가' });
  const shadow = await degradationDeps('intake', { config: () => undefined, root: dir, probe: () => ({ llm: true, board: false, why: [] }) });
  const quiet = await runOrchestratorNode('intake', { root: dir, runId: 'degrade-shadow', window: '08', mode: 'shadow', now: new Date('2026-10-04T00:00:00Z'), cards: () => [], ...shadow });
  expect(quiet.degradation).toBeUndefined();
});

test('config: loops.orchestrator.degradationSignal parses off|shadow|live and drops anything else; the probe leaves no file', () => {
  for (const mode of ['off', 'shadow', 'live'] as const) expect(parseOrchestratorLoopConfig({ degradationSignal: mode }).degradationSignal).toBe(mode);
  for (const bad of [undefined, 'on', 1, null]) expect(parseOrchestratorLoopConfig({ degradationSignal: bad }).degradationSignal).toBeUndefined();
  const dir = root();
  expect(probeBoardWritable(dir).ok).toBe(true);
  expect(probeBoardWritable(dir).ok).toBe(true);
  expect(readdirSync(taskCardsDir(dir))).toEqual([]);
});
