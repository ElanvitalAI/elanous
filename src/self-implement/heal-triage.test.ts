import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyReworkCapExhaustion, fillMissingGateFacts, markDeletedUnverified, mergeHealSignatures, triageFailure } from './heal-triage.js';
import { recordDoctorVisit, recordShadowDoctorReevaluation } from './doctor-visit.js';
import { appendRunLedgerEntry, loadRunLedger, runLedgerPath, type RunLedgerCheckedAppendDecision, type RunLedgerEntry } from './run-ledger.js';

test('환경 주장은 verify-evidence 전까지만 environment-claimed', () => {
  const signature = { environmentClaim: '할당량 소진', failedTests: 0 };
  expect(triageFailure(signature).outcome).toBe('environment-claimed');
  expect(triageFailure(signature, { visited: ['verify-evidence'] }).outcome).not.toBe('environment-claimed');
});

test('실패 시험 0 · 미검증이 문서뿐이면 untestable', () => {
  const result = triageFailure({ failedTests: 0, unverified: ['docs/a.md'] });
  expect(result.outcome).toBe('untestable');
  expect(result.evidence.length).toBeGreaterThan(0);
});

test('시험 불가 확장자와 지운 파일만 untestable', () => {
  expect(triageFailure({ failedTests: 0, unverified: ['a.json', 'b.yaml', 'c.yml', 'd.txt', '-gone.ts'] }).outcome).toBe('untestable');
});

test('importer 미실행 시험이 있으면 harness-fixable', () => {
  expect(triageFailure({ failedTests: 0, importerUnrunTests: 1, unverified: ['src/a.ts'] }).outcome).toBe('harness-fixable');
});

test('도입 실패 또는 이름이 짚이는 소스는 child-fixable', () => {
  expect(triageFailure({ failedTests: 1, introduced: 2 }).outcome).toBe('child-fixable');
  expect(triageFailure({ failedTests: 1, namedSource: 'src/a.ts' }).outcome).toBe('child-fixable');
});

test('이미 표시된 경로는 그대로 두고 unknown 은 표시하지 않는다', () => {
  const paths = ['-gone.ts', 'src/cli/daemon-attach.ts', 'kept.ts'];
  const marked = markDeletedUnverified(paths, (path) => (path === 'kept.ts' ? true : 'unknown'));
  expect(marked).toEqual(['-gone.ts', 'src/cli/daemon-attach.ts', 'kept.ts']);
  expect(markDeletedUnverified(['src/cli/daemon-attach.ts'], () => false)).toEqual(['-src/cli/daemon-attach.ts']);
});

test('게이트 사실이 없으면 칸을 더하지 않는다', () => {
  const filled = fillMissingGateFacts({ failedTests: 0 }, [{ data: { note: 'no-gate' } }]);
  expect(filled.added).toEqual([]);
  expect(filled.signature).toEqual({ failedTests: 0 });
});

test('나중 오버레이가 이기고 기여한 칸마다 출처 한 줄', () => {
  const merged = mergeHealSignatures(
    { failedTests: 0, introduced: 0 },
    [
      { source: 'collect', signature: { unverified: ['-src/cli/daemon-attach.ts'] } },
      { source: 'observe-deeper', signature: { timedOut: 1, introduced: 4 } },
    ],
  );
  expect(merged.signature).toMatchObject({ failedTests: 0, introduced: 4, timedOut: 1, unverified: ['-src/cli/daemon-attach.ts'] });
  expect(merged.evidence).toEqual(['unverified ← collect', 'introduced ← observe-deeper', 'timedOut ← observe-deeper']);
});

test('원장 errorText 는 빈 칸에만 채우고 서명 병합에도 남는다', () => {
  const entries = [{ data: { errorText: 'old' } }, { data: { errorText: 'TypeError: x is not a function' } }];
  const filled = fillMissingGateFacts({ failedTests: 1 }, entries);
  expect(filled.added).toEqual(['errorText']);
  expect(filled.signature.errorText).toBe('TypeError: x is not a function');
  expect(fillMissingGateFacts({ errorText: 'supplied' }, entries).signature.errorText).toBe('supplied');
  expect(mergeHealSignatures({ failedTests: 1 }, [{ source: 'observe-deeper', signature: filled.signature }]).signature.errorText).toBe('TypeError: x is not a function');
});

test('L2 이후 인용이 있으면 재작업, 없거나 빈 목록이면 종전 소진', () => {
  const visited = { visited: ['observe-deeper', 'ground-external'] };
  const citation = { title: 'Docs', url: 'https://example.test/docs', snippet: 'Fix' };
  expect(triageFailure({ failedTests: 1, citations: [citation] }, visited)).toMatchObject({
    outcome: 'rework-with-citations', evidence: expect.arrayContaining([citation.url]),
  });
  expect(triageFailure({ failedTests: 1, citations: [] }, visited).outcome).toBe('exhausted');
  expect(triageFailure({ failedTests: 1 }, visited).outcome).toBe('exhausted');
});

test('수리 한도 소진은 도입 실패면 코드 결함·재발사, 골 지적이면 골 결함·카드, 아니면 시험 결함·수확', () => {
  expect(classifyReworkCapExhaustion({
    introduced: ['src/other.ts introduced 1'],
    mustFix: ['fix the assertion'],
  })).toEqual({
    defectClass: 'code-defect',
    nextAction: 'relaunch',
    evidence: ['gate introduced: src/other.ts introduced 1', 'review must-fix: fix the assertion'],
  });
  expect(classifyReworkCapExhaustion({ mustFix: ['수용 기준이 모순이다'] })).toMatchObject({
    defectClass: 'goal-defect', nextAction: 'card',
  });
  expect(classifyReworkCapExhaustion({ mustFix: ['assertion does not fail before the fix'] })).toMatchObject({
    defectClass: 'test-defect', nextAction: 'harvest',
  });
  expect(classifyReworkCapExhaustion({})).toEqual({
    defectClass: 'test-defect', nextAction: 'harvest', evidence: [],
  });
});

test('모호하면 방문 수로 해상도를 올린다', () => {
  const vague = { failedTests: 3, unverified: ['src/a.ts'] };
  expect(triageFailure(vague).outcome).toBe('needs-deeper-observation');
  expect(triageFailure(vague, { visited: ['observe-deeper'] }).outcome).toBe('needs-grounding');
  expect(triageFailure(vague, { visited: ['observe-deeper', 'ground-external'] }).outcome).toBe('exhausted');
});

// ⭐ doctor-visit.ts 신규 export(recordDoctorComparison)는 지연 import 로만 가져온다 —
//    base 실행에서 이 파일 전체가 module-load-error 로 죽는 것을 막고, 기존 12개 triage
//    시험은 base 에서도 그대로 돈다(새 시험만 명명된 이유로 실패 = RED 증인).
describe('RUN-DOCTOR-LIVE 0.2.36 — doctor-compare 첫 비교 슬라이스', () => {
  const RUN_ID = 'run-0a1b2c3d-4e5f-4a7b-8c9d-0e1f2a3b4c5d';
  const OTHER_RUN_ID = 'run-00000000-0000-4000-8000-000000000000';

  /** 격리 원장 — mkdtempSync 디렉터리 seam 에 seed 한 줄(run-start)을 둔다. */
  function isolatedLedger(): string {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-compare-'));
    appendRunLedgerEntry({ timestamp: '2026-10-22T00:00:00.000Z', runId: RUN_ID, event: 'run-start', data: {} }, dir);
    return dir;
  }

  /** doctor-visit.ts 의 비교 API — base 에는 없는 신규 export 이므로 시험 안에서 지연 import 한다. */
  async function loadComparison(): Promise<typeof import('./doctor-visit.js')['recordDoctorComparison']> {
    const module = await import('./doctor-visit.js');
    if (typeof module.recordDoctorComparison !== 'function') {
      throw new Error('doctor-compare-missing: recordDoctorComparison 내보내기가 없습니다 — RUN-DOCTOR-LIVE 0.2.36 첫 비교 슬라이스가 구현돼야 합니다');
    }
    return module.recordDoctorComparison;
  }

  test('격리 원장에서 doctor-visit·shadow doctor-rx·OP 손판정·doctor-compare 를 읽어 runId·시각·결과가 일치', async () => {
    const recordDoctorComparison = await loadComparison();
    const dir = isolatedLedger();
    try {
      const visit = recordDoctorVisit({ runId: RUN_ID, from: 'supervisor', symptom: 'admit-starved', evidence: 'admit 3/3 exhausted', dir, incidentRoot: null });
      const shadow = recordShadowDoctorReevaluation(RUN_ID, dir);
      expect(shadow.status).toBe('recorded');
      expect(shadow.outcome).toBe('shadow-recorded');

      const comparison = recordDoctorComparison({ runId: RUN_ID, judgment: { timestamp: '2026-10-22T09:30:00.000Z', result: 'agree' }, dir });
      expect(comparison.status).toBe('recorded');

      const entries = loadRunLedger(RUN_ID, dir)!;
      const rows = entries.filter((entry) => entry.event === 'doctor-compare');
      expect(rows.length).toBe(1);
      const row = rows[0]!;
      expect(row.runId).toBe(RUN_ID);
      const payload = row.data as {
        visitIndex: number;
        shadowRxIndex: number;
        visit: { runId: string; from: string; symptom: string; timestamp: string };
        shadowRx: { timestamp: string; rx: string; outcome: string };
        opJudgment: { timestamp: string; result: string };
      };
      expect(payload.visitIndex).toBe(shadow.visitIndex!);

      const visitEntry = entries[payload.visitIndex]!;
      expect(visitEntry.event).toBe('doctor-visit');
      expect(visitEntry.runId).toBe(RUN_ID);
      expect(visitEntry.timestamp).toBe(visit.timestamp);
      expect(payload.visit).toEqual({ runId: RUN_ID, from: 'supervisor', symptom: 'admit-starved', timestamp: visit.timestamp! });

      const shadowEntry = entries[payload.shadowRxIndex]!;
      expect(shadowEntry.event).toBe('doctor-rx');
      expect(shadowEntry.runId).toBe(RUN_ID);
      expect(shadowEntry.data.shadow).toBe(true);
      expect(payload.shadowRx.timestamp).toBe(shadowEntry.timestamp!);
      expect(payload.shadowRx.rx).toBe('re-evaluate-member');
      expect(payload.shadowRx.outcome).toBe('shadow-recorded');
      expect(payload.opJudgment).toEqual({ timestamp: '2026-10-22T09:30:00.000Z', result: 'agree' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('같은 입력 재시도는 doctor-compare 한 행만 남긴다(멱등)', async () => {
    const recordDoctorComparison = await loadComparison();
    const dir = isolatedLedger();
    try {
      recordDoctorVisit({ runId: RUN_ID, from: 'supervisor', symptom: 'admit-starved', evidence: 'admit 3/3 exhausted', dir, incidentRoot: null });
      recordShadowDoctorReevaluation(RUN_ID, dir);
      const judgment = { timestamp: '2026-10-22T09:31:00.000Z', result: 'agree' };
      expect(recordDoctorComparison({ runId: RUN_ID, judgment, dir }).status).toBe('recorded');
      expect(recordDoctorComparison({ runId: RUN_ID, judgment, dir }).status).toBe('already-recorded');
      expect(loadRunLedger(RUN_ID, dir)!.filter((entry) => entry.event === 'doctor-compare').length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('재시도가 다른 timestamp·result 면 comparison-conflict 로 거부되고 저장된 행·출처 인덱스는 그대로다', async () => {
    const recordDoctorComparison = await loadComparison();
    const dir = isolatedLedger();
    try {
      recordDoctorVisit({ runId: RUN_ID, from: 'supervisor', symptom: 'admit-starved', evidence: 'admit 3/3 exhausted', dir, incidentRoot: null });
      recordShadowDoctorReevaluation(RUN_ID, dir);
      const first = recordDoctorComparison({ runId: RUN_ID, judgment: { timestamp: '2026-10-22T09:36:00.000Z', result: 'agree' }, dir });
      expect(first.status).toBe('recorded');

      const retrySame = recordDoctorComparison({ runId: RUN_ID, judgment: { timestamp: '2026-10-22T09:36:00.000Z', result: 'agree' }, dir });
      expect(retrySame.status).toBe('already-recorded');
      expect(retrySame.opResult).toBe('agree');
      expect(retrySame.visitIndex).toBe(first.visitIndex);
      expect(retrySame.shadowRxIndex).toBe(first.shadowRxIndex);

      expect(() => recordDoctorComparison({ runId: RUN_ID, judgment: { timestamp: '2026-10-22T09:37:00.000Z', result: 'agree' }, dir }))
        .toThrow(/comparison-conflict/);
      expect(() => recordDoctorComparison({ runId: RUN_ID, judgment: { timestamp: '2026-10-22T09:36:00.000Z', result: 'disagree' }, dir }))
        .toThrow(/comparison-conflict/);

      const rows = loadRunLedger(RUN_ID, dir)!.filter((entry) => entry.event === 'doctor-compare');
      expect(rows.length).toBe(1);
      const stored = rows[0]!.data as { visitIndex: number; shadowRxIndex: number; opJudgment: { timestamp: string; result: string } };
      expect(stored.opJudgment).toEqual({ timestamp: '2026-10-22T09:36:00.000Z', result: 'agree' });
      expect(stored.visitIndex).toBe(first.visitIndex);
      expect(stored.shadowRxIndex).toBe(first.shadowRxIndex);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('원장 누락·shadow rx 누락·runId 불일치는 명명된 이유로 실패하고 shadow 결과를 지어내지 않는다', async () => {
    const recordDoctorComparison = await loadComparison();
    const missingDir = isolatedLedger();
    try {
      expect(() => recordDoctorComparison({ runId: 'run-99999999-9999-4999-8999-999999999999', judgment: { timestamp: '2026-10-22T09:32:00.000Z', result: 'agree' }, dir: missingDir }))
        .toThrow(/run-ledger-missing/);
    } finally {
      rmSync(missingDir, { recursive: true, force: true });
    }

    const dir = isolatedLedger();
    try {
      recordDoctorVisit({ runId: RUN_ID, from: 'judge', symptom: 'admit-starved', dir, incidentRoot: null });
      expect(() => recordDoctorComparison({ runId: RUN_ID, judgment: { timestamp: '2026-10-22T09:33:00.000Z', result: 'agree' }, dir }))
        .toThrow(/shadow-rx-missing/);

      // runId 불일치 — 이 원장 파일 안에 다른 runId 의 shadow doctor-rx 행이 심져 있을 때.
      const entries = loadRunLedger(RUN_ID, dir)!;
      const visitIndex = entries.findIndex((entry) => entry.event === 'doctor-visit');
      const mismatched: RunLedgerEntry = { timestamp: '2026-10-22T09:34:00.000Z', runId: OTHER_RUN_ID, event: 'doctor-rx', data: { shadow: true, visitIndex } };
      appendFileSync(runLedgerPath(RUN_ID, dir), `${JSON.stringify(mismatched)}\n`);
      expect(() => recordDoctorComparison({ runId: RUN_ID, judgment: { timestamp: '2026-10-22T09:35:00.000Z', result: 'agree' }, dir }))
        .toThrow(/runId-mismatch/);
      // 거부 시 doctor-compare 행을 만들지 않는다(원장이 더 이상 파싱되지 않으니 파일 텍스트로 잰다).
      expect(readFileSync(runLedgerPath(RUN_ID, dir), 'utf8').split('\n').filter((line) => line.includes('"doctor-compare"')).length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('RUN-DOCTOR-LIVE #30403 — 동일 per-run lock 안에서 비교 행 존재 판정과 단일 append를 원자적으로', () => {
  const RUN_ID = 'run-0a1b2c3d-4e5f-4a7b-8c9d-0e1f2a3b4c5d';

  /** 격리 원장 — mkdtempSync 디렉터리 seam 에 seed 한 줄(run-start)을 둔다. */
  function isolatedLedger(): string {
    const dir = mkdtempSync(join(tmpdir(), 'doctor-compare-'));
    appendRunLedgerEntry({ timestamp: '2026-10-22T00:00:00.000Z', runId: RUN_ID, event: 'run-start', data: {} }, dir);
    return dir;
  }

  async function loadComparison(): Promise<typeof import('./doctor-visit.js')['recordDoctorComparison']> {
    const module = await import('./doctor-visit.js');
    if (typeof module.recordDoctorComparison !== 'function') {
      throw new Error('doctor-compare-missing: recordDoctorComparison 내보내기가 없습니다 — RUN-DOCTOR-LIVE #30403 원자적 수리가 구현돼야 합니다');
    }
    return module.recordDoctorComparison;
  }

  async function loadCheckedAppend(): Promise<typeof import('./run-ledger.js')['appendRunLedgerEntryChecked']> {
    const module = await import('./run-ledger.js');
    if (typeof module.appendRunLedgerEntryChecked !== 'function') {
      throw new Error('checked-append-missing: appendRunLedgerEntryChecked 내보내기가 없습니다 — 단일 lock 안에서 존재 판정과 append를 묶는 API가 구현돼야 합니다');
    }
    return module.appendRunLedgerEntryChecked;
  }

  /** 실제 OS 프로세스로 recordDoctorComparison 을 부르는 자식 스크립트 — fake in-process 순차 시험이 아니다. */
  function writeChildScript(): string {
    const scriptPath = join(tmpdir(), `doctor-compare-child-${process.pid}.ts`);
    const doctorVisitPath = join(import.meta.dir, 'doctor-visit.ts');
    writeFileSync(scriptPath, `import { recordDoctorComparison } from ${JSON.stringify(doctorVisitPath)};
const input = JSON.parse(process.argv[2] ?? '{}') as { runId: string; judgment: { timestamp: string; result: string }; dir: string };
try {
  const record = recordDoctorComparison(input);
  process.stdout.write(JSON.stringify({ ok: true, status: record.status, judgment: input.judgment }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
}
`);
    return scriptPath;
  }

  interface ChildResponse { ok: boolean; status?: string; judgment?: { timestamp: string; result: string }; error?: string }

  /** 자식 프로세스를 실제로 spawn 해 판정을 보내고, 표준 출력 JSON 한 줄을 기다린다. */
  function submitJudgment(scriptPath: string, input: unknown): Promise<ChildResponse> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [scriptPath, JSON.stringify(input)], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { out += chunk; });
      child.on('error', reject);
      child.on('close', () => {
        try {
          resolve(JSON.parse(out.trim()) as ChildResponse);
        } catch {
          reject(new Error(`child-output-unparseable: ${out.trim().slice(0, 300)}`));
        }
      });
    });
  }

  test('appendRunLedgerEntryChecked 단위 — 같은 판정 두 번은 행 하나, 손상 원장은 오류(거짓 already-recorded 아님)', async () => {
    const appendRunLedgerEntryChecked = await loadCheckedAppend();
    const dir = mkdtempSync(join(tmpdir(), 'run-ledger-checked-'));
    appendRunLedgerEntry({ timestamp: '2026-10-22T00:00:00.000Z', runId: RUN_ID, event: 'run-start', data: {} }, dir);
    try {
      const decide = (entries: RunLedgerEntry[] | null): RunLedgerCheckedAppendDecision<'already'> => {
        if (entries === null) throw new Error(`run-ledger-missing: 런 원장이 없습니다 (runId=${RUN_ID})`);
        return entries.some((entry) => entry.event === 'unit-checked-append')
          ? { append: false, result: 'already' }
          : { append: true, entry: { timestamp: '2026-10-22T09:40:00.000Z', runId: RUN_ID, event: 'unit-checked-append', data: {} } };
      };
      expect(appendRunLedgerEntryChecked(RUN_ID, decide, dir)).toEqual({ appended: true, result: null, refusal: null });
      expect(appendRunLedgerEntryChecked(RUN_ID, decide, dir)).toEqual({ appended: false, result: 'already', refusal: null });
      expect(loadRunLedger(RUN_ID, dir)!.filter((entry) => entry.event === 'unit-checked-append').length).toBe(1);
      // 손상 원장 — lock 안의 loadRunLedger 가 오류를 던지고 append 는 일어나지 않는다(거짓 already-recorded 아님).
      appendFileSync(runLedgerPath(RUN_ID, dir), '{"broken"\n');
      expect(() => appendRunLedgerEntryChecked(RUN_ID, decide, dir)).toThrow();
      expect(readFileSync(runLedgerPath(RUN_ID, dir), 'utf8').split('\n').filter((line) => line.includes('"unit-checked-append"')).length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  test('격리 두 실제 프로세스가 같은 runId/shadowRxIndex에 동시에 같은 판단 → doctor-compare 행 정확히 1개, 둘째 already-recorded', async () => {
    const dir = isolatedLedger();
    const scriptPath = writeChildScript();
    try {
      recordDoctorVisit({ runId: RUN_ID, from: 'supervisor', symptom: 'admit-starved', evidence: 'admit 3/3 exhausted', dir, incidentRoot: null });
      recordShadowDoctorReevaluation(RUN_ID, dir);
      const judgment = { timestamp: '2026-10-22T09:41:00.000Z', result: 'agree' };
      const responses = await Promise.all([
        submitJudgment(scriptPath, { runId: RUN_ID, judgment, dir }),
        submitJudgment(scriptPath, { runId: RUN_ID, judgment, dir }),
      ]);
      const statuses = responses.map((response) => (response.ok ? response.status : `error:${response.error}`)).sort();
      expect(statuses).toEqual(['already-recorded', 'recorded']);
      expect(loadRunLedger(RUN_ID, dir)!.filter((entry) => entry.event === 'doctor-compare').length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(scriptPath, { force: true });
    }
  }, 120_000);

  test('동시 상충 판단 → 한쪽 recorded, 한쪽 comparison-conflict, 원장 doctor-compare 행 1개(기존 행 보존)', async () => {
    const dir = isolatedLedger();
    const scriptPath = writeChildScript();
    try {
      recordDoctorVisit({ runId: RUN_ID, from: 'supervisor', symptom: 'admit-starved', evidence: 'admit 3/3 exhausted', dir, incidentRoot: null });
      recordShadowDoctorReevaluation(RUN_ID, dir);
      const first = { timestamp: '2026-10-22T09:42:00.000Z', result: 'agree' };
      const second = { timestamp: '2026-10-22T09:42:30.000Z', result: 'disagree' };
      const responses = await Promise.all([
        submitJudgment(scriptPath, { runId: RUN_ID, judgment: first, dir }),
        submitJudgment(scriptPath, { runId: RUN_ID, judgment: second, dir }),
      ]);
      const recorded = responses.find((response) => response.ok && response.status === 'recorded');
      const conflicted = responses.find((response) => !response.ok && /comparison-conflict/.test(response.error ?? ''));
      expect(recorded).toBeDefined();
      expect(conflicted).toBeDefined();
      const rows = loadRunLedger(RUN_ID, dir)!.filter((entry) => entry.event === 'doctor-compare');
      expect(rows.length).toBe(1);
      expect((rows[0]!.data as { opJudgment: unknown }).opJudgment).toEqual(recorded!.judgment);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(scriptPath, { force: true });
    }
  }, 120_000);

  test('저장된 opJudgment 가 손상됐으면 comparison-corrupt 오류 — 거짓 already-recorded 를 승인하지 않는다', async () => {
    const recordDoctorComparison = await loadComparison();
    const dir = isolatedLedger();
    try {
      recordDoctorVisit({ runId: RUN_ID, from: 'supervisor', symptom: 'admit-starved', evidence: 'admit 3/3 exhausted', dir, incidentRoot: null });
      recordShadowDoctorReevaluation(RUN_ID, dir);
      const judgment = { timestamp: '2026-10-22T09:43:00.000Z', result: 'agree' };
      expect(recordDoctorComparison({ runId: RUN_ID, judgment, dir }).status).toBe('recorded');
      // 파일 텍스트에서 opJudgment 를 깨뜨린다(원장은 파싱되지만 저장 판단이 아니다).
      const ledgerFile = runLedgerPath(RUN_ID, dir);
      writeFileSync(ledgerFile, readFileSync(ledgerFile, 'utf8').replace('"opJudgment":{"timestamp":"2026-10-22T09:43:00.000Z","result":"agree"}', '"opJudgment":"agree"'));
      expect(() => recordDoctorComparison({ runId: RUN_ID, judgment, dir })).toThrow(/comparison-corrupt/);
      expect(loadRunLedger(RUN_ID, dir)!.filter((entry) => entry.event === 'doctor-compare').length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
