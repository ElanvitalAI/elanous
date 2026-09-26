import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetElanousConfigDir, setElanousConfigDir } from '../../elanous-config-dir';
import { getUserConfig, resetUserConfig, saveUserConfig } from '../../user-config';
import { DASHBOARD_PROVIDER_SETUP_OPTIONS } from '../../dashboard/setup-inline';
import { handleChildLlmGet, handleChildLlmSet } from './setup-child-llm';

let root: string;
const originalXdg = process.env.XDG_CONFIG_HOME;

const post = (body: unknown) => new Request('http://localhost/v1/setup/child-llm', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const disk = () => JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')) as {
  obsidian?: { vault?: string };
  tools?: { selfImplement?: { childLlm?: unknown } };
  harness?: { budgetGate?: { onShortfall?: string; minHeadroomPercent?: number } };
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'elanous-child-llm-'));
  delete process.env.XDG_CONFIG_HOME;
  setElanousConfigDir(root);
  resetUserConfig();
  writeFileSync(join(root, 'config.json'), '{}');
});

afterEach(() => {
  resetElanousConfigDir();
  resetUserConfig();
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  rmSync(root, { recursive: true, force: true });
});

describe('setup child-llm', () => {
  test('카드 저장은 budgetGate 의 모르는 칸(maxUsedPercent)을 지우지 않는다', async () => {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ harness: { budgetGate: { maxUsedPercent: { grok: 30 } } } }));
    resetUserConfig();
    const res = await handleChildLlmSet(post({ budgetGate: { minHeadroomPercent: 20, onShortfall: 'wait-reset' } }));
    expect(res.status).toBe(200);
    const gate = (disk().harness?.budgetGate ?? {}) as { maxUsedPercent?: Record<string, number>; onShortfall?: string; minHeadroomPercent?: number };
    expect(gate.maxUsedPercent).toEqual({ grok: 30 });
    expect(gate.onShortfall).toBe('wait-reset');
    expect(gate.minHeadroomPercent).toBe(20);
  });

  test('POST auto + grok·openai-codex 순서는 200 이고 GET resolved.chain 순서가 같다', async () => {
    const chain = [{ provider: 'grok' }, { provider: 'openai-codex' }];
    const res = await handleChildLlmSet(post({ mode: 'auto', chain }));
    expect(res.status).toBe(200);
    const saved = await res.json() as { resolved: { mode: string; chain: Array<{ provider: string }> } };
    expect(saved.resolved.mode).toBe('auto');
    expect(saved.resolved.chain.map((entry) => entry.provider)).toEqual(['grok', 'openai-codex']);

    const got = await handleChildLlmGet().json() as {
      resolved: { chain: Array<{ provider: string }> };
      providers: string[];
    };
    expect(got.resolved.chain.map((entry) => entry.provider)).toEqual(['grok', 'openai-codex']);
    expect(got.providers).toEqual(DASHBOARD_PROVIDER_SETUP_OPTIONS.map((option) => option.provider));
  });

  test('onShortfall bogus 는 400 이고 설정은 호출 전과 같다', async () => {
    const before = readFileSync(join(root, 'config.json'), 'utf8');
    const res = await handleChildLlmSet(post({ budgetGate: { onShortfall: 'bogus' } }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; reason: string };
    expect(body.error).toBe('invalid-budget-gate');
    expect(body.reason).toContain('bogus');
    expect(readFileSync(join(root, 'config.json'), 'utf8')).toBe(before);
  });

  test('다른 키(obsidian)는 POST 뒤에도 불변이다', async () => {
    const cfg = getUserConfig();
    saveUserConfig({ ...cfg, obsidian: { ...cfg.obsidian, vault: '/kept/vault' } });
    const res = await handleChildLlmSet(post({
      mode: 'pinned',
      chain: [{ provider: 'grok', model: 'grok-4' }],
      budgetGate: { minHeadroomPercent: 20, onShortfall: 'wait-reset' },
    }));
    expect(res.status).toBe(200);
    const after = disk();
    expect(after.obsidian?.vault).toBe('/kept/vault');
    expect(after.tools?.selfImplement?.childLlm).toMatchObject({ mode: 'pinned' });
    expect(after.harness?.budgetGate?.onShortfall).toBe('wait-reset');
    expect(after.harness?.budgetGate?.minHeadroomPercent).toBe(20);
  });

  test('chain 의 빈 provider 는 400 이고 기존 childLlm 을 덮지 않는다', async () => {
    const first = await handleChildLlmSet(post({ mode: 'auto', chain: [{ provider: 'grok' }] }));
    expect(first.status).toBe(200);
    const before = readFileSync(join(root, 'config.json'), 'utf8');
    const res = await handleChildLlmSet(post({ chain: [{ provider: '' }] }));
    expect(res.status).toBe(400);
    expect(readFileSync(join(root, 'config.json'), 'utf8')).toBe(before);
  });
});
