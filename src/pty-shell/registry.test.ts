import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mintPtyId,
  ptyKindOf,
  resetForTesting,
  setPtyAdapterForTesting,
  startPty,
  type StartOpts,
} from './registry.js';
import { ptyIdSeparatorIndex, resolvePtyRef } from './pty-ref.js';
import { getPtyManifest, setPtyManifestDbPathForTesting } from './pty-manifest.js';
import { readPtyEventsAfter, resetPtyEventLogForTesting } from './pty-event-log.js';

function stubAdapter() {
  return {
    pid: 1,
    write() {},
    kill() {},
    onData: () => ({ dispose() {} }),
    onExit: () => ({ dispose() {} }),
  };
}

/** Adapter whose onData/onExit callbacks the test can fire — the registry's own
 *  production handlers are what must record the ledger rows, so the stage only
 *  plays the OS: it delivers output and an exit code. */
function controllableAdapter() {
  const callbacks: {
    data?: (chunk: string) => void;
    exit?: (e: { exitCode: number | null; signal?: number }) => void;
  } = {};
  return {
    emitData(chunk: string): void { callbacks.data?.(chunk); },
    emitExit(e: { exitCode: number | null; signal?: number }): void { callbacks.exit?.(e); },
    adapter: {
      pid: 4242,
      write() {},
      kill() {},
      onData(cb: (chunk: string) => void) { callbacks.data = cb; return { dispose() {} }; },
      onExit(cb: (e: { exitCode: number | null; signal?: number }) => void) { callbacks.exit = cb; return { dispose() {} }; },
    },
  };
}

function lifecyclePayloads(surfaceId: string): Map<string, Record<string, unknown>> {
  const byEvent = new Map<string, Record<string, unknown>>();
  for (const row of readPtyEventsAfter(0, { surfaceId, kind: 'lifecycle' })) {
    const payload = row.payload === null ? {} : JSON.parse(row.payload) as Record<string, unknown>;
    byEvent.set(String(payload.event), payload);
  }
  return byEvent;
}

afterEach(() => {
  resetForTesting();
  setPtyAdapterForTesting(null);
});

describe('PTY ID separator compatibility', () => {
  test('uses the first underscore or hyphen consistently for kind and suffix resolution', () => {
    expect(ptyIdSeparatorIndex('codex_a3f2')).toBe(5);
    expect(ptyIdSeparatorIndex('codex-a3f2')).toBe(5);
    expect(ptyIdSeparatorIndex('codex-a3_f2')).toBe(5);
    expect(ptyKindOf('codex_a3f2')).toBe('codex');
    expect(ptyKindOf('codex-a3f2')).toBe('codex');

    const items = [
      { id: 'codex_a3f2b1c4', kind: 'codex' },
      { id: 'shell-11223344', kind: 'shell' },
      { id: 'mix-a3_f2b1c4', kind: 'mix' },
    ];
    expect(resolvePtyRef('a3f2', items).match?.id).toBe('codex_a3f2b1c4');
    expect(resolvePtyRef('1122', items).match?.id).toBe('shell-11223344');
    expect(resolvePtyRef('a3_f2', items).match?.id).toBe('mix-a3_f2b1c4');
  });

  test('preserves separator-free and colon namespace handling', () => {
    expect(ptyIdSeparatorIndex('codex')).toBe(-1);
    expect(ptyIdSeparatorIndex('codex:a3f2b1c4')).toBe(-1);
    expect(ptyKindOf('codex')).toBe('pty');
    expect(ptyKindOf('codex:a3f2b1c4')).toBe('pty');
  });

  test('accepts underscore and hyphen preallocated canonical IDs but rejects colon IDs', () => {
    setPtyAdapterForTesting(() => stubAdapter());
    expect(() => startPty({ id: 'codex_a3f2b1c4', kind: 'codex', cmd: 'x', detach: true } as StartOpts)).not.toThrow();
    expect(() => startPty({ id: 'shell-11223344', kind: 'shell', cmd: 'x', detach: true } as StartOpts)).not.toThrow();
    expect(() => startPty({ id: 'a-b_a3f2b1c4', kind: 'a-b', cmd: 'x', detach: true } as StartOpts)).not.toThrow();
    expect(() => startPty({ id: 'codex:a3f2b1c4', kind: 'codex', cmd: 'x', detach: true } as StartOpts))
      .toThrow(/invalid preallocated PTY id/);
  });

  test('requires an exact literal kind prefix for preallocated IDs', () => {
    setPtyAdapterForTesting(() => stubAdapter());
    expect(() => startPty({ id: 'ab_a3f2b1c4', kind: 'a-b', cmd: 'x', detach: true } as StartOpts))
      .toThrow(/invalid preallocated PTY id/);
  });

  test('continues minting underscore IDs', () => {
    expect(mintPtyId('codex')).toMatch(/^codex_[0-9a-f]{8}$/);
  });
});

describe('TUI-SEAT-PILOT-REGISTRY-LIFECYCLE', () => {
  test(
    'startPty lifecycle emits manifest & pty-event-log spawned/exited rows with seatId, cumulative outputBytesTotal, and exitCode (normal + error exit)',
    async () => {
      // Dynamic import on purpose: a static import of this new export would fail module
      // resolution on sources that predate it, hiding the behavioral red behind a load error.
      const registryModule = await import('./registry.js');
      expect(typeof registryModule.setPtyManifestEnabledForTesting).toBe('function');
      const stateDir = mkdtempSync(join(tmpdir(), 'pty-seat-lifecycle-'));
      const previousStateDir = process.env.ELANOUS_STATE_DIR;
      process.env.ELANOUS_STATE_DIR = stateDir;
      // 격리 우주 — 전용 manifest db + 전용 events.db(같은 ELANOUS_STATE_DIR)만 만진다.
      setPtyManifestDbPathForTesting(join(stateDir, 'pty', 'manifest.db'));
      resetPtyEventLogForTesting();
      registryModule.setPtyManifestEnabledForTesting(true);

      const seat = 'seat-pilot-1';
      const output = 'seat-pilot lifecycle\n';
      const expectedBytes = Buffer.byteLength(output, 'utf8');
      // 정상 1건(exitCode 0) · 오류 1건(exitCode 7) — 같은 seatId 하나가 두 흐름에 실린다.
      const runs: ReadonlyArray<{ id: string; exitCode: number | null }> = [
        { id: 'seatpilot_a1b2c3d4', exitCode: 0 },
        { id: 'seatpilot_5e6f7a8b', exitCode: 7 },
      ];

      try {
        for (const run of runs) {
          const stage = controllableAdapter();
          setPtyAdapterForTesting(() => stage.adapter);
          const handle = startPty({
            id: run.id,
            kind: 'seatpilot',
            cmd: 'seat-pilot-placeholder',
            seat,
            detach: true,
          } as StartOpts);
          expect(handle.id).toBe(run.id);

          stage.emitData('seat-pilot ');
          stage.emitData('lifecycle\n');
          stage.emitExit({ exitCode: run.exitCode });

          const row = getPtyManifest(run.id);
          expect(row?.seat).toBe(seat);
          expect(row?.outputBytesTotal).toBe(expectedBytes);
          expect(row?.exitCode).toBe(run.exitCode);

          const events = lifecyclePayloads(run.id);
          expect([...events.keys()].sort()).toEqual(['exited', 'spawned']);

          const spawned = events.get('spawned')!;
          expect(spawned.seat).toBe(seat);
          expect(spawned.outputBytesTotal).toBe(0);
          expect(spawned.exitCode).toBeNull();

          const exited = events.get('exited')!;
          expect(exited.seat).toBe(seat);
          expect(exited.outputBytesTotal).toBe(expectedBytes);
          expect(exited.exitCode).toBe(run.exitCode);

          console.log('[seat-lifecycle]', JSON.stringify({
            ptyId: run.id,
            manifest: { seat: row?.seat, outputBytesTotal: row?.outputBytesTotal, exitCode: row?.exitCode },
            spawned: { seat: spawned.seat, outputBytesTotal: spawned.outputBytesTotal, exitCode: spawned.exitCode },
            exited: { seat: exited.seat, outputBytesTotal: exited.outputBytesTotal, exitCode: exited.exitCode },
          }));
        }
      } finally {
        registryModule.setPtyManifestEnabledForTesting(null);
        setPtyManifestDbPathForTesting(null);
        resetPtyEventLogForTesting();
        if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
        else process.env.ELANOUS_STATE_DIR = previousStateDir;
        rmSync(stateDir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
