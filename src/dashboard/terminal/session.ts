// Compatibility path for classic dashboard callers. The singleton lives in
// terminal/session-access so non-dashboard consumers can use it directly.
export {
  initDashboardTerminalSessions,
  getDashboardTerminalSessions,
  _resetDashboardTerminalSessionsForTesting,
} from '../../terminal/session-access.js';
