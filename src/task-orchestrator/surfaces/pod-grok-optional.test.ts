// GROK-OPTIONAL (10-05) — an expiring grok subscription drops grok from the Pod chain instead of failing the launch.
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { POD_GROK_MIN_VALIDITY_MS, grokLaunchReadiness, podGrokSkippedLine, podGrokSubscriptionUsable } from './self-implement-pod.js';
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
      expect(logs).toHaveLength(2);
      expect(logs[0]![0]).toBe('pod.grok-credentials');
      expect(logs[0]![1]).toBe('skipped');
      expect(logs[0]![2].reason).toBe('expiring');
      expect(logs[1]![0]).toBe('harness.pod');
      expect(logs[1]![1]).toBe('grok-credential-unusable');
      expect(logs[1]![2]).toMatchObject({ reason: 'expiring', refreshOutcome: 'unchanged', minValidityMs: POD_GROK_MIN_VALIDITY_MS });
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

  // AUT-GROK-CRED-EXPIRY-NO-LAUNCH (10-12) — refreshGrokSubscriptionToken reports failure as a value, not a throw.
  test('refresh that «returns» failed (CLI missing/broken) is refresh-failed, not expiring — observed for the autopsy', () => {
    const { home } = grokHome(30 * 60_000);
    const logs: Array<[string, string, Record<string, unknown>]> = [];
    try {
      const out = podGrokSubscriptionUsable({ home, env: {}, refresh: () => 'failed', log: (c, e, d) => { logs.push([c, e, d]); } });
      expect(out.usable).toBe(false);
      if (!out.usable) {
        expect(out.reason).toBe('refresh-failed');
        expect(podGrokSkippedLine(out)).toContain('호스트 갱신 실패');
      }
      const unusable = logs.find(([c, e]) => c === 'harness.pod' && e === 'grok-credential-unusable');
      expect(unusable?.[2]).toMatchObject({ reason: 'refresh-failed', refreshOutcome: 'failed' });
      expect(typeof unusable?.[2].expiresAt).toBe('string');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('refresh returning unchanged stays expiring (the CLI ran but did not extend the token)', () => {
    const { home } = grokHome(30 * 60_000);
    try {
      const out = podGrokSubscriptionUsable({ home, env: {}, refresh: () => 'unchanged', log: () => {} });
      expect(out.usable).toBe(false);
      if (!out.usable) expect(out.reason).toBe('expiring');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('missing credential is observed as harness.pod grok-credential-unusable reason=missing, refresh not attempted', () => {
    const home = mkdtempSync(join(tmpdir(), 'pod-grok-none-'));
    const logs: Array<[string, string, Record<string, unknown>]> = [];
    let refreshed = 0;
    try {
      const out = podGrokSubscriptionUsable({ home, env: {}, refresh: () => { refreshed += 1; return 'refreshed'; }, log: (c, e, d) => { logs.push([c, e, d]); } });
      expect(out.usable).toBe(false);
      expect(refreshed).toBe(0);
      expect(logs.find(([c, e]) => c === 'harness.pod' && e === 'grok-credential-unusable')?.[2]).toMatchObject({ reason: 'missing', refreshOutcome: 'not-attempted' });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('grokLaunchReadiness — read-only verdict on an injected clock', () => {
    const { home, authPath } = grokHome(6 * 3600_000);
    const none = mkdtempSync(join(tmpdir(), 'pod-grok-none-'));
    try {
      expect(grokLaunchReadiness({ home, env: {} }).ready).toBe(true);
      const later = grokLaunchReadiness({ home, env: {}, now: () => Date.now() + 4 * 3600_000 });
      expect(later).toMatchObject({ ready: false, reason: 'expiring' });
      expect(grokLaunchReadiness({ home: none, env: {} })).toMatchObject({ ready: false, reason: 'missing', expiresAt: null });
      // read-only: the auth file is untouched
      expect(JSON.parse(require('node:fs').readFileSync(authPath, 'utf8'))['https://auth.x.ai::client'].key).toBe('access');
    } finally { rmSync(home, { recursive: true, force: true }); rmSync(none, { recursive: true, force: true }); }
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
