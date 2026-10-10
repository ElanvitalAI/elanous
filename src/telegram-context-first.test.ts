import { expect, test } from 'bun:test';
import { TelegramBot } from './telegram.js';
import type { ContextNowAnswer, ContextNowDeps } from './context-bus/context-now.js';
import { renderContextFirstOpening } from './context-bus/context-now-surfaces.js';
import type { UserConfig } from './user-config.js';

const HOUR = 60 * 60 * 1000;
const at = '2026-10-06T00:00:00.000Z';
const answer: ContextNowAnswer = {
  at, topic: null,
  facts: [
    { kind: 'version', version: '0.2.16', source: 'elanous://release/0.2.16/checklist' },
    { kind: 'cell', version: '0.2.16', id: 'TG-CTX', title: 'Context first', status: 'red', owner: 'UX', source: 'elanous://release/0.2.16/checklist#TG-CTX' },
    { kind: 'decision', id: 'D1', title: 'Wait on context', status: 'open', dueAt: null, source: 'elanous://decisions/D1' },
    { kind: 'seat', seat: 'UX', at, status: 'shadow', id: 'TG-CTX', title: 'Context first', source: 'elanous://seat-loop/UX/1#1' },
    { kind: 'run', goal: 'TG-CTX', phase: 'implement', elapsed: '2분', source: 'run://active' },
  ],
  events: [{ at, kind: '보고', summary: '최근 대화', source: 'https://example.org/now' }],
  guide: [],
};
const SUMMARY = renderContextFirstOpening(answer);
let readContextNow: () => ContextNowAnswer = () => answer;
const nowDeps: ContextNowDeps = {};

function makeBot(opts: {
  contextFirst?: boolean;
  deps?: ContextNowDeps;
  clock?: { now: number };
} = {}) {
  const sent: string[] = [];
  const clock = opts.clock ?? { now: 0 };
  const userConfig = {
    telegram: { contextFirst: opts.contextFirst, allowedUsers: [7], enabled: true },
    intake: { telegram: { ambientCapture: 'off' } },
  } as unknown as UserConfig;
  const bot = new TelegramBot({
    token: 'test:token',
    allowedUsers: [7],
    perChatGapMs: 0,
    nowImpl: () => clock.now,
    sleepImpl: async () => {},
    log: () => {},
    onMessage: async () => '본 답',
    readContextNow: () => readContextNow(),
    contextNowDeps: opts.deps ?? nowDeps,
    slashContext: { userConfig },
    fetchImpl: (async (_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? '{}') as { text?: string };
      if (body.text) sent.push(body.text);
      return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } }), { status: 200 });
    }) as typeof fetch,
  });
  return { bot, sent, clock };
}

const incoming = (text: string, messageId = 1) => ({
  updateId: messageId, chatId: 7, userId: 7, text, messageId, isDm: true, isGroup: false, attachments: [],
});

test('첫 말 → 요약 1 ⊕ 답 · 5분 뒤 → 요약 0 · 7시간 뒤 → 요약 1', async () => {
  const { bot, sent, clock } = makeBot();
  await (bot as unknown as { handleIncoming: (c: ReturnType<typeof incoming>) => Promise<void> }).handleIncoming(incoming('안녕'));
  expect(sent).toEqual([SUMMARY, '⏳ Working…', '본 답']);
  expect(SUMMARY).toContain('TG-CTX');
  expect(SUMMARY).not.toContain('D1 Wait on context');
  expect(SUMMARY).not.toContain('최근');

  clock.now = 5 * 60 * 1000;
  sent.length = 0;
  await (bot as unknown as { handleIncoming: (c: ReturnType<typeof incoming>) => Promise<void> }).handleIncoming(incoming('또', 2));
  expect(sent.filter(text => text === SUMMARY)).toHaveLength(0);
  expect(sent).toContain('본 답');

  clock.now = 7 * HOUR;
  sent.length = 0;
  await (bot as unknown as { handleIncoming: (c: ReturnType<typeof incoming>) => Promise<void> }).handleIncoming(incoming('나중', 3));
  expect(sent[0]).toBe(SUMMARY);
  expect(sent).toContain('본 답');
});

test('요약 실패 주입 → «맥락 못 읽음» ⊕ 답', async () => {
  readContextNow = () => { throw new Error('ledger down'); };
  const { bot, sent } = makeBot();
  await (bot as unknown as { handleIncoming: (c: ReturnType<typeof incoming>) => Promise<void> }).handleIncoming(incoming('안녕'));
  expect(sent[0]).toBe('맥락 못 읽음');
  expect(sent).toContain('본 답');
});

test('설정 끔 → 요약 0', async () => {
  const { bot, sent } = makeBot({ contextFirst: false });
  await (bot as unknown as { handleIncoming: (c: ReturnType<typeof incoming>) => Promise<void> }).handleIncoming(incoming('안녕'));
  expect(sent.filter(text => text === SUMMARY || text === '맥락 못 읽음')).toHaveLength(0);
  expect(sent).toContain('본 답');
});

test('the gap is from the last utterance, not the last summary: 0h → 5h → 7h sends one summary only', async () => {
  readContextNow = () => answer;
  const { bot, sent, clock } = makeBot();
  const send = (bot as unknown as { handleIncoming: (c: ReturnType<typeof incoming>) => Promise<void> }).handleIncoming.bind(bot);
  await send(incoming('안녕', 1));
  clock.now = 5 * HOUR;
  await send(incoming('5시간 뒤', 2));
  clock.now = 7 * HOUR;
  await send(incoming('2시간 뒤', 3));
  expect(sent.filter(text => text === SUMMARY)).toHaveLength(1);
});

test('just under six hours of silence → no summary; six hours or more → summary', async () => {
  readContextNow = () => answer;
  const { bot, sent, clock } = makeBot();
  const send = (bot as unknown as { handleIncoming: (c: ReturnType<typeof incoming>) => Promise<void> }).handleIncoming.bind(bot);
  await send(incoming('안녕', 1));
  clock.now = 6 * HOUR - 1;
  await send(incoming('경계 직전', 2));
  expect(sent.filter(text => text === SUMMARY)).toHaveLength(1);
  clock.now = 12 * HOUR - 1;
  await send(incoming('경계 넘김', 3));
  expect(sent.filter(text => text === SUMMARY)).toHaveLength(2);
});

test('an utterance in between resets the quiet gap: 0h → 5h → 7h sends one summary only (every allowed message is noted at the top of handleIncoming)', async () => {
  readContextNow = () => answer;
  const { bot, sent, clock } = makeBot();
  const send = (bot as unknown as { handleIncoming: (c: ReturnType<typeof incoming>) => Promise<void> }).handleIncoming.bind(bot);
  await send(incoming('안녕', 1));
  clock.now = 5 * HOUR;
  await send(incoming('/nosuchcmd', 2));
  clock.now = 7 * HOUR;
  await send(incoming('2시간 뒤', 3));
  expect(sent.filter(text => text === SUMMARY)).toHaveLength(1);
});

test('turning the setting back on does not forget utterances made while it was off', async () => {
  readContextNow = () => answer;
  const { bot, sent, clock } = makeBot({ contextFirst: false });
  const send = (bot as unknown as { handleIncoming: (c: ReturnType<typeof incoming>) => Promise<void> }).handleIncoming.bind(bot);
  await send(incoming('끈 채로', 1));
  (bot as unknown as { slashContext: { userConfig: { telegram: { contextFirst?: boolean } } } }).slashContext.userConfig.telegram.contextFirst = true;
  clock.now = 1 * HOUR;
  await send(incoming('켠 뒤 1시간', 2));
  expect(sent.filter(text => text === SUMMARY)).toHaveLength(0);
});
