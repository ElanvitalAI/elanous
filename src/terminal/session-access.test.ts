import { afterEach, expect, test } from 'bun:test';
import {
  initDashboardTerminalSessions,
  getDashboardTerminalSessions as getFromDashboard,
  _resetDashboardTerminalSessionsForTesting,
} from '../dashboard/terminal/session.js';
import { getDashboardTerminalSessions as getFromTerminal } from './session-access.js';

afterEach(_resetDashboardTerminalSessionsForTesting);

test('dashboard and terminal paths share one initialized session registry', () => {
  _resetDashboardTerminalSessionsForTesting();
  expect(() => getFromTerminal()).toThrow('not initialized');
  const registry = initDashboardTerminalSessions({} as never);
  expect(getFromDashboard()).toBe(registry);
  expect(getFromTerminal()).toBe(registry);
});
