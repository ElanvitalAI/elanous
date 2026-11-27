import { expect, test } from 'bun:test';
import { shellChildEnv } from './child-env.js';
import { runShell } from '../shell-primitive/runtime.js';

const keys = ['ELANOUS_TRACK', 'ELANOUS_SEAT', 'ELANOUS_TEST_SECRET', 'ELANOUS_UNLISTED'] as const;

test('allowlist keeps only present seat identity without leaking other environment', () => {
  expect(shellChildEnv({ ELANOUS_TRACK: 'TC', ELANOUS_SEAT: 'TC-H-POOL-2', ELANOUS_TEST_SECRET: 'secret', ELANOUS_UNLISTED: 'private' } as NodeJS.ProcessEnv)).toEqual({
    ELANOUS_TRACK: 'TC', ELANOUS_SEAT: 'TC-H-POOL-2',
  });
  expect(shellChildEnv({} as NodeJS.ProcessEnv)).toEqual({});
});

test('allowlisted shell subprocess receives seat identity but not secrets', async () => {
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    process.env.ELANOUS_TRACK = 'TC';
    process.env.ELANOUS_SEAT = 'TC-H-POOL-2';
    process.env.ELANOUS_TEST_SECRET = 'do-not-leak';
    process.env.ELANOUS_UNLISTED = 'do-not-leak';
    const result = await runShell({
      command: ['/usr/bin/env'], cwd: '/tmp', envPolicy: 'allowlist', approval: 'none', sandbox: 'off',
    });
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.split('\n');
    expect(lines).toContain('ELANOUS_TRACK=TC');
    expect(lines).toContain('ELANOUS_SEAT=TC-H-POOL-2');
    expect(lines.some(line => line.startsWith('ELANOUS_TEST_SECRET=') || line.startsWith('ELANOUS_UNLISTED='))).toBe(false);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
