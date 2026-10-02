import { expect, test } from 'bun:test';
import type { MessageEnvelope } from '../msg/msg-store.js';
import { handleCeoSeatCommand, type CeoCommandDeps } from './ceo-commands.js';

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
