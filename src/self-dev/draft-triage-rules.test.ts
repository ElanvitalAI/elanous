import { describe, expect, it } from 'bun:test';
import { assessDraftTriage, branchStem, decideDraft, draftClaimComment, draftClaimState, draftReleaseComment, isAutoTitle, sameGoalPr, sameVerifiedGoal, type DraftTriageInput, type DraftTriagePr } from './draft-triage-rules.js';
import { RELEASE_PATH_LABEL } from './release-path-guard.js';

it('preserves manual claim bytes and distinguishes missing timestamps from expiry', () => {
  const now = new Date('2026-09-30T00:00:00Z');
  expect(draftClaimComment('TC', now)).toBe('🔧 처리 중 — owner TC · 2026-09-30T00:00:00.000Z');
  expect(draftClaimComment('UX', now, ' run R ')).toBe('🔧 처리 중 — owner UX · 2026-09-30T00:00:00.000Z · run R');
  expect(draftReleaseComment(now)).toBe('🔧 처리 끝 — 2026-09-30T00:00:00.000Z');
  expect(draftReleaseComment(now, 'run R · failed-with-pr')).toBe('🔧 처리 끝 — 2026-09-30T00:00:00.000Z · run R · failed-with-pr');
  expect(draftClaimState({ labels: ['elanous:running'], updatedAt: '2026-09-29T23:00:00Z' }, now)).toBe('claimed');
  expect(draftClaimState({ labels: ['elanous:running'], updatedAt: '2026-09-29T18:00:00Z' }, now)).toBe('expired');
  expect(draftClaimState({ labels: ['elanous:running'], updatedAt: '2026-09-29T17:00:00Z' }, now)).toBe('expired');
  expect(draftClaimState({ labels: ['elanous:running'] }, now)).toBe('unobserved');
  expect(draftClaimState({ labels: ['elanous:running', 'elanous:harvestable'] }, now)).toBe('unclaimed');
});

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
  it("DRAFT-ZERO: 명시적 harvest-deferred 표지가 검증된 실패 종료 draft만 {action:'keep', reason:'harvest-deferred'}를 반환하고, 동일 무대의 무표지 harvestable·stale·duplicate·superseded twin은 기존 판정을 유지한다", () => {
    // 동일 입력 무대 — 같은 칸·같은 실패 종료 run·같은 30h 시계·같은 twin/open 목록; 표지 한 줄만 차이난다.
    const twin = { number: 90, title: 'marker goal', branch: 'self-impl/markergoal-bbbbbbbb-r90', body: '칸: DRAFT-ZERO' };
    const newer = { number: 12, title: 'marker goal', branch: 'self-impl/markergoal-cccccccc-r12', createdAt: '2026-10-22T00:00:00Z' };
    const openDuplicate = { number: 17, title: 'dup goal', branch: 'self-impl/dp-bbbbbbbb-r17', createdAt: '2026-10-22T00:00:00Z' };
    const decide = (draft: DraftTriagePr, overrides: Partial<DraftTriageInput> = {}) => decideDraft({
      runStatus: 'failed', mergedTwins: [twin], openDrafts: [newer, openDuplicate],
      ageHours: 30, liveBranches: new Set(), draft, ...overrides,
    });
    const deferred: DraftTriagePr = { number: 11, title: 'marker goal', branch: 'self-impl/markergoal-aaaaaaaa-r11',
      labels: ['elanous:harvestable'], body: '칸: DRAFT-ZERO\n수확보류: harvest-deferred', createdAt: '2026-10-21T00:00:00Z' };
    // 검증된 표지 하나 — superseded twin·duplicate·harvestable·24h stale을 모두 이기고, PROTECTED_LABELS 선제 keep보다도 앞선다.
    expect(decide(deferred)).toEqual({ action: 'keep', reason: 'harvest-deferred' });
    expect(decide({ ...deferred, labels: ['elanous:harvestable', 'elanous:keep'] })).toEqual({ action: 'keep', reason: 'harvest-deferred' });
    // 같은 PR/body에서 runStatus만 바꾸면 실패 종료에서만 harvest-deferred 보호가 적용된다.
    expect(decide(deferred, { runStatus: 'completed' })).toEqual({ action: 'close', reason: 'superseded-by #90' });
    expect(decide(deferred, { runStatus: 'running' })).toEqual({ action: 'keep', reason: 'live' });
    expect(decide(deferred, { runStatus: undefined })).toEqual({ action: 'close', reason: 'superseded-by #90' });
    // 같은 PR에서 표지만 빼면 기존 판정 — superseded twin close.
    expect(decide({ ...deferred, body: '칸: DRAFT-ZERO' })).toEqual({ action: 'close', reason: 'superseded-by #90' });
    // 동일 칸의 무표지 harvestable — 기존 stale close (harvestable은 보호 표지가 아니다).
    expect(decide({ number: 13, title: 'harvest goal', branch: 'self-impl/hv-aaaaaaaa-r13',
      labels: ['elanous:harvestable'], body: '칸: DRAFT-ZERO', createdAt: '2026-10-21T00:00:00Z' }))
      .toEqual({ action: 'close', reason: 'stale-ended-run' });
    // 무표지 stale (run 미관측) — 기존 stale-unobserved close.
    expect(decide({ number: 15, title: 'stale goal', branch: 'self-impl/st-aaaaaaaa-r15',
      body: '칸: DRAFT-ZERO', createdAt: '2026-10-21T00:00:00Z' }, { runStatus: undefined }))
      .toEqual({ action: 'close', reason: 'stale-unobserved' });
    // 무표지 duplicate — 기존 duplicate-of-open close.
    expect(decide({ number: 16, title: 'dup goal', branch: 'self-impl/dp-aaaaaaaa-r16',
      body: '칸: DRAFT-ZERO', createdAt: '2026-10-21T00:00:00Z' }))
      .toEqual({ action: 'close', reason: 'duplicate-of-open #17' });
    // 다른 protected label — 기존 keep.
    expect(decide({ number: 18, title: 'held goal', branch: 'self-impl/hd-aaaaaaaa-r18',
      labels: ['elanous:keep'], body: '칸: DRAFT-ZERO', createdAt: '2026-10-21T00:00:00Z' }))
      .toEqual({ action: 'keep', reason: 'label:elanous:keep' });
  });
  it('DRAFT-ZERO: 수확보류 표지는 정확한 키·값으로만 검증된다 — 값 불일치·대소문자·충돌·들여쓰기·미기록은 기존 판정을 따른다', () => {
    // (a)와 같은 무대(표지 PR·twin)에서 표지 바이트만 바꿔 대조한다.
    const stage = (body: string | undefined): DraftTriageInput => ({
      draft: { number: 11, title: 'marker goal', branch: 'self-impl/markergoal-aaaaaaaa-r11',
        labels: ['elanous:harvestable'], body, createdAt: '2026-10-21T00:00:00Z' },
      runStatus: 'failed', mergedTwins: [{ number: 90, title: 'marker goal',
        branch: 'self-impl/markergoal-bbbbbbbb-r90', body: '칸: DRAFT-ZERO' }],
      openDrafts: [], ageHours: 30, liveBranches: new Set(),
    });
    for (const body of [
      '칸: DRAFT-ZERO\n수확보류: harvest-deferred',
      '칸: DRAFT-ZERO\n수확보류:harvest-deferred',
      '칸: DRAFT-ZERO\n수확보류:  harvest-deferred  ',
      '칸: DRAFT-ZERO\n수확보류: harvest-deferred\n수확보류: harvest-deferred',
    ]) expect(decideDraft(stage(body))).toEqual({ action: 'keep', reason: 'harvest-deferred' });
    for (const body of [
      '칸: DRAFT-ZERO',
      '칸: DRAFT-ZERO\n수확보류: later',
      '칸: DRAFT-ZERO\n수확보류: HARVEST-DEFERRED',
      '칸: DRAFT-ZERO\n수확보류: harvest-deferred\n수확보류: later',
      '칸: DRAFT-ZERO\n  수확보류: harvest-deferred',
      '칸: DRAFT-ZERO\n수확보류 : harvest-deferred',
    ]) expect(decideDraft(stage(body))).toEqual({ action: 'close', reason: 'superseded-by #90' });
    expect(decideDraft(stage(undefined))).toEqual({ action: 'close', reason: 'superseded-by #90' });
  });
});

describe('sameGoalPr (TC 10-05 · identifier first, title only with harness stem)', () => {
  it('compares goal identifiers when both carry one', () => {
    // review r7: a branch goal id on one side only is unverifiable — matching body «골:» lines must not close it.
    expect(sameVerifiedGoal({ number: 1, title: 'A', branch: 'self-impl/x-goalid-abc1-r1', body: '골: one' }, { number: 2, title: 'B', branch: 'tc/hand', body: '골: one' })).toBe(false);
    expect(sameVerifiedGoal({ number: 1, title: 'A', branch: 'a', body: '골: one' }, { number: 2, title: 'B', branch: 'b', body: '골: one' })).toBe(true);
    expect(sameVerifiedGoal({ number: 1, title: 'A', branch: 'self-impl/x-goalid-abc1-r1' }, { number: 2, title: 'B', branch: 'self-impl/y-goalid-abc1-r2' })).toBe(true);
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

const triageNow = new Date('2026-10-21T04:00:00.000Z');
const triageDraft: DraftTriagePr = {
  number: 101, branch: 'work/example', labels: ['elanous:from-ux'],
  body: '칸: DRAFT-TRIAGE-ANYTIME\n카드: ta-20261021-abcd12',
  latestCommitAt: '2026-10-19T03:00:00.000Z',
};

describe('assessDraftTriage', () => {
  it('separates proven harvest and explicit close-b from ungrounded drafts', () => {
    const ready = { draft: { ...triageDraft, labels: [...triageDraft.labels!, 'elanous:harvestable'] },
      now: triageNow, runStatus: 'completed', gate: 'pass' as const, review: 'approved' as const };
    expect(assessDraftTriage(ready).nextAction).toBe('harvest');
    expect(assessDraftTriage({ ...ready, gate: 'fail' }).nextAction).toBe('human');
    expect(assessDraftTriage({ ...ready, review: 'commented' }).nextAction).toBe('human');
    expect(assessDraftTriage({ ...ready, runStatus: undefined }).nextAction).toBe('human');
    expect(assessDraftTriage({ ...ready, draft: { ...ready.draft, body: '' } }).nextAction).toBe('human');
    const close = { draft: triageDraft, now: triageNow, runStatus: 'completed',
      replacement: { number: 900, evidence: 'Supersedes: #101' } };
    expect(assessDraftTriage(close)).toMatchObject({ nextAction: 'close-b',
      checks: { 'replacement-landed': { state: 'yes' } } });
    expect(assessDraftTriage({ ...close, draft: { ...triageDraft, body: '' } }).nextAction).toBe('human');
    expect(assessDraftTriage({ ...close, runStatus: 'running' }).nextAction).toBe('human');
    expect(assessDraftTriage({ ...close, replacement: undefined }).nextAction).toBe('human');
  });
  it('does not recommend a replacement close for a release-path hold', () => {
    const result = assessDraftTriage({ draft: { ...triageDraft, labels: ['elanous:from-ux', RELEASE_PATH_LABEL] },
      now: triageNow, runStatus: 'completed', replacement: { number: 900, evidence: 'Supersedes: #101' } });
    expect(result.nextAction).toBe('human');
    expect(result.checks.protected).toEqual({ state: 'yes', evidence: `보호 표지=${RELEASE_PATH_LABEL}` });
    expect(result.checks['replacement-landed'].state).toBe('yes');
  });

  it('requires repository-bound cell status before recommending close-a', () => {
    const unbound = assessDraftTriage({ draft: triageDraft, now: triageNow,
      runStatus: 'completed', cellStatus: 'done' });
    expect(unbound.nextAction).toBe('human');
    expect(unbound.checks['cell-complete'].state).toBe('unknown');
    expect(unbound.checks['cell-status-repository-bound'].state).toBe('unknown');

    const bound = assessDraftTriage({ draft: triageDraft, now: triageNow,
      runStatus: 'completed', cellStatus: 'done', cellStatusRepository: 'owner/repo', targetRepository: 'owner/repo' });
    expect(bound.nextAction).toBe('close-a');
    expect(bound.checks['cell-complete'].state).toBe('yes');
    expect(bound.checks['cell-status-repository-bound'].state).toBe('yes');

    const mismatched = assessDraftTriage({ draft: triageDraft, now: triageNow,
      runStatus: 'completed', cellStatus: 'done', cellStatusRepository: 'other/repo', targetRepository: 'owner/repo' });
    expect(mismatched.nextAction).toBe('human');
    expect(mismatched.checks['cell-status-repository-bound'].state).toBe('no');
  });

  it('newer same-cell same-card evidence alone does not authorize closure', () => {
    const result = assessDraftTriage({ draft: triageDraft, now: triageNow, runStatus: 'completed',
      cellStatus: 'yellow', newerSameCellSameCard: true });
    expect(result.nextAction).toBe('human');
    expect(result.checks.provenance.state).toBe('yes');
    expect(result.checks['newer-same-card'].state).toBe('yes');
    expect(result.checks['newer-same-card'].evidence).toContain('관측 표지이며 대체 증거가 아님');
  });

  it('treats conflicting or malformed cell markers as unknown provenance and withholds close recommendations', () => {
    for (const body of [
      '칸: DRAFT-TRIAGE-ANYTIME\n칸: ANOTHER-CELL\n카드: ta-20261021-abcd12',
      '칸: DRAFT-TRIAGE-ANYTIME\n  칸: ANOTHER-CELL\n카드: ta-20261021-abcd12',
    ]) {
      const draftWithConflictingCells = { ...triageDraft, body, latestCommitAt: '2026-09-18T00:00:00Z' };
      const result = assessDraftTriage({ draft: draftWithConflictingCells, now: triageNow,
        runStatus: 'self-implement.result final', ownerConfirmed: true });
      expect(result.nextAction).toBe('human');
      expect(result.cellId).toBeNull();
      expect(result.checks.provenance.state).toBe('unknown');
    }
  });

  it('requires unique same-line card markers for provenance', () => {
    for (const body of [
      '칸: DRAFT-TRIAGE-ANYTIME\n카드:\nta-20261021-abcd12',
      '칸: DRAFT-TRIAGE-ANYTIME\n카드: ta-20261021-abcd12\n  카드: ta-20261021-other34',
    ]) {
      const result = assessDraftTriage({ draft: { ...triageDraft, body, latestCommitAt: '2026-09-18T00:00:00Z' },
        now: triageNow, runStatus: 'self-implement.result final', ownerConfirmed: true });
      expect(result.nextAction).toBe('human');
      expect(result.cardId).toBeNull();
      expect(result.checks.provenance.state).toBe('unknown');
    }
  });

  it('keeps gate and exact-head review as observed facts without a harvest recommendation', () => {
    const result = assessDraftTriage({ draft: triageDraft, now: triageNow, runStatus: 'completed',
      gate: 'pass', review: 'approved' });
    expect(result.nextAction).toBe('human');
    expect(result.gate).toBe('pass');
    expect(result.review).toBe('approved');
    expect(result.checks.gate.state).toBe('yes');
    expect(result.checks.review.state).toBe('yes');
  });

  it('keeps replacement landing unknown when no adapter proves the PR relationship', () => {
    const result = assessDraftTriage({ draft: triageDraft, now: triageNow, runStatus: 'completed' });
    expect(result.nextAction).toBe('human');
    expect(result.checks['replacement-landed'].state).toBe('unknown');
    expect(result.checks['replacement-landed'].evidence).toContain('대체 관계를 증명하지 않음');
  });

  it('unknown provenance and owner never recommend closing; 48h close requires known owner', () => {
    const unknown = assessDraftTriage({ draft: { ...triageDraft, body: '' }, now: triageNow, runStatus: 'completed' });
    expect(unknown.nextAction).toBe('human');
    const unknownHead = assessDraftTriage({ draft: { ...triageDraft, latestCommitAt: undefined }, now: triageNow,
      runStatus: 'completed', cellStatus: 'done' });
    expect(unknownHead.nextAction).toBe('human');
    expect(unknownHead.checks['recent-commit'].state).toBe('unknown');
    const idle: DraftTriagePr = { ...triageDraft, latestCommitAt: '2026-10-18T00:00:00.000Z' };
    expect(assessDraftTriage({ draft: idle, now: triageNow, runStatus: 'completed', ownerConfirmed: false }).nextAction).toBe('human');
    expect(assessDraftTriage({ draft: idle, now: triageNow, runStatus: 'completed', ownerConfirmed: true }).nextAction).toBe('close-c');
  });

  it('running, protected label, and post-09:30 KST commit suppress close actions', () => {
    expect(assessDraftTriage({ draft: triageDraft, now: triageNow, runStatus: 'running', cellStatus: 'done' }).nextAction).toBe('human');
    expect(assessDraftTriage({ draft: { ...triageDraft, labels: [...triageDraft.labels!, 'triage:active'] }, now: triageNow,
      runStatus: 'completed', cellStatus: 'done' }).nextAction).toBe('human');
    expect(assessDraftTriage({ draft: { ...triageDraft, latestCommitAt: '2026-10-21T00:31:00.000Z' }, now: triageNow,
      runStatus: 'completed', cellStatus: 'done' }).nextAction).toBe('human');
  });

  it('does not recommend closure until a non-running run state is observed', () => {
    const ready = { draft: triageDraft, now: triageNow };
    expect(assessDraftTriage({ ...ready, runStatus: undefined }).nextAction).toBe('human');
    expect(assessDraftTriage({ ...ready, runStatus: 'running' }).nextAction).toBe('human');
    for (const closeSignal of [
      { cellStatus: 'done' as const },
      { cellStatus: 'yellow' as const, newerSameCellSameCard: true },
      { cellStatus: 'yellow' as const, ownerConfirmed: true },
    ]) {
      expect(assessDraftTriage({ draft: triageDraft, now: triageNow, ...closeSignal }).nextAction).toBe('human');
    }
    expect(assessDraftTriage({ draft: triageDraft, now: triageNow, runStatus: 'unknown', cellStatus: 'done' }).nextAction).toBe('human');
    expect(assessDraftTriage({ draft: triageDraft, now: triageNow, runStatus: 'unknown', cellStatus: 'done' }).checks.running.state).toBe('unknown');
  });

  it('never recommends relaunch from this triage; relaunch preflight owns that decision', () => {
    const result = assessDraftTriage({ draft: triageDraft, now: triageNow, runStatus: 'completed', cellStatus: 'yellow' });
    expect(result.nextAction).toBe('human');
    expect(result.checks).not.toHaveProperty('relaunch-conditions');
  });
});
