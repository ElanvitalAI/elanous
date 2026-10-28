// /term·/terminal 등록, 명령 dispatch, 격리 PTY resume 계약.
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { defaultSessionsPath, loadPersistedSessions, wirePersistence } from '../src/terminal/session-persistence.js';
import { DisplayCoordinator } from '../src/display/coordinator.js';
import { TerminalSessionRegistry } from '../src/terminal/session-registry.js';
import { PreviewTerminal } from '../src/preview/terminal.js';
import { listPty, ptyAvailable } from '../src/pty-shell/registry.js';
import { createControlSignalBus } from '../src/input/control-signal.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDashboardSlashRegistry } from '../src/dashboard/slash-runtime/dashboard-handlers.js';
import * as oldEntry from '../src/dashboard/slash-runtime/index.js';
import { SlashCommandRegistry } from '../src/dashboard/slash-runtime/registry.js';
import { handleTermSlash, registerTermSlash, type TermSlashContext } from '../src/tui/slash/term.js';
import { createDashboardTermSlashRuntime } from '../src/dashboard/term-slash-runtime.js';

describe('/term 등록 (src/tui/slash/term.ts)', () => {
  test('production showDashboard dispatch reaches registerTermSlash and handleTermSlash', () => {
    const dashboard = readFileSync(new URL('../src/dashboard/index.ts', import.meta.url), 'utf8');
    const handlers = readFileSync(new URL('../src/dashboard/slash-runtime/dashboard-handlers.ts', import.meta.url), 'utf8');
    const term = readFileSync(new URL('../src/tui/slash/term.ts', import.meta.url), 'utf8');
    expect(dashboard).toContain('const termSlashRuntime = createDashboardTermSlashRuntime({');
    expect(dashboard).toContain('slashRuntime: termSlashRuntime,');
    expect(dashboard).toContain('dashboardSlashRegistry.dispatch(cmdLower, args, slashCtx)');
    expect(handlers).toContain('registerTermSlash(registry);');
    expect(term).toContain('slashRuntime.helpLines()');
    expect(term).toContain('await handleTermSlash(args, ctx);');
  });

  test('대시보드 레지스트리에 옛 자리(ad 다음 · local 앞)에 별칭 둘로 한 번만 등록된다', () => {
    const names = buildDashboardSlashRegistry().names();
    expect(names.filter((n) => n === 'term')).toHaveLength(1);
    expect(names.filter((n) => n === 'terminal')).toHaveLength(1);
    const at = names.indexOf('term');
    expect(names.slice(at - 1, at + 3)).toEqual(['ad', 'term', 'terminal', 'local']);
  });

  test('옛 입구(slash-runtime/index.ts)가 새 집의 공개 심볼을 그대로 낸다', () => {
    expect(oldEntry.registerTermSlash).toBe(registerTermSlash);
    expect(oldEntry.handleTermSlash).toBe(handleTermSlash);
  });

  test('registerTermSlash 는 빈 레지스트리에 term·terminal 만 단다', () => {
    const reg = new SlashCommandRegistry<TermSlashContext, never>();
    registerTermSlash(reg);
    expect(reg.names()).toEqual(['term', 'terminal']);
  });

  test('mock slash stage labels formal commands while keeping experimental commands off default help', async () => {
    const format = (text: string) => text;
    const ctx = {
      chatLines: [] as string[], setChatScrollOffset: () => {},
      termSlash: { slashRuntime: createDashboardTermSlashRuntime({ accent: format, muted: format, warning: format, error: format, text: format }) },
    } as unknown as TermSlashContext;
    await handleTermSlash(['help'], ctx);
    const basic = ctx.chatLines.join('\n');
    expect(basic).toContain('Formal commands');
    for (const name of ['new', 'list', 'attach', 'detach', 'switch', 'kill', 'resume', 'snapshot']) {
      expect(basic).toContain(`/term ${name}`);
    }
    for (const name of ['matrix', 'move', 'group', 'channel', 'pipe', 'readonly', 'recharacter']) {
      expect(basic).not.toContain(`/term ${name} `);
    }
    ctx.chatLines.length = 0;
    await handleTermSlash(['help', 'experimental'], ctx);
    expect(ctx.chatLines.join('\n')).toContain('Experimental commands');
  });

  test('retired VW dispatch identifies each command without reading or changing mock terminal state', async () => {
    let scrolls = 0;
    const ctx = {
      chatLines: [] as string[],
      warning: (text: string) => `warning:${text}`,
      setChatScrollOffset: () => { scrolls++; },
      termSlash: new Proxy({}, { get: () => { throw new Error('retired command accessed terminal state'); } }),
    } as unknown as TermSlashContext;
    const cases = [
      { args: ['vw-bar', '7', 'off'], name: 'vw-bar' },
      { args: ['vw-sync', '7', 'hello'], name: 'vw-sync' },
      { args: ['move', 'term:1', 'vw'], name: 'move <id> vw' },
    ];
    for (const { args, name } of cases) {
      await handleTermSlash(args, ctx);
      expect(ctx.chatLines.at(-1)).toContain(name);
      expect(ctx.chatLines.at(-1)).toContain('retired');
    }
    expect(ctx.chatLines).toHaveLength(cases.length);
    expect(scrolls).toBe(cases.length);
  });

  test('formal and experimental subcommands still dispatch through the registered /term handler', async () => {
    const calls: string[] = [];
    const format = (text: string) => text;
    const ctx = {
      chatLines: [] as string[], setChatScrollOffset: () => {},
      accent: format, warning: format, error: format, draw: () => {},
      termSlash: {
        slashRuntime: createDashboardTermSlashRuntime({ accent: format, muted: format, warning: format, error: format, text: format }),
        openNewTerminal: (command?: string) => { calls.push(`new:${command}`); },
        openSessionPicker: () => { calls.push('switch'); },
        sessionRegistry: {
          list: () => [], foreground: () => null, kill: (id: string) => { calls.push(`kill:${id}`); },
        },
        terminalMatrix: {
          list: () => [], get: () => null, listPipes: () => [],
        },
        broadcastBus: { groups: () => [] },
        channelBus: { channels: () => [] },
      },
    } as unknown as TermSlashContext;
    const reg = new SlashCommandRegistry<TermSlashContext, never>();
    registerTermSlash(reg);
    const root = mkdtempSync(join(tmpdir(), 'term-dispatch-isolated-'));
    const previousState = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = root;
    try {
      for (const [sub, args, expected] of [
        ['help', [], '/term new'], ['help', ['experimental'], '/term matrix'],
        ['new', ['echo', 'hi'], 'new:echo hi'], ['list', [], 'No terminal sessions.'],
        ['attach', [], '/term attach requires'], ['detach', [], 'No foreground session'],
        ['switch', [], 'switch'], ['kill', [], 'No session to kill'],
        ['resume', [], 'No persisted sessions'], ['snapshot', [], 'Usage: /term snapshot'],
        ['matrix', [], '(no terminals'], ['move', [], 'Usage: /term move'],
        ['group', [], '(no broadcast groups'], ['channel', [], '(no channels'],
        ['pipe', [], 'Usage: /term pipe'], ['readonly', [], 'Usage: /term readonly'],
        ['recharacter', [], 'Usage: /term recharacter'],
      ] as const) {
        const linesBefore = ctx.chatLines.length;
        const callsBefore = calls.length;
        await reg.dispatch('term', [sub, ...args], ctx);
        expect([...ctx.chatLines.slice(linesBefore), ...calls.slice(callsBefore)].join('\n')).toContain(expected);
      }
    } finally {
      if (previousState === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previousState;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.skipIf(!ptyAvailable())('detach → resume scenario matrix: saved command/cwd spawn a new PTY without restoring the old screen buffer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'term-resume-isolated-'));
    const previousState = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = root;
    const registry = new TerminalSessionRegistry({
      coordinator: new DisplayCoordinator({ frameMs: 0 }),
      signalBus: createControlSignalBus(() => new Date().toISOString()),
      terminalFactory: (opts) => new PreviewTerminal({ ...opts, shell: '/bin/sh', shellArgs: [], useRegistry: true }),
    });
    const savedCwd = join(root, 'saved-workdir');
    mkdirSync(savedCwd);
    const command = 'printf "%s%s" RESUMED_ FRESH_SCREEN; basename "$PWD"; exec /bin/sh';
    let openedId: string | undefined;
    const format = (text: string) => text;
    const ctx = {
      chatLines: [] as string[], warning: format, error: format, draw: () => {}, setChatScrollOffset: () => {},
      termSlash: {
        sessionRegistry: registry,
        slashRuntime: createDashboardTermSlashRuntime({ accent: format, muted: format, warning: format, error: format, text: format }),
        openSession: (session: { id: string }) => { openedId = session.id; },
      },
    } as unknown as TermSlashContext;
    const waitForMarker = async (read: () => string, marker: string) => {
      const deadline = Date.now() + 10_000;
      while (!read().includes(marker) && Date.now() < deadline) await Bun.sleep(25);
      expect(read()).toContain(marker);
    };
    const waitFor = async (read: () => string, marker: string) => {
      const deadline = Date.now() + 10_000;
      while (!read().includes(marker) && Date.now() < deadline) await Bun.sleep(25);
      expect(read()).toContain(marker);
    };
    const initialPtyIds = new Set(listPty().map(handle => handle.id));
    const detachedIds: string[] = [];
    const stopObservingDetach = registry.subscribe(event => {
      if (event.type === 'detached') detachedIds.push(event.session.id);
    });
    const stopPersistence = wirePersistence(registry);
    try {
      const original = registry.spawn({ title: 'shell', cwd: savedCwd, command, kind: 'shell' }, { termCols: 100, termRows: 30 });
      const oldPty = listPty().find(handle => !initialPtyIds.has(handle.id));
      expect(oldPty?.pid).toBeGreaterThan(0);
      await waitForMarker(() => original.preview.render(false), 'RESUMED_FRESH_SCREEN');
      original.preview.write('printf "%s%s" OLD_SCREEN_BUFFER_ ONLY\r');
      await waitForMarker(() => original.preview.render(false), 'OLD_SCREEN_BUFFER_ONLY');
      const stored = () => loadPersistedSessions().find(entry => entry.id === original.id);
      const initialPersistDeadline = Date.now() + 10_000;
      while (!stored() && Date.now() < initialPersistDeadline) await Bun.sleep(25);
      expect(stored()).toMatchObject({ command, cwd: savedCwd });
      const savedBeforeDetach = statSync(defaultSessionsPath()).mtimeMs;
      await handleTermSlash(['detach'], ctx);
      expect(detachedIds).toEqual([original.id]);
      expect(original.state).toBe('background');
      expect(original.preview.isAlive).toBe(true);
      const detachPersistDeadline = Date.now() + 10_000;
      while (statSync(defaultSessionsPath()).mtimeMs === savedBeforeDetach && Date.now() < detachPersistDeadline) await Bun.sleep(25);
      expect(statSync(defaultSessionsPath()).mtimeMs).toBeGreaterThan(savedBeforeDetach);
      expect(stored()).toMatchObject({ command, cwd: savedCwd });
      await handleTermSlash(['resume', original.id.slice(-8)], ctx);
      const resumed = registry.foreground();
      expect(resumed).toBeDefined();
      expect(resumed!.id).not.toBe(original.id);
      expect(resumed!.preview).not.toBe(original.preview);
      const newPty = listPty().find(handle => !initialPtyIds.has(handle.id) && handle.id !== oldPty?.id);
      expect(newPty?.pid).toBeGreaterThan(0);
      expect(newPty?.pid).not.toBe(oldPty?.pid);
      expect(resumed!.command).toBe(command);
      expect(resumed!.cwd).toBe(savedCwd);
      expect(openedId).toBe(resumed!.id);
      await waitForMarker(() => resumed!.preview.render(false), 'RESUMED_FRESH_SCREEN');
      await waitFor(() => resumed!.preview.render(false), 'saved-workdir');
      expect(resumed!.preview.render(false)).not.toContain('OLD_SCREEN_BUFFER_ONLY');
      expect(original.preview.render(false)).toContain('OLD_SCREEN_BUFFER_ONLY');
      console.log('TERM_RESUME_PTY detach=persisted saved-command=restored saved-cwd=restored pid=new screen-buffer=not-restored');
    } finally {
      stopPersistence();
      stopObservingDetach();
      for (const session of registry.list()) registry.kill(session.id);
      if (previousState === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previousState;
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
