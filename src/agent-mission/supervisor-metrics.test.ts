import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import { LogStore, StoreSink } from '../mss/logging/log-store.js';
import { debug } from '../debug/log.js';
import { runAgentMission, claudeBackend, setAgentMissionTimingForTest } from './driver.js';
import type { PtyHandle } from '../pty-shell/registry.js';
import type { PtyControlDeps, RunSupervisor } from '../autopilot/pty-control-loop.js';
import { decideInterventionStep } from '../self-implement/intervention-step.js';
import { parseSince } from '../cli/logs-cli.js';
import { registerSupervisorMetricsCommand } from './supervisor-metrics-cli.js';
import { emitPtyDecision } from './pty-decision.js';
import {
  aggregateSupervisorMetrics,
  readSupervisorLogsFromStore,
  type SupervisorLogRow,
} from './supervisor-metrics.js';

const SINCE_MS = 1_000;
const NOW_MS = 10_000;

function row(partial: Partial<SupervisorLogRow> & Pick<SupervisorLogRow, 'category' | 'event'>): SupervisorLogRow {
  return { tsMs: 5_000, data: {}, ...partial };
}

function fixture(): SupervisorLogRow[] {
  return [
    row({ category: 'agent-mission', event: 'result', data: { ok: true, runId: 'm1' } }),
    row({ category: 'agent-mission', event: 'result', data: { ok: false, runId: 'm2' } }),
    row({ category: 'pty.decision', event: 'answer', data: { missionId: 'm1', step: 'answer', detail: { question: 'Trust?', answer: 'yes' } } }),
    row({ category: 'pty.decision', event: 'answer', data: { missionId: 'm2', step: 'answer', detail: { question: 'Continue?', answer: 'go' } } }),
    row({
      category: 'autopilot.control', event: 'end',
      data: { kind: 'stuck', interventionLevel: 'nudge', interventionStop: false, supervisionVerdict: 'continue', runId: 'm2' },
    }),
    row({
      category: 'autopilot.control', event: 'end',
      data: { kind: 'success', interventionLevel: 'continue', interventionStop: false, supervisionVerdict: 'complete', runId: 'm1' },
    }),
    row({ category: 'self-implement', event: 'frame-stall', data: { state: 'working', rung: 0, runId: 'm2' } }),
    row({ category: 'self-implement', event: 'frame-stall', data: { state: 'working', rung: 2, runId: 'm2' } }),
    row({ category: 'self-implement', event: 'frame-stall', data: { state: 'idle', rung: 2, runId: 'm1' } }),
    row({ category: 'agent-mission.resources', event: 'needs', data: { kind: 'VERIFY', what: '필요 능력 판정', runId: 'm1' } }),
    row({ category: 'agent-mission.resources', event: 'have', data: { kind: 'VERIFY', what: 'ready 서비스 대조', runId: 'm1' } }),
    row({ category: 'agent-mission.resources', event: 'backend', data: { kind: 'ROUTE', what: 'ready 에이전트 선택', runId: 'm1' } }),
    row({ category: 'agent-mission.resources', event: 'discover', data: { kind: 'ESCALATE', what: '발굴 실패', runId: 'm2' } }),
  ];
}

describe('agent-mission supervisor metrics', () => {
  it('다섯 지표가 가짜 미션 기록에서 맞고, 기록이 없는 지표는 못 잼', () => {
    const full = aggregateSupervisorMetrics(fixture(), { since: '7d', sinceMs: SINCE_MS });
    expect(full.missions).toBe(2);
    expect(full.status).toBe('measured');
    const byId = Object.fromEntries(full.metrics.map((metric) => [metric.id, metric]));
    expect(byId.completion).toMatchObject({ status: 'measured', value: '1/2', detail: { completed: 1, missions: 2, rate: 0.5 } });
    expect(byId.questionsAnswered).toMatchObject({ status: 'measured', value: 2 });
    expect(byId.unnecessaryInterventions).toMatchObject({ status: 'unmeasured', reason: '못 잼 · 개입 불필요성 근거 기록 없음' });
    expect(byId.unnecessaryInterventions.value).toBeUndefined();
    const ambiguousEnds = ['stuck', 'error', 'cancelled', 'success'].map((kind) =>
      row({ category: 'autopilot.control', event: 'end', data: { runId: 'm1', kind, interventionLevel: 'nudge' } }));
    const ambiguous = aggregateSupervisorMetrics([...fixture(), ...ambiguousEnds], { since: '7d', sinceMs: SINCE_MS });
    expect(ambiguous.metrics.find((metric) => metric.id === 'unnecessaryInterventions')).toMatchObject({
      status: 'unmeasured', reason: '못 잼 · 개입 불필요성 근거 기록 없음',
    });
    expect(ambiguous.metrics.find((metric) => metric.id === 'unnecessaryInterventions')?.value).toBeUndefined();
    expect(byId.stall).toMatchObject({ status: 'unmeasured', reason: '못 잼 · 실제 멈춤 근거 기록 없음' });
    expect(byId.stall.value).toBeUndefined();
    expect(byId.ladderHits).toMatchObject({ status: 'unmeasured', reason: '못 잼 · 사다리 적중 근거 기록 없음' });
    expect(byId.ladderHits.value).toBeUndefined();
    const inventedOutcomes = fixture().map((item) => item.event === 'frame-stall'
      ? { ...item, data: { ...item.data, actuallyStopped: true } }
      : item.category === 'agent-mission.resources'
        ? { ...item, data: { ...item.data, hit: true } }
        : item);
    const stillUnmeasured = aggregateSupervisorMetrics(inventedOutcomes, { since: '7d', sinceMs: SINCE_MS });
    expect(stillUnmeasured.metrics.find((metric) => metric.id === 'stall')?.status).toBe('unmeasured');
    expect(stillUnmeasured.metrics.find((metric) => metric.id === 'ladderHits')?.status).toBe('unmeasured');

    const partial = aggregateSupervisorMetrics(
      [row({ category: 'agent-mission', event: 'result', data: { ok: true, runId: 'only' } })],
      { since: '7d', sinceMs: SINCE_MS },
    );
    for (const id of ['questionsAnswered', 'unnecessaryInterventions', 'stall', 'ladderHits'] as const) {
      const metric = partial.metrics.find((item) => item.id === id);
      expect(metric?.status).toBe('unmeasured');
      expect(metric?.reason).toContain('못 잼');
      expect(metric?.value).toBeUndefined();
    }
    expect(partial.metrics.find((item) => item.id === 'completion')).toMatchObject({ status: 'measured', value: '1/1' });
  });

  it('실제 PTY 결정 발행기의 answer 페이로드는 detail에서 읽고 일치하는 미션 식별자로 연결한다', () => {
    const emitted = emitPtyDecision({
      missionId: 'metrics-payload-test', sessionId: 'session', terminalId: 'pty', agent: 'codex',
      step: 'answer', text: 'Answered agent question', detail: { question: 'Continue?', answer: 'yes' },
    }, () => {});
    const report = aggregateSupervisorMetrics([
      row({ category: 'agent-mission', event: 'result', data: { ok: true, missionId: emitted.missionId } }),
      row({ category: 'pty.decision', event: 'answer', data: emitted }),
    ], { since: '7d', sinceMs: SINCE_MS });
    expect(report.metrics.find((metric) => metric.id === 'questionsAnswered')).toMatchObject({
      status: 'measured', value: 1,
    });
    const rawRunId = aggregateSupervisorMetrics([
      row({ category: 'agent-mission', event: 'result', data: { ok: true, runId: 'metrics-payload-test' } }),
      row({ category: 'pty.decision', event: 'answer', data: emitted }),
    ], { since: '7d', sinceMs: SINCE_MS });
    expect(rawRunId.metrics.find((metric) => metric.id === 'questionsAnswered')).toMatchObject({
      status: 'unmeasured', reason: '못 잼 · 미션과 연결 불가',
    });
    const matchingMissionId = aggregateSupervisorMetrics([
      row({ category: 'agent-mission', event: 'result', data: { ok: true, runId: emitted.missionId } }),
      row({ category: 'pty.decision', event: 'answer', data: emitted }),
    ], { since: '7d', sinceMs: SINCE_MS });
    expect(matchingMissionId.metrics.find((metric) => metric.id === 'questionsAnswered')).toMatchObject({
      status: 'measured', value: 1,
    });
    const attributed = aggregateSupervisorMetrics([
      row({ category: 'agent-mission', event: 'result', data: { ok: true, runId: 'metrics-payload-test' } }),
      row({ category: 'pty.decision', event: 'answer', data: { ...emitted, runId: 'metrics-payload-test' } }),
    ], { since: '7d', sinceMs: SINCE_MS });
    expect(attributed.metrics.find((metric) => metric.id === 'questionsAnswered')).toMatchObject({
      status: 'measured', value: 1,
    });
  });

  it('발행기가 별칭 missionId 를 써도 sessionId 로 원래 실행에 연결한다', () => {
    const emitted = emitPtyDecision({
      missionId: 'original-run-metrics', sessionId: 'original-run-metrics', terminalId: 'pty', agent: 'codex',
      step: 'answer', text: 'Answered agent question', detail: { question: 'Continue?', answer: 'yes' },
    }, () => {});
    expect(emitted.missionId).not.toBe('original-run-metrics');
    const report = aggregateSupervisorMetrics([
      row({ category: 'agent-mission', event: 'result', data: { ok: true, runId: 'original-run-metrics' } }),
      row({ category: 'pty.decision', event: 'answer', data: emitted }),
    ], { since: '7d', sinceMs: SINCE_MS });
    expect(report.metrics.find((metric) => metric.id === 'questionsAnswered')).toMatchObject({
      status: 'measured', value: 1,
    });
    const equalAlias = aggregateSupervisorMetrics([
      row({ category: 'agent-mission', event: 'result', data: { ok: true, runId: emitted.missionId } }),
      row({ category: 'pty.decision', event: 'answer', data: emitted }),
    ], { since: '7d', sinceMs: SINCE_MS });
    expect(equalAlias.metrics.find((metric) => metric.id === 'questionsAnswered')).toMatchObject({
      status: 'measured', value: 1,
    });
    const otherCategory = aggregateSupervisorMetrics([
      row({ category: 'agent-mission', event: 'result', data: { ok: true, runId: 'original-run-metrics' } }),
      row({ category: 'autopilot.control', event: 'end', data: {
        missionId: emitted.missionId, sessionId: 'original-run-metrics', interventionLevel: 'nudge',
      } }),
    ], { since: '7d', sinceMs: SINCE_MS });
    expect(otherCategory.metrics.find((metric) => metric.id === 'unnecessaryInterventions')).toMatchObject({
      status: 'unmeasured', reason: '못 잼 · 미션과 연결 불가',
    });
  });

  it('서로 다른 runId 와 sessionId 를 가진 결정은 임의로 연결하지 않는다', () => {
    const report = aggregateSupervisorMetrics([
      row({ category: 'agent-mission', event: 'result', data: { ok: true, runId: 'm1' } }),
      row({ category: 'pty.decision', event: 'answer', data: {
        runId: 'other-run', sessionId: 'm1', detail: { question: 'Continue?', answer: 'yes' },
      } }),
    ], { since: '7d', sinceMs: SINCE_MS });
    expect(report.metrics.find((metric) => metric.id === 'questionsAnswered')).toMatchObject({
      status: 'unmeasured', reason: '못 잼 · 미션과 연결 불가',
    });
  });

  it('미션과 연결된 answer 이벤트라도 답변 본문이 없으면 질문 통과로 세지 않는다', () => {
    const report = aggregateSupervisorMetrics([
      row({ category: 'agent-mission', event: 'result', data: { ok: true, runId: 'm1' } }),
      row({ category: 'pty.decision', event: 'answer', data: { missionId: 'm1', detail: { question: 'Continue?' } } }),
    ], { since: '7d', sinceMs: SINCE_MS });
    expect(report.metrics.find((metric) => metric.id === 'questionsAnswered')).toMatchObject({
      status: 'unmeasured', reason: '못 잼 · 답변 본문 기록 없음',
    });
    expect(report.metrics.find((metric) => metric.id === 'questionsAnswered')?.value).toBeUndefined();
  });

  it('parseSince 상대값은 epoch 하한이고 절대 시각 입력은 그대로 보존한다', async () => {
    const before = Date.now();
    const parsedRelative = parseSince('7d');
    expect(parsedRelative).toBeGreaterThanOrEqual(before - 7 * 86_400_000);
    expect(parsedRelative).toBeLessThanOrEqual(Date.now() - 7 * 86_400_000);
    const absolute = '2026-09-01T00:00:00.000Z';
    let output = '';
    const program = new Command().exitOverride();
    registerSupervisorMetricsCommand(program.command('agent-mission'), {
      read: () => [], write: (text) => { output += text; }, nowMs: NOW_MS,
    });
    await program.parseAsync(['agent-mission', 'metrics', '--since', absolute, '--json'], { from: 'user' });
    expect(JSON.parse(output).sinceMs).toBe(Date.parse(absolute));
  });

  it('기록 0 은 미션 없음이고 다섯 지표를 0 으로 채우지 않는다', () => {
    const empty = aggregateSupervisorMetrics([], { since: '7d', sinceMs: SINCE_MS });
    expect(empty.status).toBe('no-missions');
    expect(empty.missions).toBe(0);
    expect(empty.metrics).toHaveLength(5);
    for (const metric of empty.metrics) {
      expect(metric.status).toBe('no-missions');
      expect(metric.reason).toBe('미션 없음');
      expect(metric.value).toBeUndefined();
    }
  });

  it('주입한 logs.db 만 읽고 CLI 는 미션 없음에 exit 0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-mission-metrics-'));
    const path = join(dir, 'logs.db');
    const store = new LogStore(path, { instance: 'metrics-fixture' });
    const at = (ms: number) => new Date(ms).toISOString();
    store.insertBatch([
      { surface: 'agent-mission', rec: { ts: at(2_000), level: 'info', category: 'agent-mission', event: 'result', data: { ok: true, runId: 'db-1' } } },
      { surface: 'agent-mission', rec: { ts: at(2_100), level: 'debug', category: 'pty.decision', event: 'answer', data: { question: 'q?', answer: 'a' } } },
      { surface: 'agent-mission', rec: { ts: at(500), level: 'info', category: 'agent-mission', event: 'result', data: { ok: true, runId: 'old' } } },
    ]);
    store.close();

    const read = readSupervisorLogsFromStore(path);
    const report = aggregateSupervisorMetrics(read(SINCE_MS, NOW_MS), { since: '7d', sinceMs: SINCE_MS });
    expect(report.missions).toBe(1);
    expect(report.metrics.find((metric) => metric.id === 'questionsAnswered')).toMatchObject({
      status: 'unmeasured', reason: '못 잼 · 미션과 연결 불가',
    });
    expect(report.metrics.find((metric) => metric.id === 'stall')?.status).toBe('unmeasured');

    let output = '';
    const program = new Command().exitOverride();
    registerSupervisorMetricsCommand(program.command('agent-mission'), {
      read: () => [],
      write: (text) => { output += text; },
      nowMs: NOW_MS,
    });
    await program.parseAsync(['agent-mission', 'metrics', '--since', '7d', '--json'], { from: 'user' });
    const parsed = JSON.parse(output) as { status: string; missions: number; sinceMs: number };
    expect(parsed.status).toBe('no-missions');
    expect(parsed.missions).toBe(0);
    expect(parsed.sinceMs).toBe(NOW_MS - 7 * 86_400_000);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('연결되지 않은 질문·개입·멈춤·사다리 기록을 합산하지 않는다', () => {
    const extra = [
      row({ category: 'pty.decision', event: 'answer', data: { question: 'unrelated?' } }),
      row({ category: 'autopilot.control', event: 'end', data: { interventionLevel: 'nudge' } }),
      row({ category: 'self-implement', event: 'frame-stall', data: { rung: 2 } }),
      row({ category: 'agent-mission.resources', event: 'needs', data: { kind: 'VERIFY' } }),
    ];
    const report = aggregateSupervisorMetrics([...fixture(), ...extra], { since: '7d', sinceMs: SINCE_MS });
    expect(report.metrics[0]).toMatchObject({ id: 'completion', status: 'measured', value: '1/2' });
    for (const id of ['questionsAnswered', 'unnecessaryInterventions', 'stall', 'ladderHits']) {
      const metric = report.metrics.find((item) => item.id === id);
      expect(metric).toMatchObject({ status: 'unmeasured', reason: '못 잼 · 미션과 연결 불가' });
      expect(metric?.value).toBeUndefined();
    }
  });

  it('실제 미션 실행기의 PTY 결정과 결과를 기록한 뒤 기존 CLI가 질문 통과를 잰다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-mission-metrics-driver-'));
    const store = new LogStore(join(dir, 'logs', 'logs.db'));
    const sink = new StoreSink(store, 'agent-mission', { installExitHandlers: false });
    const off = debug.registerSink(sink);
    const restoreTiming = setAgentMissionTimingForTest({ readyQuietMs: 0, pollMs: 1, keystrokeGapMs: 0 });
    try {
      const mission = await runAgentMission({
        mission: 'Answer the question', repo: dir, branch: 'fixture', agent: claudeBackend,
        evidence: { kind: 'doc', dirRel: 'docs', glob: /output/ },
        memory: false, resources: 'off', commit: false, screensDir: join(dir, 'screens'),
      }, {
        createWorktree: (() => ({ path: dir, branch: 'fixture', base: 'HEAD' })) as never,
        recordWorktreeProvenance: () => {},
        checkClaudeSubscription: () => ({ ok: true, authMethod: 'claude.ai', apiProvider: 'firstParty', reason: 'subscription' }),
        startPty: ((opts) => ({ id: opts.id!, kind: 'claude', nickname: 'fixture', accessMode: 'auto',
          isAlive: () => true, canWrite: () => true, drainDelta: () => '', renderScreen: async () => 'Use the existing file?',
          renderScreenPng: async () => null, write: () => {}, kill: () => {},
        } as unknown as PtyHandle)),
        resolvePtyWebAddress: (() => ({ webUrl: null, webUrlSource: null, pwaUnavailableReason: 'test' })) as never,
        controlStream: async () => '{"action":"send","text":"yes","reason":"Answering question: Use the existing file?"}',
        runControlLoop: (async (brain: RunSupervisor, control: PtyControlDeps) => {
          const screen = 'Use the existing file?';
          const decision = await brain.decide({ screen, state: 'blocked', step: 0, changed: false,
            intervention: decideInterventionStep({ screen, previous: null, stopAfterSameScreens: 2,
              descriptor: { level: 'L3', controlStance: 'owned', draft: 'continue' } }),
          });
          expect(decision).toEqual({ action: 'input', text: 'yes\r' });
          if (decision.action !== 'input') throw new Error('expected input');
          expect(control.inject(decision.text)).toBe(true);
          return { termination: { kind: 'success' }, steps: 1 } as never;
        }) as never,
        checkEvidence: () => ({ ok: true, path: join(dir, 'docs', 'output.md') }),
      });
      expect(mission.ok).toBe(true);
      sink.flush();
      const records = store.queryAll({ exactCategories: ['agent-mission', 'pty.decision'] });
      const answer = records.find((record) => record.category === 'pty.decision' && record.event === 'answer');
      const result = records.find((record) => record.category === 'agent-mission' && record.event === 'result');
      const decisionData = JSON.parse(answer?.data ?? 'null') as { missionId: string; sessionId: string; runId?: string } | null;
      const resultData = JSON.parse(result?.data ?? 'null') as { runId: string } | null;
      expect(decisionData).not.toBeNull();
      expect(resultData).not.toBeNull();
      expect(decisionData?.sessionId).toBe(resultData?.runId);
      expect(decisionData?.missionId).not.toBe(resultData?.runId);
      // The driver supplies an ambient runId to the log sink; the CLI must use
      // the stored record rather than a hand-constructed identifier alias.
      expect(decisionData?.runId).toBe(resultData?.runId);

      let output = '';
      const program = new Command().exitOverride();
      registerSupervisorMetricsCommand(program.command('agent-mission'), {
        nowMs: Date.now(), read: readSupervisorLogsFromStore(store.path), write: (text) => { output += text; },
      });
      await program.parseAsync(['agent-mission', 'metrics', '--since', '7d', '--json'], { from: 'user' });
      const report = JSON.parse(output) as { missions: number; metrics: Array<{ id: string; status: string; value?: number }> };
      expect(report.missions).toBe(1);
      expect(report.metrics.find((metric) => metric.id === 'questionsAnswered')).toMatchObject({ status: 'measured', value: 1 });
    } finally {
      restoreTiming();
      off();
      sink.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('src/index.ts agentCmd 에 등록된 실제 metrics CLI 는 7d 미션만 읽고 미션에 못 잇는 질문은 못 잼으로 낸다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-mission-metrics-cli-'));
    const store = new LogStore(join(dir, 'logs', 'logs.db'));
    const now = Date.now();
    try {
      store.insertBatch([
        { surface: 'agent-mission', rec: { ts: new Date(now - 86_400_000).toISOString(), category: 'agent-mission', event: 'result', data: { ok: true, runId: 'recent' } } },
        { surface: 'agent-mission', rec: { ts: new Date(now - 86_400_000).toISOString(), category: 'pty.decision', event: 'answer', data: { question: 'Continue?', answer: 'yes' } } },
        { surface: 'agent-mission', rec: { ts: new Date(now - 8 * 86_400_000).toISOString(), category: 'agent-mission', event: 'result', data: { ok: false, runId: 'old' } } },
      ]);
      store.close();
      const result = Bun.spawnSync(['bun', resolve('bin/elanous.mjs'), `--test=${dir}`, 'agent-mission', 'metrics', '--since', '7d', '--json'], {
        cwd: resolve('.'), env: { ...process.env, ELANOUS_STATE_DIR: dir, ELANOUS_CONFIG_DIR: dir, NODE_ENV: 'test' },
        stdout: 'pipe', stderr: 'pipe',
      });
      if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
      const report = JSON.parse(new TextDecoder().decode(result.stdout));
      expect(report.missions).toBe(1);
      expect(report.metrics.find((metric: { id: string }) => metric.id === 'completion')).toMatchObject({ value: '1/1' });
      expect(report.metrics.find((metric: { id: string }) => metric.id === 'questionsAnswered')).toMatchObject({
        status: 'unmeasured', reason: '못 잼 · 미션과 연결 불가',
      });
      expect(report.sinceMs).toBeGreaterThan(now - 7 * 86_400_000 - 10_000);
      expect(report.sinceMs).toBeLessThanOrEqual(Date.now() - 7 * 86_400_000);
    } finally {
      try { store.close(); } catch { /* already closed */ }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
