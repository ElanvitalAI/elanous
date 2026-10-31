import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExternalTaskEvent } from '../connectors/types.js';
import { debug } from '../debug/log.js';
import { CardStore } from '../task-cards/card-store.js';
import { createLinearSecretaryBreakdown, parseLinearSecretaryManifest, readApprovedLinearCapture, scanLinearWishes, suggestLinearWishes, type LinearSecretaryPlan, updateLinearSecretaryProgress } from './linear-wish.js';
import { createArtifactStore } from '../artifact/store.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'linear-wish-'));
  roots.push(root);
  return new CardStore(root);
}

function issue(identifier: string): ExternalTaskEvent {
  return {
    provider: 'linear', eventId: identifier, kind: 'updated', ref: identifier,
    identifier, title: `Wish ${identifier}`, body: `Body ${identifier}`,
    url: `https://linear.app/example/${identifier}`, priority: null, occurredAt: '2026-10-04T00:00:00Z',
  };
}

test('suggest scans unlabelled open issues, matches title or body, and returns only identifier, 40-character title and one-word reason', async () => {
  const cases = [
    { ...issue('UX-1'), title: '가'.repeat(41) + ' 만들어 줘', body: '' },
    { ...issue('UX-2'), title: '정상 제목', body: '이렇게 해 줘' },
    { ...issue('UX-3'), title: '만들어', body: '' },
    { ...issue('UX-4'), title: '정상', body: '이 기능 원해요' },
    { ...issue('UX-5'), title: '있으면 좋겠다', body: '' },
    { ...issue('UX-6'), title: '버그 수리', body: '오류가 납니다' },
  ];
  const args: unknown[] = [];
  const result = await suggestLinearWishes({ teamKey: 'UX', deps: {
    getApiKey: async () => 'secret', fetchIssues: async (options) => { args.push(options); return cases; },
  } });
  expect(args).toEqual([{ apiKey: 'secret', teamKey: 'UX', excludeLabel: 'wish' }]);
  expect(result).toEqual([
    { identifier: 'UX-1', title: '가'.repeat(40), reason: '제작' },
    { identifier: 'UX-2', title: '정상 제목', reason: '요청' },
    { identifier: 'UX-3', title: '만들어', reason: '제작' },
    { identifier: 'UX-4', title: '정상', reason: '희망' },
    { identifier: 'UX-5', title: '있으면 좋겠다', reason: '희망' },
  ]);
});

test('two matching issues produce two cards with full text; a repeat counts duplicates and logs only counts', async () => {
  const store = fixture();
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  const fetched: Array<{ apiKey: string; teamKey: string; labelOrPrefix?: string }> = [];
  const deps = {
    getApiKey: async () => 'private-linear-key',
    fetchIssues: async (args: { apiKey: string; teamKey: string; labelOrPrefix?: string }) => {
      fetched.push(args);
      return [issue('UX-1'), issue('UX-2')];
    },
  };
  try {
    expect(await scanLinearWishes({ teamKey: 'UX', store, deps })).toEqual({ added: 2, duplicate: 0, failed: 0 });
    expect(store.listCards().map(card => card.goalId).sort()).toEqual(['wish:linear:UX-1', 'wish:linear:UX-2']);
    const card = store.listCards().find(card => card.goalId === 'wish:linear:UX-1')!;
    expect(JSON.parse(card.sections[0]!.content)).toMatchObject({
      source: 'linear', ref: 'UX-1', replyTo: { surface: 'linear', issueId: 'UX-1' }, text: 'Wish UX-1\n\nBody UX-1\n\nhttps://linear.app/example/UX-1',
    });
    expect(await scanLinearWishes({ teamKey: 'UX', store, deps })).toEqual({ added: 0, duplicate: 2, failed: 0 });
    expect(store.listCards()).toHaveLength(2);
    expect(fetched).toEqual([
      { apiKey: 'private-linear-key', teamKey: 'UX', labelOrPrefix: 'wish' },
      { apiKey: 'private-linear-key', teamKey: 'UX', labelOrPrefix: 'wish' },
    ]);
    expect(log).toHaveBeenCalledWith('intake.linear-wish', 'scanned', { teamKey: 'UX', label: 'wish', added: 2, duplicate: 0, failed: 0 });
    expect(JSON.stringify(log.mock.calls)).not.toContain('Wish UX-1');
    expect(JSON.stringify(log.mock.calls)).not.toContain('Body UX-1');
    expect(JSON.stringify(log.mock.calls)).not.toContain('https://linear.app/example/UX-1');
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-linear-key');
  } finally { log.mockRestore(); store.close(); }
});

test('an issue that throws does not prevent the remaining issue from becoming a card', async () => {
  const store = fixture();
  const append = spyOn(store, 'appendSection').mockImplementationOnce(() => { throw new Error('write failed'); });
  const deps = { getApiKey: async () => 'secret', fetchIssues: async () => [issue('UX-3'), issue('UX-4')] };
  try {
    expect(await scanLinearWishes({ teamKey: 'UX', label: 'custom', store, deps })).toEqual({ added: 1, duplicate: 0, failed: 1 });
    expect(store.listCards().map(card => card.goalId).sort()).toEqual(['wish:linear:UX-3', 'wish:linear:UX-4']);
    expect(store.listCards().find(card => card.goalId === 'wish:linear:UX-4')?.sections.map(section => section.key)).toEqual(['intake:wish:0', 'intake:reply:0']);
    append.mockRestore();
    expect(await scanLinearWishes({ teamKey: 'UX', label: 'custom', store, deps })).toEqual({ added: 0, duplicate: 2, failed: 0 });
    expect(JSON.parse(store.listCards().find(card => card.goalId === 'wish:linear:UX-3')!.sections[0]!.content)).toMatchObject({ recovered: true });
  } finally { append.mockRestore(); store.close(); }
});

test('secretary creates one parent and 3-5 evidence-linked children with a Telegram-ready reply card', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const descriptions: Array<{ issueId: string; description: string }> = [];
  const plan: LinearSecretaryPlan = {
    title: '11-04 데모 준비', rationale: '실기 시연을 무대·검증·리허설로 나눴습니다.', assigneeId: 'owner-1', dueDate: '2026-11-04',
    tasks: Array.from({ length: 4 }, (_, index) => ({
      title: `단계 ${index + 1}`, intent: `시연 단계 ${index + 1}을 완료한다`,
      refs: [`https://example.test/evidence/${index + 1}`], assigneeId: `user-${index + 1}`, dueDate: '2026-11-04',
    })),
  };
  const result = await createLinearSecretaryBreakdown({ apiKey: 'secret', projectId: 'project-1', request: '11-04 데모 준비 리니어로 정리해줘', plan,
    deps: {
      createIssue: async (args) => { calls.push(args); return `issue-${calls.length}`; },
      updateDescription: async (args) => { descriptions.push(args); },
    } });
  expect(calls).toHaveLength(5);
  expect(calls[0]).toMatchObject({ title: plan.title, projectId: 'project-1', assigneeId: 'owner-1', dueDate: '2026-11-04',
    description: expect.stringContaining('https://example.test/evidence/1') });
  expect(calls.slice(1).map(call => [call.parentId, call.assigneeId, call.dueDate])).toEqual([
    ['issue-1', 'user-1', '2026-11-04'], ['issue-1', 'user-2', '2026-11-04'],
    ['issue-1', 'user-3', '2026-11-04'], ['issue-1', 'user-4', '2026-11-04'],
  ]);
  expect(descriptions).toHaveLength(4);
  expect(descriptions[0]!.description).toContain('"parentIssueId":"issue-1"');
  expect(descriptions[0]!.description).toContain('"issueId":"issue-2"');
  expect(result).toEqual({ parentIssueId: 'issue-1', childIssueIds: ['issue-2', 'issue-3', 'issue-4', 'issue-5'],
    replyCard: '등록: 부모 1개 · 하위 4개\n분해 이유: 실기 시연을 무대·검증·리허설로 나눴습니다.\n다음: 단계 1' });
});

test('secretary creates a projectless parent and subtasks only in the explicitly selected team', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const plan: LinearSecretaryPlan = {
    title: 'Demo canary', rationale: '근거에 따라 3개로 나눴습니다.', assigneeId: 'owner', dueDate: '2026-11-05',
    tasks: Array.from({ length: 3 }, (_, index) => ({ title: `단계 ${index + 1}`, intent: `단계 ${index + 1} 완료`,
      refs: [`https://example.test/${index}`], assigneeId: 'owner', dueDate: '2026-11-05' })),
  };
  await createLinearSecretaryBreakdown({ apiKey: 'secret', teamKey: 'DEMO', request: 'projectless=true teamKey=DEMO', plan,
    deps: { createIssue: async args => { calls.push(args); return `issue-${calls.length}`; }, updateDescription: async () => {} } });
  expect(calls).toHaveLength(4);
  expect(calls.every(call => call.teamKey === 'DEMO' && !('projectId' in call))).toBe(true);
  expect(calls[0]).toMatchObject({ stateType: 'started', dueDate: '2026-11-05' });
  expect(calls.slice(1).every(call => call.parentId === 'issue-1' && call.dueDate === '2026-11-05')).toBe(true);
});

test('secretary refuses an ungrounded or out-of-range breakdown before creating issues', async () => {
  let creates = 0;
  const task = { title: '조사', intent: '요구를 확인한다', refs: [], assigneeId: 'user-1', dueDate: '2026-11-04' };
  await expect(createLinearSecretaryBreakdown({ apiKey: 'secret', projectId: 'project-1', request: '요청',
    plan: { title: '부모', rationale: '근거가 약함', assigneeId: 'owner-1', dueDate: '2026-11-04', tasks: [task, task] },
    deps: { createIssue: async () => { creates++; return 'unexpected'; } } })).rejects.toThrow('3 to 5 subtasks');
  expect(creates).toBe(0);
  await expect(createLinearSecretaryBreakdown({ apiKey: 'secret', projectId: 'project-1', request: '요청',
    plan: { title: '부모', rationale: '분해', assigneeId: 'owner-1', dueDate: '2026-11-04', tasks: [task, task, task] },
    deps: { createIssue: async () => { creates++; return 'unexpected'; } } })).rejects.toThrow('needs evidence links');
  expect(creates).toBe(0);
});

test('child issue manifest maps exact Linear UUIDs and rejects unrelated issue IDs', () => {
  const description = '<!-- elanous-linear-secretary-manifest:start -->\n'
    + '{"parentIssueId":"parent-uuid","tasks":[{"issueId":"child-uuid","title":"첫 단계"}]}\n'
    + '<!-- elanous-linear-secretary-manifest:end -->';
  expect(parseLinearSecretaryManifest(description, 'child-uuid')).toEqual({ parentIssueId: 'parent-uuid', tasks: [{ issueId: 'child-uuid', title: '첫 단계' }] });
  expect(parseLinearSecretaryManifest(description, 'other-child')).toBeUndefined();
});

test('secretary records each progress step in order, attaches the capture, and preserves the parent description', async () => {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const parentDescription = [
    '요청: 데모 준비', '분해 이유: 단계별로 진행', '<!-- elanous-linear-secretary-checklist:start -->',
    '- [ ] 첫 단계', '- [ ] 둘째 단계', '<!-- elanous-linear-secretary-checklist:end -->', '근거:', '- https://example.test/spec',
  ].join('\n');
  const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(init!.body as string) as { query: string; variables: Record<string, unknown> };
    calls.push(body);
    if (body.query.includes('LinearIssueStatus')) return Response.json({ data: { issue: { state: { type: 'started' } } } });
    if (body.query.includes('IssueStates')) return Response.json({ data: { issue: { team: { states: { nodes: [{ id: 'todo', type: 'unstarted' }, { id: 'doing', type: 'started' }, { id: 'done', type: 'completed' }] } } } } });
    if (body.query.includes('LinearAttachmentCreate')) return Response.json({ data: { attachmentCreate: { success: true, attachment: { id: 'attachment-1' } } } });
    if (body.query.includes('DecisionComment')) return Response.json({ data: { commentCreate: { success: true, comment: { id: 'comment-1' } } } });
    if (body.query.includes('LinearIssueDescription($id')) return Response.json({ data: { issue: { description: parentDescription } } });
    return Response.json({ data: { issueUpdate: { success: true } } });
  }) as typeof fetch;
  await updateLinearSecretaryProgress({ apiKey: 'key', parentIssueId: 'parent-1', taskIssueId: 'child-1', taskTitle: '첫 단계',
    tasks: [{ issueId: 'child-1', title: '첫 단계' }, { issueId: 'child-2', title: '둘째 단계' }], state: 'completed',
    completedIssueIds: [], summary: '시연 자료를 준비했습니다.', workaround: '원본이 없어 샘플 캡처를 썼습니다.', captureUrl: 'https://example.test/capture.png', fetch: fakeFetch });
  expect(calls.map(call => call.query.match(/(?:query|mutation) (\w+)/)?.[1])).toEqual([
    'LinearIssueStatus', 'DecisionIssueStates', 'DecisionIssueClose', 'DecisionComment', 'LinearAttachmentCreate', 'LinearIssueDescription', 'LinearIssueDescriptionUpdate',
  ]);
  const descriptionUpdate = calls.at(-1)!.variables.input as { description: string };
  expect(descriptionUpdate.description).toContain('요청: 데모 준비');
  expect(descriptionUpdate.description).toContain('- [x] 첫 단계');
  expect(descriptionUpdate.description).toContain('- [ ] 둘째 단계');
  expect(descriptionUpdate.description).toContain('https://example.test/spec');
  const progressComment = (calls[3]!.variables.input as { body: string }).body;
  expect(progressComment).toContain('요약: 시연 자료를 준비했습니다.');
  expect(progressComment).toContain('우회: 원본이 없어 샘플 캡처를 썼습니다.');
});

test('secretary starts a team-only child whose Linear workflow type is backlog', async () => {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const parentDescription = '<!-- elanous-linear-secretary-checklist:start -->\n- [ ] 첫 단계\n<!-- elanous-linear-secretary-checklist:end -->';
  const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(init!.body as string) as { query: string; variables: Record<string, unknown> };
    calls.push(body);
    if (body.query.includes('LinearIssueStatus')) return Response.json({ data: { issue: { state: { type: 'backlog' } } } });
    if (body.query.includes('IssueStates')) return Response.json({ data: { issue: { team: { states: { nodes: [{ id: 'doing', type: 'started' }, { id: 'done', type: 'completed' }] } } } } });
    if (body.query.includes('DecisionComment')) return Response.json({ data: { commentCreate: { success: true, comment: { id: 'comment-1' } } } });
    if (body.query.includes('LinearIssueDescription($id')) return Response.json({ data: { issue: { description: parentDescription } } });
    return Response.json({ data: { issueUpdate: { success: true } } });
  }) as typeof fetch;

  await updateLinearSecretaryProgress({ apiKey: 'key', parentIssueId: 'parent-1', taskIssueId: 'child-1', taskTitle: '첫 단계',
    tasks: [{ issueId: 'child-1', title: '첫 단계' }], state: 'started', completedIssueIds: [], summary: '작업을 시작했습니다.', fetch: fakeFetch });

  expect(calls.map(call => call.query.match(/(?:query|mutation) (\w+)/)?.[1])).toEqual([
    'LinearIssueStatus', 'DecisionIssueStates', 'DecisionIssueClose', 'DecisionComment', 'LinearIssueDescription', 'LinearIssueDescriptionUpdate',
  ]);
  expect(calls[2]!.variables.input).toEqual({ stateId: 'doing' });
});

test('capture upload requires a fresh browser capture approved for this exact run and public sharing', () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'linear-capture-'));
  roots.push(baseDir);
  const store = createArtifactStore({ baseDir });
  const body = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const handle = store.put('capture', body, { origin: 'browser-runtime', producer: 'browser-runtime', extra: {
    runId: 'run-42', linearIssueId: 'parent-42', externalShare: true, sharePolicy: 'linear-approved', sensitivity: 'public',
  } });
  const approved = { path: handle.path, mimeType: 'image/png', runId: 'run-42', linearIssueId: 'parent-42',
    externalShare: true, sensitivity: 'public', createdAt: handle.meta.createdAt };
  expect(readApprovedLinearCapture({ ...approved, baseDir })).toMatchObject({
    filename: expect.stringMatching(/\.png$/), mimeType: 'image/png', body,
  });
  expect(() => readApprovedLinearCapture({ ...approved, runId: 'other-run', baseDir })).toThrow('metadata is not approved');
  expect(() => readApprovedLinearCapture({ ...approved, baseDir: join(baseDir, 'missing') })).toThrow();
  const localOnly = store.put('capture', body, { origin: 'browser-runtime', producer: 'browser-runtime', extra: {
    runId: 'run-42', linearIssueId: 'parent-42', externalShare: false, sharePolicy: 'local-only', sensitivity: 'public',
  } });
  expect(() => readApprovedLinearCapture({ ...approved, path: localOnly.path, createdAt: localOnly.meta.createdAt, baseDir })).toThrow('metadata is not approved');
  const expired = store.put('capture', body, { origin: 'browser-runtime', producer: 'browser-runtime', extra: {
    runId: 'run-42', linearIssueId: 'parent-42', externalShare: true, sharePolicy: 'linear-approved', sensitivity: 'public',
  } });
  expect(() => readApprovedLinearCapture({ ...approved, path: expired.path, createdAt: expired.meta.createdAt,
    baseDir, now: Date.now() + 8 * 24 * 60 * 60 * 1000 })).toThrow('seven-day sharing window');
  store._resetForTest();
});

test('progress uploads only the approved artifact and attaches the private Linear asset URL', async () => {
  const calls: string[] = [];
  const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(init!.body as string) as { query: string; variables?: { input?: { issueId?: string } } };
    calls.push(body.query.match(/(?:query|mutation) (\w+)/)?.[1] ?? 'unknown');
    if (body.query.includes('LinearIssueStatus')) return Response.json({ data: { issue: { state: { type: 'started' } } } });
    if (body.query.includes('IssueStates')) return Response.json({ data: { issue: { team: { states: { nodes: [{ id: 'done', type: 'completed' }] } } } } });
    if (body.query.includes('DecisionComment')) return Response.json({ data: { commentCreate: { success: true, comment: { id: 'comment-1' } } } });
    if (body.query.includes('LinearAttachmentCreate')) {
      calls.push(`attachment:${body.variables?.input?.issueId}`);
      return Response.json({ data: { attachmentCreate: { success: true, attachment: { id: 'attachment-1' } } } });
    }
    if (body.query.includes('LinearIssueDescription($id')) return Response.json({ data: { issue: { description: '<!-- elanous-linear-secretary-checklist:start -->\n- [ ] 첫 단계\n<!-- elanous-linear-secretary-checklist:end -->' } } });
    return Response.json({ data: { issueUpdate: { success: true } } });
  }) as typeof fetch;
  await updateLinearSecretaryProgress({ apiKey: 'key', parentIssueId: 'parent-1', taskIssueId: 'child-1', taskTitle: '첫 단계',
    tasks: [{ issueId: 'child-1', title: '첫 단계' }], state: 'completed', completedIssueIds: [], summary: '완료',
    captureArtifact: { path: '/local/capture.png', mimeType: 'image/png', runId: 'run-42', linearIssueId: 'parent-1',
      externalShare: true, sensitivity: 'public', createdAt: Date.now() }, fetch: fakeFetch,
    deps: {
      readCapture: () => ({ filename: 'capture.png', mimeType: 'image/png', body: Buffer.from('png') }),
      uploadFile: async () => { calls.push('fileUpload+PUT'); return 'https://asset.linear.app/capture.png'; },
    } });
  expect(calls).toEqual(['LinearIssueStatus', 'fileUpload+PUT', 'DecisionIssueStates', 'DecisionIssueClose', 'DecisionComment', 'LinearAttachmentCreate', 'attachment:parent-1', 'LinearIssueDescription', 'LinearIssueDescriptionUpdate', 'DecisionIssueStates', 'DecisionIssueClose']);
  calls.length = 0;
  await expect(updateLinearSecretaryProgress({ apiKey: 'key', parentIssueId: 'parent-1', taskIssueId: 'child-1', taskTitle: '첫 단계',
    tasks: [{ issueId: 'child-1', title: '첫 단계' }], state: 'completed', completedIssueIds: [], summary: '완료',
    captureArtifact: { path: '/local/other-parent.png', mimeType: 'image/png', runId: 'run-42', linearIssueId: 'other-parent',
      externalShare: true, sensitivity: 'public', createdAt: Date.now() }, fetch: fakeFetch,
    deps: { readCapture: () => { throw new Error('must not read or upload an artifact for another parent'); } },
  })).rejects.toThrow('not approved for this secretary parent issue');
  expect(calls).toEqual([]);
});
