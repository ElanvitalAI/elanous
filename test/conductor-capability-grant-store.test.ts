// ── T6 (Phase 3 Bundle 1) — capability-grant-store + slash tests ──

import { describe, expect, spyOn, test } from 'bun:test';
import {
  createCapabilityGrantStore,
  executeGrantSlash,
  type CapabilityGrant,
  type GrantedAction,
} from '../src/conductor/capability-grant-store';

function makeGrant(opts: Partial<CapabilityGrant> = {}): CapabilityGrant {
  return {
    persona: opts.persona ?? 'alice',
    action: opts.action ?? 'read',
    grantedAt: opts.grantedAt ?? '2026-05-01T00:00:00Z',
    ...(opts.shellId !== undefined ? { shellId: opts.shellId } : {}),
    ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
    ...(opts.note !== undefined ? { note: opts.note } : {}),
    ...(opts.grantedBy !== undefined ? { grantedBy: opts.grantedBy } : {}),
  };
}

describe('createCapabilityGrantStore — basic', () => {
  test('grant + isGranted exact match', () => {
    const s = createCapabilityGrantStore();
    s.grant(makeGrant({ persona: 'a', action: 'read' }));
    expect(s.isGranted('a', 'read')).toBe(true);
    expect(s.isGranted('a', 'write')).toBe(false);
    expect(s.isGranted('b', 'read')).toBe(false);
  });

  test('grant scoped to shellId', () => {
    const s = createCapabilityGrantStore();
    s.grant(makeGrant({ persona: 'a', action: 'write', shellId: 'shell-1' }));
    expect(s.isGranted('a', 'write', 'shell-1')).toBe(true);
    expect(s.isGranted('a', 'write', 'shell-2')).toBe(false);
    expect(s.isGranted('a', 'write')).toBe(false);
  });

  test('global grant matches when shellId queried', () => {
    const s = createCapabilityGrantStore();
    s.grant(makeGrant({ persona: 'a', action: 'read' }));  // global
    expect(s.isGranted('a', 'read', 'shell-x')).toBe(true);
  });

  test('grant overwrites duplicate', () => {
    const s = createCapabilityGrantStore();
    s.grant(makeGrant({ persona: 'a', action: 'read', note: 'first' }));
    s.grant(makeGrant({ persona: 'a', action: 'read', note: 'second' }));
    const list = s.list({ persona: 'a' });
    expect(list).toHaveLength(1);
    expect(list[0]!.note).toBe('second');
  });

  test('revoke by persona only — removes all', () => {
    const s = createCapabilityGrantStore();
    s.grant(makeGrant({ persona: 'a', action: 'read' }));
    s.grant(makeGrant({ persona: 'a', action: 'write' }));
    s.grant(makeGrant({ persona: 'b', action: 'read' }));
    expect(s.revoke({ persona: 'a' })).toBe(2);
    expect(s.list({ persona: 'a' })).toHaveLength(0);
    expect(s.list({ persona: 'b' })).toHaveLength(1);
  });

  test('revoke with action filter', () => {
    const s = createCapabilityGrantStore();
    s.grant(makeGrant({ persona: 'a', action: 'read' }));
    s.grant(makeGrant({ persona: 'a', action: 'write' }));
    expect(s.revoke({ persona: 'a', action: 'write' })).toBe(1);
    expect(s.list({ persona: 'a' })).toHaveLength(1);
    expect(s.isGranted('a', 'read')).toBe(true);
    expect(s.isGranted('a', 'write')).toBe(false);
  });

  test('revoke non-matching → 0', () => {
    const s = createCapabilityGrantStore();
    expect(s.revoke({ persona: 'nobody' })).toBe(0);
  });

  test('list with filter', () => {
    const s = createCapabilityGrantStore();
    s.grant(makeGrant({ persona: 'a', action: 'read', shellId: 's1' }));
    s.grant(makeGrant({ persona: 'a', action: 'write', shellId: 's1' }));
    s.grant(makeGrant({ persona: 'b', action: 'read' }));
    expect(s.list({ shellId: 's1' })).toHaveLength(2);
    expect(s.list({ action: 'read' })).toHaveLength(2);
  });
});

describe('createCapabilityGrantStore — expiry', () => {
  test('warns once within one hour, and not outside the window', () => {
    const now = new Date('2026-11-18T00:00:00Z').getTime();
    const warned: string[] = [];
    const s = createCapabilityGrantStore({
      now: () => new Date(now),
      onExpiring: (grant) => warned.push(grant.persona),
    });
    s.grant(makeGrant({ persona: 'outside', expiresAt: new Date(now + 61 * 60_000).toISOString() }));
    expect(warned).toEqual([]);
    s.grant(makeGrant({ persona: 'boundary', expiresAt: new Date(now + 60 * 60_000).toISOString() }));
    s.grant(makeGrant({ persona: 'inside', expiresAt: new Date(now + 59 * 60_000).toISOString() }));
    s.isGranted('inside', 'read');
    expect(warned).toEqual(['boundary', 'inside']);
  });

  test('an injected clock does not silence the default warning channel', () => {
    const now = Date.parse('2026-11-18T00:00:00Z');
    const warning = spyOn(process, 'emitWarning').mockImplementation(() => {});
    try {
      const s = createCapabilityGrantStore({ now: () => new Date(now) });
      s.grant(makeGrant({ persona: 'alice\nforged', expiresAt: new Date(now + 30 * 60_000).toISOString() }));
      expect(warning).toHaveBeenCalledTimes(1);
      expect(String(warning.mock.calls[0]?.[0])).toContain('capability grant expires within 1 hour');
      expect(String(warning.mock.calls[0]?.[0])).toContain('alice\\nforged');
      expect(String(warning.mock.calls[0]?.[0])).not.toContain('alice\nforged');
    } finally {
      warning.mockRestore();
    }
  });

  test('schedules the warning before a grant reaches its one-hour window', async () => {
    const warned: string[] = [];
    const s = createCapabilityGrantStore({ onExpiring: (grant) => warned.push(grant.persona) });
    s.grant(makeGrant({ persona: 'scheduled', expiresAt: new Date(Date.now() + 60 * 60_000 + 200).toISOString() }));
    expect(warned).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(warned).toEqual(['scheduled']);
    expect(s.isGranted('scheduled', 'read')).toBe(true);
  });

  test('checkGrant retains expired and revoked denial reasons', () => {
    let now = 1000;
    const s = createCapabilityGrantStore({ now: () => new Date(now) });
    const expiresAt = new Date(2000).toISOString();
    s.grant(makeGrant({ persona: 'expired', expiresAt }));
    s.grant(makeGrant({ persona: 'revoked' }));
    s.revoke({ persona: 'revoked' });
    now = 3000;
    expect(s.checkGrant('expired', 'read')).toEqual({ granted: false, reason: 'expired', expiresAt });
    expect(s.checkGrant('revoked', 'read')).toEqual({ granted: false, reason: 'revoked' });
    expect(s.checkGrant('missing', 'read')).toEqual({ granted: false, reason: 'absent' });
  });

  test('denial reasons survive audit rotation and a new grant clears its old reason', () => {
    let now = 1000;
    const s = createCapabilityGrantStore({ now: () => new Date(now), auditCap: 1 });
    const expiresAt = new Date(2000).toISOString();
    s.grant(makeGrant({ persona: 'expired', expiresAt }));
    s.grant(makeGrant({ persona: 'revoked' }));
    s.revoke({ persona: 'revoked' });
    now = 3000;
    s.pruneExpired();
    s.grant(makeGrant({ persona: 'unrelated' }));
    expect(s.audit()).toHaveLength(1);
    expect(s.checkGrant('expired', 'read')).toEqual({ granted: false, reason: 'expired', expiresAt });
    expect(s.checkGrant('revoked', 'read')).toEqual({ granted: false, reason: 'revoked' });
    s.grant(makeGrant({ persona: 'expired' }));
    expect(s.checkGrant('expired', 'read')).toEqual({ granted: true });
    s.revoke({ persona: 'expired' });
    expect(s.checkGrant('expired', 'read')).toEqual({ granted: false, reason: 'revoked' });
  });

  test('denial history is bounded independently from the audit log', () => {
    const s = createCapabilityGrantStore({ auditCap: 1, denialCap: 2 });
    for (const persona of ['old', 'recent-a', 'recent-b']) {
      s.grant(makeGrant({ persona }));
      s.revoke({ persona });
    }
    expect(s.audit()).toHaveLength(1);
    expect(s.checkGrant('old', 'read')).toEqual({ granted: false, reason: 'absent' });
    expect(s.checkGrant('recent-a', 'read')).toEqual({ granted: false, reason: 'revoked' });
    expect(s.checkGrant('recent-b', 'read')).toEqual({ granted: false, reason: 'revoked' });
  });

  test('non-finite denial caps cannot disable the memory bound', () => {
    expect(() => createCapabilityGrantStore({ denialCap: Number.NaN })).toThrow('invalid denialCap');
    expect(() => createCapabilityGrantStore({ denialCap: Number.POSITIVE_INFINITY })).toThrow('invalid denialCap');
  });

  test('an active global grant still authorizes a scoped request after scoped expiry', () => {
    let now = 1000;
    const s = createCapabilityGrantStore({ now: () => new Date(now) });
    s.grant(makeGrant({ persona: 'a', action: 'read' }));
    s.grant(makeGrant({ persona: 'a', action: 'read', shellId: 'shell-x', expiresAt: new Date(2000).toISOString() }));
    now = 3000;
    expect(s.checkGrant('a', 'read', 'shell-x')).toEqual({ granted: true });
  });

  test('expired grant returns false on isGranted + auto-prunes', () => {
    let nowMs = 1000;
    const s = createCapabilityGrantStore({
      now: () => new Date(nowMs),
    });
    s.grant(makeGrant({
      persona: 'a',
      action: 'read',
      expiresAt: new Date(2000).toISOString(),
    }));
    expect(s.isGranted('a', 'read')).toBe(true);
    nowMs = 3000;
    expect(s.isGranted('a', 'read')).toBe(false);
    expect(s.list()).toHaveLength(0);
  });

  test('pruneExpired returns expired events', () => {
    let nowMs = 1000;
    const s = createCapabilityGrantStore({ now: () => new Date(nowMs) });
    s.grant(makeGrant({
      persona: 'a',
      action: 'read',
      expiresAt: new Date(2000).toISOString(),
    }));
    nowMs = 5000;
    const events = s.pruneExpired();
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('expired');
  });
});

describe('createCapabilityGrantStore — audit log', () => {
  test('audit captures grant + revoke + expired', async () => {
    let nowMs = 1000;
    const s = createCapabilityGrantStore({ now: () => new Date(nowMs) });
    s.grant(makeGrant({ persona: 'a', action: 'read' }));
    s.revoke({ persona: 'a' });
    s.grant(makeGrant({
      persona: 'b', action: 'write',
      expiresAt: new Date(2000).toISOString(),
    }));
    nowMs = 3000;
    s.pruneExpired();
    const audit = s.audit();
    expect(audit.map((e) => e.kind)).toEqual(['granted', 'revoked', 'granted', 'expired']);
  });

  test('audit cap drops oldest', () => {
    const s = createCapabilityGrantStore({ auditCap: 3 });
    for (let i = 0; i < 5; i += 1) {
      s.grant(makeGrant({ persona: `p${i}`, action: 'read' }));
    }
    expect(s.audit()).toHaveLength(3);
    expect(s.audit()[0]!.grant.persona).toBe('p2'); // p0,p1 dropped
  });
});

describe('executeGrantSlash', () => {
  test('grant verb — happy path', () => {
    const s = createCapabilityGrantStore();
    const r = executeGrantSlash(
      { verb: 'grant', persona: 'alice', action: 'write', shellId: 'shell-x' },
      { store: s, now: () => '2026-05-01T00:00:00Z' },
    );
    expect(r.ok).toBe(true);
    expect(r.message).toContain('granted alice write');
    expect(r.message).toContain('for shell-x');
    expect(s.isGranted('alice', 'write', 'shell-x')).toBe(true);
  });

  test('grant — missing persona fails', () => {
    const s = createCapabilityGrantStore();
    const r = executeGrantSlash({ verb: 'grant', action: 'read' }, { store: s });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('persona');
  });

  test('grant — invalid action fails', () => {
    const s = createCapabilityGrantStore();
    const r = executeGrantSlash(
      { verb: 'grant', persona: 'a', action: 'invalid-action' as GrantedAction },
      { store: s },
    );
    expect(r.ok).toBe(false);
    expect(r.message).toContain('action');
  });

  test('revoke verb — happy path', () => {
    const s = createCapabilityGrantStore();
    s.grant(makeGrant({ persona: 'a', action: 'read' }));
    const r = executeGrantSlash({ verb: 'revoke', persona: 'a' }, { store: s });
    expect(r.ok).toBe(true);
    expect(r.message).toContain('revoked 1');
  });

  test('revoke — no match', () => {
    const s = createCapabilityGrantStore();
    const r = executeGrantSlash({ verb: 'revoke', persona: 'nobody' }, { store: s });
    expect(r.ok).toBe(false);
  });

  test('list verb — empty', () => {
    const r = executeGrantSlash({ verb: 'list' }, { store: createCapabilityGrantStore() });
    expect(r.ok).toBe(true);
    expect(r.message).toContain('현재 grant 가 없습니다');
    expect(r.grants).toEqual([]);
  });

  test('list verb — with grants', () => {
    const s = createCapabilityGrantStore();
    s.grant(makeGrant({ persona: 'a', action: 'read', shellId: 's1' }));
    s.grant(makeGrant({ persona: 'b', action: 'write' }));
    const r = executeGrantSlash({ verb: 'list' }, { store: s });
    expect(r.ok).toBe(true);
    expect(r.grants).toHaveLength(2);
    expect(r.message).toContain('a · read · [s1]');
    expect(r.message).toContain('b · write · [*]');
  });

  test('list — filtered by persona', () => {
    const s = createCapabilityGrantStore();
    s.grant(makeGrant({ persona: 'a', action: 'read' }));
    s.grant(makeGrant({ persona: 'b', action: 'read' }));
    const r = executeGrantSlash({ verb: 'list', persona: 'a' }, { store: s });
    expect(r.grants).toHaveLength(1);
    expect(r.grants![0]!.persona).toBe('a');
  });
});
