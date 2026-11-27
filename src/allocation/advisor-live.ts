// ALLOCATION-BUDGET advisor inputs from what the guardian already measured (LLM 0 · no probes here): the last resident pulse
// snapshot (<instance>/loop-agents/guardian/last-pulse.json — hosts · supervisors) ⊕ the usage snapshot (accounts).
import type { AdvisorAccount, AdvisorHost, AdvisorRoute } from './advisor.js';
import type { AllocUsageSnapshot } from './fold.js';

export function liveAdvisorWorld(snap: AllocUsageSnapshot | null, stateRoot?: string): { hosts: AdvisorHost[]; routes: AdvisorRoute[]; accounts: AdvisorAccount[] } {
  const accounts = (snap?.accounts ?? []).map(a => ({ provider: a.provider, account: a.account, status: a.status }));
  try {
    const { effectiveInstanceRoot } = require('../instance/resolve.js') as typeof import('../instance/resolve.js');
    const { readPulseSnapshot } = require('../guardian-agent/world.js') as typeof import('../guardian-agent/world.js');
    const { isPaid } = require('../guardian-agent/hosts.js') as typeof import('../guardian-agent/hosts.js');
    const world = readPulseSnapshot(stateRoot ?? effectiveInstanceRoot())?.world ?? [];
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const hosts = world.filter(e => e.kind === 'host').map((e): AdvisorHost => ({ host: e.id, reachable: e.status !== 'unreachable', load1: num(e.facts.load1), ncpu: num(e.facts.ncpu),
      paid: isPaid(e.id), ...(typeof e.facts.why === 'string' ? { why: e.facts.why } : {}) }));
    const routes = world.filter(e => e.kind === 'supervisor' && (e.status === 'dead' || e.status === 'broken'))
      .map((e): AdvisorRoute => ({ id: e.id, healthy: false, owner: e.owner ?? 'GUARDIAN', why: `supervisor ${e.status}` }));
    return { hosts, routes, accounts };
  } catch { return { hosts: [], routes: [], accounts }; }
}
