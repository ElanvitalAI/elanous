// NEXUS terminal HITL channel — β-1d · 2026-05-08.
//
// Closes the β-1 cascade. Pairs with the three sibling tests
// (pushcut/pwa/telegram/discord); only the activation gate
// differs — terminal needs `headless` mode + isTTY (or forceEnable
// in tests).
//
// What this file proves:
//   1. createNexusTerminalHitlDeps returns null when isTTY=false
//      and forceEnable=false (the production no-op path).
//   2. With forceEnable=true + injected streams, deps wire up + a
//      `y` line resolves true; `n` resolves false; garbage resolves
//      null.
//   3. clear() releases the readline + resolves any pending
//      awaitAnswer with null (channel cancel race).
//   4. createNexusTerminalHitlChannel returns null on gate fail,
//      ConfirmChannel{name:'terminal'} otherwise.
//   5. runNexus({ headless:true, terminalHitlOpts:{forceEnable:true,
//      stdin, stdout } }) registers a 'terminal' channel.
//   6. skipTerminalChannel:true forces skip.
//   7. Without headless and without forceEnable, the channel is NOT
//      registered (TUI mode default).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';

import { runNexus, type RunNexusHandle } from '../src/nexus/index.js';
import {
  getDefaultConfirmChannels,
  registerDefaultConfirmChannels,
} from '../src/hitl/confirm.js';
import {
  createNexusTerminalHitlChannel,
  createNexusTerminalHitlDeps,
} from '../src/nexus/api/hitl-terminal-channel.js';
import { setIntakeStoreForTest } from '../src/intake-plane/runtime.js';
import { createIntakeStore } from '../src/intake-plane/store.js';
import { createStubPwaVoiceAdapter } from '../src/voice/channel-adapters/pwa-voice-adapter.js';

let tmpRoot: string;
let prevNexusDir: string | undefined;
let prevHome: string | undefined;
let activeHandle: RunNexusHandle | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'elanous-nexus-hitl-tt-'));
  prevNexusDir = process.env.ELANOUS_NEXUS_DIR;
  prevHome = process.env.HOME;
  process.env.ELANOUS_NEXUS_DIR = tmpRoot;
  process.env.HOME = tmpRoot;
  setIntakeStoreForTest(createIntakeStore({ archiveDir: null, replayOnInit: false }));
  registerDefaultConfirmChannels([]);
});

afterEach(async () => {
  if (activeHandle) {
    try { activeHandle.release(); } catch { /* swallow */ }
    activeHandle = undefined;
  }
  if (prevNexusDir === undefined) delete process.env.ELANOUS_NEXUS_DIR;
  else process.env.ELANOUS_NEXUS_DIR = prevNexusDir;
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  setIntakeStoreForTest(null);
  registerDefaultConfirmChannels([]);
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* swallow */ }
});

function uniquePort(): number {
  return 59000 + Math.floor(Math.random() * 2000);
}

interface FakeStreams {
  stdin: Readable & { isTTY?: boolean };
  stdout: Writable;
  stdoutChunks: string[];
  pushLine: (line: string) => void;
}

function makeFakeStreams(): FakeStreams {
  const chunks: string[] = [];
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  // Readable in object/text mode that we can push lines into.
  const stdin = new Readable({ read() { /* manual push */ } });
  return {
    stdin: stdin as Readable & { isTTY?: boolean },
    stdout,
    stdoutChunks: chunks,
    pushLine: (line: string) => stdin.push(`${line}\n`),
  };
}

async function bootNexus(extra: Parameters<typeof runNexus>[0] = {}): Promise<RunNexusHandle> {
  const handle = await runNexus({
    detachForTesting: true,
    skipHttpServer: true,
    skipRuntimeApi: false,
    skipSupervisor: true,
    registerDaemonTab: false,
    registerSettingsTab: false,
    httpStartPort: uniquePort(),
    voiceAdapter: createStubPwaVoiceAdapter(),
    toolCwd: tmpRoot,
    ...extra,
  });
  if (!handle) throw new Error('runNexus returned undefined');
  activeHandle = handle;
  return handle;
}

describe('createNexusTerminalHitlDeps · gate + IO contract', () => {
  test('returns null when stdin.isTTY=false and no forceEnable', () => {
    const f = makeFakeStreams();
    expect(createNexusTerminalHitlDeps({ stdin: f.stdin, stdout: f.stdout })).toBeNull();
  });

  test('returns deps when forceEnable=true', () => {
    const f = makeFakeStreams();
    const deps = createNexusTerminalHitlDeps({
      stdin: f.stdin,
      stdout: f.stdout,
      forceEnable: true,
    });
    expect(deps).not.toBeNull();
    expect(typeof deps!.show).toBe('function');
    expect(typeof deps!.clear).toBe('function');
    expect(typeof deps!.awaitAnswer).toBe('function');
  });

  test('show() writes a prompt block to stdout (prompt + detail + y/n hint)', () => {
    const f = makeFakeStreams();
    const deps = createNexusTerminalHitlDeps({
      stdin: f.stdin,
      stdout: f.stdout,
      forceEnable: true,
    })!;
    deps.show({
      prompt: 'Approve file edit?',
      detail: 'src/foo.ts',
      yesLabel: 'Approve',
      noLabel: 'Deny',
    });
    const written = f.stdoutChunks.join('');
    expect(written).toContain('Approve file edit?');
    expect(written).toContain('src/foo.ts');
    expect(written).toContain('Approve (y) / Deny (n)');
  });

  test('awaitAnswer resolves true on "y" / "yes" (case-insensitive)', async () => {
    const f = makeFakeStreams();
    const deps = createNexusTerminalHitlDeps({
      stdin: f.stdin,
      stdout: f.stdout,
      forceEnable: true,
    })!;
    const p = deps.awaitAnswer();
    f.pushLine('y');
    await expect(p).resolves.toBe(true);

    const f2 = makeFakeStreams();
    const deps2 = createNexusTerminalHitlDeps({
      stdin: f2.stdin,
      stdout: f2.stdout,
      forceEnable: true,
    })!;
    const p2 = deps2.awaitAnswer();
    f2.pushLine('YES');
    await expect(p2).resolves.toBe(true);
  });

  test('awaitAnswer resolves false on "n" / "no"', async () => {
    const f = makeFakeStreams();
    const deps = createNexusTerminalHitlDeps({
      stdin: f.stdin,
      stdout: f.stdout,
      forceEnable: true,
    })!;
    const p = deps.awaitAnswer();
    f.pushLine('no');
    await expect(p).resolves.toBe(false);
  });

  test('awaitAnswer resolves null on garbage input (channel opts out)', async () => {
    const f = makeFakeStreams();
    const deps = createNexusTerminalHitlDeps({
      stdin: f.stdin,
      stdout: f.stdout,
      forceEnable: true,
    })!;
    const p = deps.awaitAnswer();
    f.pushLine('maybe');
    await expect(p).resolves.toBeNull();
  });

  test('clear() resolves a pending awaitAnswer with null', async () => {
    const f = makeFakeStreams();
    const deps = createNexusTerminalHitlDeps({
      stdin: f.stdin,
      stdout: f.stdout,
      forceEnable: true,
    })!;
    const p = deps.awaitAnswer();
    deps.clear();
    await expect(p).resolves.toBeNull();
  });

  // β-1 dismiss polish (2026-05-08) — sibling-channel-wins UX.
  describe('clear() · ANSI erase polish', () => {
    test('emits cursor-up + line-erase escapes on a TTY-like stdout', () => {
      const f = makeFakeStreams();
      // Mark the fake stdout as a TTY so the ANSI erase activates.
      // (forceEnable on the deps factory also enables it, see test
      // below.)
      (f.stdout as unknown as { isTTY?: boolean }).isTTY = true;
      const deps = createNexusTerminalHitlDeps({
        stdin: f.stdin,
        stdout: f.stdout,
        forceEnable: true,
      })!;
      deps.show({
        prompt: 'Approve?',
        detail: 'src/foo.ts',
      });
      const showWritten = f.stdoutChunks.join('');
      // 5 lines printed: blank · header · prompt · detail · prompt-row
      // (4 \n separators between them since join, no trailing \n)
      const newlineCount = (showWritten.match(/\n/g) ?? []).length;
      expect(newlineCount).toBe(4);

      const beforeClear = f.stdoutChunks.length;
      deps.clear();
      const afterClear = f.stdoutChunks.slice(beforeClear).join('');
      // Expect at least one \x1b[2K (erase line) escape sequence.
      expect(afterClear).toContain('\x1b[2K');
      expect(afterClear).toContain('\x1b[1A'); // cursor up at least once
    });

    test('falls back to plain newline when stdout is NOT a TTY (and disableAnsiErase set)', () => {
      const f = makeFakeStreams();
      // stdout.isTTY left undefined, AND disableAnsiErase=true so
      // forceEnable doesn't override the gate.
      const deps = createNexusTerminalHitlDeps({
        stdin: f.stdin,
        stdout: f.stdout,
        forceEnable: true,
        disableAnsiErase: true,
      })!;
      deps.show({ prompt: 'OK?' });
      const beforeClear = f.stdoutChunks.length;
      deps.clear();
      const afterClear = f.stdoutChunks.slice(beforeClear).join('');
      expect(afterClear).not.toContain('\x1b[');
      expect(afterClear).toBe('\n');
    });

    test('show without preceding clear → second show overwrites lastShowLineCount', () => {
      const f = makeFakeStreams();
      (f.stdout as unknown as { isTTY?: boolean }).isTTY = true;
      const deps = createNexusTerminalHitlDeps({
        stdin: f.stdin,
        stdout: f.stdout,
        forceEnable: true,
      })!;
      // First show: 4 lines (no detail)
      deps.show({ prompt: 'A?' });
      // Second show: 5 lines (with detail). The lastShowLineCount
      // should track the most recent paint.
      deps.show({ prompt: 'B?', detail: 'extra' });
      const beforeClear = f.stdoutChunks.length;
      deps.clear();
      const afterClear = f.stdoutChunks.slice(beforeClear).join('');
      // 5 lines → 4 cursor-ups + final erase. Count `\x1b[1A`.
      const ups = (afterClear.match(/\x1b\[1A/g) ?? []).length;
      expect(ups).toBe(4);
    });

    test('clear with no prior show is a single newline (lastShowLineCount=0)', () => {
      const f = makeFakeStreams();
      (f.stdout as unknown as { isTTY?: boolean }).isTTY = true;
      const deps = createNexusTerminalHitlDeps({
        stdin: f.stdin,
        stdout: f.stdout,
        forceEnable: true,
      })!;
      deps.clear();
      const written = f.stdoutChunks.join('');
      expect(written).toBe('\n');
    });
  });
});

describe('createNexusTerminalHitlChannel', () => {
  test('returns null when gate fails', () => {
    const f = makeFakeStreams();
    expect(createNexusTerminalHitlChannel({ stdin: f.stdin, stdout: f.stdout })).toBeNull();
  });

  test('returns ConfirmChannel{name:"terminal"} when gate passes', () => {
    const f = makeFakeStreams();
    const ch = createNexusTerminalHitlChannel({
      stdin: f.stdin,
      stdout: f.stdout,
      forceEnable: true,
    });
    expect(ch).not.toBeNull();
    expect(ch!.name).toBe('terminal');
  });
});

describe('runNexus terminal channel integration', () => {
  test('default boot (TUI mode + no forceEnable) does NOT register terminal', async () => {
    await bootNexus();
    const names = getDefaultConfirmChannels().map((c) => c.name);
    expect(names).not.toContain('terminal');
  });

  test('terminalHitlOpts.forceEnable + injected streams → channel registers', async () => {
    const f = makeFakeStreams();
    await bootNexus({
      terminalHitlOpts: {
        stdin: f.stdin,
        stdout: f.stdout,
        forceEnable: true,
      },
    });
    const names = getDefaultConfirmChannels().map((c) => c.name);
    expect(names).toContain('terminal');
  });

  test('skipTerminalChannel:true forces skip even with forceEnable', async () => {
    const f = makeFakeStreams();
    await bootNexus({
      skipTerminalChannel: true,
      terminalHitlOpts: {
        stdin: f.stdin,
        stdout: f.stdout,
        forceEnable: true,
      },
    });
    const names = getDefaultConfirmChannels().map((c) => c.name);
    expect(names).not.toContain('terminal');
  });

  test('release() unregisters terminal alongside siblings', async () => {
    const f = makeFakeStreams();
    const h = await bootNexus({
      terminalHitlOpts: {
        stdin: f.stdin,
        stdout: f.stdout,
        forceEnable: true,
      },
    });
    expect(getDefaultConfirmChannels().map((c) => c.name)).toContain('terminal');
    // release() became async in #36421 (Guardian train worker lifecycle
    // awaits before the confirm-channel clearing); the registry is only
    // empty once the returned promise settles.
    await h.release();
    activeHandle = undefined;
    expect(getDefaultConfirmChannels()).toHaveLength(0);
  });

  test('skipRuntimeApi:true short-circuits the terminal wire-up too', async () => {
    const f = makeFakeStreams();
    await bootNexus({
      skipRuntimeApi: true,
      terminalHitlOpts: {
        stdin: f.stdin,
        stdout: f.stdout,
        forceEnable: true,
      },
    });
    expect(getDefaultConfirmChannels()).toHaveLength(0);
  });
});
