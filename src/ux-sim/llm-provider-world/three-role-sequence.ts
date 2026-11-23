// LLM-AUTO-PROVIDER-E2E: three synthetic consumers use the real call gate and settle path.
// This scenario does not claim the hand/TA/reviewer entry points are wired to this gate.
import { gateLlmCall, settleLlmCall, type LlmCallGateDeps, type LlmCallTag } from '../../oauth/llm-call-gate.js';
import { createInMemoryGuardStore } from '../../oauth/llm-spend-guard.js';
import { createInMemoryReservationLedger } from '../../oauth/llm-spend-reservation.js';
import type { LlmSpendLedgerEntry, LlmSpendPolicyRole } from '../../nexus/llm-spend-policy/types.js';
import { createLlmProviderWorld } from './world.js';
import { exhaustAllSubscriptions, policyWith } from './scenarios.js';

const START = '2026-11-20T00:00:00.000Z';
const RESET = '2026-11-20T05:00:00.000Z';
const MODEL = 'openrouter/moonshotai/kimi-k3';
const ROLES = ['hand-seat', 'ta-child', 'review'] as const;
type Role = (typeof ROLES)[number];
type Stage = 'default' | 'team' | 'credit' | 'reset';
export interface ThreeRoleRow { role: Role; stage: Stage; row: string; provider: string; status: 'ok' | 'stop' }

/** All devices, clock, leases and money are synthetic. Opting TA into credit is deliberate and explicit. */
export async function runThreeRoleSequence(taCreditOk: boolean): Promise<{ rows: ThreeRoleRow[]; ledger: LlmSpendLedgerEntry[]; tags: LlmCallTag[] }> {
  const world = createLlmProviderWorld({ startIso: START, balanceUsd: 100 });
  const policy = policyWith({ creditModels: [MODEL], roles: {
    'hand-seat': { creditOk: true }, 'ta-child': { creditOk: taCreditOk }, review: { creditOk: true },
  } });
  const ledger: LlmSpendLedgerEntry[] = [], tags: LlmCallTag[] = [], rows: ThreeRoleRow[] = [];
  const deps: LlmCallGateDeps = { readPolicy: async () => policy, observers: [() => world.states()],
    now: () => world.clock.now(), memory: createInMemoryGuardStore(), reservations: createInMemoryReservationLedger(),
    appendLedger: entry => { ledger.push(entry); }, recordUsageTag: tag => { tags.push(tag); } };
  const devices = { 'codex-default': world.codex.default, 'codex-team': world.codex.team,
    'codex-third': world.codex.third, 'claude-code-sub': world.claude.sub1, 'claude-acp': world.acp, openrouter: world.openrouter };
  const stage = async (name: Stage) => {
    for (const role of ROLES) {
      const decision = await gateLlmCall({ role: role as LlmSpendPolicyRole, location: 'host', models: [MODEL], estimateUsd: 1 }, deps);
      if (decision.outcome !== 'go') { rows.push({ role, stage: name, row: decision.outcome, provider: '', status: 'stop' }); continue; }
      const device = devices[decision.row as keyof typeof devices];
      if (!device) throw new Error(`unexpected simulated row ${decision.row}`);
      const response = device.call({ role, model: decision.model, estimateUsd: 1 });
      await settleLlmCall(decision.handle, response.ok ? { status: 'ok', actualUsd: response.costUsd ?? 0 } : { status: 'failed' });
      rows.push({ role, stage: name, row: decision.row, provider: decision.provider, status: response.ok ? 'ok' : 'stop' });
    }
  };
  await stage('default');
  world.codex.default.exhaust('five-hour', RESET); await stage('team');
  exhaustAllSubscriptions(world, RESET); world.acp.setAlive(false); await stage('credit');
  world.clock.set(RESET); await stage('reset');
  return { rows, ledger, tags };
}
