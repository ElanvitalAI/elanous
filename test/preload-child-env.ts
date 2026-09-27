// ── bun test preload — child processes see the PATH the test set (Node semantics) ──
//
// Why: in Bun (measured 1.3.12) `execFileSync`·`spawnSync`·`execSync`·`execFile`·`spawn`·`exec`
// and `Bun.spawn`/`Bun.spawnSync` called WITHOUT an `env` option look the command up on the
// PATH the process STARTED with — a later `process.env.PATH = \`${fakeBin}:…\`` is ignored.
// Node's documented default is `process.env` at call time. So a test that puts a fake `crontab`
// / `gh` / `git` / `kubectl` first on PATH and then calls code under test in-process ran the
// REAL binary (🅞 2026-09-27: a schedule test opened the operator's crontab · #21001).
//
// This preload restores only the PATH half of Node's default for tests: when a call passes no `env`
// and a test changed PATH, the child gets the startup env with the CURRENT PATH. Other env changes keep
// Bun's startup semantics (existing tests depend on them — a whole-env version broke 10 git tests). A call that passes its own `env` is untouched. A test that mocks
// `node:child_process` itself still wins (its mock.module replaces this one for that file).
import { mock } from 'bun:test';
import * as real from 'node:child_process';
import { promisify } from 'node:util';
import { pathOnlyEnv, withEnv } from './child-env-args.js';

// Bun's default child env is the startup env; keep it for everything except a changed PATH.
const STARTUP_ENV: Readonly<Record<string, string | undefined>> = { ...process.env };
const withCurrentEnv = (args: readonly unknown[]): unknown[] => {
  const env = pathOnlyEnv(STARTUP_ENV, process.env);
  return env ? withEnv(args, env) : [...args];
};

type AnyFn = (...args: any[]) => any;

const wrap = <F extends AnyFn>(fn: F): F => {
  const wrappedFn = ((...args: unknown[]) => fn(...withCurrentEnv(args))) as F;
  // execFile/exec carry Bun's custom promisify adapter, which returns { stdout, stderr }.
  // Without it, promisify(execFile) resolves to stdout alone and gitAsync loses the diff.
  const custom = (fn as F & { [promisify.custom]?: AnyFn })[promisify.custom];
  if (custom) {
    (wrappedFn as F & { [promisify.custom]?: AnyFn })[promisify.custom] =
      (...args: unknown[]) => custom(...withCurrentEnv(args));
  }
  return wrappedFn;
};

const wrapped = {
  execFileSync: wrap(real.execFileSync), spawnSync: wrap(real.spawnSync), execSync: wrap(real.execSync),
  execFile: wrap(real.execFile), spawn: wrap(real.spawn), exec: wrap(real.exec),
};
const replacement = () => ({ ...real, ...wrapped, default: { ...real, ...wrapped } });
mock.module('node:child_process', replacement);
mock.module('child_process', replacement);

// Bun's own spawn: (cmd[], options?) or ({ cmd, ...options }).
const bun = Bun as unknown as { spawn: AnyFn; spawnSync: AnyFn };
for (const name of ['spawn', 'spawnSync'] as const) {
  const original = bun[name].bind(Bun);
  bun[name] = (first: unknown, options?: Record<string, unknown>) => {
    if (first && typeof first === 'object' && !Array.isArray(first)) {
      const spec = first as Record<string, unknown>;
      const env = spec.env === undefined ? pathOnlyEnv(STARTUP_ENV, process.env) : null;
      return original(env ? { ...spec, env } : spec);
    }
    const env = options?.env === undefined ? pathOnlyEnv(STARTUP_ENV, process.env) : null;
    return original(first, env ? { ...(options ?? {}), env } : options);
  };
}
