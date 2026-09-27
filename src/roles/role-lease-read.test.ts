import { expect, spyOn, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { ROLE_LEASE_OBJECT_PATH } from './role-lease.js';
import { readRoleLeaseAsync } from './role-lease-read.js';
import { _setSystemGcloudPathsForTesting } from '../cli/role-cli.js';

const bucket = 'gs://example-bucket';
const uri = `${bucket}/${ROLE_LEASE_OBJECT_PATH}`;
const doc = JSON.stringify({ holder: 'node-b', generation: 7, state: 'held', renewedAt: 123 });
const ok = (stdout: string) => ({ code: 0, stdout, said: stdout });

test('async read describes, cats and re-describes a stable object generation', async () => {
  const calls: string[][] = [];
  const replies = [ok('5\n'), ok(doc), ok('5\n')];
  const read = await readRoleLeaseAsync(bucket, { run: async args => { calls.push(args); return replies.shift()!; } });
  expect(read).toEqual({ kind: 'present', doc: { holder: 'node-b', generation: 7, state: 'held', renewedAt: 123 } });
  expect(calls).toEqual([
    ['storage', 'objects', 'describe', uri, '--format=value(generation)'],
    ['storage', 'cat', uri],
    ['storage', 'objects', 'describe', uri, '--format=value(generation)'],
  ]);
});

test('lease reads log their measured kind, holder, generation and elapsed milliseconds', async () => {
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    const replies = [ok('5'), ok(doc), ok('5')];
    await readRoleLeaseAsync(bucket, { run: async () => replies.shift()! });
    expect(log).toHaveBeenCalledWith('control.lease', 'read', {
      kind: 'present', holder: 'node-b', generation: 7, ms: expect.any(Number),
    });
    await readRoleLeaseAsync(bucket, { run: async () => { throw new Error('timeout (8s)'); } });
    expect(log).toHaveBeenCalledWith('control.lease', 'read', {
      kind: 'unmeasured', holder: null, generation: null, ms: expect.any(Number),
    });
  } finally { log.mockRestore(); }
});

test('a changed GCS object generation makes the lease unmeasured', async () => {
  const replies = [ok('5'), ok(doc), ok('6')];
  expect(await readRoleLeaseAsync(bucket, { run: async () => replies.shift()! }))
    .toEqual({ kind: 'unmeasured', why: 'lease changed during read; retry' });
});

test('a timed-out command does not leak an exception or accept a stale lease', async () => {
  expect(await readRoleLeaseAsync(bucket, { run: async () => { throw new Error('timeout (8s)'); } }))
    .toEqual({ kind: 'unmeasured', why: 'timeout (8s)' });
  expect(await readRoleLeaseAsync(bucket, { run: async () => ({ code: null, stdout: '', said: 'gcloud timeout (8s)' }) }))
    .toEqual({ kind: 'unmeasured', why: 'gcloud timeout (8s)' });
});

test('real async gcloud calls leave the event loop responsive and time out each call', async () => {
  _setSystemGcloudPathsForTesting([]); // 진짜 gcloud 가 /opt/homebrew 에 있는 맥에서도 가짜를 쓰게
  const dir = mkdtempSync(join(tmpdir(), 'elanous-async-gcloud-'));
  const previousHome = process.env.HOME;
  const previousPath = process.env.PATH;
  try {
    const cloudBin = join(dir, 'google-cloud-sdk', 'bin');
    mkdirSync(cloudBin, { recursive: true });
    const binary = join(cloudBin, 'gcloud');
    writeFileSync(binary, '#!/bin/sh\nexec sleep 30\n');
    chmodSync(binary, 0o755);
    process.env.HOME = dir;
    process.env.PATH = '/usr/bin:/bin';
    const started = Date.now();
    const timer = Bun.sleep(20);
    const pending = readRoleLeaseAsync(bucket);
    await timer;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await pending).toEqual({ kind: 'unmeasured', why: 'gcloud timeout (8s)' });
  } finally {
    _setSystemGcloudPathsForTesting(null);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  }
}, 12_000);

test('an absent object differs from an unreadable or malformed lease', async () => {
  expect(await readRoleLeaseAsync(bucket, { run: async () => ({ code: 1, stdout: '', said: 'matched no objects' }) }))
    .toEqual({ kind: 'absent' });
  expect(await readRoleLeaseAsync(bucket, { run: async () => ({ code: 1, stdout: '', said: 'permission denied' }) }))
    .toEqual({ kind: 'unmeasured', why: 'permission denied' });
  const replies = [ok('5'), ok('{'), ok('5')];
  expect(await readRoleLeaseAsync(bucket, { run: async () => replies.shift()! })).toMatchObject({ kind: 'unmeasured' });
});
