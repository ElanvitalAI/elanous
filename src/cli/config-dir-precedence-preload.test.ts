import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { userConfigPath } from '../user-config.js';

test('inherited XDG cannot shadow an isolated or explicitly selected state root', () => {
  const stateDir = process.env.ELANOUS_STATE_DIR;
  expect(stateDir).toBeTruthy();
  if (process.env.ELANOUS_CONFIG_PRELOAD_PROBE === '1') {
    // Parent removes state dir before spawning: preload must select a fresh root.
    expect(process.env.XDG_CONFIG_HOME).toBeTruthy();
    expect(stateDir).toContain(`elanous-test-global-${process.pid}`);
  }
  expect(userConfigPath()).toBe(join(stateDir!, 'config.json'));
});
