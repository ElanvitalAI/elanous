import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { simCli } from '../ux-sim/in-process-cli.js';

/**
 * CLI-ENTRY-LAZY — `tasks list`·`tasks show`·`tasks --help` 는 하위 전용 무거운 모듈을 싣지 않는다.
 * 판정은 «실제로 실린 모듈»로 한다(Bun.plugin onLoad 로 src/ 아래 적재를 센다 — #29781 의 dashboard 차단과 같은 기전).
 * 출력 계약은 옛 전체 진입과 stdout·stderr·rc 가 바이트 동일해야 한다.
 */
const cwd = resolve(import.meta.dir, '../..');
const entry = resolve(cwd, 'bin/elanous.mjs');
const root = mkdtempSync(join(tmpdir(), 'tasks-lazy-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
// The deterministic gate sets ELANOUS_CONFIG_DIR, which the CLI ignores with a warning — drop it for parity runs.
const {
  ELANOUS_CONFIG_DIR: _ignoredGateConfigDir,
  ELANOUS_FAST_ROUTER: _ignoredFastRouter,
  ELANOUS_TEST_FLAG_AUDIT: _ignoredGateAuditFlag,
  ...baseEnv
} = process.env;
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

/** 진입점은 simCli 로 부르고 src/ 아래 실제 적재 모듈을 계측한다. */
async function loadedModules(args: string[], preloadModules: string[] = []): Promise<{ status: number; modules: string[]; stderr: string }> {
  const runRoot = mkdtempSync(join(root, 'run-'));
  const wrapper = join(runRoot, 'instrumented-entry.mjs');
  const output = join(runRoot, 'loaded-modules.json');
  const script = `import { readFileSync, writeFileSync } from 'node:fs';\n` +
    `const seen = [];\n` +
    `Bun.plugin({ name: 'count-src', setup(build) { build.onLoad({ filter: /[\\\\/]src[\\\\/].*\\.tsx?$/ }, (a) => { seen.push(a.path); return { contents: readFileSync(a.path, 'utf8'), loader: a.path.endsWith('x') ? 'tsx' : 'ts' }; }); } });\n` +
    `process.on('exit', () => writeFileSync(${JSON.stringify(output)}, JSON.stringify(seen)));\n` +
    `for (const path of ${JSON.stringify(preloadModules)}) await import(path);\n` +
    `process.argv = [process.argv[0], ${JSON.stringify(entry)}, ...process.argv.slice(2)];\n` +
    `await import(${JSON.stringify(entry)});\n`;
  writeFileSync(wrapper, script);
  const run = await simCli(args, {
    mode: 'spawn', entrypoint: wrapper, injectTestFlag: false,
    allowPaths: [['tasks'], ['pr', 'land'], ['pty', 'list'], ['release', 'checklist']],
    stateRoot: join(runRoot, 'state'), cwd, env, timeoutMs: 60_000,
  });
  return { status: run.exitCode, modules: JSON.parse(readFileSync(output, 'utf8')) as string[], stderr: run.stderr };
}

describe('tasks read paths load only their own modules', () => {
  for (const args of [['tasks', 'list', '--json'], ['tasks', 'list', '--status', 'launched'], ['tasks', 'show', 'NEXUS-1'], ['tasks', 'show', 'ta-missing-card'], ['tasks', '--help']]) {
    test(`${args.join(' ')} — dashboard·index·board·shadow·mission·tier-split 0`, async () => {
      const { modules, stderr } = await loadedModules(args);
      expect(modules.length).toBeGreaterThan(0);
      console.log(`[tasks-lazy] ${args.join(' ')} → src 모듈 ${modules.length}`);
      expect({ args, heavy: modules.filter(isHeavyModule) }).toEqual({ args, heavy: [] });
      expect(stderr).not.toContain('error: unknown command');
    }, 60_000);
  }

  test('list and nexus show never load the full tasks registrar', async () => {
    for (const args of [['tasks', 'list', '--json'], ['tasks', 'show', 'NEXUS-1']]) {
      const { modules } = await loadedModules(args);
      expect({ args, full: modules.filter((path) => /[\\/]src[\\/]cli[\\/]tasks-cli\.ts$/.test(path)) }).toEqual({ args, full: [] });
    }
  }, 60_000);
});

describe('tasks light route keeps the legacy output contract', () => {
  test('release checklist landed-but-yellow help skips the full release registry', async () => {
    const { modules, stderr } = await loadedModules(['release', 'checklist', 'landed-but-yellow', '--help']);
    expect(modules.some((path) => path.endsWith('/src/index.ts'))).toBe(false);
    expect(modules.some((path) => path.endsWith('/src/cli/release-cli.ts'))).toBe(false);
    expect(modules.some((path) => path.endsWith('/src/cli/release-checklist-landed-cli.ts'))).toBe(true);
    expect(stderr).not.toContain('error: unknown command');
  }, 60_000);
  test('release checklist set help skips the full release registry', async () => {
    const { modules, stderr } = await loadedModules(['release', 'checklist', 'set', '--help']);
    expect(modules.some((path) => path.endsWith('/src/index.ts'))).toBe(false);
    expect(modules.some((path) => path.endsWith('/src/cli/release-cli.ts'))).toBe(false);
    expect(modules.some((path) => path.endsWith('/src/cli/release-checklist-set-cli.ts'))).toBe(true);
    expect(stderr).not.toContain('error: unknown command');
  }, 60_000);
  test('pr land help skips the full index and PR runtime', async () => {
    const { modules, stderr } = await loadedModules(['pr', 'land', '--help']);
    expect(modules.some((path) => path.endsWith('/src/index.ts'))).toBe(false);
    expect(modules.some((path) => path.endsWith('/src/cli/pr-cli.ts'))).toBe(false);
    expect(modules.some((path) => path.endsWith('/src/cli/pr-land-overlap-evidence.ts'))).toBe(false);
    expect(stderr).not.toContain('error: unknown command');
  }, 60_000);
  test('advance help skips the full index and mission runtime', async () => {
    const { modules, stderr } = await loadedModules(['tasks', 'advance', '--help']);
    expect(modules.length).toBeGreaterThan(0);
    expect(isHeavyModule(resolve(cwd, 'src/index.ts'))).toBe(true);
    expect(isHeavyModule(resolve(cwd, 'src/task-agent/mission.ts'))).toBe(true);
    expect(modules.some((path) => path.endsWith('/src/index.ts'))).toBe(false);
    expect(modules.filter(isHeavyModule)).toEqual([]);
    expect(stderr).not.toContain('error: unknown command');
  }, 60_000);

  test('advance help guard detects a forced mission import', async () => {
    const { modules } = await loadedModules(['tasks', 'advance', '--help'], [resolve(cwd, 'src/task-agent/mission.ts')]);
    expect(modules.filter(isHeavyModule)).toContain(resolve(cwd, 'src/task-agent/mission.ts'));
  }, 60_000);

  test('pr land execution forwards user arguments to the deferred registrar', async () => {
    const { modules, stderr } = await loadedModules(['pr', 'land', '--dry-run', '--pr', '0', '--expected-head', 'bad']);
    expect(modules.some((path) => path.endsWith('/src/cli/pr-cli.ts'))).toBe(true);
    expect(stderr).toContain('expected-head: --pr and --expected-head');
    expect(stderr).not.toContain("unknown command 'node'");
  }, 60_000);

  test('pty light route registers its legacy command handlers', async () => {
    const { modules, stderr } = await loadedModules(['pty', 'list', '--json']);
    expect(modules.some((path) => path.endsWith('/src/cli/pty-takeover-cli.ts'))).toBe(true);
    expect(stderr).not.toContain('error: unknown command');
  }, 60_000);

  const cases = [
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
  ];
  const stateRoot = join(root, 'state');
  const allowPaths = [['tasks'], ['tasks', 'list'], ['tasks', 'show'], ['tasks', 'hand'], ['tasks', 'advance'], ['pr', 'land'], ['pty', 'list'], ['release', 'checklist', 'set'], ['release', 'checklist', 'landed-but-yellow']] as const;

  test('real root entry keeps fast and full-router output contracts for every covered path', async () => {
    for (const args of cases) {
      const fast = await simCli(args, {
        mode: 'spawn', injectTestFlag: false, allowPaths, stateRoot, configRoot: root, cwd,
        env: { ...env, ELANOUS_FAST_ROUTER: '1', ELANOUS_TEST_FLAG_AUDIT: '0' }, timeoutMs: 60_000,
      });
      const legacy = await simCli(args, {
        mode: 'spawn', injectTestFlag: false, allowPaths, stateRoot, configRoot: root, cwd,
        env: { ...env, ELANOUS_FAST_ROUTER: '0', ELANOUS_TEST_FLAG_AUDIT: '0' }, timeoutMs: 60_000,
      });
      expect({ args, fast: [fast.exitCode, fast.stdout, fast.stderr] })
        .toEqual({ args, fast: [legacy.exitCode, legacy.stdout, legacy.stderr] });
    }
  }, 600_000);

});
