import { expect, test } from 'bun:test';
import { withSimClock, type SimClock } from './fake-clock.js';
import {
  APP_TRAFFIC_CONTRACT_CASES,
  createFakeAppTraffic,
  runAppTrafficContractCase,
  runAppTrafficContractMatrix,
  type AppTrafficLedgerEntry,
  type AppTrafficContractPortFactory,
} from './fake-app-traffic.js';

test('SIM-APPTRAFFIC shared contract matrix measures caps, windows, kill switch, and app isolation', async () => {
  await withSimClock(new Date('2026-01-01T00:00:00.000Z'), async (clock: SimClock) => {
    const factory: AppTrafficContractPortFactory = {
      create(options) { return createFakeAppTraffic({ ...options, now: () => clock.now() }); },
      advanceTime(ms) { clock.tick(ms); },
    };
    const results = runAppTrafficContractMatrix(factory);
    expect(results.map(({ id, passed }) => ({ id, passed }))).toEqual(
      APP_TRAFFIC_CONTRACT_CASES.map(({ id }) => ({ id, passed: true })),
    );
    for (const result of results) expect(result.actual).toEqual(result.expected);
    expect(clock.pendingTimers()).toBe(0);
  });
});

test('SIM-APPTRAFFIC contract comparison ignores object property order', () => {
  const byteAccounting = APP_TRAFFIC_CONTRACT_CASES.find(({ id }) => id === 'byte-accounting')!;
  const factory: AppTrafficContractPortFactory = {
    create(options) {
      const port = createFakeAppTraffic(options);
      return {
        ...port,
        usage(appSlug) {
          const usage = port.usage(appSlug);
          return {
            totalBytes: usage.totalBytes,
            responseBytes: usage.responseBytes,
            requestBytes: usage.requestBytes,
            windowStartedAt: usage.windowStartedAt,
          };
        },
      };
    },
    advanceTime() {},
  };
  expect(runAppTrafficContractCase(byteAccounting, factory).passed).toBe(true);
});

test('SIM-APPTRAFFIC contract comparison rejects missing sparse array entries', () => {
  const byteAccounting = APP_TRAFFIC_CONTRACT_CASES.find(({ id }) => id === 'byte-accounting')!;
  const factory: AppTrafficContractPortFactory = {
    create(options) {
      const port = createFakeAppTraffic(options);
      return {
        ...port,
        ledger(): readonly AppTrafficLedgerEntry[] { return new Array<AppTrafficLedgerEntry>(1); },
      };
    },
    advanceTime() {},
  };
  expect(runAppTrafficContractCase(byteAccounting, factory).passed).toBe(false);
});
