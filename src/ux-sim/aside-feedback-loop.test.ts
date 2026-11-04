import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simAsideFeedbackLoop, type AsideFeedbackLoopDependencies } from './aside-feedback-loop.js';

const sourceUrl = 'https://www.maersk.com/news/articles/2026/10/26/middle-east-operational-update-52';
const research = { summary: '26 Oct lists USD 3,000/40-foot and USD 1,000/Hormuz; later replacement not confirmed.', sourceUrls: [sourceUrl] };
const parentIssueId = 'e8d81bcf-3637-4e9c-8a29-b9ffc0c9c7c2';
const taskIssueId = 'child-demo-capture';
type AsideFeedbackLoopOverrides = Omit<Partial<AsideFeedbackLoopDependencies>, 'linear' | 'subscription' | 'external'> & {
  linear?: Partial<AsideFeedbackLoopDependencies['linear']>;
  subscription?: Partial<AsideFeedbackLoopDependencies['subscription']>;
  external?: {
    stateDir?: string;
    schedule?: Partial<AsideFeedbackLoopDependencies['external']['schedule']>;
  };
};

function fixture(overrides: AsideFeedbackLoopOverrides = {}, childManifest?: string) {
  const stateDir = mkdtempSync(join(tmpdir(), 'aside-feedback-loop-'));
  const manifestDescription = '<!-- elanous-linear-secretary-manifest:start -->\n'
    + (childManifest ?? JSON.stringify({ parentIssueId, tasks: [{ issueId: taskIssueId, title: 'aside 캡처 근거 기록' }] }))
    + '\n<!-- elanous-linear-secretary-manifest:end -->';
  let currentParentDescription = '<!-- elanous-linear-secretary-checklist:start -->\n- [ ] aside 캡처 근거 기록\n<!-- elanous-linear-secretary-checklist:end -->';
  const recordedComments: string[] = [];
  const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { query: string; variables?: { id?: string; input?: { body?: string; description?: string } } };
    const id = body.variables?.id ?? '';
    if (body.query.includes('SecretaryDemoParent')) return Response.json({ data: { issue: { id: parentIssueId, team: { key: 'DEMO' } } } });
    if (body.query.includes('LinearMissionIssueIdentity')) return Response.json({ data: { issue: { id: taskIssueId, team: { key: 'DEMO' }, parent: { id: parentIssueId } } } });
    if (body.query.includes('LinearIssueDescription($id')) return Response.json({ data: { issue: { description: id === parentIssueId ? currentParentDescription : manifestDescription } } });
    if (body.query.includes('LinearIssueStatus')) return Response.json({ data: { issue: { state: { type: 'started' } } } });
    if (body.query.includes('LinearAttachmentCreate')) return Response.json({ data: { attachmentCreate: { success: true, attachment: { id: 'attachment-demo' } } } });
    if (body.query.includes('DecisionComment')) { recordedComments.push(String(body.variables?.input?.body ?? '')); return Response.json({ data: { commentCreate: { success: true, comment: { id: 'comment-demo' } } } }); }
    if (body.query.includes('LinearIssueDescriptionUpdate')) { currentParentDescription = String(body.variables?.input?.description ?? ''); return Response.json({ data: { issueUpdate: { success: true } } }); }
    throw new Error(`unexpected fake Linear query: ${body.query}`);
  }) as typeof fetch;
  let createdCommand = '';
  const deps: AsideFeedbackLoopDependencies = {
    question: overrides.question ?? 'Did a later notice replace either dated rate?',
    sourceUrl: overrides.sourceUrl ?? sourceUrl,
    ...(overrides.captureTimeoutMs !== undefined ? { captureTimeoutMs: overrides.captureTimeoutMs } : {}),
    research: overrides.research ?? (async () => research),
    capture: overrides.capture ?? (async () => ({ status: 'captured', path: '/test/public.png', mimeType: 'image/png',
      sessionId: 'aside-session-1', browserRunId: 'browser-runtime-2' })),
    subscription: {
      seat: 'TC', topic: 'Maersk Middle East Operational Update 52 follow-up rate notice',
      linearIssueId: parentIssueId, every: '1w', scheduleCron: '0 8 * * 1', telegramDryRunFile: join(stateDir, 'briefing.md'),
      ...overrides.subscription,
    },
    linear: {
      apiKey: overrides.linear?.apiKey ?? 'test-key',
      parentIssueId: overrides.linear?.parentIssueId ?? parentIssueId,
      taskIssueId: overrides.linear?.taskIssueId ?? taskIssueId,
      fetch: overrides.linear?.fetch ?? fakeFetch,
      captureDeps: overrides.linear?.captureDeps ?? {
        readCapture: () => ({ filename: 'aside.png', mimeType: 'image/png', body: Buffer.from([1, 2, 3]) }),
        uploadFile: async () => 'https://uploads.example.test/aside.png',
      },
    },
    external: {
      stateDir: overrides.external?.stateDir ?? stateDir,
      schedule: {
        scheduleDispatch: async args => {
          if (args.action === 'create') createdCommand = String(args.command ?? '');
          return args.action === 'list'
            ? { schedules: [{ id: 'schedule-demo-1104', cron: '0 8 * * 1', command_full: `${createdCommand} >> /tmp/eln.log 2>&1` }] }
            : { ok: true };
        },
        runDue: async input => ({ ran: [{ id: input?.sourceId ?? 'missing-source', items: 5 }] }),
        ...overrides.external?.schedule,
      },
    },
  };
  return { deps, recordedComments, cleanup: () => rmSync(stateDir, { recursive: true, force: true }) };
}

async function run(overrides: AsideFeedbackLoopOverrides = {}, childManifest?: string) {
  const fx = fixture(overrides, childManifest);
  try { return await simAsideFeedbackLoop(fx.deps); }
  finally { fx.cleanup(); }
}

describe('aside↔Elanous feedback loop simulation', () => {
  test('connects the real secretary runtime and topic subscription function in order', async () => {
    const result = await run({ capture: async () => ({ status: 'captured', path: '/test/public.png', mimeType: 'image/png',
      sessionId: 'aside-session-1', browserRunId: 'browser-runtime-2' }) });
    expect(result.status).toBe('complete');
    expect(result.research.sourceUrls).toContain(sourceUrl);
    expect(result.capture).toMatchObject({ status: 'captured', sessionId: 'aside-session-1', browserRunId: 'browser-runtime-2' });
    expect(result.linear).toMatchObject({ status: 'recorded', captureAttached: true });
    expect(result.subscription).toMatchObject({ status: 'active', recurring: true });
    expect(result.events).toEqual([
      'aside-question', 'research-started', 'research-completed', 'aside-capture-requested',
      'aside-capture-completed', 'linear-recorded', 'subscription-active', 'completed',
    ]);
  });

  test('bounds capture, aborts its signal, and retains a partial result', async () => {
    let abortObserved = false;
    const result = await run({
      captureTimeoutMs: 1,
      capture: async ({ signal }) => new Promise(resolve => signal.addEventListener('abort', () => {
        abortObserved = true;
        resolve({ status: 'cancelled', reason: 'capture cancelled by abort' });
      }, { once: true })),
    });
    expect(abortObserved).toBe(true);
    expect(result.status).toBe('partial');
    expect(result.capture).toMatchObject({ status: 'failed', reason: expect.stringContaining('cancellation confirmed') });
    expect(result.linear).toMatchObject({ status: 'recorded', captureAttached: false });
    expect(result.subscription.status).toBe('active');
  });

  test('does not report cancellation when capture ignores abort and later succeeds', async () => {
    const result = await run({ captureTimeoutMs: 1, capture: async () => {
      await new Promise(resolve => setTimeout(resolve, 15));
      return { status: 'captured', path: '/test/public.png', mimeType: 'image/png', sessionId: 'late-session', browserRunId: 'late-run' };
    } });
    expect(result.capture).toMatchObject({ status: 'failed', reason: expect.stringContaining('cancellation unconfirmed') });
    expect(result.status).toBe('partial');
  });

  test('keeps a recurring subscription active when only its immediate intake row fails', async () => {
    const result = await run({ external: { schedule: { runDue: async input => ({ ran: [
      { id: input?.sourceId ?? 'source', items: 0, error: 'temporary intake failure' },
    ] }) } } });
    expect(result.subscription).toMatchObject({ status: 'active', recurring: true, scheduleId: 'schedule-demo-1104', immediateStatus: 'failed', immediateError: 'temporary intake failure' });
    expect(result.status).toBe('partial');
  });

  test('records the research summary and source URL in the Linear progress comment', async () => {
    const fx = fixture();
    try {
      const result = await simAsideFeedbackLoop(fx.deps);
      expect(result.linear.status).toBe('recorded');
      expect(fx.recordedComments[0]).toContain(research.summary);
      expect(fx.recordedComments[0]).toContain(sourceUrl);
    } finally { fx.cleanup(); }
  });

  test('discards research whose sources fail validation before Linear records progress', async () => {
    const fx = fixture({ research: async () => ({ summary: 'unverified claim', sourceUrls: ['https://wrong.example.test/'] }) });
    try {
      const result = await simAsideFeedbackLoop(fx.deps);
      expect(result.status).toBe('partial');
      expect(result.research).toEqual({ summary: '', sourceUrls: [] });
      expect(fx.recordedComments[0]).not.toContain('unverified claim');
      expect(fx.recordedComments[0]).toContain('출처: 없음');
    } finally { fx.cleanup(); }
  });

  test('does not mark a source-only empty research result complete', async () => {
    const result = await run({ research: async () => ({ summary: '  ', sourceUrls: [sourceUrl] }) });
    expect(result.status).toBe('partial');
    expect(result.research).toEqual({ summary: '', sourceUrls: [] });
    expect(result.events).toContain('research-failed:research result has no conclusion');
  });

  test('converts a synchronous capture throw into a partial result', async () => {
    const result = await run({ capture: (() => { throw new Error('browser bridge threw synchronously'); }) as AsideFeedbackLoopDependencies['capture'] });
    expect(result.status).toBe('partial');
    expect(result.capture).toMatchObject({ status: 'failed', reason: 'aside_exec capture failed: browser bridge threw synchronously' });
    expect(result.linear.status).toBe('recorded');
  });

  test('uses the real secretary parser for bracket escapes preserved by Linear markdown edits', async () => {
    const markdownEscaped = `{"parentIssueId":"${parentIssueId}","tasks":\\[{"issueId":"${taskIssueId}","title":"aside 캡처 근거 기록"}\\]}`;
    const result = await run({ capture: async () => ({ status: 'captured', path: '/test/public.png', mimeType: 'image/png',
      sessionId: 'aside-session-1', browserRunId: 'browser-runtime-2' }) }, markdownEscaped);
    expect(result.linear).toMatchObject({ status: 'recorded', captureAttached: true });
    expect(result.subscription.status).toBe('active');
    expect(result.status).toBe('complete');
  });

  test('preserves the exact one-line refusal when the escaped manifest omits this child', async () => {
    const unrelated = JSON.stringify({ parentIssueId, tasks: [{ issueId: 'other-child', title: '다른 단계' }] })
      .replace('"tasks":[', '"tasks":\\[').replace(']}', '}\\]}');
    const result = await run({}, unrelated);
    expect(result.linear).toMatchObject({ status: 'failed', reason: 'Linear secretary child is not listed in the DEMO parent manifest' });
    expect(result.status).toBe('partial');
  });

  test('preserves research, secretary and schedule errors as a partial run', async () => {
    const result = await run({
      research: async () => { throw new Error('research unavailable'); },
      linear: { apiKey: 'test-key', parentIssueId, taskIssueId, fetch: (async () => { throw new Error('Linear write refused'); }) as unknown as typeof fetch },
      external: { schedule: { scheduleDispatch: async () => ({ error: 'schedule registry unavailable' }) } },
    });
    expect(result.status).toBe('partial');
    expect(result.research.summary).toBe('');
    expect(result.capture).toMatchObject({ status: 'failed', reason: 'Skipped because research failed' });
    expect(result.linear).toMatchObject({ status: 'failed', reason: 'Linear 비서 작업을 진행하지 못했습니다. 팀 키·이슈 ID·근거·권한을 확인해 주세요.' });
    expect(result.subscription).toMatchObject({ status: 'unsupported', reason: expect.stringContaining('schedule registry unavailable') });
    expect(result.events).toContain('research-failed:research unavailable');
  });

  test('preserves browser runtime runId separately from loop and aside session IDs', async () => {
    const result = await run({ capture: async () => ({ status: 'captured', path: '/test/public.png', mimeType: 'image/png',
      sessionId: 'aside-session-X', browserRunId: 'browser-run-Y' }) });
    expect(result.status).toBe('complete');
    expect(result.runId).not.toBe('browser-run-Y');
    expect(result.capture).toMatchObject({ sessionId: 'aside-session-X', browserRunId: 'browser-run-Y' });
  });
});
