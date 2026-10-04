import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCENE_SIX_GUIDANCE, parseArgs, seed, type SeedDeps } from './demo-seed.js';

const noIO = (): SeedDeps => ({ repo: '/unused', prepareDraft: () => { throw new Error('dry-run wrote a draft'); },
  run: async () => { throw new Error('dry-run spawned a process'); } });

test('only accepts graph|wizard|all and strict dry-run/json flags', () => {
  expect(parseArgs([])).toEqual({ only: 'all', dryRun: false, json: false });
  expect(parseArgs(['--json', '--only', 'wizard', '--dry-run'])).toEqual({ only: 'wizard', dryRun: true, json: true });
  for (const argv of [['--only'], ['--only', 'invalid'], ['--only', '--json'], ['--unknown'], ['--json', '--json'], ['graph']]) {
    expect(() => parseArgs(argv)).toThrow();
  }
});

test('dry-run prints both commands without preparing a draft or spawning, and selects targets', async () => {
  const all = await seed(parseArgs(['--dry-run', '--json']), noIO());
  expect(all.ok).toBe(true);
  expect(all.events.map(event => `${event.target}:${event.phase}`)).toEqual(['graph:start', 'graph:finish', 'wizard:start', 'wizard:finish']);
  expect(all.events[0]!.command).toEqual(['bun', 'bin/elanous.mjs', '--test', 'graph', 'run', 'graphs/demo/inside-seed.yaml', '--json']);
  expect(all.events[2]!.command).toContain('--draft-file');
  expect(all.events[2]!.command).not.toContain('--run');
  expect(all.guidance).toBe(SCENE_SIX_GUIDANCE);
  expect(all.guidance).toContain('read → judge → answer');
  expect((await seed(parseArgs(['--only', 'graph', '--dry-run']), noIO())).events.map(event => event.target)).toEqual(['graph', 'graph']);
  expect((await seed(parseArgs(['--only', 'wizard', '--dry-run']), noIO())).events.map(event => event.target)).toEqual(['wizard', 'wizard']);
});

test('real graph and wizard invocation use test isolation and an uninstalled draft with no credential values', async () => {
  const root = mkdtempSync(join(tmpdir(), 'inside-demo-seed-'));
  const calls: string[][] = [];
  try {
    const deps: SeedDeps = {
      repo: root,
      prepareDraft: (repo) => {
        const parent = join(repo, 'isolated');
        mkdirSync(parent);
        const file = join(parent, 'draft.json');
        writeFileSync(file, JSON.stringify({ description: 'research draft only', connectors: [] }));
        return { file, parent };
      },
      run: async (command, cwd) => { expect(cwd).toBe(root); calls.push([...command]); return { exitCode: 0, output: command.includes('plugin') ? '{"status":"draft","errors":[],"timings":{"install":0}}' : '{"status":"done","dryRun":false}' }; },
    };
    const report = await seed(parseArgs([]), deps);
    expect(report.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(['bun', 'bin/elanous.mjs', '--test', 'graph', 'run', 'graphs/demo/inside-seed.yaml', '--json']);
    expect(calls[1]!.slice(0, 5)).toEqual(['bun', 'bin/elanous.mjs', '--test', 'plugin', 'make']);
    expect(calls[1]).toContain('--draft-file');
    expect(calls[1]).not.toContain('--run');
    expect(calls[1]).not.toContain('--market-bundle-dir');
    expect(readFileSync(calls[1]![calls[1]!.indexOf('--draft-file') + 1]!, 'utf8')).toContain('research draft only');
    expect(report.events.map(event => event.phase)).toEqual(['start', 'finish', 'start', 'finish']);
    expect(report.events[2]!.command).toEqual(calls[1]!);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('start is emitted before the child runs, then completion is emitted afterward', async () => {
  const seen: string[] = [];
  await seed(parseArgs(['--only', 'graph']), {
    repo: '/unused', prepareDraft: () => { throw new Error('not selected'); },
    run: async () => { expect(seen).toEqual(['start']); return { exitCode: 0, output: '{"status":"done","dryRun":false}' }; },
  }, event => seen.push(event.phase));
  expect(seen).toEqual(['start', 'finish']);
});

test('a nonzero exit and a spawn failure are reported, do not prevent the other target, and retain guidance', async () => {
  const calls: string[][] = [];
  const deps: SeedDeps = { repo: '/unused', prepareDraft: () => ({ file: '/draft.json', parent: '/isolated' }),
    run: async command => { calls.push(command); if (command.includes('graph')) return { exitCode: 7, output: 'bad graph' }; throw new Error('wizard unavailable'); } };
  const report = await seed(parseArgs(['--only', 'all', '--json']), deps);
  expect(calls).toHaveLength(2);
  expect(report.ok).toBe(false);
  expect(report.events.map(event => event.phase)).toEqual(['start', 'failure', 'start', 'failure']);
  expect(report.events[1]).toMatchObject({ exitCode: 7, output: 'bad graph' });
  expect(report.events[3]).toMatchObject({ output: 'wizard unavailable' });
  expect(report.guidance).toBe(SCENE_SIX_GUIDANCE);
});

test('status comes from child stdout even if isolation warning appears on stderr', async () => {
  const report = await seed(parseArgs(['--only', 'wizard']), {
    repo: '/unused', prepareDraft: () => ({ file: '/draft.json', parent: '/isolated' }),
    run: async () => ({ exitCode: 0, stdout: '{"status":"draft","errors":[],"timings":{"install":0}}',
      output: '{"status":"draft","errors":[],"timings":{"install":0}}\n[test-isolation] default config' }),
  });
  expect(report.ok).toBe(true);
  expect(report.events[1]).toMatchObject({ phase: 'finish' });
});

test('graph cannot report finish for a zero-exit dry-run result', async () => {
  const report = await seed(parseArgs(['--only', 'graph']), {
    repo: '/unused', prepareDraft: () => { throw new Error('not selected'); },
    run: async () => ({ exitCode: 0, output: '{"status":"done","dryRun":true}' }),
  });
  expect(report.ok).toBe(false);
  expect(report.events[1]).toMatchObject({ phase: 'failure', exitCode: 0 });
});

test('wizard cannot report finish for a zero-exit non-draft result', async () => {
  const report = await seed(parseArgs(['--only', 'wizard']), {
    repo: '/unused', prepareDraft: () => ({ file: '/draft.json', parent: '/isolated' }),
    run: async () => ({ exitCode: 0, output: '{"status":"installed"}' }),
  });
  expect(report.ok).toBe(false);
  expect(report.events[1]).toMatchObject({ phase: 'failure', exitCode: 0 });
});

test('CLI executes draft-only wizard in the test instance without installation', () => {
  const proc = Bun.spawnSync(['bun', 'scripts/ux/demo-seed.ts', '--only', 'wizard', '--json'], { cwd: join(import.meta.dir, '../..') });
  expect(proc.exitCode).toBe(0);
  const report = JSON.parse(proc.stdout.toString()) as { ok: boolean; events: Array<{ phase: string; output?: string }> };
  expect(report.ok).toBe(true);
  expect(report.events.map(event => event.phase)).toEqual(['start', 'finish']);
  const result = JSON.parse(report.events[1]!.output!) as { status: string; timings: { install: number }; errors: string[] };
  expect(result).toMatchObject({ status: 'draft', timings: { install: 0 }, errors: [] });
});

test('default dry-run creates no isolated demo seed directory', async () => {
  const repo = join(import.meta.dir, '../..');
  const seedDir = join(repo, '.elanous-test/demo-seed');
  const before = existsSync(seedDir);
  await seed(parseArgs(['--dry-run', '--only', 'wizard']), noIO());
  expect(existsSync(seedDir)).toBe(before);
});
