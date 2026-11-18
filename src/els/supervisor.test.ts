import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { elanousCommandFor, ensureServer, renderPlist, serveCommandFor, supervisorOff, supervisorOn, supervisorPaths, supervisorStatus, type SupervisorDeps } from './supervisor.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** Deps over a temp home/state; the server "comes up" when `serverUpAfter` calls to serverState have passed (or never). */
function setup(options: { isDefaultState?: boolean; platform?: NodeJS.Platform; launchctlCode?: number; spawnThrows?: boolean; serverUpOn?: 'launchctl' | 'spawn' | 'never'; live?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'els-sup-'));
  dirs.push(root);
  const state = join(root, 'state');
  const home = join(root, 'home');
  let up = options.live ?? false;
  const calls: string[] = [];
  let clock = 0;
  const notes: string[] = [];
  const deps: SupervisorDeps = {
    stateRoot: state, isDefaultState: options.isDefaultState ?? true, platform: options.platform ?? 'darwin',
    paths: supervisorPaths(state, home), serveCommand: ['/bin/elanous', 'side', 'serve'], pathEnv: '/usr/bin', uid: 501,
    launchctl: async (args) => {
      calls.push(`launchctl ${args.join(' ')}`);
      const code = args[0] === 'bootstrap' || args[0] === 'kickstart' ? options.launchctlCode ?? 0 : 0;
      if (code === 0 && args[0] === 'bootstrap' && (options.serverUpOn ?? 'launchctl') === 'launchctl') up = true;
      return { code, output: code ? 'boom' : '' };
    },
    spawnDetached: () => { calls.push('spawn'); if (options.spawnThrows) throw new Error('ENOENT'); if (options.serverUpOn === 'spawn') up = true; },
    serverState: async () => up ? 'live' : 'none',
    sleep: async (ms) => { clock += ms; }, now: () => clock, notify: (line) => { notes.push(line); },
  };
  return { deps, calls, notes, state, home };
}

test('renderPlist: label, argv, keep-alive and escaped values', () => {
  const plist = renderPlist(['/a b/elanous', 'side', 'serve'], '/log&x', '/usr/bin');
  expect(plist).toContain('<key>Label</key><string>dev.elanous.els</string>');
  expect(plist).toContain('<string>/a b/elanous</string>');
  expect(plist).toContain('<key>KeepAlive</key><true/>');
  expect(plist).toContain('/log&amp;x');
});

test('a running server: nothing is installed, nothing is printed', async () => {
  const { deps, calls, notes } = setup({ live: true });
  expect(await ensureServer(deps)).toEqual({ ok: true, how: 'already' });
  expect(calls).toEqual([]);
  expect(notes).toEqual([]);
});

test('first run: installs the agent, says so once; the second run (agent present, server down) restarts it silently', async () => {
  const { deps, calls, notes } = setup();
  expect(await ensureServer(deps)).toEqual({ ok: true, how: 'supervisor' });
  expect(readFileSync(deps.paths.plist, 'utf8')).toContain('<string>serve</string>');
  expect(calls).toEqual(['launchctl bootout gui/501/dev.elanous.els', 'launchctl bootstrap gui/501 ' + deps.paths.plist]);
  expect(notes).toEqual(['els: 감독자 설치함 · 끄기 = els supervisor off']);
  // later: the server died and the agent file exists → kickstart, no notice
  const again = setup();
  mkdirSync(dirname(again.deps.paths.plist), { recursive: true });
  writeFileSync(again.deps.paths.plist, 'x');
  expect((await ensureServer({ ...again.deps, launchctl: async (args) => { again.calls.push(args[0]!); return { code: 0, output: '' }; },
    serverState: (() => { let n = 0; return async () => (++n > 2 ? 'live' : 'none'); })() })).ok).toBe(true);
  expect(again.notes).toEqual([]);
  expect(again.calls).toEqual(['kickstart']);
});

test('install fails → the server is started directly and an event is recorded', async () => {
  const { deps, calls, notes } = setup({ launchctlCode: 5, serverUpOn: 'spawn' });
  expect(await ensureServer(deps)).toEqual({ ok: true, how: 'direct' });
  expect(calls).toContain('spawn');
  expect(notes).toEqual([]);
  const events = readFileSync(deps.paths.events, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { event: string; reason: string });
  expect(events.map((row) => row.event)).toEqual(['supervisor-failed', 'serve-direct']);
  expect(events[0]!.reason).toContain('launchctl bootstrap failed (5)');
});

test('not macOS, or an isolated state dir: launchd is never touched, the server starts directly', async () => {
  for (const options of [{ platform: 'linux' as const }, { isDefaultState: false }]) {
    const { deps, calls } = setup({ ...options, serverUpOn: 'spawn' });
    expect(await ensureServer(deps)).toEqual({ ok: true, how: 'direct' });
    expect(calls).toEqual(['spawn']);
    expect(existsSync(deps.paths.plist)).toBe(false);
  }
});

test('nothing can start the server → a clear failure (spawn error, or no answer in time)', async () => {
  const spawnFails = setup({ isDefaultState: false, spawnThrows: true });
  const failed = await ensureServer(spawnFails.deps);
  expect(failed.ok).toBe(false);
  expect(failed.ok === false && failed.message).toContain('cannot start the server');
  const silent = setup({ isDefaultState: false, serverUpOn: 'never' });
  const timeout = await ensureServer(silent.deps);
  expect(timeout.ok === false && timeout.message).toContain('did not answer');
});

test('off: removes the agent and blocks automatic start until on', async () => {
  const { deps, calls } = setup({ serverUpOn: 'launchctl' });
  await ensureServer(deps);                        // installs
  expect(existsSync(deps.paths.plist)).toBe(true);
  expect(await supervisorOff(deps)).toContain('supervisor off');
  expect(existsSync(deps.paths.plist)).toBe(false);
  expect(calls.filter((call) => call.startsWith('launchctl bootout')).length).toBe(2);
  const down = { ...deps, serverState: async () => 'none' as const };
  const blocked = await ensureServer(down);
  expect(blocked.ok === false && blocked.message).toContain('supervisor is off');
  expect(supervisorStatus(down, 'none')).toContain('OFF');
  expect(await supervisorOn(down)).not.toContain('supervisor is off');   // marker gone → it tries to start again (this fake server never answers)
  expect(existsSync(deps.paths.offMarker)).toBe(false);
});

test('off in an isolated state dir never touches launchd or the real plist: no launchctl call, plist kept, only the marker', async () => {
  const { deps, calls } = setup({ isDefaultState: false });
  mkdirSync(dirname(deps.paths.plist), { recursive: true });
  writeFileSync(deps.paths.plist, 'the real agent');                 // stands for the user's real agent file
  expect(await supervisorOff(deps)).toContain('isolated state dir');
  expect(calls).toEqual([]);                                          // no launchctl at all
  expect(readFileSync(deps.paths.plist, 'utf8')).toBe('the real agent');
  expect(existsSync(deps.paths.offMarker)).toBe(true);
});

test('the server is started from this install: a decision table over the prefix value, and a missing wrapper falls back to the running entry', () => {
  const exists = (path: string) => ['/iso/bin/elanous', '/iso /bin/elanous', ' /iso/bin/elanous', '/home/u/.local/share/elanous/bin/elanous'].includes(path);
  const base = { home: '/home/u', exists, execPath: '/bun', entry: '/x/elanous.mjs' };
  const fallback = ['/home/u/.local/share/elanous/bin/elanous', 'side', 'serve'];
  const table: [string, string | undefined, string[]][] = [
    ['unset', undefined, fallback],
    ['empty', '', fallback],
    ['spaces only', '   ', fallback],
    ['normal path', '/iso', ['/iso/bin/elanous', 'side', 'serve']],
    ['trailing space is part of the path', '/iso ', ['/iso /bin/elanous', 'side', 'serve']],
    ['leading space is part of the path', ' /iso', [' /iso/bin/elanous', 'side', 'serve']],
    ['prefix without a wrapper → the running entry', '/nowhere', ['/bun', '/x/elanous.mjs', 'side', 'serve']],
  ];
  for (const [label, prefixEnv, expected] of table) expect([label, serveCommandFor({ ...base, ...(prefixEnv === undefined ? {} : { prefixEnv }) })]).toEqual([label, expected]);
  expect(serveCommandFor({ ...base, exists: () => false, entry: undefined })).toEqual(['/bun', 'elanous', 'side', 'serve']);
});

test('elanousCommandFor is the same install as serveCommandFor, without «side serve» (what a chat pane runs)', () => {
  const exists = (path: string) => path === '/iso/bin/elanous';
  const base = { home: '/home/u', exists, execPath: '/bun', entry: '/x/elanous.mjs' };
  expect(elanousCommandFor({ ...base, prefixEnv: '/iso' })).toEqual(['/iso/bin/elanous']);
  expect(elanousCommandFor(base)).toEqual(['/bun', '/x/elanous.mjs']);
});
