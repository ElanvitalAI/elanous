// 대표 2026-09-23 — openrouter 비전은 «카탈로그 폴드의 vision 사실»로만 판정한다(이름 패턴 없음).
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isVisionCapableModel } from '../src/llm-vision-capability';
import { isLikelyVisionModel } from '../src/llm';
import { reloadCatalog } from '../src/registry/loader';

const meta = { source: 'auto-openrouter-api', lastSeen: 'x', autoFilled: true, confidence: 'high' };
const dm = (id: string, vision: string | null) => ({ id, provider: 'openrouter', partial: { id, provider: 'openrouter', ...(vision === undefined ? {} : { vision }) }, discoveryMeta: meta });
const saved = process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT;
afterAll(() => {
  if (saved === undefined) delete process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT; else process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT = saved;
  reloadCatalog();
});

describe('isVisionCapableModel(openrouter)', () => {
  test('⛔ 카탈로그에 없으면 «모른다» → 보내지 않는다', () => {
    delete process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT;
    reloadCatalog();
    expect(isVisionCapableModel('openrouter', 'openrouter/moonshotai/kimi-k3', 'userMessage')).toBe(false);
  });

  test('카탈로그 사실대로 — images 면 true · text-only(null) 면 false · toolResult 는 늘 false', () => {
    const dir = mkdtempSync(join(tmpdir(), 'or-vision-'));
    const path = join(dir, 's.json');
    writeFileSync(path, JSON.stringify({ version: 1, generatedAt: 'x', sources: [], models: [dm('moonshotai/kimi-k3', 'images'), dm('z-ai/glm-5.3', null)] }));
    process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT = path;
    reloadCatalog();
    expect(isVisionCapableModel('openrouter', 'openrouter/moonshotai/kimi-k3', 'userMessage')).toBe(true);
    expect(isVisionCapableModel('openrouter', 'openrouter/z-ai/glm-5.3', 'userMessage')).toBe(false);
    expect(isVisionCapableModel('openrouter', 'openrouter/moonshotai/kimi-k3', 'toolResult')).toBe(false);
  });
});

describe('isLikelyVisionModel(openrouter/…)', () => {
  test('⛔ 카탈로그·내장 표 어디에도 없으면 «모른다» → false · 내장 표(VISION-CATALOG-BUILTIN 11-25)의 주력 계열은 true', () => {
    delete process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT;
    reloadCatalog();
    expect(isLikelyVisionModel('openrouter/moonshotai/kimi-k3')).toBe(false);
    expect(isLikelyVisionModel('openrouter/google/gemini-3-pro')).toBe(true);
    expect(isLikelyVisionModel('openrouter/anthropic/claude-opus-4-6')).toBe(true);
  });

  test('카탈로그 사실대로 — images 면 true · text-only(null) 면 false', () => {
    const dir = mkdtempSync(join(tmpdir(), 'or-likely-vision-'));
    const path = join(dir, 's.json');
    writeFileSync(path, JSON.stringify({ version: 1, generatedAt: 'x', sources: [], models: [dm('moonshotai/kimi-k3', 'images'), dm('z-ai/glm-5.3', null)] }));
    process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT = path;
    reloadCatalog();
    expect(isLikelyVisionModel('openrouter/moonshotai/kimi-k3')).toBe(true);
    expect(isLikelyVisionModel('openrouter/z-ai/glm-5.3')).toBe(false);
  });

  test('isVisionCapableModel(openrouter, …, userMessage) 과 «같은» 판정이다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'or-same-rule-'));
    const path = join(dir, 's.json');
    writeFileSync(path, JSON.stringify({ version: 1, generatedAt: 'x', sources: [], models: [dm('qwen/qwen3.8-max-0902', 'images'), dm('moonshotai/kimi-k3', null)] }));
    process.env.ELANOUS_CATALOG_DISCOVERY_SNAPSHOT = path;
    reloadCatalog();
    for (const id of ['openrouter/qwen/qwen3.8-max-0902', 'openrouter/moonshotai/kimi-k3', 'openrouter/not-in-catalog/x']) {
      expect(isLikelyVisionModel(id)).toBe(isVisionCapableModel('openrouter', id, 'userMessage'));
    }
  });
});
