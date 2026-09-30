import { afterEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';

import {
  iphoneTransfer,
  servePushcutFiles,
  type IphoneTransferDeps,
} from '../src/transfer/iphone-transfer.js';
import type { TransferTarget } from '../src/transfer/transfer-targets.js';
import type { PushcutClient } from '../src/pushcut/client.js';

afterEach(() => {
  // No global state in iphone-transfer itself; pushcut singleton
  // reset is the caller's responsibility — we use injected deps
  // exclusively.
});

function mkFakeSpawn(behavior: (cmd: string, args: string[]) => { code: number; stderr?: string }): IphoneTransferDeps['spawnImpl'] {
  return ((cmd: string, args: string[]) => {
    const ee = new EventEmitter() as EventEmitter & {
      stderr: { on: EventEmitter['on'] }; kill: () => void;
    };
    ee.stderr = { on: (_evt, _cb) => ee } as never;
    ee.kill = () => {};
    setImmediate(() => {
      const r = behavior(cmd, args);
      ee.emit('close', r.code);
    });
    return ee;
  }) as never;
}

function mkPushcut(configured: boolean, captureNotify?: (name: string, payload: unknown) => void): PushcutClient {
  const notified: Array<{ name: string; payload: unknown }> = [];
  return {
    configured,
    notify: async (name, payload) => {
      notified.push({ name, payload });
      captureNotify?.(name, payload);
      return configured ? { ok: true } : { ok: false, reason: 'no-config' };
    },
    callShortcut: async () => ({ ok: false, reason: 'not-tested' }),
    _calls: notified,
  } as unknown as PushcutClient;
}

function mkFile(body: string): { localPath: string; size: number } {
  const dir = mkdtempSync(joinPath(tmpdir(), 'elanous-iphone-xfer-'));
  const path = joinPath(dir, 'sample.bin');
  writeFileSync(path, body, 'utf-8');
  return { localPath: path, size: Buffer.byteLength(body) };
}

describe('iphoneTransfer — tailscale path', () => {
  test('succeeds when tailscale probe + cp both pass', async () => {
    const target: TransferTarget = {
      kind: 'iphone',
      name: 'My iPhone',
      tailscaleHost: 'iphone.ts.net',
      pushcutName: 'elanous-file-received',
    };
    const file = mkFile('hello');
    const r = await iphoneTransfer({
      target, files: [file],
      deps: {
        tailscaleAvailable: () => true,
        spawnImpl: mkFakeSpawn(() => ({ code: 0 })),
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.transport).toBe('tailscale');
      expect(r.uploaded).toEqual([file.localPath]);
    }
  });

  test('falls back to pushcut when tailscale probe fails', async () => {
    const target: TransferTarget = {
      kind: 'iphone',
      name: 'x',
      tailscaleHost: 'iphone.ts.net',
      pushcutName: 'elanous-file-received',
    };
    const file = mkFile('hello');
    const pushcut = mkPushcut(true);
    const r = await iphoneTransfer({
      target, files: [file],
      tokenBytes: 8, bindPort: 0,
      deps: {
        tailscaleAvailable: () => false,
        pushcutClient: pushcut,
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.transport).toBe('pushcut');
      expect(r.pushcutUrls?.length).toBe(1);
    }
  });

  test('surfaces tailscale cp error', async () => {
    const target: TransferTarget = {
      kind: 'iphone', name: 'x', tailscaleHost: 'iphone.ts.net',
    };
    const file = mkFile('x');
    const r = await iphoneTransfer({
      target, files: [file],
      deps: {
        tailscaleAvailable: () => true,
        spawnImpl: mkFakeSpawn(() => ({ code: 1, stderr: 'tail drop denied' })),
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('tailscale-failed');
  });
});

describe('iphoneTransfer — pushcut path', () => {
  test('pushcut when no tailscaleHost configured', async () => {
    const target: TransferTarget = {
      kind: 'iphone', name: 'x', pushcutName: 'elanous-file-received',
    };
    const file = mkFile('abc');
    const pushcut = mkPushcut(true);
    const r = await iphoneTransfer({
      target, files: [file], tokenBytes: 8, bindPort: 0,
      deps: { pushcutClient: pushcut },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.transport).toBe('pushcut');
      expect(r.pushcutUrls?.length).toBe(1);
      expect(r.pushcutUrls![0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/xfer\/[a-f0-9]+\/sample\.bin$/);
    }
  });

  test('no-transport when neither tailscale nor pushcut configured', async () => {
    const target: TransferTarget = {
      kind: 'iphone', name: 'empty',
    };
    const file = mkFile('x');
    const r = await iphoneTransfer({
      target, files: [file],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no-transport');
  });

  test('config-missing when pushcut not configured', async () => {
    const target: TransferTarget = {
      kind: 'iphone', name: 'x', pushcutName: 'elanous-file-received',
    };
    const file = mkFile('x');
    const pushcut = mkPushcut(false);
    const r = await iphoneTransfer({
      target, files: [file], tokenBytes: 8, bindPort: 0,
      deps: { pushcutClient: pushcut },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('config-missing');
  });
});

describe('servePushcutFiles', () => {
  test('serves a file over HTTP under its token URL', async () => {
    const file = mkFile('hello from server');
    const served = await servePushcutFiles([file], {
      tokenBytes: 8, bindHost: '127.0.0.1', bindPort: 0, serveTimeoutMs: 60_000,
    });
    expect('urls' in served).toBe(true);
    if ('urls' in served) {
      expect(served.urls.length).toBe(1);
      const res = await fetch(served.urls[0]!);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toBe('hello from server');
      await served.stop();
    }
  });

  test('unknown token returns 404', async () => {
    const file = mkFile('x');
    const served = await servePushcutFiles([file], {
      tokenBytes: 8, bindHost: '127.0.0.1', bindPort: 0, serveTimeoutMs: 60_000,
    });
    if ('urls' in served) {
      const base = served.urls[0]!.split('/xfer/')[0];
      const res = await fetch(`${base}/xfer/deadbeef/x`);
      expect(res.status).toBe(404);
      await served.stop();
    }
  });

  test('stop() closes the server', async () => {
    const file = mkFile('x');
    const served = await servePushcutFiles([file], {
      tokenBytes: 4, bindHost: '127.0.0.1', bindPort: 0, serveTimeoutMs: 60_000,
    });
    if ('urls' in served) {
      await served.stop();
      try {
        const res = await fetch(served.urls[0]!, { signal: AbortSignal.timeout(200) });
        // If we get here, the server was still up — that's a failure.
        expect(res.status).toBeUndefined();
      } catch (error) {
        // Expected: server is closed, connect refused.
        expect(error).toBeInstanceOf(TypeError);
      }
    }
  });
});
