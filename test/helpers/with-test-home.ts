import { spyOn } from 'bun:test';
import * as os from 'node:os';

/** A patch of process.env for one callback: a string sets the key, `undefined` removes it. */
export type TestEnvPatch = Readonly<Record<string, string | undefined>>;

/**
 * Snapshot the patched keys, apply the patch, run, and restore every key exactly (absent stays absent) — also after a
 * throw. A `HOME` entry moves os.homedir() with it: Bun does not refresh os.homedir() when HOME changes after startup.
 * R4 (10-16): gate Pods run tests under a temp HOME with `LC_ALL=C.UTF-8` and the fake-LLM switch; a test that sets
 * one variable (e.g. LANG) without clearing the ones that outrank it reads the runner's value instead of its own.
 */
export async function withTestEnv<T>(patch: TestEnvPatch, run: () => T | Promise<T>): Promise<T> {
  const keys = Object.keys(patch);
  // Removing HOME has no single answer for os.homedir() (Bun falls back to the passwd entry, i.e. the real home) —
  // the very leak this helper exists to stop. Refuse it before touching anything; pass an empty temp dir instead.
  if (Object.hasOwn(patch, 'HOME') && patch.HOME === undefined) {
    throw new Error('withTestEnv: HOME cannot be removed — os.homedir() would fall back to the real home; pass an empty temp dir');
  }
  const previous = new Map(keys.map((key) => [key, Object.hasOwn(process.env, key) ? process.env[key] : undefined] as const));
  const home = Object.hasOwn(patch, 'HOME') ? patch.HOME : undefined;
  const homedirSpy = home !== undefined ? spyOn(os, 'homedir') : null;
  try {
    for (const key of keys) {
      const value = patch[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (homedirSpy && home !== undefined) homedirSpy.mockReturnValue(home);
    return await run();
  } finally {
    homedirSpy?.mockRestore();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Bun does not refresh os.homedir() when HOME changes after process startup. */
export async function withTestHome<T>(home: string, run: () => T | Promise<T>): Promise<T> {
  return withTestEnv({ HOME: home }, run);
}
