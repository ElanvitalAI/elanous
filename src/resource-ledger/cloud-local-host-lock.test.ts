import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withLocalCloudHostLock } from './cloud-local-host-lock.js';

test('serializes a host without blocking another, and releases on failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cloud-lock-'));
  let unblock!: () => void;
  let acquired!: () => void;
  const started = new Promise<void>(resolve => { acquired = resolve; });
  const hold = new Promise<void>(resolve => { unblock = resolve; });
  try {
    const first = withLocalCloudHostLock(root, 'fake-a', async () => { acquired(); await hold; });
    await started;
    await expect(withLocalCloudHostLock(root, 'fake-a', async () => {})).rejects.toThrow('already held');
    expect(await withLocalCloudHostLock(root, 'fake-b', async () => 7)).toBe(7);
    unblock(); await first;
    await expect(withLocalCloudHostLock(root, 'fake-a', async () => { throw new Error('fake failure'); })).rejects.toThrow('fake failure');
    expect(await withLocalCloudHostLock(root, 'fake-a', async () => 8)).toBe(8);
  } finally { unblock?.(); await rm(root, { recursive: true, force: true }); }
});
