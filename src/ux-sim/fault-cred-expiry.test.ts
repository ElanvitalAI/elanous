import { describe, expect, test } from 'bun:test';
import { POD_GROK_MIN_VALIDITY_MS } from '../task-orchestrator/surfaces/self-implement-pod.js';
import { credExpirySweep, renderCredExpiry, simCredExpiry } from './fault-cred-expiry.js';

const MIN = 60_000;

describe('simCredExpiry — 결함 주입 «자격 만료» (grok 구독)', () => {
  test('the node-b case (32 min left, refresh leaves the token unchanged) drops grok and says why, never throws', () => {
    const obs = simCredExpiry({ expiresInMs: 32 * MIN, refresh: 'unchanged' });
    expect(obs.readiness).toMatchObject({ ready: false, reason: 'expiring' });
    expect(obs.usable).toMatchObject({ usable: false, reason: 'expiring' });
    expect(obs.launchLine).toContain('이 런의 폴백 체인에서 grok 을 뺐다');
    expect(obs.logs.map((l) => `${l.category}/${l.event}`)).toEqual(['pod.grok-credentials/skipped', 'harness.pod/grok-credential-unusable']);
    expect(obs.logs[1]!.data).toMatchObject({ refreshOutcome: 'unchanged', minValidityMs: POD_GROK_MIN_VALIDITY_MS });
  });

  test('a refresh that fails or throws is told apart from «unchanged» (refresh-failed)', () => {
    for (const refresh of ['failed', 'threw', 'no-credential'] as const) {
      const obs = simCredExpiry({ expiresInMs: 32 * MIN, refresh });
      expect(obs.usable).toMatchObject({ usable: false, reason: 'refresh-failed' });
      expect(obs.logs[1]!.data.refreshOutcome).toBe(refresh);
    }
  });

  test('a refresh that extends the token keeps grok in the launch', () => {
    const obs = simCredExpiry({ expiresInMs: 32 * MIN, refresh: 'refreshed' });
    expect(obs.usable).toEqual({ usable: true });
    expect(obs.launchLine).toBeNull();
    expect(obs.logs).toHaveLength(0);
  });

  test('a refresh that extends the token but not past the minimum validity still drops grok', () => {
    const obs = simCredExpiry({ expiresInMs: 32 * MIN, refresh: 'refreshed', extendToMs: 60 * MIN });
    expect(obs.usable).toMatchObject({ usable: false, reason: 'expiring' });
    expect(obs.logs[1]!.data.refreshOutcome).toBe('refreshed');
  });

  test('render marks an already-expired token and the assumed refresh extension', () => {
    const lines = renderCredExpiry([simCredExpiry({ expiresInMs: -10 * MIN, refresh: 'unchanged' }), simCredExpiry({ expiresInMs: 32 * MIN, refresh: 'refreshed' })]);
    expect(lines[1]).toContain('만료+0h10m');
    expect(lines[2]).toContain('refreshed(→12h00m)');
  });

  test('the minimum-validity edge: 5 min over is ready, 5 min under is not', () => {
    expect(simCredExpiry({ expiresInMs: POD_GROK_MIN_VALIDITY_MS + 5 * MIN, refresh: 'unchanged' }).readiness.ready).toBe(true);
    expect(simCredExpiry({ expiresInMs: POD_GROK_MIN_VALIDITY_MS - 5 * MIN, refresh: 'unchanged' }).readiness.ready).toBe(false);
  });

  test('the sweep renders one line per scenario', () => {
    const lines = renderCredExpiry(credExpirySweep());
    expect(lines[0]).toStartWith('cred-expiry · grok 구독 · 최소 유효 3h00m');
    expect(lines).toHaveLength(1 + credExpirySweep().length);
    expect(lines.some((l) => l.includes('발사 dropped(refresh-failed)'))).toBe(true);
  });
});
