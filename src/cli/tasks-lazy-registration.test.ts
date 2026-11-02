import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * CLI-ENTRY-LAZY — `tasks list`·`tasks show`·`tasks --help` 는 하위 전용 무거운 모듈을 싣지 않는다.
 * 판정은 «실제로 실린 모듈»로 한다(Bun.plugin onLoad 로 src/ 아래 적재를 센다 — #29781 의 dashboard 차단과 같은 기전).
 * 출력 계약은 ELANOUS_FAST_ROUTER=0(옛 전체 진입) 과 stdout·stderr·rc 가 바이트 동일해야 한다.
 */
const cwd = resolve(import.meta.dir, '../..');
const entry = resolve(cwd, 'bin/elanous.mjs');
const root = mkdtempSync(join(tmpdir(), 'tasks-lazy-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
// The deterministic gate sets ELANOUS_CONFIG_DIR, which the CLI ignores with a warning — drop it for parity runs.
const { ELANOUS_CONFIG_DIR: _ignoredGateConfigDir, ...baseEnv } = process.env;
const env = { ...baseEnv, HOME: root, XDG_CONFIG_HOME: join(root, '.config'), ELANOUS_STATE_DIR: join(root, 'state') };

const HEAVY_SUFFIXES = [
  '/src/index.ts',
  '/src/task-agent/board.ts',
  '/src/task-agent/shadow.ts',
  '/src/task-agent/mission.ts',
  '/src/task-agent/tier-split.ts',
];
function isHeavyModule(path: string): boolean {
  return path.includes('/src/dashboard/') || HEAVY_SUFFIXES.some((suffix) => path.endsWith(suffix));
}

/** 진입점을 그대로 부르고 src/ 아래에서 실린 모듈 경로 전부를 돌려준다. */
function loadedModules(args: string[], preloadModules: string[] = []): { status: number | null; modules: string[]; stderr: string } {
  const script = `const { readFileSync } = await import('node:fs');\n` +
    `const seen = [];\n` +
    `Bun.plugin({ name: 'count-src', setup(build) { build.onLoad({ filter: /[\\\\/]src[\\\\/].*\\.tsx?$/ }, (a) => { seen.push(a.path); return { contents: readFileSync(a.path, 'utf8'), loader: a.path.endsWith('x') ? 'tsx' : 'ts' }; }); } });\n` +
    `process.on('exit', () => { process.stderr.write('\\nLOADED_MODULES=' + JSON.stringify(seen) + '\\n'); });\n` +
    `process.argv = ['node', 'elanous', ...${JSON.stringify(args)}];\n` +
    `for (const path of ${JSON.stringify(preloadModules)}) await import(path);\n` +
    `await import(${JSON.stringify(entry)});\n`;
  const run = spawnSync(process.execPath, ['-e', script], { cwd, encoding: 'utf8', timeout: 60_000, env });
  const line = run.stderr.split('\n').find((text) => text.startsWith('LOADED_MODULES='));
  return { status: run.status, modules: line ? JSON.parse(line.slice('LOADED_MODULES='.length)) as string[] : [], stderr: run.stderr };
}

describe('tasks read paths load only their own modules', () => {
  for (const args of [['tasks', 'list', '--json'], ['tasks', 'list', '--status', 'launched'], ['tasks', 'show', 'NEXUS-1'], ['tasks', 'show', 'ta-missing-card'], ['tasks', '--help']]) {
    test(`${args.join(' ')} — dashboard·index·board·shadow·mission·tier-split 0`, () => {
      const { modules, stderr } = loadedModules(args);
      expect(modules.length).toBeGreaterThan(0);
      console.log(`[tasks-lazy] ${args.join(' ')} → src 모듈 ${modules.length}`);
      expect({ args, heavy: modules.filter(isHeavyModule) }).toEqual({ args, heavy: [] });
      expect(stderr).not.toContain('error: unknown command');
    }, 60_000);
  }

  test('list and nexus show never load the full tasks registrar', () => {
    for (const args of [['tasks', 'list', '--json'], ['tasks', 'show', 'NEXUS-1']]) {
      const { modules } = loadedModules(args);
      expect({ args, full: modules.filter((path) => /[\\/]src[\\/]cli[\\/]tasks-cli\.ts$/.test(path)) }).toEqual({ args, full: [] });
    }
  }, 60_000);
});

describe('tasks light route keeps the legacy output contract', () => {
  test('release checklist landed-but-yellow help skips the full release registry', () => {
    const { modules, stderr } = loadedModules(['release', 'checklist', 'landed-but-yellow', '--help']);
    expect(modules.some((path) => path.endsWith('/src/index.ts'))).toBe(false);
    expect(modules.some((path) => path.endsWith('/src/cli/release-cli.ts'))).toBe(false);
    expect(modules.some((path) => path.endsWith('/src/cli/release-checklist-landed-cli.ts'))).toBe(true);
    expect(stderr).not.toContain('error: unknown command');
  }, 60_000);
  test('release checklist set help skips the full release registry', () => {
    const { modules, stderr } = loadedModules(['release', 'checklist', 'set', '--help']);
    expect(modules.some((path) => path.endsWith('/src/index.ts'))).toBe(false);
    expect(modules.some((path) => path.endsWith('/src/cli/release-cli.ts'))).toBe(false);
    expect(modules.some((path) => path.endsWith('/src/cli/release-checklist-set-cli.ts'))).toBe(true);
    expect(stderr).not.toContain('error: unknown command');
  }, 60_000);
  test('pr land help skips the full index and PR runtime', () => {
    const { modules, stderr } = loadedModules(['pr', 'land', '--help']);
    expect(modules.some((path) => path.endsWith('/src/index.ts'))).toBe(false);
    expect(modules.some((path) => path.endsWith('/src/cli/pr-cli.ts'))).toBe(false);
    expect(modules.some((path) => path.endsWith('/src/cli/pr-land-overlap-evidence.ts'))).toBe(false);
    expect(stderr).not.toContain('error: unknown command');
  }, 60_000);
  test('advance help skips the full index and mission runtime', () => {
    const { modules, stderr } = loadedModules(['tasks', 'advance', '--help']);
    expect(modules.length).toBeGreaterThan(0);
    expect(isHeavyModule(resolve(cwd, 'src/index.ts'))).toBe(true);
    expect(isHeavyModule(resolve(cwd, 'src/task-agent/mission.ts'))).toBe(true);
    expect(modules.some((path) => path.endsWith('/src/index.ts'))).toBe(false);
    expect(modules.filter(isHeavyModule)).toEqual([]);
    expect(stderr).not.toContain('error: unknown command');
  }, 60_000);

  test('advance help guard detects a forced mission import', () => {
    const { modules } = loadedModules(['tasks', 'advance', '--help'], [resolve(cwd, 'src/task-agent/mission.ts')]);
    expect(modules.filter(isHeavyModule)).toContain(resolve(cwd, 'src/task-agent/mission.ts'));
  }, 60_000);

  test('pr land execution forwards user arguments to the deferred registrar', () => {
    const { modules, stderr } = loadedModules(['pr', 'land', '--dry-run', '--pr', '0', '--expected-head', 'bad']);
    expect(modules.some((path) => path.endsWith('/src/cli/pr-cli.ts'))).toBe(true);
    expect(stderr).toContain('expected-head: --pr and --expected-head');
    expect(stderr).not.toContain("unknown command 'node'");
  }, 60_000);

  test('pty light route registers its legacy command handlers', () => {
    const { modules, stderr } = loadedModules(['pty', 'list', '--json']);
    expect(modules.some((path) => path.endsWith('/src/cli/pty-takeover-cli.ts'))).toBe(true);
    expect(stderr).not.toContain('error: unknown command');
  }, 60_000);

  for (const args of [
    ['tasks', '--help'],
    ['tasks', '-h'],
    ['tasks', 'list', '--help'],
    ['tasks', 'show', '--help'],
    ['tasks', 'hand', '--help'],
    ['tasks', 'advance', '--help'],
    ['pr', 'land', '--help'],
    ['pty', 'list', '--json'],
    ['release', 'checklist', 'set', '--help'],
    ['release', 'checklist', 'set', 'NO-SUCH-CELL', '--status', 'invalid', '--version', '0.2.45'],
    ['release', 'checklist', 'landed-but-yellow', '--help'],
    ['tasks', 'list', '--json'],
    ['tasks', 'list', '--status', 'launched'],
    ['tasks', 'list', '--bogus'],
    ['tasks', 'show'],
    ['tasks', 'show', 'NEXUS-1'],
    ['tasks', 'show', 'NEXUS-1', '--json'],
    ['tasks', 'show', 'ta-missing-card'],
    ['tasks', 'show', 'ta-missing-card', '--json'],
  ]) {
    test(`${args.join(' ')} — fast = legacy (stdout·stderr·rc)`, () => {
      const fast = spawnSync('bun', [entry, ...args], { cwd, encoding: 'utf8', timeout: 60_000, env });
      const legacy = spawnSync('bun', [entry, ...args], { cwd, encoding: 'utf8', timeout: 60_000, env: { ...env, ELANOUS_FAST_ROUTER: '0' } });
      expect([fast.status, fast.signal, fast.stdout, fast.stderr]).toEqual([legacy.status, legacy.signal, legacy.stdout, legacy.stderr]);
      expect(fast.signal).toBeNull();
    }, 120_000);
  }
});
