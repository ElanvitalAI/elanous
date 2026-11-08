import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { createAppKillSwitch } from './app-kill-switch.js';

const roots: string[] = [];
function databasePath(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'app-kill-switch-')));
  roots.push(root);
  return join(root, 'state.sqlite');
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('app kill switch', () => {
  test('persists tenant-scoped stop state and only owner or operator can reactivate', () => {
    const path = databasePath();
    const first = createAppKillSwitch(path, { now: () => new Date('2026-11-07T05:00:00.000Z') });
    first.applyIncident({ userId: 'tenant-a', appId: 'store', incident: 'abuse-report',
      reason: 'abuse reported', requestedBy: 'reporter-1' });
    expect(first.isDown('tenant-a', 'store')).toBe(true);
    expect(first.isDown('tenant-b', 'store')).toBe(false);
    first.close();

    const reopened = createAppKillSwitch(path, {
      now: () => new Date('2026-11-07T05:01:00.000Z'),
      authorizeReactivation: ({ actor }) => actor.kind === 'operator'
        ? actor.id === 'operator-1'
        : actor.id === 'tenant-a',
    });
    expect(reopened.isDown('tenant-a', 'store')).toBe(true);
    expect(() => reopened.reactivate({ userId: 'tenant-a', appId: 'store', actor: { kind: 'user', id: 'tenant-b' } }))
      .toThrow('app kill switch reactivation denied');
    expect(() => reopened.reactivate({ userId: 'tenant-a', appId: 'store', actor: { kind: 'operator', id: 'forged-operator' } }))
      .toThrow('app kill switch reactivation denied');
    expect(reopened.audit('tenant-a', 'store')).toHaveLength(1);
    expect(reopened.reactivate({ userId: 'tenant-a', appId: 'store', actor: { kind: 'user', id: 'tenant-a' } })).toBe(true);
    expect(reopened.isDown('tenant-a', 'store')).toBe(false);
    expect(reopened.reactivate({ userId: 'tenant-a', appId: 'store', actor: { kind: 'operator', id: 'operator-1' } })).toBe(false);
    expect(reopened.audit('tenant-a', 'store').map(({ action, requestedBy, actorKind, actorId }) => ({ action, requestedBy, actorKind, actorId })))
      .toEqual([
        { action: 'disabled', requestedBy: 'reporter-1', actorKind: 'system', actorId: 'incident-ingress' },
        { action: 'reactivated', requestedBy: 'reporter-1', actorKind: 'user', actorId: 'tenant-a' },
      ]);
    reopened.close();
  });

  test('rejects invalid tenant, app, requester, incident, and blank audit reason', () => {
    const control = createAppKillSwitch(databasePath());
    const valid = { userId: 'tenant-a', appId: 'store', incident: 'cost-spike' as const, reason: 'cost limit', requestedBy: 'cost-guard' };
    expect(() => control.applyIncident({ ...valid, userId: '../tenant' })).toThrow('invalid app kill switch user id');
    expect(() => control.applyIncident({ ...valid, appId: '../store' })).toThrow('invalid app kill switch app id');
    expect(() => control.applyIncident({ ...valid, requestedBy: '' })).toThrow('invalid app kill switch requester');
    expect(() => control.applyIncident({ ...valid, incident: 'unknown' as never })).toThrow('invalid app kill switch incident');
    expect(() => control.applyIncident({ ...valid, reason: '  ' })).toThrow('invalid app kill switch reason');
    control.close();
  });

  test('denies all reactivation when no trusted principal authorizer is configured', () => {
    const control = createAppKillSwitch(databasePath());
    control.applyIncident({ userId: 'tenant-a', appId: 'store', incident: 'cost-spike', reason: 'cost limit', requestedBy: 'cost-guard' });
    expect(() => control.reactivate({ userId: 'tenant-a', appId: 'store', actor: { kind: 'user', id: 'tenant-a' } }))
      .toThrow('app kill switch reactivation denied');
    expect(() => control.reactivate({ userId: 'tenant-a', appId: 'store', actor: { kind: 'operator', id: 'operator-1' } }))
      .toThrow('app kill switch reactivation denied');
    expect(control.isDown('tenant-a', 'store')).toBe(true);
    expect(control.audit('tenant-a', 'store')).toHaveLength(1);
    control.close();
  });

  test('rejects an existing database with group or other permissions without changing it', () => {
    const path = databasePath();
    writeFileSync(path, 'untrusted pre-existing state');
    chmodSync(path, 0o644);
    expect(() => createAppKillSwitch(path)).toThrow('unsafe app kill switch database');
    expect(lstatSync(path).mode & 0o777).toBe(0o644);
  });

  test('rejects a symlink database path without opening its target', () => {
    const target = databasePath();
    writeFileSync(target, 'outside target');
    const link = join(roots[roots.length - 1]!, 'linked.sqlite');
    symlinkSync(target, link);
    expect(() => createAppKillSwitch(link)).toThrow();
    expect(readFileSync(target, 'utf8')).toBe('outside target');
  });

  test('rejects symlinked or group-writable parent directories', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'app-kill-switch-parent-')));
    roots.push(root);
    const realDirectory = join(root, 'real');
    mkdirSync(realDirectory, { mode: 0o700 });
    const linkedDirectory = join(root, 'linked');
    symlinkSync(realDirectory, linkedDirectory);
    const externalNewDirectory = join(realDirectory, 'new');
    expect(() => createAppKillSwitch(join(linkedDirectory, 'new', 'state.sqlite'), { stateRoot: root })).toThrow('unsafe app kill switch state directory');
    expect(existsSync(externalNewDirectory)).toBe(false);
    expect(() => createAppKillSwitch(join(linkedDirectory, 'state.sqlite'), { stateRoot: root })).toThrow('unsafe app kill switch state directory');
    chmodSync(realDirectory, 0o770);
    expect(() => createAppKillSwitch(join(realDirectory, 'state.sqlite'), { stateRoot: root })).toThrow('unsafe app kill switch state directory');
  });

  test('resolves a state root below a normal ancestor symlink once and securely creates descendants', () => {
    const realBase = realpathSync(mkdtempSync(join(tmpdir(), 'app-kill-switch-root-')));
    roots.push(realBase);
    const realRoot = join(realBase, 'state');
    mkdirSync(realRoot, { mode: 0o700 });
    const linkedBase = join(realBase, 'base-link');
    symlinkSync(realBase, linkedBase);
    const stateRoot = join(linkedBase, 'state');
    const database = join(stateRoot, 'relay', 'state.sqlite');
    const control = createAppKillSwitch(database, { stateRoot });
    control.applyIncident({ userId: 'tenant-a', appId: 'store', incident: 'abuse-report', reason: 'reported', requestedBy: 'reporter-a' });
    expect(control.isDown('tenant-a', 'store')).toBe(true);
    expect(existsSync(join(realRoot, 'relay', 'state.sqlite'))).toBe(true);
    control.close();
  });

  test('continues to reject symlinks below the pinned state root without creating outside state', () => {
    const stateRoot = realpathSync(mkdtempSync(join(tmpdir(), 'app-kill-switch-pinned-root-')));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'app-kill-switch-outside-')));
    roots.push(stateRoot, outside);
    const linked = join(stateRoot, 'linked');
    symlinkSync(outside, linked);
    expect(() => createAppKillSwitch(join(linked, 'state.sqlite'), { stateRoot })).toThrow('unsafe app kill switch state directory');
    expect(existsSync(join(outside, 'state.sqlite'))).toBe(false);
  });
});
