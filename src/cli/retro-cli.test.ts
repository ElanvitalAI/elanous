import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { debug } from '../debug/log.js';
import { LogStore, registerLogStoreSink } from '../mss/logging/log-store.js';
import { runSelfImplement } from '../self-implement/orchestrator.js';
import { seams } from '../self-implement/test-seams.js';
import { superviseRun } from '../self-dev/run-supervisor.js';
import { collectRetroFacts, parseRetroSince, registerRetroCommands } from './retro-cli.js';

test('retro facts reads the requested event families within the time window without changing the ledger', () => {
  const dir = mkdtempSync(join(tmpdir(), 'retro-facts-'));
  const path = join(dir, 'logs.db');
  try {
    const store = new LogStore(path);
    const now = Date.now();
    store.insertBatch([
      { rec: { ts: new Date(now - 25 * 3600000).toISOString(), category: 'self-implement', event: 'rework-blocked-draft-pr', data: { number: 1 } }, surface: 'test' },
      { rec: { ts: new Date(now - 1000).toISOString(), category: 'self-implement', event: 'rework-blocked-draft-pr', data: { number: 2 } }, surface: 'test' },
      { rec: { ts: new Date(now - 900).toISOString(), category: 'self-implement', event: 'lineage-supersede', data: { closed: [1] } }, surface: 'test' },
      { rec: { ts: new Date(now + 3600000).toISOString(), category: 'self-implement', event: 'rework-blocked-draft-pr', data: { number: 999 } }, surface: 'test' },
      { rec: { ts: new Date(now - 800).toISOString(), category: 'self-dev.supervisor', event: 'resolved', data: { stopReason: 'no-progress' } }, surface: 'test' },
      { rec: { ts: new Date(now - 700).toISOString(), category: 'task-agent', event: 'task-agent.action', data: { taskId: 'task-1', kind: 'review', result: 'done', reason: 'review pass' } }, surface: 'test' },
      { rec: { ts: new Date(now - 650).toISOString(), category: 'task-agent', event: 'task-agent.action', data: { taskId: 'task-2', kind: 'review' } }, surface: 'test' },
      { rec: { ts: new Date(now - 625).toISOString(), category: 'task-agent', event: 'task-agent.action', data: { taskId: 'task-3', result: '  ' } }, surface: 'test' },
      { rec: { ts: new Date(now - 624).toISOString(), category: 'task-agent', event: 'action', data: { taskId: 'cli', kind: 'review', result: 'done', reason: 'review pass' } }, surface: 'test' },
      { rec: { ts: new Date(now - 620).toISOString(), category: 'unrelated', event: 'rework-blocked-draft-pr', data: { number: 99 } }, surface: 'test' },
      { rec: { ts: new Date(now - 600).toISOString(), category: 'self-implement', event: 'lineage-supersede', data: { closed: [] } }, surface: 'test' },
      { rec: { ts: new Date(now - 500).toISOString(), category: 'self-implement', event: 'run-rollup', data: { stage: 'merged', runStatus: 'merged' } }, surface: 'test' },
      { rec: { ts: new Date(now - 450).toISOString(), category: 'self-implement', event: 'run-rollup', data: { stage: 'gate-failed', runStatus: 'failed', failureKind: 'gate' } }, surface: 'test' },
      { rec: { ts: new Date(now - 400).toISOString(), category: 'self-implement', event: 'pr-opened', data: { number: 3, autoMerge: false } }, surface: 'test' },
      { rec: { ts: new Date(now - 350).toISOString(), category: 'self-implement', event: 'rework-blocked-draft-pr', data: { number: 4, error: 'create failed' } }, surface: 'test' },
      { rec: { ts: new Date(now - 300).toISOString(), category: 'self-dev.supervisor', event: 'decision', data: { action: 'stop', stopReason: 'provider-exhausted' } }, surface: 'test' },
      { rec: { ts: new Date(now - 250).toISOString(), category: 'self-dev.supervisor', event: 'decision', data: { action: 'relaunch', stopReason: 'retry' } }, surface: 'test' },
    ]);
    store.close();
    expect(parseRetroSince('24h', now)).toBe(now - 86400000);
    expect(() => parseRetroSince('0h', now)).toThrow('--since');
    const result = collectRetroFacts(parseRetroSince('24h', now), [{ name: 'fixture', dbPath: path }]);
    expect(result.unavailable).toEqual([]);
    expect(collectRetroFacts(parseRetroSince('24h', now), [{ name: 'missing', dbPath: join(dir, 'missing.db') }])).toEqual({ facts: [], unavailable: ['missing'] });
    expect(result.facts.map(f => f.kind)).toEqual(['stop-reason', 'ta-outcome', 'ta-outcome', 'stop-reason', 'draft-death', 'draft-birth']);
    expect(result.facts.at(-1)?.data).toEqual({ number: 2 });
    expect(result.facts.find(f => f.event === 'decision')?.data).toEqual({ action: 'stop', stopReason: 'provider-exhausted' });
    expect(result.facts.filter(f => f.kind === 'ta-outcome').map(f => f.data)).toEqual([
      { taskId: 'cli', kind: 'review', result: 'done', reason: 'review pass' },
      { taskId: 'task-1', kind: 'review', result: 'done', reason: 'review pass' },
    ]);
    // A plain (non-draft) PR open is not a draft birth.
    expect(result.facts.some(f => f.event === 'pr-opened')).toBe(false);
    expect(JSON.parse(JSON.stringify(result)).facts).toHaveLength(6);
    const unchanged = LogStore.openReadOnly(path);
    try { expect(unchanged.query({ sinceMs: now - 26 * 3600000, limit: 100 })).toHaveLength(17); }
    finally { unchanged.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('recorded events reach the installed CLI facts JSON', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'retro-cli-recorded-'));
  const stateDir = join(dir, '.elanous-test');
  const previous = process.env.ELANOUS_STATE_DIR;
  try {
    process.env.ELANOUS_STATE_DIR = stateDir;
    const nodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    const unregister = registerLogStoreSink(debug.registerSink.bind(debug), 'cli');
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
    expect(unregister).not.toBeNull();
    try {
      const draft = await runSelfImplement({
        feature: 'retro draft birth', maxReworkRounds: 0,
        seams: seams({
          gate: async () => ({ passed: false, log: 'gate failed' }),
          preservationHasChanges: () => true,
          persistPrBodyArtifact: () => ({ path: join(dir, 'draft-body.md') }),
          openPr: async () => ({ url: 'https://pr/4201', number: 4201 }),
        }),
      });
      expect(draft.abandonedClassification?.classification).toBe('implementation-deficit');
      debug.flush();
      const recorded = LogStore.openReadOnly(join(stateDir, 'logs', 'logs.db'));
      const birth = recorded.query({ sinceMs: Date.now() - 60_000, limit: 100 })
        .find(row => row.event === 'rework-blocked-draft-pr');
      recorded.close();
      expect(birth).toBeDefined();
      const priorDraftRunId = JSON.parse(birth!.data ?? '{}').runId as string;
      const goalFile = join(dir, 'retro-goal.md');
      writeFileSync(goalFile, `# Retro draft lineage\n- AskFile: docs/retro-test-ask.md\n\nretro draft lineage`);
      const closed: number[] = [];
      const merged = await runSelfImplement({
        feature: 'retro draft death', autoMerge: true, goalFile: join(dir, 'retro-goal.md'),
        seams: seams({
          reviewDiff: async () => ({ verdict: 'pass', mustFix: [], shouldFix: [], summary: 'review', reviewed: true, diffTruncated: false, diffShownChars: 100, diffTotalChars: 100, diffOmittedFiles: 0 }),
          openPr: async () => ({ url: 'https://pr/4202', number: 4202 }),
          mergePr: async () => ({ merged: true }),
          lineageSupersede: {
            listOpenDrafts: () => [{ number: 4201, runId: priorDraftRunId, openedAt: new Date(Date.now() - 1000).toISOString() }],
            readRunLedger: () => [{ runId: priorDraftRunId, event: 'pr-opened', data: { askFile: 'docs/retro-test-ask.md' } }],
            closeDraft: ({ number }) => { closed.push(number); },
          },
        }),
      });
      expect(merged.stage).toBe('merged');
      expect(closed).toEqual([4201]);
      await superviseRun({
        initial: [], rerun: async () => [], sweepPendingMerges: async () => ({ pending: 0, merged: 0 }),
        observe: (event, data) => debug.log('self-dev.supervisor', event, data),
        taskAgentShadow: false,
      });
    } finally {
      unregister?.();
    }
    const action = { taskId: 'retro-cli-ta', kind: 'review', rationale: 'review passed', pr: 4201, runId: 'retro-run', original: 'review', checklistId: 'retro-check' };
    const ta = Bun.spawnSync([process.execPath, 'bin/elanous.mjs', '--test-state-dir', stateDir, 'autopilot', 'task-agent-action', JSON.stringify(action)], {
      cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'development', ELANOUS_STATE_DIR: stateDir }, stdout: 'pipe', stderr: 'pipe',
    });
    expect(ta.exitCode).toBe(0);
    expect(new TextDecoder().decode(ta.stdout)).toContain('shadow');
    const run = Bun.spawnSync([process.execPath, 'bin/elanous.mjs', '--test-state-dir', stateDir, 'retro', 'facts', '--since', '24h', '--json'], {
      cwd: process.cwd(), env: { ...process.env, ELANOUS_STATE_DIR: stateDir }, stdout: 'pipe', stderr: 'pipe',
    });
    expect(new TextDecoder().decode(run.stderr)).not.toContain('error:');
    expect(run.exitCode).toBe(0);
    const output = JSON.parse(new TextDecoder().decode(run.stdout));
    expect(output.facts.length).toBeGreaterThan(0);
    // The merged (non-draft) PR 4202 is not a draft birth; only the rework-blocked draft 4201 is.
    expect(output.facts.filter((fact: { kind: string }) => fact.kind === 'draft-birth')).toHaveLength(1);
    expect(output.facts.some((fact: { event: string }) => fact.event === 'pr-opened')).toBe(false);
    expect(output.facts.filter((fact: { kind: string }) => fact.kind === 'ta-outcome')).toHaveLength(1);
    expect(output.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'draft-birth', event: 'rework-blocked-draft-pr', data: expect.objectContaining({ number: 4201 }) }),
      expect.objectContaining({ kind: 'draft-death', event: 'lineage-supersede', data: expect.objectContaining({ closed: [4201] }) }),
      expect.objectContaining({ kind: 'stop-reason', event: 'decision', data: expect.objectContaining({ stopReason: 'converged', action: 'stop' }) }),
      expect.objectContaining({ kind: 'ta-outcome', event: 'action', data: expect.objectContaining({ taskId: 'retro-cli-ta', result: 'shadow' }) }),
    ]));
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
  // Two real CLI spawns (task-agent-action, then retro facts): a cold `bin/elanous.mjs` boot takes several seconds in a
  // gate Pod, so bun's 5 s default timed this out (0.2.20 gate «introduced 1» · 10-08 08:1x). Same budget class as the
  // other real-spawn tests.
}, 120_000);

test('retro facts command is registered and produces JSON', async () => {
  const command = new Command();
  registerRetroCommands(command);
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: string) => { lines.push(line); };
  try { await command.parseAsync(['retro', 'facts', '--since', '24h', '--json'], { from: 'user' }); }
  finally { console.log = original; }
  const parsed = JSON.parse(lines[0]!);
  expect(parsed).toHaveProperty('facts');
  expect(parsed).toHaveProperty('since');
  expect(Array.isArray(parsed.unavailable)).toBe(true);
});
