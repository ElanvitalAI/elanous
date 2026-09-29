import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mergeabilityButtonLabel, nextMergeabilityPoll, pollMergeabilityUntilKnown } from './approval-brief';
import { ApprovalGateControls, ApprovalNarrative, ApprovalViewTabs, mergedBadge, updatedApprovalCard } from './MergeApprovals';
import { createMergeApprovalsApi } from '../../lib/merge-approvals-api';

test('polls UNKNOWN every three seconds up to three times, never polls resolved mergeability', () => {
  expect(nextMergeabilityPoll(0, 'UNKNOWN')).toBe(3_000);
  expect(nextMergeabilityPoll(1, 'UNKNOWN')).toBe(3_000);
  expect(nextMergeabilityPoll(2, 'UNKNOWN')).toBe(3_000);
  expect(nextMergeabilityPoll(3, 'UNKNOWN')).toBeNull();
  expect(nextMergeabilityPoll(0, 'MERGEABLE')).toBeNull();
  expect(nextMergeabilityPoll(0, 'CONFLICTING')).toBeNull();
});

test('button stops claiming to check when UNKNOWN polling is exhausted', () => {
  expect(mergeabilityButtonLabel(0, 'UNKNOWN')).toBe('확인 중…');
  expect(mergeabilityButtonLabel(2, 'UNKNOWN')).toBe('확인 중…');
  expect(mergeabilityButtonLabel(3, 'UNKNOWN')).toBe('확인 종료');
  expect(mergeabilityButtonLabel(0, 'MERGEABLE')).toBe('승인하고 머지');
});

test('card shows the parsed lineage, Markdown link and SCQA immediately under its title', () => {
  const html = renderToStaticMarkup(createElement(ApprovalNarrative, {
    brief: '**SCQA** [원문](https://example.com/original) <script>alert(1)</script>',
    lineage: 'c7e…', summary: '기존 한 줄',
  }));
  expect(html).toContain('aria-label="승인 요약"');
  expect(html).toContain('<strong>SCQA</strong>');
  expect(html).toContain('target="_blank" rel="noreferrer"');
  expect(html).toContain('href="https://example.com/original"');
  expect(html).toContain('아이디어 원장: c7e…');
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('기존 한 줄');
});

test('missing or empty section warns about missing content and preserves the summary and lineage', () => {
  const html = renderToStaticMarkup(createElement(ApprovalNarrative, {
    brief: null, lineage: 'c7e…', summary: '다른 형식으로 원문·과정·효과 포함',
  }));
  expect(html).toContain('승인 요약 내용이 없습니다');
  expect(html).not.toContain('승인 요약 섹션을 찾지 못함');
  expect(html).not.toContain('원문·과정·효과가 PR 본문에 없다');
  expect(html).toContain('다른 형식으로 원문·과정·효과 포함');
  expect(html).toContain('아이디어 원장: c7e…');
});

test('poll loop really calls GET until mergeability is known, and at most three times', async () => {
  const sleeps: number[] = [];
  const sleep = async (ms: number) => { sleeps.push(ms); };
  const answers = ['UNKNOWN', 'UNKNOWN', 'MERGEABLE'];
  let calls = 0;
  const seen: string[] = [];
  const resolved = await pollMergeabilityUntilKnown(async () => ({ mergeable: answers[calls++]! }), { sleep, onDetail: (d) => seen.push(d.mergeable) });
  expect(calls).toBe(3);
  expect(seen).toEqual(['UNKNOWN', 'UNKNOWN', 'MERGEABLE']);
  expect(resolved.last?.mergeable).toBe('MERGEABLE');
  expect(sleeps).toEqual([3_000, 3_000, 3_000]);

  let stuck = 0;
  const exhausted = await pollMergeabilityUntilKnown(async () => { stuck++; return { mergeable: 'UNKNOWN' }; }, { sleep });
  expect(stuck).toBe(3);
  expect(exhausted.attempts).toBe(3);

  let early = 0;
  await pollMergeabilityUntilKnown(async () => { early++; return { mergeable: 'MERGEABLE' }; }, { sleep });
  expect(early).toBe(1);

  let failing = 0;
  const errors = await pollMergeabilityUntilKnown(async () => { failing++; throw new Error('502'); }, { sleep });
  expect(failing).toBe(3);
  expect(errors.last).toBeUndefined();

  let cancelled = 0;
  await pollMergeabilityUntilKnown(async () => { cancelled++; return { mergeable: 'UNKNOWN' }; }, { sleep, isActive: () => false });
  expect(cancelled).toBe(0);
});

test('client check posts the observed head SHA and returns the gate state', async () => {
  const calls: Array<{ path: string; init: RequestInit | undefined }> = [];
  const api = createMergeApprovalsApi({ client: {
    fetchResponse: async (path, init) => {
      calls.push({ path, init });
      return new Response(JSON.stringify({ gate: { status: 'running', failures: [] } }), { status: 202 });
    },
  } });
  expect(await api.check(42, 'abc')).toEqual({ gate: { status: 'running', failures: [] } });
  expect(calls[0]?.path).toBe('/v1/approvals/merges/42/check');
  expect(calls[0]?.init?.method).toBe('POST');
  expect(calls[0]?.init?.body).toBe('{"headSha":"abc"}');
});

test('gate statuses render the start, running, pass and failure messages; merge only enables for pass', () => {
  const render = (status: 'none' | 'running' | 'passed' | 'failed' | 'unmeasured') => renderToStaticMarkup(createElement(ApprovalGateControls, {
    gate: { status, failures: ['isolation-gate — hardcoded path'], os: 'linux' }, busy: false,
    onCheck: () => {}, onMerge: () => {},
  }));
  expect(render('none')).toContain('머지 전 검사 시작');
  expect(render('running')).toContain('검사 중…');
  expect(render('passed')).toContain('검사 통과 (linux)');
  expect(render('failed')).toContain('검사 실패');
  expect(render('unmeasured')).toContain('검사 측정 불가');
  expect(render('failed')).toContain('isolation-gate — hardcoded path');
  expect(render('unmeasured')).toContain('isolation-gate — hardcoded path');
  for (const status of ['none', 'running', 'failed', 'unmeasured'] as const) {
    expect(render(status)).toMatch(/disabled=""[^>]*>승인하고 머지<\/button>/);
  }
  expect(render('passed')).toMatch(/>승인하고 머지<\/button>/);
  expect(render('passed')).not.toMatch(/disabled=""[^>]*>승인하고 머지<\/button>/);
});

test('a polled new PR head resets the merge gate and ignores stale responses', () => {
  const old: import('../../lib/merge-approvals-api').MergeApproval = {
    number: 42, title: 'Idea', url: '', headSha: 'aaa', base: 'main', draft: false, mergeable: 'MERGEABLE',
    additions: 0, deletions: 0, changedFiles: 0, files: [], checks: { success: 0, failure: 0, pending: 0 },
    gate: { status: 'passed', failures: [], os: 'linux' }, summary: '', brief: null, lineage: null,
    createdAt: '', state: 'OPEN', approvalPath: '/approvals?pr=42',
  };
  const next = { ...old, headSha: 'bbb', gate: { status: 'passed' as const, failures: [], os: 'linux' } };
  const changed = updatedApprovalCard(old, next, 'aaa');
  expect(changed.headSha).toBe('bbb');
  expect(changed.gate.status).toBe('none');
  expect(updatedApprovalCard(changed, old, 'aaa')).toBe(changed);
  expect(updatedApprovalCard(old, { ...old, gate: { status: 'running', failures: [] } }, 'aaa').gate.status).toBe('running');
});

test('merged badge shows KST merge time and tabs mark the active view', () => {
  expect(mergedBadge('2026-09-27T21:25:18Z')).toBe('머지됨 09-28 06:25 KST');
  expect(mergedBadge(null)).toBe('머지됨');
  expect(mergedBadge('nope')).toBe('머지됨');
  const html = renderToStaticMarkup(createElement(ApprovalViewTabs, { view: 'merged', onChange: () => {} }));
  expect(html).toContain('승인 대기');
  expect(html).toMatch(/aria-selected="true"[^>]*>완료</);
  expect(html).toMatch(/aria-selected="false"[^>]*>승인 대기</);
});
