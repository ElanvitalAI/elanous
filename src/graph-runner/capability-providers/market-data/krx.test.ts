import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dispatchGraphContract } from '../../capabilities.js';
import type { InProcessHandlerContext } from '../../in-process-registry.js';
import { marketDataRegistry } from './registry.js';
import { createKrxDeclarations } from './krx.js';
import type { StockFetch } from './stock-common.js';

const context = (input: unknown): InProcessHandlerContext => ({
  graphId: 'krx-spec-sim', runId: 'sim', nodeId: 'daily', input, outputs: {},
});
const cases = [
  ['krx-market', 'sto/stk_bydd_trd', 'kr.market.daily@1'],
  ['krx-kosdaq', 'sto/ksq_bydd_trd', 'kr.market.daily@1'],
  ['krx-index', 'idx/kospi_dd_trd', 'market.index@1'],
  ['krx-kosdaq-index', 'idx/kosdaq_dd_trd', 'market.index@1'],
  ['krx-etf', 'etp/etf_bydd_trd', 'kr.etp.daily@1'],
  ['krx-etn', 'etp/etn_bydd_trd', 'kr.etp.daily@1'],
  ['krx-stock-info', 'sto/stk_isu_base_info', 'market.instrument@1', 'KOSPI'],
  ['krx-stock-info', 'sto/ksq_isu_base_info', 'market.instrument@1', 'KOSDAQ'],
  ['krx-bond-index', 'idx/bon_dd_trd', 'market.index@1'],
  ['krx-deriv-index', 'idx/drvprod_dd_trd', 'market.index@1'],
  ['krx-futures', 'drv/fut_bydd_trd', 'kr.derivatives.futures@1'],
  ['krx-options', 'drv/opt_bydd_trd', 'kr.derivatives.options@1'],
  ['krx-bond', 'bon/bnd_bydd_trd', 'kr.bond.daily@1'],
  ['krx-kts', 'bon/kts_bydd_trd', 'kr.bond.daily@1'],
] as const;

test('KRX spec exposes all 14 read-only API IDs with AUTH_KEY query and fixed rows', async () => {
  const paths: string[] = [];
  const fetcher: StockFetch = async (url, init) => {
    const parsed = new URL(url); paths.push(parsed.pathname);
    expect(parsed.host).toBe('data-dbg.krx.co.kr');
    expect(parsed.searchParams.get('AUTH_KEY')).toBe('fixture-key');
    expect(parsed.searchParams.get('basDd')).toBe('20261109');
    expect(init?.method).toBeUndefined();
    expect(init?.signal).toBeDefined();
    return { ok: true, json: async () => ({ OutBlock_1: [{ ISU_CD: '005930', TDD_CLSPRC: '72000' }] }) };
  };
  const providers = createKrxDeclarations({ fetcher, lookupSecret: async () => 'fixture-key' });
  expect(providers).toHaveLength(14);
  const registry = marketDataRegistry(providers);
  for (const [command, path, contract, board] of cases) {
    const input = { market: 'KR', command, date: '2026-11-09', ...(board ? { board } : {}) };
    const response = await dispatchGraphContract(contract, context(input), registry);
    expect(response).toMatchObject({ ok: true, result: { source: 'krx', rows: [{ ISU_CD: '005930' }] } });
    expect(paths.at(-1)).toBe(`/svc/apis/${path}.json`);
    expect(JSON.stringify(response)).not.toContain('fixture-key');
  }
  expect(new Set(paths).size).toBe(14);
});

test('KRX fails closed for missing secret, wrong board and malformed response', async () => {
  const missing = marketDataRegistry(createKrxDeclarations({ lookupSecret: async () => undefined,
    fetcher: async () => { throw new Error('should not fetch'); } }));
  expect(await dispatchGraphContract('kr.market.daily@1', context({ market: 'KR', command: 'krx-market', date: '2026-11-09' }), missing))
    .toMatchObject({ ok: false, error: 'unprovided' });
  const registry = marketDataRegistry(createKrxDeclarations({ lookupSecret: async () => 'fixture-key',
    fetcher: async () => ({ ok: true, json: async () => ({ unexpected: [] }) }) }));
  expect(await dispatchGraphContract('market.instrument@1', context({ market: 'KR', command: 'krx-stock-info', date: '2026-11-09' }), registry))
    .toMatchObject({ ok: false, error: 'unprovided' });
  const failed = await dispatchGraphContract('kr.market.daily@1', context({ market: 'KR', command: 'krx-market', date: '2026-11-09' }), registry);
  expect(failed).toMatchObject({ ok: false, error: 'contract-exhausted', evidence: {
    attempts: [{ provider: 'krx-stk-bydd-trd', reason: 'provider_failed' }],
  } });
  expect(JSON.stringify(failed)).not.toContain('fixture-key');
});

test('KRX adapter has no order or account path or credential reference', () => {
  const source = readFileSync(new URL('krx.ts', import.meta.url), 'utf8');
  expect(source).not.toMatch(/\/(?:api\/v1\/)?(?:orders?|accounts?|holdings?|buying-power)(?:[/?'"`]|$)/i);
  expect(source).not.toMatch(/cred:(?:kis|toss)\.(?:account|account_seq)/);
});
