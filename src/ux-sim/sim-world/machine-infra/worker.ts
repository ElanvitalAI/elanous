import { runHealCard, type HealCard } from '../../../ops/heal-runner.js';

const ledgerDir = process.argv[2];
if (!ledgerDir) throw new Error('heal worker: missing ledger path');
const card: HealCard = {
  signal: 'pregate-load-over', owner: 'RES',
  diagnose: [{ action: 'host.load.read' }],
  repair: [{ action: 'host.load.wait', risk: 'safe', rollback: 'No state changed.' }],
  verify: [{ action: 'host.load.verify' }],
  escalate: { after: 1, message: 'Inspect the host load.' },
};
const result = await runHealCard(card, { ledgerDir, execute: async (action) => ({ ok: true, detail: `injected ${action}` }) });
console.log(JSON.stringify({ pid: process.pid, outcome: result.outcome }));
