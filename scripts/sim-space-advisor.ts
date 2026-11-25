// SPACE-ADVISOR sim — `bun scripts/sim-space-advisor.ts [--pick-rate 0.5]` · TC's 11-25 evening ✋ mix.
import { runAdvisorSim, tcEvening } from '../src/steward/space/advisor-sim.js';
const i = process.argv.indexOf('--pick-rate');
const rate = i > 0 ? Number(process.argv[i + 1]) : 0;
const r = runAdvisorSim(tcEvening(), { tcPickRate: rate });
console.log(JSON.stringify(r));
console.log(`✋ ${r.total} → steward ${r.steward} · advisor-resolved ${r.resolved} · cards to TC ${r.recommended} (max/30m ${r.reachTcPer30m}) · TC-picked ${r.picked} · auto ${r.auto} · to OP ${r.reachOp}`);
