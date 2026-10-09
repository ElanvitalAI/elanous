import { expect, test } from 'bun:test';
import { createContextFirstGate, renderContextFirst } from './context-first.js';
import type { ContextNowAnswer } from './context-now.js';
import { renderContextFirstNow, renderTelegramNow } from './context-now-surfaces.js';
import { botFromConfig } from '../telegram.js';
import { runTurn } from '../session/chat.js';
import type { LLMProvider } from '../llm.js';
import { buildAcpContextPreamble } from '../telegram-commands.js';
import { contextNow } from './context-now.js';
import { appendMessage, createSession, findSessionByTelegramChat, loadSession } from '../session/index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UserConfig } from '../user-config.js';

test('first note is pending once; recent utterances do not re-arm; six hours of silence re-arms', () => {
  let time = 0;
  const gate = createContextFirstGate({ now: () => time });
  gate.note('a');
  expect(gate.take('a')).toBe(true);
  expect(gate.take('a')).toBe(false);
  time += 5 * 60_000;
  gate.note('a');
  expect(gate.take('a')).toBe(false);
  time += 6 * 60 * 60_000;
  gate.note('a');
  expect(gate.take('a')).toBe(true);
  expect(gate.take('a')).toBe(false);
});

test('commands update the last utterance without consuming a pending summary; keys are independent', () => {
  let time = 0;
  const gate = createContextFirstGate({ now: () => time });
  gate.note('channel');
  time += 5 * 60_000;
  gate.note('channel');
  expect(gate.take('channel')).toBe(true);
  time += 5 * 60 * 60_000 + 56 * 60_000;
  gate.note('channel');
  expect(gate.take('channel')).toBe(false);
  gate.note('other');
  expect(gate.take('other')).toBe(true);
});

test('context-first includes live run and blockage without changing the /now renderer or answer', () => {
  const answer: ContextNowAnswer = {
    at: '2026-10-08T06:00:00.000Z', topic: null,
    facts: [
      { kind: 'version', version: '0.2.22', source: 'release://current' },
      { kind: 'run', goal: 'TG-CTX', phase: 'implement', elapsed: '2분', source: 'run://active' },
      { kind: 'release', version: '0.2.22', node: 'publish', status: 'blocked', source: 'release://run' },
      { kind: 'decision', id: 'D1', title: 'approve', status: 'open', dueAt: null, source: 'decision://open' },
    ],
    events: [{ at: '2026-10-08T05:00:00.000Z', kind: 'report', summary: '최근 대화', source: 'event://recent' }], guide: [],
  };
  const before = JSON.stringify(answer);
  const slash = renderTelegramNow(answer);
  const first = renderContextFirst(() => answer, undefined, renderContextFirstNow);
  expect(first).toContain('도는 런: TG-CTX · implement · 2분 — run://active');
  expect(first).toContain('발행 런: 0.2.22 · publish · blocked — release://run');
  expect(first).toContain('결정: D1 approve (open) — decision://open');
  expect(first).toContain('최근: 최근 대화 — event://recent');
  expect(first.endsWith(slash)).toBe(true);
  const runs = Array.from({ length: 5 }, (_, i) => ({ kind: 'run' as const, goal: `G${i}`, phase: 'implement', elapsed: '1분', source: `run://${i}` }));
  const crowded = renderContextFirstNow({ ...answer, facts: [...runs, ...answer.facts.filter(fact => fact.kind !== 'run')] });
  expect(crowded.split('\n').filter(line => line.startsWith('도는 런:'))).toHaveLength(3);
  expect(crowded).toContain('… 운영 항목 3개 더 (/now)');
  const long = renderContextFirstNow({ ...answer, facts: [{ kind: 'run', goal: `대상 경로: ${'x'.repeat(5000)}`, phase: 'implement', elapsed: '1분', source: 'run://long' }] });
  expect(long.split('\n')[0]!.length).toBeLessThan(120);
  expect(long.split('\n')[0]).toEndWith('· implement · 1분 — run://long');
  expect(crowded).toContain('결정: D1 approve (open) — decision://open');
  expect(crowded).toContain('최근: 최근 대화 — event://recent');
  expect(renderContextFirst(() => answer, undefined, () => '다른 화면')).toBe('다른 화면');
  expect(renderTelegramNow(answer)).toBe(slash);
  expect(JSON.stringify(answer)).toBe(before);
});

test('Telegram /attach routes a follow-up into the TUI transcript after context-first, without changing its ledger shape', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tg-context-first-'));
  const oldRoot = process.env.ELANOUS_SESSION_ROOT;
  process.env.ELANOUS_SESSION_ROOT = root;
  try {
    const tui = createSession({ source: 'cli', provider: 'anthropic', model: 'test', title: 'TUI conversation' });
    appendMessage(tui.id, { role: 'user', content: 'TG-CTX 배포는 승인 대기야', ts: new Date().toISOString() });
    appendMessage(tui.id, { role: 'assistant', content: '승인 후 진행하겠습니다', ts: new Date().toISOString() });
    const before = loadSession(tui.id)!.messages;
    const cfg = { telegram: { enabled: true, allowedUsers: [7] }, intake: { telegram: { ambientCapture: 'off' } },
      llm: { provider: 'anthropic', model: 'test' } } as unknown as UserConfig;
    const sent: string[] = [];
    const delivered: Array<{ method: string; text: string }> = [];
    const seen: Array<{ sessionId: string; userText: string; llmMessages: string[] }> = [];
    const provider = { streamChat: async function* (messages: Array<{ role: string; content: unknown }>) {
      const llmMessages = messages.map(m => String(m.content));
      seen.push({ sessionId: tui.id, userText: llmMessages.at(-1) ?? '', llmMessages });
      yield { type: 'text' as const, delta: llmMessages.includes('TG-CTX 배포는 승인 대기야')
        ? 'TG-CTX는 아직 승인 대기입니다' : '이전 대화를 찾지 못했습니다' };
    } } as unknown as LLMProvider;
    const now = new Date('2026-10-08T06:00:00.000Z');
    const summary = contextNow({}, {
      now: () => now, version: () => '0.2.22',
      checklist: version => ({ version, items: version === '0.2.22'
        ? [{ id: 'TG-CTX', title: '맥락 연결 막힘', status: 'red', owner: 'UX' }] : [] }) as ReturnType<NonNullable<import('./context-now.js').ContextNowDeps['checklist']>>,
      decisions: () => [{ id: 'D1', title: '배포 승인 대기', status: 'open' } as ReturnType<NonNullable<import('./context-now.js').ContextNowDeps['decisions']>>[number]],
      seatEntries: () => [], events: () => [{ id: 'recent', at: now.toISOString(), kind: 'report', summary: 'TUI에서 배포 논의', refs: { source: 'event://recent' } } as ReturnType<NonNullable<import('./context-now.js').ContextNowDeps['events']>>[number]],
      runningRuns: () => [{ kind: 'run', goal: 'TG-CTX', phase: 'implement', elapsed: '2분', source: 'run://active' }],
      releaseRun: () => ({ kind: 'release', version: '0.2.22', node: 'publish', status: 'blocked', source: 'release://run' }), lateSchedules: () => null,
    });
    const clock = { now: 0 };
    const bot = botFromConfig({
      userConfig: cfg,
      telegramBotOpts: { token: 'test:token', perChatGapMs: 0, nowImpl: () => clock.now,
        sleepImpl: async () => {}, readContextNow: () => summary },
      fetchImpl: (async (url: unknown, init?: { body?: string }) => {
        const body = JSON.parse(init?.body ?? '{}') as { text?: string };
        if (body.text) {
          delivered.push({ method: String(url).split('/').at(-1) ?? '', text: body.text });
          if (String(url).endsWith('/sendMessage')) sent.push(body.text);
        }
        return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } }), { status: 200 });
      }) as typeof fetch,
      runTurnImpl: opts => runTurn({ ...opts, provider, skipMemoryInjection: true }),
    });
    const send = (bot as unknown as { handleIncoming: (ctx: object) => Promise<void> }).handleIncoming.bind(bot);
    const incoming = (text: string, id: number) => ({ updateId: id, chatId: 7, userId: 7, text, messageId: id,
      isDm: true, isGroup: false, attachments: [] });
    await send(incoming(`/attach ${tui.id}`, 1));
    expect(findSessionByTelegramChat(7)?.id).toBe(tui.id);
    expect(sent.some(s => s.includes('Attached session'))).toBe(true);
    expect(loadSession(tui.id)!.messages).toEqual(before);
    await send(incoming('아까 그거 어떻게 됐어?', 2));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ sessionId: tui.id, userText: '아까 그거 어떻게 됐어?' });
    expect(seen[0]!.llmMessages).toContain('TG-CTX 배포는 승인 대기야');
    expect(buildAcpContextPreamble(7, undefined, undefined)).toContain('TG-CTX 배포는 승인 대기야');
    const firstIndex = delivered.findIndex(s => s.method === 'sendMessage' && s.text.includes('판: 0.2.22'));
    const replyIndex = delivered.findIndex(s => s.text.includes('TG-CTX는 아직 승인 대기입니다'));
    expect(firstIndex).toBeGreaterThanOrEqual(0);
    expect(replyIndex).toBeGreaterThan(firstIndex);
    expect(delivered[replyIndex]?.method).toBe('editMessageText');
    expect(sent.filter(s => s.includes('판: 0.2.22'))).toHaveLength(1);
    for (const item of ['도는 런: TG-CTX', '맥락 연결 막힘', '발행 런: 0.2.22', 'D1 배포 승인 대기', 'TUI에서 배포 논의']) {
      expect(delivered[firstIndex]?.text).toContain(item);
    }
    expect(loadSession(tui.id)!.messages.slice(0, 2)).toEqual(before);
    expect(loadSession(tui.id)!.messages.at(-1)?.content).toBe('TG-CTX는 아직 승인 대기입니다');
    clock.now = 5 * 60 * 60_000;
    await send(incoming('5시간 뒤에도 그거?', 3));
    expect(sent.filter(s => s.includes('판: 0.2.22'))).toHaveLength(1);
    clock.now = 11 * 60 * 60_000;
    await send(incoming('6시간 뒤에는?', 4));
    expect(sent.filter(s => s.includes('판: 0.2.22'))).toHaveLength(2);
    expect(loadSession(tui.id)!.messages.slice(0, 2)).toEqual(before);
  } finally {
    if (oldRoot === undefined) delete process.env.ELANOUS_SESSION_ROOT; else process.env.ELANOUS_SESSION_ROOT = oldRoot;
    rmSync(root, { recursive: true, force: true });
  }
});

test('rendering failure yields the shared unreadable message', () => {
  const answer: ContextNowAnswer = { at: '', topic: null, facts: [], events: [], guide: [] };
  expect(renderContextFirst(() => answer, undefined, () => '요약')).toBe('요약');
  expect(renderContextFirst(() => { throw Error('ledger unavailable'); }, undefined, () => '요약')).toBe('맥락 못 읽음');
  expect(renderContextFirst(() => answer, undefined, () => { throw Error('renderer unavailable'); })).toBe('맥락 못 읽음');
});
