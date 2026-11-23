// HQ-PTY-BUDGET-GUARD 칸(#130253/#130442 계기) focused 시험 — 합성 원장 점유(가짜 ptmx 상한)로
// 호스트 예산 가드 계약 고정. 칸 완료선: «85% 상한에서 새 PTY 발급 거부 + 고아 보유자 회수 1건(합성 주입) 실측».
//
// RED: 초크포인트 배선 부재 상태에서 ①자리 발급 거부 ②하니스 자식 발급 거부 ③고아 회수-후-허용 이 실패해야 한다.
// 격리: 전용 ELANOUS_STATE_DIR·전용 manifest db(pty-manifest.test.ts 양식)·stub adapter(실 PTY 0개)·
// ELANOUS_PTY_HOST_BUDGET afterAll 원복. 시험 기대값은 제품 상수 import 없이 시험 안 리터럴(독립 원칙).
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StartOpts } from './registry.js';

const previousStateDir = process.env.ELANOUS_STATE_DIR;
const previousBudgetEnv = process.env.ELANOUS_PTY_HOST_BUDGET;
const stateDir = mkdtempSync(join(tmpdir(), 'pty-budget-guard-'));
process.env.ELANOUS_STATE_DIR = stateDir;

const { getPtyManifest, isProcessAlive, listPtyManifestRows, setPtyManifestDbPathForTesting, upsertPtyManifest } = await import('./pty-manifest.js');
const { readPtyEventsAfter, resetPtyEventLogForTesting } = await import('./pty-event-log.js');
const { resetForTesting, setPtyAdapterForTesting, setPtyManifestEnabledForTesting, startPty } = await import('./registry.js');
const { decidePtyBudgetGuard, parsePtyHostBudgetEnv } = await import('./pty-budget-guard.js');

/** 스텁 PTY 어댑터 — 실 openpty 없이 startPty 초크포인트를 지난다(registry.test.ts stubAdapter 양식). */
function stubAdapter() {
  return {
    pid: 1, // 출처: #130442 — 스텁 pid(관례: registry.test.ts stubAdapter)·liveness 프로브에 살아있는 값
    write() {}, kill() {},
    onData: () => ({ dispose() {} }),
    onExit: () => ({ dispose() {} }),
  };
}

/** 합성 라이브 점유 행 — ptyPid 0 → 소유자(process.pid) 생존 판정 계약(reapDeadPtyManifest 의 pty_pid>0 ? pty-pid : owner-pid
 *  분기)으로 가드의 회수 단계에서 살아남는다. */
function injectSyntheticLiveRow(id: string): void {
  upsertPtyManifest({
    id,
    kind: 'shell',
    cmd: 'synthetic-occupancy',
    purpose: 'synthetic-occupancy',
    startedAt: Date.now(),
    now: Date.now(),
    ptyPid: 0, // 출처: #130442 — owner-pid 생존 판정 행(죽지 않는 합성 점유)
  });
}

/** 확실히 죽은 pid — 존재 가능성이 없는 상수(운영 pid 상한 위) 합성: 실 프로세스 스폰 없이 확정 죽은 행
 * (R-LIVE10 — 시험의 새 직접 spawn 은 동결 목록만 허용). 생존 프로브가 «살아있다»고 보면 계약 위반이라 즉시 실패한다. */
const CERTAINLY_DEAD_PID = 8388608; // 출처: #130442 — Linux pid_max(4194304)·macOS(99998) 위 합성 pid(스폰 없는 죽은 행)
async function certainlyDeadPid(): Promise<number> {
  if (isProcessAlive(CERTAINLY_DEAD_PID)) throw new Error('synthetic orphan fixture: constant dead pid unexpectedly reports alive');
  return CERTAINLY_DEAD_PID;
}

function liveRowCount(): number {
  return listPtyManifestRows().filter((row) => row.alive).length;
}

beforeEach(() => {
  setPtyManifestDbPathForTesting(join(mkdtempSync(join(stateDir, 'store-')), 'pty', 'manifest.db'));
  resetPtyEventLogForTesting();
  setPtyManifestEnabledForTesting(true);
  setPtyAdapterForTesting(() => stubAdapter());
  resetForTesting();
  process.env.ELANOUS_PTY_HOST_BUDGET = '4'; // 합성 ptmx 상한 4슬롯(시험 설계 — 문자열 env 값)
});

afterEach(() => {
  resetForTesting();
  setPtyAdapterForTesting(null);
  setPtyManifestEnabledForTesting(null);
});

afterAll(() => {
  setPtyManifestDbPathForTesting(null);
  resetPtyEventLogForTesting();
  if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = previousStateDir;
  if (previousBudgetEnv === undefined) delete process.env.ELANOUS_PTY_HOST_BUDGET;
  else process.env.ELANOUS_PTY_HOST_BUDGET = previousBudgetEnv;
});

describe('순수 평가기 decidePtyBudgetGuard — 주입형 입력(제품 상수 import 금지)', () => {
  test('점유 3/상한 4: 다음 발급이 4/4=100% ≥ 85% 라 거부(예약-1)', () => {
    const decision = decidePtyBudgetGuard({ occupied: 3, capacity: 4, denyAtPct: 85 }); // 출처: #130442 — 합성 슬롯(칸 완료선 «3슬롯 점유 시 거부»)
    expect(decision.verdict).toBe('deny');
    expect(decision.passive).toBe(false);
    expect(decision.projectedOccupied).toBe(4); // 출처: #130442 — 3+1 예약-1
    expect(decision.projectedPct).toBe(100); // 출처: #130442 — 4/4 백분율
    expect(decision.denyReason).toContain('85'); // 출처: #130442 — 칸 원문 임계가 거부 문구에
    expect(decision.denyReason).toContain('4/4'); // 출처: #130442 — 투영 점유 표시
  });

  test('점유 2/상한 4: 투영 3/4=75% < 85% 라 허용', () => {
    const decision = decidePtyBudgetGuard({ occupied: 2, capacity: 4, denyAtPct: 85 }); // 출처: #130442 — 합성 슬롯
    expect(decision.verdict).toBe('allow');
    expect(decision.projectedPct).toBe(75); // 출처: #130442 — 3/4 백분율
    expect(decision.denyReason).toBeNull();
  });

  test('17/20=85% 경계를 정수 교차곱으로 정확히 잡는다(부동소수 함정 회피)', () => {
    const atBoundary = decidePtyBudgetGuard({ occupied: 16, capacity: 20, denyAtPct: 85 }); // 출처: #130442 — 17/20=85% 경계 합성
    expect(atBoundary.verdict).toBe('deny');
    expect(atBoundary.projectedPct).toBe(85); // 출처: #130442 — 경계값 그대로
    const belowBoundary = decidePtyBudgetGuard({ occupied: 15, capacity: 20, denyAtPct: 85 }); // 출처: #130442 — 16/20=80% 합성
    expect(belowBoundary.verdict).toBe('allow');
    expect(belowBoundary.projectedPct).toBe(80); // 출처: #130442 — 경계 직전
  });

  test('점유가 상한을 이미 넘으면 항상 거부', () => {
    const decision = decidePtyBudgetGuard({ occupied: 5, capacity: 4, denyAtPct: 85 }); // 출처: #130442 — 초과 상태 합성
    expect(decision.verdict).toBe('deny');
  });

  test('상한 0(미무장)은 수동 — 점유가 있어도 통과', () => {
    const decision = decidePtyBudgetGuard({ occupied: 3, capacity: 0, denyAtPct: 85 }); // 출처: #130442 — 미무장 합성
    expect(decision.verdict).toBe('allow');
    expect(decision.passive).toBe(true);
  });
});

describe('ELANOUS_PTY_HOST_BUDGET 해석 parsePtyHostBudgetEnv', () => {
  test('양의 정수만 무장 — 나머지는 0(수동)', () => {
    expect(parsePtyHostBudgetEnv('4')).toBe(4); // 출처: #130442 — 합성 상한
    expect(parsePtyHostBudgetEnv(undefined)).toBe(0); // 출처: #130442 — 미설정=수동
    expect(parsePtyHostBudgetEnv('')).toBe(0); // 출처: #130442 — 빈값=수동
    expect(parsePtyHostBudgetEnv('abc')).toBe(0); // 출처: #130442 — 파손=수동
    expect(parsePtyHostBudgetEnv('-1')).toBe(0); // 출처: #130442 — 음수=수동
    expect(parsePtyHostBudgetEnv('4.5')).toBe(0); // 출처: #130442 — 소수=수동
  });
});

describe('초크포인트 배선 — 실 startPty 발급 가드(합성 원장 점유 · 완료 경계)', () => {
  test('① 자리(els 홀더) 경로: 점유 3/상한 4 → 새 발급 거부 + 감사 1줄 + 원장 무오염', () => {
    injectSyntheticLiveRow('shell_11aa22bb');
    injectSyntheticLiveRow('shell_33cc44dd');
    injectSyntheticLiveRow('shell_55ee66ff');
    expect(liveRowCount()).toBe(3); // 출처: #130442 — 합성 점유 3슬롯
    let thrown: unknown = null;
    try {
      startPty({ id: 'shell_77ee88ff', kind: 'shell', cmd: 'x', purpose: 'els-pane', seat: 'holder-seat', workdir: stateDir, detach: true } as StartOpts);
    } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).toContain('85'); // 출처: #130442 — 칸 원문 임계가 거부 문구에
    expect(String(thrown)).toContain('4/4'); // 출처: #130442 — 투영 점유 표시
    // 거부 감사 1줄 — pty_events lifecycle 채널(합성 우주 안)
    const events = readPtyEventsAfter(0, { surfaceId: 'shell_77ee88ff', kind: 'lifecycle' }); // 출처: #130442 — seq 0부터 전체
    expect(events).toHaveLength(1); // 출처: #130442 — 감사 1줄(칸② 계약)
    const [auditEvent] = events;
    const payload = JSON.parse(auditEvent?.payload ?? '{}') as Record<string, unknown>;
    expect(payload.event).toBe('budget-denied');
    expect(payload.occupied).toBe(3); // 출처: #130442 — 합성 점유
    expect(payload.projectedOccupied).toBe(4); // 출처: #130442 — 예약-1
    // 거부된 발급은 원장에 라이브 행을 남기지 않는다
    expect(liveRowCount()).toBe(3); // 출처: #130442 — 점유 불변(거부 부작용 0)
  });

  test('② 하니스 자식(headless 코딩 에이전트) 경로: 같은 초크포인트에서 거부', () => {
    injectSyntheticLiveRow('shell_11aa22bb');
    injectSyntheticLiveRow('shell_33cc44dd');
    injectSyntheticLiveRow('shell_55ee66ff');
    expect(() => startPty({ cmd: 'claude', args: ['-p'], workdir: stateDir } as StartOpts)).toThrow(/pty host budget guard/);
    expect(liveRowCount()).toBe(3); // 출처: #130442 — 거부 후 점유 불변
  });

  test('③ 고아 보유자 회수: 죽은 pid 미반납 행 1건 합성 주입 → 회수(alive=0) 후 발급 허용', async () => {
    const deadPid = await certainlyDeadPid();
    injectSyntheticLiveRow('shell_11aa22bb');
    injectSyntheticLiveRow('shell_33cc44dd');
    upsertPtyManifest({
      id: 'shell_99ff0011',
      kind: 'shell',
      cmd: 'synthetic-orphan',
      purpose: 'synthetic-orphan',
      startedAt: Date.now(),
      now: Date.now(),
      ptyPid: deadPid, // 합성 고아 — 소유 pty 프로세스 사망 후 미반납(11-22 사건 형태의 원장 흔적)
    });
    expect(liveRowCount()).toBe(3); // 출처: #130442 — 회수 전 점유 3(라이브 2 + 고아 1)
    const handle = startPty({ id: 'shell_77ee88ff', kind: 'shell', cmd: 'x', workdir: stateDir, detach: true } as StartOpts);
    expect(handle.id).toBe('shell_77ee88ff');
    // 고아 보유자 회수 1건 실측 — 톰스톤(alive=0)
    const orphan = getPtyManifest('shell_99ff0011');
    expect(orphan?.alive).toBe(false); // 출처: #130442 — 고아 회수 실측(칸 완료선)
    // 회수로 점유 3→2 → 투영 3/4=75% < 85% → 허용(새 발급 행까지 라이브 3)
    expect(liveRowCount()).toBe(3); // 출처: #130442 — 라이브 2 + 새 발급 1
  });

  test('④ 미만(점유 2/상한 4 → 투영 75%) 허용', () => {
    injectSyntheticLiveRow('shell_11aa22bb');
    injectSyntheticLiveRow('shell_33cc44dd');
    const handle = startPty({ id: 'shell_77ee88ff', kind: 'shell', cmd: 'x', workdir: stateDir, detach: true } as StartOpts);
    expect(handle.id).toBe('shell_77ee88ff');
    expect(liveRowCount()).toBe(3); // 출처: #130442 — 합성 2 + 새 발급 1
  });

  test('⑤ 미무장(ENV 없음)은 종전 동작 — 점유 3이어도 발급 허용', () => {
    delete process.env.ELANOUS_PTY_HOST_BUDGET;
    injectSyntheticLiveRow('shell_11aa22bb');
    injectSyntheticLiveRow('shell_33cc44dd');
    injectSyntheticLiveRow('shell_55ee66ff');
    const handle = startPty({ id: 'shell_77ee88ff', kind: 'shell', cmd: 'x', workdir: stateDir, detach: true } as StartOpts);
    expect(handle.id).toBe('shell_77ee88ff');
  });
});
