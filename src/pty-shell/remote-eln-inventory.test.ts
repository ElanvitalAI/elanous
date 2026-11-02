import { describe, expect, test } from 'bun:test';
import { collectRemoteElnInventory, filterRemoteElnInventory, type RemoteElnInventoryHost } from './remote-eln-inventory.js';

describe('remote eln inventory is read-only and keeps host failures distinct', () => {
  test('aggregates all sessions but never confuses unreachable with an empty host', async () => {
    const result = await collectRemoteElnInventory(['node-b', 'aws1'], async (host) => {
      if (host === 'aws1') throw new Error('ssh timeout');
      return [
        { ptyId: 'tui:51', kind: 'tui', name: 'review', alive: true, registered: true, registeredBy: 'OP', registeredAt: 100, lastActivityAt: 150 },
        { ptyId: 'shell:52', kind: 'shell', name: 'build', alive: true, registered: false, lastActivityAt: 160 },
      ];
    });

    expect(result).toEqual([
      { host: 'node-b', status: 'measured', sessions: [
        { ptyId: 'tui:51', kind: 'tui', name: 'review', alive: true, registered: true, registeredBy: 'OP', registeredAt: 100, lastActivityAt: 150 },
        { ptyId: 'shell:52', kind: 'shell', name: 'build', alive: true, registered: false, lastActivityAt: 160 },
      ] },
      { host: 'aws1', status: 'unmeasured', reason: 'ssh timeout', sessions: [] },
    ]);
  });

  test('host, kind, and registered filters are independent and preserve unmeasured rows', async () => {
    const hosts: RemoteElnInventoryHost[] = await collectRemoteElnInventory(['node-b', 'aws1'], async (host) => {
      if (host === 'aws1') throw new Error('ssh timeout');
      return [
        { ptyId: 'tui:51', kind: 'tui', name: 'review', alive: true, registered: true },
        { ptyId: 'shell:52', kind: 'shell', name: 'build', alive: true, registered: false },
      ];
    });
    const filtered = filterRemoteElnInventory(hosts, { host: ['node-b'], kind: ['tui'], registered: true });

    expect(filtered).toEqual([{ host: 'node-b', status: 'measured', sessions: [
      { ptyId: 'tui:51', kind: 'tui', name: 'review', alive: true, registered: true },
    ] }]);
    expect(filterRemoteElnInventory(hosts, { registered: false })).toEqual([
      { host: 'node-b', status: 'measured', sessions: [
        { ptyId: 'shell:52', kind: 'shell', name: 'build', alive: true, registered: false },
      ] },
      { host: 'aws1', status: 'unmeasured', reason: 'ssh timeout', sessions: [] },
    ]);
  });

  test('duplicate host aliases are rejected and malformed responses become unmeasured', async () => {
    await expect(collectRemoteElnInventory(['node-b', 'node-b'], async () => [])).rejects.toThrow('duplicate host');
    await expect(collectRemoteElnInventory(['node-b'], async () => [
      { ptyId: '', kind: 'tui', name: 'bad', alive: true, registered: false },
    ])).resolves.toMatchObject([{ host: 'node-b', status: 'unmeasured', sessions: [] }]);
  });
});
