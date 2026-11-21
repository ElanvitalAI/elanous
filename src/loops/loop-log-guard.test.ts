import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, fstatSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendLoopLog, ensureLoopLogsDir, graphJobMatches, LoopLogTargetError, loopCronCommand, loopCronLogPath, openLoopLogFile, runLoopCron, setLoopEnabled,
  type LoopRegistryOptions } from './registry.js';

// Open-time symlink/ownership barrier for loop cron logs (JUD HOLD mustFix for PR #39362).
// 소유권 불일치(uid≠euid) 실측은 비루트 권한으로 재현 불가 — 미측정. 권한(chmod) 변형으로 검증한다.

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function stateFixture() {
  const root = mkdtempSync(join(tmpdir(), 'loop-log-guard-'));
  dirs.push(root);
  const stateRoot = join(root, 'state');
  mkdirSync(join(root, 'graphs'), { recursive: true });
  writeFileSync(join(root, 'graphs', 'cron.yaml'), `graph_id: daily\nversion: 1\nloop:\n  title: Daily\n  root: 조율자\n  trigger:\n    cron: '0 7 * * *'\nentry_node: step\nterminal_nodes: [done]\nnodes:\n  - { node_id: step, kind: agent, recipe: 'cmd:step', max_visits: 1 }\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\nedges:\n  - { from: step, to: done }\n`);
  const opts: LoopRegistryOptions = { root, stateRoot, schedules: [] };
  return { root, stateRoot, opts };
}

test('the actual registered cron command routes the loop log through the guarded open, not the shell (JUD #117698)', () => {
  const { root, stateRoot } = stateFixture();
  const command = loopCronCommand('daily', 'graphs/cron.yaml', root, '/usr/bin/bun', stateRoot);
  expect(command).not.toContain('>>');                       // the shell never opens the log target
  expect(command).not.toContain('2>&1');
  expect(command).toContain('bin/elanous.mjs loop cron');    // the eln wrapper owns the guarded open
  expect(command).toContain('--state-root');
  expect(command).toMatch(/#\s*elanous-loop=daily\s*$/);      // inventory still binds the row
  expect(graphJobMatches(command, join(root, 'graphs/cron.yaml'), root, 'daily')).toBe(true);
});

test('safe regular log file: two appends land in order on the same inode owned by euid', () => {
  const { stateRoot } = stateFixture();
  const first = appendLoopLog('daily', 'first line\n', stateRoot);
  expect(first).toBe(loopCronLogPath('daily', stateRoot));
  const stats1 = statSync(first);
  const second = appendLoopLog('daily', 'second line\n', stateRoot);
  const stats2 = statSync(second);
  expect(second).toBe(first);
  expect(stats2.ino).toBe(stats1.ino);            // same file — no swap between appends
  expect(stats2.isFile()).toBe(true);
  expect(stats2.uid).toBe(process.geteuid?.() ?? -1);
  expect(stats2.mode & 0o022).toBe(0);            // owner-only write bits
  expect(readFileSync(second, 'utf8')).toBe('first line\nsecond line\n');
});

test('openLoopLogFile returns a writable descriptor for a fresh target and creates it owner-only', () => {
  const { stateRoot } = stateFixture();
  ensureLoopLogsDir(stateRoot);
  const fd = openLoopLogFile(loopCronLogPath('daily', stateRoot));
  const path = join(stateRoot, 'loop-logs', 'elanous-loop-daily.log');
  try { expect(existsSync(path)).toBe(true); } finally { closeSync(fd); }
  expect(statSync(path).uid).toBe(process.geteuid?.() ?? -1);
  expect(statSync(path).mode & 0o022).toBe(0);
});

test('log file replaced by a symlink is rejected at open time; the sentinel stays untouched', () => {
  const { root, stateRoot } = stateFixture();
  ensureLoopLogsDir(stateRoot);
  const escape = join(root, 'escape');
  mkdirSync(escape);
  const sentinel = join(escape, 'elanous-loop-daily.log');
  writeFileSync(sentinel, 'sentinel');
  const before = statSync(sentinel);
  symlinkSync(sentinel, loopCronLogPath('daily', stateRoot));
  expect(() => appendLoopLog('daily', 'ATTACK\n', stateRoot)).toThrow(LoopLogTargetError);
  expect(readFileSync(sentinel, 'utf8')).toBe('sentinel');            // content unchanged
  expect(statSync(sentinel).ino).toBe(before.ino);                    // inode unchanged
  expect(lstatSync(loopCronLogPath('daily', stateRoot)).isSymbolicLink()).toBe(true);
});

test('loop-logs parent replaced by a symlink is rejected before anything escapes the state root', () => {
  const { root, stateRoot } = stateFixture();
  mkdirSync(stateRoot);
  const escape = join(root, 'escape');
  mkdirSync(escape);
  symlinkSync(escape, join(stateRoot, 'loop-logs'));
  expect(() => appendLoopLog('daily', 'ATTACK\n', stateRoot)).toThrow(LoopLogTargetError);
  expect(existsSync(join(escape, 'elanous-loop-daily.log'))).toBe(false);
  expect(() => ensureLoopLogsDir(stateRoot)).toThrow(LoopLogTargetError);
});

test('stateRoot itself replaced by a symlink is rejected by the registration barrier', () => {
  const { root } = stateFixture();
  const real = join(root, 'real-state');
  mkdirSync(real);
  const linked = join(root, 'linked-state');
  symlinkSync(real, linked);
  expect(() => ensureLoopLogsDir(linked)).toThrow(LoopLogTargetError);
  expect(existsSync(join(real, 'loop-logs'))).toBe(false);
});

test('non-regular log object (FIFO) is rejected without opening it', () => {
  const { stateRoot } = stateFixture();
  ensureLoopLogsDir(stateRoot);
  const fifo = loopCronLogPath('daily', stateRoot);
  const mk = spawnSync('mkfifo', [fifo]);
  expect(mk.status).toBe(0);
  expect(lstatSync(fifo).isFIFO()).toBe(true);
  expect(() => appendLoopLog('daily', 'ATTACK\n', stateRoot)).toThrow(LoopLogTargetError);
  expect(lstatSync(fifo).isFIFO()).toBe(true);    // object untouched, nothing consumed
});

test('group/world-writable log file or loop-logs directory is rejected', () => {
  const { stateRoot } = stateFixture();
  appendLoopLog('daily', 'first\n', stateRoot);
  const path = loopCronLogPath('daily', stateRoot);
  chmodSync(path, 0o666);                          // world-writable file
  expect(() => appendLoopLog('daily', 'second\n', stateRoot)).toThrow(LoopLogTargetError);
  expect(readFileSync(path, 'utf8')).toBe('first\n');
  chmodSync(path, 0o644);
  chmodSync(join(stateRoot, 'loop-logs'), 0o777);  // world-writable directory
  expect(() => appendLoopLog('daily', 'third\n', stateRoot)).toThrow(LoopLogTargetError);
});

test('setLoopEnabled --yes refuses to dispatch when the log target is unsafe', async () => {
  const f = stateFixture();
  let dispatches = 0;
  const opts: LoopRegistryOptions = { ...f.opts, scheduleAction: async () => { dispatches++; return { changed: true }; } };
  const escape = join(f.root, 'escape');
  mkdirSync(escape);
  mkdirSync(f.stateRoot);
  symlinkSync(escape, join(f.stateRoot, 'loop-logs'));
  await expect(setLoopEnabled('daily', true, true, opts)).rejects.toThrow(LoopLogTargetError);
  expect(dispatches).toBe(0);
  expect(existsSync(join(escape, 'elanous-loop-daily.log'))).toBe(false);

  const other = stateFixture();
  let dispatches2 = 0;
  const opts2: LoopRegistryOptions = { ...other.opts, scheduleAction: async () => { dispatches2++; return { changed: true }; } };
  ensureLoopLogsDir(other.stateRoot);
  const sentinel = join(other.root, 'escape2.log');
  writeFileSync(sentinel, 'sentinel');
  const before = statSync(sentinel);
  symlinkSync(sentinel, loopCronLogPath('daily', other.stateRoot));
  await expect(setLoopEnabled('daily', true, true, opts2)).rejects.toThrow(LoopLogTargetError);
  expect(dispatches2).toBe(0);
  expect(readFileSync(sentinel, 'utf8')).toBe('sentinel');
  expect(statSync(sentinel).ino).toBe(before.ino);
});

test('runLoopCron hands the guarded descriptor to the graph child and returns its exit status', () => {
  const { stateRoot } = stateFixture();
  ensureLoopLogsDir(stateRoot);
  let seen: { args: string[]; fd: number } | undefined;
  const fakeSpawn = ((_bun: string, args: string[], opts: { stdio: ['ignore', number, number] }) => {
    seen = { args, fd: opts.stdio[1] };
    return { status: 7 };
  }) as unknown as typeof spawnSync;
  const status = runLoopCron('daily', 'graphs/cron.yaml', stateRoot, {
    bun: '/usr/bin/bun',
    graphArgs: ['bin/elanous.mjs', 'graph', 'run', 'graphs/cron.yaml'],
    spawn: fakeSpawn,
  });
  expect(status).toBe(7);                                          // the child's status propagates to cron
  expect(seen!.args).toEqual(['bin/elanous.mjs', 'graph', 'run', 'graphs/cron.yaml']);
  expect(typeof seen!.fd).toBe('number');                          // the guarded descriptor is open…
  expect(() => fstatSync(seen!.fd)).toThrow();                     // …and closed again by the wrapper
});

test('runLoopCron refuses an unsafe log target before the graph child is spawned', () => {
  const { root, stateRoot } = stateFixture();
  ensureLoopLogsDir(stateRoot);
  const escape = join(root, 'escape');
  mkdirSync(escape);
  const sentinel = join(escape, 'elanous-loop-daily.log');
  writeFileSync(sentinel, 'sentinel');
  symlinkSync(sentinel, loopCronLogPath('daily', stateRoot));
  let spawns = 0;
  const fakeSpawn = (() => { spawns++; return { status: 0 }; }) as unknown as typeof spawnSync;
  expect(() => runLoopCron('daily', 'graphs/cron.yaml', stateRoot, { spawn: fakeSpawn })).toThrow(LoopLogTargetError);
  expect(spawns).toBe(0);
  expect(readFileSync(sentinel, 'utf8')).toBe('sentinel');
});
