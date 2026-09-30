import { expect, test } from 'bun:test';
import { NESTED_AGENT_ENV_BLOCKLIST } from './nested-agent-env.js';
import { claudeBackend, resolveBackendSpawn } from '../agent-mission/driver.js';

test('Claude child session marker is blocked and removed from the spawned child environment', () => {
  expect(NESTED_AGENT_ENV_BLOCKLIST.has('CLAUDE_CODE_CHILD_SESSION')).toBe(true);
  const spawned = resolveBackendSpawn(claudeBackend, {
    PATH: '/usr/bin', CLAUDE_CODE_CHILD_SESSION: 'parent', CLAUDECODE: 'parent',
  });
  expect(spawned.env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
  expect(spawned.env.CLAUDECODE).toBeUndefined();
  expect(spawned.env.PATH).toBe('/usr/bin');
  expect(spawned.nestedEnvRemovedCount).toBe(2);
});
