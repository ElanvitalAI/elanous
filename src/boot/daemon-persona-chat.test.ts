import { expect, test } from 'bun:test';
import { composeDaemonSystemPrompt, personaPromptForChat, prependChatPersonaOnLaterTurn, withChatPersonaPrompt } from './daemon-runtime.js';
import { parseDaemonPromptBody } from './daemon-prompt-request.js';
import type { PersonaProfile } from '../persona/types.js';

test('PWA persona id resolves through persona address and prepends only the selected prompt', async () => {
  const profile = { personaId: 'mira', displayName: '미라', systemPrompt: '페르소나 앞머리' } as PersonaProfile;
  let loads = 0;
  const deps = {
    load: async () => { loads++; },
    registry: () => ({ list: () => [profile], get: (id: string) => id === 'mira' ? profile : undefined }),
  };
  expect(await personaPromptForChat(undefined, deps)).toBeUndefined();
  expect(loads).toBe(0);
  expect(await personaPromptForChat('미라', deps)).toBe('페르소나 앞머리');
  expect(await personaPromptForChat('unknown', deps)).toBeUndefined();
  expect(loads).toBe(2);
  expect(await withChatPersonaPrompt('페르소나 앞머리', async () => {
    await Promise.resolve();
    return composeDaemonSystemPrompt('기본 시스템', undefined, 's');
  })).toStartWith('페르소나 앞머리\n\n기본 시스템');
  expect(withChatPersonaPrompt('페르소나 앞머리', () => prependChatPersonaOnLaterTurn([
    { role: 'user', content: '두번째 질문' },
  ], false))).toEqual([
    { role: 'system', content: '페르소나 앞머리' },
    { role: 'user', content: '두번째 질문' },
  ]);
  expect(withChatPersonaPrompt('페르소나 앞머리', () => prependChatPersonaOnLaterTurn([
    { role: 'system', content: '페르소나 앞머리\n\n기본 시스템' }, { role: 'user', content: '첫 질문' },
  ], true))).toHaveLength(2);
  expect(prependChatPersonaOnLaterTurn([{ role: 'user', content: '기본 질문' }], false))
    .toEqual([{ role: 'user', content: '기본 질문' }]);
  expect(composeDaemonSystemPrompt('기본 시스템', undefined, 's')).toStartWith('기본 시스템');
  expect(parseDaemonPromptBody({ userText: '질문', personaId: 'mira' }, '기본 시스템'))
    .toMatchObject({ ok: true, value: { personaId: 'mira', userText: '질문' } });
  const unchanged = parseDaemonPromptBody({ userText: '질문' }, '기본 시스템');
  expect(unchanged).toMatchObject({ ok: true, value: { userText: '질문' } });
  expect(unchanged.ok && Object.hasOwn(unchanged.value, 'personaId')).toBe(false);
});
