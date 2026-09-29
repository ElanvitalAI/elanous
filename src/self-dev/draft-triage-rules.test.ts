import { describe, expect, it } from 'bun:test';
import { decideDraft, type DraftTriageInput } from './draft-triage-rules.js';

const base: DraftTriageInput = {
  draft: { number: 1, title: 'same goal', branch: 'self-impl/x-goalid-a1b2c3-run' },
  runStatus: 'completed', mergedTwins: [], ageHours: 30, liveBranches: new Set(),
};

describe('decideDraft', () => {
  it('keeps living runs and branches even with a merged twin', () => {
    expect(decideDraft({ ...base, runStatus: 'running', mergedTwins: [{ number: 2, title: 'same goal', branch: 'other' }] })).toEqual({ action: 'keep', reason: 'live' });
    expect(decideDraft({ ...base, liveBranches: new Set([base.draft.branch]) })).toEqual({ action: 'keep', reason: 'live' });
  });
  it('closes a same-title merged twin of a one-hour-old ended run', () => {
    expect(decideDraft({ ...base, ageHours: 1, mergedTwins: [{ number: 2, title: 'same goal', branch: 'other' }] })).toEqual({ action: 'close', reason: 'superseded-by #2' });
  });
  it('closes a merged goalid lineage without a matching title', () => {
    expect(decideDraft({ ...base, ageHours: 1, mergedTwins: [{ number: 3, title: 'different', branch: 'self-impl/y-goalid-a1b2c3-new' }] })).toEqual({ action: 'close', reason: 'superseded-by #3' });
  });
  it('closes stale ended runs including completed and ended-unclosed', () => {
    expect(decideDraft(base)).toEqual({ action: 'close', reason: 'stale-ended-run' });
    expect(decideDraft({ ...base, runStatus: 'ended-unclosed' })).toEqual({ action: 'close', reason: 'stale-ended-run' });
  });
  it('keeps recent ended runs and indeterminate runs', () => {
    expect(decideDraft({ ...base, ageHours: 3 })).toEqual({ action: 'keep', reason: 'recent' });
    expect(decideDraft({ ...base, runStatus: undefined })).toEqual({ action: 'keep', reason: 'unobserved' });
    expect(decideDraft({ ...base, runStatus: 'unknown' })).toEqual({ action: 'close', reason: 'stale-ended-run' });
  });
  it('keeps human approval drafts even when stale or superseded', () => {
    expect(decideDraft({ ...base, draft: { ...base.draft, labels: ['elanous:idea-approval'] }, mergedTwins: [{ number: 2, title: 'same goal', branch: 'other' }] })).toEqual({ action: 'keep', reason: 'label:elanous:idea-approval' });
    for (const label of ['elanous:keep']) {
      expect(decideDraft({ ...base, draft: { ...base.draft, labels: [label] }, ageHours: 100 })).toEqual({ action: 'keep', reason: `label:${label}` });
    }
    // Origin labels carry no protection.
    expect(decideDraft({ ...base, draft: { ...base.draft, labels: ['elanous:from-harness'] }, ageHours: 100 }).action).toBe('close');
  });
});
