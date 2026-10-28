import { afterAll, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setOpsRootsForTesting } from '../instance/test-write-guard.js';
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

      expect(ledgerBytes(RUN_ID, dir)).toBe(bytesBefore);
      expect(ledgerRowCount(RUN_ID, dir)).toBe(rowsBefore);
      expect(existsSync(runLedgerPath(OTHER_RUN_ID, dir))).toBe(false);
      expect(existsSync(lockDir(RUN_ID, dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('시험 우주 운영 원장 쓰기 거부는 typed identity 로 도착하고 파일 바이트·행 수·잠금이 불변이다', () => {
    const opsRoot = mkdtempSync(join(tmpdir(), 'doctor-visit-ops-root-'));
    const dir = join(opsRoot, 'run-ledger');
    setOpsRootsForTesting([opsRoot]);
    try {
      // 시험이 «운영처럼 보이는» 원장을 직접 심는다 — 생산 경로는 여기에 쓰지 못해야 한다.
      seedLedger(dir, RUN_ID);
      const bytesBefore = ledgerBytes(RUN_ID, dir);
      const rowsBefore = ledgerRowCount(RUN_ID, dir);

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

      expect(thrown instanceof Error).toBe(true);
      const message = (thrown as Error).message;
      expect(message).toMatch(/^run-ledger-missing:/);
      expect(message).not.toMatch(/runId-mismatch/);
      expect(message).not.toMatch(/ledger-write-refused/);
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