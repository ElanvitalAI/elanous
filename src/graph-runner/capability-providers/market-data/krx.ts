import type { GraphCapabilityProviderDeclaration } from '../../capabilities.js';
import { failed, isoDate, object, responseJson } from './stock-common.js';
import type { StockFetch } from './stock-common.js';
import { marketSecretLookup, requiredMarketSecret } from './market-secrets.js';
import type { MarketSecretLookup } from './market-secrets.js';

/** All 14 api_id values from OP's KRX-SPEC-FROM-KR-FLOW-1109.md. */
const ROUTES = [
  ['krx-market', 'sto', 'stk_bydd_trd', 'kr.market.daily@1'],
  ['krx-kosdaq', 'sto', 'ksq_bydd_trd', 'kr.market.daily@1'],
  ['krx-index', 'idx', 'kospi_dd_trd', 'market.index@1'],
  ['krx-kosdaq-index', 'idx', 'kosdaq_dd_trd', 'market.index@1'],
  ['krx-etf', 'etp', 'etf_bydd_trd', 'kr.etp.daily@1'],
  ['krx-etn', 'etp', 'etn_bydd_trd', 'kr.etp.daily@1'],
  ['krx-stock-info', 'sto', 'stk_isu_base_info', 'market.instrument@1', 'KOSPI'],
  ['krx-stock-info', 'sto', 'ksq_isu_base_info', 'market.instrument@1', 'KOSDAQ'],
  ['krx-bond-index', 'idx', 'bon_dd_trd', 'market.index@1'],
  ['krx-deriv-index', 'idx', 'drvprod_dd_trd', 'market.index@1'],
  ['krx-futures', 'drv', 'fut_bydd_trd', 'kr.derivatives.futures@1'],
  ['krx-options', 'drv', 'opt_bydd_trd', 'kr.derivatives.options@1'],
  ['krx-bond', 'bon', 'bnd_bydd_trd', 'kr.bond.daily@1'],
  ['krx-kts', 'bon', 'kts_bydd_trd', 'kr.bond.daily@1'],
] as const;

/** Read-only KRX daily services. The key is a URL query parameter in the source skill, not an HTTP header. */
export function createKrxDeclarations(options: { fetcher?: StockFetch; lookupSecret?: MarketSecretLookup } = {}): readonly GraphCapabilityProviderDeclaration[] {
  const fetcher = options.fetcher ?? fetch;
  const lookup = options.lookupSecret ?? marketSecretLookup;
  return ROUTES.map(([command, category, apiId, contract, board]) => ({
    id: `krx-${apiId.replaceAll('_', '-')}`, provides: [contract], tier: 'free' as const, latency: 1500,
    secretRefs: ['cred:krx.api_key'],
    conditions: { market: 'KR', command, ...(board ? { board } : {}) },
    available: async () => Boolean((await lookup('cred:krx.api_key'))?.trim()),
    guarantees: { sourceAttribution: true },
    invoke: async (context) => {
      try {
        const input = object(context.nodeInput ?? context.input);
        const date = input.date;
        if (input.market !== 'KR' || input.command !== command || !isoDate(date) || (board && input.board !== board))
          throw new Error('invalid_input');
        const params = new URLSearchParams({ AUTH_KEY: await requiredMarketSecret('cred:krx.api_key', lookup),
          basDd: date.replaceAll('-', '') });
        const data = await responseJson(fetcher,
          `https://data-dbg.krx.co.kr/svc/apis/${category}/${apiId}.json?${params}`,
          { signal: AbortSignal.timeout(90_000) });
        if (!Array.isArray(data.OutBlock_1)) throw new Error('invalid_response');
        const rows = data.OutBlock_1.map(object);
        return { ok: true, outcome: 'ok' as const,
          result: { source: 'krx', market: 'KR', command, date, ...(board ? { board } : {}), rows },
          evidence: { source: 'krx', timing: 'end-of-day', approval: 'service-specific' } };
      } catch (error) { return failed(error); }
    },
  }));
}
