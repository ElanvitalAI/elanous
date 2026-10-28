import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { superviseRun, type SupervisorDecision } from '../self-dev/run-supervisor.js';
import { recordShadowDoctorReevaluation } from './doctor-visit.js';
import { appendRunLedgerEntry, loadRunLedger } from './run-ledger.js';

test('supervisor and doctor pull a matching lesson at decision time while child goals stay untouched', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'knowhow-supervisors-'));
  const ledgerDir = mkdtempSync(join(tmpdir(), 'knowhow-doctor-ledger-'));
  const runId = 'run-0a1b2c3d-4e5f-4a7b-8c9d-0e1f2a3b4c5d';
  const goal = '대상 경로: src/self-dev/run-supervisor.ts\n실패 서명: no-progress';
  try {
    mkdirSync(join(repo, 'docs/roles/TC'), { recursive: true });
    writeFileSync(join(repo, 'docs/roles/TC/KNOWHOW.md'),
      '## K-TC-991 no-progress\n- 상황: src/self-dev/run-supervisor.ts no-progress.\n- 처방: 증거를 재확인한다.\n- 출처: 격리 시험 · 상태: active\n');
    let decision: SupervisorDecision | undefined;
    await superviseRun({
      initial: [{ taskId: 'failed-piece', feature: goal, status: 'failed', stage: 'error', error: { code: 'BOOM', message: 'unknown' } }],
      knowhowRepo: repo,
      rerun: async (prior) => prior,
      sweepPendingMerges: async () => ({ pending: 0, merged: 0 }),
      taskAgentShadow: false,
      onDecision: (value) => { decision = value; },
    });
    expect(decision?.knowhowPackSliceIds).toEqual(['K-TC-991']);
    expect(decision?.knowhowPackReference).toContain('증거를 재확인한다');
    expect(decision?.why).toContain('K-TC-991');

    const timestamp = '2026-10-26T00:00:00.000Z';
    appendRunLedgerEntry({ timestamp, runId, event: 'run-start', data: {} }, ledgerDir);
    appendRunLedgerEntry({ timestamp, runId, event: 'knowhow-pack', data: { repoPath: repo, goal, ids: ['K-TC-991'], injected: false } }, ledgerDir);
    appendRunLedgerEntry({ timestamp, runId, event: 'doctor-visit', data: { from: 'supervisor', symptom: 'admit-starved', evidence: 'admit 3/3 exhausted' } }, ledgerDir);
    expect(recordShadowDoctorReevaluation(runId, ledgerDir).status).toBe('recorded');
    const rx = loadRunLedger(runId, ledgerDir)!.find((entry) => entry.event === 'doctor-rx')?.data;
    expect(rx?.knowhowPackSliceIds).toEqual(['K-TC-991']);
    expect(rx?.knowhowPackDecision).toMatchObject({ source: 'repository', ids: ['K-TC-991'], reason: 'selected', reference: expect.stringContaining('증거를 재확인한다') });
    expect(rx?.handoff).toContain('K-TC-991');
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(ledgerDir, { recursive: true, force: true });
  }
});
