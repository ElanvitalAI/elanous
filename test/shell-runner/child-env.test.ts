import { expect, test } from 'bun:test';
import { shellChildEnv } from '../../src/shell-runner/child-env.js';
import { createFileCaptureEngine } from '../../src/shell-runner/file-engine.js';
import { createRunnerHostFactory } from '../../src/shell-runner/runner-host-factory.js';
import { PreviewTerminal } from '../../src/preview/terminal.js';
import { resetCapturedEnvForTesting, setCapturedEnvForTesting } from '../../src/shell-env-bootstrap.js';

test('shell environment keeps runtime settings and explicit safe values, never credential names', () => {
  const env = shellChildEnv({ PATH: '/bin', HOME: '/safe', FAKE_API_KEY: 'fake', SSH_AUTH_SOCK: 'fake', RANDOM_PARENT: 'fake' },
    { CUSTOM_FLAG: 'allowed', FAKE_TOKEN: 'fake', FAKE_API_KEY: 'fake' });
  expect(Object.hasOwn(env, 'PATH')).toBe(true);
  expect(Object.hasOwn(env, 'CUSTOM_FLAG')).toBe(true);
  expect(['FAKE_API_KEY', 'SSH_AUTH_SOCK', 'FAKE_TOKEN', 'RANDOM_PARENT'].some(key => Object.hasOwn(env, key))).toBe(false);
});

test('file-engine real shell cannot see inherited or explicitly supplied fake secret', async () => {
  const previous = process.env.FAKE_API_KEY;
  process.env.FAKE_API_KEY = 'fake';
  try {
    const engine = createFileCaptureEngine();
    const handle = engine.run({ command: ['/bin/sh', '-c', 'if [ -n "${FAKE_API_KEY+x}" ] || [ -n "${FAKE_TOKEN+x}" ] || [ -z "${PATH+x}" ]; then printf LEAK; else printf SAFE; fi'],
      env: { FAKE_TOKEN: 'fake', CUSTOM_FLAG: 'allowed' }, timeoutMs: 5000 }, { getCwd: () => process.cwd() }); // 출처: #102320 — 실 셸 환경 차단 시험의 종료 상한.
    const result = await handle.result;
    expect(result.stdout.text).toBe('SAFE');
    expect(result.exitCode).toBe(0);
  } finally { if (previous === undefined) delete process.env.FAKE_API_KEY; else process.env.FAKE_API_KEY = previous; }
});

test('PTY factory and isolated preview never reintroduce captured fake secret', () => {
  const previous = process.env.FAKE_API_KEY;
  process.env.FAKE_API_KEY = 'fake';
  setCapturedEnvForTesting({ PATH: '/bin', FAKE_API_KEY: 'fake', FAKE_TOKEN: 'fake' });
  let factoryEnv: Record<string, string> = {};
  let spawnedEnv: Record<string, string> = {};
  const factory = createRunnerHostFactory({ getSessionCwd: () => process.cwd(), defaultShell: '/bin/sh',
    terminalFactory: (_label, spec) => { factoryEnv = spec.env ?? {}; return { start() {}, isAlive: true } as never; } });
  try {
    factory.factory({ command: 'true', env: { FAKE_TOKEN: 'fake', CUSTOM_FLAG: 'allowed' } });
    const preview = new PreviewTerminal({ cols: 80, rows: 24, cwd: process.cwd(), shell: '/bin/sh', shellArgs: [], env: factoryEnv, isolatedEnv: true },
      (_shell, _args, opts) => { spawnedEnv = opts.env; throw new Error('captured-spawn'); });
    expect(() => preview.start()).toThrow('captured-spawn');
    expect(Object.hasOwn(spawnedEnv, 'PATH')).toBe(true);
    expect(Object.hasOwn(spawnedEnv, 'CUSTOM_FLAG')).toBe(true);
    expect(['FAKE_API_KEY', 'FAKE_TOKEN'].some(key => Object.hasOwn(spawnedEnv, key))).toBe(false);
  } finally {
    factory.disposeAll();
    resetCapturedEnvForTesting();
    if (previous === undefined) delete process.env.FAKE_API_KEY; else process.env.FAKE_API_KEY = previous;
  }
});

// Linux PTY output is empty on the pre-existing direct path; tracked as LINUX-PTY-OUTPUT-EMPTY.
test.skipIf(process.platform === 'linux')('real PTY shell receives no inherited fake secret', async () => {
  const previous = process.env.FAKE_API_KEY;
  process.env.FAKE_API_KEY = 'fake';
  setCapturedEnvForTesting({ PATH: '/usr/bin:/bin', FAKE_API_KEY: 'fake' });
  let output = '';
  const terminal = new PreviewTerminal({ cols: 80, rows: 24, cwd: process.cwd(), shell: '/bin/sh',
    shellArgs: ['-c', 'if [ -n "${FAKE_API_KEY+x}" ] || [ -z "${PATH+x}" ]; then printf LEAK; else printf SAFE; fi'],
    env: shellChildEnv(process.env), isolatedEnv: true });
  terminal.addRawOutputTap(chunk => { output += chunk; });
  try {
    terminal.start();
    const deadline = Date.now() + 5000;
    while (!output.includes('SAFE') && !output.includes('LEAK') && Date.now() < deadline) await Bun.sleep(20);
    expect(output).toBe('SAFE');
  } finally {
    terminal.stop();
    resetCapturedEnvForTesting();
    if (previous === undefined) delete process.env.FAKE_API_KEY; else process.env.FAKE_API_KEY = previous;
  }
}, 8000);

// Linux PTY output is empty on the pre-existing direct path; tracked as LINUX-PTY-OUTPUT-EMPTY.
test.skipIf(process.platform === 'linux')('actual runner PTY shell cannot see fake inherited or explicit secrets', async () => {
  const previous = process.env.FAKE_API_KEY;
  process.env.FAKE_API_KEY = 'fake';
  setCapturedEnvForTesting({ PATH: '/usr/bin:/bin', FAKE_API_KEY: 'fake' });
  const factory = createRunnerHostFactory({ getSessionCwd: () => process.cwd(), defaultShell: '/bin/bash' });
  let output = '';
  try {
    const host = factory.factory({ command: 'true', env: { FAKE_TOKEN: 'fake' } });
    if (!host) throw new Error('runner PTY did not start');
    const stopTap = host.addRawOutputTap(chunk => { output += chunk; });
    host.write('if [ -n "${FAKE_API_KEY+x}" ] || [ -n "${FAKE_TOKEN+x}" ] || [ -z "${PATH+x}" ]; then printf "\\nLEAK\\n"; else printf "\\nSAFE\\n"; fi\r');
    const deadline = Date.now() + 5000;
    while (!/(?:^|\n)(?:SAFE|LEAK)\r?\n/.test(output) && Date.now() < deadline) await Bun.sleep(20);
    stopTap();
    expect(/(?:^|\n)SAFE\r?\n/.test(output)).toBe(true);
    expect(/(?:^|\n)LEAK\r?\n/.test(output)).toBe(false);
  } finally {
    factory.disposeAll();
    resetCapturedEnvForTesting();
    if (previous === undefined) delete process.env.FAKE_API_KEY; else process.env.FAKE_API_KEY = previous;
  }
}, 8000);
