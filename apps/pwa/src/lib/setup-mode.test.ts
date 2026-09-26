import { describe, expect, test } from 'bun:test';

import type { NexusHealth } from '@/nexus/types';
import { setupModeBannerText, setupModeRedirect } from './setup-mode';

const base: NexusHealth = {
  ok: true,
  nexusVersion: '0',
  phase: 'running',
  startedAt: 0,
  uptimeMs: 0,
  tabs: { total: 0, byStatus: {} as NexusHealth['tabs']['byStatus'] },
};

describe('setup-mode', () => {
  test('health with no setupMode field yields null from both functions', () => {
    expect(setupModeRedirect(base, '/')).toBeNull();
    expect(setupModeBannerText(base, '/')).toBeNull();
    expect(setupModeRedirect(base, '/chat')).toBeNull();
    expect(setupModeBannerText(base, '/chat')).toBeNull();
  });

  test('setupMode true and pathname / redirects to /setup', () => {
    const health = { ...base, setupMode: true };
    expect(setupModeRedirect(health, '/')).toBe('/setup');
  });

  test('setupMode true and pathname /setup yields a null banner', () => {
    const health = { ...base, setupMode: true };
    expect(setupModeBannerText(health, '/setup')).toBeNull();
    expect(setupModeRedirect(health, '/setup')).toBeNull();
  });

  test('setupMode true, /chat, and setupMissing [llm] includes llm in the banner', () => {
    const health = { ...base, setupMode: true, setupMissing: ['llm'] };
    const text = setupModeBannerText(health, '/chat');
    expect(text).not.toBeNull();
    expect(text).toContain('llm');
    expect(text).toContain('셋업 모드 — 먼저 LLM 을 정하세요');
    expect(setupModeRedirect(health, '/chat')).toBeNull();
  });

  test('setupMode false or a nested setup path does not redirect or banner', () => {
    expect(setupModeRedirect({ ...base, setupMode: false }, '/')).toBeNull();
    expect(setupModeBannerText({ ...base, setupMode: false }, '/chat')).toBeNull();
    expect(setupModeBannerText({ ...base, setupMode: true }, '/setup/llm')).toBeNull();
  });
});
