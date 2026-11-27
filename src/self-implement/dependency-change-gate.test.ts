import { describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { gitAt } from '../git-fs/smart-run.js';
import { pwaBuildCacheKey, runDependencyChangeGate } from './dependency-change-gate.js';
import { pwaReachableSrcFiles } from './pwa-import-graph.js';

const brokenConsumer = 'src/acp/server.ts(36,3): error TS2724: missing SDK session API';

function fixture(check: (cwd: string) => void, config = true): void {
  const cwd = mkdtempSync(join(tmpdir(), 'dependency-change-gate-'));
  try {
    if (config) writeFileSync(join(cwd, 'tsconfig.json'), '{}');
    mkdirSync(join(cwd, 'apps/pwa/node_modules/next'), { recursive: true });
    writeFileSync(join(cwd, 'apps/pwa/node_modules/next/package.json'), '{}');
    check(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe('runDependencyChangeGate', () => {
  test('source-only edits skip all commands', () => fixture((cwd) => {
    const calls: string[] = [];
    const result = runDependencyChangeGate({ cwd, changedFiles: ['src/a.ts'], run: (cmd) => {
      calls.push(cmd);
      return { status: 0 };
    } });
    expect(result).toEqual({ ran: false, passed: true, failures: [] });
    expect(calls).toEqual([]);
  }));

  test('bun.lock change catches a root error in unchanged src/acp/server.ts and still runs the build', () => fixture((cwd) => {
    const calls: string[] = [];
    const result = runDependencyChangeGate({ cwd, changedFiles: ['bun.lock', 'src/a.ts'], run: (cmd, args, opts) => {
      calls.push([cmd, ...args].join(' '));
      expect(opts).toEqual({ cwd, timeout: 300_000 });
      return cmd === 'bunx'
        ? { status: 2, stdout: `noise\n${brokenConsumer}\nother diagnostic`, stderr: '' }
        : { status: 0 };
    } });
    expect(result).toEqual({ ran: true, passed: false, failures: [{ step: 'root-tsc', lines: [brokenConsumer] }], trigger: 'dependency', pwaReachableChanged: [] });
    expect(calls).toEqual(['bunx tsc --noEmit -p tsconfig.json', 'bun bin/elanous.mjs --test nexus build']);
  }));

  test('successful dependency update runs root tsc then PWA build', () => fixture((cwd) => {
    const calls: string[] = [];
    const result = runDependencyChangeGate({ cwd, changedFiles: ['bun.lock', 'src/a.ts'], run: (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      return { status: 0 };
    } });
    expect(result).toEqual({ ran: true, passed: true, failures: [], trigger: 'dependency', pwaReachableChanged: [] });
    expect(calls).toEqual(['bunx tsc --noEmit -p tsconfig.json', 'bun bin/elanous.mjs --test nexus build']);
  }));

  test('missing tsconfig in an external target skips both commands', () => fixture((cwd) => {
    let calls = 0;
    const result = runDependencyChangeGate({ cwd, changedFiles: ['package.json'], run: () => {
      calls++;
      return { status: 0 };
    } });
    expect(result).toEqual({ ran: false, passed: true, failures: [], skipped: 'no-tsconfig', trigger: 'dependency', pwaReachableChanged: [] });
    expect(calls).toBe(0);
  }, false));

  test('root and PWA manifests trigger the gate; no PWA folder means only root tsc', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dependency-manifest-'));
    try {
      writeFileSync(join(cwd, 'tsconfig.json'), '{}');
      for (const file of ['package.json', 'apps/pwa/package.json']) {
        const calls: string[] = [];
        expect(runDependencyChangeGate({ cwd, changedFiles: [file], run: (cmd) => {
          calls.push(cmd);
          return { status: 0 };
        } })).toMatchObject({ ran: true, passed: true });
        expect(calls).toEqual(['bunx']);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('timeout and PWA failure cannot pass as unmeasured success', () => fixture((cwd) => {
    const result = runDependencyChangeGate({ cwd, changedFiles: ['bun.lock'], run: (cmd) => cmd === 'bunx'
      ? { status: null, signal: 'SIGTERM', error: new Error('spawnSync bunx ETIMEDOUT') }
      : { status: 1, stderr: 'PWA build failed' } });
    expect(result).toMatchObject({ ran: true, passed: false });
    expect(result.failures.map(({ step }) => step)).toEqual(['root-tsc', 'pwa-build']);
    expect(result.failures[0]!.lines.join(' ')).toContain('ETIMEDOUT');
    expect(result.failures[1]!.lines).toContain('PWA build failed');
  }));

  test('reachable src runs only the PWA build; unrelated src runs nothing; missing PWA deps is measured false', () => fixture((cwd) => {
    mkdirSync(join(cwd, 'apps/pwa/src'), { recursive: true });
    mkdirSync(join(cwd, 'src/llm'), { recursive: true });
    mkdirSync(join(cwd, 'src/other'), { recursive: true });
    writeFileSync(join(cwd, 'apps/pwa/src/a.tsx'), "import '../../../src/llm/x.js';");
    writeFileSync(join(cwd, 'src/llm/x.ts'), "import './y.js';");
    writeFileSync(join(cwd, 'src/llm/y.ts'), 'export const y = 1;');
    writeFileSync(join(cwd, 'src/other/z.ts'), 'export const z = 1;');
    const calls: string[] = [];
    const run = (cmd: string, args: readonly string[]) => { calls.push([cmd, ...args].join(' ')); return { status: 0 }; };
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const reached = runDependencyChangeGate({ cwd, changedFiles: ['./src/llm/y.ts'], run });
      expect(reached).toEqual({ ran: true, passed: true, measured: true, failures: [], trigger: 'pwa-reachable', pwaReachableChanged: ['src/llm/y.ts'] });
      expect(calls).toEqual(['bun bin/elanous.mjs --test nexus build']);
      expect(log).toHaveBeenCalledWith('self-implement', 'gate.pwa-reachable', { trigger: 'pwa-reachable', changed: ['src/llm/y.ts'], skipped: undefined });
      calls.length = 0;
      expect(runDependencyChangeGate({ cwd, changedFiles: ['src/other/z.ts'], run })).toEqual({ ran: false, passed: true, failures: [] });
      expect(calls).toEqual([]);
      rmSync(join(cwd, 'apps/pwa/node_modules'), { recursive: true });
      expect(runDependencyChangeGate({ cwd, changedFiles: ['src/llm/y.ts'], run })).toEqual({
        ran: false, passed: true, measured: false, failures: [], skipped: 'pwa-deps-missing',
        trigger: 'pwa-reachable', pwaReachableChanged: ['src/llm/y.ts'],
      });
      expect(calls).toEqual([]);
      expect(log).toHaveBeenCalledWith('self-implement', 'gate.pwa-reachable', { trigger: 'pwa-reachable', changed: ['src/llm/y.ts'], skipped: 'pwa-deps-missing' });
    } finally { log.mockRestore(); }
  }));

  test('PWA import through actual JS builds for changes to either JS bridge or downstream TS', () => fixture((cwd) => {
    mkdirSync(join(cwd, 'apps/pwa/src'), { recursive: true });
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(join(cwd, 'apps/pwa/src/entry.tsx'), "import '../../../src/bridge.js';");
    writeFileSync(join(cwd, 'src/bridge.js'), "export { x } from './x.js';");
    writeFileSync(join(cwd, 'src/x.ts'), 'export const x = 1;');
    const calls: string[] = [];
    for (const file of ['src/bridge.js', 'src/x.ts']) {
      calls.length = 0;
      const result = runDependencyChangeGate({ cwd, changedFiles: [file], run: (cmd, args) => {
        calls.push([cmd, ...args].join(' '));
        return { status: 0 };
      } });
      expect(result).toEqual({ ran: true, passed: true, measured: true, failures: [], trigger: 'pwa-reachable', pwaReachableChanged: [file] });
      expect(calls).toEqual(['bun bin/elanous.mjs --test nexus build']);
    }
  }));

  test('reachable source builds PWA even when the root tsconfig is absent', () => fixture((cwd) => {
    mkdirSync(join(cwd, 'apps/pwa/src'), { recursive: true });
    mkdirSync(join(cwd, 'src/llm'), { recursive: true });
    writeFileSync(join(cwd, 'apps/pwa/src/a.tsx'), "import '../../../src/llm/x.js';");
    writeFileSync(join(cwd, 'src/llm/x.ts'), 'export const x = 1;');
    const calls: string[] = [];
    const result = runDependencyChangeGate({ cwd, changedFiles: ['src/llm/x.ts'], run: (cmd) => { calls.push(cmd); return { status: 0 }; } });
    expect(calls).toEqual(['bun']);
    expect(result).toMatchObject({ ran: true, measured: true, trigger: 'pwa-reachable' });
  }, false));

  test('deleted reachable source triggers PWA validation', () => fixture((cwd) => {
    mkdirSync(join(cwd, 'apps/pwa/src'), { recursive: true });
    writeFileSync(join(cwd, 'apps/pwa/src/a.tsx'), "import '../../../src/llm/deleted.js';");
    const calls: string[] = [];
    const result = runDependencyChangeGate({ cwd, changedFiles: ['src/llm/deleted.ts'], run: (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      return { status: 1, stderr: 'Cannot find module src/llm/deleted.js' };
    } });
    expect(calls).toEqual(['bun bin/elanous.mjs --test nexus build']);
    expect(result).toMatchObject({ ran: true, passed: false, trigger: 'pwa-reachable',
      pwaReachableChanged: ['src/llm/deleted.ts'], failures: [{ step: 'pwa-build', lines: ['Cannot find module src/llm/deleted.js'] }],
    });
  }));

  test('combined dependency and reachable source without root tsconfig or PWA dependencies does not claim a run', () => fixture((cwd) => {
    mkdirSync(join(cwd, 'apps/pwa/src'), { recursive: true });
    mkdirSync(join(cwd, 'src/llm'), { recursive: true });
    writeFileSync(join(cwd, 'apps/pwa/src/a.tsx'), "import '../../../src/llm/x.js';");
    writeFileSync(join(cwd, 'src/llm/x.ts'), 'export const x = 1;');
    rmSync(join(cwd, 'apps/pwa/node_modules'), { recursive: true });
    const calls: string[] = [];
    const log = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const result = runDependencyChangeGate({ cwd, changedFiles: ['bun.lock', 'src/llm/x.ts'], run: (cmd) => {
        calls.push(cmd);
        return { status: 0 };
      } });
      expect(calls).toEqual([]);
      expect(result).toEqual({ ran: false, passed: true, measured: false, failures: [],
        skipped: 'pwa-deps-missing', trigger: 'dependency', pwaReachableChanged: ['src/llm/x.ts'] });
      expect(log).toHaveBeenCalledWith('self-implement', 'gate.pwa-reachable', {
        trigger: 'dependency', changed: ['src/llm/x.ts'], skipped: 'pwa-deps-missing',
      });
    } finally { log.mockRestore(); }
  }, false));

  test('combined dependency and reachable source still builds when root tsconfig is absent', () => fixture((cwd) => {
    mkdirSync(join(cwd, 'apps/pwa/src'), { recursive: true });
    mkdirSync(join(cwd, 'src/llm'), { recursive: true });
    writeFileSync(join(cwd, 'apps/pwa/src/a.tsx'), "import '../../../src/llm/x.js';");
    writeFileSync(join(cwd, 'src/llm/x.ts'), 'export const x = 1;');
    const calls: string[] = [];
    const result = runDependencyChangeGate({ cwd, changedFiles: ['bun.lock', 'src/llm/x.ts'], run: (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      return { status: 0 };
    } });
    expect(calls).toEqual(['bun bin/elanous.mjs --test nexus build']);
    expect(result).toMatchObject({ ran: true, passed: true, trigger: 'dependency', pwaReachableChanged: ['src/llm/x.ts'] });
  }, false));

  test('reachable PWA build failure retains the existing failure lines without root tsc', () => fixture((cwd) => {
    mkdirSync(join(cwd, 'apps/pwa/src'), { recursive: true });
    mkdirSync(join(cwd, 'src/llm'), { recursive: true });
    writeFileSync(join(cwd, 'apps/pwa/src/a.tsx'), "import '../../../src/llm/x.js';");
    writeFileSync(join(cwd, 'src/llm/x.ts'), 'export const x = 1;');
    const calls: string[] = [];
    const result = runDependencyChangeGate({ cwd, changedFiles: ['src/llm/x.ts'], run: (cmd) => {
      calls.push(cmd);
      return { status: 1, stderr: 'PWA build failed' };
    } });
    expect(calls).toEqual(['bun']);
    expect(result).toMatchObject({ ran: true, passed: false, trigger: 'pwa-reachable', failures: [{ step: 'pwa-build', lines: ['PWA build failed'] }] });
  }));

  test('combined dependency and reachable src edits retain both old command steps and report the reachable source', () => fixture((cwd) => {
    mkdirSync(join(cwd, 'apps/pwa/src'), { recursive: true });
    mkdirSync(join(cwd, 'src/llm'), { recursive: true });
    writeFileSync(join(cwd, 'apps/pwa/src/a.tsx'), "import '../../../src/llm/x.js';");
    writeFileSync(join(cwd, 'src/llm/x.ts'), 'export const x = 1;');
    const calls: string[] = [];
    const result = runDependencyChangeGate({ cwd, changedFiles: ['bun.lock', 'src/llm/x.ts'], run: (cmd) => { calls.push(cmd); return { status: 0 }; } });
    expect(calls).toEqual(['bunx', 'bun']);
    expect(result).toMatchObject({ trigger: 'dependency', pwaReachableChanged: ['src/llm/x.ts'], passed: true });
  }));

  test('dependency update without PWA dependencies still runs root tsc and exposes the unmeasured build', () => fixture((cwd) => {
    rmSync(join(cwd, 'apps/pwa/node_modules'), { recursive: true });
    const calls: string[] = [];
    const result = runDependencyChangeGate({ cwd, changedFiles: ['bun.lock'], run: (cmd) => { calls.push(cmd); return { status: 0 }; } });
    expect(calls).toEqual(['bunx']);
    expect(result).toMatchObject({ ran: true, passed: true, measured: false, trigger: 'dependency', skipped: 'pwa-deps-missing' });
  }));

  test('root compiler diagnostics are capped at 20 lines', () => fixture((cwd) => {
    const result = runDependencyChangeGate({ cwd, changedFiles: ['bun.lock'], run: (cmd) => ({
      status: cmd === 'bunx' ? 1 : 0,
      stdout: cmd === 'bunx' ? Array.from({ length: 25 }, (_, i) => `src/consumer${i}.ts(1,1): error TS2304: x`).join('\n') : '',
    }) });
    expect(result.failures[0]!.lines).toHaveLength(20);
  }));

  test('an empty apps/pwa/node_modules is not installed; a hoisted root next is', () => fixture((cwd) => {
    mkdirSync(join(cwd, 'apps/pwa/src'), { recursive: true });
    mkdirSync(join(cwd, 'src/llm'), { recursive: true });
    writeFileSync(join(cwd, 'apps/pwa/src/a.tsx'), "import '../../../src/llm/y.js';");
    writeFileSync(join(cwd, 'src/llm/y.ts'), 'export const y = 1;');
    rmSync(join(cwd, 'apps/pwa/node_modules/next'), { recursive: true });
    const calls: string[] = [];
    const run = (cmd: string, args: readonly string[]) => { calls.push([cmd, ...args].join(' ')); return { status: 0 }; };
    const empty = runDependencyChangeGate({ cwd, changedFiles: ['src/llm/y.ts'], run });
    expect(empty).toMatchObject({ skipped: 'pwa-deps-missing', measured: false });
    expect(calls).toEqual([]);
    mkdirSync(join(cwd, 'node_modules/next'), { recursive: true });
    writeFileSync(join(cwd, 'node_modules/next/package.json'), '{}');
    const hoisted = runDependencyChangeGate({ cwd, changedFiles: ['src/llm/y.ts'], run });
    expect(hoisted.skipped).toBeUndefined();
    expect(calls.some((c) => c.includes('nexus build'))).toBe(true);
  }));
});


/** A git work tree: apps/pwa importing src/llm/x.ts, an unrelated src/other/z.ts, root manifests and installed next. */
function gitFixture(check: (cwd: string, cacheDir: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'pwa-build-cache-'));
  const cwd = join(root, 'repo');
  const cacheDir = join(root, 'state', 'pwa-build-cache');
  const g = (...args: string[]) => {
    const r = gitAt(cwd)(args);
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  };
  try {
    mkdirSync(join(cwd, 'apps/pwa/src'), { recursive: true });
    mkdirSync(join(cwd, 'apps/pwa/node_modules/next'), { recursive: true });
    mkdirSync(join(cwd, 'src/llm'), { recursive: true });
    mkdirSync(join(cwd, 'src/other'), { recursive: true });
    writeFileSync(join(cwd, '.gitignore'), 'node_modules/\n');
    writeFileSync(join(cwd, 'apps/pwa/node_modules/next/package.json'), '{}');
    writeFileSync(join(cwd, 'apps/pwa/package.json'), '{"name":"pwa"}\n');
    writeFileSync(join(cwd, 'apps/pwa/src/a.tsx'), "import '../../../src/llm/x.js';\n");
    writeFileSync(join(cwd, 'src/llm/x.ts'), 'export const x = 1;\n');
    writeFileSync(join(cwd, 'src/other/z.ts'), 'export const z = 1;\n');
    writeFileSync(join(cwd, 'package.json'), '{"name":"root"}\n');
    writeFileSync(join(cwd, 'bun.lock'), 'lock v1\n');
    writeFileSync(join(cwd, 'tsconfig.json'), '{}\n');
    g('init', '-q', '-b', 'main');
    g('-c', 'user.email=t@t.co', '-c', 'user.name=T', 'add', '-A');
    g('-c', 'user.email=t@t.co', '-c', 'user.name=T', 'commit', '-q', '-m', 'base');
    check(cwd, cacheDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const BUILD = 'bun bin/elanous.mjs --test nexus build';

describe('PWA-GATE-OWN-DELTA-CACHE — content-addressed PWA build cache', () => {
  test('a green build is stored; the same inputs are a hit that skips the build and still count as measured', () => gitFixture((cwd, cacheDir) => {
    const calls: string[] = [];
    const run = (cmd: string, args: readonly string[]) => { calls.push([cmd, ...args].join(' ')); return { status: 0, stdout: 'built' }; };
    const events: Array<Record<string, unknown>> = [];
    const log = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data?: Record<string, unknown>) => {
      if (category === 'self-implement' && event === 'gate.pwa-build') events.push(data ?? {});
    }) as never);
    try {
      const first = runDependencyChangeGate({ cwd, changedFiles: ['src/llm/x.ts'], run, cacheDir });
      expect(first).toMatchObject({ ran: true, passed: true, measured: true, pwaBuildCache: 'miss' });
      expect(calls).toEqual([BUILD]);
      expect(readdirSync(cacheDir).filter((file) => file.endsWith('.json'))).toEqual([`${first.pwaBuildCacheKey}.json`]);
      calls.length = 0;
      const second = runDependencyChangeGate({ cwd, changedFiles: ['src/llm/x.ts'], run, cacheDir });
      expect(second).toEqual({
        ran: false, passed: true, measured: true, failures: [], trigger: 'pwa-reachable', pwaReachableChanged: ['src/llm/x.ts'],
        pwaBuildCache: 'hit', pwaBuildCacheKey: first.pwaBuildCacheKey,
      });
      expect(calls).toEqual([]);
      expect(events.map((event) => event.cache)).toEqual(['miss', 'hit']);
      expect(events[1]!.key).toBe(first.pwaBuildCacheKey!.slice(0, 16));
    } finally { log.mockRestore(); }
  }));

  test('the key moves with bun.lock (and with a reachable src edit) but not with an unrelated src file', () => gitFixture((cwd, cacheDir) => {
    const key = () => pwaBuildCacheKey(cwd, pwaReachableSrcFiles(cwd));
    const base = key();
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    writeFileSync(join(cwd, 'src/other/z.ts'), 'export const z = 2;\n');
    expect(key()).toBe(base);
    writeFileSync(join(cwd, 'bun.lock'), 'lock v2\n');
    const lockMoved = key();
    expect(lockMoved).not.toBe(base);
    writeFileSync(join(cwd, 'src/llm/x.ts'), 'export const x = 2;\n');
    expect(key()).not.toBe(lockMoved);
    // A cached green build for the old lock is not reused for the new one.
    const calls: string[] = [];
    const run = (cmd: string, args: readonly string[]) => { calls.push([cmd, ...args].join(' ')); return { status: 0 }; };
    writeFileSync(join(cwd, 'bun.lock'), 'lock v1\n');
    writeFileSync(join(cwd, 'src/llm/x.ts'), 'export const x = 1;\n');
    expect(runDependencyChangeGate({ cwd, changedFiles: ['src/llm/x.ts'], run, cacheDir }).pwaBuildCache).toBe('miss');
    writeFileSync(join(cwd, 'bun.lock'), 'lock v2\n');
    expect(runDependencyChangeGate({ cwd, changedFiles: ['bun.lock'], run, cacheDir }).pwaBuildCache).toBe('miss');
    expect(calls.filter((call) => call === BUILD)).toHaveLength(2);
  }));

  test('a failed build is never cached — the next gate on the same inputs builds again and fails again', () => gitFixture((cwd, cacheDir) => {
    const calls: string[] = [];
    const run = (cmd: string, args: readonly string[]) => { calls.push([cmd, ...args].join(' ')); return { status: 1, stderr: "Cannot find module 'styled-jsx/package.json'" }; };
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = runDependencyChangeGate({ cwd, changedFiles: ['src/llm/x.ts'], run, cacheDir });
      expect(result).toMatchObject({ passed: false, pwaBuildCache: 'miss' });
      expect(result.failures[0]!.lines).toContain("Cannot find module 'styled-jsx/package.json'");
    }
    expect(calls).toEqual([BUILD, BUILD]);
    expect(existsSync(cacheDir) ? readdirSync(cacheDir) : []).toEqual([]);
  }));

  test('missing PWA deps on a new key stays «못 쟀다»; only an identical green key passes measured', () => gitFixture((cwd, cacheDir) => {
    const run = () => ({ status: 0 });
    expect(runDependencyChangeGate({ cwd, changedFiles: ['src/llm/x.ts'], run, cacheDir }).pwaBuildCache).toBe('miss');
    rmSync(join(cwd, 'apps/pwa/node_modules'), { recursive: true });
    expect(runDependencyChangeGate({ cwd, changedFiles: ['src/llm/x.ts'], run, cacheDir })).toMatchObject({ passed: true, measured: true, pwaBuildCache: 'hit' });
    writeFileSync(join(cwd, 'src/llm/x.ts'), 'export const x = 3;\n');
    expect(runDependencyChangeGate({ cwd, changedFiles: ['src/llm/x.ts'], run, cacheDir })).toMatchObject({
      ran: false, passed: true, measured: false, skipped: 'pwa-deps-missing', pwaBuildCache: 'miss',
    });
  }));

  test('a change to the PWA app itself builds (cache miss on its new content)', () => gitFixture((cwd, cacheDir) => {
    const calls: string[] = [];
    const run = (cmd: string, args: readonly string[]) => { calls.push([cmd, ...args].join(' ')); return { status: 0 }; };
    writeFileSync(join(cwd, 'apps/pwa/src/a.tsx'), "import '../../../src/llm/x.js';\nexport const page = 1;\n");
    const result = runDependencyChangeGate({ cwd, changedFiles: ['apps/pwa/src/a.tsx'], run, cacheDir });
    expect(result).toMatchObject({ ran: true, passed: true, trigger: 'pwa-reachable', pwaReachableChanged: ['apps/pwa/src/a.tsx'], pwaBuildCache: 'miss' });
    expect(calls).toEqual([BUILD]);
    expect(runDependencyChangeGate({ cwd, changedFiles: ['apps/pwa/node_modules/next/x.js'], run, cacheDir })).toEqual({ ran: false, passed: true, failures: [] });
  }));

  test('no git work tree ⇒ cache unavailable, the build still runs', () => fixture((cwd) => {
    mkdirSync(join(cwd, 'apps/pwa/src'), { recursive: true });
    const calls: string[] = [];
    const result = runDependencyChangeGate({ cwd, changedFiles: ['apps/pwa/src/a.tsx'], cacheDir: join(cwd, '.cache'),
      run: (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { status: 0 }; } });
    expect(result).toMatchObject({ ran: true, passed: true, pwaBuildCache: 'unavailable' });
    expect(result.pwaBuildCacheKey).toBeUndefined();
    expect(calls).toEqual([BUILD]);
    expect(existsSync(join(cwd, '.cache'))).toBe(false);
  }));
});
