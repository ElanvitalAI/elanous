import { expect, test } from 'bun:test';
import { planKisMode, planMarketEnvMigration } from './migrate-omni-market-secrets.js';

test('one-time market migration maps literal env names to credential slots without value output', () => {
  const planned = planMarketEnvMigration([
    'EODHD_API_KEY=fixture-a\nTOSSINVEST_CLIENT_ID=fixture-b\nTOSSINVEST_CLIENT_SECRET=fixture-c\n',
    'export KIS_APP_KEY=fixture-d\nexport KIS_APP_SECRET=fixture-e\n',
    'KRX_API_KEY=fixture-f\nTWELVEDATA_API_KEY=fixture-g\nFDS_API_KEY=fixture-h\n',
  ], new Set());
  expect(Object.keys(planned).sort()).toEqual([
    'cred:eodhd.api_key', 'cred:fds.api_key', 'cred:kis.app_key', 'cred:kis.app_secret',
    'cred:krx.api_key', 'cred:toss.client_id', 'cred:toss.client_secret', 'cred:twelvedata.api_key',
  ]);
  expect(() => planMarketEnvMigration(['EODHD_API_KEY=fixture-a'], new Set(['cred:eodhd.api_key']))).toThrow();
  expect(() => planMarketEnvMigration(['EODHD_API_KEY=$(cat /tmp/key)'], new Set())).toThrow();
});

test('kr-flow .env migration covers all named credentials and KIS mode without making mode a secret', () => {
  const content = 'KIS_APP_KEY=fixture-app\nKIS_APP_SECRET=fixture-secret\nKIS_ACCOUNT=fixture-account\nKIS_MODE=vts\nKRX_API_KEY=fixture-krx\nTOSSINVEST_ACCOUNT_SEQ=fixture-seq\n';
  const planned = planMarketEnvMigration([content], new Set());
  expect(Object.keys(planned).sort()).toEqual([
    'cred:kis.account', 'cred:kis.app_key', 'cred:kis.app_secret', 'cred:krx.api_key', 'cred:toss.account_seq',
  ]);
  expect(planKisMode([content])).toBe('vts');
  expect(JSON.stringify(planned)).not.toContain('KIS_MODE');
  expect(() => planKisMode(['KIS_MODE=unexpected'])).toThrow();
  expect(() => planKisMode(['KIS_MODE=real', 'KIS_MODE=vts'])).toThrow();
});
