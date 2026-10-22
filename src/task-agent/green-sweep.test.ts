import { describe, expect, test } from 'bun:test';
import type { ChecklistItem } from '../release-loop/checklist.js';
import type { TaskCard } from './task-hand.js';
import { ambiguousGreenSweepPrs, appendGreenSweepEvidence, decideGreenSweep, explicitEvidencePrs, greenSweepCandidates, observeGreenSweep } from './green-sweep.js';

const sha = 'a'.repeat(40);
const url = 'https://github.com/example/repo/pull/123';
const cell = (patch: Partial<ChecklistItem> = {}): ChecklistItem => ({
  id: 'CELL', title: '대상 경로: src/task-agent/actions.ts\n판정: 시험 0 fail', status: 'yellow',
  updatedAt: '2026-10-13T00:00:00.000Z', updatedBy: 'test', ...patch,
});
const card = (patch: Partial<TaskCard> = {}): TaskCard => ({
  id: 'ta-123', text: 'task', createdAt: '2026-10-13T00:00:00.000Z', status: 'done', history: [],
  checklistId: 'CELL', checklistVersion: '0.2.28', pr: { number: 123, url },
  prTerminal: { pr: 123, url, head: sha, state: 'MERGED', at: '2026-10-13T00:00:00.000Z' },
  postLand: { pr: 123, head: sha, at: '2026-10-13T00:00:00.000Z', outcome: 'complete', evidence: ['test'], remaining: [] },
  ...patch,
});
const merged = { number: 123, state: 'MERGED', mergeSha: sha, url };

describe('GREEN-FROM-LEDGER pure decision', () => {
  test('bound complete card + merged ancestor gives green; PR body is never a candidate', () => {
    const item = cell();
    const candidates = greenSweepCandidates(item, '0.2.28', [card()]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.source).toBe('card');
    expect(decideGreenSweep({ item, candidate: candidates[0]!, candidateCount: 1, pr: merged, ancestor: true, hold: false, repositoryMatches: true }))
      .toMatchObject({ verdict: 'green', reason: 'bound-card-complete', mergeSha: sha });
    expect(greenSweepCandidates(item, '0.2.28', [])).toEqual([]);
  });

  test('open, closed, missing merge SHA, and nonancestor never green', () => {
    const item = cell();
    const candidate = greenSweepCandidates(item, '0.2.28', [card()])[0]!;
    for (const state of ['OPEN', 'CLOSED']) {
      expect(decideGreenSweep({ item, candidate, candidateCount: 1, pr: { ...merged, state }, ancestor: false, hold: false, repositoryMatches: true }).verdict).toBe('skip');
    }
    expect(decideGreenSweep({ item, candidate, candidateCount: 1, pr: { ...merged, mergeSha: undefined }, ancestor: false, hold: false, repositoryMatches: true }).reason).toBe('merge-sha-unreadable');
    expect(decideGreenSweep({ item, candidate, candidateCount: 1, pr: merged, ancestor: false, hold: false, repositoryMatches: true }).reason).toBe('merge-sha-not-on-origin-main');
    expect(decideGreenSweep({ item, candidate, candidateCount: 1, pr: merged, ancestor: null, hold: false, repositoryMatches: true }))
      .toMatchObject({ verdict: 'record-only', reason: 'origin-main-ref-unverified' });
  });

  test('closed component can use a verified merged train, while mismatched binding stays closed', () => {
    const trainCard = card({ prTerminal: { pr: 123, url, head: sha, state: 'CLOSED', at: '2026-10-13T00:00:00.000Z' },
      trainLanding: { componentPr: 123, integrationPr: 456, mergeSha: sha, train: 'c2', at: '2026-10-13T00:00:00.000Z' }, postLand: undefined });
    const candidate = greenSweepCandidates(cell(), '0.2.28', [trainCard])[0]!;
    const viaTrain = { ...merged, viaTrain: { integrationPr: 456 } };
    expect(decideGreenSweep({ item: cell(), candidate, candidateCount: 1, pr: viaTrain, ancestor: true, hold: false, repositoryMatches: true }))
      .toMatchObject({ verdict: 'green', reason: 'bound-card-train-merged' });
    expect(decideGreenSweep({ item: cell(), candidate, candidateCount: 1, pr: { ...viaTrain, viaTrain: { integrationPr: 789 } },
      ancestor: true, hold: false, repositoryMatches: true }).reason).toBe('train-binding-mismatch');
    expect(decideGreenSweep({ item: cell(), candidate, candidateCount: 1, pr: { ...merged, state: 'CLOSED' },
      ancestor: true, hold: false, repositoryMatches: true }).verdict).toBe('skip');
  });

  test('explicit landed evidence is a candidate; incidental PR mention is not', () => {
    expect(explicitEvidencePrs('PR #123 참고 · 다른 PR #456 본문 mention')).toEqual([]);
    expect(explicitEvidencePrs('PR #123 참고, 다른 변경 착지')).toEqual([]);
    expect(explicitEvidencePrs('https://github.com/example/repo/pull/123 참고, 다른 변경 착지')).toEqual([]);
    expect(explicitEvidencePrs('GREEN-FROM-LEDGER: PR #123 merged aaa · record-only · remaining')).toEqual([]);
    expect(explicitEvidencePrs('GREEN-FROM-LEDGER: PR #123 merged aaa · skip · hold')).toEqual([]);
    expect(explicitEvidencePrs('PR #123 미착지\n미착지 #456\nPR #789 not merged')).toEqual([]);
    expect(explicitEvidencePrs('PR #123 병합하지 않음\nPR #456 착지 아님')).toEqual([]);
    expect(explicitEvidencePrs('PR #123 착지 예정\nPR #456 병합 계획\nPR #789 착지 · 다른 PR 대기')).toEqual([]);
    expect(explicitEvidencePrs('PR #123 착지 실패\nPR #456 착지 불가\nPR #789 착지 아직 안 됨\nPR #321 착지 미완료\nPR #654 착지 누락\nPR #987 착지 못 함')).toEqual([]);
    expect(explicitEvidencePrs('https://github.com/example/repo/pull/123 착지')).toEqual([123]);
    expect(explicitEvidencePrs('수확: 착지 #123 main aaa\nPR #456 merged\n#789 첫 조각 착지')).toEqual([123, 456]);
    const item = cell({ evidence: '판정: green\n수확: 착지 #123 main aaa' });
    const candidate = greenSweepCandidates(item, '0.2.28', [])[0]!;
    expect(candidate.source).toBe('evidence');
    expect(decideGreenSweep({ item, candidate, candidateCount: 1, pr: merged, ancestor: true, hold: false, repositoryMatches: true }))
      .toMatchObject({ verdict: 'green', reason: 'explicit-cell-completion-evidence' });
    const landingOnly = cell({ evidence: 'PR #123 착지' });
    expect(decideGreenSweep({ item: landingOnly, candidate: greenSweepCandidates(landingOnly, '0.2.28', [])[0]!,
      candidateCount: 1, pr: merged, ancestor: true, hold: false, repositoryMatches: true }))
      .toMatchObject({ verdict: 'record-only', reason: 'cell-completion-not-explicit' });
    const criteriaOnly = cell({ title: '완료 기준: 시험 0 fail', evidence: 'PR #123 착지' });
    expect(decideGreenSweep({ item: criteriaOnly, candidate: greenSweepCandidates(criteriaOnly, '0.2.28', [])[0]!,
      candidateCount: 1, pr: merged, ancestor: true, hold: false, repositoryMatches: true }))
      .toMatchObject({ verdict: 'record-only', reason: 'cell-completion-not-explicit' });
    const partial = cell({ evidence: '칸 전체 완료 기준: 운영 확인\nPR #123 착지 · 일부 범위만 완료' });
    expect(decideGreenSweep({ item: partial, candidate: greenSweepCandidates(partial, '0.2.28', [])[0]!,
      candidateCount: 1, pr: merged, ancestor: true, hold: false, repositoryMatches: true }))
      .toMatchObject({ verdict: 'record-only', reason: 'remaining-or-multiple-piece-evidence' });
    const conflict = cell({ evidence: '판정: green\nPR #123 착지\n판정: yellow' });
    expect(decideGreenSweep({ item: conflict, candidate: greenSweepCandidates(conflict, '0.2.28', [])[0]!,
      candidateCount: 1, pr: merged, ancestor: true, hold: false, repositoryMatches: true }))
      .toMatchObject({ verdict: 'record-only', reason: 'conflicting-cell-verdict-evidence' });
    const secondVerification = cell({ evidence: '판정: green\nPR #123 착지 · 2차 검증 필요' });
    expect(decideGreenSweep({ item: secondVerification,
      candidate: greenSweepCandidates(secondVerification, '0.2.28', [])[0]!,
      candidateCount: 1, pr: merged, ancestor: true, hold: false, repositoryMatches: true }))
      .toMatchObject({ verdict: 'record-only', reason: 'remaining-or-multiple-piece-evidence' });
  });

  test('card PR alone can recover a hand landing; unknown version and duplicate binding stay yellow', () => {
    const item = cell();
    const handCard = card({ postLand: undefined, prTerminal: undefined });
    const candidate = greenSweepCandidates(item, '0.2.28', [handCard])[0]!;
    expect(decideGreenSweep({ item, candidate, candidateCount: 1, pr: merged, ancestor: true, hold: false, repositoryMatches: true }))
      .toMatchObject({ verdict: 'green', reason: 'bound-card-merged' });
    const unversioned = greenSweepCandidates(item, '0.2.28', [card({ checklistVersion: undefined })])[0]!;
    expect(decideGreenSweep({ item, candidate: unversioned, candidateCount: 1, pr: merged, ancestor: true, hold: false, repositoryMatches: true }).reason)
      .toBe('card-version-unbound');
    const duplicate = greenSweepCandidates(item, '0.2.28', [card(), card({ id: 'ta-duplicate' })])[0]!;
    expect(decideGreenSweep({ item, candidate: duplicate, candidateCount: 1, pr: merged, ancestor: true, hold: false, repositoryMatches: true }).reason)
      .toBe('ambiguous-pr-across-cards');
    const triplicate = greenSweepCandidates(item, '0.2.28', [card(), card({ id: 'ta-duplicate' }), card({ id: 'ta-third' })])[0]!;
    expect(decideGreenSweep({ item, candidate: triplicate, candidateCount: 1, pr: merged, ancestor: true, hold: false, repositoryMatches: true }).reason)
      .toBe('ambiguous-pr-across-cards');
    const addedFeature = cell({ title: '기능 추가 완료 · 대상 경로: src/task-agent/actions.ts' });
    expect(decideGreenSweep({ item: addedFeature, candidate: greenSweepCandidates(addedFeature, '0.2.28', [card()])[0]!,
      candidateCount: 1, pr: merged, ancestor: true, hold: false, repositoryMatches: true }).verdict).toBe('green');
    const yellowEvidence = cell({ evidence: '판정: yellow' });
    expect(decideGreenSweep({ item: yellowEvidence, candidate: greenSweepCandidates(yellowEvidence, '0.2.28', [card()])[0]!,
      candidateCount: 1, pr: merged, ancestor: true, hold: false, repositoryMatches: true }))
      .toMatchObject({ verdict: 'record-only', reason: 'conflicting-cell-verdict-evidence' });
  });

  test('multiple pieces stay record-only; hold and stop skip', () => {
    const item = cell();
    const candidate = greenSweepCandidates(item, '0.2.28', [card()])[0]!;
    const base = { item, candidate, pr: merged, ancestor: true, hold: false, repositoryMatches: true };
    expect(decideGreenSweep({ ...base, candidateCount: 2 }).reason).toBe('multiple-piece-prs');
    expect(decideGreenSweep({ ...base, candidateCount: 1, hold: true })).toMatchObject({ verdict: 'skip', reason: 'traffic-hold' });
    const unreadable = decideGreenSweep({ ...base, candidateCount: 1, hold: null, holdDiagnostic: 'ENOENT: /traffic.json' });
    expect(unreadable).toMatchObject({ verdict: 'record-only', reason: 'hold-state-unreadable', holdDiagnostic: 'ENOENT: /traffic.json' });
    const masked = decideGreenSweep({ ...base, candidateCount: 1, pr: null, hold: null, holdDiagnostic: 'ENOENT: /traffic.json' });
    expect(masked).toMatchObject({ verdict: 'skip', reason: 'pr-unreadable' });
    expect(masked.holdDiagnostic).toBeUndefined();
    expect(decideGreenSweep({ ...base, item: cell({ evidence: '남은 것: 운영 실물' }), candidateCount: 1 }).reason)
      .toBe('remaining-or-multiple-piece-evidence');
    expect(decideGreenSweep({ ...base, item: cell({ evidence: 'PR #123 merged · 후속 작업: 운영 확인' }), candidateCount: 1 }))
      .toMatchObject({ verdict: 'record-only', reason: 'remaining-or-multiple-piece-evidence' });
    expect(decideGreenSweep({ ...base, item: cell({ evidence: 'PR #123 착지 · 후속 일: 운영 확인 필요' }), candidateCount: 1 }))
      .toMatchObject({ verdict: 'record-only', reason: 'remaining-or-multiple-piece-evidence' });
    expect(decideGreenSweep({ ...base, item: cell({ evidence: 'PR #123 착지\nPR #456 미착지' }), candidateCount: 1 }))
      .toMatchObject({ verdict: 'record-only', reason: 'remaining-or-multiple-piece-evidence' });
    expect(decideGreenSweep({ ...base, item: cell({ evidence: 'PR #123 착지\nPR #456 착지 실패' }), candidateCount: 1 }))
      .toMatchObject({ verdict: 'record-only', reason: 'remaining-or-multiple-piece-evidence' });
    for (const marker of [
      '실물 판정선 미충족 · 대체 후보 0', 'pin 뒤 실물 대기, green 조건 미달',
      '남은 조각 검증 · 잔여 2건', '후속 조각 확인', 'PR #123 착지 · 후속 PR #456 예정',
      '1차 완료 · 2차 작업 필요', '후속 배선', '여러 조각',
    ]) {
      expect(decideGreenSweep({ ...base, item: cell({ title: marker, evidence: 'PR #123 착지' }), candidateCount: 1 }))
        .toMatchObject({ verdict: 'record-only', reason: 'remaining-or-multiple-piece-evidence' });
    }
    expect(decideGreenSweep({ ...base, item: cell({ title: '조각①② 처리', evidence: 'PR #123 착지' }), candidateCount: 1 }))
      .toMatchObject({ verdict: 'record-only', reason: 'remaining-or-multiple-piece-evidence' });
    expect(decideGreenSweep({ ...base, item: cell({ evidence: '사람 판정: 정지' }), candidateCount: 1 }))
      .toMatchObject({ verdict: 'skip', reason: 'cell-stop-evidence' });
    expect(decideGreenSweep({ ...base, item: cell({ evidence: '사람 판정: 보류' }), candidateCount: 1, hold: null }))
      .toMatchObject({ verdict: 'skip', reason: 'cell-stop-evidence' });
    expect(decideGreenSweep({ ...base, candidate: greenSweepCandidates(item, '0.2.28', [card({ postLand: {
      pr: 123, head: sha, at: '2026-10-13T00:00:00.000Z', outcome: 'partial', evidence: [], remaining: ['운영 확인'],
    } })])[0]!, candidateCount: 1 }))
      .toMatchObject({ verdict: 'record-only', reason: 'card-post-land-incomplete' });
    expect(decideGreenSweep({ ...base, candidate: greenSweepCandidates(item, '0.2.28', [card({ postLand: {
      pr: 123, head: sha, at: '2026-10-13T00:00:00.000Z', outcome: 'complete', evidence: [], remaining: ['운영 확인'],
    } })])[0]!, candidateCount: 1 }))
      .toMatchObject({ verdict: 'record-only', reason: 'card-post-land-incomplete' });
  });

  test('evidence is appended once and never replaces an existing paragraph', () => {
    const before = '기존 측정: 12/0\n사람 판정: yellow';
    const line = 'GREEN-FROM-LEDGER: PR #123 merged '+sha;
    expect(appendGreenSweepEvidence(before, line)).toBe(`${before}\n${line}`);
    expect(appendGreenSweepEvidence(appendGreenSweepEvidence(before, line), line)).toBe(`${before}\n${line}`);
    const scqa = 'S: 기존 관측\n\nC: 근거\nQ: 판단 대기\nA: \n\n';
    expect(appendGreenSweepEvidence(scqa, line)).toBe(`${scqa}${line}`);
    const decision = decideGreenSweep({ item: cell({ evidence: scqa }), candidate: greenSweepCandidates(cell(), '0.2.28', [card()])[0]!,
      candidateCount: 1, pr: merged, ancestor: true, hold: false, repositoryMatches: true });
    expect(decision.plannedEvidence).toBe(`${scqa}${decision.evidence}`);
    expect(decision.existingEvidence).toBe(scqa);
  });

  test('PR repository must match the checkout origin', () => {
    const item = cell({ evidence: '판정: green\nPR #123 착지' });
    const candidate = greenSweepCandidates(item, '0.2.28', [])[0]!;
    const base = { item, candidate, candidateCount: 1, pr: merged, ancestor: true, hold: false, repositoryMatches: true };
    expect(decideGreenSweep({ ...base, repositoryMatches: true }).verdict).toBe('green');
    expect(decideGreenSweep({ ...base, repositoryMatches: false })).toMatchObject({ verdict: 'skip', reason: 'repository-mismatch' });
    expect(decideGreenSweep({ ...base, repositoryMatches: null })).toMatchObject({ verdict: 'record-only', reason: 'repository-unreadable' });
    const { repositoryMatches: _bound, ...unknownRepo } = base;
    expect(decideGreenSweep(unknownRepo)).toMatchObject({ verdict: 'record-only', reason: 'repository-unreadable' });
    const urlEvidence = cell({ evidence: '판정: green\nhttps://github.com/example/repo/pull/123 착지' });
    const urlCandidate = greenSweepCandidates(urlEvidence, '0.2.28', [])[0]!;
    expect(decideGreenSweep({ ...base, item: urlEvidence, candidate: urlCandidate })).toMatchObject({ verdict: 'green' });
    expect(decideGreenSweep({ ...base, item: urlEvidence, candidate: urlCandidate,
      pr: { ...merged, url: 'https://github.com/other/repo/pull/123' } }))
      .toMatchObject({ verdict: 'skip', reason: 'evidence-pr-url-mismatch' });
  });

  test('one PR claimed by two checklist cells stays record-only, including evidence-only claims', () => {
    const first = cell({ evidence: '판정: green\nPR #123 착지' });
    const second = cell({ id: 'OTHER', evidence: '판정: green\nPR #123 착지' });
    expect([...ambiguousGreenSweepPrs([first, second], '0.2.28', [])]).toEqual([123]);
    for (const item of [first, second]) {
      const candidate = greenSweepCandidates(item, '0.2.28', [])[0]!;
      expect(decideGreenSweep({ item, candidate, candidateCount: 1, pr: merged, ancestor: true,
        hold: false, repositoryMatches: true, ambiguousAcrossCells: true }))
        .toMatchObject({ verdict: 'record-only', reason: 'ambiguous-pr-across-cells' });
    }
    const cards = [card(), card({ id: 'ta-other', checklistId: 'OTHER' })];
    expect([...ambiguousGreenSweepPrs([cell(), cell({ id: 'OTHER' })], '0.2.28', cards)]).toEqual([123]);
    const alreadyGreen = cell({ id: 'DONE', status: 'green', evidence: 'PR #123 착지' });
    expect([...ambiguousGreenSweepPrs([first, alreadyGreen], '0.2.28', [])]).toEqual([123]);
    expect(decideGreenSweep({ item: first, candidate: greenSweepCandidates(first, '0.2.28', [])[0]!,
      candidateCount: 1, pr: merged, ancestor: true, hold: false, repositoryMatches: true,
      ambiguousAcrossCells: true })).toMatchObject({ verdict: 'record-only', reason: 'ambiguous-pr-across-cells' });
  });

  test('green, record-only, and skip each emit a structured debug decision', () => {
    const item = cell();
    const candidate = greenSweepCandidates(item, '0.2.28', [card()])[0]!;
    const rows: Array<{ event: string; data: unknown }> = [];
    const log = (_category: string, event: string, data: unknown) => { rows.push({ event, data }); };
    for (const input of [
      { pr: merged, ancestor: true, hold: false, repositoryMatches: true },
      { pr: merged, ancestor: true, hold: true, repositoryMatches: true },
      { pr: { ...merged, state: 'OPEN' }, ancestor: false, hold: false, repositoryMatches: true },
    ]) observeGreenSweep(decideGreenSweep({ item, candidate, candidateCount: 1, ...input }), log);
    expect(rows.map((row) => row.event)).toEqual(['green', 'skip', 'skip']);
    expect(rows[0]?.data).toEqual({ cell: 'CELL', pr: 123, mergeSha: sha, reason: 'bound-card-complete' });
  });
});
