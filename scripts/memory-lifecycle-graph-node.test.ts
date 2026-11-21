import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPhase, verifyEffect } from './memory-lifecycle-graph-node.js';

const valid = { replayStrengthened: 0, decayChanged: 1, hot: 2, warm: 3, cold: 4,
  consolidated: 5, archived: 6, prunedEvents: 7, promotionCandidates: null, errors: 0 };

describe('memory lifecycle graph nodes', () => {
  test('phase source is isolated and missing means unknown', () => {
    const root = mkdtempSync(join(tmpdir(), 'memory-phase-'));
    expect(readPhase(root)).toBe('unknown');
    const path = join(root, 'elanous-hq/seat-state/OP/PHASE.json');
    mkdirSync(join(root, 'elanous-hq/seat-state/OP'), { recursive: true });
    for (const phase of ['land-flood', 'dev-normal', 'hard-rehearsal', 'gate-window', 'publish']) {
      writeFileSync(path, JSON.stringify({ phase }));
      expect(readPhase(root)).toBe(phase);
    }
    writeFileSync(path, '{');
    expect(readPhase(root)).toBe('unknown');
    writeFileSync(path, JSON.stringify({ phase: 'typo' }));
    expect(readPhase(root)).toBe('unknown');
  });
  test('effect requires every measured count, preserves null unknown and rejects malformed counts', () => {
    expect(verifyEffect(valid)).toEqual(valid);
    expect(() => verifyEffect({ ...valid, cold: undefined })).toThrow();
    expect(() => verifyEffect({ ...valid, hot: -1 })).toThrow();
    expect(() => verifyEffect({ ...valid, archived: 0.5 })).toThrow();
    expect(() => verifyEffect(null)).toThrow();
  });
});

test('isolated real guard and record: deny only two, unknown proceeds and is logged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lifecycle-guard-'));
  const state = join(dir, 'state');
  const home = join(dir, 'home');
  const phaseFile = join(state, 'elanous-hq/seat-state/OP/PHASE.json');
  mkdirSync(join(state, 'elanous-hq/seat-state/OP'), { recursive: true });
  mkdirSync(home, { recursive: true });
  const contextFile = join(dir, 'context.json');
  const env = { ...process.env, HOME: home, ELANOUS_STATE_DIR: state, ELANOUS_GRAPH_CONTEXT: contextFile };
  delete env.NODE_ENV;
  const run = (node: string, outputs: Record<string, unknown> = {}) => {
    writeFileSync(contextFile, JSON.stringify({ graphId: 'memory-lifecycle', runId: 'test-run', nodeId: node, outputs }));
    const result = spawnSync(process.execPath, [join(import.meta.dir, 'memory-lifecycle-graph-node.ts'), node], { env, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    return { ...result, output: JSON.parse(result.stdout.trim().split('\n').at(-1)!) };
  };
  for (const [phase, outcome] of [['hard-rehearsal', 'skipped'], ['gate-window', 'skipped'], ['publish', 'ok'], ['land-flood', 'ok']]) {
    writeFileSync(phaseFile, JSON.stringify({ phase }));
    expect(run('phase-guard').output).toEqual({ outcome, phase });
  }
  writeFileSync(phaseFile, '{broken');
  const guard = run('phase-guard');
  expect(guard.stderr).toContain('warning: phase unknown');
  expect(guard.output).toEqual({ outcome: 'ok', phase: 'unknown' });
  const effect = { replayStrengthened: 1, decayChanged: 2, hot: 3, warm: 4, cold: 5, consolidated: 6, archived: 7, prunedEvents: 8, promotionCandidates: null, errors: 0 };
  const verified = run('verify-effect', { run: effect }).output;
  expect(verified.effect).toEqual(effect);
  run('record', { 'phase-guard': guard.output, 'verify-effect': verified });
  const db = new Database(join(state, 'logs/logs.db'), { readonly: true });
  try {
    const rows = db.query("SELECT event, data FROM logs WHERE category = 'memory.lifecycle' ORDER BY id").all() as Array<{ event: string; data: string }>;
    expect(rows.map(row => row.event)).toEqual(['skipped', 'skipped', 'graph-cycle']);
    expect(JSON.parse(rows[2]!.data)).toMatchObject({ phase: 'unknown', replayStrengthened: 1, promotionCandidates: null });
  } finally { db.close(); }
});

test('installed graph executes real lifecycle or skips denied phases in an isolated instance', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lifecycle-graph-e2e-'));
  const state = join(dir, 'state');
  const home = join(dir, 'home');
  const phaseDir = join(state, 'elanous-hq/seat-state/OP');
  mkdirSync(phaseDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  const root = join(import.meta.dir, '..');
  const env = { ...process.env, HOME: home, ELANOUS_STATE_DIR: state };
  delete env.NODE_ENV;
  const script = `import { runGraph } from './src/graph-runner/runner.ts';
    const result = await runGraph('./graphs/memory/memory-lifecycle.yaml', { deps: { root: process.env.ELANOUS_STATE_DIR } });
    console.log(JSON.stringify({status: result.status, path: result.path}));`;
  for (const phase of ['hard-rehearsal', 'gate-window', 'publish', 'unknown']) {
    writeFileSync(join(phaseDir, 'PHASE.json'), phase === 'unknown' ? '{broken' : JSON.stringify({ phase }));
    // 출처: #39360 — the 120s overall test budget divided among four sequential phases.
    const child = spawnSync(process.execPath, ['-e', script], { cwd: root, env, encoding: 'utf8', timeout: 30000 });
    expect(child.status, child.stderr).toBe(0);
    const output = JSON.parse(child.stdout.trim().split('\n').at(-1)!);
    expect(output.status).toBe('done');
    expect(output.path).toEqual(['hard-rehearsal', 'gate-window'].includes(phase)
      ? ['phase-guard', 'done'] : ['phase-guard', 'run', 'verify-effect', 'record', 'done']);
  }
  const db = new Database(join(state, 'logs/logs.db'), { readonly: true });
  try {
    const rows = db.query("SELECT event, data FROM logs WHERE category = 'memory.lifecycle' AND event IN ('skipped', 'graph-cycle') ORDER BY id").all() as Array<{ event: string; data: string }>;
    expect(rows.map(row => row.event)).toEqual(['skipped', 'skipped', 'graph-cycle', 'graph-cycle']);
    expect(rows.map(row => JSON.parse(row.data).phase)).toEqual(['hard-rehearsal', 'gate-window', 'publish', 'unknown']);
    expect(JSON.parse(rows[3]!.data)).toHaveProperty('replayStrengthened');
  } finally { db.close(); }
}, 120000);
