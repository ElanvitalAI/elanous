import { describe, expect, test, afterEach } from 'bun:test';
import { Command } from 'commander';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PtyControlResult } from '../pty-shell/pty-control-ipc.js';

process.env.ELANOUS_STATE_DIR = mkdtempSync(join(tmpdir(), 'pty-drive-'));

const { runPtyDrive, runDriveCliCommand, runPtyAttachDrive, registerPtyAttachDriveCommand, ptyListReportsAlive, stripScopeArgs, withScopeArgs } = await import('./pty-drive-cli.js');
const { controlDepsForRemoteRef } = await import('../autopilot/pty-control-loop.js');
const { registerPtyTakeoverCommands } = await import('./pty-takeover-cli.js');
const { buildDevCliSpec } = await import('../self-dev/dev-cli.js');
const { planDevPipeline } = await import('../self-dev/dev-pipeline.js');
const { debug } = await import('../debug/log.js');
const { KNOWN_LOG_EVENT_NAMES } = await import('./log-event-names.js');
const { setElanousConfigDir, resetElanousConfigDir } = await import('../elanous-config-dir.js');
const { effectiveInstanceRoot, resetEffectiveInstanceRoot } = await import('../instance/resolve.js');
const { setPtyAdapterForTesting, getPty, listPty, unregisterPty } = await import('../pty-shell/registry.js');

afterEach(() => {
  for (const pty of listPty()) {
    try { pty.kill(); } catch { /* noop */ }
    unregisterPty(pty.id);
  }
  setPtyAdapterForTesting(null);
});

function mockAdapter(writes: string[], onKill: () => void, onExit?: (emit: (event: { exitCode: number | null; signal?: number }) => void) => void, output?: string) {
  return {
    pid: 3, write: (s: string) => { writes.push(s); }, kill: onKill, resize: () => {},
    onData: (callback: (data: string) => void) => { if (output) queueMicrotask(() => callback(output)); return { dispose() {} }; }, onExit: (callback: (event: { exitCode: number | null; signal?: number }) => void) => {
      onExit?.(callback);
      return { dispose() {} };
    },
  };
}

describe('runPtyAttachDrive (existing PTY control-axis handler)', () => {
  const handle = (over: Partial<import('../pty-shell/registry.js').PtyHandle> = {}) => ({
    id: 'pty_target', kind: 'shell', nickname: 'target', accessMode: 'auto' as const,
    isAlive: () => true,
    ...over,
  }) as import('../pty-shell/registry.js').PtyHandle;

  test('resolves id and nickname, then passes the local agent-owned handle to the shared control loop without spawning', async () => {
    const target = handle();
    let received: unknown;
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    const result = await runPtyAttachDrive('target', { goal: 'finish', maxSteps: 3, pollMs: 0, stream: async () => '{"action":"done","reason":"done"}', out: () => {} }, {
      listPty: () => [target], getPty: (id) => id === target.id ? target : undefined,
      controlDepsForHandle: (h) => { received = h; return { observe: async () => '7 pass', inject: () => true, input: async () => {} } as never; },
      createBrain: () => ({}) as never,
      runControlLoop: async () => ({ termination: { kind: 'success' }, steps: 1 }) as never,
      log: (event, data) => { events.push({ event, data }); },
    });
    expect(result).toEqual({ exitCode: 0, message: 'pty auto: pty_target success' });
    expect(received).toBe(target);
    expect(events).toEqual([{ event: 'attach-start', data: { id: 'pty_target', ref: 'target', goal: 'finish' } }, { event: 'attach-finish', data: { id: 'pty_target', termination: 'success', steps: 1 } },
      { event: 'attach-verdict', data: { id: 'pty_target', kind: 'success', reason: 'final PTY screen has success evidence' } }]);
  });

  test.each([
    ['bash: build-tool: command not found', 'done-but-failed'],
    ['all set', 'success-unverified'],
  ])('brain «done» with final screen %p is not a success (DRIVE-OK · 10-03 X1)', async (screen, kind) => {
    const target = handle();
    const result = await runPtyAttachDrive('target', { goal: 'finish', maxSteps: 3, pollMs: 0, out: () => {} }, {
      listPty: () => [target], getPty: (id) => id === target.id ? target : undefined,
      controlDepsForHandle: () => ({ observe: async () => screen, inject: () => true }) as never,
      createBrain: () => ({}) as never,
      runControlLoop: async () => ({ termination: { kind: 'success' }, steps: 1 }) as never,
      log: () => {},
    });
    expect(result).toEqual({ exitCode: 1, message: `pty auto: pty_target ${kind}` });
  });

  test('falls back to an alive remote manifest PTY with the default human actor', async () => {
    let remoteCall: unknown;
    let loopDeps: { subjectPtyId?: string } | undefined;
    const result = await runPtyAttachDrive('pty_remote1', { goal: 'finish', out: () => {} }, {
      listPty: () => [], getPty: () => undefined,
      listPtyManifestRows: () => [{ id: 'pty_remote1', kind: 'pty', alive: true }] as never,
      controlDepsForHandle: () => ({}) as never,
      controlDepsForRemoteRef: (id, opts) => { remoteCall = [id, opts]; return { observe: async () => 'build successful', inject: () => true, controlStance: () => 'owned', isAlive: () => true }; },
      createBrain: () => ({}) as never,
      runControlLoop: async (_brain, deps) => { loopDeps = deps; return { termination: { kind: 'success' }, steps: 1 } as never; }, log: () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(remoteCall).toEqual(['pty_remote1', { actor: 'human' }]);
    expect(loopDeps?.subjectPtyId).toBe('pty_remote1');
  });

  test('observes remote snapshots and records denied input as lost without logging text', async () => {
    const calls: unknown[] = [];
    const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
    const deps = controlDepsForRemoteRef('pty_x', { actor: 'human', request: async (...args: unknown[]) => {
      calls.push(args);
      return args[1] === 'snapshot' ? { status: 'success', screen: 'S1' } : { status: 'denied', reason: 'write-arbiter' };
    }, log: (event, data) => logs.push({ event, data }) });
    expect(await deps.observe()).toBe('S1');
    expect(deps.inject('hi')).toBe(true);
    await Bun.sleep(0);
    expect(deps.controlStance?.()).toBe('lost');
    expect(calls[1]).toEqual(['pty_x', 'input-text', { chars: 'hi' }, { actor: 'human' }]);
    expect(logs).toEqual([{ event: 'remote-inject', data: { ptyId: 'pty_x', status: 'denied', reason: 'write-arbiter', bytes: 2 } }]);
  });

  test('updates remote liveness from the last result across unknown-pty recovery statuses', async () => {
    const results = [
      { status: 'unknown-pty' },
      { status: 'success', screen: 'S1' },
      { status: 'unknown-pty' },
      { status: 'denied', reason: 'write-arbiter' },
      { status: 'unknown-pty' },
      { status: 'owner-unreachable' },
    ];
    const deps = controlDepsForRemoteRef('pty_x', {
      actor: 'human',
      request: async () => results.shift() as never,
    });

    expect(await deps.observe()).toBe('');
    expect(deps.isAlive?.()).toBe(false);
    expect(await deps.observe()).toBe('S1');
    expect(deps.isAlive?.()).toBe(true);

    expect(await deps.observe()).toBe('');
    expect(deps.isAlive?.()).toBe(false);
    deps.inject('denied');
    await Bun.sleep(0);
    expect(deps.controlStance?.()).toBe('lost');
    expect(deps.isAlive?.()).toBe(true);

    expect(await deps.observe()).toBe('');
    expect(deps.isAlive?.()).toBe(false);
    deps.inject('unreachable');
    await Bun.sleep(0);
    expect(deps.controlStance?.()).toBe('unknown');
    expect(deps.isAlive?.()).toBe(true);
  });

  test('names missing and ambiguous refs without starting control', async () => {
    const first = handle({ id: 'pty_first', nickname: 'same' });
    const second = handle({ id: 'pty_second', nickname: 'same' });
    let started = 0;
    const deps = {
      listPty: () => [first, second], getPty: () => undefined,
      controlDepsForHandle: () => ({}) as never, createBrain: () => ({}) as never,
      runControlLoop: async () => { started++; return {} as never; }, log: () => {},
    };
    await expect(runPtyAttachDrive('none', { goal: 'x' }, deps)).resolves.toEqual({ exitCode: 1, message: 'pty auto: none was not found' });
    await expect(runPtyAttachDrive('same', { goal: 'x' }, deps)).resolves.toEqual({ exitCode: 1, message: 'pty auto: ambiguous ref same; candidates: pty_first, pty_second' });
    await expect(runPtyAttachDrive(' ', { goal: 'x' }, deps)).resolves.toEqual({ exitCode: 2, message: 'pty auto: <ref> is required' });
    expect(started).toBe(0);
  });

  test('rejects a resolved PTY without agent ownership and never starts control', async () => {
    const target = handle({ accessMode: 'write' });
    let started = 0;
    const result = await runPtyAttachDrive('pty_target', { goal: 'x' }, {
      listPty: () => [target], getPty: () => target, controlDepsForHandle: () => ({}) as never,
      createBrain: () => ({}) as never, runControlLoop: async () => { started++; return {} as never; }, log: () => {},
    });
    expect(result).toEqual({ exitCode: 1, message: 'pty auto: pty_target is not agent-owned (access mode: write); refusing to take ownership' });
    expect(started).toBe(0);
  });

  test('Commander registration requires ref and goal while delegating output and exit state to its runner', async () => {
    const program = new Command();
    program.exitOverride();
    const calls: string[] = [];
    registerPtyAttachDriveCommand(program.command('pty'), async (start) => {
      calls.push((await start()).message);
    }, {
      listPty: () => [], getPty: () => undefined, controlDepsForHandle: () => ({}) as never,
      createBrain: () => ({}) as never, runControlLoop: async () => ({}) as never, log: () => {},
    });
    await expect(program.parseAsync(['node', 'script', 'pty', 'auto'], { from: 'node' })).rejects.toThrow();
    await expect(program.parseAsync(['node', 'script', 'pty', 'auto', 'missing', '--goal', 'x'], { from: 'node' })).resolves.toBeDefined();
    expect(calls).toEqual(['pty auto: missing was not found']);
    const commandNames = program.commands[0]?.commands.map((command) => command.name()) ?? [];
    expect(commandNames).toContain('auto');
    expect(commandNames).not.toContain('attach-drive');
  });

  test('registerPtyTakeoverCommands routes auto through the shared control-axis stderr and exit runner', async () => {
    const program = new Command();
    const stderr = process.stderr.write;
    const lines: string[] = [];
    process.stderr.write = ((text: string) => { lines.push(text); return true; }) as typeof process.stderr.write;
    try {
      registerPtyTakeoverCommands(program, {
        getPty: () => undefined, requestPtyTakeover: () => false,
        requestRemote: async (): Promise<PtyControlResult> => ({ status: 'failed', reason: 'unused' }),
        log: () => {},
      });
      await expect(program.parseAsync(['node', 'script', 'pty', 'auto', 'missing', '--goal', 'x'], { from: 'node' })).resolves.toBeDefined();
      expect(lines).toEqual(['pty auto: missing was not found\n']);
      expect(process.exitCode).toBe(1);
      const commandNames = program.commands[0]?.commands.map((command) => command.name()) ?? [];
      expect(commandNames).toContain('auto');
      expect(commandNames).not.toContain('attach-drive');
    } finally {
      process.stderr.write = stderr;
      process.exitCode = 0;
    }
  });

  test('registerPtyTakeoverCommands preserves shared runner exception propagation for auto', async () => {
    const program = new Command();
    registerPtyTakeoverCommands(program, {
      getPty: () => undefined, requestPtyTakeover: () => false,
      requestRemote: async (): Promise<PtyControlResult> => ({ status: 'failed', reason: 'unused' }),
      registerObservationSink: async () => { throw new Error('sink unavailable'); }, log: () => {},
    });
    await expect(program.parseAsync(['node', 'script', 'pty', 'auto', 'target', '--goal', 'x'], { from: 'node' })).rejects.toThrow('sink unavailable');
  });
});

describe('runPtyDrive (elanous drive 핸들러)', () => {
  test('dev --elanous --hold parses --ready-timeout-ms into the dispatched PTY readiness timeout', () => {
    const spec = buildDevCliSpec({ text: '' }, { kind: 'self' }, {
      elanous: true, hold: true, readyTimeoutMs: '180000',
    });
    const plan = planDevPipeline(spec);
    expect(plan.dispatch).toBe('elanous-tui');
    expect(plan.elanous).toEqual({ hold: true, readyTimeoutMs: 180000 });
  });

  test('dev --elanous --hold rejects non-positive and nonnumeric --ready-timeout-ms values by name', () => {
    for (const raw of ['0', '-1', 'nope']) {
      expect(() => buildDevCliSpec({ text: '' }, { kind: 'self' }, {
        elanous: true, hold: true, readyTimeoutMs: raw,
      })).toThrow(/--ready-timeout-ms.*양의 정수/);
    }
  });

  test('registers hold settlement and owner-child-death observations', () => {
    expect(KNOWN_LOG_EVENT_NAMES).toEqual(expect.objectContaining(new Set([
      'hold-wait-settlement-failed', 'hold-owner-child-died',
    ])));
  });

  // ⭐ `drive` 의 계약은 한 문장이다 — **표면은 `dev` 와 같고, 런타임이 받는 것은 5개뿐이다.**
  //   ① 표면: `--help` 가 `dev` 것과 글자 그대로 같고 top-level 에 독립 항목으로 서지 않는다(C-4 수렴).
  //      ⇒ 그래서 도움말에는 `--elanous` 를 포함한 dev 옵션이 다 보인다.
  //   ② 런타임: `assertDriveAliasOptions` 가 goal·max-steps·poll-ms·model·cwd 외 **전부 명시 거부**한다.
  //      ⇒ `drive --elanous` 는 거부된다(그 축은 test/cli-dev-command.test.ts 가 검증한다).
  //   ⛔ 초판 주석이 ①만 보고 *"--elanous 를 상속한다"* 라 적어 두 테스트가 모순돼 보였다(리뷰 3R must-fix).
  //      **보이는 것과 받는 것은 다르다** — 두 테스트는 같은 계약의 두 축이지 충돌이 아니다.
  test('drive resolves as an alias of dev, not a coexisting command', () => {
    const run = (args: string[]) => {
      const proc = Bun.spawnSync({
        cmd: ['bun', 'bin/elanous.mjs', ...args, '--help'],
        cwd: join(import.meta.dir, '..', '..'),
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, ELANOUS_STATE_DIR: mkdtempSync(join(tmpdir(), 'pty-drive-cli-')) },
      });
      return new TextDecoder().decode(proc.stdout);
    };
    expect(run(['drive'])).toMatch(/Usage: elanous dev\|drive/);
    expect(run(['drive'])).toBe(run(['dev']));
    expect(run([])).not.toMatch(/^\s{2}drive\b/m);
    // ① 의 직접 단언 — 도움말에는 dev 옵션이 그대로 보인다(런타임 거부와는 별개 축).
    expect(run(['drive'])).toContain('--elanous');
  }, 15_000);

  test('drive Commander action preserves shell flags, default bash target, and child exit code', async () => {
    let got: import('./pty-drive-cli.js').PtyDriveOpts | undefined;
    const exits: number[] = [];
    const stop = (code: number): never => { exits.push(code); throw new Error(`exit:${code}`); };
    await expect(runDriveCliCommand('printf shell', {
      goal: 'finish', maxSteps: '7', pollMs: '0', model: 'brain', cwd: '/work',
    }, {
      runPtyDrive: async (opts) => { got = opts; return { exitCode: 17 }; },
      exit: stop,
    })).rejects.toThrow('exit:17');
    expect(got).toEqual({ command: 'printf shell', goal: 'finish', maxSteps: 7, pollMs: 0, model: 'brain', cwd: '/work' });
    expect(exits).toEqual([17]);
  });

  test('drive --attach drives the existing ref and does not spawn', async () => {
    let spawned: import('./pty-drive-cli.js').PtyDriveOpts | undefined;
    let attached: { ref?: string; opts?: import('./pty-drive-cli.js').PtyAttachDriveOpts } | undefined;
    const exits: number[] = [];
    const stop = (code: number): never => { exits.push(code); throw new Error(`exit:${code}`); };
    await expect(runDriveCliCommand(undefined, {
      goal: 'finish', maxSteps: '4', pollMs: '0', model: 'brain', attach: 'pty_target',
    }, {
      runPtyDrive: async (opts) => { spawned = opts; return { exitCode: 0 }; },
      runPtyAttachDrive: async (ref, opts) => {
        attached = { ref, opts };
        return { exitCode: 0, message: 'pty auto: pty_target success' };
      },
      exit: stop,
    })).rejects.toThrow('exit:0');
    expect(spawned).toBeUndefined();
    expect(attached).toEqual({
      ref: 'pty_target',
      opts: { goal: 'finish', maxSteps: 4, pollMs: 0, model: 'brain' },
    });
    expect(exits).toEqual([0]);
  });

  test('drive --attach names spawn-only flags instead of accepting then ignoring them', async () => {
    let attached = 0;
    const errors: string[] = [];
    const exits: number[] = [];
    const stop = (code: number): never => { exits.push(code); throw new Error(`exit:${code}`); };
    await expect(runDriveCliCommand(undefined, {
      goal: 'x', attach: 'pty_target', cwd: '/work', worktree: true, json: true,
    }, {
      runPtyAttachDrive: async () => { attached += 1; return { exitCode: 0, message: 'ok' }; },
      writeError: (message) => { errors.push(message); },
      exit: stop,
    })).rejects.toThrow('exit:2');
    expect(attached).toBe(0);
    expect(exits).toEqual([2]);
    expect(errors.join('')).toContain('--cwd');
    expect(errors.join('')).toContain('--worktree');
    expect(errors.join('')).toContain('--json');
  });

  test('shared four options mean the same thing on spawn and attach', async () => {
    let spawned: import('./pty-drive-cli.js').PtyDriveOpts | undefined;
    let attached: import('./pty-drive-cli.js').PtyAttachDriveOpts | undefined;
    const stop = (code: number): never => { throw new Error(`exit:${code}`); };
    await expect(runDriveCliCommand('printf shell', {
      goal: 'finish', maxSteps: '9', pollMs: '3', model: 'brain',
    }, {
      runPtyDrive: async (opts) => { spawned = opts; return { exitCode: 0 }; },
      exit: stop,
    })).rejects.toThrow('exit:0');
    await expect(runDriveCliCommand(undefined, {
      goal: 'finish', maxSteps: '9', pollMs: '3', model: 'brain', attach: 'pty_target',
    }, {
      runPtyAttachDrive: async (_ref, opts) => { attached = opts; return { exitCode: 0, message: 'ok' }; },
      exit: stop,
    })).rejects.toThrow('exit:0');
    expect(spawned).toMatchObject({ goal: 'finish', maxSteps: 9, pollMs: 3, model: 'brain' });
    expect(attached).toEqual({ goal: 'finish', maxSteps: 9, pollMs: 3, model: 'brain' });
  });

  test('X1 shape: brain says done but the final screen shows a failure → exit 1 (DRIVE-OK)', async () => {
    const lines: string[] = [];
    setPtyAdapterForTesting(() => mockAdapter([], () => {}, undefined, 'bash: openclaw: command not found\r\n'));
    const r = await runPtyDrive({
      command: 'bash', goal: 'install', stream: async () => '{"action":"done","reason":"설치 완료"}',
      out: (s) => { lines.push(s); }, maxSteps: 2, pollMs: 0,
    });
    expect(r.exitCode).toBe(1);
    expect(lines.join('')).toContain('verdict: done-but-failed');
  });

  test('default shell path remains bash -c and cleans up', async () => {
    const writes: string[] = [];
    let killed = false;
    let spawned: { cmd?: string; args?: string[] } | undefined;
    setPtyAdapterForTesting((opts) => { spawned = opts; return mockAdapter(writes, () => { killed = true; }, undefined, '7 pass\r\n'); });
    const script = ['{"action":"input","text":"777\\r"}', '{"action":"done","reason":"완료"}'];
    let i = 0;
    const r = await runPtyDrive({
      command: 'echo x', goal: '코드 입력', stream: async () => script[Math.min(i++, script.length - 1)]!,
      out: () => {}, maxSteps: 5, pollMs: 0,
    });
    expect(r.exitCode).toBe(0);
    expect(spawned).toMatchObject({ cmd: 'bash', args: ['-c', 'echo x'], accessMode: 'auto', transitionPolicy: 'open' });
    expect(writes).toContain('777\r');
    expect(killed).toBe(true);
  });

  test('elanous target uses the shared bare TUI root, delivers before brain input, and mirrors via parent storage', async () => {
    const writes: string[] = [];
    const mirrors: Array<{ key: string; frame: string; stateDir: string | undefined }> = [];
    let spawned: { cmd?: string; args?: string[]; env?: Record<string, string>; accessMode?: string; transitionPolicy?: string } | undefined;
    setPtyAdapterForTesting((opts) => { spawned = opts; return mockAdapter(writes, () => {}); });
    const root = mkdtempSync(join(tmpdir(), 'elanous-drive-isolated-'));
    const callerState = mkdtempSync(join(tmpdir(), 'elanous-drive-parent-'));
    const originalState = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = callerState;
    try {
      const r = await runPtyDrive({
        elanous: true, goal: 'implement the child goal', repoRoot: '/repo', cwd: root, isolatedRoot: root,
        bootMs: 0, sleep: async () => {}, stream: async () => '{"action":"done","reason":"ready"}', out: () => {}, maxSteps: 2, pollMs: 0,
        writeScreen: (key, frame, env) => mirrors.push({ key, frame, stateDir: env?.ELANOUS_STATE_DIR }),
      });
      expect(r.exitCode).toBe(0);
    } finally {
      // ⚠️ `env[k] = undefined` stores the STRING "undefined" — a later test then
      // reads a caller state directory literally named that. Restore by deleting.
      if (originalState === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = originalState;
    }
    const configDir = realpathSync(root);
    const stateDir = configDir;
    expect(spawned).toMatchObject({
      cmd: 'bun', args: ['/repo/bin/elanous.mjs', '--config-dir', configDir, '--test-state-dir', stateDir],
      env: { ELANOUS_STATE_DIR: stateDir }, accessMode: 'auto', transitionPolicy: 'open',
    });
    expect(writes.slice(0, 2)).toEqual(['implement the child goal', '\r']);
    expect(mirrors).toHaveLength(3);
    expect(new Set(mirrors.map(({ key }) => key)).size).toBe(1);
    expect(mirrors.every(({ stateDir: envState }) => envState === callerState)).toBe(true);
    expect(existsSync(configDir)).toBe(true);
    expect(existsSync(stateDir)).toBe(true);
  });

  test('elanous hold spawns a detached externally writable child without a brain, mirrors once, and reports its registry ref', async () => {
    const writes: string[] = [];
    const output: string[] = [];
    const mirrors: Array<{ key: string; frame: string }> = [];
    let spawned: { detach?: boolean; accessMode?: string; transitionPolicy?: string } | undefined;
    setPtyAdapterForTesting((opts) => { spawned = opts; return mockAdapter(writes, () => {}); });
    const root = mkdtempSync(join(tmpdir(), 'elanous-hold-'));
    const result = await runPtyDrive({
      elanous: true, hold: true, spawnOwner: false, repoRoot: '/repo', cwd: root, isolatedRoot: root,
      out: (line) => output.push(line),
      writeScreen: (key, frame) => mirrors.push({ key, frame }),
      stream: async () => { throw new Error('hold must not create a brain'); },
    });
    const ref = output.join('').match(/⛭ held (\S+)/)?.[1];
    expect(result.exitCode).toBe(0);
    expect(ref).toBeDefined();
    expect(spawned).toMatchObject({ detach: true, accessMode: 'auto', transitionPolicy: 'open' });
    expect(writes).toEqual([]);
    expect(mirrors).toHaveLength(1);
    expect(getPty(ref!)).toMatchObject({ id: ref, detach: true, accessMode: 'write' });
  });

  test('elanous hold JSON success emits one structured line instead of the legacy held text', async () => {
    const output: string[] = [];
    setPtyAdapterForTesting(() => mockAdapter([], () => {}));
    const root = mkdtempSync(join(tmpdir(), 'elanous-hold-json-'));
    const originalSpaceId = process.env.ELANOUS_HOLD_SPACE_ID;
    process.env.ELANOUS_HOLD_SPACE_ID = 'dev-run-x';
    const result = await runPtyDrive({
      elanous: true, hold: true, json: true, spawnOwner: false, repoRoot: '/repo', cwd: root, isolatedRoot: root,
      out: (line) => output.push(line), writeScreen: () => {},
    });
    if (originalSpaceId === undefined) delete process.env.ELANOUS_HOLD_SPACE_ID;
    else process.env.ELANOUS_HOLD_SPACE_ID = originalSpaceId;
    expect(result.exitCode).toBe(0);
    expect(output).toHaveLength(1);
    const held = JSON.parse(output[0]!);
    expect(held).toMatchObject({ held: true, spaceId: 'dev-run-x', workdir: root });
    expect(held.ptyId).toMatch(/^pty_/);
    expect(output[0]).not.toContain('⛭ held');
  });

  // ⛔⭐ hold 경로가 **중간에서 던지면 정리해야 한다**(리뷰 must-fix · 2026-07-30) —
  //    종전엔 finally 가 `opts.hold` 만 봐서 setAccessMode·renderScreen·writeScreen 중 하나라도
  //    던지면 **detached PTY 와 isolation 이 유출**됐다(아무도 거두지 않는다).
  //    ⇒ 판정을 성공 handoff 플래그로 바꿨고, 그것을 여기서 고정한다.
  test('hold 가 handoff 전에 던지면 PTY 를 유출하지 않고 거둔다', async () => {
    let killed = false;
    setPtyAdapterForTesting(() => mockAdapter([], () => { killed = true; }));
    const root = mkdtempSync(join(tmpdir(), 'elanous-hold-leak-'));
    await expect(runPtyDrive({
      elanous: true, hold: true, spawnOwner: false, repoRoot: '/repo', cwd: root, isolatedRoot: root,
      out: () => {},
      // ⭐ handoff 직전 단계에서 던진다 — 이때 정리가 돌아야 한다.
      writeScreen: () => { throw new Error('mirror failed'); },
    })).rejects.toThrow('mirror failed');
    expect(killed).toBe(true);
  });

  // ⛔⭐ owner 생성 **판별 자체**를 잰다(리뷰 must-fix · 2026-07-30) — 위 테스트는 `spawnOwner: false`
  //    로 owner 를 끄고 registry 배선만 보므로, 판별을 `!out && !writeScreen` 으로 되돌려도 통과한다
  //    (뮤테이션으로 확인: 0 fail). ⇒ 판별이 **주입 여부가 아니라 명시 필드**임을 여기서 고정한다.
  //    ⚠️ 실제 detached 프로세스를 띄우지 않기 위해 Bun.spawn 을 스파이로 바꾸고 **호출 수만** 센다.
  test('hold 의 owner 생성 판별은 주입 여부가 아니라 spawnOwner 필드다', async () => {
    const originalSpawn = Bun.spawn;
    const originalSpawnSync = Bun.spawnSync;
    let calls = 0;
    let mintedId = '';
    let ownerEnv: Record<string, string> | undefined;
    let checkerEnv: Record<string, string> | undefined;
    (Bun as { spawn: typeof Bun.spawn }).spawn = ((...a: Parameters<typeof Bun.spawn>) => {
      calls += 1;
      // ⭐ 실제 owner 를 띄우지 않는다. 대신 그 프로세스가 넘겨받는 id 를 가로채
      //    아래 spawnSync 스파이가 그것을 `alive` 로 돌려주게 한다(폴링 1회로 즉시 반환 ⇒ 30초 회피).
      ownerEnv = (a[0] as { env?: Record<string, string> }).env;
      mintedId = ownerEnv?.ELANOUS_HOLD_PTY_ID ?? '';
      return { unref() {}, kill() {} } as unknown as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn;
    (Bun as { spawnSync: typeof Bun.spawnSync }).spawnSync = ((...a: Parameters<typeof Bun.spawnSync>) => {
      checkerEnv = (a[0] as { env?: Record<string, string> }).env;
      return ({
      // ⚠️ `exitCode` 를 반드시 준다 — 실제 `Bun.spawnSync` 는 항상 숫자를 싣고,
      //    ready 판정이 **`exitCode === 0` 을 요구**하므로(죽은 checker 의 stdout 을 안 믿는다)
      //    가짜가 이걸 빼면 영영 ready 가 안 된다.
        stdout: new TextEncoder().encode(`${mintedId}\ttui\t-\tremote\talive\n`), exitCode: 0,
      }) as unknown as ReturnType<typeof Bun.spawnSync>;
    }) as typeof Bun.spawnSync;
    setPtyAdapterForTesting(() => mockAdapter([], () => {}));
    const root = mkdtempSync(join(tmpdir(), 'elanous-hold-owner-'));
    try {
      // ⭐ out/writeScreen 을 **주입해도** spawnOwner 를 끄지 않았으면 owner 를 띄우려 한다.
      await runPtyDrive({
        elanous: true, hold: true, repoRoot: '/repo', cwd: root, isolatedRoot: root,
        out: () => {}, writeScreen: () => {},
      }).catch(() => {});
      expect(calls).toBeGreaterThan(0);
      expect(checkerEnv?.ELANOUS_STATE_DIR).toBe(ownerEnv?.ELANOUS_STATE_DIR);
      // ⭐ 반대로 spawnOwner:false 면 주입이 없어도 owner 를 띄우지 않는다.
      calls = 0;
      await runPtyDrive({
        elanous: true, hold: true, spawnOwner: false, repoRoot: '/repo', cwd: root, isolatedRoot: root,
        out: () => {}, writeScreen: () => {},
      });
      expect(calls).toBe(0);
    } finally {
      (Bun as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
      (Bun as { spawnSync: typeof Bun.spawnSync }).spawnSync = originalSpawnSync;
    }
  });

  // ⛔⭐⭐⭐ ready 실패가 **무엇을 기다렸고 무엇을 봤는지** 말하는지 고정한다(2026-08-01).
  //    종전 메시지는 `did not become ready within 30 seconds` 한 줄이라, 밖에서
  //    «판정이 틀렸다» / «id 가 갈렸다» / «checker 가 아예 못 돌았다» 가 **구별되지 않았다**
  //    (`[S]` 가 pilot 에서 정확히 이 실패로 막혔다 · 조율 채널 #5730).
  //    ⚠️ 세 경우를 **다른 문면**으로 고정한다 — 하나로 뭉치면 이 회귀를 다시 못 잡는다.
  //    ⭐ `sync` 는 **부모가 실제로 만든 id** 를 받는다 — 테스트가 밖에서 스파이를 또 걸면
  //       이 함수가 그것을 덮어써서 id 가 빈 문자열이 된다(실제로 한 번 밟았다).
  const holdFailure = async (
    sync: (mintedId: string) => { stdout: Uint8Array; stderr?: Uint8Array; exitCode?: number },
    options: { root?: string; onChecker?: (argv: string[]) => void } = {},
  ): Promise<string> => {
    const originalSpawn = Bun.spawn;
    const originalSpawnSync = Bun.spawnSync;
    let mintedId = '';
    (Bun as { spawn: typeof Bun.spawn }).spawn = ((...a: Parameters<typeof Bun.spawn>) => {
      mintedId = (a[0] as { env?: Record<string, string> }).env?.ELANOUS_HOLD_PTY_ID ?? '';
      return { unref() {}, kill() {} } as unknown as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn;
    (Bun as { spawnSync: typeof Bun.spawnSync }).spawnSync = ((
      ...args: Parameters<typeof Bun.spawnSync>
    ) => {
      const cmd = args[0] as { cmd?: string[] };
      options.onChecker?.(cmd.cmd ?? []);
      return sync(mintedId) as unknown as ReturnType<typeof Bun.spawnSync>;
    }) as typeof Bun.spawnSync;
    setPtyAdapterForTesting(() => mockAdapter([], () => {}));
    const root = options.root ?? mkdtempSync(join(tmpdir(), 'elanous-hold-ready-'));
    try {
      await runPtyDrive({
        elanous: true, hold: true, repoRoot: '/repo', cwd: root, isolatedRoot: root,
        readyTimeoutMs: 30, settlementMs: 0, out: () => {}, writeScreen: () => {},
      });
      return '(threw nothing)';
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    } finally {
      (Bun as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
      (Bun as { spawnSync: typeof Bun.spawnSync }).spawnSync = originalSpawnSync;
    }
  };

  test('ready 실패는 기다린 id 를 싣는다', async () => {
    const msg = await holdFailure(() => ({ stdout: new TextEncoder().encode(''), exitCode: 0 }));
    expect(msg).toMatch(/awaited pty_[0-9a-f]{8}/);
  });

  test('detached owner readiness failure emits JSON before preserving the error', async () => {
    const originalSpawn = Bun.spawn;
    const originalSpawnSync = Bun.spawnSync;
    const output: string[] = [];
    (Bun as { spawn: typeof Bun.spawn }).spawn = (() => ({ unref() {}, kill() {} }) as unknown as ReturnType<typeof Bun.spawn>) as typeof Bun.spawn;
    (Bun as { spawnSync: typeof Bun.spawnSync }).spawnSync = (() => ({
      stdout: new TextEncoder().encode(''), exitCode: 0,
    }) as unknown as ReturnType<typeof Bun.spawnSync>) as typeof Bun.spawnSync;
    const root = mkdtempSync(join(tmpdir(), 'elanous-hold-json-failure-'));
    try {
      await expect(runPtyDrive({
        elanous: true, hold: true, json: true, repoRoot: '/repo', cwd: root, isolatedRoot: root,
        readyTimeoutMs: 0, settlementMs: 0, out: (line) => output.push(line), writeScreen: () => {},
      })).rejects.toThrow('did not become ready');
      expect(output).toHaveLength(1);
      expect(JSON.parse(output[0]!)).toMatchObject({ held: false, error: expect.stringContaining('did not become ready') });
    } finally {
      (Bun as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
      (Bun as { spawnSync: typeof Bun.spawnSync }).spawnSync = originalSpawnSync;
    }
  });

  test('registered PTY that dies during settlement fails instead of printing held', async () => {
    const originalSpawn = Bun.spawn;
    const originalSpawnSync = Bun.spawnSync;
    let mintedId = '';
    let checks = 0;
    const output: string[] = [];
    (Bun as { spawn: typeof Bun.spawn }).spawn = ((...a: Parameters<typeof Bun.spawn>) => {
      mintedId = (a[0] as { env?: Record<string, string> }).env?.ELANOUS_HOLD_PTY_ID ?? '';
      return { unref() {}, kill() {}, exitCode: null, exited: Promise.resolve(1) } as unknown as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn;
    (Bun as { spawnSync: typeof Bun.spawnSync }).spawnSync = (() => ({
      stdout: new TextEncoder().encode(checks++ === 0 ? `${mintedId}\ttui\t-\tremote\talive\n` : ''), exitCode: 0,
    }) as unknown as ReturnType<typeof Bun.spawnSync>) as typeof Bun.spawnSync;
    const root = mkdtempSync(join(tmpdir(), 'elanous-hold-settlement-death-'));
    try {
      await expect(runPtyDrive({
        elanous: true, hold: true, repoRoot: '/repo', cwd: root, isolatedRoot: root,
        readyTimeoutMs: 30, settlementMs: 0, out: (line) => output.push(line), writeScreen: () => {},
      })).rejects.toThrow(/registered then died.*last exit=1/);
      expect(output.join('')).not.toContain('⛭ held');
      expect(checks).toBe(2);
    } finally {
      (Bun as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
      (Bun as { spawnSync: typeof Bun.spawnSync }).spawnSync = originalSpawnSync;
    }
  });

  test('settlement preserves held success and observes the default 30000ms timeout', async () => {
    const originalSpawn = Bun.spawn;
    const originalSpawnSync = Bun.spawnSync;
    const records: Array<{ category: string; event: string; data?: Record<string, unknown> }> = [];
    const off = debug.registerSink({ name: 'hold-ready-timeout-default', emit: (rec) => records.push({ category: rec.category, event: rec.event, data: rec.data as Record<string, unknown> }) });
    const wasEnabled = debug.enabled;
    debug.enable();
    let mintedId = '';
    let checks = 0;
    const output: string[] = [];
    (Bun as { spawn: typeof Bun.spawn }).spawn = ((...a: Parameters<typeof Bun.spawn>) => {
      mintedId = (a[0] as { env?: Record<string, string> }).env?.ELANOUS_HOLD_PTY_ID ?? '';
      return { unref() {}, kill() {} } as unknown as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn;
    (Bun as { spawnSync: typeof Bun.spawnSync }).spawnSync = (() => {
      checks += 1;
      return {
        stdout: new TextEncoder().encode(`${mintedId}\ttui\t-\tremote\talive\n`), exitCode: 0,
      } as unknown as ReturnType<typeof Bun.spawnSync>;
    }) as typeof Bun.spawnSync;
    const root = mkdtempSync(join(tmpdir(), 'elanous-hold-settlement-alive-'));
    try {
      const result = await runPtyDrive({
        elanous: true, hold: true, repoRoot: '/repo', cwd: root, isolatedRoot: root,
        settlementMs: 0, out: (line) => output.push(line), writeScreen: () => {},
      });
      expect(result.exitCode).toBe(0);
      expect(output).toEqual([`⛭ held ${mintedId}\n`]);
      expect(checks).toBe(2);
      expect(records.find((record) => record.category === 'pty.drive' && record.event === 'hold-wait-start')?.data?.readyTimeoutMs).toBe(30_000);
    } finally {
      off();
      if (!wasEnabled) debug.disable();
      (Bun as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
      (Bun as { spawnSync: typeof Bun.spawnSync }).spawnSync = originalSpawnSync;
    }
  });

  test('settlement observes an explicit readiness timeout', async () => {
    const originalSpawn = Bun.spawn;
    const originalSpawnSync = Bun.spawnSync;
    const records: Array<{ category: string; event: string; data?: Record<string, unknown> }> = [];
    const off = debug.registerSink({ name: 'hold-ready-timeout-explicit', emit: (rec) => records.push({ category: rec.category, event: rec.event, data: rec.data as Record<string, unknown> }) });
    const wasEnabled = debug.enabled;
    debug.enable();
    let mintedId = '';
    (Bun as { spawn: typeof Bun.spawn }).spawn = ((...a: Parameters<typeof Bun.spawn>) => {
      mintedId = (a[0] as { env?: Record<string, string> }).env?.ELANOUS_HOLD_PTY_ID ?? '';
      return { unref() {}, kill() {} } as unknown as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn;
    (Bun as { spawnSync: typeof Bun.spawnSync }).spawnSync = (() => ({
      stdout: new TextEncoder().encode(`${mintedId}\ttui\t-\tremote\talive\n`), exitCode: 0,
    }) as unknown as ReturnType<typeof Bun.spawnSync>) as typeof Bun.spawnSync;
    const root = mkdtempSync(join(tmpdir(), 'elanous-hold-settlement-explicit-'));
    try {
      const result = await runPtyDrive({
        elanous: true, hold: true, repoRoot: '/repo', cwd: root, isolatedRoot: root,
        readyTimeoutMs: 180_000, settlementMs: 0, out: () => {}, writeScreen: () => {},
      });
      expect(result.exitCode).toBe(0);
      expect(records.find((record) => record.category === 'pty.drive' && record.event === 'hold-wait-start')?.data?.readyTimeoutMs).toBe(180_000);
    } finally {
      off();
      if (!wasEnabled) debug.disable();
      (Bun as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
      (Bun as { spawnSync: typeof Bun.spawnSync }).spawnSync = originalSpawnSync;
    }
  });

  test('detached owner JSON success includes the parent-selected spaceId', async () => {
    const originalSpawn = Bun.spawn;
    const originalSpawnSync = Bun.spawnSync;
    let mintedId = '';
    const output: string[] = [];
    (Bun as { spawn: typeof Bun.spawn }).spawn = ((...a: Parameters<typeof Bun.spawn>) => {
      mintedId = (a[0] as { env?: Record<string, string> }).env?.ELANOUS_HOLD_PTY_ID ?? '';
      return { unref() {}, kill() {} } as unknown as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn;
    (Bun as { spawnSync: typeof Bun.spawnSync }).spawnSync = (() => ({
      stdout: new TextEncoder().encode(`${mintedId}\ttui\t-\tremote\talive\n`), exitCode: 0,
    }) as unknown as ReturnType<typeof Bun.spawnSync>) as typeof Bun.spawnSync;
    const root = mkdtempSync(join(tmpdir(), 'elanous-hold-owner-json-'));
    const originalSpaceId = process.env.ELANOUS_HOLD_SPACE_ID;
    process.env.ELANOUS_HOLD_SPACE_ID = 'dev-run-x';
    try {
      const result = await runPtyDrive({
        elanous: true, hold: true, json: true, repoRoot: '/repo', cwd: root, isolatedRoot: root,
        settlementMs: 0, out: (line) => output.push(line), writeScreen: () => {},
      });
      expect(result.exitCode).toBe(0);
      expect(output).toHaveLength(1);
      expect(JSON.parse(output[0]!)).toEqual({ held: true, ptyId: mintedId, spaceId: 'dev-run-x', workdir: root });
    } finally {
      if (originalSpaceId === undefined) delete process.env.ELANOUS_HOLD_SPACE_ID;
      else process.env.ELANOUS_HOLD_SPACE_ID = originalSpaceId;
      (Bun as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
      (Bun as { spawnSync: typeof Bun.spawnSync }).spawnSync = originalSpawnSync;
    }
  });

  test('ready 실패 셋은 서로 다른 문면이다 — 빈 목록 · 다른 id · checker 사망', async () => {
    const empty = await holdFailure(() => ({ stdout: new TextEncoder().encode(''), exitCode: 0 }));
    const other = await holdFailure(() => ({
      stdout: new TextEncoder().encode('pty_0badcafe\ttui\t-\tremote\talive\t?\n'), exitCode: 0,
    }));
    const dead = await holdFailure(() => ({
      stdout: new TextEncoder().encode(''),
      stderr: new TextEncoder().encode('bun: command not found\n'),
      exitCode: 127,
    }));

    expect(empty).toContain('checker printed nothing');
    // ⭐ 「무엇이 대신 보였나」 를 실어야 id 갈림을 밖에서 잡는다.
    expect(other).toContain('checker listed [pty_0badcafe]');
    expect(dead).toContain('checker exit=127');
    expect(dead).toContain('bun: command not found');
    // ⛔⭐ 셋이 실제로 갈리는지 — ⚠️ 종전엔 `new Set([...]).size === 3` 이었는데
    //    **awaited id 가 매 실행 달라서 문면이 같아져도 통과**했다(무인 리뷰 should-fix).
    //    ⇒ id 를 정규화해 **문면 자체**를 비교한다.
    const shape = (m: string): string => m.replace(/pty_[0-9a-f]{8}/g, '<id>');
    expect(new Set([shape(empty), shape(other), shape(dead)]).size).toBe(3);
  });

  // ⛔⭐ ① 「판정이 틀렸다」 를 **빈 목록으로 대체하지 않고 실제로 재현**한다(리뷰 must-fix) —
  //    awaited id 가 stdout 에 **있는데** 판정이 실패하는 경우다(형식이 어긋난 행).
  test('ready 실패 ① — awaited id 가 목록에 있는데 판정이 실패하면 그 목록을 보여준다', async () => {
    // ⭐ id 는 맞는데 상태 칸이 `alive` 가 아니다 ⇒ 판정은 거짓, 목록엔 그 id 가 보인다.
    //    ⛔ 이것이 「① 판정이 틀렸다」의 **실제 재현**이다 — 빈 목록으로 대체하지 않는다.
    const msg = await holdFailure((id) => ({
      stdout: new TextEncoder().encode(`${id}\ttui\t-\tremote\tstarting\t?\n`), exitCode: 0,
    }));
    expect(msg).toMatch(/awaited (pty_[0-9a-f]{8}); checker listed \[\1\]/);
  });

  // ⛔⭐ checker 가 **죽으면서도 stdout 을 남기면** ready 로 오판하거나 문면이 오분류됐다(리뷰 must-fix).
  test('checker 가 nonzero 면 stdout 에 alive 행이 있어도 ready 가 아니다', async () => {
    const msg = await holdFailure((id) => ({
      stdout: new TextEncoder().encode(`${id}\ttui\t-\tremote\talive\t?\n`),
      stderr: new TextEncoder().encode('registry: partial read\n'),
      exitCode: 3,
    }));
    // ⛔ 종전 구현은 여기서 **성공(⛭ held)** 했다 — 그래서 이 단언이 회귀를 고정한다.
    expect(msg).toContain('did not become ready');
    // ⭐ exit 가 최우선 분기 — 「못 봤다」가 아니라 「못 돌았다」로 읽혀야 한다.
    expect(msg).toContain('checker exit=3');
    expect(msg).toContain('registry: partial read');
  });

  const expectPtyListCheckerIdentity = (data: Record<string, unknown>, checkerArgv: string[]): void => {
    const cliEntrypoint = process.argv[1];
    expect(String(data.checkerSubcommand)).toBe('pty list');
    expect(data.checkerArgv).toEqual(checkerArgv);
    expect(checkerArgv).toEqual(expect.arrayContaining([process.execPath, cliEntrypoint]));
    expect(checkerArgv.slice(0, 2)).toEqual([process.execPath, cliEntrypoint]);
    expect(checkerArgv.slice(-2)).toEqual(['pty', 'list']);
  };

  // ⛔⭐ 수용 기준 2 — 관측 페이로드를 **실제로 잰다**(무인 리뷰 should-fix).
  //    메시지만 재면 `hold-wait-*` 이벤트를 통째로 지워도 통과한다.
  test('hold 대기는 awaitingId·checker·cwd·stateDir 를 관측에 남긴다', async () => {
    const records: Array<{ category: string; event: string; data?: Record<string, unknown> }> = [];
    // ⭐ 값을 **알고 있는 상태**로 재야 `undefined` 퇴행이 잡힌다(존재 검사만으론 안 잡힌다).
    const expectedState = mkdtempSync(join(tmpdir(), 'hold-wait-state-'));
    const priorState = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = expectedState;
    const off = debug.registerSink({
      name: 'hold-wait-test-capture',
      emit: (rec) => { records.push({ category: rec.category, event: rec.event, data: rec.data as Record<string, unknown> }); },
    });
    const wasEnabled = debug.enabled;
    let checkerArgv: string[] = [];
    debug.enable();
    try {
      // ⭐ 심은 값이 timeout 레코드에 **보존되는지** 재려고 stdout·stderr·exit 를 다 준다.
      const longRoot = join(mkdtempSync(join(tmpdir(), 'hold-wait-root-')), ...Array(16).fill('long-isolated-worktree-segment'));
      mkdirSync(longRoot, { recursive: true });
      await holdFailure(() => ({
        stdout: new TextEncoder().encode('pty_0badcafe\ttui\t-\tremote\tstarting\t?\n'),
        stderr: new TextEncoder().encode('registry: scope mismatch\n'),
        exitCode: 4,
      }), { root: longRoot, onChecker: (argv) => { checkerArgv = argv; } });
    } finally {
      off();
      if (!wasEnabled) debug.disable();
      // ⚠️ `env[k] = undefined` 는 문자열 "undefined" 를 넣는다 — 지워서 복원한다.
      if (priorState === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = priorState;
    }
    const decision = records.find((r) => r.category === 'pty.drive' && r.event === 'tui-workdir-decision');
    const start = records.find((r) => r.category === 'pty.drive' && r.event === 'hold-wait-start');
    const timeout = records.find((r) => r.category === 'pty.drive' && r.event === 'hold-wait-timeout');
    expect(decision?.data).toEqual(expect.objectContaining({ isolated: true, workdirProvided: true, rejected: false }));
    expect(start).toBeDefined();
    // ⭐ 네 칸이 다 있어야 밖에서 «어느 우주를 봤나» 가 갈린다 — `stateDir` 이 근본 확정의 열쇠다.
    expect(String(start!.data?.awaitingId)).toMatch(/^pty_[0-9a-f]{8}$/);
    // ⛔⭐ 표시용 `checker` 는 «경로 길이에 따라» 절단될 수도, 안 될 수도 있다 — 둘 다 정상이다.
    //    ⚠️ 절단을 «요구»하면 짧은 경로(메인 트리)에서 깨지고, 절단을 «금지»하면 긴 경로(골 워크트리 ~150자)에서 깨진다.
    //       2026-09-16 에 그 두 얼굴이 «차례로» 났다 — 긴 경로에서 깨지던 것을 고치다 짧은 경로에서 깨뜨렸다.
    //    ⇒ 「절단됐으면 표식이 붙고, 아니면 끝이 `pty list` 다」만 잰다.
    //       명령 «정체성»은 절단되지 않는 전용 필드·argv 로 아래 헬퍼가 따로 잰다.
    expect(String(start!.data?.checker)).toMatch(/(?:«\+\d+c»|pty list)$/);
    expectPtyListCheckerIdentity(start!.data ?? {}, checkerArgv);
    // ⛔ 존재가 아니라 **값**을 잰다 — `cwd` 는 holdFailure 가 만든 격리 루트, `stateDir` 은 위에서 심은 것.
    expect(String(start!.data?.cwd)).toContain('hold-wait-root-');
    expect(start!.data?.stateDir).toBe(expectedState);
    expect(start!.data?.readyTimeoutMs).toBe(30);
    expect(timeout).toBeDefined();
    // ⛔ 키 존재만 보면 빈 값·오값 퇴행을 못 잡는다(리뷰 must-fix) — **심은 값 그대로**를 잰다.
    expect(timeout!.data?.checkerExit).toBe(4);
    expect(String(timeout!.data?.checkerStdout)).toContain('pty_0badcafe');
    expect(String(timeout!.data?.checkerStderr)).toContain('registry: scope mismatch');
  });

  test('hold 대기 checker identity는 실제 runPtyDrive 관측에서 잘못된 subcommand를 거부한다', async () => {
    const records: Array<{ category: string; event: string; data?: Record<string, unknown> }> = [];
    const off = debug.registerSink({
      name: 'hold-wait-identity-mutation-capture',
      emit: (rec) => {
        if (rec.category === 'pty.drive' && rec.event === 'hold-wait-start') {
          records.push({ ...rec, data: { ...(rec.data as Record<string, unknown>), checkerSubcommand: 'pty snapshot' } });
        }
      },
    });
    const wasEnabled = debug.enabled;
    debug.enable();
    try {
      await holdFailure(() => ({ stdout: new TextEncoder().encode(''), exitCode: 0 }));
    } finally {
      off();
      if (!wasEnabled) debug.disable();
    }
    const start = records.find((r) => r.category === 'pty.drive' && r.event === 'hold-wait-start');
    expect(() => expectPtyListCheckerIdentity(start!.data ?? {}, [])).toThrow(
      'Expected: "pty list"\nReceived: "pty snapshot"',
    );
  });

  // ⛔⭐⭐⭐ 대표 대표 정식화(2026-08-01): ***prod / prod 가 띄우는 격리 / test / test 가 띄우는 격리
  //    — 네 가지 변수가 있다.*** 한 조합만 고정하면 나머지 셋에서 같은 사고가 다시 난다.
  //
  // ⛔ **초판은 argv 만 포착해 «checker 가 인자를 들었나» 만 쟀다**(무인 리뷰 must-fix) —
  //    그건 수용 기준(«owner 등록 뿌리 == checker 조회 뿌리»)이 아니다. 두 프로세스가
  //    **실제로 해석하는 뿌리**를 각각 재서 비교한다. 해석기는 순수하지 않고(env·override·트리)
  //    프로세스 상태를 읽으므로, **owner 가 실행될 상태를 재현해 같은 해석기를 돌린다.**
  //    지도 = 내부 문서 `MAP-isolation-scope-four-universes-2026-08-01`
  const withProcessState = async <T>(
    state: { stateDir?: string; configOverride?: string },
    body: () => Promise<T> | T,
  ): Promise<T> => {
    const originalState = process.env.ELANOUS_STATE_DIR;
    if (state.stateDir) process.env.ELANOUS_STATE_DIR = state.stateDir;
    else delete process.env.ELANOUS_STATE_DIR;
    // ⛔⭐ `--config-dir` 은 argv 에 있는 것만으로는 해석에 안 잡힌다 — CLI 파서가
    //    `setElanousConfigDir()` 로 process-local override 를 세우고 해석 1층이 그것을 읽는다.
    if (state.configOverride) setElanousConfigDir(state.configOverride);
    else resetElanousConfigDir();
    resetEffectiveInstanceRoot();      // 메모 무효화 — 안 하면 앞 조합의 값이 새어 나온다
    try { return await body(); } finally {
      resetElanousConfigDir();
      if (originalState === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = originalState;
      resetEffectiveInstanceRoot();
    }
  };

  /** 한 우주에서 hold 를 돌리고, **owner 프로세스가 해석할 뿌리**와 **checker 가 조회할 뿌리**를 낸다. */
  const universe = async (state: { stateDir?: string; configOverride?: string; parentArgv?: string[] }): Promise<{
    ownerRoot: string; ownerScope: string[]; checkerScope: string[]; ownerStamp: string | undefined;
  }> => {
    const originalSpawn = Bun.spawn;
    const originalSpawnSync = Bun.spawnSync;
    let ownerEnv: Record<string, string> = {};
    let ownerArgv: string[] = [];
    let checkerArgv: string[] = [];
    (Bun as { spawn: typeof Bun.spawn }).spawn = ((...a: Parameters<typeof Bun.spawn>) => {
      const o = a[0] as { cmd?: string[]; env?: Record<string, string> };
      ownerArgv = [...(o.cmd ?? [])];
      ownerEnv = { ...(o.env ?? {}) };
      return { unref() {}, kill() {} } as unknown as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn;
    (Bun as { spawnSync: typeof Bun.spawnSync }).spawnSync = ((...a: Parameters<typeof Bun.spawnSync>) => {
      checkerArgv = [...((a[0] as { cmd?: string[] }).cmd ?? [])];
      return { stdout: new TextEncoder().encode(''), exitCode: 0 } as unknown as ReturnType<typeof Bun.spawnSync>;
    }) as typeof Bun.spawnSync;
    setPtyAdapterForTesting(() => mockAdapter([], () => {}));
    const root = mkdtempSync(join(tmpdir(), 'elanous-four-universes-'));
    const originalArgv = process.argv;
    // ⭐ 부모 argv 를 실제로 심는다 — owner 는 이걸 물려받으므로 **스코프 결정자가 남는지**가 여기서 갈린다.
    if (state.parentArgv) process.argv = ['bun', '/repo/bin/elanous.mjs', ...state.parentArgv];
    try {
      await withProcessState(state, () => runPtyDrive({
        elanous: true, hold: true, repoRoot: '/repo', cwd: root, isolatedRoot: root,
        readyTimeoutMs: 30, settlementMs: 0, out: () => {}, writeScreen: () => {},
      }).catch(() => {}));

      // ⭐ **owner 가 해석할 뿌리** — owner 는 부모 argv 를 재실행하고 `ownerEnv` 를 받는다.
      //    그 상태를 재현해 **같은 해석기**를 돌린다(argv 를 눈으로 읽지 않는다).
      // ⛔⭐ owner argv 에 **스코프 결정자가 남아 있으면 1층이 env 스탬프를 이긴다**
      //    (무인 리뷰 must-fix) ⇒ argv 를 그대로 두고 재현한다. 남아 있으면 여기서 갈린다.
      const leftoverTest = ownerArgv.some((a) => a === '--test' || a.startsWith('--test='));
      expect(`owner argv 에 남은 --test: ${leftoverTest}`).toBe('owner argv 에 남은 --test: false');
      // ⭐ 부모가 해석한 뿌리 — 이것이 양쪽에 그대로 가야 한다.
      const ownerRoot = await withProcessState(state, () => effectiveInstanceRoot());
      return {
        ownerRoot,
        ownerScope: scopeSlice(ownerArgv),
        checkerScope: scopeSlice(checkerArgv),
        ownerStamp: ownerEnv.ELANOUS_STATE_DIR,
      };
    } finally {
      (Bun as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
      (Bun as { spawnSync: typeof Bun.spawnSync }).spawnSync = originalSpawnSync;
      process.argv = originalArgv;
    }
  };

  /** 자식이 실제로 받는 **스코프 인자 쌍**. 없으면 빈 배열 — 그 자체가 결함이다. */
  const scopeSlice = (cmd: string[]): string[] => {
    const i = cmd.indexOf('--config-dir');
    return i >= 0 ? [cmd[i]!, cmd[i + 1]!] : [];
  };

  // ⛔⭐ **사전 발급 id 가 최종 child env 까지 가는가** — helper 단위 검증만으로는
  //    `runPtyDrive` 배선이 끊겨도 통과한다(무인 리뷰 should-fix).
  //    ⚠️ 이것은 정체성 전파일 뿐 pty↔session 결속이 아니다(세션은 데몬 소유 · 매뉴얼 §0a ⑶b).
  const heldChildEnv = async (over: { ptyId?: string; ambient?: string; observeOnly?: boolean; root?: string; harnessSpace?: string; harnessSpaceId?: string }): Promise<Record<string, string>> => {
    const priorAmbient = process.env.ELANOUS_HOLD_PTY_ID;
    const priorObserveOnly = process.env.ELANOUS_SELF_IMPLEMENT_OBSERVE_ONLY;
    const priorHarnessSpace = process.env.ELANOUS_HARNESS_SPACE;
    const priorHarnessSpaceId = process.env.ELANOUS_HARNESS_SPACE_ID;
    if (over.ambient) process.env.ELANOUS_HOLD_PTY_ID = over.ambient;
    else delete process.env.ELANOUS_HOLD_PTY_ID;
    if (over.observeOnly) process.env.ELANOUS_SELF_IMPLEMENT_OBSERVE_ONLY = '1';
    else delete process.env.ELANOUS_SELF_IMPLEMENT_OBSERVE_ONLY;
    if (over.harnessSpace) process.env.ELANOUS_HARNESS_SPACE = over.harnessSpace;
    else delete process.env.ELANOUS_HARNESS_SPACE;
    if (over.harnessSpaceId) process.env.ELANOUS_HARNESS_SPACE_ID = over.harnessSpaceId;
    else delete process.env.ELANOUS_HARNESS_SPACE_ID;
    let spawned: { env?: Record<string, string> } | undefined;
    setPtyAdapterForTesting((o) => { spawned = o as { env?: Record<string, string> }; return mockAdapter([], () => {}); });
    const root = over.root ?? mkdtempSync(join(tmpdir(), 'elanous-held-identity-'));
    try {
      await runPtyDrive({
        elanous: true, hold: true, spawnOwner: false, repoRoot: '/repo', cwd: root, isolatedRoot: root,
        ...(over.ptyId ? { ptyId: over.ptyId } : {}),
        out: () => {}, writeScreen: () => {},
      });
      return spawned?.env ?? {};
    } finally {
      if (priorAmbient === undefined) delete process.env.ELANOUS_HOLD_PTY_ID;
      else process.env.ELANOUS_HOLD_PTY_ID = priorAmbient;
      if (priorObserveOnly === undefined) delete process.env.ELANOUS_SELF_IMPLEMENT_OBSERVE_ONLY;
      else process.env.ELANOUS_SELF_IMPLEMENT_OBSERVE_ONLY = priorObserveOnly;
      if (priorHarnessSpace === undefined) delete process.env.ELANOUS_HARNESS_SPACE;
      else process.env.ELANOUS_HARNESS_SPACE = priorHarnessSpace;
      if (priorHarnessSpaceId === undefined) delete process.env.ELANOUS_HARNESS_SPACE_ID;
      else process.env.ELANOUS_HARNESS_SPACE_ID = priorHarnessSpaceId;
    }
  };

  test('held 자식은 외부 fallback dev-hold를 받고 부모 harness 공간은 보존한다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'manual hold child!'));
    const outside = await heldChildEnv({ root });
    const inherited = await heldChildEnv({ root, harnessSpace: 'self-implement', harnessSpaceId: 'existing-space' });

    expect(outside.ELANOUS_HARNESS_SPACE).toBe('dev-hold');
    expect(outside.ELANOUS_HARNESS_SPACE_ID).toMatch(/^manual-hold-child-/);
    expect(inherited.ELANOUS_HARNESS_SPACE).toBe('self-implement');
    expect(inherited.ELANOUS_HARNESS_SPACE_ID).toBe('existing-space');
  });

  test('held 자식 env 에 PTY 정체성이 실린다 — 명시 ptyId 가 ambient 를 이긴다', async () => {
    // ⭐ ambient(부모가 owner 로 재실행될 때 넘기는 값)만 있을 때
    expect((await heldChildEnv({ ambient: 'pty_11111111' })).ELANOUS_PTY_ID).toBe('pty_11111111');
    // ⭐ 명시 opts.ptyId 가 있으면 그것이 이긴다
    expect((await heldChildEnv({ ptyId: 'pty_22222222', ambient: 'pty_11111111' })).ELANOUS_PTY_ID).toBe('pty_22222222');
    // ⛔ 둘 다 없으면 키를 만들지 않는다 (빈 경로)
    expect((await heldChildEnv({})).ELANOUS_PTY_ID).toBeUndefined();
  });

  test('held 자식은 부모 observe-only 플래그만 부팅 전 env 로 물려받고 나머지 env 는 보존한다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'elanous-held-observe-only-'));
    const priorRunId = process.env.ELANOUS_RUN_ID;
    const runId = 'run-held-observe-only';
    process.env.ELANOUS_RUN_ID = runId;
    try {
      const enabled = await heldChildEnv({ observeOnly: true, root });
      const disabled = await heldChildEnv({ root });

      expect(enabled.ELANOUS_SELF_IMPLEMENT_OBSERVE_ONLY).toBe('1');
      expect(disabled.ELANOUS_SELF_IMPLEMENT_OBSERVE_ONLY).toBeUndefined();
      expect(enabled.ELANOUS_RUN_ID).toBe(runId);
      expect(disabled.ELANOUS_RUN_ID).toBe(runId);
      const { ELANOUS_SELF_IMPLEMENT_OBSERVE_ONLY: _enabledFlag, ...enabledRest } = enabled;
      const { ELANOUS_SELF_IMPLEMENT_OBSERVE_ONLY: _disabledFlag, ...disabledRest } = disabled;
      expect(enabledRest).toEqual(disabledRest);
    } finally {
      if (priorRunId === undefined) delete process.env.ELANOUS_RUN_ID;
      else process.env.ELANOUS_RUN_ID = priorRunId;
    }
  });

  test('owner argv 는 스코프 결정자를 물려받지 않는다 (1층이 스탬프를 이기지 못하게)', () => {
    // ⛔ 부모가 어떤 형태로 우주를 정했든, 자식에겐 **해석 결과 하나**만 간다.
    expect(stripScopeArgs(['--test', 'dev', '--elanous'])).toEqual(['dev', '--elanous']);
    expect(stripScopeArgs(['--test=/tmp/x', 'dev'])).toEqual(['dev']);
    expect(stripScopeArgs(['--config-dir', '/tmp/x', 'dev'])).toEqual(['dev']);
    expect(stripScopeArgs(['--config-dir=/tmp/x', 'dev'])).toEqual(['dev']);
    // ⭐ 스코프와 무관한 인자는 건드리지 않는다(값 토큰을 잘못 먹으면 명령이 깨진다).
    expect(stripScopeArgs(['dev', '--elanous', '--hold', '-d', '/w'])).toEqual(['dev', '--elanous', '--hold', '-d', '/w']);
    // ⛔ `--` 뒤는 자식 명령의 인자다 — 걷어내면 남의 명령이 깨진다.
    expect(stripScopeArgs(['--test', 'drive', '--', 'sh', '--test'])).toEqual(['drive', '--', 'sh', '--test']);
  });

  test('스코프는 argv 에 끼워 넣는다 — `--` 뒤로 밀리면 파싱되지 않는다', () => {
    // ⛔ 끝에 붙이면 passthrough 뒤라 우리 플래그로 안 읽힌다(무인 리뷰 must-fix).
    expect(withScopeArgs(['drive', '--', 'sh', '-c', 'x'], '/R'))
      .toEqual(['drive', '--config-dir', '/R', '--', 'sh', '-c', 'x']);
    expect(withScopeArgs(['--test', 'dev', '--elanous'], '/R'))
      .toEqual(['dev', '--elanous', '--config-dir', '/R']);
  });

  test('4우주 — owner 가 해석하는 뿌리와 checker 가 조회하는 뿌리가 넷 전부에서 같다', async () => {
    const testRoot = realpathSync(mkdtempSync(join(tmpdir(), 'universe-test-')));
    const childRoot = realpathSync(mkdtempSync(join(tmpdir(), 'universe-child-')));

    // ① prod            — 결정자 없음(4층 기본)
    // ② prod → 격리      — 부모가 prod 인데 격리 루트가 명시로 정해졌다
    // ③ test            — 부모 스탬프(2층)
    // ④ test → 격리      — 스탬프 ⊕ 명시(1층이 이긴다)
    const universes = {
      '①prod': await universe({}),
      '②prod→격리': await universe({ configOverride: childRoot }),
      // ⭐ ③④ 는 부모가 **`--test` argv 로** 결정한 우주다 — owner 가 그걸 물려받으면 안 된다.
      '③test': await universe({ stateDir: testRoot, parentArgv: ['--test', 'dev', '--elanous', '--hold'] }),
      '④test→격리': await universe({ stateDir: testRoot, configOverride: childRoot, parentArgv: ['--test', 'dev', '--elanous', '--hold'] }),
    };

    for (const [label, u] of Object.entries(universes)) {
      // ⛔⭐ **계약 자체를 잰다** — 양쪽이 같은 값을 **같은 층(1층 명시 --config-dir)** 으로 받는가.
      //    ⚠️ 종전엔 argv 를 스니핑해 해석기를 다시 돌렸는데, 그건 자기충족이라 파싱을 안 잰다
      //       (무인 리뷰 must-fix). 여기서는 **자식들이 실제로 받는 인자**를 직접 비교한다.
      expect(`${label}: ${u.ownerScope.join(' ')}`).toBe(`${label}: ${u.checkerScope.join(' ')}`);
      expect(`${label}: ${u.ownerScope.join(' ')}`).toBe(`${label}: --config-dir ${u.ownerRoot}`);
      // ⭐ env 스탬프(2층)도 같은 뿌리다 — 1층이 이기지만, 두 축이 어긋나 있으면 그 자체가 결함이다.
      expect(`${label}: ${u.ownerStamp}`).toBe(`${label}: ${u.ownerRoot}`);
    }

    // ⭐ 음성 대조 — 층별 결과가 실제로 갈리는가. 전부 같으면 위 루프가 아무것도 증명하지 않는다.
    expect(universes['②prod→격리'].ownerRoot).toBe(childRoot);
    expect(universes['③test'].ownerRoot).toBe(testRoot);
    expect(universes['④test→격리'].ownerRoot).toBe(childRoot);   // 1층이 2층을 이긴다
    expect(universes['①prod'].ownerRoot).not.toBe(testRoot);
    expect(universes['①prod'].ownerRoot).not.toBe(childRoot);
  });

  // ⭐ 인수 시 추가(2026-07-30) — 구현에는 거부 셋이 있었는데 **아무 테스트도 재지 않았다**.
  //    뮤테이션으로 확인: `hold cannot be combined with goal` 을 무력화해도 16 tests 가 0 fail 이었다.
  //    ⇒ "수락 후 무시 금지" 는 이 레포의 불변식이므로 그 거부를 테스트로 고정한다.
  test.each([
    ['hold requires elanous target', { hold: true, cwd: '/tmp' }, /hold requires elanous target/],
    ['hold rejects a goal instead of silently ignoring it', { elanous: true, hold: true, goal: 'g', cwd: '/tmp' }, /hold cannot be combined with goal/],
    ['non-hold drive still requires a goal', { elanous: true, cwd: '/tmp' }, /drive requires a non-empty goal/],
  ] as const)('%s', async (_name, opts, expected) => {
    setPtyAdapterForTesting(() => mockAdapter([], () => {}));
    await expect(runPtyDrive({ ...opts, repoRoot: '/repo', out: () => {}, writeScreen: () => {} } as Parameters<typeof runPtyDrive>[0]))
      .rejects.toThrow(expected);
  });

  // ⛔⭐⭐ 위 표는 `out`/`writeScreen` 을 주입하므로 **production 의 detached-owner 분기를 우회**한다
  //    (리뷰 must-fix · 2026-07-30). 초판은 그래서 "거부가 owner spawn **뒤**에 있다" 는 결함을
  //    **잡지 못했다** — 실제 호출에서는 자식을 띄운 다음 30초 timeout 으로 실패했다.
  // ⇒ 거부를 spawn 앞으로 옮겼으므로 **주입 없이도** spawn 전에 던져야 한다. 그것을 여기서 고정한다.
  //    ⭐ 판정: Bun.spawn 이 한 번도 불리지 않아야 한다(불렸다면 우회 경로가 되살아난 것이다).
  test.each([
    ['hold+non-elanous rejects before spawning an owner', { hold: true, cwd: '/tmp' }, /hold requires elanous target/],
    ['hold+goal rejects before spawning an owner', { elanous: true, hold: true, goal: 'g', cwd: '/tmp' }, /hold cannot be combined with goal/],
    // ⛔ 경계값 — `--goal ''` 은 trim() 기준이면 통과해 **조용히 무시**된다(수락 후 무시 금지 위반).
    ['hold+empty goal still rejects (accepted-then-ignored is forbidden)', { elanous: true, hold: true, goal: '', cwd: '/tmp' }, /hold cannot be combined with goal/],
    ['hold+whitespace goal still rejects', { elanous: true, hold: true, goal: '   ', cwd: '/tmp' }, /hold cannot be combined with goal/],
    // ⛔ 런타임 계층에도 brain 전용 옵션 거부 테스트가 필요하다(리뷰 must-fix · 2026-07-30) —
    //    상위 두 층(dev-cli·dev-pipeline)에만 있어서 **이 층의 brainOnly 블록을 삭제해도 전부 통과**했다.
    ['hold+maxSteps rejects before spawning (brain-only)', { elanous: true, hold: true, maxSteps: 5, cwd: '/tmp' }, /brain-only options: maxSteps/],
    ['hold+pollMs rejects before spawning (brain-only)', { elanous: true, hold: true, pollMs: 0, cwd: '/tmp' }, /brain-only options: pollMs/],
    ['hold+model rejects before spawning (brain-only)', { elanous: true, hold: true, model: 'x', cwd: '/tmp' }, /brain-only options: model/],
  ] as const)('%s', async (_name, opts, expected) => {
    const originalSpawn = Bun.spawn;
    let spawnCalls = 0;
    (Bun as { spawn: typeof Bun.spawn }).spawn = ((...args: Parameters<typeof Bun.spawn>) => {
      spawnCalls += 1;
      return originalSpawn(...args);
    }) as typeof Bun.spawn;
    try {
      await expect(runPtyDrive({ ...opts, repoRoot: '/repo' } as Parameters<typeof runPtyDrive>[0])).rejects.toThrow(expected);
      expect(spawnCalls).toBe(0);
    } finally {
      (Bun as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
    }
  });

  test('elanous target preserves its established harness space in child env and mirror key', async () => {
    const writes: string[] = [];
    const mirrors: string[] = [];
    let spawned: { env?: Record<string, string> } | undefined;
    setPtyAdapterForTesting((opts) => { spawned = opts; return mockAdapter(writes, () => {}); });
    const root = mkdtempSync(join(tmpdir(), 'elanous-drive-space-'));
    const previous = {
      space: process.env.ELANOUS_HARNESS_SPACE,
      id: process.env.ELANOUS_HARNESS_SPACE_ID,
      run: process.env.ELANOUS_RUN_ID,
    };
    process.env.ELANOUS_HARNESS_SPACE = 'dev-harness';
    process.env.ELANOUS_HARNESS_SPACE_ID = 'explicit-space';
    process.env.ELANOUS_RUN_ID = 'run-explicit-space';
    try {
      await runPtyDrive({
        elanous: true, goal: 'x', repoRoot: '/repo', cwd: root, isolatedRoot: root, bootMs: 0, sleep: async () => {},
        stream: async () => '{"action":"done","reason":"ready"}', out: () => {}, maxSteps: 1, pollMs: 0,
        writeScreen: (key) => { mirrors.push(key); },
      });
    } finally {
      if (previous.space === undefined) delete process.env.ELANOUS_HARNESS_SPACE; else process.env.ELANOUS_HARNESS_SPACE = previous.space;
      if (previous.id === undefined) delete process.env.ELANOUS_HARNESS_SPACE_ID; else process.env.ELANOUS_HARNESS_SPACE_ID = previous.id;
      if (previous.run === undefined) delete process.env.ELANOUS_RUN_ID; else process.env.ELANOUS_RUN_ID = previous.run;
    }
    expect(spawned!.env).toMatchObject({
      ELANOUS_HARNESS_SPACE: 'dev-harness', ELANOUS_HARNESS_SPACE_ID: 'explicit-space', ELANOUS_RUN_ID: 'run-explicit-space',
    });
    expect(mirrors).toEqual(['explicit-space', 'explicit-space', 'explicit-space']);
  });

  test('elanous target creates and removes an OS-temporary isolated root rather than polluting cwd or inheriting caller state', async () => {
    let spawned: { args?: string[]; env?: Record<string, string> } | undefined;
    setPtyAdapterForTesting((opts) => { spawned = opts; return mockAdapter([], () => {}); });
    const cwd = mkdtempSync(join(tmpdir(), 'elanous-drive-worktree-'));
    const result = await runPtyDrive({
      elanous: true, goal: 'x', repoRoot: '/repo', cwd, bootMs: 0, sleep: async () => {},
      stream: async () => '{"action":"done","reason":"ready"}', out: () => {}, maxSteps: 1, pollMs: 0,
    });
    expect(result.exitCode).toBe(0);
    const configDir = spawned!.args![2]!;
    const stateDir = spawned!.args![4]!;
    expect(configDir).not.toContain(cwd);
    expect(configDir).not.toBe(process.env.ELANOUS_STATE_DIR);
    expect(stateDir).toBe(configDir);
    expect(spawned!.env!.ELANOUS_STATE_DIR).toBe(configDir);
    expect(existsSync(configDir)).toBe(false);
    expect(existsSync(stateDir)).toBe(false);
  });

  test('elanous target rejects an explicit isolated root that is not a writable directory before spawning', async () => {
    let spawned = false;
    setPtyAdapterForTesting(() => { spawned = true; return mockAdapter([], () => {}); });
    const root = join(mkdtempSync(join(tmpdir(), 'elanous-drive-file-')), 'not-a-directory');
    writeFileSync(root, 'file');
    await expect(runPtyDrive({
      elanous: true, goal: 'x', cwd: mkdtempSync(join(tmpdir(), 'elanous-drive-worktree-')), isolatedRoot: root,
      stream: async () => '{"action":"done","reason":"x"}', out: () => {},
    })).rejects.toThrow(`cannot establish isolated elanous TUI root at ${root}`);
    expect(spawned).toBe(false);
  });

  test('elanous target rejects caller state identity and a symlink alias before spawning', async () => {
    let spawned = false;
    setPtyAdapterForTesting(() => { spawned = true; return mockAdapter([], () => {}); });
    const callerState = mkdtempSync(join(tmpdir(), 'elanous-drive-parent-'));
    const alias = join(mkdtempSync(join(tmpdir(), 'elanous-drive-alias-')), 'state-link');
    symlinkSync(callerState, alias);
    const originalState = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = callerState;
    try {
      await expect(runPtyDrive({ elanous: true, goal: 'x', cwd: mkdtempSync(join(tmpdir(), 'elanous-drive-worktree-')), isolatedRoot: callerState, out: () => {} })).rejects.toThrow('overlaps caller state directory');
      await expect(runPtyDrive({ elanous: true, goal: 'x', cwd: mkdtempSync(join(tmpdir(), 'elanous-drive-worktree-')), isolatedRoot: alias, out: () => {} })).rejects.toThrow('overlaps caller state directory');
    } finally {
      // ⚠️ `env[k] = undefined` stores the STRING "undefined" — a later test then
      // reads a caller state directory literally named that. Restore by deleting.
      if (originalState === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = originalState;
    }
    expect(spawned).toBe(false);
  });

  test('elanous target rejects caller-state descendants and symlinked descendants before spawning', async () => {
    let spawned = false;
    setPtyAdapterForTesting(() => { spawned = true; return mockAdapter([], () => {}); });
    const callerState = mkdtempSync(join(tmpdir(), 'elanous-drive-parent-'));
    const descendant = join(callerState, 'child');
    const aliasParent = mkdtempSync(join(tmpdir(), 'elanous-drive-alias-parent-'));
    const alias = join(aliasParent, 'state-link');
    symlinkSync(callerState, alias);
    const originalState = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = callerState;
    try {
      await expect(runPtyDrive({ elanous: true, goal: 'x', cwd: mkdtempSync(join(tmpdir(), 'elanous-drive-worktree-')), isolatedRoot: descendant, out: () => {} })).rejects.toThrow('overlaps caller state directory');
      await expect(runPtyDrive({ elanous: true, goal: 'x', cwd: mkdtempSync(join(tmpdir(), 'elanous-drive-worktree-')), isolatedRoot: join(alias, 'child'), out: () => {} })).rejects.toThrow('overlaps caller state directory');
    } finally {
      // ⚠️ `env[k] = undefined` stores the STRING "undefined" — a later test then
      // reads a caller state directory literally named that. Restore by deleting.
      if (originalState === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = originalState;
    }
    expect(spawned).toBe(false);
  });

  // ⚠️ The MIRROR case the one-way check missed: the caller's state lives INSIDE
  // the isolated root. Both one-way containment questions answer "no" there
  // (`/tmp/r` is not under `/tmp/r/state/existing`, and neither is `/tmp/r/state`),
  // so the run was declared isolated while writing straight onto the caller's
  // state. Touching is symmetric; the check has to be too.
  test('elanous target rejects a caller state that lives INSIDE the isolated root', async () => {
    let spawned = false;
    setPtyAdapterForTesting(() => { spawned = true; return mockAdapter([], () => {}); });
    const root = mkdtempSync(join(tmpdir(), 'elanous-drive-root-'));
    const callerState = join(root, 'state', 'existing');
    mkdirSync(callerState, { recursive: true });
    const originalState = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = callerState;
    try {
      await expect(runPtyDrive({ elanous: true, goal: 'x', cwd: mkdtempSync(join(tmpdir(), 'elanous-drive-worktree-')), isolatedRoot: root, out: () => {} })).rejects.toThrow('overlaps caller state directory');
    } finally {
      // ⚠️ `env[k] = undefined` stores the STRING "undefined" — a later test then
      // reads a caller state directory literally named that. Restore by deleting.
      if (originalState === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = originalState;
    }
    expect(spawned).toBe(false);
  });

  test('elanous target rejects a symlinked caller state that resolves inside the isolated root', async () => {
    let spawned = false;
    setPtyAdapterForTesting(() => { spawned = true; return mockAdapter([], () => {}); });
    const root = mkdtempSync(join(tmpdir(), 'elanous-drive-root-'));
    const realInside = join(root, 'state', 'existing');
    mkdirSync(realInside, { recursive: true });
    // The caller points at a symlink that lands inside the isolated root — the
    // overlap is only visible after realpath resolution.
    const alias = join(mkdtempSync(join(tmpdir(), 'elanous-drive-alias-')), 'state-link');
    symlinkSync(realInside, alias);
    const originalState = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = alias;
    try {
      await expect(runPtyDrive({ elanous: true, goal: 'x', cwd: mkdtempSync(join(tmpdir(), 'elanous-drive-worktree-')), isolatedRoot: root, out: () => {} })).rejects.toThrow('overlaps caller state directory');
    } finally {
      // ⚠️ `env[k] = undefined` stores the STRING "undefined" — a later test then
      // reads a caller state directory literally named that. Restore by deleting.
      if (originalState === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = originalState;
    }
    expect(spawned).toBe(false);
  });

  // ⚠️ A directory whose NAME begins with two dots is a legitimate child, not an
  // escape. Reading `..state` as an escape made both directions answer "not
  // contained" for a path plainly inside the isolated root, so the spawn guard
  // was bypassed. The escape cases are only: absolute, exactly `..`, or `..` +
  // separator.
  test('elanous target rejects a caller state in a child directory whose name starts with dots', async () => {
    let spawned = false;
    setPtyAdapterForTesting(() => { spawned = true; return mockAdapter([], () => {}); });
    const root = mkdtempSync(join(tmpdir(), 'elanous-drive-root-'));
    const callerState = join(root, '..state');
    mkdirSync(callerState, { recursive: true });
    const originalState = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = callerState;
    try {
      await expect(runPtyDrive({ elanous: true, goal: 'x', cwd: mkdtempSync(join(tmpdir(), 'elanous-drive-worktree-')), isolatedRoot: root, out: () => {} })).rejects.toThrow('overlaps caller state directory');
    } finally {
      // ⚠️ `env[k] = undefined` stores the STRING "undefined" — a later test then
      // reads a caller state directory literally named that. Restore by deleting.
      if (originalState === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = originalState;
    }
    // The guard must stop it BEFORE spawning — that is what "fail closed" means here.
    expect(spawned).toBe(false);
  });

  test('elanous target fails closed when an isolated root cannot be established', async () => {
    let spawned = false;
    setPtyAdapterForTesting(() => { spawned = true; return mockAdapter([], () => {}); });
    await expect(runPtyDrive({
      elanous: true, goal: 'x', cwd: mkdtempSync(join(tmpdir(), 'elanous-drive-worktree-')), isolatedRoot: '/dev/null/elanous-drive-root',
      stream: async () => '{"action":"done","reason":"x"}', out: () => {},
    })).rejects.toThrow('cannot establish isolated elanous TUI root');
    expect(spawned).toBe(false);
  });

  test('preserves null when the child died without either an exit code or signal, and reports failure at the CLI boundary', async () => {
    setPtyAdapterForTesting(() => mockAdapter([], () => {}, (emit) => {
      queueMicrotask(() => emit({ exitCode: null }));
    }));
    const result = await runPtyDrive({
      command: 'echo x', goal: 'x', stream: async () => '{"action":"done","reason":"ready"}', out: () => {}, maxSteps: 1, pollMs: 0,
    });
    expect(result.exitCode).toBeNull();

    const errors: string[] = [];
    const exits: number[] = [];
    const stop = (code: number): never => { exits.push(code); throw new Error(`exit:${code}`); };
    await expect(runDriveCliCommand('echo x', { goal: 'x', maxSteps: '1', pollMs: '0' }, {
      runPtyDrive: async () => result,
      writeError: (message) => { errors.push(message); },
      exit: stop,
    })).rejects.toThrow('exit:1');
    expect(errors.join('')).toContain('child exited without an exit code');
    expect(exits).toEqual([1]);
  });

  test('kills and unregisters when the brain throws', async () => {
    let killed = false;
    setPtyAdapterForTesting(() => mockAdapter([], () => { killed = true; }));
    const result = await runPtyDrive({ command: 'echo x', goal: 'x', stream: async () => { throw new Error('brain failed'); }, out: () => {}, maxSteps: 1, pollMs: 0 });
    expect(result.exitCode).toBe(1);
    expect(killed).toBe(true);
  });
});

describe('ptyListReportsAlive — hold ready 판정', () => {
  // ⛔ 실측 형식(2026-08-01): `pty list` 는 마지막에 컬럼을 하나 더 붙인다.
  //    종전 판정(`line.endsWith('\talive')`)은 이 형식에서 한 번도 참이 될 수 없었고,
  //    그래서 `--hold` 가 항상 30초 타임아웃 → owner kill → "owner 가 죽었다" 로 보였다.
  const LIVE_FORMAT = 'tui:25461\ttui\t-\tremote\talive\t?';

  test('alive 가 마지막 필드가 아니어도 찾는다 (회귀: 줄 끝 매칭)', () => {
    expect(ptyListReportsAlive(LIVE_FORMAT, 'tui:25461')).toBe(true);
    // 종전 구현이 쓰던 자: 같은 입력에서 거짓이었다 — 이 대조가 회귀를 고정한다.
    expect(LIVE_FORMAT.endsWith('\talive')).toBe(false);
  });

  test('컬럼이 더 늘어도 견딘다', () => {
    expect(ptyListReportsAlive('pty_a\tpty\t-\tremote\talive\t?\textra', 'pty_a')).toBe(true);
  });

  test('id 는 첫 필드로만 일치시킨다 (접두 오탐 금지)', () => {
    expect(ptyListReportsAlive(LIVE_FORMAT, 'tui:254')).toBe(false);
    expect(ptyListReportsAlive('other\ttui\t-\tremote\talive\t?', 'tui:25461')).toBe(false);
  });

  test('상태 컬럼이 아닌 자리의 alive 는 오판하지 않는다 (음성 · 리뷰 must-fix)', () => {
    // 닉네임(3번째 필드)이 'alive' 인데 상태는 exited — includes() 였다면 참으로 오판했다.
    expect(ptyListReportsAlive('pty_a\tpty\talive\tremote\texited\t?', 'pty_a')).toBe(false);
    // kind 자리가 alive 인 경우도 마찬가지.
    expect(ptyListReportsAlive('pty_a\talive\t-\tremote\texited\t?', 'pty_a')).toBe(false);
  });

  test('alive 가 아니면 거짓이다', () => {
    expect(ptyListReportsAlive('tui:25461\ttui\t-\tremote\texited\t?', 'tui:25461')).toBe(false);
  });

  test('여러 줄에서 해당 id 만 본다', () => {
    const many = ['a\tpty\t-\tremote\texited\t?', LIVE_FORMAT, 'b\tpty\t-\tremote\talive\t?'].join('\n');
    expect(ptyListReportsAlive(many, 'tui:25461')).toBe(true);
    expect(ptyListReportsAlive(many, 'a')).toBe(false);
  });
});

// ⛔⭐⭐⭐ 2026-08-05 · `[S]` 제보 — `dev --elanous --hold --worktree` 가 «항상» 안 떴다.
//   기전: owner 가 부모 argv 를 물려받아 `--worktree` 를 «다시» 보고, 런 신원은 상속되므로
//   같은 이름의 워크트리를 만들려다 실패해 ***PTY 등록 전에 죽었다.***
//   📏 기전 재현(별도 실측): 같은 runId 로 두 번 부르면
//     `git worktree add failed — branch dev/<runId> is already used by worktree at …`
describe('owner argv — 부모가 «이미 소비한» 인자를 물려주지 않는다', () => {
  test('⛔ --worktree 와 짧은 형태 -w 를 걷는다', async () => {
    const { stripParentAppliedArgs } = await import('./pty-drive-cli');
    expect(stripParentAppliedArgs(['dev', '--elanous', '--hold', '--worktree'])).toEqual(['dev', '--elanous', '--hold']);
    expect(stripParentAppliedArgs(['dev', '-w', '--elanous'])).toEqual(['dev', '--elanous']);
  });

  test('⛔ `--` 뒤는 «건드리지 않는다» — 남의 명령의 인자다', async () => {
    const { stripParentAppliedArgs } = await import('./pty-drive-cli');
    expect(stripParentAppliedArgs(['drive', '--worktree', '--', 'sh', '-c', 'echo --worktree']))
      .toEqual(['drive', '--', 'sh', '-c', 'echo --worktree']);
  });

  test('⭐ 그 밖의 인자는 «한 바이트도» 안 건드린다', async () => {
    const { stripParentAppliedArgs } = await import('./pty-drive-cli');
    const argv = ['dev', '--elanous', '--hold', '--cwd', '/x', '--model', 'sol'];
    expect(stripParentAppliedArgs(argv)).toEqual(argv);
  });

  test('⛔ 스코프 걷기와 «함께» 걸어도 둘 다 먹는다 — owner 가 받는 최종 형태', async () => {
    const { stripParentAppliedArgs, withScopeArgs } = await import('./pty-drive-cli');
    const out = withScopeArgs(stripParentAppliedArgs(['dev', '--test', '--worktree', '--elanous', '--hold']), '/root');
    expect(out).not.toContain('--worktree');
    expect(out).not.toContain('--test');
    expect(out).toContain('--config-dir');
    expect(out).toContain('--elanous');
  });
});

// ⛔⭐⭐⭐ 라이브가 잡은 «둘째 마디» — `--worktree` 를 걷기만 하면 owner 는 작업 디렉토리를
//   «아예 잃고», 격리 우주가 그것을 거부한다(실측 문면: "격리 우주에서는 작업 디렉토리를
//   명시해야 한다 — --cwd <worktree-path>"). ⇒ 걷은 자리를 «메워야» 완결된다.
describe('owner argv — 걷은 자리를 --cwd 로 메운다', () => {
  test('⛔ --cwd 가 없으면 «부모가 만든 경로»를 명시로 넣는다', async () => {
    const { withOwnerCwdArg } = await import('./pty-drive-cli');
    expect(withOwnerCwdArg(['dev', '--elanous', '--hold'], '/wt/a'))
      .toEqual(['dev', '--elanous', '--hold', '--cwd', '/wt/a']);
  });

  test('⛔ 사람이 이미 준 --cwd 는 «덮지 않는다» — 명시가 이긴다', async () => {
    const { withOwnerCwdArg } = await import('./pty-drive-cli');
    expect(withOwnerCwdArg(['dev', '--cwd', '/mine', '--hold'], '/wt/a'))
      .toEqual(['dev', '--cwd', '/mine', '--hold']);
    expect(withOwnerCwdArg(['dev', '--cwd=/mine'], '/wt/a')).toEqual(['dev', '--cwd=/mine']);
  });

  test('⛔ `--` 뒤에는 «안» 넣는다 — 남의 명령의 인자가 된다', async () => {
    const { withOwnerCwdArg } = await import('./pty-drive-cli');
    expect(withOwnerCwdArg(['drive', '--', 'sh', '-c', 'x'], '/wt/a'))
      .toEqual(['drive', '--cwd', '/wt/a', '--', 'sh', '-c', 'x']);
  });

  test('⭐ 세 걷기·메우기의 «최종 형태» — owner 가 실제로 받는 argv', async () => {
    const { stripParentAppliedArgs, withScopeArgs, withOwnerCwdArg } = await import('./pty-drive-cli');
    const out = withOwnerCwdArg(
      withScopeArgs(stripParentAppliedArgs(['dev', '--test', '--worktree', '--elanous', '--hold']), '/root'),
      '/wt/a',
    );
    expect(out).not.toContain('--worktree');
    expect(out).not.toContain('--test');
    expect(out).toContain('--config-dir');
    expect(out.slice(out.indexOf('--cwd'), out.indexOf('--cwd') + 2)).toEqual(['--cwd', '/wt/a']);
  });
});

// ⛔⭐⭐⭐ owner 사망 경로 — 세 갈래를 «다른 답»으로 고정한다(리뷰 must-fix · 2026-08-05).
//   ⑴ 죽었고 등록도 없다      → 30초 안 기다리고 «사유»를 낸다(로그 꼬리 ⊕ 전문 경로)
//   ⑵ 죽었지만 «등록은 됐다»  → 답은 「죽었다」가 아니라 「떴다」다(경합)
//   ⑶ exitCode 를 «모른다»    → 「죽었다」로 읽지 않는다(undefined ≠ 사망)
describe('hold owner 사망 — 세 갈래', () => {
  const { writeFileSync: wf } = require('node:fs') as typeof import('node:fs');

  const holdWithOwner = async (
    owner: Record<string, unknown>,
    sync: (mintedId: string) => { stdout: Uint8Array; stderr?: Uint8Array; exitCode?: number },
    ownerLogText?: string,
  ): Promise<string> => {
    const originalSpawn = Bun.spawn;
    const originalSpawnSync = Bun.spawnSync;
    let mintedId = '';
    (Bun as { spawn: typeof Bun.spawn }).spawn = ((...a: Parameters<typeof Bun.spawn>) => {
      mintedId = (a[0] as { env?: Record<string, string> }).env?.ELANOUS_HOLD_PTY_ID ?? '';
      // ⭐ 실제 owner 가 남겼을 산출을 그 자리에 심는다 — 문면이 그것을 싣는지 본다.
      if (ownerLogText !== undefined) {
        try { wf(join(tmpdir(), `elanous-hold-owner-${mintedId}.log`), ownerLogText); } catch { /* best-effort */ }
      }
      // ⛔⭐ `{...owner}` 로 «복사»하면 스폰 시점 값이 얼어붙어 «전이»를 못 잰다
      //   (첫 판이 그래서 ⑸⑹이 못 물렸다 — 자가 대상보다 먼저 굳은 자리다).
      //   ⇒ 게터로 «지금 값»을 본다.
      return {
        unref() {}, kill() {},
        get exitCode() { return (owner as { exitCode?: number }).exitCode; },
      } as unknown as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn;
    (Bun as { spawnSync: typeof Bun.spawnSync }).spawnSync = ((
      ..._a: Parameters<typeof Bun.spawnSync>
    ) => sync(mintedId) as unknown as ReturnType<typeof Bun.spawnSync>) as typeof Bun.spawnSync;
    setPtyAdapterForTesting(() => mockAdapter([], () => {}));
    const root = mkdtempSync(join(tmpdir(), 'elanous-hold-owner-died-'));
    try {
      await runPtyDrive({
        elanous: true, hold: true, repoRoot: '/repo', cwd: root, isolatedRoot: root,
        readyTimeoutMs: 30, settlementMs: 0, out: () => {}, writeScreen: () => {},
      });
      return '(threw nothing)';
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    } finally {
      (Bun as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
      (Bun as { spawnSync: typeof Bun.spawnSync }).spawnSync = originalSpawnSync;
    }
  };

  const emptyList = () => ({ stdout: new TextEncoder().encode(''), exitCode: 0 });
  const aliveList = (id: string) => ({
    stdout: new TextEncoder().encode(`${id}\ttui\t-\tremote\talive\n`), exitCode: 0,
  });

  test('⑴ ⛔ 죽었고 등록도 없으면 «사유»를 낸다 — 「30초 기다렸다」가 아니다', async () => {
    const msg = await holdWithOwner({ exitCode: 1 }, emptyList, '앞줄\n❌ 격리 우주에서는 작업 디렉토리를 명시해야 한다\n');
    expect(msg).toContain('exited before registering a PTY (exit=1)');
    expect(msg).toContain('작업 디렉토리를 명시해야 한다');   // ⭐ owner 가 «말한 것»이 실린다
    expect(msg).toContain('전문:');                          // 전문 경로도 준다
    expect(msg).not.toContain('did not become ready');
  });

  test('⑵ ⛔ 죽었어도 «등록이 됐으면» 성공이다 — 경합을 오판하지 않는다', async () => {
    const msg = await holdWithOwner({ exitCode: 0 }, aliveList);
    expect(msg).toBe('(threw nothing)');
  });

  test('⑶ ⛔ exitCode 를 «모르면»(undefined) 「죽었다」로 읽지 않는다', async () => {
    // 사망 판정이 `!== null` 이면 여기서 즉시 사망으로 접힌다(첫 판이 그랬고 기존 6건을 깼다).
    const msg = await holdWithOwner({}, emptyList);
    expect(msg).toContain('did not become ready');            // 정상 타임아웃 경로
    expect(msg).not.toContain('exited before registering');
  });

  // ⛔⭐⭐ 리뷰 must-fix — 「마지막 checker 실행 «도중»」 죽는 전이. 고정된 exitCode 로는 못 잡는다.
  //   종전엔 루프를 나온 뒤 exitCode 를 다시 안 읽어 «일반 timeout» 으로 오판했다.
  test('⑸ ⛔ 마지막 폴 «도중» 죽어도 사유를 낸다 — 일반 timeout 으로 접지 않는다', async () => {
    const owner: { exitCode?: number } = {};
    // checker 가 불릴 때 «그제서야» 죽는다 — 루프 안의 사망 검사는 이미 지나간 뒤다
    const msg = await holdWithOwner(owner, () => { owner.exitCode = 3; return emptyList(); }, 'boom\n');
    expect(msg).toContain('exited before registering a PTY (exit=3)');
    expect(msg).not.toContain('did not become ready');
  });

  test('⑹ ⛔ 마지막 폴 도중 죽었지만 «등록은 됐으면» 성공이다 — 재판정이 먼저다', async () => {
    const owner: { exitCode?: number } = {};
    let mid = '';
    const msg = await holdWithOwner(owner, (id) => {
      mid = id;
      if (owner.exitCode === undefined) { owner.exitCode = 0; return emptyList(); }   // 첫 폴: 없음 ⊕ 그때 죽는다
      return aliveList(mid);                                                          // 재판정: 있다
    }, '');
    expect(msg).toBe('(threw nothing)');
  });

  test('⭐ 로그가 «비어도» 문면이 그 사실을 말한다 — 수를 꾸며내지 않는다', async () => {
    const msg = await holdWithOwner({ exitCode: 2 }, emptyList, '');
    expect(msg).toContain('exit=2');
    expect(msg).toContain('owner 산출 없음');
  });
});
