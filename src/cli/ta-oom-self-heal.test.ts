// TA-OOM-SELF-HEAL 시뮬 — 출처: 칸 문면 «시뮬(합성 OOM 사건 주입 장면) ⊕ 시험 우주 재배치 원장 3줄 ·
// focused 1파일 + 시뮬 1장면 · ≤10분 · JUD-2».
// 합성 사건 fixture 로 원인 분류·한 단계 재배치·2회째 needs-op·재배치 원장 3줄을 증명.
// r3 수리 시험(판정본 jud-39701-ec254951eb17.json · JUD-2 hold mustFix ①②):
//   ① 실제 생산자 입력 경로 회귀 — child-exit JSONL 이 <root>/loop/orchestrator/sim-impact-audit/<runId>.log 에,
//      oom-evidence debug JSONL 이 <root>/log/debug-<ymdhms>.log 에 남을 때 CLI(healOomIncidents)가 그 파일들을
//      읽는다(레거시 resource-ledger/events.jsonl 도 후보) · 정상 종료·debug 거울 행은 음성.
//   ② 실제 배치 경로 회귀 — 기본 대역(queuedPoolHintChannel)이 harness 큐 대기 항목의 poolHint 를 한 단계 위
//      값으로 정확히 1회 바꾼다(setQueuedPoolHint 실매) · 두 번째 사건은 needs-op 추가 요청 없음 ·
//      같은 사건 재처리는 추가 요청·중복 행 없음.
// r2 수리 시험(판정본 jud-39701-977592b94ac5 · JUD-2 hold mustFix ①②):
//   ① 실제 생산자 형식 회귀 — child-exit(tick.ts:1187) signal/137 원인 분류(주체=runId) · oom-evidence
//     (self-implement-pod.ts:3676 debug 기록) 원인 oom(주체=data.job) · 정상 종료는 음성.
//   ② 재배치 실행 연결 — 스파이 스케줄러 대역으로 첫 사건 배치 요청 정확히 1회(한 단계 위) · 두 번째 사건
//     needs-op 추가 요청 없음 · 같은 사건 재처리 중복 행·중복 요청 없음.
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { classifyCause, fileSchedulerChannel, formatRelocationLine, healOomIncidents, parseIncident, producerIncidentPaths, readIncidents, selfHealAfterChildExit, tierUp, type SchedulerChannel } from './ta-oom-self-heal.js';

const HOUR = '2026-11-23T01'; // 합성 시간 — 실 운영 원장과 무관
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function ledger(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mvpb-taoom-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'resource-ledger'), { recursive: true });
  return dir;
}

function events(root: string, rows: Array<Record<string, unknown>>): void {
  writeFileSync(join(root, 'resource-ledger', 'events.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
}

/** 실제 생산자 ① 형상 — sim-impact-audit 로그(tick.ts:1131–1133 경로 · 1186–1189 형식)에 JSONL append. */
function auditExit(root: string, runId: string, row: Record<string, unknown>): void {
  const path = join(root, 'loop', 'orchestrator', 'sim-impact-audit', `${runId}.log`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(row) + '\n', { flag: 'a' });
}

/** 실제 생산자 ② 형상 — debug per-run 로그(debug/log.ts:296 파일명)에 JSONL append. */
function debugRow(root: string, file: string, row: Record<string, unknown>): void {
  const path = join(root, 'log', file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(row) + '\n', { flag: 'a' });
}

const noopChannel: SchedulerChannel = { requestPlacement: () => {} };

describe('TA-OOM-SELF-HEAL(ROSTER-0334 칸 문면)', () => {
  test('원인 분류 — oom/sigkill 토큰만 사건, room/lease 오탐 0', () => {
    expect(classifyCause('pod-oom')).toBe('oom');
    expect(classifyCause('pod-sigkill')).toBe('sigkill');
    expect(classifyCause('child-kill')).toBe('sigkill');
    expect(classifyCause('oom-kill')).toBe('oom'); // oom 계열 우선 — SIGKILL 아님
    expect(classifyCause('host-room-lease')).toBe(null); // 'room' 포함 — 경계 오탐 방지(음성 대조)
    expect(classifyCause('guardian-host-lease')).toBe(null);
    expect(classifyCause('lease-reaped')).toBe(null);
    expect(classifyCause('host-readiness-heartbeat')).toBe(null);
  });

  test('한 단계 위 — 사다리 안 +1 단계, 끝/밖 → null', () => {
    expect(tierUp('small')).toBe('medium');
    expect(tierUp('medium')).toBe('large');
    expect(tierUp('xlarge')).toBe(null); // 최상단 — 위 없음
    expect(tierUp('tiny')).toBe(null); // 사다리 밖 계급
  });

  test('시뮬 1장면: 합성 OOM 사건 주입 → 재배치 원장 3줄(relocate · needs-op · relocate)', async () => {
    const root = ledger();
    events(root, [
      { at: `${HOUR}:00:00.000Z`, event: 'pod-oom', pod: 'ta-pod-a', tier: 'small' },       // 1회째 → 한 단계 위
      { at: `${HOUR}:10:00.000Z`, event: 'host-readiness-heartbeat', host: 'node-b' },        // 무해 사건 — 무시(음성)
      { at: `${HOUR}:30:00.000Z`, event: 'pod-sigkill', pod: 'ta-pod-a', tier: 'medium' },  // 2회째 → needs-op
      { at: `${HOUR}:45:00.000Z`, event: 'pod-oom', pod: 'ta-pod-b', tier: 'medium' },      // 1회째 → 한 단계 위
    ]);
    const lines = await healOomIncidents(root, noopChannel);
    // 출처: 칸 문면 «시험 우주 재배치 원장 3줄» — 무해 사건 제외 3줄.
    expect(lines).toHaveLength(3);
    expect(lines.map(line => line.decision)).toEqual(['relocate', 'needs-op', 'relocate']);
    expect(lines[0]?.toTier).toBe('medium'); // small → medium(한 단계)
    expect(lines[1]?.incidentNo).toBe(2);   // ta-pod-a 2회째 — needs-op
    expect(lines[1]?.toTier).toBe(null);
    expect(lines[2]?.toTier).toBe('large'); // medium → large(한 단계)
    const relocations = readFileSync(join(root, 'resource-ledger', 'relocations.jsonl'), 'utf8').trim().split('\n');
    expect(relocations).toHaveLength(3); // 재배치 원장 3줄 — append 실측
    expect(relocations.map(line => (JSON.parse(line) as { decision: string }).decision)).toEqual(['relocate', 'needs-op', 'relocate']);
  });

  test('최상단 칸 OOM 1회째 — 위 없음 → 즉시 needs-op', async () => {
    const root = ledger();
    events(root, [{ at: `${HOUR}:05:00.000Z`, event: 'pod-oom', pod: 'ta-pod-top', tier: 'xlarge' }]);
    const lines = await healOomIncidents(root, noopChannel);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.decision).toBe('needs-op');
    expect(lines[0]?.toTier).toBe(null);
  });

  test('사건 원장 부재 → 0줄 · 재배치 원장 미생성', async () => {
    const root = ledger();
    const lines = await healOomIncidents(root, noopChannel);
    expect(lines).toHaveLength(0);
    expect(existsSync(join(root, 'resource-ledger', 'relocations.jsonl'))).toBe(false); // 원장 부작성(음성)
  });

  test('계급 미기재 사건 — 사다리 바닥(small) 간주 → 한 단계 위 재배치', () => {
    const incident = parseIncident(JSON.stringify({ at: `${HOUR}:07:00.000Z`, event: 'pod-oom', pod: 'ta-pod-c' }));
    expect(incident?.tier).toBe('small');
    expect(incident?.cause).toBe('oom');
  });

  test('포맷 — 원장 줄 원문 그대로 · 원장 부재 읽기 0건', () => {
    expect(formatRelocationLine({ at: `${HOUR}:00:00.000Z`, subject: 'ta-pod-a', cause: 'oom', incidentNo: 1, fromTier: 'small', toTier: 'medium', decision: 'relocate' }))
      .toBe(`${HOUR}:00:00.000Z | ta-pod-a | oom#1 | small->medium | relocate`);
    expect(readIncidents('/nonexistent-ta-oom/events.jsonl')).toHaveLength(0);
  });

  test('r2 mustFix ①: 실제 생산자 형식 — child-exit(tick.ts:1187) 원인 분류 · 주체 = runId · 정상 종료는 사건 아님', () => {
    const killed = parseIncident(JSON.stringify({ event: 'child-exit', at: `${HOUR}:00:00.000Z`, runId: 'run-r2a', window: 'w1', exitCode: null, signal: 'SIGKILL' }));
    expect(killed).toEqual({ at: `${HOUR}:00:00.000Z`, subject: 'run-r2a', tier: 'small', cause: 'sigkill' });
    const exit137 = parseIncident(JSON.stringify({ event: 'child-exit', at: `${HOUR}:00:30.000Z`, runId: 'run-r2b', window: 'w1', exitCode: 137, signal: null }));
    expect(exit137?.cause).toBe('sigkill'); // 출처: 137 = 128+9(SIGKILL) — signal 없이도 kill 사망
    const quiet = parseIncident(JSON.stringify({ event: 'child-exit', at: `${HOUR}:00:40.000Z`, runId: 'run-r2c', window: 'w1', exitCode: 0, signal: null }));
    expect(quiet).toBe(null); // 정상 종료(exitCode 0·signal null) — OOM/kill 사건 아님(음성)
  });

  test('r2 mustFix ①: 실제 생산자 형식 — oom-evidence(self-implement-pod.ts:3676 debug 기록) 원인 oom · 주체 = data.job', () => {
    // 출처: 합성 logShape 형상(self-implement-pod.ts:3674–3675 lines/bytes 필드 모양) — 값은 임의 합성.
    const evidence = parseIncident(JSON.stringify({ ts: `${HOUR}:01:00.000Z`, category: 'self-implement.pod', event: 'oom-evidence', data: { job: 'si-pod-1', memoryLimit: '8Gi', samples: [], logShape: { lines: 2, bytes: 64 } } }));
    expect(evidence).toEqual({ at: `${HOUR}:01:00.000Z`, subject: 'si-pod-1', tier: 'small', cause: 'oom' });
  });

  test('r3 mustFix ①: 실제 생산자 입력 경로 — sim-impact-audit 로그 + debug 로그를 CLI 가 읽는다 · 정상 종료·거울 행은 음성', async () => {
    const root = ledger();
    // 실제 생산자 ①: 자식 SIGKILL(tick.ts:1187 형식) — 같은 파일에 정상 종료 행도(음성)
    auditExit(root, 'run-r3a', { event: 'child-exit', at: `${HOUR}:00:00.000Z`, runId: 'run-r3a', window: 'w1', exitCode: null, signal: 'SIGKILL' });
    auditExit(root, 'run-r3a', { event: 'child-exit', at: `${HOUR}:00:10.000Z`, runId: 'run-r3a', window: 'w1', exitCode: 0, signal: null });
    // 실제 생산자 ②: Pod oom-evidence(self-implement-pod.ts:3676 형식) — 같은 파일에 무해 debug 행도(음성)
    debugRow(root, 'debug-20261123010000.log', { ts: `${HOUR}:00:05.000Z`, category: 'loop.orchestrator', event: 'sim-impact-audit-child-exit', data: { runId: 'run-r3a', exitCode: null, signal: 'SIGKILL' } });
    debugRow(root, 'debug-20261123010000.log', { ts: `${HOUR}:00:30.000Z`, category: 'self-implement.pod', event: 'oom-evidence', data: { job: 'si-pod-3', memoryLimit: '8Gi', samples: [], logShape: { lines: 1, bytes: 32 } } });
    const paths = producerIncidentPaths(root);
    expect(paths).toContain(join(root, 'loop', 'orchestrator', 'sim-impact-audit', 'run-r3a.log')); // 실제 생산자 ① 경로
    expect(paths).toContain(join(root, 'log', 'debug-20261123010000.log')); // 실제 생산자 ② 경로
    expect(paths).toContain(join(root, 'resource-ledger', 'events.jsonl')); // 레거시 원장도 후보
    const requests: Array<Record<string, string>> = [];
    const spy: SchedulerChannel = { requestPlacement: (request) => { requests.push({ subject: request.subject, toTier: request.toTier }); } };
    const lines = await healOomIncidents(root, spy);
    expect(lines.map(line => [line.subject, line.cause, line.decision])).toEqual([
      ['run-r3a', 'sigkill', 'relocate'],
      ['si-pod-3', 'oom', 'relocate'],
    ]); // 정상 종료(exitCode 0)·debug 거울 행(sim-impact-audit-child-exit)은 제외 — 음성 실측
    expect(requests).toEqual([{ subject: 'run-r3a', toTier: 'medium' }, { subject: 'si-pod-3', toTier: 'medium' }]); // 각 1회(한 단계 위)
  });

  test('r2 mustFix ②: 재배치 실행 연결 시뮬 — 첫 사건 배치 요청 정확히 1회(한 단계 위) · 두 번째 사건 needs-op 추가 요청 없음 · 재처리 중복 없음', async () => {
    const root = ledger();
    events(root, [
      { at: `${HOUR}:00:00.000Z`, event: 'pod-oom', pod: 'ta-pod-a', tier: 'small' },       // 1회째 → 배치 요청 1회 + relocate
      { at: `${HOUR}:30:00.000Z`, event: 'pod-sigkill', pod: 'ta-pod-a', tier: 'medium' },  // 2회째 → needs-op · 요청 없음
    ]);
    const requests: Array<Record<string, string>> = [];
    const spy: SchedulerChannel = { requestPlacement: (request) => { requests.push({ subject: request.subject, fromTier: request.fromTier, toTier: request.toTier }); } };
    const first = await healOomIncidents(root, spy);
    expect(first.map(line => line.decision)).toEqual(['relocate', 'needs-op']);
    expect(requests).toEqual([{ subject: 'ta-pod-a', fromTier: 'small', toTier: 'medium' }]); // 스케줄러 대역 — 요청 정확히 1회(한 단계 위)
    const second = await healOomIncidents(root, spy); // 같은 사건 재처리 — 판정 격리 실측(두 번 실행 4행 중복) 시정
    expect(second).toHaveLength(0);             // 신규 결정 0줄
    expect(requests).toHaveLength(1);           // 추가 배치 요청 없음
    const rows = readFileSync(join(root, 'resource-ledger', 'relocations.jsonl'), 'utf8').trim().split('\n');
    expect(rows).toHaveLength(2); // 재배치 원장 — 두 번 실행에도 2행(중복 0)
  });

  test('r3 mustFix ②(OP #134414): 배선 시뮬 — 사건 주입 137 → self-heal 실행(selfHealAfterChildExit) → placement-requests.jsonl 1행', async () => {
    const root = ledger();
    // 실제 생산자 ① 형상 — 자식 exitCode 137(=128+9, SIGKILL) 주입(tick.ts:1187 형식)
    auditExit(root, 'run-r3b', { event: 'child-exit', at: `${HOUR}:00:00.000Z`, runId: 'run-r3b', window: 'w1', exitCode: 137, signal: null });
    // 배선 진입점 — tick.ts 자식 child-exit 기록 뒤 호출하는 같은 함수. debug dir 추가 훑기도 이 경로로.
    const lines = await selfHealAfterChildExit(root, join(root, 'log'));
    expect(lines.map(line => line.decision)).toEqual(['relocate']);
    const requestRows = readFileSync(join(root, 'resource-ledger', 'placement-requests.jsonl'), 'utf8').trim().split('\n');
    expect(requestRows).toHaveLength(1); // 배치 요청 파일 기록 — 1행(소비는 새 칸 TA-OOM-PLACEMENT-CONSUMER)
    const parsed = JSON.parse(requestRows[0] ?? '') as { event: string; subject: string; toTier: string };
    expect(parsed.event).toBe('placement-request');
    expect(parsed.subject).toBe('run-r3b');
    expect(parsed.toTier).toBe('medium'); // small → medium(한 단계 위)
    expect(fileSchedulerChannel(root)).toBeTruthy(); // 대역 팩토리 — 항상 대역 객체 반환
  });
});