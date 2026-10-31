import { afterAll, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prodInstanceRoot } from '../instance/resolve.js';
import { isInsideOpsRoot, setOpsRootsForTesting } from '../instance/test-write-guard.js';
import { recordDoctorComparison } from './doctor-visit.js';
// 새 typed 거부 오류는 네임스페이스로 꺼낸다 — named import 면 그 export 가 아직 없는 트리에서
// 파일 전체가 로드 실패해 다른 시험까지 못 돈다(run-ledger.test.ts 의 같은 규율).
import * as doctorVisitModule from './doctor-visit.js';
import { runLedgerPath, RunLedgerCheckedAppendRunIdMismatchError } from './run-ledger.js';
import * as runLedgerModule from './run-ledger.js';

// R-TST23: mock.module()은 process-wide 레지스트리를 바꾸며 mock.restore()는 이를 되돌리지 않는다.
// 원본 스냅샷을 afterAll 마지막 mock.module()로 되돌려 이후 파일이 오염되지 않게 한다.
const originalRunLedger = { ...runLedgerModule };
afterAll(() => {
  mock.module('./run-ledger.js', () => originalRunLedger);
});

// ⛔ 이 블록은 mock 을 «쓰지 않는다» — 생산 진입점 recordDoctorComparison 이 실제 appendRunLedgerEntryChecked
// 를 지나며 원장 «바이트»·잠금 디렉터리·행 수를 직접 관측한다. mock 블록보다 앞에 둬 레지스트리가 깨끗한
// 상태에서 돈다.
describe('RUN-DOCTOR-LIVE-QUALITY-FU — 실제 checked append 경로가 typed identity 를 하류까지 보존한다', () => {
  const RUN_ID = 'run-0a1b2c3d-4e5f-4a7b-8c9d-0e1f2a3b4c5d';
  const OTHER_RUN_ID = 'run-ffffffff-0000-4000-8000-000000000000';
  const JUDGMENT = { timestamp: '2026-10-27T10:00:00.000Z', result: 'agree' };

  /** 생산 형식 그대로의 원장 바이트 — doctor-visit 한 행 + 그 방문을 가리키는 shadow doctor-rx 한 행. */
  function seedLedger(dir: string, runId: string): void {
    mkdirSync(dir, { recursive: true });
    const rows = [
      { timestamp: '2026-10-27T09:00:00.000Z', runId, event: 'doctor-visit',
        data: { from: 'parent', symptom: 'admit-starved', evidence: 'no progress 40m' } },
      { timestamp: '2026-10-27T09:05:00.000Z', runId, event: 'doctor-rx',
        data: { shadow: true, visitIndex: 0, rx: 're-evaluate-member', outcome: 'shadow-recorded', execution: 'none' } },
    ];
    writeFileSync(runLedgerPath(runId, dir), rows.map((row) => `${JSON.stringify(row)}\n`).join(''), 'utf8');
  }

  const ledgerBytes = (runId: string, dir: string): string => readFileSync(runLedgerPath(runId, dir), 'utf8');
  const ledgerRowCount = (runId: string, dir: string): number => ledgerBytes(runId, dir).split('\n').filter(Boolean).length;
  const lockDir = (runId: string, dir: string): string => join(dir, `.${runId}.lock`);

  test('실제 원장을 지나 doctor-compare 한 행을 남기고, 재시도는 already-recorded 로 한 행만 유지한다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-visit-real-'));
    try {
      seedLedger(dir, RUN_ID);
      const rowsBefore = ledgerRowCount(RUN_ID, dir);

      const record = recordDoctorComparison({ runId: RUN_ID, judgment: JUDGMENT, dir });

      expect(record).toEqual({ status: 'recorded', visitIndex: 0, shadowRxIndex: 1,
        rx: 're-evaluate-member', outcome: 'shadow-recorded', opResult: 'agree' });
      const rows = ledgerBytes(RUN_ID, dir).split('\n').filter(Boolean);
      expect(rows.length).toBe(rowsBefore + 1);
      const appended = JSON.parse(rows.at(-1)!) as { runId: string; event: string;
        data: { visitIndex: number; shadowRxIndex: number; opJudgment: { timestamp: string; result: string } } };
      expect(appended.event).toBe('doctor-compare');
      expect(appended.runId).toBe(RUN_ID);
      expect(appended.data.visitIndex).toBe(0);
      expect(appended.data.shadowRxIndex).toBe(1);
      expect(appended.data.opJudgment).toEqual(JUDGMENT);
      expect(existsSync(lockDir(RUN_ID, dir))).toBe(false);

      const retry = recordDoctorComparison({ runId: RUN_ID, judgment: JUDGMENT, dir });
      expect(retry.status).toBe('already-recorded');
      expect(ledgerRowCount(RUN_ID, dir)).toBe(rowsBefore + 1);
      expect(existsSync(lockDir(RUN_ID, dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('원장 바이트의 runId 불일치는 typed reason·두 runId 로 하류에 도착하고 파일·행·잠금은 불변이다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-visit-mismatch-real-'));
    try {
      mkdirSync(dir, { recursive: true });
      // 두 번째 행이 «다른» runId 를 적었다 — 생산 경로가 loadRunLedger 에서 실제로 만나는 identity 불일치다.
      writeFileSync(runLedgerPath(RUN_ID, dir), [
        `${JSON.stringify({ timestamp: '2026-10-27T09:00:00.000Z', runId: RUN_ID, event: 'doctor-visit',
          data: { from: 'parent', symptom: 'admit-starved' } })}\n`,
        `${JSON.stringify({ timestamp: '2026-10-27T09:05:00.000Z', runId: OTHER_RUN_ID, event: 'doctor-rx',
          data: { shadow: true, visitIndex: 0 } })}\n`,
      ].join(''), 'utf8');
      const bytesBefore = ledgerBytes(RUN_ID, dir);
      const rowsBefore = ledgerRowCount(RUN_ID, dir);

      let thrown: unknown;
      try {
        recordDoctorComparison({ runId: RUN_ID, judgment: JUDGMENT, dir });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(RunLedgerCheckedAppendRunIdMismatchError);
      const mismatch = thrown as InstanceType<typeof RunLedgerCheckedAppendRunIdMismatchError>;
      expect(mismatch.reason).toBe('runId-mismatch');
      expect(mismatch.decisionRunId).toBe(OTHER_RUN_ID);
      expect(mismatch.lockedRunId).toBe(RUN_ID);
      expect(mismatch.message).toContain(`runId does not match ${RUN_ID}`);
      // 어느 생산자가 던졌는지까지 identity 로 남는다 — 원장 «바이트» 불일치(서브클래스)이지
      // decision entry 불일치가 아니다. lineNumber 필드도 하류까지 살아 있어야 한다.
      expect(mismatch).toBeInstanceOf(runLedgerModule.RunLedgerEntryRunIdMismatchError);
      expect(mismatch.name).toBe('RunLedgerEntryRunIdMismatchError');
      const fromBytes = mismatch as InstanceType<typeof runLedgerModule.RunLedgerEntryRunIdMismatchError>;
      expect(Number.isInteger(fromBytes.lineNumber)).toBe(true);
      expect(fromBytes.lineNumber).toBeGreaterThan(0);

      expect(ledgerBytes(RUN_ID, dir)).toBe(bytesBefore);
      expect(ledgerRowCount(RUN_ID, dir)).toBe(rowsBefore);
      expect(existsSync(runLedgerPath(OTHER_RUN_ID, dir))).toBe(false);
      expect(existsSync(lockDir(RUN_ID, dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('시험 우주 운영 원장 쓰기 거부는 typed identity 로 도착하고 파일 바이트·행 수·잠금·디렉터리 항목이 불변이다', () => {
    const opsRoot = mkdtempSync(join(tmpdir(), 'doctor-visit-ops-root-'));
    const dir = join(opsRoot, 'run-ledger');
    setOpsRootsForTesting([opsRoot]);
    try {
      // 시험이 «운영처럼 보이는» 원장을 직접 심는다 — 생산 경로는 여기에 쓰지 못해야 한다.
      seedLedger(dir, RUN_ID);
      const bytesBefore = ledgerBytes(RUN_ID, dir);
      const rowsBefore = ledgerRowCount(RUN_ID, dir);
      // 디렉터리 항목까지 찍어 둔다 — 거부가 «파일 내용»뿐 아니라 잠금·아카이브·임시 파일도
      // 남기지 않았음을 한 번에 관측한다.
      const entriesBefore = readdirSync(dir).sort();

      let thrown: unknown;
      try {
        recordDoctorComparison({ runId: RUN_ID, judgment: JUDGMENT, dir });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(doctorVisitModule.DoctorComparisonLedgerWriteRefusedError);
      const refused = thrown as InstanceType<typeof doctorVisitModule.DoctorComparisonLedgerWriteRefusedError>;
      expect(refused.reason).toBe('ledger-write-refused');
      expect(refused.runId).toBe(RUN_ID);
      expect(refused.ledgerDir).toBe(dir);
      expect(refused.message).toMatch(/ledger-write-refused/);
      // 거부는 «원장 없음»으로 축소되지 않는다.
      expect(refused.message).not.toMatch(/run-ledger-missing|runId-mismatch/);

      expect(ledgerBytes(RUN_ID, dir)).toBe(bytesBefore);
      expect(ledgerRowCount(RUN_ID, dir)).toBe(rowsBefore);
      expect(existsSync(lockDir(RUN_ID, dir))).toBe(false);
      // 거부된 «한 번의» 실제 원장 경로 호출은 디렉터리 항목 하나도 늘리지 않았다.
      expect(readdirSync(dir).sort()).toEqual(entriesBefore);
      // 이 장면은 «운영 유사(simulated)» 우주다 — 골의 운영 E4(운영 실물)는 이 시험이 아니라
      // 운영 쪽 별도 관측으로 표시한다. 두 우주가 같은 경로가 아님을 여기서 고정한다.
      expect(isInsideOpsRoot(dir)).toBe(true);
      expect(dir.startsWith(prodInstanceRoot())).toBe(false);
    } finally {
      setOpsRootsForTesting(null);
      rmSync(opsRoot, { recursive: true, force: true });
    }
  });

  test('원장이 «아예 없는» 운영 유사 경로에서도 거부가 먼저 서서 run-ledger-missing 으로 축소되지 않는다', () => {
    const opsRoot = mkdtempSync(join(tmpdir(), 'doctor-visit-ops-empty-'));
    const dir = join(opsRoot, 'run-ledger');
    setOpsRootsForTesting([opsRoot]);
    try {
      // 원장 부재와 운영 원장 쓰기 거부가 «동시에» 참인 유일한 배치다 — 순서가 뒤집히면
      // 생산 경로가 missing 을 먼저 만나고 거부 identity 가 사라진다.
      expect(existsSync(dir)).toBe(false);

      let thrown: unknown;
      try {
        recordDoctorComparison({ runId: RUN_ID, judgment: JUDGMENT, dir });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(doctorVisitModule.DoctorComparisonLedgerWriteRefusedError);
      const refused = thrown as InstanceType<typeof doctorVisitModule.DoctorComparisonLedgerWriteRefusedError>;
      expect(refused.reason).toBe('ledger-write-refused');
      expect(refused.runId).toBe(RUN_ID);
      expect(refused.ledgerDir).toBe(dir);
      expect(refused.message).not.toMatch(/run-ledger-missing/);

      // 거부는 결정 콜백·잠금보다 앞에서 서므로 원장 디렉터리·파일·잠금이 하나도 생기지 않는다.
      expect(existsSync(dir)).toBe(false);
      expect(existsSync(runLedgerPath(RUN_ID, dir))).toBe(false);
      expect(existsSync(lockDir(RUN_ID, dir))).toBe(false);
    } finally {
      setOpsRootsForTesting(null);
      rmSync(opsRoot, { recursive: true, force: true });
    }
  });

  /** 생산 형식 그대로의 원장 행 묶음 — 실패 분류마다 다른 형태의 원장 바이트를 심는다. */
  function writeRows(dir: string, rows: readonly Record<string, unknown>[]): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(runLedgerPath(RUN_ID, dir), rows.map((row) => `${JSON.stringify(row)}\n`).join(''), 'utf8');
  }

  /** 실제 caller 를 한 번 불러 던져진 오류를 잡는다 — 원장·잠금 불변을 재기 위한 공통 형태. */
  function captureFailure(runId: string, dir: string, judgment: { timestamp: string; result: string }): unknown {
    try {
      recordDoctorComparison({ runId, judgment, dir });
    } catch (error) {
      return error;
    }
    throw new Error('expected recordDoctorComparison to throw');
  }

  test('shadow doctor-rx 가 없으면 typed shadow-rx-missing 으로 남고 파일 바이트·행·잠금은 불변이다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-visit-shadow-missing-'));
    try {
      writeRows(dir, [{ timestamp: '2026-10-27T09:00:00.000Z', runId: RUN_ID, event: 'doctor-visit',
        data: { from: 'parent', symptom: 'admit-starved', evidence: 'no progress 40m' } }]);
      const bytesBefore = ledgerBytes(RUN_ID, dir);
      const rowsBefore = ledgerRowCount(RUN_ID, dir);

      const thrown = captureFailure(RUN_ID, dir, JUDGMENT);

      expect(thrown).toBeInstanceOf(doctorVisitModule.DoctorComparisonFailureError);
      const failure = thrown as InstanceType<typeof doctorVisitModule.DoctorComparisonFailureError>;
      expect(failure.reason).toBe('shadow-rx-missing');
      expect(failure.message).toMatch(/^shadow-rx-missing:/);
      expect(ledgerBytes(RUN_ID, dir)).toBe(bytesBefore);
      expect(ledgerRowCount(RUN_ID, dir)).toBe(rowsBefore);
      expect(existsSync(lockDir(RUN_ID, dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('shadow doctor-rx 가 가리키는 방문이 없으면 typed visit-missing 이고 방문을 지어내지 않는다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-visit-visit-missing-'));
    try {
      // visitIndex 1 은 자기 자신(doctor-rx)을 가리킨다 — doctor-visit 행이 실제로 없는 원장이다.
      writeRows(dir, [{ timestamp: '2026-10-27T09:00:00.000Z', runId: RUN_ID, event: 'doctor-rx',
        data: { shadow: true, visitIndex: 1, rx: 're-evaluate-member', outcome: 'shadow-recorded' } }]);
      const bytesBefore = ledgerBytes(RUN_ID, dir);
      const rowsBefore = ledgerRowCount(RUN_ID, dir);

      const thrown = captureFailure(RUN_ID, dir, JUDGMENT);

      expect(thrown).toBeInstanceOf(doctorVisitModule.DoctorComparisonFailureError);
      const failure = thrown as InstanceType<typeof doctorVisitModule.DoctorComparisonFailureError>;
      expect(failure.reason).toBe('visit-missing');
      expect(failure.message).toMatch(/^visit-missing:/);
      expect(ledgerBytes(RUN_ID, dir)).toBe(bytesBefore);
      expect(ledgerRowCount(RUN_ID, dir)).toBe(rowsBefore);
      expect(existsSync(lockDir(RUN_ID, dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('이미 기록된 비교와 손판정이 다르면 typed comparison-conflict 이고 기존 행을 덮지 않는다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-visit-conflict-'));
    try {
      const stored = { timestamp: '2026-10-27T08:00:00.000Z', result: 'disagree' };
      writeRows(dir, [
        { timestamp: '2026-10-27T09:00:00.000Z', runId: RUN_ID, event: 'doctor-visit',
          data: { from: 'parent', symptom: 'admit-starved', evidence: 'no progress 40m' } },
        { timestamp: '2026-10-27T09:05:00.000Z', runId: RUN_ID, event: 'doctor-rx',
          data: { shadow: true, visitIndex: 0, rx: 're-evaluate-member', outcome: 'shadow-recorded' } },
        { timestamp: '2026-10-27T09:06:00.000Z', runId: RUN_ID, event: 'doctor-compare',
          data: { shadow: true, visitIndex: 0, shadowRxIndex: 1, opJudgment: stored } },
      ]);
      const bytesBefore = ledgerBytes(RUN_ID, dir);
      const rowsBefore = ledgerRowCount(RUN_ID, dir);

      const thrown = captureFailure(RUN_ID, dir, JUDGMENT);

      expect(thrown).toBeInstanceOf(doctorVisitModule.DoctorComparisonFailureError);
      const failure = thrown as InstanceType<typeof doctorVisitModule.DoctorComparisonFailureError>;
      expect(failure.reason).toBe('comparison-conflict');
      expect(failure.message).toMatch(/^comparison-conflict:/);
      expect(failure.message).toContain(JSON.stringify(stored));
      expect(ledgerBytes(RUN_ID, dir)).toBe(bytesBefore);
      expect(ledgerRowCount(RUN_ID, dir)).toBe(rowsBefore);
      expect(existsSync(lockDir(RUN_ID, dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('저장된 비교 판단이 손상됐으면 typed comparison-corrupt 로 거짓 already-recorded 를 승인하지 않는다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-visit-corrupt-'));
    try {
      writeRows(dir, [
        { timestamp: '2026-10-27T09:00:00.000Z', runId: RUN_ID, event: 'doctor-visit',
          data: { from: 'parent', symptom: 'admit-starved', evidence: 'no progress 40m' } },
        { timestamp: '2026-10-27T09:05:00.000Z', runId: RUN_ID, event: 'doctor-rx',
          data: { shadow: true, visitIndex: 0, rx: 're-evaluate-member', outcome: 'shadow-recorded' } },
        { timestamp: '2026-10-27T09:06:00.000Z', runId: RUN_ID, event: 'doctor-compare',
          data: { shadow: true, visitIndex: 0, shadowRxIndex: 1, opJudgment: { result: 'agree' } } },
      ]);
      const bytesBefore = ledgerBytes(RUN_ID, dir);
      const rowsBefore = ledgerRowCount(RUN_ID, dir);

      const thrown = captureFailure(RUN_ID, dir, JUDGMENT);

      expect(thrown).toBeInstanceOf(doctorVisitModule.DoctorComparisonFailureError);
      const failure = thrown as InstanceType<typeof doctorVisitModule.DoctorComparisonFailureError>;
      expect(failure.reason).toBe('comparison-corrupt');
      expect(failure.message).toMatch(/^comparison-corrupt:/);
      expect(ledgerBytes(RUN_ID, dir)).toBe(bytesBefore);
      expect(ledgerRowCount(RUN_ID, dir)).toBe(rowsBefore);
      expect(existsSync(lockDir(RUN_ID, dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('원장이 실제로 없는 시험 우주 운영 경로에서도 missing 이 아니라 ledger-write-refused 로 거부된다', () => {
    const opsRoot = mkdtempSync(join(tmpdir(), 'doctor-visit-ops-root-empty-'));
    const dir = join(opsRoot, 'run-ledger');
    setOpsRootsForTesting([opsRoot]);
    try {
      expect(existsSync(runLedgerPath(RUN_ID, dir))).toBe(false);

      let thrown: unknown;
      try {
        recordDoctorComparison({ runId: RUN_ID, judgment: JUDGMENT, dir });
      } catch (error) {
        thrown = error;
      }

      // 누락 원장만 missing 이다 — 운영 원장 경로를 향한 호출은 원장 유무와 무관하게 먼저 거부된다.
      expect(thrown).toBeInstanceOf(doctorVisitModule.DoctorComparisonLedgerWriteRefusedError);
      const refused = thrown as InstanceType<typeof doctorVisitModule.DoctorComparisonLedgerWriteRefusedError>;
      expect(refused.reason).toBe('ledger-write-refused');
      expect(refused.message).not.toMatch(/run-ledger-missing/);
      expect(existsSync(runLedgerPath(RUN_ID, dir))).toBe(false);
      expect(existsSync(lockDir(RUN_ID, dir))).toBe(false);
    } finally {
      setOpsRootsForTesting(null);
      rmSync(opsRoot, { recursive: true, force: true });
    }
  });

  test('원장이 실제로 없을 때만 run-ledger-missing 으로 남고 아무 원장도 잠금도 만들어지지 않는다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-visit-missing-real-'));
    try {
      let thrown: unknown;
      try {
        recordDoctorComparison({ runId: RUN_ID, judgment: JUDGMENT, dir });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(doctorVisitModule.DoctorComparisonFailureError);
      const failure = thrown as InstanceType<typeof doctorVisitModule.DoctorComparisonFailureError>;
      expect(failure.reason).toBe('run-ledger-missing');
      expect(failure.message).toMatch(/^run-ledger-missing:/);
      expect(failure.message).not.toMatch(/runId-mismatch/);
      expect(failure.message).not.toMatch(/ledger-write-refused/);
      expect(existsSync(runLedgerPath(RUN_ID, dir))).toBe(false);
      expect(existsSync(lockDir(RUN_ID, dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('RUN-DOCTOR-LIVE 0.2.36 F3 — recordDoctorComparison caller가 typed 거부·불일치를 삼키지 않는다', () => {
  const RUN_ID = 'run-0a1b2c3d-4e5f-4a7b-8c9d-0e1f2a3b4c5d';
  const JUDGMENT = { timestamp: '2026-10-22T10:00:00.000Z', result: 'agree' };

  test('checked append의 typed runId 불일치는 runId-mismatch로 분류되고 run-ledger-missing로 축소되지 않는다', () => {
    mock.module('./run-ledger.js', () => ({
      appendRunLedgerEntryChecked: () => { throw new RunLedgerCheckedAppendRunIdMismatchError('run-ffffffff-0000-4000-8000-000000000000', RUN_ID); },
    }));
    expect(() => recordDoctorComparison({ runId: RUN_ID, judgment: JUDGMENT })).toThrow(/runId-mismatch/);
    mock.restore();
  });

  test('checked append의 ledger-write-refused는 이름붙은 거부로 그대로 전파되고 원장 행을 남기지 않는다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-visit-refused-'));
    try {
      mock.module('./run-ledger.js', () => ({
        appendRunLedgerEntryChecked: () => ({ appended: false, result: null, refusal: 'ledger-write-refused' as const }),
      }));
      expect(() => recordDoctorComparison({ runId: RUN_ID, judgment: JUDGMENT, dir })).toThrow(/ledger-write-refused/);
      mock.restore();
      expect(existsSync(runLedgerPath(RUN_ID, dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('원장이 실제로 없을 때만 run-ledger-missing로 분류한다', () => {
    mock.module('./run-ledger.js', () => ({
      appendRunLedgerEntryChecked: () => { throw new Error('run-ledger-missing: 런 원장이 없습니다 — 새 원장을 만들지 않습니다'); },
    }));
    expect(() => recordDoctorComparison({ runId: RUN_ID, judgment: JUDGMENT })).toThrow(/run-ledger-missing/);
    mock.restore();
  });
});

// ── 시험 EOF · 현재 구현 상태 정합 (RUN-DOCTOR-LIVE-QUALITY-FU · #30564 shouldFix 후속) ─────────────
// 위 QUALITY-FU 블록은 더 이상 RED-draft 가 «아니다». 이 트리에서 mock 없이 생산 진입점
// recordDoctorComparison(src/self-implement/doctor-visit.ts:517) → appendRunLedgerEntryChecked
// (src/self-implement/run-ledger.ts:917) 실경로를 그대로 지나 GREEN 이다
// (관측: 8 pass · 0 fail · 55 expect — `bun test src/self-implement/doctor-visit.test.ts`).
//  · mismatch : RunLedgerEntryRunIdMismatchError(reason='runId-mismatch' · decisionRunId ·
//               lockedRunId · lineNumber)가 caller 까지 도착. 원장 바이트·행 수·잠금 불변.
//  · refusal  : ops root 앞에서 DoctorComparisonLedgerWriteRefusedError(reason='ledger-write-refused'
//               · runId · ledgerDir)로 표면화. 원장 디렉터리 항목·바이트·행 수·잠금 불변.
//  · ordering : 원장이 «아예 없어도» 거부가 결정 콜백보다 먼저 서므로 run-ledger-missing 으로
//               축소되지 않는다(순서가 뒤집히면 그 시험이 실제로 red 가 된다 — 확인함).
//  · missing  : 실제로 원장이 없을 때만 'run-ledger-missing'.
// 증거 명령: bun test src/self-implement/doctor-visit.test.ts
//            bun test src/self-implement/doctor-visit.test.ts src/self-implement/run-ledger.test.ts src/self-implement/heal-triage.test.ts
// 운영 E4(운영 실물 관측)는 이 파일의 장면과 «다른 관측»이다 — 여기 쓰는 ops root 는 simulated 이고,
// dir 이 prodInstanceRoot() 밖임을 시험이 단언한다. 운영 실물을 기다리지 않고 장치를 세웠으며
// 운영 쪽 증거는 별도 관측으로 표시한다.
// 배선 경계(의도적 · 생산 호출자 없음): recordDoctorComparison 의 호출자는 시험 경로뿐이다 —
// live dispatch·stall-watch retirement 는 후속 cross-judgment 증거 슬라이스에서 붙는다
// (doctor-visit.ts:513-515 의 경계와 같은 이유: `eln doctor status --json` = total 0 operating visits).