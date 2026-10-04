// GROK-OPTIONAL (10-05) — an expiring grok subscription drops grok from the Pod chain instead of failing the launch.
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { podGrokSkippedLine, podGrokSubscriptionUsable } from './self-implement-pod.js';
import { planPodProvider } from './pod-account-broker.js';

function grokHome(expiresInMs: number): { home: string; authPath: string } {
  const home = mkdtempSync(join(tmpdir(), 'pod-grok-optional-'));
  mkdirSync(join(home, '.grok'));
  const authPath = join(home, '.grok', 'auth.json');
  writeFileSync(authPath, JSON.stringify({ 'https://auth.x.ai::client': { key: 'access', expires_at: new Date(Date.now() + expiresInMs).toISOString(), refresh_token: 'r' } }));
  return { home, authPath };
}

const fullCodex = [
  { name: 'default', usedPercent: 98, reached: false },
  { name: 'team', usedPercent: 100, reached: true },
] as unknown as Parameters<typeof planPodProvider>[0]['codexCandidates'];

describe('GROK-OPTIONAL — Pod grok copy is optional', () => {
  test('expiring and the host refresh cannot extend it → not usable, logged as skipped, no throw', () => {
    const { home } = grokHome(60_000);
    const logs: Array<[string, string, Record<string, unknown>]> = [];
    try {
      const out = podGrokSubscriptionUsable({ home, env: {}, refresh: () => {}, log: (c, e, d) => { logs.push([c, e, d]); } });
      expect(out.usable).toBe(false);
      if (!out.usable) {
        expect(out.reason).toBe('expiring');
        expect(out.expiresAt).toBeString();
        expect(podGrokSkippedLine(out)).toContain('이 런의 폴백 체인에서 grok 을 뺐다');
      }
      expect(logs).toHaveLength(1);
      expect(logs[0]![0]).toBe('pod.grok-credentials');
      expect(logs[0]![1]).toBe('skipped');
      expect(logs[0]![2].reason).toBe('expiring');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('refresh that throws is reported as refresh-failed', () => {
    const { home } = grokHome(60_000);
    try {
      const out = podGrokSubscriptionUsable({ home, env: {}, refresh: () => { throw new Error('no network'); }, log: () => {} });
      expect(out.usable).toBe(false);
      if (!out.usable) expect(out.reason).toBe('refresh-failed');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('no subscription credential → missing', () => {
    const home = mkdtempSync(join(tmpdir(), 'pod-grok-none-'));
    try {
      const out = podGrokSubscriptionUsable({ home, env: {}, log: () => {} });
      expect(out.usable).toBe(false);
      if (!out.usable) expect(out.reason).toBe('missing');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('a refresh that extends the token keeps grok usable', () => {
    const { home, authPath } = grokHome(60_000);
    try {
      const out = podGrokSubscriptionUsable({ home, env: {}, log: () => {}, refresh: () => {
        writeFileSync(authPath, JSON.stringify({ 'https://auth.x.ai::client': { key: 'new', expires_at: new Date(Date.now() + 6 * 3600_000).toISOString() } }));
      } });
      expect(out.usable).toBe(true);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('a token with hours to spare is usable and not refreshed (unchanged path)', () => {
    const { home } = grokHome(6 * 3600_000);
    let refreshed = 0;
    try {
      expect(podGrokSubscriptionUsable({ home, env: {}, log: () => {}, refresh: () => { refreshed += 1; } }).usable).toBe(true);
      expect(refreshed).toBe(0);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('plan: grok dropped ⊕ codex credits allowed → launches on codex, not grok', () => {
    const plan = planPodProvider({ codexCandidates: fullCodex, grokSubscription: false, grokApiKey: false, grokApiKeyOptIn: false, creditsAllowed: true });
    expect(plan.provider).toBe('openai-codex');
  });

  test('plan: grok dropped and no codex left → fails as before (nowhere to go)', () => {
    const plan = planPodProvider({ codexCandidates: fullCodex, grokSubscription: false, grokApiKey: false, grokApiKeyOptIn: false, creditsAllowed: false });
    expect(plan.provider).toBeNull();
  });

  test('plan: usable grok with no codex left still picks grok (unchanged)', () => {
    const plan = planPodProvider({ codexCandidates: fullCodex, grokSubscription: true, grokApiKey: false, grokApiKeyOptIn: false, creditsAllowed: false });
    expect(plan.provider).toBe('grok');
  });
});
