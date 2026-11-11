import { expect, test } from 'bun:test';
import { SERVICE_KEY_CATALOG } from './service-key-catalog.js';
import { buildCredentialInventory } from '../cli/cred-cli.js';
import { createTossDeclarations } from '../graph-runner/capability-providers/market-data/toss.js';
import { createEodhdDeclarations } from '../graph-runner/capability-providers/market-data/eodhd.js';
import { createTwelveDataDeclarations, createFdsDeclarations } from '../graph-runner/capability-providers/market-data/omni-sources.js';
import { createKisDeclarations } from '../graph-runner/capability-providers/market-data/kis.js';
import { createKrxDeclarations } from '../graph-runner/capability-providers/market-data/krx.js';

const marketSlots = [
  ['toss', ['TOSSINVEST_CLIENT_ID', 'TOSSINVEST_CLIENT_SECRET', 'TOSSINVEST_ACCOUNT_SEQ', 'TOSSINVEST_BASE_URL'], ['cred:toss.client_id', 'cred:toss.client_secret', 'cred:toss.account_seq', 'cred:toss.base_url']],
  ['eodhd', ['EODHD_API_KEY'], ['cred:eodhd.api_key']],
  ['twelvedata', ['TWELVEDATA_API_KEY'], ['cred:twelvedata.api_key']],
  ['fds', ['FDS_API_KEY'], ['cred:fds.api_key']],
  ['kis', ['KIS_APP_KEY', 'KIS_APP_SECRET', 'KIS_ACCOUNT'], ['cred:kis.app_key', 'cred:kis.app_secret', 'cred:kis.account']],
  ['krx', ['KRX_API_KEY'], ['cred:krx.api_key']],
] as const;

test('market credential catalog lists every read-only adapter slot by its runtime secret name', () => {
  for (const [id, envNames, storeIds] of marketSlots) {
    const entry = SERVICE_KEY_CATALOG.find((item) => item.id === id);
    expect(entry, id).toBeDefined();
    expect(entry?.kind).toBe('api-key');
    expect(entry?.envNames).toEqual(envNames);
    expect(entry?.storeIds).toEqual(storeIds);
    expect(entry?.setupUrl).toStartWith('https://');
    expect(entry?.verification).toContain('상태 코드만');
    expect(entry?.appAttachable).not.toBe(true);
  }
  const names = marketSlots.flatMap(([, , storeIds]) => storeIds);
  expect(new Set(names).size).toBe(names.length);
  expect(names.join(',')).not.toMatch(/order/i);
  expect(marketSlots.flatMap(([, envNames]) => envNames)).toEqual(expect.arrayContaining([
    'FDS_API_KEY', 'TWELVEDATA_API_KEY', 'KIS_APP_KEY', 'KIS_APP_SECRET', 'KIS_ACCOUNT', 'KRX_API_KEY',
    'TOSSINVEST_CLIENT_ID', 'TOSSINVEST_CLIENT_SECRET', 'TOSSINVEST_ACCOUNT_SEQ', 'TOSSINVEST_BASE_URL',
  ]));
});

test('credential inventory simulation reports market slot names without reading values', () => {
  const storedIds = marketSlots.flatMap(([, , storeIds]) => storeIds);
  const rows = buildCredentialInventory(SERVICE_KEY_CATALOG, storedIds, {});
  for (const [id, , storeIds] of marketSlots) {
    const row = rows.find((item) => item.id === id);
    expect(row?.status).toBe('present');
    expect(row?.source).toEqual(storeIds.map((slot) => `eln-secret:${slot}`));
    expect(row?.transfer).toBe('encrypted-bundle');
  }
  expect(rows.filter((item) => item.type === 'unknown')).toEqual([]);
});

test('catalog slot names equal the market provider declarations actually consumed at runtime', () => {
  const declarations = [
    ['toss', createTossDeclarations()], ['eodhd', createEodhdDeclarations()],
    ['twelvedata', createTwelveDataDeclarations()], ['fds', createFdsDeclarations()],
    ['kis', createKisDeclarations()], ['krx', createKrxDeclarations()],
  ] as const;
  for (const [id, providers] of declarations) {
    const catalog = SERVICE_KEY_CATALOG.find((item) => item.id === id);
    const adapterRefs = [...new Set(providers.flatMap((provider) => provider.secretRefs ?? []))];
    const accountIdentifierSlots = id === 'toss' ? ['cred:toss.account_seq', 'cred:toss.base_url'] : id === 'kis' ? ['cred:kis.account'] : [];
    expect(catalog?.storeIds, id).toEqual([...adapterRefs, ...accountIdentifierSlots]);
    expect(accountIdentifierSlots.every((slot) => !adapterRefs.includes(slot))).toBe(true);
  }
});
