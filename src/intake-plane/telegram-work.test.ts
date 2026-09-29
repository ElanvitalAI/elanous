import { describe, expect, test } from 'bun:test';

import { handleTelegramWork, TELEGRAM_WORK_USAGE } from './telegram-work.js';

const MSG = { chatId: 42, messageId: 7 };

describe('telegram /work (X6)', () => {
  test('빈 글이면 사용법', async () => {
    expect(await handleTelegramWork([], MSG)).toBe(TELEGRAM_WORK_USAGE);
    expect(await handleTelegramWork(['tasks'], MSG)).toBe(TELEGRAM_WORK_USAGE);
  });

  test('갈래를 붙이면 판정 없이 그 갈래로 · 외부 출처 ref 는 chat:message', async () => {
    const seen: unknown[] = [];
    const reply = await handleTelegramWork(['tasks', '보고서', '초안'], MSG, {
      route: async () => { throw new Error('판정을 부르면 안 된다'); },
      submit: async (input) => { seen.push(input); return { ok: true, track: 'tasks', taskId: 'task:abc', deduplicated: false }; },
    });
    expect(seen).toEqual([{ text: '보고서 초안', track: 'tasks', origin: { kind: 'external', ledgerSource: 'telegram-bot', provider: 'telegram', ref: '42:7', reportTo: { channel: 'telegram', chatId: 42 } } }]);
    expect(reply).toContain('task:abc');
    expect(reply).toContain('승인 대기');
  });

  test('graph 는 발신 대화로 reportTo 를 askHarness 까지 전한다', async () => {
    const seen: unknown[] = [];
    const reply = await handleTelegramWork(['graph', '만들어줘'], MSG, {
      askHarness: async (text, reportTo) => { seen.push({ text, reportTo }); return { acceptanceId: 'h-1' }; },
      log: () => {},
    });
    expect(reply).toBe('🛠 하니스 접수 h-1');
    expect(seen).toEqual([{ text: '만들어줘', reportTo: { channel: 'telegram', chatId: 42 } }]);
  });

  test('자동 판정 갈래에서도 원점은 그대로 전달된다', async () => {
    const seen: unknown[] = [];
    await handleTelegramWork(['구현해줘'], MSG, {
      route: async (input) => {
        seen.push(input.origin);
        return { decision: { track: 'graph' } as never, submitted: { ok: true, track: 'graph', acceptanceId: 'h-3' } };
      },
    });
    expect(seen).toEqual([{ kind: 'external', ledgerSource: 'telegram-bot', provider: 'telegram', ref: '42:7', reportTo: { channel: 'telegram', chatId: 42 } }]);
  });

  test('봇과 스레드가 주어지면 원점에만 붙이고 ref 는 유지한다', async () => {
    const seen: unknown[] = [];
    await handleTelegramWork(['graph', 'x'], { ...MSG, botId: 'bot-1', threadId: 3 }, {
      submit: async (input) => { seen.push(input.origin); return { ok: true, track: 'graph', acceptanceId: 'h-2' }; },
    });
    expect(seen).toEqual([{ kind: 'external', ledgerSource: 'telegram-bot', provider: 'telegram', ref: '42:7', reportTo: { channel: 'telegram', chatId: 42, botId: 'bot-1', threadId: 3 } }]);
  });

  test('판정이 못 고르면 실행 0 · 갈래 셋을 묻는다', async () => {
    let submitted = 0;
    const reply = await handleTelegramWork(['이거', '어떻게'], MSG, {
      route: async () => ({ decision: { track: 'ask-human' } as never, askHuman: ['absorb', 'tasks', 'graph'] }),
      submit: async () => { submitted += 1; return { ok: true, track: 'graph', acceptanceId: 'x' }; },
    });
    expect(submitted).toBe(0);
    expect(reply).toContain('/work absorb');
    expect(reply).toContain('/work graph');
  });

  test('판정 결과를 그 대화 문구로 · 실패는 한 줄', async () => {
    const ok = await handleTelegramWork(['https://example.com/a'], MSG, {
      route: async () => ({ decision: { track: 'absorb' } as never, submitted: { ok: true, track: 'absorb', ids: ['i1'], added: 1, merged: 0 } }),
    });
    expect(ok).toContain('흡수');
    const bad = await handleTelegramWork(['graph', 'x'], MSG, {
      submit: async () => ({ ok: false, track: 'graph', reason: 'no-acceptance-id\n스택' }),
    });
    expect(bad).toBe('❌ 하니스에 넣지 못했습니다 — no-acceptance-id');
  });
});
