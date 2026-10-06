import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import { LogStore } from '../mss/logging/log-store.js';
import { parseSince } from '../cli/logs-cli.js';
import { registerSupervisorMetricsCommand } from './supervisor-metrics-cli.js';
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
    row({ category: 'pty.decision', event: 'answer', data: { missionId: 'm1', step: 'answer', question: 'Trust?', answer: 'yes' } }),
    row({ category: 'pty.decision', event: 'answer', data: { missionId: 'm2', step: 'answer', question: 'Continue?', answer: 'go' } }),
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

  it('실제 CLI 는 임시 logs.db 의 하루 전 미션만 --since 7d 에 넣고 8일 전 미션은 뺀다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-mission-metrics-cli-'));
    const store = new LogStore(join(dir, 'logs', 'logs.db'));
    const now = Date.now();
    try {
      store.insertBatch([
        { surface: 'agent-mission', rec: { ts: new Date(now - 86_400_000).toISOString(), category: 'agent-mission', event: 'result', data: { ok: true, runId: 'recent' } } },
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
      expect(report.sinceMs).toBeGreaterThan(now - 7 * 86_400_000 - 10_000);
      expect(report.sinceMs).toBeLessThanOrEqual(Date.now() - 7 * 86_400_000);
    } finally {
      try { store.close(); } catch { /* already closed */ }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
