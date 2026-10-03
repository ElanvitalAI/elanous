// M1-5 (PLAN-friction-free-model-selection-ux-2026-05-12 · Phase 1) —
// `elanous setup` Voice & AI step. Drives the wizard through the three
// modes (smart / preset / customize) with scriptedIO so the test
// stays deterministic and offline.

import { describe, expect, test } from 'bun:test';
import { askVoiceAI } from '../../src/onboarding/voice-ai.js';
import { scriptedIO } from '../../src/onboarding.js';

describe('M1-5 · askVoiceAI · smart defaults (recommended)', () => {
  test('mode=1 → empty answer (Balanced default preserved)', async () => {
    const io = scriptedIO(['1']);
    const answer = await askVoiceAI(io);
    expect(answer.modelTier).toBeUndefined();
    expect(answer.budget).toBeUndefined();
    // Header copy surfaces in outputs.
    const log = io.outputs.join('\n');
    expect(log).toContain('Smart defaults active');
  });
});

describe('M1-5 · askVoiceAI · preset (Phase 2 placeholder)', () => {
  test('mode=2 → profile=power tag · phase 2 notice printed', async () => {
    const io = scriptedIO(['2']);
    const answer = await askVoiceAI(io);
    expect(answer.modelTier).toEqual({ profile: 'power' });
    expect(answer.budget).toBeUndefined();
    const log = io.outputs.join('\n');
    expect(log).toContain('Preset catalog ships in Phase 2');
  });
});

describe('M1-5 · askVoiceAI · customize per surface', () => {
  test('mode=3 + Best tier + skip cap → modelTier=power custom · no budget', async () => {
    // Inputs: [mode, tier, capPrompt]
    const io = scriptedIO(['3', '4', '']);
    const answer = await askVoiceAI(io);
    expect(answer.modelTier).toEqual({
      profile: 'custom',
      voice: { stt: 'best' },
    });
    expect(answer.budget).toBeUndefined();
    const log = io.outputs.join('\n');
    expect(log).toContain('STT tier = Best');
    expect(log).not.toContain('cap $');
  });

  test('mode=3 + Loaded tier + cap=25 → modelTier + budget', async () => {
    const io = scriptedIO(['3', '5', '25']);
    const answer = await askVoiceAI(io);
    expect(answer.modelTier?.voice?.stt).toBe('loaded');
    expect(answer.modelTier?.profile).toBe('custom');
    expect(answer.budget).toEqual({ monthlyUsdCap: 25 });
  });

  test('mode=3 + Budget tier + negative cap → cap dropped with warning', async () => {
    const io = scriptedIO(['3', '1', '-10']);
    const answer = await askVoiceAI(io);
    expect(answer.modelTier?.voice?.stt).toBe('budget');
    expect(answer.budget).toBeUndefined();
    const log = io.outputs.join('\n');
    expect(log).toContain("isn't a non-negative number");
  });

  test('mode=3 + balanced + blank cap → cap omitted', async () => {
    const io = scriptedIO(['3', '2', '']);
    const answer = await askVoiceAI(io);
    expect(answer.modelTier?.voice?.stt).toBe('balanced');
    expect(answer.budget).toBeUndefined();
  });
});

describe('M1-5 · askVoiceAI · output surface', () => {
  test('header + every tier label printed in customize mode', async () => {
    const io = scriptedIO(['3', '2', '']);
    await askVoiceAI(io);
    const log = io.outputs.join('\n');
    expect(log).toContain('Voice & AI behavior');
    for (const label of ['Budget', 'Balanced', 'Better', 'Best', 'Loaded']) {
      expect(log).toContain(label);
    }
  });

  test('mode picker always shows the 3 modes', async () => {
    const io = scriptedIO(['1']);
    await askVoiceAI(io);
    const log = io.outputs.join('\n');
    expect(log).toContain('Smart defaults (recommended)');
    expect(log).toContain('Pick a preset (Phase 2)');
    expect(log).toContain('Customize per surface');
  });
});
