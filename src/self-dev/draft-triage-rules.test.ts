import { describe, expect, it } from 'bun:test';
import { branchStem, decideDraft, isAutoTitle, sameGoalPr, type DraftTriageInput, type DraftTriagePr } from './draft-triage-rules.js';

const base: DraftTriageInput = {
  draft: { number: 1, title: 'same goal', branch: 'self-impl/x-goalid-a1b2c3-run' },
  runStatus: 'completed', mergedTwins: [], ageHours: 30, liveBranches: new Set(),
};

describe('decideDraft', () => {
  it('closes only A against the newer same-title same-stem open B', () => {
    const openDrafts: DraftTriagePr[] = [
      { number: 1, title: 'T', branch: 'self-impl/x-aaaaaaaa-r1', createdAt: '2026-10-03T10:00:00Z' },
      { number: 2, title: 'T', branch: 'self-impl/x-bbbbbbbb-r2', createdAt: '2026-10-03T11:00:00Z' },
      { number: 3, title: 'T', branch: 'self-impl/y-cccccccc-r3', createdAt: '2026-10-03T12:00:00Z' },
      { number: 4, title: 'U', branch: 'self-impl/x-dddddddd-r4', createdAt: '2026-10-03T13:00:00Z' },
    ];
    const decide = (draft: DraftTriagePr, overrides: Partial<DraftTriageInput> = {}) =>
      decideDraft({ ...base, draft, ageHours: 1, openDrafts, ...overrides });
    expect(openDrafts.map((draft) => decide(draft))).toEqual([
      { action: 'close', reason: 'duplicate-of-open #2' },
      { action: 'keep', reason: 'recent' },
      { action: 'keep', reason: 'recent' },
      { action: 'keep', reason: 'recent' },
    ]);
    expect(decide({ ...openDrafts[0]!, labels: ['elanous:keep'] })).toEqual({ action: 'keep', reason: 'label:elanous:keep' });
    expect(decide(openDrafts[0]!, { runStatus: 'running' })).toEqual({ action: 'keep', reason: 'live' });
    expect(decide(openDrafts[0]!, { liveBranches: new Set([openDrafts[0]!.branch]) }))
      .toEqual({ action: 'keep', reason: 'branch-finality-unobserved' });
    expect(decide(openDrafts[0]!, { mergedTwins: [{ number: 9, title: 'T', branch: 'self-impl/x-eeeeeeee-r9' }] }))
      .toEqual({ action: 'close', reason: 'superseded-by #9' });
  });
  it('selects the newest valid open attempt, without guessing missing title, time or branch stem', () => {
    const draft: DraftTriagePr = { number: 1, title: 'T', branch: 'self-impl/x-aaaaaaaa-r1', createdAt: '2026-10-03T10:00:00Z' };
    const newer: DraftTriagePr = { ...draft, number: 2, branch: 'self-impl/x-bbbbbbbb-r2', createdAt: '2026-10-03T11:00:00Z' };
    const newest: DraftTriagePr = { ...newer, number: 5, branch: 'self-impl/x-eeeeeeee-r5', createdAt: '2026-10-03T14:00:00Z' };
    const decide = (candidate: DraftTriagePr, openDrafts: DraftTriagePr[]) =>
      decideDraft({ ...base, draft: candidate, ageHours: 1, openDrafts });
    expect(decide(draft, [newer, newest])).toEqual({ action: 'close', reason: 'duplicate-of-open #5' });
    expect(decideDraft({ ...base, draft, ageHours: 1 })).toEqual({ action: 'keep', reason: 'recent' });
    for (const missing of [
      { ...draft, title: undefined }, { ...draft, createdAt: undefined },
      { ...draft, branch: 'self-impl/x-invalid-r1' },
    ]) expect(decide(missing, [newer]).action).toBe('keep');
    for (const candidate of [
      { ...newer, title: undefined }, { ...newer, createdAt: undefined }, { ...newer, createdAt: 'invalid' },
      { ...newer, branch: 'self-impl/x-invalid-r2' }, { ...newer, createdAt: draft.createdAt },
      { ...newer, number: draft.number },
    ]) expect(decide(draft, [candidate]).action).toBe('keep');
    expect(branchStem(draft.branch)).toBe('x');
    expect(branchStem('self-impl/x-aaaaaaaa-r')).toBeUndefined();
    expect(branchStem('other/x-aaaaaaaa-r1')).toBeUndefined();
  });
  it('keeps living runs and branches even with a merged twin', () => {
    expect(decideDraft({ ...base, runStatus: 'running', mergedTwins: [{ number: 2, title: 'same goal', branch: 'other' }] })).toEqual({ action: 'keep', reason: 'live' });
    expect(decideDraft({ ...base, liveBranches: new Set([base.draft.branch]), finalRunResult: false }))
      .toEqual({ action: 'keep', reason: 'live' });
    expect(decideDraft({ ...base, liveBranches: new Set([base.draft.branch]) }))
      .toEqual({ action: 'keep', reason: 'branch-finality-unobserved' });
  });
  it('closes a same-title merged twin of a one-hour-old ended run', () => {
    const draft = { number: 1, title: 'same goal', branch: 'self-impl/sg-aaaaaaaa-r1' };
    expect(decideDraft({ ...base, draft, ageHours: 1, mergedTwins: [{ number: 2, title: 'same goal', branch: 'self-impl/sg-bbbbbbbb-r2' }] })).toEqual({ action: 'close', reason: 'superseded-by #2' });
  });
  it('closes a merged goalid lineage without a matching title', () => {
    expect(decideDraft({ ...base, ageHours: 1, mergedTwins: [{ number: 3, title: 'different', branch: 'self-impl/y-goalid-a1b2c3-new' }] })).toEqual({ action: 'close', reason: 'superseded-by #3' });
  });
  it('requires verified file coverage and matching slot for a branch-prefix replacement', () => {
    const row = { ...base.draft, title: 'old', branch: 'self-impl/shared-aaaaaaaa-r1', body: '칸: TC-17',
      createdAt: '2026-09-01T00:00:00Z', changedFiles: ['src/a.ts'],
      latestFileChanges: { 'src/a.ts': '2026-09-01T12:00:00Z' } };
    const merged = { number: 42, title: 'new', branch: 'self-impl/shared-bbbbbbbb-r2', body: '칸: TC-17',
      mergedAt: '2026-09-02T00:00:00Z', changedFiles: ['src/a.ts'] };
    expect(decideDraft({ ...base, draft: row, ageHours: 1, mergedTwins: [merged] }))
      .toEqual({ action: 'close', reason: 'superseded-by #42 (all-files-landed)' });
    for (const variation of [
      { body: '칸: TC-18' }, { mergedAt: '2026-08-31T00:00:00Z' },
      { changedFiles: ['src/b.ts'] },
    ]) expect(decideDraft({ ...base, draft: row, ageHours: 1, mergedTwins: [{ ...merged, ...variation }] }))
      .toEqual({ action: 'keep', reason: 'recent' });
    expect(decideDraft({ ...base, draft: { ...row, latestFileChanges: undefined }, ageHours: 1,
      mergedTwins: [merged] })).toEqual({ action: 'keep', reason: 'recent' });
    expect(decideDraft({ ...base, draft: { ...row, branch: 'self-impl/shared-goalid-cafe-aaaaaaaa-r1' },
      ageHours: 1, mergedTwins: [{ ...merged, branch: 'self-impl/shared-goalid-beef-bbbbbbbb-r2' }] }))
      .toEqual({ action: 'keep', reason: 'recent' });
  });
  it('closes a different-title harvest explicitly referencing the draft number, but not a neighboring number', () => {
    const harvested = { number: 7, title: 'unrelated heading', branch: 'work/different', body: 'Implemented (수확 #1)' };
    expect(decideDraft({ ...base, ageHours: 1, mergedTwins: [harvested] })).toEqual({ action: 'close', reason: 'superseded-by #7 (harvest #1)' });
    expect(decideDraft({ ...base, ageHours: 1, mergedTwins: [{ ...harvested, body: 'superseded #10' }] }).action).toBe('keep');
    expect(decideDraft({ ...base, ageHours: 1, mergedTwins: [{ ...harvested, body: '',
      landingVerifiedComments: ['landing-verified: draft #1 landed'] }] }).action).toBe('close');
    for (const text of ['superseded #1', 'landing-verified: superseded #1']) {
      expect(decideDraft({ ...base, ageHours: 1, mergedTwins: [{ ...harvested, body: '', mergeCommitMessage: text }] }).action).toBe('close');
    }
    for (const text of ['superseded #1', '(수확 #1)', 'landing-verified: superseded #10']) {
      expect(decideDraft({ ...base, ageHours: 1, mergedTwins: [{ ...harvested, body: '', landingVerifiedComments: [text] }] }).action).toBe('keep');
    }
    expect(decideDraft({ ...base, ageHours: 1, mergedTwins: [{ ...harvested, body: '',
      landingVerifiedComments: ['landing-verified: superseded #1'] }] }).action).toBe('close');
    for (const text of ['landing-verified: PR #30 landed; see tracking #1',
      'landing-verified: draft #10 landed; see tracking #1', 'landing-verified: PR #1 landed']) {
      expect(decideDraft({ ...base, ageHours: 1, mergedTwins: [{ ...harvested, body: '',
        landingVerifiedComments: [text] }] }).action).toBe('keep');
    }
  });
  it('closes only when later same-slot landings cover every changed file', () => {
    const draft = { ...base.draft, createdAt: '2026-09-01T00:00:00Z', body: '칸: UX 10-03', changedFiles: ['a.ts', 'b.ts'],
      latestFileChanges: { 'a.ts': '2026-09-01T12:00:00Z', 'b.ts': '2026-09-01T12:00:00Z' } };
    const landed = { number: 8, branch: 'other', title: 'different', body: '칸: UX 10-03', mergedAt: '2026-09-02T00:00:00Z', changedFiles: ['a.ts', 'b.ts'] };
    expect(decideDraft({ ...base, draft, ageHours: 1, mergedTwins: [landed] })).toEqual({ action: 'close', reason: 'superseded-by #8 (all-files-landed)' });
    for (const variation of [{ changedFiles: ['a.ts'] }, { mergedAt: '2026-08-31T00:00:00Z' }, { body: '칸: UX 10-04' }]) {
      expect(decideDraft({ ...base, draft, ageHours: 1, mergedTwins: [{ ...landed, ...variation }] }).action).toBe('keep');
    }
    expect(decideDraft({ ...base, draft: { ...draft, changedFiles: [] }, ageHours: 1, mergedTwins: [landed] }).action).toBe('keep');
    const ambiguousChanges: Array<Readonly<Record<string, string>> | undefined> = [
      undefined, { 'a.ts': '2026-09-01T12:00:00Z' },
      { 'a.ts': '2026-09-03T00:00:00Z', 'b.ts': '2026-09-01T12:00:00Z' },
      { 'a.ts': 'invalid', 'b.ts': '2026-09-01T12:00:00Z' },
    ];
    for (const latestFileChanges of ambiguousChanges) {
      expect(decideDraft({ ...base, draft: { ...draft, latestFileChanges }, ageHours: 1,
        mergedTwins: [landed] }).action).toBe('keep');
    }
    expect(decideDraft({ ...base, draft, ageHours: 1, mergedTwins: [
      { ...landed, changedFiles: ['a.ts'] },
      { ...landed, number: 11, changedFiles: ['b.ts'] },
    ] })).toEqual({ action: 'close', reason: 'superseded-by #8, #11 (all-files-landed)' });
  });
  it('does not treat a retained worktree as live after the ledger records self-implement.result final', () => {
    expect(decideDraft({ ...base, runStatus: 'self-implement.result final', liveBranches: new Set([base.draft.branch]) }))
      .toEqual({ action: 'close', reason: 'stale-ended-run (self-implement.result final; worktree is not live)' });
  });
  it('closes stale ended runs including completed and ended-unclosed', () => {
    expect(decideDraft(base)).toEqual({ action: 'close', reason: 'stale-ended-run' });
    expect(decideDraft({ ...base, runStatus: 'ended-unclosed' })).toEqual({ action: 'close', reason: 'stale-ended-run' });
  });
  it('keeps recent ended runs and indeterminate runs', () => {
    expect(decideDraft({ ...base, ageHours: 3 })).toEqual({ action: 'keep', reason: 'recent' });
    expect(decideDraft({ ...base, runStatus: undefined, ageHours: 3 })).toEqual({ action: 'keep', reason: 'unobserved' });
    expect(decideDraft({ ...base, runStatus: 'unknown' })).toEqual({ action: 'close', reason: 'stale-ended-run' });
  });
  it('closes unobserved merged goal ids and exact titles before checking age', () => {
    expect(decideDraft({ ...base, runStatus: undefined, ageHours: 3, mergedTwins: [
      { number: 20, title: 'other', branch: 'self-impl/y-goalid-a1b2c3-new' },
    ] })).toEqual({ action: 'close', reason: 'superseded-by #20' });
    expect(decideDraft({ ...base, draft: { number: 1, title: 'same goal', branch: 'self-impl/sg-aaaaaaaa-r1' }, runStatus: undefined, ageHours: 3, mergedTwins: [
      { number: 21, title: 'same goal', branch: 'self-impl/sg-bbbbbbbb-r2' },
    ] })).toEqual({ action: 'close', reason: 'superseded-by #21' });
  });
  it('closes unobserved non-live drafts at the 24h idle boundary, not 3h', () => {
    expect(decideDraft({ ...base, runStatus: undefined, ageHours: 25 })).toEqual({ action: 'close', reason: 'stale-unobserved' });
    expect(decideDraft({ ...base, runStatus: undefined, ageHours: 24 })).toEqual({ action: 'close', reason: 'stale-unobserved' });
    expect(decideDraft({ ...base, runStatus: undefined, ageHours: NaN })).toEqual({ action: 'keep', reason: 'unobserved' });
    expect(decideDraft({ ...base, runStatus: undefined, ageHours: 3 })).toEqual({ action: 'keep', reason: 'unobserved' });
  });
  it('keeps human approval drafts even when stale or superseded', () => {
    expect(decideDraft({ ...base, draft: { ...base.draft, labels: ['elanous:idea-approval'] }, mergedTwins: [{ number: 2, title: 'same goal', branch: 'other' }] })).toEqual({ action: 'keep', reason: 'label:elanous:idea-approval' });
    for (const label of ['elanous:keep', 'elanous:release-hold', 'elanous:release-path']) {
      expect(decideDraft({ ...base, runStatus: undefined, draft: { ...base.draft, labels: [label] }, ageHours: 100,
        mergedTwins: [{ number: 2, title: 'same goal', branch: 'other' }] })).toEqual({ action: 'keep', reason: `label:${label}` });
    }
    const harvested = { number: 7, title: 'different', branch: 'other', body: '(수확 #1)' };
    expect(decideDraft({ ...base, draft: { ...base.draft, labels: ['elanous:keep'] }, mergedTwins: [harvested] }))
      .toEqual({ action: 'keep', reason: 'label:elanous:keep' });
    // Origin labels carry no protection.
    expect(decideDraft({ ...base, draft: { ...base.draft, labels: ['elanous:from-harness'] }, ageHours: 100 }).action).toBe('close');
  });
});

describe('sameGoalPr (TC 10-05 · identifier first, title only with harness stem)', () => {
  it('compares goal identifiers when both carry one', () => {
    expect(sameGoalPr({ number: 1, title: 'A', branch: 'self-impl/x-goalid-abc1-r1' }, { number: 2, title: 'B', branch: 'self-impl/y-goalid-abc1-r2' })).toBe(true);
    expect(sameGoalPr({ number: 1, title: 'Same', branch: 'self-impl/x-goalid-abc1-r1' }, { number: 2, title: 'Same', branch: 'self-impl/x-goalid-def2-r2' })).toBe(false);
    expect(sameGoalPr({ number: 1, title: 'Same', branch: 'a', body: '골: one' }, { number: 2, title: 'Same', branch: 'b', body: '골: two' })).toBe(false);
  });
  it('never treats an auto title shared by different goals as the same goal', () => {
    const title = 'src/harness: harness-queue.ts';
    expect(isAutoTitle(title)).toBe(true);
    expect(isAutoTitle('src: hq.ts, fence-audit.ts, registry.ts')).toBe(true);
    expect(isAutoTitle('fix seat loop downgrade')).toBe(false);
    expect(sameGoalPr({ number: 1, title, branch: 'self-impl/x-aaaaaaaa-r1' }, { number: 2, title, branch: 'self-impl/x-bbbbbbbb-r2' })).toBe(false);
  });
  it('needs exact title, both harness branches and the same stem when an identifier is missing', () => {
    const a = { number: 1, title: 'Same', branch: 'self-impl/x-aaaaaaaa-r1' };
    expect(sameGoalPr(a, { number: 2, title: 'Same', branch: 'self-impl/x-bbbbbbbb-r2' })).toBe(true);
    expect(sameGoalPr(a, { number: 2, title: 'Same', branch: 'feature/x' })).toBe(false);
    expect(sameGoalPr(a, { number: 2, title: 'Same', branch: 'self-impl/y-bbbbbbbb-r2' })).toBe(false);
    expect(sameGoalPr(a, { number: 2, title: 'Other', branch: 'self-impl/x-bbbbbbbb-r2' })).toBe(false);
  });
});
