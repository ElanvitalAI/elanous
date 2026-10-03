import { setDefaultTimeout, afterEach, expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { debug } from '../debug/log.js';
import type { DoctorFixDeps } from '../cli/doctor-fix.js';
import { runFirstRunDoctor } from './first-run-doctor.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

const originalPath = process.env.PATH;
afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
});

function fixture() {
  const files = new Map<string, { mode: number; text: string }>([
    ['/cache/test_key', { mode: 0o644, text: 'SECRET' }],
    ['/home/test/.bashrc', { mode: 0o644, text: 'original startup' }],
    ['/service', { mode: 0o644, text: 'original service' }],
  ]);
  let privateMode = 0o755;
  const writes: string[] = [];
  const installed: string[] = [];
  const deps: DoctorFixDeps = {
    home: '/home/test', configDir: '/home/test/.elanous', cacheDir: '/cache', keyNames: ['test_key'],
    env: { SHELL: '/bin/bash', PATH: '/usr/bin' }, arch: 'x64',
    readiness: {
      platform: 'linux', installPrefix: '/installed/elanous', pathEntries: ['/usr/bin'], tmpdirSameFsAsBunCache: false,
      distro: 'amzn2', rgOnPath: false,
      pythonEnv: { status: 'fixable', evidence: 'venv missing' },
      serviceFile: { path: '/service', text: '[Service]\nEnvironment="OPENAI_API_KEY=secret-value"\n' },
    },
    exists: (path) => path === '/cache' || path === '/home/test/.elanous' || files.has(path),
    lstat: (path) => {
      if (path === '/cache' || path === '/home/test/.elanous') return { mode: path === '/cache' ? 0o700 : privateMode, isFile: () => false, isSymbolicLink: () => false };
      const file = files.get(path);
      if (!file) throw new Error('missing fixture file');
      return { mode: file.mode, isFile: () => true, isSymbolicLink: () => false };
    },
    readdir: (path) => path === '/cache' ? ['test_key'] : path === '/home/test/.elanous' ? [] : [],
    chmod: (path, mode) => {
      writes.push(path);
      if (path === '/home/test/.elanous') privateMode = mode;
      else files.get(path)!.mode = mode;
    },
    readFile: (path) => files.get(path)?.text ?? '',
    writeFile: (path, text) => { writes.push(path); files.set(path, { mode: 0o600, text }); },
    appendFile: (path) => { writes.push(path); },
    rename: (from, to) => { writes.push(to); files.set(to, files.get(from)!); },
    mkdir: (path) => { writes.push(path); },
    installStaticTool: (name) => { installed.push(name); return { ok: true, detail: 'installed' }; },
    smokeCheck: () => true,
    pythonSetup: () => { throw new Error('python must not run'); },
    installManagedPython: () => { throw new Error('managed python must not run'); },
    removeTree: () => { throw new Error('node-pty must not run'); },
  };
  return { deps, files, writes, installed };
}

test('applies only three unattended ids, defers fixable shell edits, and logs id-only outcomes', () => {
  const f = fixture();
  process.env.PATH = '/usr/bin';
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  try {
    const result = runFirstRunDoctor(f.deps);
    expect(result.fixed).toEqual(['static-tools', 'key-cache-permissions', 'private-files']);
    expect(result.later).toEqual(['install-path', 'bun-tmpdir']);
    expect(result.skipped).toContain('install-path');
    expect(result.skipped).toContain('bun-tmpdir');
    expect(result.skipped).toContain('service-secrets');
    expect(result.skipped).toContain('python-env');
    expect(result.failed).toEqual([]);
    expect(result.lines).toEqual(['나중에: elanous doctor --fix (셸 시작 파일 수정)']);
    expect(f.installed).toEqual(['rg']);
    expect(f.files.get('/cache/test_key')?.mode).toBe(0o600);
    expect(f.writes).toEqual(['/cache/test_key', '/home/test/.elanous']);
    expect(f.files.get('/home/test/.bashrc')?.text).toBe('original startup');
    expect(f.files.get('/service')?.text).toBe('original service');
    const events = log.mock.calls.filter(([category]) => category === 'doctor.first-run');
    expect(events).toHaveLength(result.fixed.length + result.skipped.length);
    expect(events.every(([, event, data]) =>
      ['fixed', 'skipped', 'failed'].includes(String(event)) && Object.keys(data as object).join() === 'id')).toBe(true);
    expect(events.map(([, event, data]) => [event, (data as { id: string }).id])).toContainEqual(['skipped', 'service-secrets']);
  } finally { log.mockRestore(); }
});

test('service-file, node-pty rebuild, and managed python stay untouched even when fixable', () => {
  const f = fixture();
  const versioned = '/installed/elanous/versions/1.0/node_modules/elanous/bin/elanous.mjs';
  f.deps.readiness = {
    ...f.deps.readiness, nodePty: 'missing', buildToolchain: { make: true, cxx20: true },
    pythonEnv: { status: 'manual', evidence: 'no python3 found' },
    serviceFile: { path: '/service', text: `<string>${versioned}</string>` },
  };
  f.deps.realpath = () => '/installed/elanous/versions/1.0';
  f.deps.readFile = (path) => path.endsWith('/package.json')
    ? JSON.stringify({ optionalDependencies: { 'node-pty': '^1.1.0' } }) : f.files.get(path)?.text ?? '';
  const exists = f.deps.exists!;
  f.deps.exists = (path) => path === '/installed/elanous/current/node_modules/elanous/' || exists(path);
  const result = runFirstRunDoctor(f.deps);
  expect(result.skipped).toEqual(expect.arrayContaining(['service-file', 'node-pty-rebuild', 'python-managed']));
  expect(result.fixed).toEqual(['static-tools', 'key-cache-permissions', 'private-files']);
  expect(result.failed).toEqual([]);
  expect(f.writes).toEqual(['/cache/test_key', '/home/test/.elanous']);
  expect(f.files.get('/service')?.text).toBe('original service');
});

test('PATH is prepended only to current process and inherited by children, without duplicate entries or shell edits', () => {
  const f = fixture();
  f.deps.readiness = { installPrefix: '/installed/elanous', pathEntries: ['/usr/bin'] };
  f.deps.keyNames = ['test_key'];
  f.deps.configDir = '/not-present';
  f.files.get('/cache/test_key')!.mode = 0o600;
  process.env.PATH = '/usr/bin';
  const bin = join('/installed/elanous', 'bin');
  const first = runFirstRunDoctor(f.deps);
  expect(process.env.PATH).toBe(`${bin}${delimiter}/usr/bin`);
  expect(spawnSync(process.execPath, ['-e', 'process.stdout.write(process.env.PATH ?? "")'], { encoding: 'utf8' }).stdout).toBe(process.env.PATH);
  expect(first.lines).toEqual(['나중에: elanous doctor --fix (셸 시작 파일 수정)']);
  runFirstRunDoctor(f.deps);
  expect(process.env.PATH?.split(delimiter).filter((entry) => entry === bin)).toHaveLength(1);
  expect(f.writes).toEqual([]);
  expect(f.files.get('/home/test/.bashrc')?.text).toBe('original startup');
});

test('without an install prefix the static-tool bin is added to the process PATH', () => {
  const f = fixture();
  f.deps.configDir = '/not-present';
  f.deps.readiness = { installPrefix: null, pathEntries: ['/usr/bin'] };
  f.files.get('/cache/test_key')!.mode = 0o600;
  process.env.PATH = '/usr/bin';
  const result = runFirstRunDoctor(f.deps);
  expect(process.env.PATH).toBe(`/home/test/.local/share/elanous/bin${delimiter}/usr/bin`);
  expect(result.later).toEqual([]);
  expect(result.lines).toEqual([]);
});

test('nothing fixable is silent and does not edit PATH when already present', () => {
  const f = fixture();
  f.deps.readiness = { installPrefix: '/installed/elanous', pathEntries: ['/installed/elanous/bin'], tmpdirSameFsAsBunCache: true };
  f.files.get('/cache/test_key')!.mode = 0o600;
  f.deps.lstat = (path) => path === '/home/test/.elanous'
    ? { mode: 0o700, isFile: () => false, isSymbolicLink: () => false }
    : path === '/cache' ? { mode: 0o700, isFile: () => false, isSymbolicLink: () => false }
      : { mode: f.files.get(path)!.mode, isFile: () => true, isSymbolicLink: () => false };
  process.env.PATH = '/installed/elanous/bin:/usr/bin';
  expect(runFirstRunDoctor(f.deps)).toEqual({ fixed: [], skipped: [], failed: [], later: [], lines: [] });
  expect(process.env.PATH).toBe('/installed/elanous/bin:/usr/bin');
  expect(f.writes).toEqual([]);
});

test('item failure shows only its reason and continues other safe repairs', () => {
  const f = fixture();
  const chmod = f.deps.chmod!;
  f.deps.chmod = (path, mode) => {
    if (path === '/cache/test_key') throw new Error('SECRET');
    chmod(path, mode);
  };
  const result = runFirstRunDoctor(f.deps);
  expect(result.failed).toEqual(['key-cache-permissions']);
  expect(result.fixed).toContain('static-tools');
  expect(result.lines).toEqual([
    'doctor: key-cache-permissions 수리 실패 — could not chmod or recheck cache file',
    '나중에: elanous doctor --fix (셸 시작 파일 수정)',
  ]);
  expect(JSON.stringify(result)).not.toContain('SECRET');
});

test('planning exception and logging exception never escape first run', () => {
  const f = fixture();
  f.deps.readiness = { installPrefix: '/installed/elanous', pathEntries: ['/usr/bin'] };
  f.deps.lstat = () => { throw new Error('SECRET-private-path'); };
  const log = spyOn(debug, 'log').mockImplementation(() => { throw new Error('log unavailable'); });
  try {
    const result = runFirstRunDoctor(f.deps);
    expect(result.failed).toEqual(['doctor']);
    expect(result.lines).toEqual(['doctor: doctor 수리 실패 — 계획 또는 적용 중 예외']);
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(process.env.PATH?.split(delimiter)).toContain('/installed/elanous/bin');
  } finally { log.mockRestore(); }
});
