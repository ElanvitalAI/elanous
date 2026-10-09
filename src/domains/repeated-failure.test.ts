import { describe, expect, test } from 'bun:test';
import type { LogStoreRow } from '../mss/logging/log-store.js';
import { detectRepeatedFailures, explainFailure, failureReason, normalizeReason } from './repeated-failure.js';
import { opsHealth } from './ops-status.js';
import { TaskStore } from '../task-orchestrator/store.js';

function row(index: number, category: string, event: string, reason: string, level = 'debug'): LogStoreRow {
  const ts = new Date(Date.parse('2026-09-28T06:00:00Z') + index * 10_000).toISOString();
  return {
    id: index + 1, ts, ts_ms: Date.parse(ts), level, instance: 'prod', surface: 'pwa',
    category, event, session_id: `session-${index}`, trace_id: null,
    data: JSON.stringify({ reason, sessionId: `session-${index}` }),
  };
}

function repeatedFailureFixture(): LogStoreRow[] {
  return [
    ...Array.from({ length: 25 }, (_, i) => row(
      i, i % 9 === 0 ? 'webterm.tabs.list.error' : i % 2 === 0 ? 'webterm.acp.close' : 'webterm.acp.handshake-failed',
      i % 9 === 0 ? 'error' : i % 2 === 0 ? 'close' : 'handshake-failed',
      `${i % 2 ? 'Error: ' : ''}socket closed: 1008: auth_failed`,
    )),
    ...Array.from({ length: 10 }, (_, i) => row(25 + i, 'webterm.acp.state', 'ready', 'socket closed: 1008: auth_failed', 'info')),
    ...Array.from({ length: 3 }, (_, i) => row(35 + i, 'webterm.acp.close', 'close', 'unrelated_failure')),
  ];
}

describe('repeated failure — failure shape rather than severity', () => {
  test('normalizes volatile IDs and codes, limits to 120 characters', () => {
    expect(normalizeReason('Error: socket closed: 1008: auth_failed')).toBe('Error: socket closed: #: auth_failed');
    expect(normalizeReason('id=123e4567-e89b-12d3-a456-426614174000 hash=deadbeef12345678 count=429')).toBe('id=# hash=# count=#');
    expect(normalizeReason('x'.repeat(200))).toHaveLength(120);
    expect(normalizeReason('token=ownerSecretAlpha9')).toBe('token=***');
  });

  test('non-failure rows and malformed data cannot qualify', () => {
    const failure = row(1, 'webterm.acp.close', 'close', 'socket closed: 1008: auth_failed');
    expect(failureReason(failure)).toBe('socket closed: 1008: auth_failed');
    expect(failureReason({ ...failure, event: 'handshake-failed', category: 'webterm.acp.state' })).toBe('socket closed: 1008: auth_failed');
    expect(failureReason({ ...failure, event: 'list', category: 'webterm.tabs.list.error' })).toBe('socket closed: 1008: auth_failed');
    expect(failureReason({ ...failure, event: 'state', category: 'webterm.acp.state' })).toBeNull();
    expect(failureReason({ ...failure, data: '{broken' })).toBeNull();
    expect(failureReason({ ...failure, data: JSON.stringify({ error: 'bad socket' }) })).toBe('bad socket');
    expect(failureReason({ ...failure, data: JSON.stringify({ message: 'connection lost' }) })).toBe('connection lost');
  });

  test('normal close reasons never create an alert, even at the health threshold', () => {
    const closes = Array.from({ length: 25 }, (_, i) => row(i, 'webterm.acp.close', 'close',
      i % 3 === 0 ? 'socket closed: 1000: normal closure' : i % 3 === 1 ? 'socket closed: 1001: going away' : 'client disconnected: normal closure'));
    expect(closes.every((entry) => failureReason(entry) === null)).toBe(true);
    expect(detectRepeatedFailures(closes)).toEqual([]);
    const store = new TaskStore({ path: ':memory:', noWal: true });
    try {
      const health = opsHealth({ recentLogs: () => closes, missionStore: store,
        listScheduleRows: () => [], opsDbPath: '/nonexistent/ops_events.db', mandate: null, graphLoopRuns: () => [] });
      expect(health.anomalies.filter((anomaly) => anomaly.kind === 'repeated_failure')).toEqual([]);
    } finally { store.close(); }
    expect(failureReason(row(26, 'webterm.acp.close', 'close', 'socket closed: 1008: auth_failed'))).not.toBeNull();
    expect(failureReason(row(27, 'webterm.acp.close', 'close', 'socket closed: 3000: custom'))).toBeNull();
    expect(failureReason({ ...row(28, 'webterm.acp.close', 'close', 'normal closure'),
      data: JSON.stringify({ error: 'normal closure' }) })).toBeNull();
  });

  test('owner-token guidance requires both the ACP socket area and failure event', () => {
    const matching = detectRepeatedFailures([row(0, 'webterm.acp.close', 'close', 'socket closed: 1008: auth_failed')], { threshold: 1 })[0]!;
    expect(explainFailure(matching)).toContain('연결 토큰 칸');
    const foreign = detectRepeatedFailures([row(1, 'payments.gateway.error', 'error', 'socket closed: 1008: auth_failed')], { threshold: 1 })[0]!;
    expect(explainFailure(foreign)).toContain('elanous logs --category payments.gateway');
    expect(explainFailure(foreign)).not.toContain('연결 토큰 칸');
    // Live 19:20 tick: the same ACP socket close surfaced through webterm.tabs list errors — same cause, same guidance.
    const tabs = detectRepeatedFailures([row(2, 'webterm.tabs.list.error', 'error', 'Error: socket closed: 1008: auth_failed')], { threshold: 1 })[0]!;
    expect(explainFailure(tabs)).toContain('연결 토큰 칸');
    const otherWebterm = detectRepeatedFailures([row(3, 'webterm.tabs.list.error', 'error', 'socket error: timeout')], { threshold: 1 })[0]!;
    expect(explainFailure(otherWebterm)).not.toContain('연결 토큰 칸');
  });

  test('25 debug failures across category shapes, Error prefix and session IDs yield only the ACP group', () => {
    const rows = repeatedFailureFixture();
    const groups = detectRepeatedFailures(rows, { threshold: 20 });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ area: 'webterm.acp', count: 22, reason: 'socket closed: #: auth_failed' });
    // Lower threshold makes other areas and causes visible without merging them.
    expect(detectRepeatedFailures(rows, { threshold: 3 }).map((g) => [g.area, g.count]))
      .toEqual([['webterm.acp', 22], ['webterm.acp', 3], ['webterm.tabs', 3]]);
    expect(explainFailure(groups[0]!)).toContain('소유자 토큰');
    expect(explainFailure(groups[0]!)).toContain('연결 토큰 만들기');
    expect(explainFailure(groups[0]!)).toContain('만료');
    expect(explainFailure(groups[0]!)).not.toContain('토큰이 없어');
  });

  test('unknown causes give a duration, count and log query without leaking a token value', () => {
    const firstTs = new Date(Date.now() - 8 * 60_000).toISOString();
    const lastTs = new Date(Date.now() - 7 * 60_000).toISOString();
    const group = detectRepeatedFailures([
      { ...row(0, 'webterm.acp.close', 'close', 'socket failed token=ownerSecretAlpha9'), ts: firstTs, ts_ms: Date.parse(firstTs) },
      { ...row(7, 'webterm.acp.close', 'close', 'socket failed token=ownerSecretBeta8'), ts: lastTs, ts_ms: Date.parse(lastTs) },
    ], { threshold: 2 })[0]!;
    expect(group.count).toBe(2);
    expect(group.reason).toBe('socket failed token=***');
    expect(explainFailure(group)).toMatch(/^webterm\.acp 가 1분에 2번 같은 사유로 실패: socket failed token=\*\*\* — `elanous logs --category webterm\.acp --since (8|9)m` 로 본다$/);
  });

  test('opsHealth surfaces ≥20 debug failures as one redacted actionable anomaly', () => {
    const rows = repeatedFailureFixture();
    const recentLogs = () => rows;
    const store = new TaskStore({ path: ':memory:', noWal: true });
    try {
      const report = opsHealth({ recentLogs, missionStore: store, listScheduleRows: () => [],
        opsDbPath: '/nonexistent/ops_events.db', mandate: null, graphLoopRuns: () => [] });
      const repeated = report.anomalies.filter((a) => a.kind === 'repeated_failure');
      expect(repeated).toHaveLength(1);
      expect(repeated[0]?.entity).toContain('webterm.acp');
      expect(repeated[0]?.detail).toContain('소유자 토큰');
      expect(repeated[0]?.detail).toContain('연결 토큰 칸');
      expect(repeated[0]?.since).toBe(rows[1]?.ts);
    } finally { store.close(); }
  });
});

describe('review must-fix — transport close codes', () => {
  test('counts ECONNRESET and «connection reset by peer» closes as failures, but not a normal closure', () => {
    expect(failureReason(row(1, 'webterm.acp.close', 'close', 'read ECONNRESET'))).toBe('read ECONNRESET');
    expect(failureReason(row(2, 'webterm.acp.close', 'close', 'connection reset by peer'))).toBe('connection reset by peer');
    expect(failureReason(row(3, 'webterm.acp.close', 'close', 'normal closure'))).toBeNull();
    const rows = Array.from({ length: 20 }, (_, i) => row(10 + i, 'webterm.acp.close', 'close', 'read ECONNRESET'));
    expect(detectRepeatedFailures(rows, { threshold: 20 }).map((g) => g.count)).toEqual([20]);
  });
});
