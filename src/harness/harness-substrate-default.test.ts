import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { getUserConfig, saveUserConfig, setUserConfigOverlay, type UserConfig } from '../user-config.js';
import * as podDispatch from './harness-pod-dispatch.js';
import { resolveHarnessSubstrate } from './harness-substrate-default.js';
import { devAskPodDispatchInput } from './harness-substrate-default.js';
import { installHarnessCliCommand } from './harness-cli-command.js';

const config = (substrate?: 'local' | 'pod', podPool?: string): Pick<UserConfig, 'harness' | 'pod'> => ({ harness: { substrate, podPool } });
const context = () => 'current-context';

describe('harness substrate default', () => {
  let previousPool: string | undefined;
  beforeEach(() => {
    previousPool = process.env.ELANOUS_POD_POOL;
    delete process.env.ELANOUS_POD_POOL;
  });
  afterEach(() => {
    setUserConfigOverlay(null);
    if (previousPool === undefined) delete process.env.ELANOUS_POD_POOL;
    else process.env.ELANOUS_POD_POOL = previousPool;
  });

  test('flag, config, default and four pool layers', () => {
    expect(resolveHarnessSubstrate({ config: config(), env: {}, currentContext: context })).toEqual({ substrate: 'local', pool: null, source: 'default' });
    expect(resolveHarnessSubstrate({ config: config('pod', 'cfg'), env: {}, currentContext: context })).toEqual({ substrate: 'pod', pool: 'cfg', source: 'config' });
    expect(resolveHarnessSubstrate({ flag: { substrate: 'local' }, config: config('pod', 'cfg'), env: {}, currentContext: context })).toEqual({ substrate: 'local', pool: null, source: 'flag' });
    expect(resolveHarnessSubstrate({ flag: { substrate: 'pod', podPool: 'flag' }, config: config('local', 'cfg'), env: { ELANOUS_POD_POOL: 'env' }, currentContext: context })).toEqual({ substrate: 'pod', pool: 'flag', source: 'flag' });
    expect(resolveHarnessSubstrate({ config: config('pod', 'cfg'), env: { ELANOUS_POD_POOL: 'env' }, currentContext: context })).toEqual({ substrate: 'pod', pool: 'env', source: 'config' });
    expect(resolveHarnessSubstrate({ config: config('pod'), env: {}, currentContext: context })).toEqual({ substrate: 'pod', pool: 'current-context', source: 'config' });
    expect(resolveHarnessSubstrate({ flag: { podPool: 'flag-only' }, config: config('pod', 'cfg'), env: {}, currentContext: context })).toEqual({ substrate: 'pod', pool: 'flag-only', source: 'config' });
  });

  test('legacy pod.pool remains the fallback before context and after the new pool layers', () => {
    const legacy = { harness: { substrate: 'pod' as const }, pod: { pool: 'legacy-pool@host:4' } };
    expect(resolveHarnessSubstrate({ config: legacy, env: {}, currentContext: context })).toEqual({ substrate: 'pod', pool: 'legacy-pool@host:4', source: 'config' });
    expect(resolveHarnessSubstrate({ flag: { substrate: 'pod' }, config: { pod: { pool: 'legacy-pool@host:4' } }, env: {}, currentContext: context })).toEqual({ substrate: 'pod', pool: 'legacy-pool@host:4', source: 'flag' });
    expect(resolveHarnessSubstrate({ config: { ...legacy, harness: { substrate: 'pod', podPool: 'new-pool' } }, env: {}, currentContext: context }).pool).toBe('new-pool');
    expect(resolveHarnessSubstrate({ config: legacy, env: { ELANOUS_POD_POOL: 'env-pool' }, currentContext: context }).pool).toBe('env-pool');
    expect(resolveHarnessSubstrate({ flag: { podPool: 'flag-pool' }, config: legacy, env: {}, currentContext: context }).pool).toBe('flag-pool');
  });

  test('configured pod without a reachable pool fails rather than running local', () => {
    expect(() => resolveHarnessSubstrate({ config: config('pod'), env: {}, currentContext: () => undefined }))
      .toThrow('`--substrate local` 로 명시하라');
  });

  test('user configuration parses and persists both harness fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-config-'));
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ harness: { substrate: 'pod', podPool: 'pool-node-b@node-b:8' } }));
    const parsed = getUserConfig(path);
    expect(parsed.harness).toMatchObject({ substrate: 'pod', podPool: 'pool-node-b@node-b:8' });
    saveUserConfig(parsed, path);
    expect(JSON.parse(readFileSync(path, 'utf8')).harness).toMatchObject({ substrate: 'pod', podPool: 'pool-node-b@node-b:8' });
    const updated = getUserConfig(path);
    expect(updated.harness).toMatchObject({ substrate: 'pod', podPool: 'pool-node-b@node-b:8' });
    const emptyDir = mkdtempSync(join(tmpdir(), 'harness-empty-'));
    const initial = getUserConfig(join(emptyDir, 'missing.json'));
    expect(initial.harness?.substrate).toBeUndefined();
    expect(resolveHarnessSubstrate({ config: initial, env: {}, currentContext: () => undefined })).toEqual({ substrate: 'local', pool: null, source: 'default' });
    rmSync(dir, { recursive: true, force: true });
    rmSync(emptyDir, { recursive: true, force: true });
  });

  test('a persisted legacy pod.pool is parsed and selected before current context', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-legacy-pool-'));
    const path = join(dir, 'config.json');
    try {
      writeFileSync(path, JSON.stringify({ harness: { substrate: 'pod' }, pod: { pool: 'legacy-pool@host:4' } }));
      const parsed = getUserConfig(path);
      expect(parsed.pod?.pool).toBe('legacy-pool@host:4');
      expect(resolveHarnessSubstrate({ config: parsed, env: {}, currentContext: context }).pool).toBe('legacy-pool@host:4');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('ask --dry-run preserves legacy pod.pool when the new pool is absent', async () => {
    setUserConfigOverlay((cfg) => ({ ...cfg, pod: { ...cfg.pod, pool: 'legacy-pool@host:4' }, harness: { ...cfg.harness, substrate: 'pod', podPool: undefined } }));
    const program = new Command().exitOverride();
    installHarnessCliCommand(program, { registerSink: async () => {}, resolveSurface: async () => 'harness', ask: async () => {} });
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: string) => { lines.push(line); };
    try {
      await program.parseAsync(['node', 'elanous', 'harness', 'ask', '/missing-goal', '--dry-run']);
      expect(lines).toContain('[harness] substrate=pod pool=legacy-pool@host:4 (config)');
    } finally {
      console.log = original;
    }
  });

  test('legacy pod.pool is passed to Pod dispatch instead of the current context', async () => {
    setUserConfigOverlay((cfg) => ({ ...cfg, pod: { ...cfg.pod, pool: 'legacy-pool@host:4' }, harness: { ...cfg.harness, substrate: 'pod', podPool: undefined } }));
    const dispatched = spyOn(podDispatch, 'dispatchHarnessOnPod').mockImplementation(() => 0);
    const program = new Command().exitOverride();
    installHarnessCliCommand(program, { registerSink: async () => {}, resolveSurface: async () => 'harness', say: async () => {} });
    const original = console.log;
    console.log = () => {};
    try {
      await program.parseAsync(['node', 'elanous', 'harness', 'say', 'goal']);
      expect(dispatched).toHaveBeenCalledTimes(1);
      expect(dispatched).toHaveBeenCalledWith(expect.objectContaining({ entrance: 'cli-harness-say', podPool: 'legacy-pool@host:4' }), expect.anything());
    } finally {
      console.log = original;
      dispatched.mockRestore();
    }
  });

  test('ask --dry-run exposes the configured Pod and selected pool without dispatch', async () => {
    setUserConfigOverlay((cfg) => ({ ...cfg, harness: { ...cfg.harness, substrate: 'pod', podPool: 'pool-preview:2' }, pod: { ...cfg.pod, pool: undefined } }));
    const program = new Command().exitOverride();
    const local: string[] = [];
    installHarnessCliCommand(program, { registerSink: async () => {}, resolveSurface: async () => 'harness', ask: async () => { local.push('ask'); } });
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: string) => { lines.push(line); };
    try {
      await program.parseAsync(['node', 'elanous', 'harness', 'ask', '/missing-goal', '--dry-run']);
      expect(lines).toContain('[harness] substrate=pod pool=pool-preview:2 (config)');
      expect(local).toEqual([]);
    } finally {
      console.log = original;
    }
  });

  test('configured pod with no pool refuses ask before any local dispatch', async () => {
    setUserConfigOverlay((cfg) => ({ ...cfg, harness: { ...cfg.harness, substrate: 'pod', podPool: undefined }, pod: { ...cfg.pod, pool: undefined } }));
    const previousPath = process.env.PATH;
    process.env.PATH = '';
    const previousExit = process.exitCode;
    process.exitCode = 0;
    const program = new Command().exitOverride();
    const received: unknown[] = [];
    installHarnessCliCommand(program, { registerSink: async () => {}, resolveSurface: async () => 'harness', ask: async (...args) => { received.push(args); } });
    const errors: string[] = [];
    const original = console.error;
    console.error = (line: string) => { errors.push(line); };
    try {
      await program.parseAsync(['node', 'elanous', 'harness', 'ask', '/missing-goal', '--pod-pool', ' ', '--dry-run']);
      expect(process.exitCode).toBe(1);
      expect(received).toEqual([]);
      expect(errors.some((line) => line.includes('`--substrate local` 로 명시하라'))).toBe(true);
      process.exitCode = 0;
    } finally {
      console.error = original;
      process.exitCode = previousExit;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  test('configured pod dispatches on ask and say, explicit local overrides it', async () => {
    setUserConfigOverlay((cfg) => ({ ...cfg, harness: { ...cfg.harness, substrate: 'pod', podPool: 'pool-test:2' }, pod: { ...cfg.pod, pool: undefined } }));
    const dispatched = spyOn(podDispatch, 'dispatchHarnessOnPod').mockImplementation(() => 0);
    const local: string[] = [];
    const program = new Command().exitOverride();
    installHarnessCliCommand(program, { registerSink: async () => {}, resolveSurface: async () => 'harness', ask: async () => { local.push('ask'); }, say: async () => { local.push('say'); } });
    const original = console.log;
    console.log = () => {};
    try {
      await program.parseAsync(['node', 'elanous', 'harness', 'ask', '/goal']);
      await program.parseAsync(['node', 'elanous', 'harness', 'say', 'goal']);
      expect(dispatched).toHaveBeenCalledTimes(2);
      expect(dispatched).toHaveBeenCalledWith(expect.objectContaining({ entrance: 'cli-harness-ask', podPool: 'pool-test:2' }), expect.anything());
      expect(dispatched).toHaveBeenCalledWith(expect.objectContaining({ entrance: 'cli-harness-say', podPool: 'pool-test:2' }), expect.anything());
      await program.parseAsync(['node', 'elanous', 'harness', 'ask', '/goal', '--substrate', 'local']);
      expect(local).toEqual(['ask']);
      expect(dispatched).toHaveBeenCalledTimes(2);
    } finally {
      console.log = original;
      dispatched.mockRestore();
    }
  });

  test('ask --dry-run prints the resolved launch substrate without dispatch', async () => {
    const received: unknown[] = [];
    const program = new Command().exitOverride();
    installHarnessCliCommand(program, { registerSink: async () => {}, resolveSurface: async () => 'harness', ask: async (...args) => { received.push(args); } });
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: string) => { lines.push(line); };
    try {
      await program.parseAsync(['node', 'elanous', 'harness', 'ask', '/missing-goal', '--substrate', 'local', '--dry-run']);
      expect(lines).toContain('[harness] substrate=local (flag)');
      expect(received).toEqual([]);
    } finally { console.log = original; }
  });
});

test('dev --ask on a Pod keeps --no-auto-merge (and only then sends autoMerge false)', () => {
  expect(devAskPodDispatchInput({ autoMerge: false, base: 'main' }, 'docs/goals/g.md', 'pool-node-b@node-b:8'))
    .toEqual({ entrance: 'cli-harness-ask', input: 'docs/goals/g.md', podPool: 'pool-node-b@node-b:8', base: 'main', autoMerge: false });
  expect(devAskPodDispatchInput({}, 'g.md', 'p')).toEqual({ entrance: 'cli-harness-ask', input: 'g.md', podPool: 'p' });
});
