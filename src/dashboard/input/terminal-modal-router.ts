// Compatibility entry for dashboard-owned consumers. The routing policy is
// shared with the standalone Next TUI from src/terminal.
export {
  createTerminalModalRouter,
  terminalModalRouter,
  type KeyRouteResult,
  type TerminalModalRouter,
} from '../../terminal/terminal-modal-router.js';
