import { describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { runDependencyChangeGate } from './dependency-change-gate.js';

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

