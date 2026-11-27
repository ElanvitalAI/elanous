// `eln world facts get <key>` — one fact by key, for ops scripts (seat-state tools) that must not carry literals.
//   hosts                       every host fact (json)
//   hosts.<purpose>             routable hosts for a purpose (space-separated · --json array)
//   host.<name>                 one host fact (json)
//   review | review.<field>     review routing policy
//   caps | caps.<name>          usage caps / thresholds
//   expiry.<name>               ISO expiry · expiry.<name>.epoch = seconds
//   accounts.<provider>         account names · llm-accounts = fuel rows
//   retryHosts                  tsc-timeout re-run order
//   creditAccounts[.<provider>] accounts allowed to spend paid credits (absent provider = unrestricted)
import { hostsFor, isRoutePurpose, ROUTE_PURPOSES } from './route.js';
import type { ResourceFacts } from './types.js';

export type FactValue = string | number | boolean | null | readonly unknown[] | Record<string, unknown>;

/** Pure: the value for a key, or undefined when the key is unknown. */
export function factGet(facts: ResourceFacts, key: string): FactValue | undefined {
  const [head, ...rest] = key.split('.');
  const tail = rest.join('.');
  switch (head) {
    case 'hosts':
      if (!tail) return facts.hosts as unknown as readonly unknown[];
      return isRoutePurpose(tail) ? hostsFor(tail, { facts }) : undefined;
    case 'host': return (facts.hosts.find(h => h.host === tail) as unknown as Record<string, unknown>) ?? undefined;
    case 'review':
      if (!tail) return facts.review as unknown as Record<string, unknown>;
      return (facts.review as unknown as Record<string, FactValue>)[tail];
    case 'caps': return tail ? facts.caps[tail] : facts.caps as unknown as Record<string, unknown>;
    case 'expiry': {
      const [name, fmt] = tail.endsWith('.epoch') ? [tail.slice(0, -'.epoch'.length), 'epoch'] : [tail, 'iso'];
      const v = facts.expiries[name!];
      if (!v) return undefined;
      return fmt === 'epoch' ? Math.floor(Date.parse(v) / 1000) : v;
    }
    case 'expiries': return facts.expiries as Record<string, unknown>;
    case 'accounts': return tail ? facts.accountNames[tail] : facts.accountNames as unknown as Record<string, unknown>;
    case 'llm-accounts': return facts.accounts as unknown as readonly unknown[];
    case 'retryHosts': return facts.retryHosts;
    case 'creditAccounts': return tail ? facts.creditAccounts[tail] : facts.creditAccounts as unknown as Record<string, unknown>;
    default: return undefined;
  }
}

export const FACT_KEYS_HELP = `hosts · hosts.<${ROUTE_PURPOSES.join('|')}> · host.<name> · review[.field] · caps[.name] · expiry.<name>[.epoch] · accounts[.<provider>] · llm-accounts · retryHosts · creditAccounts[.<provider>]`;

/** Shell form: arrays space-separated, scalars as-is, objects as JSON. */
export function formatFact(v: FactValue): string {
  if (Array.isArray(v)) return v.every(x => typeof x !== 'object') ? v.join(' ') : JSON.stringify(v);
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
