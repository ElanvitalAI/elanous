import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { classifyAbandonedRun, isAbandonedClassificationOutcome, readWorktreePorcelain } from './abandoned-classification.js';

describe('classifyAbandonedRun', () => {
  test('classifies abandoned and budget-exhausted outcomes but excludes completed outcomes', () => {
    expect(isAbandonedClassificationOutcome('abandoned')).toBe(true);
    expect(isAbandonedClassificationOutcome('budget-exhausted')).toBe(true);
    expect(isAbandonedClassificationOutcome('completed')).toBe(false);
  });

  test.each([
    ['clean', '', undefined, false, 'report-deficit', 'review-result-observation-unmeasured'],
    ['clean', '', 'completed-without-changes', false, 'report-deficit', 'review-result-observation-unmeasured'],
    ['clean', '', undefined, true, 'implementation-deficit', 'must-fix-reported'],
    ['clean', '', 'completed-without-changes', true, 'implementation-deficit', 'must-fix-reported'],
    ['dirty', ' M src/file.ts\n', undefined, false, 'implementation-deficit', 'no-must-fix-without-clean-worktree-or-completed-without-changes'],
    ['dirty', ' M src/file.ts\n', 'completed-without-changes', false, 'report-deficit', 'review-result-observation-unmeasured'],
    ['dirty', ' M src/file.ts\n', undefined, true, 'implementation-deficit', 'must-fix-reported'],
    ['dirty', ' M src/file.ts\n', 'completed-without-changes', true, 'implementation-deficit', 'must-fix-reported'],
  ] as const)('%s worktree(porcelain=%j), completion=%s, mustFix=%s -> %s', (_state, worktreePorcelain, completionDisposition, mustFixReported, classification, classificationBasis) => {
    expect(classifyAbandonedRun({ worktreePorcelain, ...(completionDisposition ? { completionDisposition } : {}), mustFixReported })).toEqual({
      classification,
      classificationBasis,
      worktreeClean: worktreePorcelain === '',
      ...(completionDisposition ? { completionDisposition } : {}),
      mustFixReported,
    });
  });

  test.each([
    [{ worktreePorcelain: ' M src/file.ts\n', mustFixReported: true, supervisorVerdict: 'CONTRACT-CONFLICT' }, 'contract-conflict', 'supervisor-contract-conflict'],
    [{ worktreePorcelain: ' M src/file.ts\n', mustFixReported: true, stage: 'pr-declined' }, 'pr-declined', 'pr-declined-stage'],
    [{ worktreePorcelain: ' M src/file.ts\n', mustFixReported: true, mergeApprovalReceived: true }, 'merge-approved-abandoned', 'merge-approval-received'],
    [{ worktreePorcelain: ' M src/file.ts\n', mustFixReported: true, quotaExhausted: true }, 'quota-exhausted', 'environment-quota-outranks-run-stage-evidence'],
  ] as const)('preserves classification priority and records its selected basis', (input, classification, classificationBasis) => {
    expect(classifyAbandonedRun(input)).toMatchObject({ classification, classificationBasis });
  });

  test('an UNCONVERGEABLE verdict plus a separately observed goal cause identifies a candidate with its basis', () => {
    expect(classifyAbandonedRun({
      worktreePorcelain: ' M src/file.ts\n',
      supervisorVerdict: 'UNCONVERGEABLE',
      goalCauseObserved: true,
      mustFixReported: true,
    })).toEqual({
      classification: 'goal-unconvergeable-candidate',
      classificationBasis: 'supervisor-unconvergeable-goal-candidate',
      worktreeClean: false,
      supervisorVerdict: 'UNCONVERGEABLE',
      goalCauseObserved: true,
      mustFixReported: true,
    });
  });

  test('an UNCONVERGEABLE verdict without a goal-cause observation preserves the legacy deficit branch', () => {
    expect(classifyAbandonedRun({
      worktreePorcelain: ' M src/file.ts\n',
      supervisorVerdict: 'UNCONVERGEABLE',
      mustFixReported: true,
    })).toEqual({
      classification: 'implementation-deficit',
      classificationBasis: 'must-fix-reported',
      worktreeClean: false,
      supervisorVerdict: 'UNCONVERGEABLE',
      mustFixReported: true,
    });
  });

  test('missing or non-goal supervisor verdict preserves legacy deficit branches', () => {
    const legacy = {
      classification: 'implementation-deficit',
      classificationBasis: 'no-must-fix-without-clean-worktree-or-completed-without-changes',
      worktreeClean: false,
      mustFixReported: false,
    } as const;
    const base = { worktreePorcelain: ' M src/file.ts\n', mustFixReported: false } as const;
    expect(classifyAbandonedRun(base)).toEqual(legacy);
    expect(classifyAbandonedRun({ ...base, supervisorVerdict: 'SUFFICIENT' })).toEqual({
      ...legacy,
      supervisorVerdict: 'SUFFICIENT',
    });
  });

  test('contract conflict and existing procedural or environmental signals outrank the unconvergeable candidate', () => {
    const base = { worktreePorcelain: ' M src/file.ts\n', mustFixReported: true } as const;
    expect(classifyAbandonedRun({
      ...base,
      supervisorVerdict: 'CONTRACT-CONFLICT',
      goalCauseObserved: true,
      stage: 'pr-declined',
      quotaExhausted: true,
      providerError: true,
    })).toMatchObject({
      classification: 'contract-conflict',
      classificationBasis: 'supervisor-contract-conflict',
      goalCauseObserved: true,
    });
    expect(classifyAbandonedRun({
      ...base,
      supervisorVerdict: 'UNCONVERGEABLE',
      goalCauseObserved: true,
      stage: 'pr-declined',
      quotaExhausted: true,
      credentialFailure: true,
      providerError: true,
    })).toMatchObject({
      classification: 'pr-declined',
      classificationBasis: 'pr-declined-stage',
      supervisorVerdict: 'UNCONVERGEABLE',
      goalCauseObserved: true,
      quotaExhausted: true,
      credentialFailure: true,
      providerError: true,
    });
    expect(classifyAbandonedRun({
      ...base,
      supervisorVerdict: 'UNCONVERGEABLE',
      goalCauseObserved: true,
      providerError: true,
    })).toMatchObject({
      classification: 'provider-error',
      classificationBasis: 'environment-provider-error-outranks-run-stage-evidence',
      goalCauseObserved: true,
    });
  });

  test('non-implement goal types classify every deficit branch as an artifact deficit while omitted and implement retain legacy results', () => {
    const artifactBasis = 'non-implement-goal-type-artifact-deficit';
    const artifactInputs = [
      { worktreePorcelain: ' M docs/x.md\n', mustFixReported: false },
      { worktreePorcelain: '', mustFixReported: false },
      { worktreePorcelain: ' M docs/x.md\n', completionDisposition: 'completed-without-changes' as const, mustFixReported: false },
      { worktreePorcelain: ' M docs/x.md\n', mustFixReported: true },
    ] as const;
    for (const goalType of ['research', 'document', 'operate'] as const) {
      for (const input of artifactInputs) {
        expect(classifyAbandonedRun({ ...input, goalType })).toMatchObject({
          classification: 'artifact-deficit',
          classificationBasis: artifactBasis,
        });
      }
    }

    const dirtyNoMustFix = artifactInputs[0];
    expect(classifyAbandonedRun(dirtyNoMustFix)).toMatchObject({
      classification: 'implementation-deficit',
      classificationBasis: 'no-must-fix-without-clean-worktree-or-completed-without-changes',
    });
    expect(classifyAbandonedRun({ ...dirtyNoMustFix, goalType: 'implement' })).toMatchObject({
      classification: 'implementation-deficit',
      classificationBasis: 'no-must-fix-without-clean-worktree-or-completed-without-changes',
    });
    expect(classifyAbandonedRun(artifactInputs[1])).toMatchObject({
      classification: 'report-deficit',
      classificationBasis: 'review-result-observation-unmeasured',
    });
    expect(classifyAbandonedRun(artifactInputs[2])).toMatchObject({
      classification: 'report-deficit',
      classificationBasis: 'review-result-observation-unmeasured',
    });
    expect(classifyAbandonedRun(artifactInputs[3])).toMatchObject({
      classification: 'implementation-deficit',
      classificationBasis: 'must-fix-reported',
    });
  });

  test('pr-declined stage outranks must-fix while omitted and other stages retain existing classifications', () => {
    const base = { worktreePorcelain: ' M src/file.ts\n', mustFixReported: false } as const;
    expect(classifyAbandonedRun(base).classification).toBe('implementation-deficit');
    expect(classifyAbandonedRun({ ...base, stage: 'review-blocked' }).classification).toBe('implementation-deficit');
    expect(classifyAbandonedRun({ ...base, stage: 'pr-declined' }).classification).toBe('pr-declined');
    expect(classifyAbandonedRun({ ...base, stage: 'pr-declined', mustFixReported: true }).classification).toBe('pr-declined');
  });

  test('merge approval classifies an abandoned run ahead of must-fix while omitted input preserves implementation-deficit', () => {
    const base = { worktreePorcelain: ' M src/file.ts\n', mustFixReported: true } as const;
    expect(classifyAbandonedRun(base).classification).toBe('implementation-deficit');
    expect(classifyAbandonedRun({ ...base, mergeApprovalReceived: true })).toMatchObject({
      classification: 'merge-approved-abandoned',
      mergeApprovalReceived: true,
      mustFixReported: true,
    });
  });

  // ⛔⭐⭐⭐ 쿼터 소진은 «환경»이 멈춘 것이지 «구현»이 모자란 것이 아니다.
  //   ⇒ mustFix 보다 앞이고, 머지 승인보다는 뒤다(승인은 더 강한 완료 주장).
  //   ⭐ 그리고 «둘 다 참»일 때도 쿼터 사실은 결과에 남아야 한다 — 운영자가 재시도 여부를 그것으로 정한다.
  test('quota exhaustion outranks must-fix, yields to merge approval, and is never lost from the result', () => {
    const base = { worktreePorcelain: ' M src/file.ts\n', mustFixReported: true } as const;
    expect(classifyAbandonedRun(base).classification).toBe('implementation-deficit');
    expect(classifyAbandonedRun({ ...base, quotaExhausted: true })).toMatchObject({
      classification: 'quota-exhausted',
      quotaExhausted: true,
      mustFixReported: true,
    });
    // 머지 승인이 이긴다 — ⛔ 그래도 쿼터 사실은 «남는다»
    expect(classifyAbandonedRun({ ...base, quotaExhausted: true, mergeApprovalReceived: true })).toMatchObject({
      classification: 'merge-approved-abandoned',
      classificationBasis: 'merge-approval-received',
      mergeApprovalReceived: true,
      quotaExhausted: true,
    });
    // contract-conflict · pr-declined 는 여전히 더 앞이다
    expect(classifyAbandonedRun({ ...base, quotaExhausted: true, stage: 'pr-declined' }).classification).toBe('pr-declined');
    expect(classifyAbandonedRun({ ...base, quotaExhausted: true, supervisorVerdict: 'CONTRACT-CONFLICT' }).classification).toBe('contract-conflict');
  });
  test('substrate deadline outranks postmortem quota, credential, and provider error and keeps the quota fact', () => {
    const base = { worktreePorcelain: ' M src/file.ts\n', mustFixReported: true } as const;
    expect(classifyAbandonedRun({
      ...base,
      substrateDeadlineExceeded: true,
      quotaExhausted: true,
      credentialFailure: true,
      providerError: true,
    })).toMatchObject({
      classification: 'run-deadline-exceeded',
      classificationBasis: 'substrate-deadline-outranks-postmortem-quota',
      quotaExhausted: true,
      credentialFailure: true,
      providerError: true,
    });
    expect(classifyAbandonedRun({ ...base, substrateDeadlineExceeded: true, mergeApprovalReceived: true }).classification).toBe('merge-approved-abandoned');
    expect(classifyAbandonedRun({ ...base, substrateDeadlineExceeded: true, stage: 'pr-declined' }).classification).toBe('pr-declined');
    expect(classifyAbandonedRun({ ...base, substrateDeadlineExceeded: true, supervisorVerdict: 'CONTRACT-CONFLICT' }).classification).toBe('contract-conflict');
    expect(classifyAbandonedRun({ ...base, substrateDeadlineExceeded: false }).classification).not.toBe('run-deadline-exceeded');
  });

  test('omitting the quota input leaves both classification and payload untouched', () => {
    const base = { worktreePorcelain: '', mustFixReported: false } as const;
    const out = classifyAbandonedRun(base);
    expect(out.classification).toBe('report-deficit');
    expect(out.quotaExhausted).toBeUndefined();
    // ⛔ false 를 넘겨도 「찼다」로 읽히면 안 된다
    expect(classifyAbandonedRun({ ...base, quotaExhausted: false }).quotaExhausted).toBeUndefined();
  });

  test.each([
    ['clean', ''],
    ['dirty', ' M src/file.ts\n'],
  ] as const)('an observed credential failure outranks %s worktree status', (_state, worktreePorcelain) => {
    expect(classifyAbandonedRun({
      worktreePorcelain,
      credentialFailure: true,
      mustFixReported: false,
    })).toMatchObject({
      classification: 'credential-failure',
      classificationBasis: 'environment-credential-outranks-run-stage-evidence',
      credentialFailure: true,
      worktreeClean: worktreePorcelain === '',
    });
  });

  test('credential failure yields to existing quota exhaustion and preserves both observations', () => {
    expect(classifyAbandonedRun({
      worktreePorcelain: '',
      quotaExhausted: true,
      credentialFailure: true,
      providerError: true,
      mustFixReported: false,
    })).toMatchObject({
      classification: 'quota-exhausted',
      classificationBasis: 'environment-quota-outranks-run-stage-evidence',
      quotaExhausted: true,
      credentialFailure: true,
      providerError: true,
    });
  });

  test('false and omitted credential-failure observations preserve the legacy classification and payload', () => {
    const base = { worktreePorcelain: '', mustFixReported: false } as const;
    const legacy = {
      classification: 'report-deficit',
      classificationBasis: 'review-result-observation-unmeasured',
      worktreeClean: true,
      mustFixReported: false,
    } as const;
    expect(classifyAbandonedRun(base)).toEqual(legacy);
    expect(classifyAbandonedRun({ ...base, credentialFailure: false })).toEqual(legacy);
  });

  test('an explicitly observed provider error selects its classification, basis, and payload', () => {
    expect(classifyAbandonedRun({
      worktreePorcelain: ' M src/file.ts\n',
      providerError: true,
      mustFixReported: true,
    })).toMatchObject({
      classification: 'provider-error',
      classificationBasis: 'environment-provider-error-outranks-run-stage-evidence',
      providerError: true,
      mustFixReported: true,
    });
  });

  test('request rejection outranks account availability, while other categories retain quota priority', () => {
    const base = { worktreePorcelain: '', mustFixReported: false, quotaExhausted: true, providerError: true } as const;
    expect(classifyAbandonedRun({ ...base, providerErrorCategory: 'request' })).toMatchObject({
      classification: 'provider-error',
      classificationBasis: 'provider-request-rejection-outranks-account-availability',
      quotaExhausted: true,
      providerError: true,
    });
    for (const providerErrorCategory of ['quota', 'credential', 'other'] as const) {
      expect(classifyAbandonedRun({ ...base, providerErrorCategory })).toMatchObject({
        classification: 'quota-exhausted',
        classificationBasis: 'environment-quota-outranks-run-stage-evidence',
      });
    }
    expect(classifyAbandonedRun({ ...base, providerErrorCategory: 'request', providerError: false }).classification).toBe('quota-exhausted');
    expect(classifyAbandonedRun({ ...base, providerErrorCategory: 'request', mergeApprovalReceived: true }).classification).toBe('merge-approved-abandoned');
  });

  test('quota exhaustion outranks provider error while preserving both observations', () => {
    expect(classifyAbandonedRun({
      worktreePorcelain: ' M src/file.ts\n',
      quotaExhausted: true,
      providerError: true,
      mustFixReported: true,
    })).toMatchObject({
      classification: 'quota-exhausted',
      classificationBasis: 'environment-quota-outranks-run-stage-evidence',
      quotaExhausted: true,
      providerError: true,
    });
  });

  test('a higher-priority classification does not discard an observed provider error', () => {
    expect(classifyAbandonedRun({
      worktreePorcelain: ' M src/file.ts\n',
      mergeApprovalReceived: true,
      providerError: true,
      mustFixReported: true,
    })).toMatchObject({
      classification: 'merge-approved-abandoned',
      classificationBasis: 'merge-approval-received',
      mergeApprovalReceived: true,
      providerError: true,
    });
  });

  test('false and omitted provider-error observations preserve the legacy classification and payload', () => {
    const base = { worktreePorcelain: '', mustFixReported: false } as const;
    const legacy = {
      classification: 'report-deficit',
      classificationBasis: 'review-result-observation-unmeasured',
      worktreeClean: true,
      mustFixReported: false,
    } as const;
    expect(classifyAbandonedRun(base)).toEqual(legacy);
    expect(classifyAbandonedRun({ ...base, providerError: false })).toEqual(legacy);
  });

  test('explicit supervisor contract-conflict outranks pr-declined and a structured must-fix without reading reason text', () => {
    expect(classifyAbandonedRun({
      worktreePorcelain: ' M src/file.ts\n',
      stage: 'pr-declined',
      supervisorVerdict: 'CONTRACT-CONFLICT',
      mustFixReported: true,
    })).toEqual({
      classification: 'contract-conflict',
      classificationBasis: 'supervisor-contract-conflict',
      worktreeClean: false,
      supervisorVerdict: 'CONTRACT-CONFLICT',
      mustFixReported: true,
    });
    expect(classifyAbandonedRun({
      worktreePorcelain: ' M src/file.ts\n',
      mustFixReported: true,
    }).classification).toBe('implementation-deficit');
  });

  test('empty porcelain with blocked residue is not invented as clean', () => {
    expect(classifyAbandonedRun({
      worktreePorcelain: '',
      gitResidue: { allowed: false, observation: { state: 'observed', residues: ['merge'] }, reason: 'git residue blocks operation: merge' },
      mustFixReported: false,
    })).toMatchObject({ classification: 'implementation-deficit', worktreeClean: undefined });
  });

  test('unreadable residue is not invented as clean', () => {
    expect(classifyAbandonedRun({
      worktreePorcelain: '',
      gitResidue: { allowed: false, observation: { state: 'unreadable' }, reason: 'git residue unreadable' },
      mustFixReported: false,
    })).toMatchObject({ classification: 'implementation-deficit', worktreeClean: undefined });
  });

  // ⛔ 회귀 — 멈춘 **이유와 잔여 종류**가 산출물까지 남아야 한다(수용 기준). 배선만 하고
  //    단언이 없으면 다음 손질이 조용히 지운다 — 이 PR 에서 실제로 한 번 지워졌었다.
  test('a residue block keeps its reason and residue kinds in the result', () => {
    expect(classifyAbandonedRun({
      worktreePorcelain: '',
      gitResidue: { allowed: false, observation: { state: 'observed', residues: ['merge', 'index-lock'] }, reason: 'git residue blocks operation: merge, index-lock' },
      mustFixReported: false,
    })).toMatchObject({
      gitResidueBlock: { reason: 'git residue blocks operation: merge, index-lock', residues: ['merge', 'index-lock'] },
    });
    expect(classifyAbandonedRun({
      worktreePorcelain: '',
      gitResidue: { allowed: false, observation: { state: 'unreadable' }, reason: 'git residue unreadable' },
      mustFixReported: false,
    })).toMatchObject({ gitResidueBlock: { reason: 'git residue unreadable', residues: 'unreadable' } });
  });

  // ⭐ 정리 허용(살아 있는 잠금)과 「깨끗함」 판정은 다른 축이다 — 막지 않아도 깨끗하다고는 못 한다.
  test('an allowed-but-observed residue still suspends the clean verdict', () => {
    const r = classifyAbandonedRun({
      worktreePorcelain: '',
      gitResidue: { allowed: true, observation: { state: 'observed', residues: ['index-lock'] } },
      mustFixReported: false,
    });
    expect(r.worktreeClean).toBeUndefined();
    expect(r.gitResidueBlock).toBeUndefined();   // 막힌 게 아니므로 차단 사유는 없다
  });

  test('unobservable worktree is not invented as clean', () => {
    expect(classifyAbandonedRun({
      worktreePorcelain: undefined,
      mustFixReported: false,
    })).toEqual({
      classification: 'implementation-deficit',
      classificationBasis: 'no-must-fix-without-clean-worktree-or-completed-without-changes',
      worktreeClean: undefined,
      mustFixReported: false,
    });
  });

  test('no-change runs with cited evidence that exists classify as already-satisfied', () => {
    expect(classifyAbandonedRun({
      worktreePorcelain: '',
      citedEvidenceExists: true,
      mustFixReported: false,
    })).toEqual({
      classification: 'already-satisfied',
      classificationBasis: 'cited-evidence-exists-without-changes',
      worktreeClean: true,
      citedEvidenceExists: true,
      mustFixReported: false,
    });
    expect(classifyAbandonedRun({
      worktreePorcelain: ' M src/file.ts\n',
      completionDisposition: 'completed-without-changes',
      citedEvidenceExists: true,
      mustFixReported: false,
    })).toMatchObject({
      classification: 'already-satisfied',
      classificationBasis: 'cited-evidence-exists-without-changes',
      citedEvidenceExists: true,
    });
  });

  test('no-change runs split omitted cited evidence from an explicit false measurement', () => {
    const omitted = {
      classification: 'report-deficit',
      classificationBasis: 'no-must-fix-clean-worktree-with-cited-evidence-unmeasured',
      worktreeClean: true,
      mustFixReported: false,
    } as const;
    expect(classifyAbandonedRun({ worktreePorcelain: '', mustFixReported: false, reviewResultObserved: true })).toEqual(omitted);
    expect(classifyAbandonedRun({
      worktreePorcelain: ' M src/file.ts\n',
      completionDisposition: 'completed-without-changes',
      mustFixReported: false,
      reviewResultObserved: true,
    })).toMatchObject({
      classification: 'report-deficit',
      classificationBasis: 'no-must-fix-clean-worktree-with-cited-evidence-unmeasured',
    });
    expect(classifyAbandonedRun({
      worktreePorcelain: ' M src/file.ts\n',
      completionDisposition: 'completed-without-changes',
      citedEvidenceExists: false,
      mustFixReported: false,
      reviewResultObserved: true,
    })).toMatchObject({
      classification: 'report-deficit',
      classificationBasis: 'no-must-fix-completed-without-changes',
      worktreeClean: false,
      completionDisposition: 'completed-without-changes',
    });
    const cleanOnly = classifyAbandonedRun({
      worktreePorcelain: '',
      citedEvidenceExists: false,
      mustFixReported: false,
      reviewResultObserved: true,
    });
    const both = classifyAbandonedRun({
      worktreePorcelain: '',
      completionDisposition: 'completed-without-changes',
      citedEvidenceExists: false,
      mustFixReported: false,
      reviewResultObserved: true,
    });
    expect(cleanOnly).toEqual({
      classification: 'report-deficit',
      classificationBasis: 'no-must-fix-clean-worktree',
      worktreeClean: true,
      mustFixReported: false,
    });
    expect(both).toEqual({
      classification: 'report-deficit',
      classificationBasis: 'no-must-fix-clean-worktree-and-completed-without-changes',
      worktreeClean: true,
      completionDisposition: 'completed-without-changes',
      mustFixReported: false,
    });
    expect(cleanOnly.classificationBasis).not.toBe('no-must-fix-completed-without-changes');
    expect(both.classificationBasis).not.toBe(cleanOnly.classificationBasis);
    expect(both.classificationBasis).not.toBe('no-must-fix-completed-without-changes');
  });

  test('report-deficit splits observed, unobserved, and omitted review results into distinct bases', () => {
    const base = { worktreePorcelain: '', mustFixReported: false } as const;
    const observed = classifyAbandonedRun({ ...base, reviewResultObserved: true });
    const unobserved = classifyAbandonedRun({ ...base, reviewResultObserved: false });
    const omitted = classifyAbandonedRun(base);
    expect(observed.classification).toBe('report-deficit');
    expect(unobserved.classification).toBe('report-deficit');
    expect(omitted.classification).toBe('report-deficit');
    expect(observed.classificationBasis).toBe('no-must-fix-clean-worktree-with-cited-evidence-unmeasured');
    expect(unobserved.classificationBasis).toBe('terminal-state-not-reviewed');
    expect(omitted.classificationBasis).toBe('review-result-observation-unmeasured');
    expect(unobserved.classificationBasis).not.toBe(observed.classificationBasis);
    expect(omitted.classificationBasis).not.toBe(observed.classificationBasis);
    expect(omitted.classificationBasis).not.toBe(unobserved.classificationBasis);
  });

  test('orchestrator four classifyAbandonedRun call sites pass the in-scope review observation', () => {
    const src = readFileSync(new URL('./orchestrator.ts', import.meta.url), 'utf8');
    expect(src.split('classifyAbandonedRun(').length - 1).toBe(4);
    expect(src.split('reviewResultObserved: result.review !== undefined').length - 1).toBe(2);
    expect(src.split('reviewResultObserved: review !== undefined').length - 1).toBe(2);
    expect(src.split('mustFixReported: (result.review?.mustFix.length ?? 0) > 0').length - 1).toBe(2);
    expect(src.split('mustFixReported: (review?.mustFix.length ?? 0) > 0').length - 1).toBe(2);
  });

  test('cited evidence that exists does not reclassify a dirty worktree without completed-without-changes', () => {
    expect(classifyAbandonedRun({
      worktreePorcelain: ' M src/file.ts\n',
      citedEvidenceExists: true,
      mustFixReported: false,
    })).toEqual({
      classification: 'implementation-deficit',
      classificationBasis: 'no-must-fix-without-clean-worktree-or-completed-without-changes',
      worktreeClean: false,
      citedEvidenceExists: true,
      mustFixReported: false,
    });
  });

  test('existing ten-value classifications and bases stay selected when cited evidence exists', () => {
    expect(classifyAbandonedRun({
      worktreePorcelain: '',
      citedEvidenceExists: true,
      mustFixReported: true,
    })).toMatchObject({
      classification: 'implementation-deficit',
      classificationBasis: 'must-fix-reported',
      citedEvidenceExists: true,
    });
    expect(classifyAbandonedRun({
      worktreePorcelain: ' M src/file.ts\n',
      citedEvidenceExists: true,
      supervisorVerdict: 'CONTRACT-CONFLICT',
      mustFixReported: false,
    })).toMatchObject({ classification: 'contract-conflict', classificationBasis: 'supervisor-contract-conflict' });
    expect(classifyAbandonedRun({
      worktreePorcelain: ' M src/file.ts\n',
      citedEvidenceExists: true,
      stage: 'pr-declined',
      mustFixReported: false,
    })).toMatchObject({ classification: 'pr-declined', classificationBasis: 'pr-declined-stage' });
    expect(classifyAbandonedRun({
      worktreePorcelain: ' M src/file.ts\n',
      citedEvidenceExists: true,
      mergeApprovalReceived: true,
      mustFixReported: false,
    })).toMatchObject({ classification: 'merge-approved-abandoned', classificationBasis: 'merge-approval-received' });
    expect(classifyAbandonedRun({
      worktreePorcelain: ' M src/file.ts\n',
      citedEvidenceExists: true,
      quotaExhausted: true,
      mustFixReported: false,
    })).toMatchObject({ classification: 'quota-exhausted', classificationBasis: 'environment-quota-outranks-run-stage-evidence' });
    expect(classifyAbandonedRun({
      worktreePorcelain: ' M src/file.ts\n',
      citedEvidenceExists: true,
      credentialFailure: true,
      mustFixReported: false,
    })).toMatchObject({ classification: 'credential-failure', classificationBasis: 'environment-credential-outranks-run-stage-evidence' });
    expect(classifyAbandonedRun({
      worktreePorcelain: ' M src/file.ts\n',
      citedEvidenceExists: true,
      providerError: true,
      mustFixReported: false,
    })).toMatchObject({ classification: 'provider-error', classificationBasis: 'environment-provider-error-outranks-run-stage-evidence' });
    expect(classifyAbandonedRun({
      worktreePorcelain: ' M src/file.ts\n',
      citedEvidenceExists: true,
      supervisorVerdict: 'UNCONVERGEABLE',
      goalCauseObserved: true,
      mustFixReported: false,
    })).toMatchObject({ classification: 'goal-unconvergeable-candidate', classificationBasis: 'supervisor-unconvergeable-goal-candidate' });
    expect(classifyAbandonedRun({
      worktreePorcelain: '',
      citedEvidenceExists: true,
      goalType: 'research',
      mustFixReported: false,
    })).toMatchObject({ classification: 'artifact-deficit', classificationBasis: 'non-implement-goal-type-artifact-deficit' });
  });

  test('reads porcelain from a real clean and dirty worktree', () => {
    const repo = mkdtempSync(join(tmpdir(), 'abandoned-classification-'));
    const git = (...args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    try {
      git('init', '-q');
      expect(readWorktreePorcelain(repo)).toBe('');
      writeFileSync(join(repo, 'artifact.ts'), 'export const artifact = true;\n');
      expect(readWorktreePorcelain(repo)).toBe('?? artifact.ts\n');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('classificationBasis 는 «동어반복이 아니다»', () => {
  // 🩸 계기(2026-09-20 · 채널 #16815): block 아티팩트에서 네 칸이 2:2 로 갈렸고
  //   (reason·stage=게이트 ↔ 중단원인·classification=쿼타) 중재해야 할 «근거» 칸이
  //   분류 이름을 그대로 되풀이해 아무것도 «더» 말하지 않았다. 사람이 그것을 모순으로 읽었다.
  test('⛔ 어떤 분기도 «분류 이름»을 근거로 되풀이하지 않는다', () => {
    const src = readFileSync(new URL('./abandoned-classification.ts', import.meta.url), 'utf8');
    const block = /const classificationBasis[\s\S]*?\}\)\(\);/.exec(src)?.[0] ?? '';
    expect(block).not.toBe('');
    const pairs = [...block.matchAll(/case '([a-z-]+)': return '([a-z-]+)';/g)]
      .map(([, cls, basis]) => ({ cls, basis }));
    const requestBasis = /case '(provider-error)': return input.providerErrorCategory === 'request'\s*\? '([a-z-]+)'/.exec(block);
    if (requestBasis) pairs.push({ cls: requestBasis[1]!, basis: requestBasis[2]! });
    // ⛔ 분모를 «먼저» 단언한다 — 정규식이 0건을 내면 이 시험이 «조용히 초록»이 된다.
    // report-deficit 은 측정/미측정 삼항이라 이 정규식에 안 잡힌다(아래 별도 단언).
    expect(pairs.length).toBeGreaterThanOrEqual(9);
    expect(pairs.filter((pair) => pair.cls === pair.basis)).toEqual([]);
    expect(block).toContain("case 'provider-error': return input.providerErrorCategory === 'request'");
    expect(block).toContain("'provider-request-rejection-outranks-account-availability'");
    expect(block).toContain("case 'report-deficit'");
    expect(block).toContain("'no-must-fix-clean-worktree'");
    expect(block).toContain("'no-must-fix-completed-without-changes'");
    expect(block).toContain("'no-must-fix-clean-worktree-and-completed-without-changes'");
    expect(block).toContain('no-must-fix-clean-worktree-with-cited-evidence-unmeasured');
    expect(block).toContain('terminal-state-not-reviewed');
    expect(block).toContain('review-result-observation-unmeasured');
    expect(block).not.toContain('no-must-fix-clean-worktree-or-completed-without-changes');
    expect(block).not.toMatch(/case 'report-deficit': return 'report-deficit'/);
  });

  test('환경 셋은 «무엇을 눌렀는지»를 이름으로 말한다 — ⊕ 사실 자체는 그대로 실린다', () => {
    const cases = [
      { input: { quotaExhausted: true } as const, classification: 'quota-exhausted',
        basis: 'environment-quota-outranks-run-stage-evidence' },
      { input: { credentialFailure: true } as const, classification: 'credential-failure',
        basis: 'environment-credential-outranks-run-stage-evidence' },
      { input: { providerError: true } as const, classification: 'provider-error',
        basis: 'environment-provider-error-outranks-run-stage-evidence' },
    ];
    for (const c of cases) {
      const r = classifyAbandonedRun({ worktreePorcelain: ' M src/a.ts\n', mustFixReported: true, ...c.input });
      // ⛔ 문자열로 «좁혀» 비교한다 — 표의 리터럴 합집합이 반환 타입과 안 맞아 toBe 오버로드가 깨진다.
      expect(String(r.classification)).toBe(c.classification);
      expect(String(r.classificationBasis)).toBe(c.basis);
      // ⭐ 「환경이 구현 증거를 눌렀다」가 이름의 뜻이다 — mustFix 가 보고됐는데도 환경이 이겼다
      expect(r.mustFixReported).toBe(true);
    }
  });
});
