// ── M4 (Phase 4 Bundle 3) — voice-brain-lend tests ──

import { describe, expect, test } from 'bun:test';
import {
  createVoiceBrainHandlers,
  bindVoiceBrainMethods,
  VoiceBrainDeniedError,
  VOICE_BRAIN_RPC_METHODS,
} from '../../src/voice/voice-brain-lend';
import { createCapabilityGrantStore } from '../../src/conductor/capability-grant-store';

function defaultDeps(overrides = {}) {
  return {
    serverName: 'elanous',
    serverVersion: '1.0.0',
    speak: async (s: string) => ({ ok: true, durationMs: s.length * 10 }),
    listen: async () => ({ transcript: 'hello', confidence: 0.9, ok: true }),
    reason: async (input: { question: string }) => ({
      answer: `reasoning: ${input.question}`,
      ok: true,
    }),
    ...overrides,
  };
}

describe('METHODS namespace', () => {
  test('uses acp/voice-brain prefix', () => {
    expect(VOICE_BRAIN_RPC_METHODS.speak).toBe('acp/voice-brain.speak');
    expect(VOICE_BRAIN_RPC_METHODS.ask).toBe('acp/voice-brain.ask');
  });
});

describe('speak', () => {
  test('happy path', async () => {
    let spoken = '';
    const h = createVoiceBrainHandlers(defaultDeps({
      speak: async (s: string) => { spoken = s; return { ok: true, durationMs: 100 }; },
    }));
    const r = await h.speak({ clientId: 'codex', sentence: 'hello world' });
    expect(r.ok).toBe(true);
    expect(r.durationMs).toBe(100);
    expect(spoken).toBe('hello world');
  });

  test('TTS throws → ok=false', async () => {
    const h = createVoiceBrainHandlers(defaultDeps({
      speak: async () => { throw new Error('dead'); },
    }));
    expect((await h.speak({ clientId: 'c', sentence: 'x' })).ok).toBe(false);
  });
});

describe('listen', () => {
  test('passes budget to provider', async () => {
    let receivedBudget = 0;
    const h = createVoiceBrainHandlers(defaultDeps({
      listen: async (opts: { budgetMs: number }) => {
        receivedBudget = opts.budgetMs;
        return { transcript: 't', ok: true };
      },
    }));
    await h.listen({ clientId: 'c', budgetMs: 5000 });
    expect(receivedBudget).toBe(5000);
  });

  test('default budget 10000ms', async () => {
    let receivedBudget = 0;
    const h = createVoiceBrainHandlers(defaultDeps({
      listen: async (opts: { budgetMs: number }) => {
        receivedBudget = opts.budgetMs;
        return { transcript: '', ok: true };
      },
    }));
    await h.listen({ clientId: 'c' });
    expect(receivedBudget).toBe(10000);
  });
});

describe('ask — non-HITL', () => {
  test('reason + speak', async () => {
    let spoken = '';
    const h = createVoiceBrainHandlers(defaultDeps({
      speak: async (s: string) => { spoken = s; return { ok: true }; },
    }));
    const r = await h.ask({ clientId: 'codex', question: 'why?' });
    expect(r.ok).toBe(true);
    expect(r.answer).toBe('reasoning: why?');
    expect(spoken).toBe('reasoning: why?');
  });

  test('reasoning fail → ok=false', async () => {
    const h = createVoiceBrainHandlers(defaultDeps({
      reason: async () => ({ answer: '', ok: false }),
    }));
    expect((await h.ask({ clientId: 'c', question: 'q' })).ok).toBe(false);
  });
});

describe('ask — HITL', () => {
  test('hitl=true uses hitlEscalate', async () => {
    let escalated = false;
    const h = createVoiceBrainHandlers(defaultDeps({
      hitlEscalate: async (input: { question: string }) => {
        escalated = true;
        return { decision: input.question.includes('reasoning') ? 'apply' : 'reject' };
      },
    }));
    const r = await h.ask({ clientId: 'c', question: 'q', hitl: true });
    expect(r.ok).toBe(true);
    expect(r.hitlDecision).toBe('apply');
    expect(escalated).toBe(true);
  });

  test('hitl=true but no escalator → falls back to non-HITL speak', async () => {
    let spoken = false;
    const h = createVoiceBrainHandlers(defaultDeps({
      speak: async () => { spoken = true; return { ok: true }; },
    }));
    const r = await h.ask({ clientId: 'c', question: 'q', hitl: true });
    expect(r.ok).toBe(true);
    expect(r.hitlDecision).toBeUndefined();
    expect(spoken).toBe(true);
  });
});

describe('grantStore policy', () => {
  test('expired grant is denied with an explicit reason', async () => {
    let now = 1000;
    const store = createCapabilityGrantStore({ now: () => new Date(now) });
    store.grant({ persona: 'codex', action: 'speak' as never, grantedAt: new Date(now).toISOString(), expiresAt: new Date(2000).toISOString() });
    now = 3000;
    const h = createVoiceBrainHandlers(defaultDeps({ grantStore: store }));
    await expect(h.speak({ clientId: 'codex', sentence: 'x' })).rejects.toThrow('expired');
  });

  test('without store → all clients allowed', async () => {
    const h = createVoiceBrainHandlers(defaultDeps());
    expect((await h.speak({ clientId: 'unknown', sentence: 'x' })).ok).toBe(true);
  });

  test('with store + no grant → throws', async () => {
    const store = createCapabilityGrantStore();
    const h = createVoiceBrainHandlers(defaultDeps({ grantStore: store }));
    await expect(h.speak({ clientId: 'codex', sentence: 'x' })).rejects.toBeInstanceOf(VoiceBrainDeniedError);
  });

  test('with store + grant → allowed', async () => {
    const store = createCapabilityGrantStore();
    store.grant({
      persona: 'codex',
      action: 'speak' as never,
      grantedAt: new Date().toISOString(),
    });
    const h = createVoiceBrainHandlers(defaultDeps({ grantStore: store }));
    expect((await h.speak({ clientId: 'codex', sentence: 'x' })).ok).toBe(true);
  });
});

describe('capabilities', () => {
  test('returns server descriptor', async () => {
    const h = createVoiceBrainHandlers(defaultDeps());
    const cap = await h.capabilities();
    expect(cap.serverName).toBe('elanous');
    expect(cap.serverVersion).toBe('1.0.0');
    expect(cap.supportedActions).toContain('speak');
  });

  test('default actions overridable', async () => {
    const h = createVoiceBrainHandlers(defaultDeps({
      defaultCapabilities: {
        supportedActions: ['speak'],
        providers: { tts: ['openai', 'elevenlabs'] },
      },
    }));
    const cap = await h.capabilities();
    expect(cap.supportedActions).toEqual(['speak']);
    expect(cap.providers.tts).toEqual(['openai', 'elevenlabs']);
  });
});

describe('bindVoiceBrainMethods', () => {
  test('returns method map', async () => {
    const h = createVoiceBrainHandlers(defaultDeps());
    const map = bindVoiceBrainMethods(h);
    expect(typeof map['acp/voice-brain.speak']).toBe('function');
    expect(typeof map['acp/voice-brain.capabilities']).toBe('function');
    const cap = await map['acp/voice-brain.capabilities']!({}) as { serverName: string };
    expect(cap.serverName).toBe('elanous');
  });
});
