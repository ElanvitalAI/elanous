import { describe, expect, spyOn, test } from 'bun:test';
import { debug } from '../debug/log.js';
import { handleDiscordSeatWork } from './discord-seat-work.js';
import { DiscordBot } from '../discord.js';
import type { UserConfig } from '../user-config.js';
import type { PersonaProfile } from '../persona/types.js';
import type { PersonaSource } from '../persona/mention-parser.js';

const MSG = { channelId: '123', messageId: '456' };
const OWNER = { ...MSG, userId: '11111', isDm: true };
const config = { raw: { decisions: { discordOwnerId: '11111' } }, discord: { allowedUsers: ['11111'] } } as unknown as UserConfig;
const sage: PersonaProfile = { personaId: 'sage', displayName: 'Sage', systemPrompt: '차분히 답하라.', mentionPatterns: ['@mentor'] };
const personaProfiles: PersonaProfile[] = [sage, { personaId: 'cmo', displayName: 'CMO Persona' }, { personaId: 'mira', displayName: 'Mira' }];
const personaSource: PersonaSource = { list: () => personaProfiles, get: (id) => personaProfiles.find((p) => p.personaId === id) };

describe('Discord persona address', () => {
  test('owner private @sage and mentionPatterns answer in the persona voice, without seat work', async () => {
    const prompts: string[] = [];
    const deps = { config, personaSource,
      personaAnswerDeps: { complete: async (prompt: string) => { prompts.push(prompt); return '조언입니다.'; } },
      submit: async () => { throw Error('should not submit'); },
      answer: async () => { throw Error('should not answer seat'); },
      dispatch: async () => { throw Error('should not dispatch'); },
    } as never;
    expect(await handleDiscordSeatWork('@sage 오늘 할 일', OWNER, deps)).toBe('@Sage\n조언입니다.');
    expect(prompts[0]?.startsWith('차분히 답하라.\n')).toBe(true);
    expect(prompts[0]).toContain('오늘 할 일');
    expect(await handleDiscordSeatWork('@mentor 조언', OWNER, deps)).toBe('@Sage\n조언입니다.');
    expect(await handleDiscordSeatWork('@mIrA 조언', OWNER, deps)).toBe('@Mira\n조언입니다.');
    expect(prompts).toHaveLength(3);
  });

  test('seat name and colliding personaId take seat answer path, not persona', async () => {
    const seats: string[] = [];
    let personaCalls = 0;
    const deps = { config, personaSource,
      personaAnswer: async () => { personaCalls++; return 'persona'; },
      answer: async (seat: string) => { seats.push(seat); return { title: 'CMO', text: '자리 답' }; },
      submit: async () => { throw Error('should not submit'); },
    } as never;
    expect(await handleDiscordSeatWork('@cmo 오늘 진행 상황?', OWNER, deps)).toBe('자리 답');
    expect(await handleDiscordSeatWork('@MK 오늘 진행 상황?', OWNER, deps)).toBe('자리 답');
    expect(seats).toEqual(['cmo', 'MK']);
    expect(personaCalls).toBe(0);
  });

  test('mixed seat/persona and multiple personas reject without answering or intake', async () => {
    const events: unknown[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: unknown) => {
      if (category === 'persona.address') events.push({ event, data });
    }) as typeof debug.log);
    const deps = { config, personaSource,
      personaAnswer: async () => { throw Error('should not answer persona'); },
      answer: async () => { throw Error('should not answer seat'); },
      dispatch: async () => { throw Error('should not dispatch'); },
      submit: async () => { throw Error('should not submit'); },
    } as never;
    try {
      expect(await handleDiscordSeatWork('@sage,@cmo private-question', OWNER, deps)).toBe('페르소나는 한 번에 하나만 부를 수 있습니다');
      expect(await handleDiscordSeatWork('@sage,@mira private-question', OWNER, deps)).toBe('페르소나는 한 번에 하나만 부를 수 있습니다');
      expect(events).toEqual([
        { event: 'rejected', data: { reason: 'mixed', via: 'discord' } },
        { event: 'rejected', data: { reason: 'mixed', via: 'discord' } },
      ]);
      expect(JSON.stringify(events)).not.toContain('private-question');
    } finally { log.mockRestore(); }
  });

  test('non-owner and unknown addresses retain seat clarification; owner persona events identify discord', async () => {
    const events: unknown[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: unknown) => {
      if (category === 'persona.address') events.push({ event, data });
    }) as typeof debug.log);
    const calls: unknown[] = [];
    const deps = { config, personaSource,
      personaAnswer: async (persona: PersonaProfile, question: string) => { calls.push([persona.personaId, question]); return '@Sage\n답'; },
      submit: async () => { throw Error('should not submit'); },
    } as never;
    const rejected = '어느 좌석을 말씀하시나요? @sage은(는) 등록된 좌석이 아닙니다. 좌석을 확인해 다시 보내 주세요.';
    try {
      expect(await handleDiscordSeatWork('@sage 질문', { ...OWNER, userId: '22222' }, deps)).toBe(rejected);
      expect(await handleDiscordSeatWork('@sage 질문', { ...OWNER, isDm: false }, deps)).toBe(rejected);
      expect(await handleDiscordSeatWork('@nobody 질문', OWNER, deps)).toBe(rejected.replace('@sage', '@nobody'));
      expect(calls).toHaveLength(0);
      expect(await handleDiscordSeatWork('@sage 질문', OWNER, deps)).toBe('@Sage\n답');
      expect(calls).toEqual([['sage', '질문']]);
      expect(events).toEqual([
        { event: 'resolved', data: { name: 'sage', personaId: 'sage', via: 'discord' } },
        { event: 'answered', data: { personaId: 'sage', via: 'discord' } },
      ]);
    } finally { log.mockRestore(); }
  });
});

describe('Discord persona seat alias', () => {
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
      expect(await handleDiscordSeatWork('@sage 내일 일정 정리해 줘', OWNER, deps)).toBe('받음');
      expect(await handleDiscordSeatWork('@MK 내일 일정 정리해 줘', OWNER, deps)).toBe('받음');
      expect(dispatched).toEqual(Array(2).fill(['MK', '내일 일정 정리해 줘', { via: 'discord' }]));
      expect(await handleDiscordSeatWork('@sage 오늘 할 일?', OWNER, deps)).toBe('자리 답');
      expect(await handleDiscordSeatWork('@MK 오늘 할 일?', OWNER, deps)).toBe('자리 답');
      expect(answered).toEqual([['MK', '오늘 할 일?'], ['MK', '오늘 할 일?']]);
      expect(events).toEqual(Array(2).fill({ name: 'sage', personaId: 'sage', seat: 'MK', via: 'discord' }));
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
    expect(await handleDiscordSeatWork('@sage,@OP 정리해 줘', OWNER, deps)).toBe('@CMO 접수번호: R-1\n@COO 접수번호: R-2');
    expect(inputs).toEqual(['@CMO 정리해 줘', '@COO 정리해 줘']);
    expect(await handleDiscordSeatWork('@sage 오늘 할 일?', OWNER, deps)).toBe('@CMO 접수번호: R-3');
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
      expect(await handleDiscordSeatWork('@mira 질문', OWNER, deps)).toBe('@Mira 답');
      expect(await handleDiscordSeatWork('@typo 질문', OWNER, deps)).toBe('@Typo 답');
      const forbiddenSource: PersonaSource = { list: () => { throw Error('should not list personas'); },
        get: () => { throw Error('should not look up persona'); } };
      const outsider = { config, personaSource: forbiddenSource,
        personaAnswer: async () => { throw Error('should not answer persona'); },
        submit: async () => { throw Error('should not submit'); } } as never;
      expect(await handleDiscordSeatWork('@sage 질문', { ...OWNER, userId: '22222' }, outsider))
        .toBe('어느 좌석을 말씀하시나요? @sage은(는) 등록된 좌석이 아닙니다. 좌석을 확인해 다시 보내 주세요.');
      expect(await handleDiscordSeatWork('@sage 질문', { ...OWNER, isDm: false }, outsider))
        .toBe('어느 좌석을 말씀하시나요? @sage은(는) 등록된 좌석이 아닙니다. 좌석을 확인해 다시 보내 주세요.');
      expect(calls).toEqual(['mira', 'typo']);
      expect(events).toEqual([]);
    } finally { log.mockRestore(); }
  });
});

describe('Discord owner intent', () => {
  test('one seat question answers; null answer falls back to intake', async () => {
    const answers: unknown[] = []; const inputs: unknown[] = [];
    const deps = { config,
      answer: async (...args: unknown[]) => { answers.push(args); return { title: 'COO', text: '진행 중입니다.' }; },
      dispatch: async () => { throw Error('should not dispatch'); },
      submit: async (input: unknown) => { inputs.push(input); return { ok: true as const, track: 'graph' as const, acceptanceId: 'R-1' }; },
    };
    expect(await handleDiscordSeatWork('@COO 오늘 행사 준비 어디까지야?', OWNER, deps as never)).toBe('진행 중입니다.');
    expect(answers).toEqual([['COO', '오늘 행사 준비 어디까지야?']]); expect(inputs).toHaveLength(0);
    expect(await handleDiscordSeatWork('@COO 오늘 행사 준비 어디까지야?', OWNER, { ...deps, answer: async () => null } as never)).toBe('@COO 접수번호: R-1');
    expect(inputs).toHaveLength(1);
  });

  test('task sends canonical seat through discord C2 route', async () => {
    const calls: unknown[] = [];
    const reply = await handleDiscordSeatWork('@CTO 결제 화면 오타 고쳐 줘', OWNER, { config,
      dispatch: async (seat, text, _deps, extra) => { calls.push([seat, text, extra]); return { reply: '받음 — TC에 전했습니다.', channel: 'posted' }; },
      submit: async () => { throw Error('should not submit'); },
    });
    expect(reply).toBe('받음 — TC에 전했습니다.');
    expect(calls).toEqual([['TC', '결제 화면 오타 고쳐 줘', { via: 'discord' }]]);
  });

  test('real C2 dispatch writes one CEO message and one channel line', async () => {
    const messages: unknown[] = []; const lines: string[] = [];
    const reply = await handleDiscordSeatWork('@CTO 결제 화면 오타 고쳐 줘', OWNER, { config,
      commandDeps: { ownerId: '11111', replyTarget: 'acme/repo#42', append: (message) => { messages.push(message); },
        runGh: async (_args, stdin) => { lines.push(stdin); return 0; }, now: () => new Date('2026-10-02T03:30:00Z') },
      submit: async () => { throw Error('should not submit'); },
    });
    expect(reply).toBe('받음 — TC에 전했습니다.');
    expect(messages).toEqual([{ from: 'CEO', to: 'TC', kind: 'ceo-task', body: '결제 화면 오타 고쳐 줘' }]);
    expect(lines).toEqual(['**[대표]** 2026-10-02 12:30 KST → TC · 결제 화면 오타 고쳐 줘']);
  });

  test('intent log contains no request body', async () => {
    const events: unknown[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: unknown) => {
      if (category === 'seat.dispatch' && event === 'intent') events.push(data);
    }) as typeof debug.log);
    try {
      expect(await handleDiscordSeatWork('@COO private-request-body 알려줘', OWNER, {
        config, answer: async () => ({ title: 'COO', text: '답' }),
      })).toBe('답');
      expect(events).toEqual([{ seat: 'OP', intent: 'question', via: 'discord', outcome: 'answered' }]);
      expect(JSON.stringify(events)).not.toContain('private-request-body');
    } finally { log.mockRestore(); }
  });

  test('group, non-owner, multiple seats preserve intake', async () => {
    const inputs: unknown[] = [];
    const deps = { config,
      submit: async (input: unknown) => { inputs.push(input); return { ok: true as const, track: 'graph' as const, acceptanceId: 'R-1' }; },
      answer: async () => { throw Error('should not answer'); }, dispatch: async () => { throw Error('should not dispatch'); },
    } as never;
    expect(await handleDiscordSeatWork('@CTO 고쳐 줘', { ...OWNER, isDm: false }, deps)).toContain('접수번호');
    expect(await handleDiscordSeatWork('@CTO 고쳐 줘', { ...OWNER, userId: '22222' }, deps)).toContain('접수번호');
    expect(await handleDiscordSeatWork('@COO,CMO 정리해 줘', OWNER, deps)).toContain('접수번호');
    expect(inputs).toHaveLength(4);
  });

  test('defaultSeat opt-in alone dispatches unaddressed tasks', async () => {
    const calls: unknown[] = [];
    const deps = { config, dispatch: async (seat: string, text: string) => { calls.push([seat, text]); return { reply: '받음 — OP에 전했습니다.', channel: 'posted' as const }; } };
    expect(await handleDiscordSeatWork('내일 일정 정리해 줘', OWNER, deps)).toBeNull();
    const enabled = { ...deps, config: { ...config, raw: { ...config.raw, seatDispatch: { defaultSeat: 'COO' } } } } as never;
    expect(await handleDiscordSeatWork('내일 일정 정리해 줘', OWNER, enabled)).toBe('받음 — OP에 전했습니다.');
    expect(calls).toEqual([['OP', '내일 일정 정리해 줘']]);
    expect(await handleDiscordSeatWork('오늘 일정 어디까지야?', OWNER, enabled)).toBeNull();
    expect(await handleDiscordSeatWork('/coo 고쳐 줘', OWNER, enabled)).toBeNull();
    expect(await handleDiscordSeatWork('  @CTO 고쳐 줘', OWNER, enabled)).toBeNull();
    expect(await handleDiscordSeatWork('내일 일정 정리해 줘', { ...OWNER, isDm: false }, enabled)).toBeNull();
  });
});

describe('Discord addressed seat work', () => {
  test('leaves unaddressed chat messages untouched without submitting', async () => {
    let calls = 0;
    const reply = await handleDiscordSeatWork('일반 대화 중 @cmo 언급', MSG, {
      submit: async () => { calls++; return { ok: true, track: 'graph', acceptanceId: 'R-1' }; },
    });
    expect(reply).toBeNull();
    expect(calls).toBe(0);
  });

  test('resolves title and alias and submits each addressed seat with the Discord origin', async () => {
    const inputs: unknown[] = [];
    const reply = await handleDiscordSeatWork('@t,cTo 이번 주 블로그 초안 만들어', { ...MSG, threadId: '789' }, {
      submit: async (input) => {
        inputs.push(input);
        return { ok: true, track: 'graph', acceptanceId: `R-${inputs.length}` };
      },
    });
    expect(inputs).toEqual([
      {
        text: '@CMO 이번 주 블로그 초안 만들어', track: 'graph',
        origin: { kind: 'external', ledgerSource: 'memo', provider: 'other', ref: 'discord:123:456', reportTo: { channel: 'discord', channelId: '123', discordThreadId: '789' } },
      },
      {
        text: '@CTO 이번 주 블로그 초안 만들어', track: 'graph',
        origin: { kind: 'external', ledgerSource: 'memo', provider: 'other', ref: 'discord:123:456', reportTo: { channel: 'discord', channelId: '123', discordThreadId: '789' } },
      },
    ]);
    expect(reply).toBe('@CMO 접수번호: R-1\n@CTO 접수번호: R-2');
  });

  test('the actual intake door forwards the originating channel to the harness', async () => {
    const received: unknown[] = [];
    const reply = await handleDiscordSeatWork('@mk 구현해 줘', MSG, {
      askHarness: async (text, reportTo) => {
        received.push({ text, reportTo });
        return { acceptanceId: 'R-77' };
      },
      log: () => {},
    });
    expect(received).toEqual([{ text: '@CMO 구현해 줘', reportTo: { channel: 'discord', channelId: '123' } }]);
    expect(reply).toBe('@CMO 접수번호: R-77');
  });

  test('unknown seats ask for clarification; no partial submissions even with valid seats', async () => {
    let calls = 0;
    const reply = await handleDiscordSeatWork('@cmo,cfo 구현해 줘', MSG, {
      submit: async () => { calls++; return { ok: true, track: 'graph', acceptanceId: 'R-1' }; },
    });
    expect(reply).toContain('@cfo');
    expect(reply).toContain('좌석을 확인해 다시 보내');
    expect(calls).toBe(0);
  });

  test('empty request asks for work rather than submitting', async () => {
    let calls = 0;
    const reply = await handleDiscordSeatWork('@cmo  ', MSG, {
      submit: async () => { calls++; return { ok: true, track: 'graph', acceptanceId: 'R-1' }; },
    });
    expect(reply).toContain('요청 내용을 적어');
    expect(calls).toBe(0);
  });

  test('submission failure cannot claim an intake number', async () => {
    const reply = await handleDiscordSeatWork('@cmo 실행해', MSG, {
      submit: async () => ({ ok: false, track: 'graph', reason: 'no-acceptance-id\ninternal trace' }),
    });
    expect(reply).toBe('@CMO 접수 실패 — no-acceptance-id');
  });

  test('gateway returns the owner persona reply in the originating DM without chat or intake', async () => {
    const sent: string[] = [];
    let personaCalls = 0;
    const bot = new DiscordBot({ token: 'tok', allowedUsers: ['11111'],
      onMessage: async () => { throw Error('should not enter ordinary chat'); },
      seatWorkDeps: { config, personaSource,
        personaAnswer: async (persona, question) => {
          personaCalls++;
          expect([persona.personaId, question]).toEqual(['sage', '오늘 할 일']);
          return '@Sage\n조언입니다.';
        },
        submit: async () => { throw Error('should not submit'); },
      },
      fetchImpl: (async (_url: string, init: RequestInit) => {
        if (init.method === 'POST') sent.push((JSON.parse(String(init.body)) as { content: string }).content);
        return { ok: true, status: 200, json: async () => ({ id: 'response' }), text: async () => '' };
      }) as typeof fetch,
    });
    await (bot as unknown as { handleMessageCreate: (m: Record<string, unknown>) => Promise<void> }).handleMessageCreate({
      author: { id: '11111' }, id: '1', channel_id: 'dm-1', content: '@sage 오늘 할 일',
    });
    expect(personaCalls).toBe(1);
    expect(sent).toContain('@Sage\n조언입니다.');
  });

  test('gateway sends owner DM questions and default-seat tasks to seat paths, leaving other chat alone', async () => {
    const sent: string[] = []; const chats: string[] = []; const dispatched: unknown[] = [];
    const bot = new DiscordBot({ token: 'tok', allowedUsers: ['11111'],
      onMessage: async ({ text }) => { chats.push(text); return 'chat'; },
      seatWorkDeps: { config: { ...config, raw: { ...config.raw, seatDispatch: { defaultSeat: 'COO' } } },
        dispatch: async (seat, text, _deps, extra) => { dispatched.push([seat, text, extra]); return { reply: '받음 — OP에 전했습니다.', channel: 'posted' }; },
        answer: async () => ({ title: 'COO', text: '진행 중입니다.' }),
        submit: async () => { throw Error('should not submit'); },
      },
      fetchImpl: (async (_url: string, init: RequestInit) => {
        if (init.method === 'POST') sent.push((JSON.parse(String(init.body)) as { content: string }).content);
        return { ok: true, status: 200, json: async () => ({ id: 'response' }), text: async () => '' };
      }) as typeof fetch,
    });
    const receive = (id: string, content: string) => (bot as unknown as { handleMessageCreate: (m: Record<string, unknown>) => Promise<void> }).handleMessageCreate({
      author: { id: '11111' }, id, channel_id: 'dm-1', content,
    });
    await receive('1', '@COO 행사 준비 어디까지야?');
    await receive('2', '내일 일정 정리해 줘');
    await receive('3', '오늘 일정 어디까지야?');
    expect(dispatched).toEqual([['OP', '내일 일정 정리해 줘', { via: 'discord' }]]);
    expect(chats).toEqual(['오늘 일정 어디까지야?']);
    expect(sent).toContain('진행 중입니다.'); expect(sent).toContain('받음 — OP에 전했습니다.');
  });

  test('allowlisted gateway messages reach the intake door and reply in the originating channel', async () => {
    const posts: Array<{ url: string; content: string }> = [];
    const inputs: unknown[] = [];
    let chats = 0;
    const bot = new DiscordBot({
      token: 'tok', allowedUsers: ['owner'],
      onMessage: async () => { chats++; return 'chat'; },
      seatWorkDeps: {
        submit: async (input) => { inputs.push(input); return { ok: true, track: 'graph', acceptanceId: 'R-42' }; },
      },
      fetchImpl: (async (url: string, init: RequestInit) => {
        if (init.method === 'POST') posts.push({ url, content: JSON.parse(String(init.body)).content });
        return { ok: true, status: 200, json: async () => ({ id: 'response' }), text: async () => '' };
      }) as typeof fetch,
    });
    const receive = (m: Record<string, unknown>) => (bot as unknown as {
      handleMessageCreate: (m: Record<string, unknown>) => Promise<void>;
    }).handleMessageCreate(m);

    await receive({ author: { id: 'owner' }, id: 'm-1', channel_id: 'thread-9', thread_id: 'thread-9', content: '@cmo 작성해' });
    expect(inputs).toEqual([{ text: '@CMO 작성해', track: 'graph', origin: {
      kind: 'external', ledgerSource: 'memo', provider: 'other', ref: 'discord:thread-9:m-1',
      reportTo: { channel: 'discord', channelId: 'thread-9', discordThreadId: 'thread-9' },
    } }]);
    expect(posts).toEqual([{ url: 'https://discord.com/api/v10/channels/thread-9/messages', content: '@CMO 접수번호: R-42' }]);
    expect(chats).toBe(0);

    await receive({ author: { id: 'owner' }, id: 'm-2', channel_id: 'thread-9', content: '@unknown 작성해' });
    expect(inputs).toHaveLength(1);
    expect(posts[1]?.content).toContain('좌석을 확인해 다시 보내');
    expect(chats).toBe(0);

    await receive({ author: { id: 'owner' }, id: 'm-3', channel_id: 'thread-9', content: '일반 대화' });
    expect(inputs).toHaveLength(1);
    expect(chats).toBe(1);
    expect(posts[2]?.content).toBe('⏳ Working…');

    await receive({ author: { id: 'stranger' }, id: 'm-4', channel_id: 'thread-9', content: '@cmo 작성해' });
    expect(inputs).toHaveLength(1);
    expect(chats).toBe(1);
    expect(posts[3]?.content).toContain('not on the allowlist');
  });
});
