import { afterEach, expect, spyOn, test } from 'bun:test';
import { debug } from './debug/log.js';
import { capturedEnvAvailable, mergeCapturedPath, resetCapturedEnvForTesting, runPrintenvCapture, setCapturedEnvForTesting, warmCapturedEnv } from './shell-env-bootstrap.js';

afterEach(() => resetCapturedEnvForTesting());

test('append only missing captured PATH entries after the existing target order', () => {
  const target = { PATH: '/usr/bin:/bin', TOKEN: 'keep', HTTP_PROXY: 'keep-proxy' };
  setCapturedEnvForTesting({ PATH: '/opt/x/bin:/usr/bin:/opt/y/bin:/opt/x/bin', TOKEN: 'secret', HTTP_PROXY: 'other' });
  expect(mergeCapturedPath(target)).toBe(2);
  expect(target).toEqual({ PATH: '/usr/bin:/bin:/opt/x/bin:/opt/y/bin', TOKEN: 'keep', HTTP_PROXY: 'keep-proxy' });
  expect(mergeCapturedPath(target)).toBe(0);
  expect(target.PATH).toBe('/usr/bin:/bin:/opt/x/bin:/opt/y/bin');
});

test('fallback capture does not alter even a different target PATH', () => {
  const target = { PATH: '/usr/bin:/bin' };
  setCapturedEnvForTesting(null);
  expect(capturedEnvAvailable()).toBe(false);
  expect(mergeCapturedPath(target)).toBe(0);
  expect(target.PATH).toBe('/usr/bin:/bin');
});

test('default target is the running process environment', () => {
  const previous = process.env.PATH;
  try {
    process.env.PATH = '/usr/bin:/bin';
    setCapturedEnvForTesting({ PATH: '/opt/x/bin:/usr/bin' });
    expect(mergeCapturedPath()).toBe(1);
    expect(process.env.PATH).toBe('/usr/bin:/bin:/opt/x/bin');
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
});

// HOST-PROBE-FOR-PODS ①: login-env capture time lands in `boot.phase`, on both the daemon warm path
// (nexus/index.ts → warmCapturedEnv) and the PTY's synchronous first capture (getCapturedEnv → runPrintenvCapture).
function bootPhases(run: () => unknown): Promise<Array<{ event: string; ms: number; outcome: string }>> {
  const log = spyOn(debug, 'log').mockImplementation(() => {});
  const done = async () => {
    try {
      await run();
      // read before mockRestore — restoring clears the recorded calls
      return log.mock.calls
        .filter(call => call[0] === 'boot.phase')
        .map(call => ({ event: String(call[1]), ...(call[2] as { ms: number; outcome: string }) }));
    } finally { log.mockRestore(); }
  };
  return done();
}

function withShell<T>(shell: string | undefined, run: () => T): T {
  const saved = process.env.SHELL;
  if (shell === undefined) delete process.env.SHELL; else process.env.SHELL = shell;
  try { return run(); } finally {
    if (saved === undefined) delete process.env.SHELL; else process.env.SHELL = saved;
  }
}

const warmSpawn = (stdout: string, code = 0) => ((() => ({
  stdout: new Response(stdout).body, exited: Promise.resolve(code), kill: () => undefined,
})) as unknown as typeof Bun.spawn);

test('the warm path records seed and shell phases with their duration and outcome', async () => {
  const env = 'PATH=/usr/bin:/bin\nHOME=/h\nUSER=x\nSHELL=/bin/zsh\nLANG=C\nEXTRA=1\n';
  const ok = await withShell('/bin/zsh', () => bootPhases(() => warmCapturedEnv(warmSpawn(env))));
  expect(ok.map(p => [p.event, p.outcome])).toEqual([['login-env.seed', 'ready'], ['login-env.shell', 'ok']]);
  for (const phase of ok) expect(phase.ms).toBeGreaterThanOrEqual(0);

  resetCapturedEnvForTesting();
  const failed = await withShell('/bin/zsh', () => bootPhases(() => warmCapturedEnv(warmSpawn('', 1))));
  expect(failed.map(p => [p.event, p.outcome])).toEqual([['login-env.seed', 'ready'], ['login-env.shell', 'failed']]);
});

test('the synchronous capture records an unavailable seed and a failed shell without changing its result', async () => {
  const noShell = await withShell(undefined, () => bootPhases(() => expect(runPrintenvCapture()).toBeNull()));
  expect(noShell.map(p => [p.event, p.outcome])).toEqual([['login-env.seed', 'unavailable']]);

  const missing = await withShell('/nonexistent-elanous-test/zsh', () => bootPhases(() => expect(runPrintenvCapture()).toBeNull()));
  expect(missing.map(p => [p.event, p.outcome])).toEqual([['login-env.seed', 'ready'], ['login-env.shell', 'failed']]);
  expect(missing[1]!.ms).toBeGreaterThanOrEqual(0);
});
