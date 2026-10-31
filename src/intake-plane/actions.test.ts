import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listSources } from './intake-sources.js';
import { appendTopicBriefingTelegramDryRun, deliverTopicBriefing, deliverTopicBriefingWithReceipts, isDecisionImpactingTopicEvidence, scheduleIntakeSession, subscribeTopicSearch } from './actions.js';
import type { IntakeStore } from './store.js';

const linearIssueId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

test('topic subscription registers one existing daemon schedule then immediately runs the same source id', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'topic-subscribe-'));
  const calls: Array<Record<string, unknown>> = [];
  try {
    const result = await subscribeTopicSearch({ seat: 'MK', topic: 'HBM supply chain', linearIssueId,
      every: '1w', scheduleCron: '0 8 * * 1' }, {
      stateDir,
      now: new Date('2026-10-30T23:00:00Z'),
      scheduleDispatch: async (args) => {
        calls.push(args);
        if (args.action === 'list') return { schedules: [{ id: 'schedule-123', cron: '0 8 * * 1',
          command: calls.find(call => call.action === 'create')?.command }] };
        return { ok: true };
      },
      runDue: async (input) => ({ ran: [{ id: input?.sourceId ?? 'immediate', items: 5 }] }),
    });
    expect(result.source).toMatchObject({ seat: 'MK', kind: 'topic-search', spec: 'HBM supply chain', every: '1w', linearIssueId, scheduleCron: '0 8 * * 1' });
    expect(result.scheduleId).toBe('schedule-123');
    expect(result.immediate.ran).toEqual([{ id: result.source.id, items: 5 }]);
    expect(calls.map(call => call.action)).toEqual(['create', 'list', 'migrate', 'note']);
    expect(calls[0]).toMatchObject({ cron: '0 8 * * 1', command: `eln intake source run-due --source-id ${result.source.id} --project-issue-briefing`, category: 'ingest' });
    expect(calls[2]).toMatchObject({ id: 'schedule-123', yes: true });
    expect(listSources({}, stateDir)).toHaveLength(1);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test('Telegram dry-run file is propagated to recurring command and records bodies without a live sender', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'topic-subscribe-dryrun-'));
  const output = join(stateDir, 'telegram.jsonl');
  let command = '';
  try {
    const result = await subscribeTopicSearch({ seat: 'MK', topic: 'HBM supply chain', linearIssueId,
      every: '1w', scheduleCron: '0 8 * * 1', telegramDryRunFile: output }, {
      stateDir,
      scheduleDispatch: async args => {
        if (args.action === 'create') command = String(args.command);
        if (args.action === 'list') return { schedules: [{ id: 'dryrun-schedule', cron: '0 8 * * 1', command }] };
        return { ok: true };
      },
      runDue: async input => {
        expect(input?.deps?.projectTopicBriefing).toBeTypeOf('function');
        return { ran: [{ id: input?.sourceId ?? 'immediate', items: 0 }] };
      },
    });
    expect(result.scheduleId).toBe('dryrun-schedule');
    expect(command).toContain(`--telegram-dry-run-file '${output}'`);
    appendTopicBriefingTelegramDryRun(output, { linearIssueId, text: 'issue card', kind: 'issue' });
    appendTopicBriefingTelegramDryRun(output, { linearIssueId, text: 'memo card', kind: 'memo' });
    const rows = readFileSync(output, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(rows).toMatchObject([{ linearIssueId, text: 'issue card', kind: 'issue' }, { linearIssueId, text: 'memo card', kind: 'memo' }]);
    expect(statSync(output).mode & 0o777).toBe(0o600);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test('an existing live topic schedule blocks adding a duplicate Telegram dry-run schedule', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'topic-subscribe-mode-conflict-'));
  try {
    const input = { seat: 'MK', topic: 'HBM supply chain', linearIssueId, every: '1w', scheduleCron: '0 8 * * 1' };
    const sourceId = `topic-${(await import('node:crypto')).createHash('sha256').update(`MK\n${linearIssueId}\nhbm supply chain`).digest('hex').slice(0, 20)}`;
    const { addSource } = await import('./intake-sources.js');
    addSource({ id: sourceId, seat: 'MK', kind: 'topic-search', spec: input.topic, every: input.every,
      scheduleCron: input.scheduleCron, linearIssueId }, stateDir);
    const liveCommand = `eln intake source run-due --source-id ${sourceId} --project-issue-briefing`;
    await expect(subscribeTopicSearch({ ...input, telegramDryRunFile: join(stateDir, 'telegram.jsonl') }, {
      stateDir,
      scheduleDispatch: async args => args.action === 'list'
        ? { schedules: [{ id: 'existing-live', cron: input.scheduleCron, command: liveCommand }] } : { ok: true },
      runDue: async () => ({ ran: [] }),
    })).rejects.toThrow('중복 예약을 피하려면 기존 일정부터 제거해야 한다');
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test('topic schedule registration sees maintenance-classified crontab rows and rolls back a failed migration', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'topic-subscribe-category-rollback-'));
  const calls: Array<Record<string, unknown>> = [];
  let command = '';
  try {
    await expect(subscribeTopicSearch({ seat: 'MK', topic: 'AI chip capacity', linearIssueId,
      every: '1d', scheduleCron: '0 8 31 10 *' }, {
      stateDir,
      scheduleDispatch: async (args) => {
        calls.push(args);
        if (args.action === 'create') { command = String(args.command); return { ok: true }; }
        if (args.action === 'list') {
          expect(args.category).toBeUndefined();
          return { schedules: [{ id: 'maintenance-row', category: 'maintenance', cron: '0 8 31 10 *', command }] };
        }
        if (args.action === 'migrate') return { error: 'migration unavailable' };
        return { ok: true };
      },
    })).rejects.toThrow('topic-search 일정을 데몬으로 이관하지 못했다: migration unavailable');
    expect(calls.map(call => call.action)).toEqual(['create', 'list', 'migrate', 'delete']);
    expect(calls.at(-1)).toMatchObject({ action: 'delete', id: 'maintenance-row', yes: true });
    expect(listSources({}, stateDir)).toEqual([]);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test('topic subscription identities distinguish seats for the same parent issue and topic', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'topic-subscribe-seats-'));
  try {
    const common = { topic: 'HBM supply chain', linearIssueId, every: '1w', scheduleCron: '0 8 * * 1' };
    const subscribe = async (seat: 'MK' | 'UX') => {
      let command = '';
      return subscribeTopicSearch({ ...common, seat }, {
        stateDir,
        scheduleDispatch: async args => {
          if (args.action === 'create') command = String(args.command);
          if (args.action === 'list') return { schedules: [{ id: `${seat.toLowerCase()}-schedule`, cron: '0 8 * * 1', command }] };
          return { ok: true };
        },
        runDue: async input => ({ ran: [{ id: input?.sourceId ?? 'immediate', items: 0 }] }),
      });
    };
    const mk = await subscribe('MK');
    const ux = await subscribe('UX');
    expect(mk.source.id).not.toBe(ux.source.id);
    expect(listSources({}, stateDir).map(source => source.seat).sort()).toEqual(['MK', 'UX']);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test('failed topic schedule registration removes the source instead of leaving an unscheduled subscription', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'topic-subscribe-fail-'));
  try {
    await expect(subscribeTopicSearch({ seat: 'MK', topic: 'HBM supply chain', linearIssueId,
      every: '1w', scheduleCron: '0 8 * * 1' }, {
      stateDir,
      scheduleDispatch: async () => ({ error: 'schedule write denied' }),
      runDue: async () => ({ ran: [] }),
    })).rejects.toThrow('topic-search 일정 등록 실패: schedule write denied');
    expect(listSources({}, stateDir)).toEqual([]);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test('a schedule created before an unreadable registry list is removed with the orphan source', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'topic-subscribe-orphan-'));
  const actions: string[] = [];
  try {
    await expect(subscribeTopicSearch({ seat: 'MK', topic: 'HBM supply chain', linearIssueId,
      every: '1w', scheduleCron: '0 8 * * 1' }, {
      stateDir,
      scheduleDispatch: async (args) => {
        actions.push(String(args.action));
        if (args.action === 'list') {
          if (actions.filter(action => action === 'list').length === 1) return { error: 'registry unavailable' };
          return { schedules: [{ id: 'orphan-1', command: actions.includes('create')
            ? `eln intake source run-due --source-id ${listSources({}, stateDir)[0]?.id} --project-issue-briefing` : '', cron: '0 8 * * 1' }] };
        }
        return { ok: true };
      },
    })).rejects.toThrow('일정 목록 확인 실패: registry unavailable');
    expect(actions).toContain('delete');
    expect(listSources({}, stateDir)).toEqual([]);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test('topic subscription recreates a manually removed recurring schedule for an existing source', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'topic-subscribe-recreate-'));
  let command = '';
  let created = 0;
  try {
    const input = { seat: 'MK', topic: 'HBM supply chain', linearIssueId, every: '1w', scheduleCron: '0 8 * * 1' };
    const dispatch = async (args: Record<string, unknown>) => {
      if (args.action === 'create') { created++; command = String(args.command); return { ok: true }; }
      if (args.action === 'list') return { schedules: command
        ? [{ id: 'recreated-schedule', cron: '0 8 * * 1', command }] : [] };
      return { ok: true };
    };
    const runDue = async (value?: { now?: Date; seat?: string; sourceId?: string; deps?: import('./intake-sources.js').RunDueDeps }) => ({
      ran: [{ id: value?.sourceId ?? 'immediate', items: 0 }],
    });
    await subscribeTopicSearch(input, { stateDir, scheduleDispatch: dispatch, runDue });
    command = '';
    const result = await subscribeTopicSearch(input, { stateDir, scheduleDispatch: dispatch, runDue });
    expect(created).toBe(2);
    expect(result.scheduleId).toBe('recreated-schedule');
    expect(listSources({}, stateDir)).toHaveLength(1);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test('topic subscription fails and removes a new orphan schedule when its note cannot be stored', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'topic-subscribe-note-'));
  const actions: string[] = [];
  try {
    await expect(subscribeTopicSearch({ seat: 'MK', topic: 'HBM supply chain', linearIssueId,
      every: '1w', scheduleCron: '0 8 * * 1' }, {
      stateDir,
      scheduleDispatch: async args => {
        actions.push(String(args.action));
        if (args.action === 'list') return { schedules: [{ id: 'schedule-note-fail', cron: '0 8 * * 1', command: String(args.command ?? `eln intake source run-due --source-id ${listSources({}, stateDir)[0]?.id} --project-issue-briefing`) }] };
        if (args.action === 'note') return { error: 'note write denied' };
        return { ok: true };
      },
    })).rejects.toThrow('일정 설명 저장 실패: note write denied');
    expect(actions).toContain('delete');
    expect(listSources({}, stateDir)).toEqual([]);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test('issue briefing sends only related findings to Telegram and Linear, then reopens a Done issue once', async () => {
  const calls: string[] = [];
  const related = { id: 1, text: 'HBM lead time changed', domain: '흡수', priority: 'P1', deadline: null,
    evidence: 'https://example.test/hbm', source: 'topic', linearIssueId, created_at: '2026-10-30T00:00:00.000Z', sent_at: null } as const;
  const unrelated = { ...related, id: 2, text: 'Unrelated item', linearIssueId: 'a1234567-89ab-4cde-8f01-123456789abc' } as const;
  const result = await deliverTopicBriefing({ linearIssueId, issueLabel: 'HBM project', summary: 'Supply lead time rose 15%.', items: [related, unrelated] }, {
    sendIssueCard: async ({ text }) => { calls.push(`telegram:${text}`); },
    commentIssue: async (_id, text) => { calls.push(`linear:${text}`); },
    issueIsDone: async () => true,
    isDecisionImpacting: async items => { calls.push(`impact:${items.length}`); return true; },
    reopenIssue: async () => { calls.push('reopen'); },
    sendMemoUpdateCard: async ({ text }) => { calls.push(`memo:${text}`); },
  });
  expect(result).toEqual({ related: 1, reopened: true });
  expect(calls).toHaveLength(5);
  expect(calls[0]).toContain('관련 이슈');
  expect(calls[0]).toContain('https://example.test/hbm');
  expect(calls[0]).not.toContain('Unrelated item');
  expect(calls[1]).toContain('Supply lead time rose 15%.');
  expect(calls[2]).toBe('impact:1');
  expect(calls.slice(3)).toEqual(['reopen', expect.stringContaining('메모 갱신?')]);
  expect(calls[4]).toContain('HBM project');
});

test('Done issue reopening requires specific decision-scale evidence rather than incidental keywords', () => {
  const item = (text: string) => ({ id: 1, text, domain: '흡수', priority: 'P1', deadline: null, evidence: null,
    source: 'topic', linearIssueId, created_at: '2026-10-30T00:00:00.000Z', sent_at: null }) as const;
  expect(isDecisionImpactingTopicEvidence([item('계약 조건을 논의했다')])).toBe(false);
  expect(isDecisionImpactingTopicEvidence([item('The report notes a delay in the meeting')])).toBe(false);
  expect(isDecisionImpactingTopicEvidence([item('주요 공급 계약이 취소됐다')])).toBe(true);
  expect(isDecisionImpactingTopicEvidence([item('Revenue outlook downgraded')])).toBe(true);
});

test('issue briefing retries only the failed delivery stage after a Telegram success', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'topic-delivery-receipt-'));
  let telegram = 0;
  let comments = 0;
  let failComment = true;
  const item = { id: 5, text: 'HBM supply outlook', domain: '흡수', priority: 'P1', deadline: null,
    evidence: 'https://example.test/hbm', source: 'topic', linearIssueId, created_at: '2026-10-30T00:00:00.000Z', sent_at: null } as const;
  const deps = {
    sendIssueCard: async () => { telegram++; },
    commentIssue: async () => { comments++; if (failComment) { failComment = false; throw new Error('temporary Linear outage'); } },
    issueIsDone: async () => false,
    isDecisionImpacting: async () => false,
    reopenIssue: async () => {},
    sendMemoUpdateCard: async () => {},
  };
  try {
    const input = { linearIssueId, summary: 'HBM supply outlook changed', items: [item] };
    await expect(deliverTopicBriefingWithReceipts(input, stateDir, deps)).rejects.toThrow('temporary Linear outage');
    const retried = await deliverTopicBriefingWithReceipts(input, stateDir, deps);
    expect(retried).toEqual({ related: 1, reopened: false });
    expect(telegram).toBe(1);
    expect(comments).toBe(2);
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test('issue briefing with no related items does not send, comment, or reopen', async () => {
  let calls = 0;
  const result = await deliverTopicBriefing({ linearIssueId, summary: 'Not relevant', items: [] }, {
    sendIssueCard: async () => { calls++; }, commentIssue: async () => { calls++; },
    issueIsDone: async () => { calls++; return true; }, isDecisionImpacting: async () => { calls++; return true; },
    reopenIssue: async () => { calls++; }, sendMemoUpdateCard: async () => { calls++; },
  });
  expect(result).toEqual({ related: 0, reopened: false });
  expect(calls).toBe(0);
});

test('schedule-followup preserves the session draft and records the requested schedule text', () => {
  const session = { intakeId: 'daily-intake', draft: { items: [{ id: 'watch-topic' }] } };
  let saved: unknown;
  const store = {
    getSession: (id: string) => id === 'daily-intake' ? session : undefined,
    saveDecision: (intakeId: string, decision: unknown) => {
      saved = decision;
      return { ...session, intakeId };
    },
  } as unknown as IntakeStore;

  const result = scheduleIntakeSession(store, 'daily-intake', '매일 07:00');

  expect(result.output).toBe('intake daily-intake scheduled as "매일 07:00"');
  expect(saved).toEqual({
    intakeId: 'daily-intake', mode: 'schedule-followup', approvedItemIds: ['watch-topic'],
    deferredItemIds: [], clarifiedAnswers: { scheduleText: '매일 07:00' },
  });
});
