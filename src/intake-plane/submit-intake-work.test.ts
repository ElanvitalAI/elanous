import { describe, expect, test } from 'bun:test';
import { intakeItemId, type IngestResult, type IntakeSource, type RawIntakeItem } from './items.js';
import {
  absorbItemsFromText,
  routeAndSubmitIntakeWork,
  submitIntakeWork,
  taskFieldsFromText,
  type CreateTaskInput,
  type IntakeWorkOrigin,
  type SubmitIntakeWorkDeps,
} from './submit-intake-work.js';

const OWNER: IntakeWorkOrigin = { kind: 'owner', ledgerSource: 'pwa' };
const TELEGRAM: IntakeWorkOrigin = { kind: 'external', ledgerSource: 'telegram-bot', provider: 'telegram', ref: '42:7' };

function fakeDeps() {
  const ingested: Array<{ source: IntakeSource | import('./items.js').RegisteredIntakeSourceKind; raws: RawIntakeItem[] }> = [];
  const tasks: CreateTaskInput[] = [];
  const asks: string[] = [];
  const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
  const deps: SubmitIntakeWorkDeps = {
    root: () => '/tmp/nowhere',
    now: () => '2026-09-27T00:00:00.000Z',
    ingest: (_root, source, raws) => {
      ingested.push({ source, raws });
      return { shaped: raws.length, added: raws.length, merged: 0, seen: 0, skipped: 0, badLines: 0 } satisfies IngestResult;
    },
    createTask: async (input) => { tasks.push(input); return { taskId: 'task-1', output: 'ok' }; },
    askHarness: async (text) => { asks.push(text); return { acceptanceId: 'acc-1' }; },
    log: (event, data) => { logs.push({ event, data }); },
  };
  return { deps, ingested, tasks, asks, logs };
}

describe('submitIntakeWork', () => {
  test('absorb puts one ledger item per URL and returns the same ids the HTTP entrance uses', async () => {
    const { deps, ingested } = fakeDeps();
    const text = '읽어 둘 것 https://a.example/x 그리고 https://b.example/y';
    const res = await submitIntakeWork({ text, track: 'absorb', origin: TELEGRAM }, deps);
    expect(ingested).toHaveLength(1);
    expect(ingested[0]!.source).toBe('telegram-bot');
    expect(ingested[0]!.raws).toEqual([{ url: 'https://a.example/x' }, { url: 'https://b.example/y' }]);
    expect(res).toEqual({
      ok: true, track: 'absorb', added: 2, merged: 0,
      ids: [intakeItemId('telegram-bot', { url: 'https://a.example/x' }), intakeItemId('telegram-bot', { url: 'https://b.example/y' })],
    });
  });

  test('tasks from an external origin carry external provider/ref so M1 approval applies', async () => {
    const { deps, tasks } = fakeDeps();
    const res = await submitIntakeWork({ text: '결제 페이지 고쳐\n로그인 뒤 500 이 난다', track: 'tasks', origin: TELEGRAM }, deps);
    expect(res).toEqual({ ok: true, track: 'tasks', taskId: 'task-1', deduplicated: false });
    expect(tasks[0]).toEqual({
      title: '결제 페이지 고쳐',
      description: '로그인 뒤 500 이 난다',
      surface: { kind: 'llm-direct', prompt: '결제 페이지 고쳐\n로그인 뒤 500 이 난다' },
      external: { provider: 'telegram', ref: '42:7' },
      externalSurfaceDefaulted: true,
    });
  });

  test('tasks from the owner are not marked external', async () => {
    const { deps, tasks } = fakeDeps();
    await submitIntakeWork({ text: '할 일 하나', track: 'tasks', origin: OWNER }, deps);
    expect(tasks[0]!.external).toBeUndefined();
  });

  test('graph goes to the harness and returns its acceptance id', async () => {
    const { deps, asks } = fakeDeps();
    const res = await submitIntakeWork({ text: '구현해 줘: 버튼 색', track: 'graph', origin: OWNER }, deps);
    expect(asks).toEqual(['구현해 줘: 버튼 색']);
    expect(res).toEqual({ ok: true, track: 'graph', acceptanceId: 'acc-1' });
  });

  test('a seat document goes to the exec request instead of harness ask and retains reportTo', async () => {
    const reportTo = { channel: 'telegram' as const, chatId: -100123, botId: 'bot-1' };
    const { deps, asks } = fakeDeps();
    const routed: unknown[] = [];
    deps.seatDoc = async input => { routed.push(input); return { id: 'exec-1' }; };
    const res = await submitIntakeWork({ text: '@CMO 10-28 마케팅 전략 한 장', track: 'graph', origin: { ...TELEGRAM, reportTo } }, deps);
    expect(res).toEqual({ ok: true, track: 'graph', acceptanceId: 'exec-1' });
    expect(asks).toEqual([]);
    expect(routed).toEqual([{ text: '@CMO 10-28 마케팅 전략 한 장', reportTo, deps: undefined }]);
    await submitIntakeWork({ text: '@TC 로그인 버그 고쳐줘', track: 'graph', origin: { ...TELEGRAM, reportTo } }, deps);
    expect(asks).toEqual(['@TC 로그인 버그 고쳐줘']);
    expect(routed).toHaveLength(1);
  });

  test('CO1 — a non-code @coo request goes to the planner path with reportTo; a @coo code request stays a harness ask', async () => {
    const reportTo = { channel: 'discord' as const, channelId: 'c-1' };
    const { deps, asks } = fakeDeps();
    const routed: unknown[] = [];
    deps.seatDoc = async input => { routed.push(input); return { id: 'exec-2' }; };
    const res = await submitIntakeWork({ text: '@coo 내일 마케터스 나이트 준비 나눠 줘', track: 'graph', origin: { ...TELEGRAM, reportTo } }, deps);
    expect(res).toEqual({ ok: true, track: 'graph', acceptanceId: 'exec-2' });
    expect(routed).toEqual([{ text: '@coo 내일 마케터스 나이트 준비 나눠 줘', reportTo, deps: undefined }]);
    await submitIntakeWork({ text: '@coo 로그인 버그 고쳐줘', track: 'graph', origin: { ...TELEGRAM, reportTo } }, deps);
    expect(asks).toEqual(['@coo 로그인 버그 고쳐줘']);
    expect(routed).toHaveLength(1);
  });

  test('graph forwards external reportTo as the harness ask origin', async () => {
    const origin = { channel: 'telegram' as const, chatId: -100123, botId: 'bot-1' };
    const received: unknown[] = [];
    const { deps } = fakeDeps();
    deps.askHarness = async (text, reportTo) => { received.push({ text, reportTo }); return { acceptanceId: 'acc-1' }; };
    await submitIntakeWork({ text: '구현해 줘', track: 'graph', origin: { ...TELEGRAM, reportTo: origin } }, deps);
    expect(received).toEqual([{ text: '구현해 줘', reportTo: origin }]);
    received.length = 0;
    await submitIntakeWork({ text: '구현해 줘', track: 'graph', origin: OWNER }, deps);
    expect(received).toEqual([{ text: '구현해 줘', reportTo: undefined }]);
  });

  test('default graph ask sends reportTo in the HTTP request body', async () => {
    const origin = { channel: 'telegram' as const, chatId: -100123, botId: 'bot-1' };
    const bodies: unknown[] = [];
    const { deps } = fakeDeps();
    delete deps.askHarness;
    deps.handleHarnessAskPost = async (request) => {
      bodies.push(await request.json());
      return new Response(JSON.stringify({ acceptanceId: 'acc-1' }));
    };
    expect(await submitIntakeWork({ text: '구현해 줘', track: 'graph', origin: { ...TELEGRAM, reportTo: origin } }, deps))
      .toEqual({ ok: true, track: 'graph', acceptanceId: 'acc-1' });
    await submitIntakeWork({ text: '개선해 줘', track: 'graph', origin: OWNER }, deps);
    expect(bodies).toEqual([{ text: '구현해 줘', origin }, { text: '개선해 줘' }]);
  });

  test('a failing door becomes ok:false with a reason, and logs never carry the text', async () => {
    const { deps, logs } = fakeDeps();
    deps.createTask = async () => ({ output: 'TOX not initialized — graph unavailable' });
    const res = await submitIntakeWork({ text: '비밀 문장 하나', track: 'tasks', origin: OWNER }, deps);
    expect(res).toEqual({ ok: false, track: 'tasks', reason: 'TOX not initialized — graph unavailable' });
    expect(JSON.stringify(logs)).not.toContain('비밀 문장');
    expect(logs.at(-1)!.data.textLength).toBe('비밀 문장 하나'.length);
  });

  test('empty text is rejected without touching any door', async () => {
    const { deps, ingested, tasks, asks } = fakeDeps();
    const res = await submitIntakeWork({ text: '   ', track: 'absorb', origin: OWNER }, deps);
    expect(res).toEqual({ ok: false, track: 'absorb', reason: 'empty-text' });
    expect(ingested.length + tasks.length + asks.length).toBe(0);
  });
});

describe('routeAndSubmitIntakeWork', () => {
  test('a URL-only message is routed to absorb and submitted', async () => {
    const { deps, ingested } = fakeDeps();
    const res = await routeAndSubmitIntakeWork({ text: 'https://a.example/x', origin: TELEGRAM }, deps);
    expect(res.decision.track).toBe('absorb');
    expect('submitted' in res && res.submitted.ok).toBe(true);
    expect(ingested).toHaveLength(1);
  });

  test('an unknown message is not executed and offers the three tracks', async () => {
    const { deps, ingested, tasks, asks } = fakeDeps();
    const res = await routeAndSubmitIntakeWork({ text: '음', origin: TELEGRAM }, deps);
    expect(res.decision.track).toBe('ask-human');
    expect('askHuman' in res ? res.askHuman : null).toEqual(['absorb', 'tasks', 'graph']);
    expect(ingested.length + tasks.length + asks.length).toBe(0);
  });

  test('a hint from the person overrides the rules', async () => {
    const { deps, asks } = fakeDeps();
    const res = await routeAndSubmitIntakeWork({ text: '음', origin: OWNER, hint: 'graph' }, deps);
    expect(res.decision).toMatchObject({ track: 'graph', decidedBy: 'human' });
    expect(asks).toEqual(['음']);
  });
});

describe('text helpers', () => {
  test('absorbItemsFromText keeps prose as one item when there is no URL', () => {
    expect(absorbItemsFromText('그냥 메모')).toEqual([{ text: '그냥 메모' }]);
  });
  test('taskFieldsFromText caps the title at 80 chars and omits an empty description', () => {
    const long = 'a'.repeat(120);
    expect(taskFieldsFromText(long)).toEqual({ title: 'a'.repeat(80) });
  });
});
