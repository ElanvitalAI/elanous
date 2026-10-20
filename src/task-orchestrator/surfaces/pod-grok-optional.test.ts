// GROK-OPTIONAL (10-05) — an expiring grok subscription drops grok from the Pod chain instead of failing the launch.
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { POD_GROK_MIN_VALIDITY_MS, fitPodDeadlineToGrok, grokLaunchReadiness, hostGrokCredentials, podGrokSkippedLine, podGrokSubscriptionUsable } from './self-implement-pod.js';
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
      const later = grokLaunchReadiness({ home, env: {}, now: () => Date.now() + 5 * 3600_000 });
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

describe('POD-GROK-VALIDITY-FIT — the Pod launch bar follows the Job, not the full 3 h', () => {
  const H = 3600_000;
  const M = 60_000;
  test('the bar is a 90 min Job plus a 15 min margin (1h45m), below the 6 h token half-life', () => {
    expect(POD_GROK_MIN_VALIDITY_MS).toBe(105 * M);
  });

  test('2 h left → shipped without a refresh; a 1 h Job is kept, the default 3 h Job is cut to 1h45m', () => {
    const { home } = grokHome(2 * H);
    let refreshed = 0;
    try {
      const out = hostGrokCredentials({ home, env: {}, ghToken: () => 'gh', refresh: () => { refreshed += 1; } });
      expect(refreshed).toBe(0);
      expect(out.grokAuth).toContain('access');
      const now = Date.now();
      expect(fitPodDeadlineToGrok({ requestedSeconds: 3600, expiresAtMs: now + 2 * H, nowMs: now, relay: false })).toEqual({ refused: false, deadlineSeconds: 3600, fitted: false, availableSeconds: 6300 });
      expect(fitPodDeadlineToGrok({ requestedSeconds: 10_800, expiresAtMs: now + 2 * H, nowMs: now, relay: false })).toEqual({ refused: false, deadlineSeconds: 6300, fitted: true, availableSeconds: 6300 });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('time passed since the check: below the minimum Job at launch → refused, never a deadline past the token', () => {
    const now = Date.now();
    expect(fitPodDeadlineToGrok({ requestedSeconds: 10_800, expiresAtMs: now + 100 * M, nowMs: now, relay: false })).toEqual({ refused: true, availableSeconds: 85 * 60 });
    expect(fitPodDeadlineToGrok({ requestedSeconds: 10_800, expiresAtMs: now + 10 * M, nowMs: now, relay: false }).refused).toBe(true);
    // the 1h45m bar holds even for a short requested Job (45 min)
    expect(fitPodDeadlineToGrok({ requestedSeconds: 2700, expiresAtMs: now + 61 * M, nowMs: now, relay: false }).refused).toBe(true);
    expect(fitPodDeadlineToGrok({ requestedSeconds: 2700, expiresAtMs: now + 2 * H, nowMs: now, relay: false })).toMatchObject({ refused: false, deadlineSeconds: 2700 });
  });

  test('the shipped expiry ignores scopes without an access key', async () => {
    const { shippedGrokExpiresAtMs } = await import('./self-implement-pod.js');
    const now = Date.now();
    const auth = JSON.stringify({ a: { key: 'access', expires_at: new Date(now + 2 * H).toISOString() }, b: { expires_at: new Date(now + 10 * H).toISOString() } });
    expect(shippedGrokExpiresAtMs(auth)).toBe(Date.parse(new Date(now + 2 * H).toISOString()));
    expect(shippedGrokExpiresAtMs('not json')).toBeNull();
  });

  test('a host credential relay or an unknown expiry keeps the requested deadline', () => {
    const now = Date.now();
    expect(fitPodDeadlineToGrok({ requestedSeconds: 10_800, expiresAtMs: now + 2 * H, nowMs: now, relay: true }).deadlineSeconds).toBe(10_800);
    expect(fitPodDeadlineToGrok({ requestedSeconds: 10_800, expiresAtMs: null, nowMs: now, relay: false }).deadlineSeconds).toBe(10_800);
  });

  test('20 min left → refused with remaining time, the bar and the next action', () => {
    const { home } = grokHome(20 * M + 30_000);
    try {
      let message = '';
      try { hostGrokCredentials({ home, env: {}, ghToken: () => 'gh', refresh: () => {} }); } catch (error) { message = (error as Error).message; }
      expect(message).toContain('남은 시간 20m');
      expect(message).toContain('기준 1h45m');
      expect(message).toContain('grok login');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('expired → refused as 만료됨', () => {
    const { home } = grokHome(-60_000);
    try {
      expect(() => hostGrokCredentials({ home, env: {}, ghToken: () => 'gh', refresh: () => {} })).toThrow('남은 시간 만료됨');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('a caller with its own (unfitted) deadline sets its own bar', () => {
    const { home } = grokHome(2 * H);
    try {
      expect(() => hostGrokCredentials({ home, env: {}, ghToken: () => 'gh', refresh: () => {}, minValidityMs: 3 * H })).toThrow('기준 3h00m');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('the skipped launch line carries remaining time, the bar and the next action', () => {
    const now = Date.now();
    const line = podGrokSkippedLine({ reason: 'expiring', expiresAt: new Date(now + 20 * M + 30_000).toISOString() }, () => now);
    expect(line).toContain('남은 20m < 기준 1h45m');
    expect(line).toContain('다음: 호스트에서 grok login');
    expect(podGrokSkippedLine({ reason: 'missing', expiresAt: null })).not.toContain('다음:');
  });
});
