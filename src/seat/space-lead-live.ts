// SPACE-LEAD-HUMAN — live wiring: user config `federation.humanLead` (the switch · default off) ⊕ federation.yaml `lead:`
// → the HumanLeadPort the ✋ sweep uses. The channel is the decision ledger: its existing Telegram / PWA card path shows the
// card with resolve / reject / escalate buttons, and a tap is recorded there before the sweep executes it.

import { homedir } from 'node:os';
import type { DecidedLeadCard, HumanLeadPort } from '../msg/hand-raise-ladder.js';
import { humanLeadCard, humanLeadMsgId, humanLeadRef, resolveHumanLeads, type HumanLeadConfig, type SpaceLeadDecl } from './space-lead.js';

const DECIDED_WINDOW_MS = 24 * 60 * 60_000;

/** The configured human leads (empty when the switch is off or nothing reads). */
export function liveHumanLeads(deps: { cwd?: string; home?: string } = {}): ReturnType<typeof resolveHumanLeads> {
  let config: HumanLeadConfig | null = null;
  try {
    const { getUserConfig } = require('../user-config/reader.js') as typeof import('../user-config/reader.js');
    const federation = getUserConfig().raw?.federation as { humanLead?: HumanLeadConfig } | undefined;
    config = federation?.humanLead ?? null;
  } catch { config = null; }
  if (config?.enabled !== true) return new Map();
  const declared: { coordinator: string; lead?: SpaceLeadDecl }[] = [];
  try {
    const { readWorkspaceFile } = require('../els/workspace-config.js') as typeof import('../els/workspace-config.js');
    const decl = readWorkspaceFile(deps.cwd ?? process.cwd(), deps.home ?? homedir());
    if (decl.path && decl.config) for (const space of Object.values(decl.config.spaces)) declared.push({ coordinator: space.coordinator, ...(space.lead ? { lead: space.lead } : {}) });
  } catch { /* an unreadable declaration declares nothing */ }
  return resolveHumanLeads({ config, declared });
}

/** The port, or undefined when no space is human-led (the sweep then behaves exactly as before). */
export function liveHumanLeadPort(deps: { cwd?: string; home?: string; stateDir?: string } = {}): HumanLeadPort | undefined {
  const leads = liveHumanLeads(deps);
  if (!leads.size) return undefined;
  const raised = new Set<string>();
  const ledger = () => {
    const { DecisionLedger } = require('../decisions/decision-ledger.js') as typeof import('../decisions/decision-ledger.js');
    return new DecisionLedger(deps.stateDir ? { stateDir: deps.stateDir } : {});
  };
  return {
    leads,
    raiseCard: (hand, lead) => {
      const ref = humanLeadRef(hand.id);
      if (raised.has(ref)) return { decisionId: '', fresh: false };
      const book = ledger();
      const before = book.list({ status: 'all' }).find((e) => e.refs?.includes(ref));
      const entry = before ?? book.raiseOnce(humanLeadCard({ lead, msgId: hand.id, blockedSeat: hand.blockedSeat, reason: hand.reason, body: hand.body }), ref);
      raised.add(ref);
      return { decisionId: entry.id, fresh: !before };
    },
    decided: () => {
      const since = Date.now() - DECIDED_WINDOW_MS;
      const out: DecidedLeadCard[] = [];
      for (const entry of ledger().list({ status: 'decided' })) {
        const msgId = humanLeadMsgId(entry.refs);
        if (!msgId || !entry.decidedAt || Date.parse(entry.decidedAt) < since) continue;
        const via = entry.decidedBy?.kind === 'human' ? entry.decidedBy.via : entry.decidedBy?.kind === 'auto' ? `auto:${entry.decidedBy.agent}` : undefined;
        out.push({ decisionId: entry.id, msgId, ...(entry.choice ? { choice: entry.choice } : {}), ...(entry.note ? { note: entry.note } : {}), ...(via ? { via } : {}) });
      }
      return out;
    },
  };
}
