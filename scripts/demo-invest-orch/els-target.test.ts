// DEMO-INVEST-ELS-TARGET — the invest demo opens its panel tabs in the els of the universe it runs in (or the one named).
import { expect, test } from 'bun:test';
import { investElsEnv, investElsTarget } from './handlers.js';

test('default: the els of the run\'s own universe; an inherited operational socket never decides', () => {
  const env = { ELANOUS_STATE_DIR: '/tmp/tvx/u', ELANOUS_ELS_SOCKET: '/Users/me/.elanous/els/els.sock' };
  expect(investElsTarget(env)).toEqual({ socket: '/tmp/tvx/u/els/els.sock', stateRoot: '/tmp/tvx/u' });
});

test('an explicit --els-socket wins and names its own state root', () => {
  expect(investElsTarget({ ELANOUS_STATE_DIR: '/tmp/a' }, '/tmp/b/els/els.sock')).toEqual({ socket: '/tmp/b/els/els.sock', stateRoot: '/tmp/b' });
});

test('no universe and no socket is refused, not guessed', () => {
  expect(() => investElsTarget({})).toThrow('set ELANOUS_STATE_DIR or pass --els-socket');
});

test('the els new env points at the target root and drops another els\'s credentials', () => {
  const target = { socket: '/tmp/tvx/u/els/els.sock', stateRoot: '/tmp/tvx/u' };
  const env = investElsEnv({ PATH: '/bin', ELANOUS_STATE_DIR: '/x', ELANOUS_ELS_SOCKET: '/ops/els/els.sock', ELANOUS_ELS_PANE_TOKEN: 'tok', ELANOUS_ELS_OWNER_TOKEN: 'own', ELANOUS_ELS_PANE: 'p1', ELANOUS_ELS_WS: 'HQ' } as NodeJS.ProcessEnv, target);
  expect(env).toEqual({ PATH: '/bin', ELANOUS_STATE_DIR: '/tmp/tvx/u' } as NodeJS.ProcessEnv);
  const same = investElsEnv({ ELANOUS_ELS_SOCKET: '/tmp/tvx/u/els/els.sock', ELANOUS_ELS_PANE_TOKEN: 'tok' } as NodeJS.ProcessEnv, target);
  expect(same.ELANOUS_ELS_PANE_TOKEN).toBe('tok');
});
