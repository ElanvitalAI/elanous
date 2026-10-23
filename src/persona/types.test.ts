import { describe, expect, test } from 'bun:test';
import type { PersonaProfile } from './types.js';

describe('PersonaProfile browser residence', () => {
  test('keeps browserPort on the persona profile rather than a separate entity', () => {
    const profile: PersonaProfile = {
      personaId: 'remote',
      displayName: 'Remote',
      browserPort: 9333,
    };

    expect(profile.browserPort).toBe(9333);
  });
});

describe('PersonaProfile speechStyle', () => {
  test('keeps the declared speech style on the persona profile', () => {
    const profile: PersonaProfile = {
      personaId: 'mira',
      displayName: 'Mira',
      speechStyle: '짧고 단정하게 — 결론 먼저',
    };

    expect(profile.speechStyle).toBe('짧고 단정하게 — 결론 먼저');
  });
});
