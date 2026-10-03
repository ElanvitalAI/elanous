// M1-1 (PLAN-friction-free-model-selection-ux-2026-05-12 · Phase 1) —
// UserConfig sparse parse for `modelTier` / `budget` / `smartDefaults`.
//
// Each sub-tree is optional — when the user hasn't set anything we want
// the field absent from UserConfig (not `{}`) so resolvers in
// `src/model-tier/` fall through to zero-config defaults without first
// having to detect "is this empty?".

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildUserConfig, saveUserConfig } from '../src/user-config.js';
import { resolveSttTier } from '../src/model-tier/tier-resolver.js';
import { debug } from '../src/debug/log.js';

let root: string;
let cfgPath: string;

function writeFile(json: unknown): void {
  writeFileSync(cfgPath, JSON.stringify(json));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'm1-1-model-tier-'));
  cfgPath = join(root, 'config.json');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('M1-1 · UserConfig.modelTier sparse parse', () => {
  test('absent → undefined (not empty object)', () => {
    writeFile({ llm: { provider: 'anthropic' } });
    const cfg = buildUserConfig(cfgPath);
    expect(cfg.modelTier).toBeUndefined();
    expect(cfg.budget).toBeUndefined();
    expect(cfg.smartDefaults).toBeUndefined();
  });

  test('empty modelTier object → still undefined (no leaf fields)', () => {
    writeFile({ modelTier: {} });
    const cfg = buildUserConfig(cfgPath);
    expect(cfg.modelTier).toBeUndefined();
  });

  test('legacy key alone resolves identically, logs one deprecation and saves only profile', () => {
    const logs: Array<{ category: string; event: string; data: unknown }> = [];
    const originalLog = debug.log;
    debug.log = ((category: string, event: string, data: unknown) => {
      if (category === 'config' && event === 'deprecated-key') logs.push({ category, event, data });
    }) as typeof debug.log;
    try {
      writeFile({ modelTier: { persona: 'power' } });
      const cfg = buildUserConfig(cfgPath);
      expect(cfg.modelTier).toEqual({ profile: 'power' });
      expect(resolveSttTier(cfg.modelTier)).toMatchObject({ tier: 'balanced', source: 'profile' });
      expect(logs).toEqual([{ category: 'config', event: 'deprecated-key', data: {
        from: 'modelTier.persona', to: 'modelTier.profile',
      } }]);
      saveUserConfig(cfg, cfgPath);
      expect(logs).toHaveLength(1);
      const saved = JSON.parse(readFileSync(cfgPath, 'utf8')) as { modelTier: Record<string, unknown> };
      expect(saved.modelTier).toEqual({ profile: 'power' });
    } finally {
      debug.log = originalLog;
    }
  });

  test('new profile wins when both keys exist, without a deprecation warning', () => {
    writeFile({ modelTier: { persona: 'power', profile: 'custom' } });
    const cfg = buildUserConfig(cfgPath);
    expect(cfg.modelTier).toEqual({ profile: 'custom' });
    expect(resolveSttTier(cfg.modelTier).source).toBe('profile');
  });

  test('new profile parses, invalid profile does not fall back to legacy', () => {
    writeFile({ modelTier: { profile: 'casual' } });
    expect(buildUserConfig(cfgPath).modelTier).toEqual({ profile: 'casual' });
    writeFile({ modelTier: { profile: 'ultra', persona: 'power' } });
    expect(buildUserConfig(cfgPath).modelTier).toBeUndefined();
  });

  test('voice.stt = "best" parses · sibling fields stay sparse', () => {
    writeFile({ modelTier: { voice: { stt: 'best' } } });
    const cfg = buildUserConfig(cfgPath);
    expect(cfg.modelTier?.voice?.stt).toBe('best');
    expect(cfg.modelTier?.voice?.tts).toBeUndefined();
  });

  test('invalid tier value → field dropped', () => {
    writeFile({ modelTier: { voice: { stt: 'turbo' }, llm: 42 } });
    const cfg = buildUserConfig(cfgPath);
    // voice.stt was the only voice field — dropped value → voice itself sparse.
    expect(cfg.modelTier?.voice).toBeUndefined();
    expect(cfg.modelTier?.llm).toBeUndefined();
  });

  test('invalid legacy profile value → field dropped', () => {
    writeFile({ modelTier: { persona: 'ultra' } });
    const cfg = buildUserConfig(cfgPath);
    expect(cfg.modelTier).toBeUndefined();
  });

  test('preset trimmed · empty string dropped', () => {
    writeFile({ modelTier: { preset: '  medical_dictation  ' } });
    const cfg = buildUserConfig(cfgPath);
    expect(cfg.modelTier?.preset).toBe('medical_dictation');

    writeFile({ modelTier: { preset: '   ' } });
    const cfg2 = buildUserConfig(cfgPath);
    expect(cfg2.modelTier).toBeUndefined();
  });

  test('all five surface fields parse independently', () => {
    writeFile({
      modelTier: {
        voice: { stt: 'loaded', tts: 'best' },
        llm: 'better',
        embedding: 'balanced',
        vision: 'best',
      },
    });
    const cfg = buildUserConfig(cfgPath);
    expect(cfg.modelTier?.voice?.stt).toBe('loaded');
    expect(cfg.modelTier?.voice?.tts).toBe('best');
    expect(cfg.modelTier?.llm).toBe('better');
    expect(cfg.modelTier?.embedding).toBe('balanced');
    expect(cfg.modelTier?.vision).toBe('best');
  });

  test('malformed root (string/array) → undefined', () => {
    writeFile({ modelTier: 'not-an-object' });
    const cfg = buildUserConfig(cfgPath);
    expect(cfg.modelTier).toBeUndefined();

    writeFile({ modelTier: ['a', 'b'] });
    const cfg2 = buildUserConfig(cfgPath);
    expect(cfg2.modelTier).toBeUndefined();
  });
});

describe('M1-1 · UserConfig.budget sparse parse', () => {
  test('monthlyUsdCap parses · fallbackTier defaults to undefined', () => {
    writeFile({ budget: { monthlyUsdCap: 50 } });
    const cfg = buildUserConfig(cfgPath);
    expect(cfg.budget?.monthlyUsdCap).toBe(50);
    expect(cfg.budget?.fallbackTier).toBeUndefined();
  });

  test('negative cap → field dropped', () => {
    writeFile({ budget: { monthlyUsdCap: -5 } });
    const cfg = buildUserConfig(cfgPath);
    expect(cfg.budget).toBeUndefined();
  });

  test('out-of-range notifyAtPct → field dropped', () => {
    writeFile({ budget: { notifyAtPct: 150 } });
    const cfg = buildUserConfig(cfgPath);
    expect(cfg.budget).toBeUndefined();
  });

  test('fallbackTier validates against ModelTier', () => {
    writeFile({ budget: { monthlyUsdCap: 10, fallbackTier: 'budget' } });
    const cfg = buildUserConfig(cfgPath);
    expect(cfg.budget?.fallbackTier).toBe('budget');

    writeFile({ budget: { monthlyUsdCap: 10, fallbackTier: 'ultra' } });
    const cfg2 = buildUserConfig(cfgPath);
    expect(cfg2.budget?.fallbackTier).toBeUndefined();
    expect(cfg2.budget?.monthlyUsdCap).toBe(10);
  });
});

describe('M1-1 · UserConfig.smartDefaults sparse parse', () => {
  test('autoSuggest boolean parses', () => {
    writeFile({ smartDefaults: { autoSuggest: false } });
    const cfg = buildUserConfig(cfgPath);
    expect(cfg.smartDefaults?.autoSuggest).toBe(false);
  });

  test('non-boolean values dropped', () => {
    writeFile({ smartDefaults: { autoSuggest: 'yes', suppressPatternHints: 1 } });
    const cfg = buildUserConfig(cfgPath);
    expect(cfg.smartDefaults).toBeUndefined();
  });
});
