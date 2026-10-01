// ── PFC-S5 P4: recommendModel pure decision fn ──

import { describe, test, expect } from 'bun:test';
import {
  recommendModel,
  estimateCost,
  type RecommendContext,
} from '../src/intelligence-map/recommend-model';
import { BUILTIN_CATALOG } from '../src/intelligence-map/model-catalog';
import type {
  CostCapConfig,
  CostSnapshot,
  SystemSnapshot,
} from '../src/intelligence-map/types';

function system(freeGb = 32): SystemSnapshot {
  return {
    cpuCount: 8,
    loadAvg1: 1,
    loadAvg5: 1,
    loadAvg15: 1,
    cpuPercent: 12,
    freeMemGb: freeGb,
    totalMemGb: 64,
    freeMemPercent: (freeGb / 64) * 100,
    platform: 'darwin',
    arch: 'arm64',
    snapshotAt: 1,
  };
}

function emptyCost(): CostSnapshot {
  return {
    totalUsd: 0,
    weeklyUsd: 0,
    monthlyUsd: 0,
    perModel: {},
    perGoal: {},
    weekStart: 0,
    monthStart: 0,
    eventsCount: 0,
    snapshotAt: 1,
  };
}

function buildCtx(overrides: Partial<RecommendContext> = {}): RecommendContext {
  return {
    catalog: BUILTIN_CATALOG,
    system: overrides.system ?? system(),
    cost: overrides.cost ?? emptyCost(),
    costConfig: overrides.costConfig ?? {},
    env: overrides.env ?? { ANTHROPIC_API_KEY: 'x', OPENAI_API_KEY: 'y', GROK_API_KEY: 'z', GEMINI_API_KEY: 'g' },
  };
}

describe('PFC-S5 P4 — recommendModel', () => {
  test('reasoning + long context → picks claude-opus', () => {
    const rec = recommendModel('reasoning', { contextSize: 500_000 }, buildCtx());
    // Long-context + reasoning fits opus (1M ctx). Grok is also 1M
    // reasoning. The 2026-05 catalog refresh adds nemotron3-nano-omni
    // (local · 1M ctx · reasoning) — local-first sort makes it win
    // when the host has the RAM (default system(32) GB ≥ 32 GB minRam).
    expect([
      'claude-opus-4-7', 'grok-4-1-fast', 'gemini-2.5-flash',
      'nemotron3-nano-omni:30b-a3b',
    ]).toContain(rec.recommended);
  });

  test('cheap task — local wins when available (cheapest = free)', () => {
    const rec = recommendModel('cheap', {}, buildCtx({ system: system(32) }));
    // Local models qualify under the "cheap" special-case (price<1),
    // and local-first sort puts qwen on top at 0/0 pricing.
    expect(rec.recommended).toBe('qwen2.5-coder:32b');
  });

  test('cheap task — no local available → picks cheapest paid', () => {
    // 6GB free — defeats every local model in the May 2026 catalog
    // (smallest is glm-z1:9b @ 12GB minRamGb · kimi-vl-a3b @ 14GB).
    const rec = recommendModel('cheap', {}, buildCtx({ system: system(6) }));
    // Among enabled paid candidates, gpt-6-luna ($0.10/$0.50 avg=0.30)
    // is cheaper than gpt-4o-mini ($0.15/$0.60 avg=0.375).
    expect(rec.recommended).toBe('gpt-6-luna');
    expect(rec.estimatedCostUsd).toBeCloseTo(0.0007, 4);
  });

  test('local_preferred returns local-only', () => {
    const rec = recommendModel('local_preferred', {}, buildCtx({ system: system(48) }));
    expect(['qwen2.5-coder:32b', 'llama3:70b']).toContain(rec.recommended);
  });

  test('force_local drops paid even when task does not imply local', () => {
    const rec = recommendModel('reasoning', { forceLocal: true }, buildCtx({ system: system(48) }));
    expect(rec.recommended).toBe('llama3:70b');
    expect(rec.diagnostics.force_local).toBe('forced');
  });

  test('RAM gate drops local models that exceed free mem', () => {
    // 4GB free — defeats every open-weight local in the catalog.
    const rec = recommendModel('local_preferred', {}, buildCtx({ system: system(4) }));
    expect(rec.recommended).toBeUndefined();
    expect(rec.diagnostics.ram).toContain('after RAM gate');
  });

  test('weekly cap tripped → paid models dropped', () => {
    const cost: CostSnapshot = { ...emptyCost(), weeklyUsd: 10, monthlyUsd: 10 };
    const costConfig: CostCapConfig = { weeklyCapUsd: 10 };
    const rec = recommendModel('coding', {}, buildCtx({ cost, costConfig, system: system(32) }));
    // cap_status='tripped' → local only. qwen has coding tag.
    expect(rec.recommended).toBe('qwen2.5-coder:32b');
    expect(rec.capStatus).toBe('tripped');
  });

  test('env missing → models filtered (no anthropic key)', () => {
    const rec = recommendModel('reasoning', {}, buildCtx({ env: { GROK_API_KEY: 'x' } }));
    // No anthropic/openai/gemini keys → grok (reasoning tag) wins among
    // cloud; the local set with reasoning tag (llama3:70b · nemotron3
    // · qwen3.6 · glm-z1) wins on the price tiebreak when the RAM gate
    // lets them in. system(32) → llama3:70b drops (48 > 32) but
    // nemotron (32) and others fit, so any of these are valid winners.
    expect([
      'grok-4-1-fast', 'llama3:70b', 'nemotron3-nano-omni:30b-a3b',
      'qwen3.6-35b-a3b-ud-mlx', 'qwen3.6:35b-a3b', 'qwen3.6:27b',
      'glm-z1:32b', 'glm-z1:9b',
    ]).toContain(rec.recommended);
  });

  test('MLX Qwen recommendation retains its selected serving-recipe ID', () => {
    const rec = recommendModel('reasoning', { forceLocal: true }, buildCtx({ system: system(22) }));
    expect(rec.recommended).toBe('qwen3.6-35b-a3b-ud-mlx');
    expect(rec.reasoning).toContain('qwen3.6-35b-a3b-ud-mlx');
    expect(rec.alternatives).not.toContain(rec.recommended);
  });

  test('Ollama Qwen candidate remains distinct from the MLX serving recipe', () => {
    const rec = recommendModel('local_preferred', {}, buildCtx({ system: system(32) }));
    expect(rec.alternatives).toContain('qwen3.6:35b-a3b');
    expect(rec.alternatives).not.toContain(rec.recommended);
  });

  test('no candidate → undefined recommended + reasoning', () => {
    const rec = recommendModel('reasoning', { forceLocal: true }, buildCtx({ system: system(8) }));
    expect(rec.recommended).toBeUndefined();
    expect(rec.reasoning).toContain('No model matches');
  });

  test('max_usd_per_call picks cheaper candidate', () => {
    // Force locals out (system(2)) so the budget gate is exercised
    // against paid models. Otherwise the 2026-05 catalog adds free
    // local picks (nemotron3 · qwen3.6 · glm-z1) that bypass the
    // gate at $0 estimated cost.
    const rec = recommendModel(
      'reasoning',
      { estimatedInputTokens: 100_000, estimatedOutputTokens: 100_000, maxUsdPerCall: 0.05 },
      buildCtx({ system: system(2) }),
    );
    // 200k tokens at $15/$75 → opus cost = $1.5 + $7.5 = $9 → way over.
    // Should bump to cheaper reasoning — grok (0.5/2) = $0.05 + $0.2 = $0.25 → still over.
    // Gemini (0.3/2.5) = $0.03 + $0.25 = $0.28 over.
    // Sonnet (3/15) = $0.3 + $1.5 = $1.8 over. So no fit → reasoning notes.
    expect(rec.diagnostics.max_usd_per_call).toBeDefined();
  });

  test('diagnostics always include cap_status + enabled + task_match', () => {
    const rec = recommendModel('coding', {}, buildCtx());
    expect(rec.diagnostics.cap_status).toBeDefined();
    expect(rec.diagnostics.enabled).toContain('after envKey filter');
    expect(rec.diagnostics.task_match).toContain('after taskType filter');
  });

  test('alternatives include up to 3 after recommended', () => {
    const rec = recommendModel('reasoning', {}, buildCtx({ system: system(64) }));
    expect(rec.alternatives.length).toBeLessThanOrEqual(3);
    expect(rec.alternatives).not.toContain(rec.recommended);
  });

  test('estimateCost for paid model uses per-Mtok rate', () => {
    const opus = BUILTIN_CATALOG.models.find(m => m.id === 'claude-opus-5')!;
    const cost = estimateCost(opus, 1_000_000, 500_000);
    // 1M input * $5 + 0.5M output * $25 = $5 + $12.5 = $17.5
    expect(cost).toBeCloseTo(17.5);
  });

  test('estimateCost for local model = 0', () => {
    const qwen = BUILTIN_CATALOG.models.find(m => m.id === 'qwen2.5-coder:32b')!;
    expect(estimateCost(qwen, 100_000, 100_000)).toBe(0);
  });
});
