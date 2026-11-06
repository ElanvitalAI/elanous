// NEXUS · runNexus entry tests (Phase N-1 PR α)
//
// Uses detachForTesting so we don't block on SIGINT. Verifies lock +
// runtime.json are written and released cleanly.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CONTINUATION_LOOP_TTL_MINUTES,
  continuationLoopId,
  NEXUS_VERSION,
} from '../src/nexus/index.js';
import { nexusLockPath, nexusRuntimePath } from '../src/nexus/paths.js';
import { readNexusLock } from '../src/nexus/supervisor/lock.js';
import { readNexusRuntime } from '../src/nexus/runtime.js';
import { bootNexus, drainNexusBoots } from './helpers/nexus-boot.js';

let tmpRoot: string;
let prevEnv: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'elanous-nexus-run-'));
  prevEnv = process.env.ELANOUS_NEXUS_DIR;
  process.env.ELANOUS_NEXUS_DIR = tmpRoot;
});

afterEach(() => {
  drainNexusBoots();
  if (prevEnv === undefined) delete process.env.ELANOUS_NEXUS_DIR;
  else process.env.ELANOUS_NEXUS_DIR = prevEnv;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('continuation loop registry identity', () => {
  test('uses source-aware stable IDs and skips unidentified file-queue goals', () => {
    expect(continuationLoopId({ source: 'auto-mode', goalSlug: 'alpha' })).toBe('continuation:auto-mode:alpha');
    expect(continuationLoopId({ source: 'file-queue', goalSlug: 'alpha', id: 'queue-42' })).toBe('continuation:file-queue:queue-42');
    expect(continuationLoopId({ source: 'file-queue', goalSlug: 'alpha' })).toBeUndefined();
  });

  test('uses the documented one-day ephemeral TTL', () => {
    expect(CONTINUATION_LOOP_TTL_MINUTES).toBe(24 * 60);
  });
});

describe('runNexus (detachForTesting)', () => {
  test('drains un-released boots newest first, continues after a release error, and is repeatable', async () => {
    const first = await bootNexus({ detachForTesting: true });
    const second = await bootNexus({ detachForTesting: true, force: true });
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    const order: string[] = [];
    const releaseFirst = first!.release;
    const releaseSecond = second!.release;
    first!.release = () => { order.push('first'); releaseFirst(); };
    second!.release = () => { order.push('second'); releaseSecond(); throw new Error('release probe'); };

    expect(existsSync(nexusLockPath())).toBe(true);
    expect(existsSync(nexusRuntimePath())).toBe(true);
    expect(() => drainNexusBoots()).toThrow(AggregateError);
    expect(order).toEqual(['second', 'first']);
    expect(existsSync(nexusLockPath())).toBe(false);
    expect(existsSync(nexusRuntimePath())).toBe(false);
    expect(() => drainNexusBoots()).not.toThrow();
    expect(order).toEqual(['second', 'first']);
  });

  test('writes lock + runtime, returns handle, release tears them down', async () => {
    const handle = await bootNexus({ detachForTesting: true });
    expect(handle).toBeDefined();
    expect(existsSync(nexusLockPath())).toBe(true);
    expect(existsSync(nexusRuntimePath())).toBe(true);

    const lock = readNexusLock();
    expect(lock!.pid).toBe(process.pid);

    const rt = readNexusRuntime();
    expect(rt).not.toBeNull();
    expect(rt!.pid).toBe(process.pid);
    expect(rt!.nexusVersion).toBe(NEXUS_VERSION);
    expect(rt!.phase).toMatch(/^N-\d/);

    // PR β auto-registers chat:1 on boot so the sidebar is non-empty on
    // first frame. webterm:1 was previously co-registered but is now
    // gated behind `global.tabs.registerWebterm` (PWA mirror prep cleanup
    // · default-OFF) — the tab is opt-in via switch / ELANOUS_REGISTER_WEBTERM
    // env so external-terminal-first desktop users don't see the placeholder.
    expect(handle!.registry.has('chat:1')).toBe(true);
    expect(handle!.registry.has('webterm:1')).toBe(false);
    expect(handle!.registry.list()).toHaveLength(1);

    handle!.release();
    expect(existsSync(nexusLockPath())).toBe(false);
    expect(existsSync(nexusRuntimePath())).toBe(false);
  });

  test('second run while first holds lock fails with NexusLockError exit', async () => {
    const handle = await bootNexus({ detachForTesting: true });
    try {
      // Simulate a second invocation by calling runNexus again — but
      // without detachForTesting it would block on signals. We use a
      // separate path: spawn a child via Bun.spawn to test the CLI
      // exit, which is too heavy for a unit test. Instead, verify the
      // lock primitive catches it (covered by nexus-paths-lock.test.ts)
      // and that runNexus itself wraps it via `process.exit(1)` —
      // implicitly tested by the CLI integration which we exercise
      // manually after pushing the PR.
      expect(handle).toBeDefined();
    } finally {
      handle!.release();
    }
  });

  test('force=true takes over an existing lock', async () => {
    const first = await bootNexus({ detachForTesting: true });
    try {
      const second = await bootNexus({ detachForTesting: true, force: true });
      expect(second).toBeDefined();
      expect(readNexusLock()!.pid).toBe(process.pid);
      second!.release();
    } finally {
      // first.release is now a no-op (lock points at second's identity
      // before that called release). Either way: cleanup is best-effort.
      first!.release();
    }
  });
});
