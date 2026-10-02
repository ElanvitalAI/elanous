import { afterEach, expect, test } from 'bun:test';
import { capturedEnvAvailable, getCapturedEnv, resetCapturedEnvForTesting, setCapturedEnvForTesting, warmCapturedEnv } from './shell-env-bootstrap.js';

afterEach(() => resetCapturedEnvForTesting());

const fakeSpawn = (stdout: string, code = 0) => ((() => ({
  stdout: new Response(stdout).body,
  exited: Promise.resolve(code),
  kill: () => undefined,
})) as unknown as typeof Bun.spawn);

const env = 'PATH=/usr/bin:/bin\nHOME=/home/x\nUSER=x\nSHELL=/bin/zsh\nLANG=en_US.UTF-8\nEXTRA=1\n';

test('warm fills the cache without spawnSync, so getCapturedEnv returns it at once', async () => {
  const saved = process.env.SHELL; process.env.SHELL = '/bin/zsh';
  try {
    expect(await warmCapturedEnv(fakeSpawn(env))).toBe(true);
    expect(capturedEnvAvailable()).toBe(true);
    expect(getCapturedEnv().EXTRA).toBe('1');
  } finally { process.env.SHELL = saved; }
});

test('a failed or implausible warm leaves the cache empty so the old path still runs', async () => {
  const saved = process.env.SHELL; process.env.SHELL = '/bin/zsh';
  try {
    expect(await warmCapturedEnv(fakeSpawn('', 1))).toBe(false);
    expect(capturedEnvAvailable()).toBe(false);
    expect(await warmCapturedEnv(fakeSpawn('A=1\n'))).toBe(false);
    expect(capturedEnvAvailable()).toBe(false);
  } finally { process.env.SHELL = saved; }
});

test('warm is a no-op once something is captured', async () => {
  setCapturedEnvForTesting({ PATH: '/x', KEEP: 'y' });
  let spawned = 0;
  const spy = ((...args: unknown[]) => { spawned++; return (fakeSpawn(env) as unknown as (...a: unknown[]) => unknown)(...args); }) as unknown as typeof Bun.spawn;
  expect(await warmCapturedEnv(spy)).toBe(true);
  expect(spawned).toBe(0);
  expect(getCapturedEnv().KEEP).toBe('y');
});
