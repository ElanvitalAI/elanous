import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunScopedWarmControlForward, startWarmControlPortForward } from './warm-control-forward.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fakeKubectl(body: string): { root: string; bin: string } {
  const root = mkdtempSync(join(tmpdir(), 'warm-control-forward-'));
  roots.push(root);
  const bin = join(root, 'kubectl');
  writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  chmodSync(bin, 0o700);
  return { root, bin };
}

describe('warm control port-forward', () => {
  it('shares one failed start within a run but retries from a fresh run lifecycle', async () => {
    let firstAttempts = 0;
    const failedRun = createRunScopedWarmControlForward(async () => {
      firstAttempts++;
      throw new Error('transient start failure');
    });
    await expect(failedRun.ensure()).rejects.toThrow('transient start failure');
    await expect(failedRun.ensure()).rejects.toThrow('transient start failure');
    expect(firstAttempts).toBe(1);
    await failedRun.stop();

    let nextRunAttempts = 0;
    const nextRun = createRunScopedWarmControlForward(async () => {
      nextRunAttempts++;
      return { url: 'http://127.0.0.1:31413/', stop: async () => {} };
    });
    await expect(nextRun.ensure()).resolves.toMatchObject({ url: 'http://127.0.0.1:31413/' });
    expect(nextRunAttempts).toBe(1);
    await nextRun.stop();
  });

  it('binds only loopback and stops its owned process', async () => {
    const state = join(tmpdir(), `warm-forward-state-${process.pid}-${Date.now()}`);
    const fake = fakeKubectl(`
last=''
for arg do last="$arg"; done
local_port="${'${last%%:*}'}"
remote_port="${'${last#*:}'}"
printf '%s\n' "$@" > '${state}'
printf 'Forwarding from 127.0.0.1:%s -> %s\n' "$local_port" "$remote_port"
trap 'exit 0' TERM INT
while :; do sleep 1; done`);
    let stop: (() => Promise<void>) | undefined;
    try {
      const forward = await startWarmControlPortForward({ context: 'k3d-test', namespace: 'elanous-test',
        service: 'elanous-control', remotePort: 31413, kubectl: fake.bin });
      stop = forward.stop;
      expect(forward.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      const args = readFileSync(state, 'utf8').trim().split(/\r?\n/);
      expect(args[args.indexOf('--address') + 1]).toBe('127.0.0.1');
      expect(args).toContain('service/elanous-control');
      expect(args.at(-1)?.split(':')[1]).toBe('31413');
    } finally {
      if (stop) await stop();
      rmSync(state, { force: true });
    }
  });

  it('retries once when the reserved ephemeral port is claimed before kubectl binds it', async () => {
    const state = join(tmpdir(), `warm-forward-collision-${process.pid}-${Date.now()}`);
    const fake = fakeKubectl(`
count=0
if [ -f '${state}' ]; then count=$(cat '${state}'); fi
count=$((count + 1))
printf '%s' "$count" > '${state}'
if [ "$count" -eq 1 ]; then echo 'unable to listen: address already in use' >&2; exit 1; fi
last=''
for arg do last="$arg"; done
local_port="${'${last%%:*}'}"
remote_port="${'${last#*:}'}"
printf 'Forwarding from 127.0.0.1:%s -> %s\n' "$local_port" "$remote_port"
trap 'exit 0' TERM INT
while :; do sleep 1; done`);
    try {
      const forward = await startWarmControlPortForward({ context: 'k3d-test', namespace: 'elanous-test',
        service: 'elanous-control', remotePort: 31413, kubectl: fake.bin });
      await forward.stop();
      expect(readFileSync(state, 'utf8')).toBe('2');
    } finally { rmSync(state, { force: true }); }
  });
});
