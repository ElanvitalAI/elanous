// OP-LONG-SESSION-COMPACT (O4) — allow-list remote windows (OP decision #90602). Literal expectations; the catalog is the
// real one (resolveModelContextWindow) or a fixture (remoteContextWindow).
import { describe, expect, test } from 'bun:test';
import { resolveModelContextWindow } from './context-window.js';
import { remoteContextWindow } from './remote-context-window.js';

describe('resolveModelContextWindow — the live seat models (11-18 unknown 21,807 in 24h)', () => {
  test('vendor-routed and bare-shape cloud ids get their window', () => {
    // 출처: #38648 — src/intelligence-map/model-catalog.ts gpt-6-luna contextWindow
    expect(resolveModelContextWindow('openai/gpt-6-luna')).toBe(1_050_000);
    // 출처: #38648 — catalog glm cloud entries (glm-5.1 200_000 · glm-5 202_000 · glm-4.x 200_000) → smallest
    for (const id of ['z-ai/glm-5.3', 'openrouter/z-ai/glm-5.3', 'glm-5.3']) expect(resolveModelContextWindow(id)).toBe(200_000);
    // 출처: #38648 — catalog qwen cloud entries smallest (qwen3.6-flash 256_000)
    expect(resolveModelContextWindow('qwen/qwen3.8-max-0902')).toBe(256_000);
  });
});

describe('resolveModelContextWindow — everything not on the allow list is local (JUD #38648 probes, rounds 1–3)', () => {
  const LOCAL = [
    'qwen3:8b', 'qwen2.5:7b', 'glm4:9b', 'ollama/qwen3:4b', 'deepseek-r1:7b', 'ollama/glm-5.3-Q4_K_M', 'lmstudio/glm-5.3',
    'acme/glmorph-9', 'mlx-community/Qwen3-8B-4bit', 'mlx-community/GLM-4-Z1-9B', 'lmstudio-community/glm-5.3-GGUF',
    'qwen/qwen3-8b', 'z-ai/glm-5.3-Q4_K_M', 'deepseek-r1', 'deepseek-coder-v2-lite-instruct', 'qwen3', 'qwen2.5-coder',
    'glm4', 'acme/zeta-9',
  ];
  test('none of them takes a cloud window', () => {
    for (const id of LOCAL) expect([id, resolveModelContextWindow(id)]).toEqual([id, null]);
  });

  test('a catalog id keeps its own catalog window (exact match first)', () => {
    // 출처: #38648 — catalog glm-z1:9b (local) contextWindow
    expect(resolveModelContextWindow('glm-z1:9b')).toBe(32_000);
    expect(resolveModelContextWindow('glm-5.1')).toBe(200_000);
  });
});

describe('remoteContextWindow (fixture catalog)', () => {
  const catalog = [
    { id: 'glm-5.1', provider: 'glm', family: 'glm', contextWindow: 200_000 },
    { id: 'glm-5', provider: 'glm', family: 'glm', contextWindow: 202_000 },
    { id: 'glm-z1:9b', provider: 'ollama', family: 'glm', contextWindow: 32_000, local: true },
  ];
  test('the smallest CLOUD window of the provider; local entries never count', () => {
    expect(remoteContextWindow('z-ai/glm-9', catalog)).toEqual({ provider: 'glm', contextWindow: 200_000, via: 'vendor' });
    expect(remoteContextWindow('glm-9', catalog)).toEqual({ provider: 'glm', contextWindow: 200_000, via: 'bare-shape' });
  });
  test('a vendor with no cloud catalog entry is not resolved', () => {
    expect(remoteContextWindow('qwen/qwen9-max', catalog)).toBeNull();
  });
});
