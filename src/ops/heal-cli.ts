import { join } from 'node:path';
import { resolveSeatStateRoot } from '../loops/msg-wake.js';
import { addItem, listChecklist } from '../release-loop/checklist.js';
import { executeHealAction } from './heal-actions.js';
import { loadHealCard } from './heal-card.js';
import { runHealCard } from './heal-runner.js';

const IMPROVEMENT_VERSION = '0.3.33';

/** Product CLI path: card lookup → bounded built-in actions → ledger → third-hit card improvement. */
export async function runOpsHeal(signal: string): Promise<number> {
  try {
    const root = resolveSeatStateRoot();
    const card = loadHealCard(root, signal);
    const result = await runHealCard(card, {
      ledgerDir: join(root, 'OPS'),
      execute: (action, args) => executeHealAction(root, action, args),
      openImprovement: (repeatedSignal) => {
        const id = `HEAL-CARD-IMPROVE-${repeatedSignal.toUpperCase()}`;
        if (listChecklist(IMPROVEMENT_VERSION).items.some((item) => item.id === id)) return;
        addItem(IMPROVEMENT_VERSION, {
          id, title: `TB card improvement after three ${repeatedSignal} signals`, owner: card.owner,
          priority: 'P1', dispatchKind: 'ops',
        });
      },
    });
    console.log(JSON.stringify(result));
    return result.outcome === 'ready' ? 0 : 2;
  } catch (error) {
    console.error(`ops heal: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
