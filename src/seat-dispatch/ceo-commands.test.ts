import { expect, test } from 'bun:test';
import type { MessageEnvelope } from '../msg/msg-store.js';
import { dispatchCeoTask, handleCeoSeatCommand, type CeoCommandDeps } from './ceo-commands.js';

const OWNER = '111';
function harness(over: Partial<CeoCommandDeps> = {}) {
  const gh: Array<{ args: string[]; stdin: string }> = [];
  const stored: MessageEnvelope[] = [];
  const deps: CeoCommandDeps = {
    ownerId: OWNER, replyTarget: 'acme/repo#20798',
    runGh: async (args, stdin) => { gh.push({ args, stdin }); return 0; },
    append: (message) => { stored.push(message); },
    now: () => new Date('2026-10-02T03:30:00Z'),
    ...over,
  };
  return { deps, gh, stored };
}

test('owner in a private chat: one channel line, one ceo-task message, «받음» reply', async () => {
  const { deps, gh, stored } = harness();
  const reply = await handleCeoSeatCommand('cto', ['결제', '화면', '오타', '고쳐', '줘'], { chatId: 111, userId: 111 }, deps);
  expect(reply).toBe('받음 — TC에 전했습니다.');
  expect(gh).toEqual([{ args: ['pr', 'comment', '20798', '--repo', 'acme/repo', '--body-file', '-'], stdin: '**[대표]** 2026-10-02 12:30 KST → TC · 결제 화면 오타 고쳐 줘' }]);
  expect(stored).toEqual([{ from: 'CEO', to: 'TC', body: '결제 화면 오타 고쳐 줘', kind: 'ceo-task' }]);
});

test('dispatchCeoTask routes a non-Telegram request through the same seat store and channel', async () => {
  const { deps, gh, stored } = harness({ ownerId: null });
  const result = await dispatchCeoTask('MK', '  홍보   문구  검토  ', deps);
  expect(result).toEqual({ reply: '받음 — MK에 전했습니다.', channel: 'posted' });
  expect(stored).toEqual([{ from: 'CEO', to: 'MK', body: '홍보 문구 검토', kind: 'ceo-task' }]);
  expect(gh).toEqual([{ args: ['pr', 'comment', '20798', '--repo', 'acme/repo', '--body-file', '-'], stdin: '**[대표]** 2026-10-02 12:30 KST → MK · 홍보 문구 검토' }]);
});

test('Discord seat dispatch uses the existing inbox and coordination channel path', async () => {
  const { deps, gh, stored } = harness();
  const result = await dispatchCeoTask('TC', '결제 화면 오타 고쳐 줘', deps, { via: 'discord' });
  expect(result).toEqual({ reply: '받음 — TC에 전했습니다.', channel: 'posted' });
  expect(stored).toEqual([{ from: 'CEO', to: 'TC', body: '결제 화면 오타 고쳐 줘', kind: 'ceo-task' }]);
  expect(gh).toEqual([{ args: ['pr', 'comment', '20798', '--repo', 'acme/repo', '--body-file', '-'], stdin: '**[대표]** 2026-10-02 12:30 KST → TC · 결제 화면 오타 고쳐 줘' }]);
});

test('dispatchCeoTask rejects whitespace-only requests before writing', async () => {
  const { deps, gh, stored } = harness();
  const result = await dispatchCeoTask('OP', '  \t  ', deps);
  expect(result.reply).toBe('할 일을 입력해 주세요.');
  expect(stored).toEqual([]);
  expect(gh).toEqual([]);
});

test('PWA dispatch includes attachment paths only in the seat inbox and not the channel', async () => {
  const { deps, gh, stored } = harness();
  const result = await dispatchCeoTask('OP', '현장 사진 보고 공지 초안', deps,
    { attachments: [{ name: '현장.jpg', path: '/tmp/seat/att-1.jpg' }], via: 'pwa' });
  expect(result).toEqual({ reply: '받음 — OP에 전했습니다.', channel: 'posted' });
  expect(stored).toEqual([{ from: 'CEO', to: 'OP', kind: 'ceo-task', body: '현장 사진 보고 공지 초안\n첨부: 현장.jpg — /tmp/seat/att-1.jpg' }]);
  expect(gh.map(({ stdin }) => stdin)).toEqual(['**[대표]** 2026-10-02 12:30 KST → OP · 현장 사진 보고 공지 초안 · 첨부 1 (PWA)']);
});

test('PWA channel failure leaves the seat message intact and returns a structured reason', async () => {
  const { deps, stored } = harness({ runGh: async () => 1 });
  expect(await dispatchCeoTask('TC', '확인', deps, { via: 'pwa' })).toEqual({
    reply: '받음 — TC 메시지함에는 넣었습니다. 다만 조율 채널에 못 남겼습니다(gh 종료 코드 1).', channel: 'failed', channelError: 'gh 종료 코드 1',
  });
  expect(stored).toEqual([{ from: 'CEO', to: 'TC', body: '확인', kind: 'ceo-task' }]);
});

test('owner in a group is refused and nothing is written', async () => {
  const { deps, gh, stored } = harness();
  expect(await handleCeoSeatCommand('cto', ['x'], { chatId: -500, userId: 111 }, deps)).toBe('개인 대화에서만 쓸 수 있습니다.');
  expect(gh).toEqual([]);
  expect(stored).toEqual([]);
});

test('someone else in a private chat is refused and nothing is written', async () => {
  const { deps, gh, stored } = harness();
  expect(await handleCeoSeatCommand('cto', ['x'], { chatId: 222, userId: 222 }, deps)).toBe('소유자만 쓸 수 있습니다.');
  expect(gh).toEqual([]);
  expect(stored).toEqual([]);
});

test('no configured owner refuses everyone', async () => {
  const { deps, gh } = harness({ ownerId: null });
  expect(await handleCeoSeatCommand('coo', ['x'], { chatId: 111, userId: 111 }, deps)).toBe('소유자만 쓸 수 있습니다.');
  expect(gh).toEqual([]);
});

test('empty /cmo prints one usage line and writes nothing', async () => {
  const { deps, gh, stored } = harness();
  expect(await handleCeoSeatCommand('cmo', ['  '], { chatId: 111, userId: 111 }, deps)).toBe('사용법: /cmo <할 일>');
  expect(gh).toEqual([]);
  expect(stored).toEqual([]);
});

test('gh failure is said in the reply; the seat store still has the task', async () => {
  const { deps, stored } = harness({ runGh: async () => 1 });
  const reply = await handleCeoSeatCommand('cxo', ['폰', '화면'], { chatId: 111, userId: 111 }, deps);
  expect(reply).toContain('조율 채널에 못 남겼습니다(gh 종료 코드 1)');
  expect(stored).toEqual([{ from: 'CEO', to: 'UX', body: '폰 화면', kind: 'ceo-task' }]);
});

test('missing reply target is said in the reply instead of hidden', async () => {
  const { deps, gh, stored } = harness({ replyTarget: null });
  expect(await handleCeoSeatCommand('coo', ['x'], { chatId: 111, userId: 111 }, deps)).toContain('decisions.replyGhPr 미설정');
  expect(gh).toEqual([]);
  expect(stored).toHaveLength(1);
});

test('dispatchCeoTask with a ref already in the seat inbox delivers nothing again and reports the channel as unknown', async () => {
  const gh: string[] = [];
  const stored: MessageEnvelope[] = [];
  const deps: CeoCommandDeps = {
    ownerId: null, replyTarget: 'acme/repo#20798',
    runGh: async (_args, stdin) => { gh.push(stdin); return 0; },
    append: (message) => { stored.push(message); },
    hasMessage: (seat, ref) => stored.some((m) => m.to === seat && m.body.endsWith(`\n요청: ${ref}`)),
  };
  const first = await dispatchCeoTask('OP', '공지 초안', deps, { via: 'pwa', ref: 'pwa:r-1' });
  expect(first.channel).toBe('posted');
  expect(stored).toEqual([{ from: 'CEO', to: 'OP', body: '공지 초안\n요청: pwa:r-1', kind: 'ceo-task' }]);
  const retry = await dispatchCeoTask('OP', '공지 초안', deps, { via: 'pwa', ref: 'pwa:r-1' });
  expect(retry.channel).toBe('unknown');
  expect(stored).toHaveLength(1);
  expect(gh).toHaveLength(1);
});
