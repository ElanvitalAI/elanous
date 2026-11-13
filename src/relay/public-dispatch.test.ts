import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPublicDispatchRoutes, loadPublicDispatchRoutes } from './public-dispatch';
import { validateRelayPublicOptions } from './relay-cli';

const a = 'a'.repeat(64);
const b = 'b'.repeat(64);
const trusted = new Set([a, b]);
const owners = new Map([[a, 'member-a'], [b, 'member-b']]);

describe('operator-provisioned public dispatch', () => {
  test('keeps two user labels pinned to separate Nexus hosts', () => {
    const routes = buildPublicDispatchRoutes(new Map([
      ['alice', { serverId: a, ownerMemberId: 'member-a' }],
      ['bob', { serverId: b, ownerMemberId: 'member-b' }],
    ]), trusted, owners);
    expect(routes.get('alice')?.serverId).toBe(a);
    expect(routes.get('bob')?.serverId).toBe(b);
    expect(routes.get('charlie')).toBeUndefined();
  });

  test('rejects unknown hosts, wrong owners, invalid labels, and shared hosts', () => {
    const rejected = [
      new Map([['alice', { serverId: 'c'.repeat(64), ownerMemberId: 'member-c' }]]),
      new Map([['alice', { serverId: a, ownerMemberId: 'member-b' }]]),
      new Map([['a--b', { serverId: a, ownerMemberId: 'member-a' }]]),
      new Map([
        ['alice', { serverId: a, ownerMemberId: 'member-a' }],
        ['bob', { serverId: a, ownerMemberId: 'member-a' }],
      ]),
    ];
    for (const routes of rejected) expect(() => buildPublicDispatchRoutes(routes, trusted, owners)).toThrow('invalid public dispatch route');
  });

  test('loads only an owner-private config and rejects duplicate labels', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-dispatch-'));
    const path = join(dir, 'routes.json');
    try {
      const route = { user: 'alice', serverId: a, ownerMemberId: 'member-a' };
      writeFileSync(path, JSON.stringify({ routes: [route] }), { mode: 0o600 });
      expect(loadPublicDispatchRoutes(path).get('alice')).toEqual({ serverId: a, ownerMemberId: 'member-a' });
      chmodSync(path, 0o644);
      expect(() => loadPublicDispatchRoutes(path)).toThrow('owner-only');
      chmodSync(path, 0o600);
      writeFileSync(path, JSON.stringify({ routes: [route, route] }));
      expect(() => loadPublicDispatchRoutes(path)).toThrow('invalid public dispatch config');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('CLI requires member auth and excludes legacy pins for multi-user mode', () => {
    expect(() => validateRelayPublicOptions({ publicDomain: 'elanous.app', publicDispatchConfig: 'routes.json', memberRequired: true })).not.toThrow();
    expect(() => validateRelayPublicOptions({ publicDomain: 'elanous.app', publicDispatchConfig: 'routes.json' })).toThrow('member-required');
    expect(() => validateRelayPublicOptions({ publicDomain: 'elanous.app', publicDispatchConfig: 'routes.json',
      memberRequired: true, publicUserId: 'alice' })).toThrow('single-user pins');
  });
});
