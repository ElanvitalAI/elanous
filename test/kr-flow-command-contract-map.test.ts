import { expect, test } from 'bun:test';
import { createDefaultMarketDataRegistry } from '../src/graph-runner/capability-providers/market-data/registry.js';
import { createKrxDeclarations } from '../src/graph-runner/capability-providers/market-data/krx.js';

/** OP's kr-flow command inventory: 10 KIS command names, excluding aliases and the separate futures quote. */
const kisCommands = [
  ['foreign-net', 'kr.flow.foreign@1'],
  ['investor', 'kr.flow.investor@1'],
  ['investor-time', 'kr.flow.investor-time@1'],
  ['estimate', 'kr.flow.estimate@1'],
  ['price', 'market.quote@1'],
  ['ohlcv', 'market.ohlcv@1'],
  ['market-flow', 'kr.flow.market@1'],
  ['investor-detail', 'kr.flow.investor-detail@1'],
  ['frgn-institution', 'kr.flow.intraday@1'],
  ['short-sale', 'kr.short-sale@1'],
] as const;

/** The 14 distinct KRX api_id values in OP's KRX-SPEC-FROM-KR-FLOW-1109.md. */
const krxServices = [
  ['krx-market', 'stk_bydd_trd', 'kr.market.daily@1'],
  ['krx-kosdaq', 'ksq_bydd_trd', 'kr.market.daily@1'],
  ['krx-index', 'kospi_dd_trd', 'market.index@1'],
  ['krx-kosdaq-index', 'kosdaq_dd_trd', 'market.index@1'],
  ['krx-etf', 'etf_bydd_trd', 'kr.etp.daily@1'],
  ['krx-etn', 'etn_bydd_trd', 'kr.etp.daily@1'],
  ['krx-stock-info', 'stk_isu_base_info', 'market.instrument@1'],
  ['krx-stock-info', 'ksq_isu_base_info', 'market.instrument@1'],
  ['krx-bond-index', 'bon_dd_trd', 'market.index@1'],
  ['krx-deriv-index', 'drvprod_dd_trd', 'market.index@1'],
  ['krx-futures', 'fut_bydd_trd', 'kr.derivatives.futures@1'],
  ['krx-options', 'opt_bydd_trd', 'kr.derivatives.options@1'],
  ['krx-bond', 'bnd_bydd_trd', 'kr.bond.daily@1'],
  ['krx-kts', 'kts_bydd_trd', 'kr.bond.daily@1'],
] as const;

test('KIS 10-command table maps every name to a registered read-only capability contract', () => {
  const registry = createDefaultMarketDataRegistry();
  expect(kisCommands).toHaveLength(10);
  expect(new Set(kisCommands.map(([name]) => name)).size).toBe(10);
  for (const [name, contract] of kisCommands) {
    expect(name).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
    expect(registry.contracts[contract], `${name} -> ${contract}`).toBeDefined();
  }
  // Mapping-only contracts remain fail-closed until a read-only KIS adapter implements each one.
  const implemented = new Set(registry.providers.filter((provider) => provider.id.startsWith('kis-'))
    .flatMap((provider) => provider.provides));
  expect([...implemented].sort()).toEqual(['market.kr-flow@1', 'market.ohlcv@1', 'market.quote@1']);
});

test('KRX 14-api-id table maps every source route to exactly one registered declaration and contract', () => {
  const registry = createDefaultMarketDataRegistry();
  const providers = createKrxDeclarations();
  expect(krxServices).toHaveLength(14);
  expect(new Set(krxServices.map(([, apiId]) => apiId)).size).toBe(14);
  expect(providers).toHaveLength(14);
  for (const [command, apiId, contract] of krxServices) {
    const provider = providers.find((item) => item.id === `krx-${apiId.replaceAll('_', '-')}`);
    expect(provider, apiId).toBeDefined();
    expect(provider?.provides).toEqual([contract]);
    expect(provider?.conditions?.command).toBe(command);
    expect(registry.contracts[contract], contract).toBeDefined();
  }
  expect(providers.filter((item) => item.conditions?.command === 'krx-stock-info').map((item) => item.conditions?.board).sort())
    .toEqual(['KOSDAQ', 'KOSPI']);
});
