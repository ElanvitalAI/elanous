import { test, expect, describe, spyOn, beforeEach, afterEach } from 'bun:test';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { debug } from '../debug/log.js';
import { failureReason } from '../domains/repeated-failure.js';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addSelfDevRunParticipant, checkpointDependenciesForRun, closeSelfDevRunParticipant, saveSelfDevRun, loadSelfDevRun, listSelfDevRuns, listParkedGoals, listCombinedParkedGoals, parkedGoalsPopulationNotice, scanParkedGoals, countRunningGoals, countUnconvergeableRunLedgers, recordSelfDevRunSupervisorStop, resolveParkedSelfDevRun, failureClassificationForInterruptionVerdict, extractParkedGoalLedgerArtifactEvidence, PARKED_GOALS_LEDGER_STATUS, PARKED_GOALS_LIMITATION, type SelfDevRunState } from './run-store.js';
import { analyzeRepairSignals, CLASSIFICATION_HINTS } from './repair-signals.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'self-dev-runs-'));
}

let mirrorLedgerRoot: string;
beforeEach(() => {
  mirrorLedgerRoot = tmp();
  setElanousConfigDir(mirrorLedgerRoot);
});
afterEach(() => {
  resetElanousConfigDir();
  rmSync(mirrorLedgerRoot, { recursive: true, force: true });
});

const run = (id: string, updatedAt: number): SelfDevRunState => ({
  runId: id,
  createdAt: 1,
  updatedAt,
  results: [{ taskId: 't1', feature: 'A', status: 'done', prUrl: 'https://x/1' }],
});

describe('self-dev run-store (S3 persistence)', () => {
  test('save → load round-trip', () => {
    const dir = tmp();
    saveSelfDevRun(run('run-1', 100), dir);
    const loaded = loadSelfDevRun('run-1', dir);
    expect(loaded?.runId).toBe('run-1');
    expect(loaded?.results[0]).toMatchObject({ feature: 'A', status: 'done', prUrl: 'https://x/1' });
  });

  test('missing checkpoint is null and logs a non-failure event only once per run ID', () => {
    const dir = tmp();
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      expect(loadSelfDevRun('absent-checkpoint-ops-h1', dir)).toBeNull();
      expect(loadSelfDevRun('absent-checkpoint-ops-h1', dir)).toBeNull();
      const events = log.mock.calls.filter(([category]) => category === 'self-dev.run-store');
      expect(events.filter(([, event]) => event === 'read-failed')).toHaveLength(0);
      expect(events.filter(([, event]) => event === 'checkpoint-absent')).toEqual([
        ['self-dev.run-store', 'checkpoint-absent', { runId: 'absent-checkpoint-ops-h1' }],
      ]);
      expect(failureReason({ category: 'self-dev.run-store', event: 'checkpoint-absent', data: '{"runId":"r"}' })).toBeNull();
    } finally {
      log.mockRestore();
    }
  });

  test('corrupt JSON, invalid shape, and non-ENOENT read errors remain read-failed and null', () => {
    const dir = tmp();
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      writeFileSync(join(dir, 'broken.json'), '{not-json', 'utf8');
      expect(loadSelfDevRun('broken', dir)).toBeNull();
      writeFileSync(join(dir, 'shape.json'), JSON.stringify({ runId: 'x' }), 'utf8');
      expect(loadSelfDevRun('shape', dir)).toBeNull();
      mkdirSync(join(dir, 'not-a-file.json'));
      expect(loadSelfDevRun('not-a-file', dir)).toBeNull();
      const failures = log.mock.calls.filter(([category, event]) => category === 'self-dev.run-store' && event === 'read-failed');
      expect(failures).toHaveLength(3);
      expect(failures[0]?.[2]).toMatchObject({ runId: 'broken', reason: expect.stringContaining('SyntaxError') });
      expect(failures[1]?.[2]).toEqual({ runId: 'shape', reason: 'invalid checkpoint shape' });
      expect(failures[2]?.[2]).toMatchObject({ runId: 'not-a-file', reason: expect.stringContaining('EISDIR') });
    } finally {
      log.mockRestore();
    }
  });

  test('two real children exchange 200 large checkpoints without observing a partial JSON', async () => {
    const dir = tmp();
    const runId = 'concurrent-checkpoint';
    const count = 200;
    const payload = 'x'.repeat(1024 * 1024 + 1);
    saveSelfDevRun({
      runId, createdAt: 1, updatedAt: 0,
      results: [{ taskId: 't1', feature: 'A', status: 'done', screenTail: payload }],
    }, dir);
    const storeUrl = new URL('./run-store.ts', import.meta.url).href;
    const setup = `
      import { existsSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { loadSelfDevRun, saveSelfDevRun } from ${JSON.stringify(storeUrl)};
      const [dir, runId, countText] = process.argv.slice(1);
      const count = Number(countText);
      const waitFor = async (path) => {
        const deadline = Date.now() + 10000;
        while (!existsSync(path)) {
          if (existsSync(join(dir, 'reader-failed'))) throw new Error('reader reported a partial checkpoint');
          if (Date.now() > deadline) throw new Error('checkpoint exchange timed out: ' + path);
          await new Promise(resolve => setTimeout(resolve, 1));
        }
      };
    `;
    const writer = Bun.spawn({
      cmd: [process.execPath, '-e', `${setup}
        const payload = 'x'.repeat(1024 * 1024 + 1);
        for (let i = 1; i <= count; i++) {
          await waitFor(join(dir, 'ack-' + (i - 1)));
          saveSelfDevRun({ runId, createdAt: 1, updatedAt: i,
            results: [{ taskId: 't1', feature: 'A', status: 'done', screenTail: payload }] }, dir);
        }
      `, dir, runId, String(count)],
      stdout: 'pipe', stderr: 'pipe', env: { ...process.env, HOME: mirrorLedgerRoot },
    });
    const reader = Bun.spawn({
      cmd: [process.execPath, '-e', `${setup}
        writeFileSync(join(dir, 'ack-0'), 'ready');
        let reads = 0;
        try {
          for (let i = 1; i <= count; i++) {
            let state;
            do {
              state = loadSelfDevRun(runId, dir);
              reads++;
              if (!state) throw new Error('null checkpoint at iteration ' + i + ' read ' + reads);
              if (state.results[0]?.screenTail?.length !== 1024 * 1024 + 1)
                throw new Error('partial checkpoint at iteration ' + i);
              if (state.updatedAt < i) await new Promise(resolve => setTimeout(resolve, 0));
            } while (state.updatedAt < i);
            writeFileSync(join(dir, 'ack-' + i), 'read');
          }
          console.log('200 intact checkpoints; reads=' + reads);
        } catch (error) {
          writeFileSync(join(dir, 'reader-failed'), String(error));
          throw error;
        }
      `, dir, runId, String(count)],
      stdout: 'pipe', stderr: 'pipe', env: { ...process.env, HOME: mirrorLedgerRoot },
    });
    try {
      const [writerCode, readerCode] = await Promise.all([writer.exited, reader.exited]);
      const writerError = await new Response(writer.stderr).text();
      const readerError = await new Response(reader.stderr).text();
      expect(readerError).toBe('');
      expect(readerCode).toBe(0);
      expect(writerError).toBe('');
      expect(writerCode).toBe(0);
      expect(await new Response(reader.stdout).text()).toContain('200 intact checkpoints; reads=');
      expect(loadSelfDevRun(runId, dir)?.updatedAt).toBe(count);
      expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      writer.kill();
      reader.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  test('new-run checkpoint maps goal IDs to predecessor IDs and explicit no-dependency shards', () => {
    expect(checkpointDependenciesForRun(null, [
      { feature: 'prepare', id: 'prepare' },
      { feature: 'implement', id: 'implement', dependsOn: ['prepare'] },
      { feature: 'verify', id: 'verify', dependsOn: ['prepare', 'implement'] },
    ])).toEqual({
      prepare: [],
      implement: ['prepare'],
      verify: ['prepare', 'implement'],
    });
  });

  test('checkpoint preserves predecessor dependencies and explicit no-dependency shards', () => {
    const dir = tmp();
    const state: SelfDevRunState = {
      ...run('run-dependencies', 100),
      dependencies: {
        prepare: [],
        implement: ['prepare'],
        verify: ['prepare', 'implement'],
      },
    };

    saveSelfDevRun(state, dir);

    const loaded = loadSelfDevRun('run-dependencies', dir);
    expect(loaded).toEqual(state);
    expect(JSON.parse(readFileSync(join(dir, 'run-dependencies.json'), 'utf8')).dependencies).toEqual({
      prepare: [],
      implement: ['prepare'],
      verify: ['prepare', 'implement'],
    });
  });

  test('legacy checkpoint without dependencies remains distinct from explicit no-dependency shards', () => {
    const dir = tmp();
    const legacy = run('legacy-no-dependencies', 100);
    writeFileSync(join(dir, 'legacy-no-dependencies.json'), JSON.stringify(legacy), 'utf8');

    const loaded = loadSelfDevRun('legacy-no-dependencies', dir);
    expect(loaded?.dependencies).toBeUndefined();
    expect(loaded?.dependencies).not.toEqual({ prepare: [] });
    expect(loaded?.results).toEqual(legacy.results);
  });

  test('actual self orchestrate --resume checkpoint preserves legacy absence, explicit empty predecessors, and predecessor IDs', () => {
    const stateDir = tmp();
    const dir = join(stateDir, 'self-dev-runs');
    const doneNoop = [{ taskId: 'noop-task', feature: 'noop', status: 'done' }] as SelfDevRunState['results'];
    const states: SelfDevRunState[] = [
      { ...run('resume-legacy', 100), results: doneNoop },
      { ...run('resume-empty', 100), results: doneNoop, dependencies: { prepare: [], implement: [] } },
      { ...run('resume-predecessor', 100), results: doneNoop, dependencies: { prepare: [], implement: ['prepare'] } },
    ];

    for (const state of states) saveSelfDevRun(state, dir);
    for (const state of states) {
      const resumed = Bun.spawnSync({
        cmd: [process.execPath, 'src/index.ts', 'self', 'orchestrate', 'noop', '--resume', state.runId, '--json'],
        cwd: process.cwd(),
        env: { ...process.env, HOME: mirrorLedgerRoot, ELANOUS_STATE_DIR: stateDir },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(resumed.exitCode).toBe(0);
    }

    expect(loadSelfDevRun('resume-legacy', dir)?.dependencies).toBeUndefined();
    expect(loadSelfDevRun('resume-empty', dir)?.dependencies).toEqual({ prepare: [], implement: [] });
    expect(loadSelfDevRun('resume-predecessor', dir)?.dependencies).toEqual({ prepare: [], implement: ['prepare'] });
    expect(loadSelfDevRun('resume-predecessor', dir)?.results).toMatchObject(doneNoop);
  }, 15_000);

  test('supervisor stop reason persists as a closed, distinct checkpoint field', () => {
    const dir = tmp();
    saveSelfDevRun(run('supervisor-stop', 100), dir);

    expect(recordSelfDevRunSupervisorStop('supervisor-stop', 'needs-human', dir)).toEqual({ outcome: 'persisted' });

    expect(loadSelfDevRun('supervisor-stop', dir)).toMatchObject({ supervisorStopReason: 'needs-human' });
    expect(JSON.parse(readFileSync(join(dir, 'supervisor-stop.json'), 'utf8')).supervisorStopReason).toBe('needs-human');
  });

  test('supervisor stop persistence reports a missing directory and record without creating either', () => {
    const missingDir = join(tmp(), 'missing');
    expect(recordSelfDevRunSupervisorStop('missing-dir', 'needs-human', missingDir)).toEqual({ outcome: 'missing-directory' });
    expect(existsSync(missingDir)).toBe(false);

    const dir = tmp();
    expect(recordSelfDevRunSupervisorStop('missing-record', 'needs-human', dir)).toEqual({ outcome: 'missing-record' });
    expect(existsSync(join(dir, 'missing-record.json'))).toBe(false);
  });


  test('load missing → null', () => {
    expect(loadSelfDevRun('nope', tmp())).toBeNull();
  });

  test('list returns runs newest-first', () => {
    const dir = tmp();
    saveSelfDevRun(run('old', 100), dir);
    saveSelfDevRun(run('new', 200), dir);
    const runs = listSelfDevRuns(dir);
    expect(runs.map((r) => r.runId)).toEqual(['new', 'old']);
  });

  test('save is fail-soft on a bad dir (never throws)', () => {
    expect(() => saveSelfDevRun(run('x', 1), '/proc/nonexistent/cannot/write')).not.toThrow();
  });

  test('failed replacement removes its temporary file without changing the target', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'unreplaceable.json'));
    saveSelfDevRun(run('unreplaceable', 100), dir);
    expect(readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([]);
    expect(existsSync(join(dir, 'unreplaceable.json'))).toBeTrue();
  });

  test('participant registrations preserve earlier participants for the same run', () => {
    const dir = tmp();
    saveSelfDevRun(run('run-participants', 100), dir);
    expect(loadSelfDevRun('run-participants', dir)?.participants).toBeUndefined();

    addSelfDevRunParticipant('run-participants', {
      id: 'agent-1', kind: 'agent', transports: [{ kind: 'acp', id: 'acp-1' }], registeredAt: 10, runIdSource: 'explicit',
    }, dir);
    addSelfDevRunParticipant('run-participants', {
      id: 'pty-1', kind: 'pty', transports: [{ kind: 'pty', id: 'pty-1' }], registeredAt: 20, runIdSource: 'inherited',
    }, dir);

    const participants = loadSelfDevRun('run-participants', dir)?.participants;
    expect(participants).toHaveLength(2);
    expect(participants).toEqual([
      { id: 'agent-1', kind: 'agent', transports: [{ kind: 'acp', id: 'acp-1' }], registeredAt: 10, runIdSource: 'explicit' },
      { id: 'pty-1', kind: 'pty', transports: [{ kind: 'pty', id: 'pty-1' }], registeredAt: 20, runIdSource: 'inherited' },
    ]);
  });

  test('closing a participant preserves its first terminal declaration and ignores absent entries', () => {
    const dir = tmp();
    saveSelfDevRun(run('run-close-participant', 100), dir);
    addSelfDevRunParticipant('run-close-participant', {
      id: 'pty-1', kind: 'pty', transports: [{ kind: 'pty', id: 'pty-1' }], registeredAt: 10, runIdSource: 'inherited',
    }, dir);

    closeSelfDevRunParticipant('run-close-participant', 'pty-1', 'self', dir);
    const first = loadSelfDevRun('run-close-participant', dir)?.participants?.[0];
    expect(first).toMatchObject({ id: 'pty-1', closedBy: 'self' });
    expect(typeof first?.closedAt).toBe('number');

    closeSelfDevRunParticipant('run-close-participant', 'pty-1', 'parent', dir);
    closeSelfDevRunParticipant('run-close-participant', 'absent', 'parent', dir);
    expect(loadSelfDevRun('run-close-participant', dir)?.participants).toEqual([
      expect.objectContaining({ id: 'pty-1', closedAt: first?.closedAt, closedBy: 'self' }),
    ]);
    expect(() => closeSelfDevRunParticipant('absent-run', 'pty-1', 'parent', dir)).not.toThrow();
  });

  test('checkpoint save preserves participant registered between stale checkpoints', () => {
    const dir = tmp();
    const stale = run('run-save-race', 100);
    saveSelfDevRun(stale, dir);
    addSelfDevRunParticipant('run-save-race', {
      id: 'process-1', kind: 'process', transports: [{ kind: 'rpc', id: 'task-orchestrator' }], registeredAt: 10, runIdSource: 'minted',
    }, dir);

    saveSelfDevRun({ ...stale, updatedAt: 200, results: [] }, dir);

    expect(loadSelfDevRun('run-save-race', dir)).toMatchObject({
      updatedAt: 200,
      results: [],
      participants: [{ id: 'process-1', kind: 'process', transports: [{ kind: 'rpc', id: 'task-orchestrator' }], registeredAt: 10, runIdSource: 'minted' }],
    });
  });
});

describe('self-implement UNCONVERGEABLE ledger summary', () => {
  const ledgerRunId = (suffix: string): string => `run-00000000-0000-0000-0000-${suffix.padStart(12, '0')}`;
  const writeLedger = (dir: string, runId: string, entries: unknown[]): void => {
    writeFileSync(join(dir, `${runId}.jsonl`), `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
  };
  const entry = (runId: string, verdict: string) => ({ event: 'rework-budget', runId, data: { verdict } });

  test('각 런의 마지막 rework-budget 판정만 세고 여러 런을 합산한다', () => {
    const dir = tmp();
    const first = ledgerRunId('1');
    const second = ledgerRunId('2');
    const reverted = ledgerRunId('3');
    const other = ledgerRunId('4');
    writeLedger(dir, first, [entry(first, 'CONVERGEABLE'), entry(first, 'UNCONVERGEABLE')]);
    writeLedger(dir, second, [entry(second, 'CONVERGEABLE'), entry(second, 'UNCONVERGEABLE')]);
    writeLedger(dir, reverted, [entry(reverted, 'UNCONVERGEABLE'), entry(reverted, 'CONVERGEABLE')]);
    writeLedger(dir, other, [{ event: 'start', runId: other, data: {} }]);

    const summary = countUnconvergeableRunLedgers(dir);
    expect(summary).toEqual({ status: 'ok', count: 2, runIds: [first, second] });
    if (summary.status !== 'ok') throw new Error('expected readable ledger summary');
    expect(summary.count).toBe(summary.runIds.length);
    expect(summary.runIds).not.toContain(reverted);
    expect(summary.runIds).not.toContain(other);
  });

  test('없는 원장 디렉터리는 측정된 0건이고 못 읽는 디렉터리와 손상된 원장은 분리한다', () => {
    expect(countUnconvergeableRunLedgers(join(tmp(), 'absent'))).toEqual({ status: 'ok', count: 0, runIds: [] });
    const unreadablePath = join(tmp(), 'not-a-directory');
    writeFileSync(unreadablePath, '', 'utf8');
    expect(countUnconvergeableRunLedgers(unreadablePath)).toEqual({ status: 'unreadable', runIds: [] });
    const dir = tmp();
    writeFileSync(join(dir, `${ledgerRunId('4')}.jsonl`), '{not json}\n', 'utf8');
    expect(countUnconvergeableRunLedgers(dir)).toEqual({ status: 'unreadable', runIds: [] });
  });

  test('원장 기준 draft PR 관찰과 현재 열림 확인 명령, 수렴 불가 런 식별자를 각각 고지한다', () => {
    const runIds = [ledgerRunId('1'), ledgerRunId('2')];
    const notice = parkedGoalsPopulationNotice({ status: 'ok', count: 2, runIds });

    expect(notice).toContain('self-implement 원장 기준');
    expect(notice).toContain(runIds[0]);
    expect(notice).toContain(runIds[1]);
    expect(notice).toContain('이 런들이 열어 둔 draft PR');
    expect(notice).toContain('elanous logs abandoned-draft-prs --all --include-test');
    expect(notice).toContain('그중 지금도 아직 열려 있는지는 이 명령이 안 봅니다');
    expect(notice).toContain('gh pr list --state open --draft');
  });

  test('식별자 표시 한도에서는 모두 보이고 초과하면 앞 10개와 전체 수 및 생략 사실을 고지한다', () => {
    const runIds = Array.from({ length: 11 }, (_, index) => ledgerRunId(String(index + 1)));
    const atLimit = parkedGoalsPopulationNotice({ status: 'ok', count: 10, runIds: runIds.slice(0, 10) });
    const truncated = parkedGoalsPopulationNotice({ status: 'ok', count: 11, runIds });

    expect(atLimit).toContain(runIds[9]);
    expect(atLimit).not.toContain('생략');
    expect(truncated).toContain(runIds[0]);
    expect(truncated).toContain(runIds[9]);
    expect(truncated).not.toContain(runIds[10]);
    expect(truncated).toContain('11건 중 10건 표시, 1건 생략');
  });

  test('0건과 원장을 못 읽은 상태를 구분하며 원장 실패 때 식별자를 지어내지 않는다', () => {
    const zero = parkedGoalsPopulationNotice({ status: 'ok', count: 0, runIds: [] });
    const unreadable = parkedGoalsPopulationNotice({ status: 'unreadable', runIds: [] });

    expect(zero).toContain('0건');
    expect(zero).not.toContain('원장을 못 읽어');
    expect(unreadable).toContain('원장을 못 읽어 집계하지 못했습니다');
    expect(unreadable).toContain('이 런들이 열어 둔 draft PR');
    expect(unreadable).toContain('elanous logs abandoned-draft-prs --all --include-test');
    expect(unreadable).toContain('gh pr list --state open --draft');
    expect(unreadable).not.toContain('런 식별자:');
  });
});

describe('listCombinedParkedGoals', () => {
  const ledgerRunId = (suffix: string): string => `run-00000000-0000-0000-0000-${suffix.padStart(12, '0')}`;

  test('self-dev와 UNCONVERGEABLE 원장을 같은 모양의 source 구별 행으로 합치고 제한 전 모집단을 센다', () => {
    const runsDir = tmp();
    const ledgerDir = tmp();
    const ledgerId = ledgerRunId('1');
    saveSelfDevRun({ runId: 'self-dev', createdAt: 1, updatedAt: 200, results: [
      { taskId: 'failed', feature: 'self-dev feature', status: 'failed', stage: 'gate-failed', error: { code: 'SELF_IMPL_FAILED', message: 'failed' } },
    ] }, runsDir);
    writeFileSync(join(ledgerDir, `${ledgerId}.jsonl`), `${[
      { event: 'rework-budget', runId: ledgerId, timestamp: '2026-08-21T00:00:00.000Z', data: { verdict: 'UNCONVERGEABLE', reason: 'rework exhausted' } },
      { event: 'run-status', runId: ledgerId, timestamp: '2026-08-21T00:00:01.000Z', data: { runStatus: 'failed' } },
    ].map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');

    const listing = listCombinedParkedGoals({ dir: runsDir, ledgerDir, limit: 1 });

    expect(listing.counts).toEqual({ total: 2, selfDevRun: 1, selfImplementLedger: 1 });
    expect(listing.displayLimit).toBe(1);
    expect(listing.omittedCount).toBe(1);
    expect(listing.parked).toHaveLength(1);
    const full = listCombinedParkedGoals({ dir: runsDir, ledgerDir });
    expect(new Set(full.parked.map((goal) => goal.source))).toEqual(new Set(['self-dev-run', 'self-implement-ledger']));
    const selfDev = full.parked.find((goal) => goal.source === 'self-dev-run')!;
    expect(selfDev).toMatchObject({ feature: 'self-dev feature', status: 'failed', stage: 'gate-failed', error: { code: 'SELF_IMPL_FAILED', message: 'failed' }, runId: 'self-dev', updatedAt: 200 });
    const ledger = full.parked.find((goal) => goal.source === 'self-implement-ledger')!;
    expect(ledger).toMatchObject({ feature: 'rework exhausted', status: 'interrupted', stage: 'UNCONVERGEABLE', failureClassification: 'goal-unconvergeable-candidate', error: { code: 'UNCONVERGEABLE', message: 'rework exhausted' }, runId: ledgerId });
    expect(analyzeRepairSignals(full.parked)).toContainEqual(expect.objectContaining({
      pattern: 'goal-unconvergeable-candidate',
      hypothesis: expect.stringContaining(CLASSIFICATION_HINTS['goal-unconvergeable-candidate'].goal),
    }));
    expect(typeof ledger.updatedAt).toBe('number');
  });

  test('copies recorded classification and final gated attribution while preserving absent and empty event states', () => {
    const ledgerDir = tmp();
    const classified = ledgerRunId('11');
    const empty = ledgerRunId('12');
    const absent = ledgerRunId('13');
    const terminal = (runId: string): object[] => [
      { event: 'rework-budget', runId, timestamp: '2026-08-21T00:00:00.000Z', data: { verdict: 'UNCONVERGEABLE', reason: `reason ${runId}` } },
      { event: 'run-status', runId, timestamp: '2026-08-21T00:00:01.000Z', data: { runStatus: 'failed' } },
    ];
    const writeLedger = (runId: string, entries: object[]): void => {
      writeFileSync(join(ledgerDir, `${runId}.jsonl`), `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
    };
    writeLedger(classified, [...terminal(classified),
      { event: 'abandoned-classification', runId: classified, data: { classification: 'implementation-deficit' } },
      { event: 'gated', runId: classified, data: { introduced: 9, preexisting: 1 } },
      { event: 'gated', runId: classified, data: { introduced: 0, preexisting: 2 } },
      { event: 'review-cited-paths', runId: classified, data: { round: 0, missingCount: 1, ambiguousCount: 3 } },
      { event: 'review-cited-paths', runId: classified, data: { round: 1, missingCount: 0, ambiguousCount: 5 } },
    ]);
    writeLedger(empty, [...terminal(empty), { event: 'abandoned-classification', runId: empty, data: { classification: '' } }]);
    writeLedger(absent, terminal(absent));

    const listing = listCombinedParkedGoals({ dir: tmp(), ledgerDir });
    const byRunId = new Map(listing.parked.map((row) => [row.runId, row]));

    expect(byRunId.get(classified)).toMatchObject({
      feature: `reason ${classified}`,
      status: 'interrupted',
      stage: 'UNCONVERGEABLE',
      source: 'self-implement-ledger',
      failureClassification: 'goal-unconvergeable-candidate',
      ledgerAbandonedClassification: 'implementation-deficit',
      ledgerGatedCounts: { introduced: 0, preexisting: 2 },
      ledgerReviewCitedPathCounts: { missing: 1, ambiguous: 8 },
    });
    expect(byRunId.get(empty)?.ledgerAbandonedClassification).toBe('');
    expect(byRunId.get(empty)?.ledgerGatedCounts).toBeNull();
    expect(byRunId.get(empty)?.ledgerReviewCitedPathCounts).toBeNull();
    expect(byRunId.get(absent)?.ledgerAbandonedClassification).toBeNull();
    expect(byRunId.get(absent)?.ledgerGatedCounts).toBeNull();
    expect(byRunId.get(absent)?.ledgerReviewCitedPathCounts).toBeNull();
    expect(listing.counts).toEqual({ total: 3, selfDevRun: 0, selfImplementLedger: 3 });
  });

  test('projects only the last locally recorded PR artifact evidence without mutating entries', () => {
    const runId = ledgerRunId('15');
    const entries = [
      { event: 'pr-opened', runId, data: { number: 41, changedFiles: 1, additions: 2, deletions: 3 } },
      { event: 'pr-opened', runId, data: { number: 42, changedFiles: 4, additions: 5, deletions: 6 } },
    ];
    const before = structuredClone(entries);

    expect(extractParkedGoalLedgerArtifactEvidence(entries)).toEqual({ prNumber: 42, changedFiles: 4, additions: 5, deletions: 6 });
    expect(entries).toEqual(before);
  });

  test('preserves a locally recorded rollup PR reference when artifact-size events are absent', () => {
    const runId = ledgerRunId('16');
    expect(extractParkedGoalLedgerArtifactEvidence([
      { event: 'run-rollup', runId, data: { prNumber: 99 } },
    ])).toEqual({ prNumber: 99, changedFiles: null, additions: null, deletions: null });
    expect(extractParkedGoalLedgerArtifactEvidence([
      { event: 'run-rollup', runId, data: { prNumber: 99 } },
      { event: 'pr-opened', runId, data: { number: 100, changedFiles: 4, additions: 5, deletions: 6 } },
    ])).toEqual({ prNumber: 100, changedFiles: 4, additions: 5, deletions: 6 });
  });

  test('leaves artifact evidence undefined when no valid locally recorded PR reference exists', () => {
    const runId = ledgerRunId('19');
    for (const number of [undefined, 'none', 'unknown', 0, -1, 1.5, Number.NaN]) {
      expect(extractParkedGoalLedgerArtifactEvidence([
        { event: 'pr-opened', runId, data: number === undefined ? {} : { number } },
      ])).toBeUndefined();
      expect(extractParkedGoalLedgerArtifactEvidence([
        { event: 'run-rollup', runId, data: number === undefined ? {} : { prNumber: number } },
      ])).toBeUndefined();
    }
  });

  test('adds local artifact size evidence to parked rows and distinguishes absent artifacts without external calls', () => {
    const ledgerDir = tmp();
    const recorded = ledgerRunId('17');
    const rollupOnly = ledgerRunId('18');
    const absent = ledgerRunId('19');
    const writeInterruptedLedger = (runId: string, entries: object[]): void => {
      writeFileSync(join(ledgerDir, `${runId}.jsonl`), `${[
        { event: 'rework-budget', runId, timestamp: '2026-08-21T00:00:00.000Z', data: { verdict: 'UNCONVERGEABLE', reason: 'recorded PR remains local context' } },
        ...entries,
        { event: 'run-status', runId, timestamp: '2026-08-21T00:00:01.000Z', data: { runStatus: 'failed' } },
      ].map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
    };
    writeInterruptedLedger(recorded, [{ event: 'pr-opened', runId: recorded, data: { number: 4242, changedFiles: 7, additions: 80, deletions: 9 } }]);
    writeInterruptedLedger(rollupOnly, [{ event: 'run-rollup', runId: rollupOnly, data: { prNumber: 4343 } }]);
    writeInterruptedLedger(absent, []);

    const rows = new Map(listCombinedParkedGoals({ dir: tmp(), ledgerDir }).parked.map((goal) => [goal.runId, goal]));

    expect(rows.get(recorded)?.ledgerArtifactEvidence).toEqual({ prNumber: 4242, changedFiles: 7, additions: 80, deletions: 9 });
    expect(rows.get(rollupOnly)?.ledgerArtifactEvidence).toEqual({ prNumber: 4343, changedFiles: null, additions: null, deletions: null });
    expect(rows.get(absent)?.ledgerArtifactEvidence).toBeNull();
    expect(rows.get(recorded)).not.toHaveProperty('recoverable');
  });

  test('marks interrupted rows when the same goal later completed without removing all-failed or unreadable-goal rows', () => {
    const ledgerDir = tmp();
    const succeededLater = ledgerRunId('20');
    const completed = ledgerRunId('21');
    const allFailed = ledgerRunId('22');
    const unreadableGoalId = ledgerRunId('23');
    const writeLedger = (runId: string, entries: object[]): void => {
      writeFileSync(join(ledgerDir, `${runId}.jsonl`), `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
    };
    const interrupted = (runId: string, goalId?: string): object[] => [
      { event: 'rework-budget', runId, goalId, timestamp: '2026-08-21T00:00:00.000Z', data: { verdict: 'UNCONVERGEABLE', reason: runId } },
      { event: 'run-status', runId, goalId, timestamp: '2026-08-21T00:00:01.000Z', data: { runStatus: 'failed' } },
    ];
    writeLedger(succeededLater, interrupted(succeededLater, 'goal-succeeded-later'));
    writeLedger(completed, [{ event: 'run-status', runId: completed, goalId: 'goal-succeeded-later', timestamp: '2026-08-22T00:00:01.000Z', data: { runStatus: 'completed' } }]);
    writeLedger(allFailed, interrupted(allFailed, 'goal-all-failed'));
    writeLedger(unreadableGoalId, interrupted(unreadableGoalId));

    const listing = listCombinedParkedGoals({ dir: tmp(), ledgerDir });
    const byRunId = new Map(listing.parked.map((row) => [row.runId, row]));

    expect(listing.parked).toHaveLength(3);
    expect(listing.counts).toEqual({ total: 3, selfDevRun: 0, selfImplementLedger: 3 });
    expect(byRunId.get(succeededLater)?.laterRunSucceeded).toBeTrue();
    expect(byRunId.get(allFailed)?.laterRunSucceeded).toBeFalse();
    expect(byRunId.get(unreadableGoalId)?.laterRunSucceeded).toBeNull();
  });

  test('preserves unknown timestamp comparisons unless a known later completion establishes success', () => {
    const ledgerDir = tmp();
    const missingTimestamp = ledgerRunId('24');
    const invalidCompletedTimestamp = ledgerRunId('25');
    const invalidInterruptedTimestamp = ledgerRunId('26');
    const completedMissingTimestamp = ledgerRunId('27');
    const completedInvalidTimestamp = ledgerRunId('30');
    const completedInvalidInterrupted = ledgerRunId('31');
    const mixedUnknownAndLaterCompleted = ledgerRunId('32');
    const completedUnknownForMixedGoal = ledgerRunId('33');
    const completedLaterForMixedGoal = ledgerRunId('34');
    const writeLedger = (runId: string, entries: object[]): void => {
      writeFileSync(join(ledgerDir, `${runId}.jsonl`), `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
    };
    const interrupted = (runId: string, goalId: string, timestamp?: string): object[] => [
      { event: 'rework-budget', runId, goalId, timestamp, data: { verdict: 'UNCONVERGEABLE', reason: runId } },
      { event: 'run-status', runId, goalId, timestamp, data: { runStatus: 'failed' } },
    ];
    writeLedger(missingTimestamp, interrupted(missingTimestamp, 'goal-missing-time'));
    writeLedger(invalidCompletedTimestamp, interrupted(invalidCompletedTimestamp, 'goal-invalid-completed', '2026-08-21T00:00:01.000Z'));
    writeLedger(invalidInterruptedTimestamp, interrupted(invalidInterruptedTimestamp, 'goal-invalid-interrupted', 'invalid'));
    writeLedger(mixedUnknownAndLaterCompleted, interrupted(mixedUnknownAndLaterCompleted, 'goal-mixed-completed', '2026-08-21T00:00:01.000Z'));
    writeLedger(completedMissingTimestamp, [{ event: 'run-status', runId: completedMissingTimestamp, goalId: 'goal-missing-time', timestamp: '2026-08-22T00:00:01.000Z', data: { runStatus: 'completed' } }]);
    writeLedger(completedInvalidTimestamp, [{ event: 'run-status', runId: completedInvalidTimestamp, goalId: 'goal-invalid-completed', timestamp: 'invalid', data: { runStatus: 'completed' } }]);
    writeLedger(completedInvalidInterrupted, [{ event: 'run-status', runId: completedInvalidInterrupted, goalId: 'goal-invalid-interrupted', timestamp: '2026-08-22T00:00:01.000Z', data: { runStatus: 'completed' } }]);
    writeLedger(completedUnknownForMixedGoal, [{ event: 'run-status', runId: completedUnknownForMixedGoal, goalId: 'goal-mixed-completed', data: { runStatus: 'completed' } }]);
    writeLedger(completedLaterForMixedGoal, [{ event: 'run-status', runId: completedLaterForMixedGoal, goalId: 'goal-mixed-completed', timestamp: '2026-08-22T00:00:01.000Z', data: { runStatus: 'completed' } }]);

    const byRunId = new Map(listCombinedParkedGoals({ dir: tmp(), ledgerDir }).parked.map((row) => [row.runId, row]));

    expect(byRunId.get(missingTimestamp)?.laterRunSucceeded).toBeNull();
    expect(byRunId.get(invalidCompletedTimestamp)?.laterRunSucceeded).toBeNull();
    expect(byRunId.get(invalidInterruptedTimestamp)?.laterRunSucceeded).toBeNull();
    expect(byRunId.get(mixedUnknownAndLaterCompleted)?.laterRunSucceeded).toBeTrue();
  });

  test('self parked CLI serializes laterRunSucceeded from the existing combined-listing execution path', () => {
    const stateDir = tmp();
    const ledgerDir = join(stateDir, 'run-ledger');
    mkdirSync(ledgerDir, { recursive: true });
    const interruptedRun = ledgerRunId('28');
    const completedRun = ledgerRunId('29');
    writeFileSync(join(ledgerDir, `${interruptedRun}.jsonl`), `${[
      { event: 'rework-budget', runId: interruptedRun, goalId: 'goal-cli', timestamp: '2026-08-21T00:00:00.000Z', data: { verdict: 'UNCONVERGEABLE', reason: 'CLI parked failure' } },
      { event: 'run-status', runId: interruptedRun, goalId: 'goal-cli', timestamp: '2026-08-21T00:00:01.000Z', data: { runStatus: 'failed' } },
    ].map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
    writeFileSync(join(ledgerDir, `${completedRun}.jsonl`), `${JSON.stringify({ event: 'run-status', runId: completedRun, goalId: 'goal-cli', timestamp: '2026-08-22T00:00:01.000Z', data: { runStatus: 'completed' } })}\n`, 'utf8');

    const result = spawnSync('bun', ['bin/elanous.mjs', 'self', 'parked', '--json'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, HOME: mirrorLedgerRoot, ELANOUS_DEBUG_LEVEL: 'off', ELANOUS_STATE_DIR: stateDir },
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const listing = JSON.parse(result.stdout) as { parked: Array<{ runId: string; laterRunSucceeded?: boolean | null }> };
    expect(listing.parked.find((row) => row.runId === interruptedRun)?.laterRunSucceeded).toBeTrue();
  }, 60_000);

  test('projects recorded goalFile exactly, omits it when absent, and renders its filename through self parked', () => {
    const stateDir = tmp();
    const ledgerDir = join(stateDir, 'run-ledger');
    mkdirSync(ledgerDir, { recursive: true });
    const withGoalFile = ledgerRunId('30');
    const withoutGoalFile = ledgerRunId('31');
    const goalFile = '/repository/docs/goals/GOAL-run-store-goal-file-2026-09-13.md';
    const interruptedEntries = (runId: string, startData: object): object[] => [
      { event: 'start', runId, goalId: `goal-${runId}`, timestamp: '2026-08-21T00:00:00.000Z', data: startData },
      { event: 'rework-budget', runId, timestamp: '2026-08-21T00:00:01.000Z', data: { verdict: 'UNCONVERGEABLE', reason: `reason ${runId}` } },
      { event: 'run-status', runId, goalId: `goal-${runId}`, timestamp: '2026-08-21T00:00:02.000Z', data: { runStatus: 'failed' } },
    ];
    for (const [runId, startData] of [[withGoalFile, { goalFile }], [withoutGoalFile, {}]] as const) {
      writeFileSync(join(ledgerDir, `${runId}.jsonl`), `${interruptedEntries(runId, startData).map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
    }

    const listing = listCombinedParkedGoals({ dir: join(stateDir, 'self-dev-runs'), ledgerDir });
    const rows = new Map(listing.parked.map((row) => [row.runId, row]));
    expect(rows.get(withGoalFile)).toMatchObject({ goalFile, feature: `reason ${withGoalFile}` });
    expect(Object.keys(rows.get(withoutGoalFile) ?? {})).not.toContain('goalFile');
    expect(listing.counts).toEqual({ total: 2, selfDevRun: 0, selfImplementLedger: 2 });

    const human = spawnSync('bun', ['bin/elanous.mjs', 'self', 'parked'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, HOME: mirrorLedgerRoot, ELANOUS_DEBUG_LEVEL: 'off', ELANOUS_STATE_DIR: stateDir },
    });

    expect(human.error).toBeUndefined();
    expect(human.status).toBe(0);
    expect(human.stdout).toContain('GOAL-run-store-goal-file-2026-09-13.md');
  }, 60_000);

  test('does not promote an unreadable ledger to a parked row without interruption evidence', () => {
    const ledgerDir = tmp();
    const unreadable = ledgerRunId('14');
    writeFileSync(join(ledgerDir, `${unreadable}.jsonl`), '{not json}\n', 'utf8');

    const listing = listCombinedParkedGoals({ dir: tmp(), ledgerDir });

    expect(listing.parked.find((row) => row.runId === unreadable)).toBeUndefined();
    expect(listing.counts).toEqual({ total: 0, selfDevRun: 0, selfImplementLedger: 0 });
  });

  test('two UNCONVERGEABLE ledger rows yield the goal contract and decomposition repair signal', () => {
    const ledgerDir = tmp();
    for (const [suffix, reason] of [['2', 'repeated review finding'], ['3', 'repeated reviewer request']] as const) {
      const runId = ledgerRunId(suffix);
      writeFileSync(join(ledgerDir, `${runId}.jsonl`), `${[
        { event: 'rework-budget', runId, timestamp: '2026-08-21T00:00:00.000Z', data: { verdict: 'UNCONVERGEABLE', reason } },
        { event: 'run-status', runId, timestamp: '2026-08-21T00:00:01.000Z', data: { runStatus: 'failed' } },
      ].map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
    }

    const listing = listCombinedParkedGoals({ dir: tmp(), ledgerDir });

    expect(listing.parked.every((goal) => goal.failureClassification === 'goal-unconvergeable-candidate')).toBeTrue();
    expect(analyzeRepairSignals(listing.parked)).toContainEqual(expect.objectContaining({
      pattern: 'goal-unconvergeable-candidate',
      kind: 'system',
      hypothesis: expect.stringContaining(CLASSIFICATION_HINTS['goal-unconvergeable-candidate'].system),
    }));
  });

  test('only known interruption verdicts receive failure classifications', () => {
    expect(failureClassificationForInterruptionVerdict('UNCONVERGEABLE')).toBe('goal-unconvergeable-candidate');
    expect(failureClassificationForInterruptionVerdict('CONTRACT-CONFLICT')).toBe('contract-conflict');
    expect(failureClassificationForInterruptionVerdict('CONTINUE')).toBeUndefined();
    expect(failureClassificationForInterruptionVerdict(null)).toBeUndefined();
  });

  test('every needs-human supervisor stop without an ordinary parked result is listed with its distinct reason', () => {
    const runsDir = tmp();
    for (const [runId, updatedAt] of [['needs-human-first', 200], ['needs-human-second', 100]] as const) {
      saveSelfDevRun({
        runId, createdAt: 1, updatedAt, supervisorStopReason: 'needs-human',
        results: [{ taskId: 'done', feature: `completed ${runId}`, status: 'done', stage: 'merged', merged: true }],
      }, runsDir);
    }
    saveSelfDevRun({
      runId: 'no-actionable-run', createdAt: 1, updatedAt: 50,
      supervisorStopReason: 'no-actionable-work',
      results: [{ taskId: 'done', feature: 'also completed', status: 'done', stage: 'merged', merged: true }],
    }, runsDir);

    const listing = listCombinedParkedGoals({ dir: runsDir, ledgerDir: tmp() });

    expect(listing.counts).toEqual({ total: 2, selfDevRun: 2, selfImplementLedger: 0 });
    expect(listing.parked).toMatchObject([
      { source: 'self-dev-run', runId: 'needs-human-first', stage: 'supervisor-stop', supervisorStopReason: 'needs-human', status: 'interrupted' },
      { source: 'self-dev-run', runId: 'needs-human-second', stage: 'supervisor-stop', supervisorStopReason: 'needs-human', status: 'interrupted' },
    ]);
    expect(listing.parked.map(({ runId }) => runId)).toEqual(['needs-human-first', 'needs-human-second']);
    expect(listing.parked.every(({ supervisorStopReason }) => supervisorStopReason === 'needs-human')).toBeTrue();
  });

  test('zero parked results retain the status-based population, read store names, and shared limitation', () => {
    const runsDir = tmp();
    const ledgerDir = tmp();

    const listing = listCombinedParkedGoals({ dir: runsDir, ledgerDir });

    expect(listing.counts).toEqual({ total: 0, selfDevRun: 0, selfImplementLedger: 0 });
    expect(listing.parked).toEqual([]);
    expect(listing.population).toEqual({
      selfDevRun: 'existing parked-goal scan',
      selfImplementLedgerStatus: PARKED_GOALS_LEDGER_STATUS,
    });
    expect(listing.population.selfImplementLedgerStatus).toBe(PARKED_GOALS_LEDGER_STATUS);
    expect(listing.stores).toEqual({ count: 2, names: [runsDir, ledgerDir] });
    expect(listing.limitation).toBe(PARKED_GOALS_LIMITATION);
    expect(listing.limitation).toContain('다른 우주는 보지 않으며');
    expect(listing.limitation).toContain('아직 열려 있는지도 보지 않습니다');
  });

  test('self parked CLI renders the same population and limitation metadata in JSON and human output at zero results', () => {
    const stateDir = tmp();
    const expectedStores = [join(stateDir, 'self-dev-runs'), join(stateDir, 'run-ledger')];
    const result = spawnSync('bun', ['bin/elanous.mjs', 'self', 'parked', '--json'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, HOME: mirrorLedgerRoot, ELANOUS_DEBUG_LEVEL: 'off', ELANOUS_STATE_DIR: stateDir },
    });
    const human = spawnSync('bun', ['bin/elanous.mjs', 'self', 'parked'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, HOME: mirrorLedgerRoot, ELANOUS_DEBUG_LEVEL: 'off', ELANOUS_STATE_DIR: stateDir },
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const listing = JSON.parse(result.stdout) as {
      counts: { total: number };
      population: { selfImplementLedgerStatus: string };
      stores: { count: number; names: string[] };
      limitation: string;
    };
    expect(listing.counts.total).toBe(0);
    expect(listing.population.selfImplementLedgerStatus).toBe(PARKED_GOALS_LEDGER_STATUS);
    expect(listing.stores).toEqual({ count: expectedStores.length, names: expectedStores });
    expect(listing.limitation).toBe(PARKED_GOALS_LIMITATION);
    expect(human.error).toBeUndefined();
    expect(human.status).toBe(0);
    expect(human.stdout).toContain(`원장 상태=${PARKED_GOALS_LEDGER_STATUS}`);
    expect(human.stdout).toContain(PARKED_GOALS_LIMITATION);
  }, 60_000);

  test('display limit rejects zero so a caller cannot silently hide the whole population', () => {
    expect(() => listCombinedParkedGoals({ dir: tmp(), ledgerDir: tmp(), limit: 0 })).toThrow('parked goal display limit must be a positive safe integer: 0');
  });
});

describe('listParkedGoals (G4 · 실패 백로그)', () => {
  const runWith = (id: string, updatedAt: number, results: SelfDevRunState['results']): SelfDevRunState =>
    ({ runId: id, createdAt: 1, updatedAt, results });

  test('scan은 빈 저장소와 전부 제외된 저장소를 이유별 계수로 구별하고 기존 배열을 보존한다', () => {
    const empty = scanParkedGoals(tmp());
    expect(empty.parked).toEqual([]);
    expect(empty.counts.runs).toBe(0);

    const filteredDir = tmp();
    saveSelfDevRun({
      ...runWith('filtered', 100, [
        { taskId: 'done', feature: 'DONE', status: 'done' },
        { taskId: 'live', feature: 'LIVE', status: 'running' as never },
      ]),
      pid: 4242,
    }, filteredDir);
    const filtered = scanParkedGoals(filteredDir, (pid) => pid === 4242);
    expect(filtered.parked).toEqual([]);
    expect(filtered.counts.runs).toBeGreaterThan(0);
    expect(filtered.counts.resultItems).toBeGreaterThan(0);
    expect(Object.values(filtered.counts.excluded).reduce((sum, count) => sum + count, 0)).toBe(filtered.counts.resultItems);
    expect(filtered.counts).not.toEqual(empty.counts);
    expect(filtered.counts.excluded.completed).toBe(1);
    expect(filtered.counts.excluded.liveRunning).toBe(1);

    const parkedDir = tmp();
    saveSelfDevRun(runWith('parked', 100, [{ taskId: 'failed', feature: 'FAILED', status: 'failed' }]), parkedDir);
    expect(listParkedGoals(parkedDir)).toEqual(scanParkedGoals(parkedDir).parked);
  });

  test('실패/취소 goal 을 parked 로 수집(done 제외)', () => {
    const dir = tmp();
    saveSelfDevRun(runWith('r1', 100, [
      { taskId: 'a', feature: 'A', status: 'done', prUrl: 'https://x/1' },
      { taskId: 'b', feature: 'B', status: 'failed', stage: 'gate-failed', error: { code: 'SELF_IMPL_FAILED', message: 'x' } },
      { taskId: 'c', feature: 'C', status: 'cancelled' },
    ]), dir);
    const parked = listParkedGoals(dir);
    expect(new Set(parked.map((p) => p.feature))).toEqual(new Set(['B', 'C'])); // A(done) 제외
    expect(parked.find((p) => p.feature === 'B')!.stage).toBe('gate-failed');
  });

  test('관측 전용 done 은 parked 에 남고 출처 stage 를 보존한다', () => {
    const dir = tmp();
    saveSelfDevRun(runWith('old', 100, [{ taskId: 'b', feature: 'B', status: 'failed', stage: 'merge-conflict' }]), dir);
    saveSelfDevRun(runWith('observed', 200, [{ taskId: 'b', feature: 'B', status: 'done', stage: 'observed' }]), dir);

    expect(listParkedGoals(dir)).toMatchObject([{ feature: 'B', status: 'done', stage: 'observed', runId: 'observed' }]);
  });

  test('재실행으로 실제 done 되면 parked 에서 빠짐(최신 run 이 이김)', () => {
    const dir = tmp();
    saveSelfDevRun(runWith('old', 100, [{ taskId: 'b', feature: 'B', status: 'failed', stage: 'merge-conflict' }]), dir);
    saveSelfDevRun(runWith('new', 200, [{ taskId: 'b', feature: 'B', status: 'done', prUrl: 'https://x/9' }]), dir);
    expect(listParkedGoals(dir)).toEqual([]); // 최신 run 에서 실제 done → parked 아님
  });

  test('사람이 해소 표시한 최신 run은 기록과 이유를 보존하고 parked에서만 제외한다', () => {
    const dir = tmp();
    const state = runWith('resolved', 100, [{ taskId: 'b', feature: 'B', status: 'failed', stage: 'merge-conflict' }]);
    saveSelfDevRun(state, dir);

    expect(listParkedGoals(dir).map((goal) => goal.runId)).toEqual(['resolved']);
    const resolution = resolveParkedSelfDevRun('resolved', 'succeeded in a later run', dir);

    expect(resolution.reason).toBe('succeeded in a later run');
    expect(loadSelfDevRun('resolved', dir)).toMatchObject({
      ...state,
      parkedResolution: { reason: 'succeeded in a later run' },
    });
    expect(listParkedGoals(dir)).toEqual([]);
  });

  test('없는 run의 해소 표시는 run ID를 말하며 실패하고 파일을 만들지 않는다', () => {
    const dir = tmp();
    expect(() => resolveParkedSelfDevRun('absent-run', 'reviewed', dir)).toThrow('self-dev run not found: absent-run');
    expect(existsSync(join(dir, 'absent-run.json'))).toBeFalse();
  });

  test('경로 이탈 run ID는 저장소 밖 파일을 읽거나 바꾸지 못한다', () => {
    const root = tmp();
    const dir = join(root, 'self-dev-runs');
    const victim = join(root, 'victim.json');
    try {
      writeFileSync(victim, '{"preserve":true}', 'utf8');

      expect(() => resolveParkedSelfDevRun('../victim', 'reviewed', dir)).toThrow('invalid self-dev run ID: ../victim');
      expect(readFileSync(victim, 'utf8')).toBe('{"preserve":true}');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('막힌 goal 없으면 빈 백로그', () => {
    const dir = tmp();
    saveSelfDevRun(runWith('r', 100, [{ taskId: 'a', feature: 'A', status: 'done' }]), dir);
    expect(listParkedGoals(dir)).toEqual([]);
  });

  test('중단된 잡의 non-terminal(running) → interrupted 로 relabel(실행중 오인 방지)', () => {
    const dir = tmp();
    saveSelfDevRun(runWith('killed', 100, [
      { taskId: 'a', feature: 'A', status: 'running' },   // 오케스트레이터 killed → 잔류
      { taskId: 'b', feature: 'B', status: 'failed', stage: 'gate-failed' },
    ]), dir);
    const parked = listParkedGoals(dir);
    expect(parked.find((p) => p.feature === 'A')!.status).toBe('interrupted'); // running 아님
    expect(parked.find((p) => p.feature === 'B')!.status).toBe('failed');      // 진짜 실패는 유지
  });
});

describe('C — 라이브 vs interrupted 구분(HITL 정황 품질·2026-07-21 대표)', () => {
  const withPid = (dir: string, pid: number, status: string): void => {
    saveSelfDevRun({ runId: 'live', createdAt: 1, updatedAt: 2, pid, results: [
      { taskId: 'a', feature: 'LIVE', status: status as never },
      { taskId: 'b', feature: 'FAIL', status: 'failed', stage: 'gate-failed' },
    ] }, dir);
  };

  test('구동 오케스트레이터 살아있으면 non-terminal=running → parked 제외(막힌 것 아님)', () => {
    const dir = tmp();
    withPid(dir, 4242, 'running');
    const alive = (pid: number): boolean => pid === 4242;   // 라이브 주입
    const parked = listParkedGoals(dir, alive);
    expect(parked.find((p) => p.feature === 'LIVE')).toBeUndefined();  // 라이브=제외
    expect(parked.find((p) => p.feature === 'FAIL')!.status).toBe('failed'); // 진짜 실패는 유지
    expect(countRunningGoals(dir, alive)).toBe(1);   // 실행중 1건으로 카운트
  });

  test('오케스트레이터 죽었으면 non-terminal=interrupted → parked(결정 대기)', () => {
    const dir = tmp();
    withPid(dir, 4242, 'running');
    const dead = (): boolean => false;   // 죽음 주입
    const parked = listParkedGoals(dir, dead);
    expect(parked.find((p) => p.feature === 'LIVE')!.status).toBe('interrupted'); // 진짜 막힘
    expect(countRunningGoals(dir, dead)).toBe(0);
  });

  test('pid 없는 구버전 체크포인트 → 보수적으로 죽음(interrupted·종전 동작)', () => {
    const dir = tmp();
    saveSelfDevRun({ runId: 'old', createdAt: 1, updatedAt: 2, results: [
      { taskId: 'a', feature: 'OLD', status: 'running' as never },
    ] }, dir);
    expect(listParkedGoals(dir, () => true).find((p) => p.feature === 'OLD')!.status).toBe('interrupted');
  });
});
