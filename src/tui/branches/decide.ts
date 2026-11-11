import { DecisionLedger } from '../../decisions/decision-ledger.js';
import { createDecideSlashHandler } from '../../decisions/decide-slash.js';

/** Each TUI instance owns its handler and numbered-card snapshot. */
export function createNextTuiDecideBranchRoute(ledger: DecisionLedger = new DecisionLedger()): (input: string) => string {
  const handle = createDecideSlashHandler(ledger);
  return (input: string): string => {
    const args = input.trim().replace(/^\/(?:decide|dec)(?:\s+|$)/u, '').trim().split(/\s+/u).filter(Boolean);
    return handle(args);
  };
}
