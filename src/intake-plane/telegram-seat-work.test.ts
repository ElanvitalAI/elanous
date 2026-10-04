import { describe, expect, spyOn, test } from 'bun:test';
import { debug } from '../debug/log.js';
import { handleTelegramSeatWork } from './telegram-seat-work.js';
import { TelegramBot } from '../telegram.js';
import type { UserConfig } from '../user-config.js';
import type { PersonaProfile } from '../persona/types.js';
import type { PersonaSource } from '../persona/mention-parser.js';

const MSG = { chatId: -123, messageId: 456 };
const OWNER = { chatId: 111, userId: 111, messageId: 456 };
const config = { raw: { decisions: { telegramOwnerId: 111 } }, telegram: { allowedUsers: [111] } } as unknown as UserConfig;
const sage: PersonaProfile = { personaId: 'sage', displayName: 'Sage', systemPrompt: '차분히 답하라.', mentionPatterns: ['@mentor'] };
const personaProfiles: PersonaProfile[] = [sage, { personaId: 'cmo', displayName: 'CMO Persona' }, { personaId: 'mira', displayName: 'Mira' }];
const personaSource: PersonaSource = { list: () => personaProfiles, get: (id) => personaProfiles.find((p) => p.personaId === id) };

describe('Telegram persona address', () => {
  test('owner private @sage and mentionPatterns use the persona prompt, not seat intake or dispatch', async () => {
    const prompts: string[] = [];
    const deps = { config, personaSource,
      personaAnswerDeps: { complete: async (prompt: string) => { prompts.push(prompt); return '조언입니다.'; } },
      submit: async () => { throw Error('should not submit'); },
      answer: async () => { throw Error('should not answer seat'); },
      dispatch: async () => { throw Error('should not dispatch'); },
    } as never;
    expect(await handleTelegramSeatWork('@sage 오늘 할 일', OWNER, deps)).toBe('@Sage\n조언입니다.');
    expect(prompts[0]?.startsWith('차분히 답하라.\n')).toBe(true);
    expect(prompts[0]).toContain('오늘 할 일');
    expect(await handleTelegramSeatWork('@mentor 조언', OWNER, deps)).toBe('@Sage\n조언입니다.');
    expect(await handleTelegramSeatWork('@mIrA 조언', OWNER, deps)).toBe('@Mira\n조언입니다.');
    expect(prompts).toHaveLength(3);
  });

  test('seat title and colliding personaId still take seat answer path, never persona completion', async () => {
    const seats: unknown[] = [];
    let personaCalls = 0;
    const deps = { config, personaSource,
      personaAnswer: async () => { personaCalls++; return 'persona'; },
      answer: async (seat: string) => { seats.push(seat); return { title: 'CMO', text: '자리 답' }; },
      submit: async () => { throw Error('should not submit'); },
    } as never;
    expect(await handleTelegramSeatWork('@cmo 오늘 진행 상황?', OWNER, deps)).toBe('자리 답');
    expect(await handleTelegramSeatWork('@MK 오늘 진행 상황?', OWNER, deps)).toBe('자리 답');
    expect(seats).toEqual(['cmo', 'MK']);
    expect(personaCalls).toBe(0);
  });

  test('mixed and multiple personas reject without answering, dispatching, or intake, with a reason-only event', async () => {
    const events: unknown[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: unknown) => {
      if (category === 'persona.address') events.push({ event, data });
    }) as typeof debug.log);
    const deps = { config, personaSource,
      personaAnswer: async () => { throw Error('should not answer'); },
      answer: async () => { throw Error('should not answer seat'); },
      dispatch: async () => { throw Error('should not dispatch'); },
      submit: async () => { throw Error('should not submit'); },
    } as never;
    try {
      expect(await handleTelegramSeatWork('@sage,@cmo private-question', OWNER, deps)).toBe('페르소나는 한 번에 하나만 부를 수 있습니다');
      expect(await handleTelegramSeatWork('@sage,@mira private-question', OWNER, deps)).toBe('페르소나는 한 번에 하나만 부를 수 있습니다');
      expect(events).toEqual([{ event: 'rejected', data: { reason: 'mixed' } }, { event: 'rejected', data: { reason: 'mixed' } }]);
      expect(JSON.stringify(events)).not.toContain('private-question');
    } finally { log.mockRestore(); }
  });

  test('non-owner and unknown names keep the original seat clarification; only owner persona resolution is observed', async () => {
    const events: unknown[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: unknown) => {
      if (category === 'persona.address') events.push({ event, data });
    }) as typeof debug.log);
    const deps = { config, personaSource,
      personaAnswer: async () => '@Sage\n답',
      submit: async () => { throw Error('should not submit'); },
    } as never;
    const rejected = '어느 좌석을 말씀하시나요? @sage은(는) 등록된 좌석이 아닙니다. 좌석을 확인해 다시 보내 주세요.';
    try {
      expect(await handleTelegramSeatWork('@sage 질문', { ...OWNER, userId: 222, chatId: 222 }, deps)).toBe(rejected);
      expect(await handleTelegramSeatWork('@sage 질문', { ...OWNER, chatId: -123 }, deps)).toBe(rejected);
      expect(await handleTelegramSeatWork('@nobody 질문', OWNER, deps)).toBe(rejected.replace('@sage', '@nobody'));
      expect(await handleTelegramSeatWork('@sage 질문', OWNER, deps)).toBe('@Sage\n답');
      expect(events).toEqual([{ event: 'resolved', data: { name: 'sage', personaId: 'sage' } }]);
    } finally { log.mockRestore(); }
  });
});

describe('Telegram persona seat alias', () => {
  const seated: PersonaProfile = { ...sage, seat: 'MK' };
  const typo: PersonaProfile = { personaId: 'typo', displayName: 'Typo', seat: 'CFO' };
  const profiles = [seated, typo, ...personaProfiles.slice(1)];
  const source: PersonaSource = { list: () => profiles, get: (id) => profiles.find((p) => p.personaId === id) };

  test('owner task and question follow @MK exactly, never the persona completion', async () => {
    const dispatched: unknown[] = []; const answered: unknown[] = []; const events: unknown[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: unknown) => {
      if (category === 'persona.address' && event === 'seat-alias') events.push(data);
    }) as typeof debug.log);
    const deps = { config, personaSource: source,
      personaAnswer: async () => { throw Error('should not answer persona'); },
      dispatch: async (seat: string, body: string, _deps: unknown, extra: unknown) => {
        dispatched.push([seat, body, extra]); return { reply: '받음', channel: 'posted' as const };
      },
      answer: async (seat: string, body: string) => { answered.push([seat, body]); return { title: 'CMO', text: '자리 답' }; },
      submit: async () => { throw Error('should not submit'); },
    } as never;
    try {
      expect(await handleTelegramSeatWork('@sage 내일 일정 정리해 줘', OWNER, deps)).toBe('받음');
      expect(await handleTelegramSeatWork('@MK 내일 일정 정리해 줘', OWNER, deps)).toBe('받음');
      expect(dispatched).toEqual(Array(2).fill(['MK', '내일 일정 정리해 줘', { via: 'telegram' }]));
      expect(await handleTelegramSeatWork('@sage 오늘 할 일?', OWNER, deps)).toBe('자리 답');
      expect(await handleTelegramSeatWork('@MK 오늘 할 일?', OWNER, deps)).toBe('자리 답');
      expect(answered).toEqual([['MK', '오늘 할 일?'], ['MK', '오늘 할 일?']]);
      expect(events).toEqual(Array(2).fill({ name: 'sage', personaId: 'sage', seat: 'MK', via: 'telegram' }));
    } finally { log.mockRestore(); }
  });

  test('owner mixed alias and seat submit both seats; one alias falls back to intake on no answer', async () => {
    const inputs: unknown[] = [];
    const deps = { config, personaSource: source,
      personaAnswer: async () => { throw Error('should not answer persona'); },
      dispatch: async () => { throw Error('should not dispatch'); },
      answer: async () => null,
      submit: async (input: { text: string }) => { inputs.push(input.text); return { ok: true as const, track: 'graph' as const, acceptanceId: `R-${inputs.length}` }; },
    } as never;
    expect(await handleTelegramSeatWork('@sage,@OP 정리해 줘', OWNER, deps)).toBe('@CMO 접수번호: R-1\n@COO 접수번호: R-2');
    expect(inputs).toEqual(['@CMO 정리해 줘', '@COO 정리해 줘']);
    expect(await handleTelegramSeatWork('@sage 오늘 할 일?', OWNER, deps)).toBe('@CMO 접수번호: R-3');
    expect(inputs).toEqual(['@CMO 정리해 줘', '@COO 정리해 줘', '@CMO 오늘 할 일?']);
  });

  test('no seat and unresolved seat retain persona voice; non-owner alias is rejected without persona lookup', async () => {
    const calls: string[] = []; const events: unknown[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: unknown) => {
      if (category === 'persona.address' && event === 'seat-alias') events.push(data);
    }) as typeof debug.log);
    const deps = { config, personaSource: source,
      personaAnswer: async (persona: PersonaProfile) => { calls.push(persona.personaId); return `@${persona.displayName} 답`; },
      dispatch: async () => { throw Error('should not dispatch'); },
      answer: async () => { throw Error('should not answer seat'); },
      submit: async () => { throw Error('should not submit'); },
    } as never;
    try {
      expect(await handleTelegramSeatWork('@mira 질문', OWNER, deps)).toBe('@Mira 답');
      expect(await handleTelegramSeatWork('@typo 질문', OWNER, deps)).toBe('@Typo 답');
      const forbiddenSource: PersonaSource = { list: () => { throw Error('should not list personas'); },
        get: () => { throw Error('should not look up persona'); } };
      const outsider = { config, personaSource: forbiddenSource,
        personaAnswer: async () => { throw Error('should not answer persona'); },
        submit: async () => { throw Error('should not submit'); } } as never;
      expect(await handleTelegramSeatWork('@sage 질문', { ...OWNER, userId: 222, chatId: 222 }, outsider))
        .toBe('어느 좌석을 말씀하시나요? @sage은(는) 등록된 좌석이 아닙니다. 좌석을 확인해 다시 보내 주세요.');
      expect(await handleTelegramSeatWork('@sage 질문', { ...OWNER, chatId: -123 }, outsider))
        .toBe('어느 좌석을 말씀하시나요? @sage은(는) 등록된 좌석이 아닙니다. 좌석을 확인해 다시 보내 주세요.');
      expect(calls).toEqual(['mira', 'typo']);
      expect(events).toEqual([]);
    } finally { log.mockRestore(); }
  });
});

describe('Telegram owner intent', () => {
  test('question answers once; empty answer falls back to one graph intake', async () => {
    const answers: unknown[] = []; const dispatched: unknown[] = []; const submitted: unknown[] = [];
    const deps = {
      config: config as UserConfig,
      answer: async (...args: unknown[]) => { answers.push(args); return { title: 'COO', text: '진행 중입니다.' }; },
      dispatch: async (...args: unknown[]) => { dispatched.push(args); return { reply: '받음', channel: 'posted' as const }; },
      submit: async (input: unknown) => { submitted.push(input); return { ok: true as const, track: 'graph' as const, acceptanceId: 'R-1' }; },
    };
    expect(await handleTelegramSeatWork('@COO 오늘 행사 준비 어디까지야?', OWNER, deps as never)).toBe('진행 중입니다.');
    expect(answers).toEqual([[ 'COO', '오늘 행사 준비 어디까지야?' ]]);
    expect(dispatched).toHaveLength(0); expect(submitted).toHaveLength(0);
    expect(await handleTelegramSeatWork('@COO 오늘 행사 준비 어디까지야?', OWNER, { ...deps, answer: async () => null } as never)).toBe('@COO 접수번호: R-1');
    expect(submitted).toHaveLength(1);
  });

  test('task dispatches canonical seat via telegram and returns its reply', async () => {
    const calls: unknown[] = [];
    const reply = await handleTelegramSeatWork('@CTO 결제 화면 오타 고쳐 줘', OWNER, {
      config,
      dispatch: async (seat, text, _deps, extra) => { calls.push([seat, text, extra]); return { reply: '받음 — TC에 전했습니다.', channel: 'posted' }; },
      submit: async () => { throw Error('should not submit'); },
      answer: async () => { throw Error('should not answer'); },
    });
    expect(reply).toBe('받음 — TC에 전했습니다.');
    expect(calls).toEqual([['TC', '결제 화면 오타 고쳐 줘', { via: 'telegram' }]]);
  });

  test('real C2 dispatch writes one CEO message and one coordination line without intake', async () => {
    const messages: unknown[] = []; const lines: string[] = [];
    const reply = await handleTelegramSeatWork('@CTO 결제 화면 오타 고쳐 줘', OWNER, {
      config, commandDeps: { ownerId: '111', replyTarget: 'acme/repo#42', append: (message) => { messages.push(message); },
        runGh: async (_args, stdin) => { lines.push(stdin); return 0; }, now: () => new Date('2026-10-02T03:30:00Z') },
      submit: async () => { throw Error('should not submit'); },
    });
    expect(reply).toBe('받음 — TC에 전했습니다.');
    expect(messages).toEqual([{ from: 'CEO', to: 'TC', kind: 'ceo-task', body: '결제 화면 오타 고쳐 줘' }]);
    expect(lines).toEqual(['**[대표]** 2026-10-02 12:30 KST → TC · 결제 화면 오타 고쳐 줘']);
  });

  test('intent observation exposes only seat, intent, via and outcome', async () => {
    const events: unknown[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: unknown) => {
      if (category === 'seat.dispatch' && event === 'intent') events.push(data);
    }) as typeof debug.log);
    try {
      expect(await handleTelegramSeatWork('@COO private-request-body 알려줘', OWNER, {
        config, answer: async () => ({ title: 'COO', text: '답' }),
      })).toBe('답');
      expect(events).toEqual([{ seat: 'OP', intent: 'question', via: 'telegram', outcome: 'answered' }]);
      expect(JSON.stringify(events)).not.toContain('private-request-body');
    } finally { log.mockRestore(); }
  });

  test('group, non-owner, and multiple seats retain graph intake', async () => {
    const inputs: unknown[] = [];
    const deps = { config, submit: async (input: unknown) => { inputs.push(input); return { ok: true as const, track: 'graph' as const, acceptanceId: 'R-1' }; },
      dispatch: async () => { throw Error('should not dispatch'); }, answer: async () => { throw Error('should not answer'); } } as never;
    expect(await handleTelegramSeatWork('@CTO 고쳐 줘', { ...OWNER, chatId: -123 }, deps)).toContain('접수번호');
    expect(await handleTelegramSeatWork('@CTO 고쳐 줘', { ...OWNER, chatId: 222, userId: 222 }, deps)).toContain('접수번호');
    expect(await handleTelegramSeatWork('@COO,CMO 정리해 줘', OWNER, deps)).toContain('접수번호');
    expect(inputs).toHaveLength(4);
  });

  test('unaddressed task only dispatches with defaultSeat enabled; questions and commands remain chat', async () => {
    const calls: unknown[] = [];
    const deps = { config, dispatch: async (seat: string, text: string) => { calls.push([seat, text]); return { reply: '받음 — OP에 전했습니다.', channel: 'posted' as const }; } };
    expect(await handleTelegramSeatWork('내일 일정 정리해 줘', OWNER, deps)).toBeNull();
    const enabled = { ...deps, config: { ...config, raw: { ...config.raw, seatDispatch: { defaultSeat: 'COO' } } } } as never;
    expect(await handleTelegramSeatWork('내일 일정 정리해 줘', OWNER, enabled)).toBe('받음 — OP에 전했습니다.');
    expect(calls).toEqual([['OP', '내일 일정 정리해 줘']]);
    expect(await handleTelegramSeatWork('오늘 일정 어디까지야?', OWNER, enabled)).toBeNull();
    expect(await handleTelegramSeatWork('/cto 고쳐 줘', OWNER, enabled)).toBeNull();
    expect(await handleTelegramSeatWork('  @CTO 고쳐 줘', OWNER, enabled)).toBeNull();
    expect(await handleTelegramSeatWork('내일 일정 정리해 줘', { ...OWNER, chatId: -123 }, enabled)).toBeNull();
  });
});

describe('Telegram addressed seat work', () => {
  test('leaves unaddressed messages untouched without submitting', async () => {
    let calls = 0;
    const reply = await handleTelegramSeatWork('일반 대화 중 @cmo 언급', MSG, {
      submit: async () => { calls++; return { ok: true, track: 'graph', acceptanceId: 'R-1' }; },
    });
    expect(reply).toBeNull();
    expect(calls).toBe(0);
    expect(await handleTelegramSeatWork('일반 대화\n@cmo 전략 수립', MSG, {
      submit: async () => { calls++; return { ok: true, track: 'graph', acceptanceId: 'R-1' }; },
    })).toBeNull();
    expect(calls).toBe(0);
  });

  test('resolves seats and submits each once with Telegram origin and reportTo', async () => {
    const inputs: unknown[] = [];
    const reply = await handleTelegramSeatWork('@cmo,cTo 10-28 마케팅 전략 한 장', { ...MSG, threadId: 789, botId: '123' }, {
      submit: async (input) => {
        inputs.push(input);
        return { ok: true, track: 'graph', acceptanceId: `R-${inputs.length}` };
      },
    });
    expect(inputs).toEqual(['CMO', 'CTO'].map((label) => ({
      text: `@${label} 10-28 마케팅 전략 한 장`, track: 'graph',
      origin: { kind: 'external', ledgerSource: 'telegram-bot', provider: 'telegram', ref: 'telegram:-123:456',
        reportTo: { channel: 'telegram', chatId: -123, botId: '123', threadId: 789 } },
    })));
    expect(reply).toBe('@CMO 접수번호: R-1\n@CTO 접수번호: R-2');
  });

  test('actual intake forwards the originating Telegram conversation to the harness', async () => {
    const received: unknown[] = [];
    const reply = await handleTelegramSeatWork('@mk 구현해 줘', MSG, {
      askHarness: async (text, reportTo) => {
        received.push({ text, reportTo });
        return { acceptanceId: 'R-77' };
      }, log: () => {},
    });
    expect(received).toEqual([{ text: '@CMO 구현해 줘', reportTo: { channel: 'telegram', chatId: -123 } }]);
    expect(reply).toBe('@CMO 접수번호: R-77');
  });

  test('unknown seat rejects all seats with one clarification and no submissions', async () => {
    let calls = 0;
    const reply = await handleTelegramSeatWork('@cmo,cfo 작성해', MSG, {
      submit: async () => { calls++; return { ok: true, track: 'graph', acceptanceId: 'R-1' }; },
    });
    expect(reply).toContain('@cfo');
    expect(reply).toContain('좌석을 확인해 다시 보내');
    expect(reply?.split('\n')).toHaveLength(1);
    expect(calls).toBe(0);
  });

  test('empty body asks for work without submitting', async () => {
    let calls = 0;
    const reply = await handleTelegramSeatWork('@cmo  ', MSG, {
      submit: async () => { calls++; return { ok: true, track: 'graph', acceptanceId: 'R-1' }; },
    });
    expect(reply).toContain('요청 내용을 적어');
    expect(calls).toBe(0);
  });

  test('failed intake never claims an acceptance number', async () => {
    const reply = await handleTelegramSeatWork('@cmo 실행해', MSG, {
      submit: async () => ({ ok: false, track: 'graph', reason: 'no-acceptance-id\ninternal trace' }),
    });
    expect(reply).toBe('@CMO 접수 실패 — no-acceptance-id');
  });

  test('seat observations contain names and reason, never the request body', async () => {
    const observed: Array<{ category: string; event: string; data: unknown }> = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: unknown) => {
      if (category === 'seat-address.telegram') observed.push({ category, event, data });
    }) as typeof debug.log);
    try {
      await handleTelegramSeatWork('@cmo private-request-body', MSG, {
        submit: async () => ({ ok: true, track: 'graph', acceptanceId: 'R-1' }),
      });
      await handleTelegramSeatWork('@cfo private-request-body', MSG);
      await handleTelegramSeatWork('@cmo ', MSG);
      expect(observed).toEqual([
        { category: 'seat-address.telegram', event: 'parsed', data: { seats: ['cmo'] } },
        { category: 'seat-address.telegram', event: 'enqueued', data: { seats: ['CMO'] } },
        { category: 'seat-address.telegram', event: 'parsed', data: { seats: ['cfo'] } },
        { category: 'seat-address.telegram', event: 'rejected', data: { seats: ['cfo'], reason: 'unknown-seat' } },
        { category: 'seat-address.telegram', event: 'parsed', data: { seats: ['cmo'] } },
        { category: 'seat-address.telegram', event: 'rejected', data: { seats: ['cmo'], reason: 'empty-body' } },
      ]);
      expect(JSON.stringify(observed)).not.toContain('private-request-body');
    } finally {
      log.mockRestore();
    }
  });

  test('gateway sends the owner persona answer back in the same private Telegram chat', async () => {
    const sent: Array<Record<string, unknown>> = [];
    let bot: TelegramBot;
    let polls = 0;
    bot = new TelegramBot({ token: '123:test', allowedUsers: [111], perChatGapMs: 0,
      onMessage: async () => { throw Error('should not enter ordinary chat'); },
      seatWorkDeps: { config, personaSource,
        personaAnswerDeps: { complete: async (prompt) => {
          expect(prompt.startsWith('차분히 답하라.\n')).toBe(true);
          return '조언입니다.';
        } },
        submit: async () => { throw Error('should not submit'); },
      },
      fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
        const method = String(url).split('/').at(-1);
        if (method === 'getUpdates') {
          if (++polls > 1) { bot.stop(); return Response.json({ ok: true, result: [] }); }
          return Response.json({ ok: true, result: [{ update_id: 1,
            message: { message_id: 456, from: { id: 111 }, chat: { id: 111, type: 'private' }, text: '@sage 오늘 할 일' },
          }] });
        }
        if (method === 'sendMessage') sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ ok: true, result: { message_id: 9 } });
      }) as typeof fetch,
    });
    await bot.start();
    expect(sent).toContainEqual({ chat_id: 111, text: '@Sage\n조언입니다.', reply_to_message_id: 456 });
  });

  test('gateway forwards owner identity to seat intent and offers unaddressed DM task only when configured', async () => {
    const sent: string[] = []; const chats: string[] = []; const dispatched: unknown[] = [];
    let bot: TelegramBot; let polls = 0;
    bot = new TelegramBot({ token: '123:test', allowedUsers: [111], perChatGapMs: 0,
      onMessage: async ({ text }) => { chats.push(text); },
      seatWorkDeps: { config: { ...config, raw: { ...config.raw, seatDispatch: { defaultSeat: 'COO' } } },
        dispatch: async (seat, text, _deps, extra) => { dispatched.push([seat, text, extra]); return { reply: '받음 — OP에 전했습니다.', channel: 'posted' }; },
        answer: async () => ({ title: 'COO', text: '진행 중입니다.' }),
        submit: async () => { throw Error('should not submit'); },
      },
      fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
        const method = String(url).split('/').at(-1);
        if (method === 'getUpdates') {
          if (++polls > 1) { bot.stop(); return Response.json({ ok: true, result: [] }); }
          return Response.json({ ok: true, result: [
            { update_id: 1, message: { message_id: 1, from: { id: 111 }, chat: { id: 111, type: 'private' }, text: '@COO 행사 준비 어디까지야?' } },
            { update_id: 2, message: { message_id: 2, from: { id: 111 }, chat: { id: 111, type: 'private' }, text: '내일 일정 정리해 줘' } },
            { update_id: 3, message: { message_id: 3, from: { id: 111 }, chat: { id: 111, type: 'private' }, text: '오늘 일정 어디까지야?' } },
          ] });
        }
        if (method === 'sendMessage') sent.push((JSON.parse(String(init?.body)) as { text: string }).text);
        return Response.json({ ok: true, result: { message_id: 9 } });
      }) as typeof fetch,
    });
    await bot.start();
    expect(dispatched).toEqual([['OP', '내일 일정 정리해 줘', { via: 'telegram' }]]);
    expect(chats).toEqual(['오늘 일정 어디까지야?']);
    expect(sent).toContain('진행 중입니다.'); expect(sent).toContain('받음 — OP에 전했습니다.');
  });

  test('gateway accepts only owner seat messages, replies in the same chat/thread, and preserves ordinary chat', async () => {
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    const inputs: unknown[] = [];
    const chats: string[] = [];
    let polls = 0;
    let bot: TelegramBot;
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const method = String(url).split('/').at(-1)!;
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      calls.push({ method, body });
      if (method === 'getUpdates') {
        if (++polls > 1) { bot.stop(); return Response.json({ ok: true, result: [] }); }
        const message = (id: number, user: number, text: string) => ({
          update_id: id, message: { message_id: id, from: { id: user }, chat: { id: -123, type: 'supergroup' },
            message_thread_id: 789, text },
        });
        return Response.json({ ok: true, result: [
          message(1, 10, '@cmo 10-28 마케팅 전략 한 장'),
          message(2, 10, '@cfo 작성해'),
          message(3, 10, '일반 대화'),
          message(4, 11, '@cmo 작성해'),
        ] });
      }
      return Response.json({ ok: true, result: { message_id: 777 } });
    }) as typeof fetch;
    bot = new TelegramBot({
      token: '123:test', allowedUsers: [10], fetchImpl, perChatGapMs: 0,
      onMessage: async (ctx) => { chats.push(ctx.text); },
      seatWorkDeps: { submit: async (input) => {
        inputs.push(input);
        return { ok: true, track: 'graph', acceptanceId: 'R-42' };
      } },
    });
    await bot.start();
    expect(inputs).toEqual([{ text: '@CMO 10-28 마케팅 전략 한 장', track: 'graph', origin: {
      kind: 'external', ledgerSource: 'telegram-bot', provider: 'telegram', ref: 'telegram:-123:1',
      reportTo: { channel: 'telegram', chatId: -123, botId: '123', threadId: 789 },
    } }]);
    expect(chats).toEqual(['일반 대화']);
    const sent = calls.filter(({ method }) => method === 'sendMessage').map(({ body }) => body);
    expect(sent).toHaveLength(4);
    expect(sent.find((body) => body.reply_to_message_id === 1)).toEqual({ chat_id: -123, text: '@CMO 접수번호: R-42', reply_to_message_id: 1, message_thread_id: 789 });
    const unknownReply = sent.find((body) => body.reply_to_message_id === 2);
    expect(unknownReply?.text).toContain('좌석을 확인해 다시 보내');
    expect(unknownReply).toMatchObject({ chat_id: -123, reply_to_message_id: 2, message_thread_id: 789 });
    expect(sent.find((body) => body.reply_to_message_id === 3)).toEqual({ chat_id: -123, text: '⏳ Working…', reply_to_message_id: 3, message_thread_id: 789 });
    expect(sent.find((body) => body.reply_to_message_id === 4)).toEqual({ chat_id: -123, text: 'This bot is private. Your user ID is not on the allowlist.', reply_to_message_id: 4, message_thread_id: 789 });
  });
});

test('a throwing intake door still answers in the same chat (review must-fix)', async () => {
  const { handleTelegramSeatWork } = await import('./telegram-seat-work.js');
  const reply = await handleTelegramSeatWork('@cmo 10-28 마케팅 전략 한 장', { chatId: 1, messageId: 2 }, {
    submit: async () => { throw new Error('queue offline\nstack'); },
  } as never);
  expect(reply).toBe('@CMO 접수 실패 — queue offline');
});
