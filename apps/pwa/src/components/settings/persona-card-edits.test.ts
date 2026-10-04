import { describe, expect, test } from 'bun:test';
import type { PersonaWireEntry } from '@/nexus/client';
import { changedPersonaEdits, personaDraft } from './persona-card-edits';

const persona: PersonaWireEntry = {
  personaId: 'mira',
  displayName: '미라',
  description: '기존 설명',
  systemPrompt: '첫째 줄\n둘째 줄',
};

describe('PersonaCard edit payload', () => {
  test('prepopulates every field from the server and leaves untouched fields out of PATCH', () => {
    const draft = personaDraft(persona);
    expect(draft).toEqual({ displayName: '미라', description: '기존 설명', systemPrompt: '첫째 줄\n둘째 줄' });
    expect(changedPersonaEdits(persona, draft)).toEqual({});
    expect(changedPersonaEdits(persona, { ...draft, displayName: '새 이름' })).toEqual({ displayName: '새 이름' });
  });

  test('sends multiline prompt and description clears without dropping another edit', () => {
    expect(changedPersonaEdits(persona, {
      displayName: '미라', description: '', systemPrompt: '새 첫째 줄\n새 둘째 줄',
    })).toEqual({ description: '', systemPrompt: '새 첫째 줄\n새 둘째 줄' });
  });

  test('missing optional fields are prefilled with empty strings and do not become edits', () => {
    const draft = personaDraft({ personaId: 'new', displayName: 'New' });
    expect(draft).toEqual({ displayName: 'New', description: '', systemPrompt: '' });
    expect(changedPersonaEdits({ personaId: 'new', displayName: 'New' }, draft)).toEqual({});
  });
});
