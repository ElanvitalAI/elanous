// ── C2 (Phase 3 Bundle 3) — persona-capability-router tests ──

import { describe, expect, test } from 'bun:test';
import { createPersonaCapabilityRouter } from '../../src/discord/persona-capability-router';
import { createCapabilityGrantStore } from '../../src/conductor/capability-grant-store';

describe('createPersonaCapabilityRouter — role-based grants', () => {
  test('admin → all actions allowed', () => {
    const store = createCapabilityGrantStore();
    const router = createPersonaCapabilityRouter({ grantStore: store });
    router.setPersona({ persona: 'elanous-admin', role: 'admin' });
    for (const action of ['read', 'spawn', 'write', 'interrupt', 'inspect', 'close'] as const) {
      const d = router.decide({ persona: 'elanous-admin', action });
      expect(d.allowed).toBe(true);
      expect(d.via).toBe('role');
    }
  });

  test('observer → only read', () => {
    const store = createCapabilityGrantStore();
    const router = createPersonaCapabilityRouter({ grantStore: store });
    router.setPersona({ persona: 'alice', role: 'observer' });
    expect(router.decide({ persona: 'alice', action: 'read' }).allowed).toBe(true);
    expect(router.decide({ persona: 'alice', action: 'write' }).allowed).toBe(false);
  });

  test('commander → spawn but not write', () => {
    const router = createPersonaCapabilityRouter({ grantStore: createCapabilityGrantStore() });
    router.setPersona({ persona: 'bob', role: 'commander' });
    expect(router.decide({ persona: 'bob', action: 'spawn' }).allowed).toBe(true);
    expect(router.decide({ persona: 'bob', action: 'write' }).allowed).toBe(false);
  });

  test('guest → nothing without explicit grant', () => {
    const router = createPersonaCapabilityRouter({ grantStore: createCapabilityGrantStore() });
    router.setPersona({ persona: 'visitor', role: 'guest' });
    expect(router.decide({ persona: 'visitor', action: 'read' }).allowed).toBe(false);
  });

  test('unknown persona → denied', () => {
    const router = createPersonaCapabilityRouter({ grantStore: createCapabilityGrantStore() });
    const d = router.decide({ persona: 'nobody', action: 'read' });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('unknown-persona');
  });
});

describe('createPersonaCapabilityRouter — explicit grants', () => {
  test('expired grant gives an explicit denial reason', () => {
    let now = 1000;
    const store = createCapabilityGrantStore({ now: () => new Date(now) });
    const router = createPersonaCapabilityRouter({ grantStore: store });
    router.setPersona({ persona: 'visitor', role: 'guest' });
    store.grant({ persona: 'visitor', action: 'write', grantedAt: new Date(now).toISOString(), expiresAt: new Date(2000).toISOString() });
    now = 3000;
    expect(router.decide({ persona: 'visitor', action: 'write' })).toEqual({ allowed: false, reason: 'expired' });
  });

  test('guest with explicit grant via store → allowed', () => {
    const store = createCapabilityGrantStore();
    const router = createPersonaCapabilityRouter({ grantStore: store });
    router.setPersona({ persona: 'visitor', role: 'guest' });
    store.grant({
      persona: 'visitor',
      action: 'read',
      grantedAt: new Date().toISOString(),
    });
    const d = router.decide({ persona: 'visitor', action: 'read' });
    expect(d.allowed).toBe(true);
    expect(d.via).toBe('grant');
  });

  test('observer + scoped write grant → allowed only for that shellId', () => {
    const store = createCapabilityGrantStore();
    const router = createPersonaCapabilityRouter({ grantStore: store });
    router.setPersona({ persona: 'alice', role: 'observer' });
    store.grant({
      persona: 'alice',
      action: 'write',
      shellId: 'shell-x',
      grantedAt: new Date().toISOString(),
    });
    expect(router.decide({ persona: 'alice', action: 'write', shellId: 'shell-x' }).allowed).toBe(true);
    expect(router.decide({ persona: 'alice', action: 'write', shellId: 'shell-y' }).allowed).toBe(false);
  });
});

describe('createPersonaCapabilityRouter — channel restriction', () => {
  test('allowedChannelIds filter', () => {
    const router = createPersonaCapabilityRouter({ grantStore: createCapabilityGrantStore() });
    router.setPersona({
      persona: 'alice',
      role: 'commander',
      allowedChannelIds: ['ch-dev'],
    });
    expect(router.decide({ persona: 'alice', action: 'spawn', channelId: 'ch-dev' }).allowed).toBe(true);
    expect(router.decide({ persona: 'alice', action: 'spawn', channelId: 'ch-prod' }).allowed).toBe(false);
  });

  test('omit channelId → allowedChannelIds bypassed', () => {
    const router = createPersonaCapabilityRouter({ grantStore: createCapabilityGrantStore() });
    router.setPersona({
      persona: 'alice',
      role: 'commander',
      allowedChannelIds: ['ch-dev'],
    });
    expect(router.decide({ persona: 'alice', action: 'spawn' }).allowed).toBe(true);
  });
});

describe('createPersonaCapabilityRouter — shellId restriction', () => {
  test('allowedShellIds filter', () => {
    const router = createPersonaCapabilityRouter({ grantStore: createCapabilityGrantStore() });
    router.setPersona({
      persona: 'bob',
      role: 'commander',
      allowedShellIds: ['shell-a'],
    });
    expect(router.decide({ persona: 'bob', action: 'spawn', shellId: 'shell-a' }).allowed).toBe(true);
    expect(router.decide({ persona: 'bob', action: 'spawn', shellId: 'shell-b' }).allowed).toBe(false);
  });
});

describe('createPersonaCapabilityRouter — list / remove', () => {
  test('list returns registered personas', () => {
    const router = createPersonaCapabilityRouter({ grantStore: createCapabilityGrantStore() });
    router.setPersona({ persona: 'a', role: 'observer' });
    router.setPersona({ persona: 'b', role: 'commander' });
    expect(router.list()).toHaveLength(2);
  });

  test('removePersona drops from registry', () => {
    const router = createPersonaCapabilityRouter({ grantStore: createCapabilityGrantStore() });
    router.setPersona({ persona: 'a', role: 'observer' });
    router.removePersona('a');
    expect(router.decide({ persona: 'a', action: 'read' }).reason).toBe('unknown-persona');
  });
});
