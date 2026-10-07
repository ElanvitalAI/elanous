import { describe, expect, it } from 'bun:test';
import { createRoundPrTracker, defaultRoundPrAdapters, roundPrRef, type RoundPrAdapters, type RoundPrRef, type RoundPrView } from './round-pr-supersede.js';
import type { SelfDevJobResult } from './orchestrate.js';

const url = (n: number) => `https://github.com/acme/repo/pull/${n}`;
const job = (feature: string, pr: number, over: Partial<SelfDevJobResult> = {}): SelfDevJobResult =>
  ({ taskId: `task:${pr}`, feature, status: 'failed', stage: 'review-blocked', prUrl: url(pr), ...over } as SelfDevJobResult);

function fakeGh(views: Record<number, RoundPrView | null>) {
  const calls: Array<{ op: 'label' | 'comment' | 'close'; pr: number; arg: string }> = [];
  const failClose = new Set<number>();
  const adapters: RoundPrAdapters = {
    view: (pr: RoundPrRef) => views[pr.number] ?? null,
    addLabel: (pr, label) => {
      calls.push({ op: 'label', pr: pr.number, arg: label });
      const current = views[pr.number];
      if (current) views[pr.number] = { ...current, labels: [...current.labels, label] };
      return true;
    },
    comment: (pr, body) => { calls.push({ op: 'comment', pr: pr.number, arg: body }); return true; },
    close: (pr) => { calls.push({ op: 'close', pr: pr.number, arg: '' }); return !failClose.has(pr.number); },
  };
  return { adapters, calls, failClose };
}
const openDraft: RoundPrView = { state: 'OPEN', isDraft: true, labels: [], comments: [] };

describe('round PR supersede — same run + goal', () => {
  it('round 2 of the same goal supersedes round 1 exactly once, with a link to the new PR', () => {
    const gh = fakeGh({ 101: openDraft, 102: openDraft });
    const events: Array<[string, Record<string, unknown>]> = [];
    const tracker = createRoundPrTracker({ runId: 'run-x', adapters: gh.adapters, observe: (e, d) => events.push([e, d]) });
    tracker.record([job('goal A', 101)], 0);
    const out = tracker.record([job('goal A', 102)], 1);
    expect(out).toEqual([{ kind: 'superseded', round: 1, prevPr: 101, pr: 102 }]);
    expect(gh.calls.map((c) => `${c.op}#${c.pr}`)).toEqual(['label#101', 'comment#101', 'close#101']);
    expect(gh.calls[0]!.arg).toBe('elanous:superseded');
    expect(gh.calls[1]!.arg).toContain('#102 (https://github.com/acme/repo/pull/102)');
    expect(gh.calls[1]!.arg).toContain('run-x');
    expect(events).toEqual([['round-pr-superseded', { runId: 'run-x', round: 1, prevPr: 101, pr: 102 }]]);
    // Round 3 of the same goal: only round 2 is superseded — round 1 is never touched again.
    gh.calls.length = 0;
    tracker.record([job('goal A', 103, { status: 'done', stage: 'merged', merged: true })], 2);
    expect(gh.calls.map((c) => `${c.op}#${c.pr}`)).toEqual(['label#102', 'comment#102', 'close#102']);
  });

  it('a different goal in the same run is untouched', () => {
    const gh = fakeGh({ 101: openDraft, 200: openDraft });
    const tracker = createRoundPrTracker({ runId: 'run-x', adapters: gh.adapters, observe: () => {} });
    tracker.record([job('goal A', 101), job('goal B', 200)], 0);
    const out = tracker.record([job('goal A', 102), job('goal B', 200, { resumeDisposition: 'skip' })], 1);
    expect(out.map((o) => `${o.kind}:${o.prevPr}`)).toEqual(['superseded:101']);
    expect(gh.calls.some((c) => c.pr === 200)).toBe(false);
  });

  it('a merged PR is never superseded — by the result or by the live view', () => {
    const gh = fakeGh({ 101: { state: 'MERGED', isDraft: false, labels: [], mergedAt: '2026-10-07T00:00:00Z', comments: [] }, 301: openDraft });
    const tracker = createRoundPrTracker({ runId: 'run-x', adapters: gh.adapters, observe: () => {} });
    tracker.record([job('goal A', 101), job('goal C', 301, { status: 'done', stage: 'merged', merged: true })], 0);
    const out = tracker.record([job('goal A', 102), job('goal C', 302)], 1);
    expect(out.map((o) => o.kind === 'kept' ? `kept:${o.prevPr}:${o.reason}` : `${o.kind}:${o.prevPr}`))
      .toEqual(['kept:301:merged', 'kept:101:state:MERGED']);
    expect(gh.calls).toEqual([]);
  });

  it('keeps non-draft, protected, unobserved and other-repository PRs; retries only the unobserved one', () => {
    const views: Record<number, RoundPrView | null> = {
      1: { state: 'OPEN', isDraft: false, labels: [], comments: [] },
      2: { state: 'OPEN', isDraft: true, labels: ['elanous:keep'], comments: [] },
      3: null,
    };
    const gh = fakeGh(views);
    const tracker = createRoundPrTracker({ runId: null, adapters: gh.adapters, observe: () => {} });
    tracker.record([job('a', 1), job('b', 2), job('c', 3), job('d', 4, { prUrl: 'https://github.com/other/repo/pull/4' })], 0);
    const out = tracker.record([job('a', 11), job('b', 12), job('c', 13), job('d', 14)], 1);
    expect(out.map((o) => (o as { reason?: string }).reason)).toEqual(['not-draft', 'label:elanous:keep', 'view-unobserved', 'other-repository']);
    expect(gh.calls).toEqual([]);
    views[3] = openDraft;
    // No new PR next round: the newer PR #13 continues, and the unobserved supersede of #3 is retried.
    const retried = tracker.record([job('c', 13)], 2);
    expect(retried.map((o) => `${o.kind}:${o.prevPr}`)).toEqual(['continued:13', 'superseded:3']);
    expect(gh.calls.filter((c) => c.pr === 3).map((c) => c.op)).toEqual(['label', 'comment', 'close']);
    expect(tracker.record([job('c', 13)], 3).filter((o) => o.kind === 'superseded')).toEqual([]);
  });

  it('the same PR in a later round is reported as continued, not superseded', () => {
    const gh = fakeGh({ 101: openDraft });
    const events: string[] = [];
    const tracker = createRoundPrTracker({ runId: 'run-x', adapters: gh.adapters, observe: (e) => events.push(e) });
    tracker.record([job('goal A', 101)], 0);
    expect(tracker.record([job('goal A', 101)], 1)).toEqual([{ kind: 'continued', round: 1, prevPr: 101, pr: 101 }]);
    expect(events).toEqual(['round-pr-continued']);
    expect(gh.calls).toEqual([]);
  });

  it('two PRs of one goal key within the same round are not superseded by each other', () => {
    const gh = fakeGh({ 101: openDraft, 102: openDraft });
    const tracker = createRoundPrTracker({ runId: 'run-x', adapters: gh.adapters, observe: () => {} });
    expect(tracker.record([job('goal A', 101), job('goal A', 102)], 0)).toEqual([]);
    expect(tracker.record([job('goal A', 101), job('goal A', 102)], 1).filter((o) => o.kind !== 'continued')).toEqual([]);
    expect(gh.calls).toEqual([]);
  });

  it('a close that fails after the link comment is retried next round without a second comment', () => {
    const gh = fakeGh({ 101: openDraft });
    gh.failClose.add(101);
    const tracker = createRoundPrTracker({ runId: 'run-x', adapters: gh.adapters, observe: () => {} });
    tracker.record([job('goal A', 101)], 0);
    expect(tracker.record([job('goal A', 102)], 1)).toEqual([{ kind: 'kept', round: 1, prevPr: 101, pr: 102, reason: 'close-failed' }]);
    gh.failClose.delete(101);
    // The next round brings no new PR (#102 continues): the close is retried anyway, without a second comment.
    expect(tracker.record([job('goal A', 102)], 2).filter((o) => o.prevPr === 101)).toEqual([{ kind: 'superseded', round: 2, prevPr: 101, pr: 102 }]);
    // The retry re-reads the PR: the label is already there, the comment was posted — only close runs again.
    expect(gh.calls.filter((c) => c.pr === 101).map((c) => c.op)).toEqual(['label', 'comment', 'close', 'close']);
  });

  it('a retried supersede keeps linking its first successor, and runs even in a round with no PR', () => {
    const gh = fakeGh({ 101: openDraft });
    gh.failClose.add(101);
    const events: Array<[string, Record<string, unknown>]> = [];
    const tracker = createRoundPrTracker({ runId: 'run-x', adapters: gh.adapters, observe: (e, d) => events.push([e, d]) });
    tracker.record([job('goal A', 101)], 0);
    tracker.record([job('goal A', 102)], 1);
    gh.failClose.delete(101);
    const out = tracker.record([], 2);
    expect(out).toEqual([{ kind: 'superseded', round: 2, prevPr: 101, pr: 102 }]);
    expect(events.at(-1)).toEqual(['round-pr-superseded', { runId: 'run-x', round: 2, prevPr: 101, pr: 102 }]);
    expect(gh.calls.filter((c) => c.op === 'comment').map((c) => c.pr)).toEqual([101]);
  });

  it('the same PR spelled with a different repository case is one PR, never a successor', () => {
    const gh = fakeGh({ 101: openDraft });
    const tracker = createRoundPrTracker({ runId: 'run-x', adapters: gh.adapters, observe: () => {} });
    tracker.record([job('goal A', 101)], 0);
    const out = tracker.record([job('goal A', 101, { prUrl: 'https://github.com/ACME/Repo/pull/101' })], 1);
    expect(out).toEqual([{ kind: 'continued', round: 1, prevPr: 101, pr: 101 }]);
    expect(gh.calls).toEqual([]);
  });

  it('default adapters refuse every write without the App token (reads still allowed)', async () => {
    const ran: string[][] = [];
    const adapters = await defaultRoundPrAdapters({
      appToken: () => null,
      inTest: () => false,
      run: (args) => { ran.push(args); return { status: 0, stdout: JSON.stringify({ state: 'OPEN', isDraft: true, labels: [{ name: 'x' }], mergedAt: null, comments: [{ body: 'hi' }] }) }; },
    });
    const ref = roundPrRef(url(101))!;
    expect(adapters.view(ref)).toEqual({ state: 'OPEN', isDraft: true, labels: ['x'], mergedAt: null, comments: ['hi'] });
    expect([adapters.addLabel(ref, 'elanous:superseded'), adapters.comment(ref, 'c'), adapters.close(ref)]).toEqual([false, false, false]);
    expect(ran.map((args) => args[1])).toEqual(['view']);
    const withApp = await defaultRoundPrAdapters({ appToken: () => 'app', inTest: () => false, run: (args, env) => { ran.push([...args, env.GH_TOKEN ?? '']); return { status: 0, stdout: '' }; } });
    expect(withApp.close(ref)).toBe(true);
    expect(ran.at(-1)).toEqual(['pr', 'close', '101', '--repo', 'acme/repo', 'app']);
  });

  it('a link comment that was posted although gh reported failure is not posted again on retry', () => {
    const view: RoundPrView = { state: 'OPEN', isDraft: true, labels: [], comments: [] };
    const posted: string[] = [];
    let closes = 0;
    const tracker = createRoundPrTracker({ runId: 'run-x', observe: () => {}, adapters: {
      view: () => ({ ...view, comments: [...posted] }),
      addLabel: () => true,
      comment: (_pr, body) => { posted.push(body); return false; }, // posted, but reported as failed
      close: () => { closes += 1; return true; },
    } });
    tracker.record([job('goal A', 101)], 0);
    expect(tracker.record([job('goal A', 102)], 1)[0]).toMatchObject({ kind: 'kept', reason: 'comment-failed' });
    expect(tracker.record([], 2)).toEqual([{ kind: 'superseded', round: 2, prevPr: 101, pr: 102 }]);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('#102 (https://github.com/acme/repo/pull/102)');
    expect(closes).toBe(1);
  });

  it('the App token is fetched per write: a token that appears later in the run lets the retry write', async () => {
    let token: string | null = null;
    const ran: string[][] = [];
    const adapters = await defaultRoundPrAdapters({
      appToken: () => token,
      inTest: () => false,
      run: (args, env) => { ran.push([args[1]!, env.GH_TOKEN ?? '-']); return { status: 0, stdout: JSON.stringify({ state: 'OPEN', isDraft: true, labels: [], mergedAt: null, comments: [] }) }; },
    });
    const tracker = createRoundPrTracker({ runId: 'run-x', adapters, observe: () => {} });
    tracker.record([job('goal A', 101)], 0);
    expect(tracker.record([job('goal A', 102)], 1)[0]).toMatchObject({ kind: 'kept', reason: 'label-failed' });
    token = 'app-token';
    expect(tracker.record([], 2)).toEqual([{ kind: 'superseded', round: 2, prevPr: 101, pr: 102 }]);
    expect(ran.filter(([op]) => op !== 'view')).toEqual([['edit', 'app-token'], ['comment', 'app-token'], ['close', 'app-token']]);
  });

  it('an unreadable comment list makes the view unobserved, so the tracker writes nothing', async () => {
    for (const comments of [undefined, null, [{ body: 3 }]]) {
      const ran: string[] = [];
      const adapters = await defaultRoundPrAdapters({
        appToken: () => 'app',
        inTest: () => false,
        run: (args) => { ran.push(args[1]!); return { status: 0, stdout: JSON.stringify({ state: 'OPEN', isDraft: true, labels: [], mergedAt: null, ...(comments === undefined ? {} : { comments }) }) }; },
      });
      const tracker = createRoundPrTracker({ runId: 'run-x', adapters, observe: () => {} });
      tracker.record([job('goal A', 101)], 0);
      expect(tracker.record([job('goal A', 102)], 1)[0]).toMatchObject({ kind: 'kept', reason: 'view-unobserved' });
      expect(ran).toEqual(['view']);
    }
  });

  it('an earlier PR reported merged in the same round after it was queued is never written', () => {
    const gh = fakeGh({ 101: openDraft });
    const tracker = createRoundPrTracker({ runId: 'run-x', adapters: gh.adapters, observe: () => {} });
    tracker.record([job('goal A', 101)], 0);
    const out = tracker.record([job('goal A', 102), job('goal A', 101, { status: 'done', stage: 'merged', merged: true })], 1);
    expect(out.filter((o) => o.prevPr === 101 && o.kind !== 'continued')).toEqual([{ kind: 'kept', round: 1, prevPr: 101, pr: 102, reason: 'merged' }]);
    expect(gh.calls).toEqual([]);
  });

  it('a carried PR from an earlier process is not this run\'s PR and is never superseded', () => {
    const gh = fakeGh({ 90: openDraft });
    const tracker = createRoundPrTracker({ runId: 'run-x', adapters: gh.adapters, observe: () => {} });
    tracker.record([job('goal A', 90, { resumeDisposition: 'skip' })], 0);
    expect(tracker.record([job('goal A', 102)], 1)).toEqual([]);
    expect(gh.calls).toEqual([]);
  });

  it('parses only github.com pull URLs', () => {
    expect(roundPrRef('https://github.com/a/b/pull/7')).toEqual({ repository: 'a/b', number: 7, url: 'https://github.com/a/b/pull/7' });
    expect(roundPrRef('https://example.test/pull/1')).toBeNull();
    expect(roundPrRef(undefined)).toBeNull();
  });
});
