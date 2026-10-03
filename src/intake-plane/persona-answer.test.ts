import { expect, spyOn, test } from 'bun:test';
import { debug } from '../debug/log.js';
import type { PersonaSource } from '../persona/mention-parser.js';
import type { PersonaProfile } from '../persona/types.js';
import { answerAsPersona, resolvePersonaAddress } from './persona-answer.js';

const sage: PersonaProfile = { personaId: 'sage', displayName: 'Sage', systemPrompt: '차분하고 간결하게 답하라.', mentionPatterns: ['@현자'] };
const names: PersonaProfile[] = [sage, { personaId: 'other', displayName: 'Alias' }, { personaId: 'alias', displayName: 'Else' }];
const source: PersonaSource = {
  list: () => names,
  get: (id) => names.find((p) => p.personaId === id),
};

test('personaId, mentionPatterns, then case-insensitive displayName; no match returns null', () => {
  expect(resolvePersonaAddress('sage', source)).toBe(sage);
  expect(resolvePersonaAddress('현자', source)).toBe(sage);
  expect(resolvePersonaAddress('SaGe', source)).toBe(sage);
  expect(resolvePersonaAddress('aLiAs', source)?.personaId).toBe('alias');
  expect(resolvePersonaAddress('nobody', source)).toBeNull();
});

test('persona system prompt heads the question, output starts with displayName and records answered without private content', async () => {
  let prompt = '';
  const events: unknown[] = [];
  const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: unknown) => {
    if (category === 'persona.address') events.push({ category, event, data });
  }) as typeof debug.log);
  try {
    const result = await answerAsPersona(sage, 'private-question', { complete: async (p) => { prompt = p; return '  조언입니다.  '; } });
    expect(prompt.startsWith(`${sage.systemPrompt}\n`)).toBe(true);
    expect(prompt).toContain('private-question');
    expect(result).toBe('@Sage\n조언입니다.');
    expect(events).toEqual([{ category: 'persona.address', event: 'answered', data: { personaId: 'sage', chars: Array.from(result).length } }]);
    expect(JSON.stringify(events)).not.toContain('private-question');
  } finally { log.mockRestore(); }
});

test('missing system prompt uses the display name and answer cuts at 3500 code points', async () => {
  let prompt = '';
  const answer = await answerAsPersona({ personaId: 'nari', displayName: 'Nari' }, '질문', {
    complete: async (p) => { prompt = p; return `${'가'.repeat(3_493)}🎉끝`; },
  });
  expect(prompt.startsWith('너는 Nari 이다\n')).toBe(true);
  expect(prompt).toContain('질문');
  expect(Array.from(answer)).toHaveLength(3_500);
  expect(answer.endsWith('🎉')).toBe(true);
  expect(answer).not.toContain('끝');
});
