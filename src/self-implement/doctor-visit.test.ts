import { afterAll, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordDoctorComparison } from './doctor-visit.js';
import { runLedgerPath, RunLedgerCheckedAppendRunIdMismatchError } from './run-ledger.js';
import * as runLedgerModule from './run-ledger.js';

// R-TST23: mock.module()은 process-wide 레지스트리를 바꾸며 mock.restore()는 이를 되돌리지 않는다.
// 원본 스냅샷을 afterAll 마지막 mock.module()로 되돌려 이후 파일이 오염되지 않게 한다.
const originalRunLedger = { ...runLedgerModule };
afterAll(() => {
  mock.module('./run-ledger.js', () => originalRunLedger);
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