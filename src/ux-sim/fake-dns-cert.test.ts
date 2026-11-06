import { describe, expect, it } from 'bun:test';
import { withSimClock } from './fake-clock.js';
import { loadMockScenarioCatalog, renderMockScenarioDeviceMarkdownTable } from './mock-scenario-catalog.js';
import {
  createFakeDnsCert,
  createFakeDnsCertContractPort,
  FAKE_DNS_CERT_CONFIRMED_RESERVED_APP_WORDS,
  fakeDnsCertReservedWordContractCases,
  fakeDnsCertContractCases,
  fakeDnsCertNameRuleCases,
  isFakeDnsCertNameAllowed,
  runFakeDnsCertContractMatrix,
} from './fake-dns-cert.js';

const EPOCH = Date.parse('2026-11-05T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

async function settleAt<T>(operation: () => Promise<T>, clock: { tick(ms: number): void }, ms: number): Promise<T> {
  const pending = operation();
  await Promise.resolve();
  clock.tick(ms);
  return pending;
}
function advanceClock(clock: { tick(ms: number): void }, ms: number): void {
  while (ms > 0) {
    const step = Math.min(ms, 2_000_000_000);
    clock.tick(step);
    ms -= step;
  }
}

describe.serial('SIM-FAKE-DNS-CERT', () => {
  it('matches one wildcard label and keeps one relay record for 100 app registrations', () => {
    const device = createFakeDnsCert();
    expect(device.zone.records).toEqual([{ name: '*.elanous.app', type: 'CNAME', value: 'relay-edge.elanous.net' }]);
    expect(device.zone.nameservers.length).toBeGreaterThan(0);
    expect(device.zone.soa).toBeDefined();
    expect(device.matchesWildcard('notes--alice.elanous.app')).toBe(true);
    expect(device.matchesWildcard('x.notes--alice.elanous.app')).toBe(false);
    for (let index = 0; index < 100; index += 1) device.registerApp(`app${index}--alice.elanous.app`);
    expect(device.counters.wildcardRecordWrites).toBe(1);
    expect(device.counters.acmeTxtWrites).toBe(0);
  });

  it('isolates per-device zones, applications, counters, and certificates', async () => {
    const first = createFakeDnsCert();
    const second = createFakeDnsCert();
    first.registerApp('notes--alice.elanous.app');
    expect(first.apps()).toHaveLength(1);
    expect(second.apps()).toHaveLength(0);
    expect(first.counters.wildcardRecordWrites).toBe(1);
    expect(second.counters.wildcardRecordWrites).toBe(1);
    await first.issueCertificate();
    expect(first.certificate()).toBeDefined();
    expect(second.certificate()).toBeUndefined();
  });

  it('keeps internal certificate state isolated from mutations to returned certificates', async () => {
    await withSimClock(EPOCH, async (clock) => {
      const device = createFakeDnsCert({ certificateLifetimeMs: 90 * DAY });
      const pending = device.issueCertificate();
      await Promise.resolve();
      clock.tick(0);
      const issued = await pending;
      if (issued.status !== 'issued') throw new Error('initial certificate issuance unexpectedly failed');
      const original = device.certificate();
      if (!original) throw new Error('issued certificate was not retained');

      (issued.certificate as { expiresAt: number }).expiresAt = EPOCH;
      (issued.certificate.names as unknown as string[])[0] = 'tampered.example';
      const exposed = device.certificate();
      expect(exposed).toEqual(original);
      if (!exposed) throw new Error('internal certificate was not retained');
      (exposed as { expiresAt: number }).expiresAt = EPOCH;
      expect(device.certificate()).toEqual(original);

      advanceClock(clock, 60 * DAY - 1);
      expect(await device.renewIfDue()).toMatchObject({ status: 'not-due' });
      clock.tick(1);
      const renewal = device.renewIfDue();
      await Promise.resolve();
      clock.tick(0);
      expect(await renewal).toMatchObject({ status: 'issued' });
    });
  });

  it('issues DNS-01 and observes TXT propagation independently', async () => {
    await withSimClock(EPOCH, async (clock) => {
      const device = createFakeDnsCert({ txtPropagationDelayMs: 25, propagationTimeoutMs: 30 });
      const result = await settleAt(() => device.issueCertificate(), clock, 25) as { status: string; certificate?: { names: string[]; issuedAt: number } };
      expect(result).toMatchObject({ status: 'issued', certificate: { names: ['*.elanous.app'], issuedAt: EPOCH + 25 } });
      expect(device.counters.acmeTxtWrites).toBe(1);
    });
  });

  it('keeps the latest concurrent issuance result when an older slow request completes last', async () => {
    await withSimClock(EPOCH, async (clock) => {
      const device = createFakeDnsCert({ txtPropagationDelayMs: 30 });
      const firstPending = device.issueCertificate();
      await Promise.resolve();
      device.configure({ txtPropagationDelayMs: 0 });
      const secondPending = device.issueCertificate();
      clock.tick(0);
      const second = await secondPending;
      clock.tick(30);
      const first = await firstPending;
      expect(first).toMatchObject({ status: 'issued' });
      expect(second).toMatchObject({ status: 'issued' });
      if (second.status !== 'issued') throw new Error('second concurrent issuance unexpectedly failed');
      expect(device.certificate()).toEqual(second.certificate);
      expect(device.certificate()?.serial).toBe(second.certificate.serial);
    });
  });

  it('stores an earlier in-flight success when a later request fails (CAA, limit, or propagation timeout)', async () => {
    for (const later of [{ caaAllowed: false }, { issuanceLimit: 1 }, { txtPropagationDelayMs: 11, propagationTimeoutMs: 10 }] as const) {
      await withSimClock(EPOCH, async (clock) => {
        const device = createFakeDnsCert({ txtPropagationDelayMs: 30 });
        const firstPending = device.issueCertificate();
        await Promise.resolve();
        device.configure(later);
        const secondPending = device.issueCertificate();
        advanceClock(clock, 11);
        const second = await secondPending;
        expect(second, JSON.stringify(later)).toMatchObject({ status: 'failed' });
        clock.tick(30);
        const first = await firstPending;
        if (first.status !== 'issued') throw new Error('earlier issuance unexpectedly failed');
        expect(first.superseded).toBeUndefined();
        expect(device.certificate()).toEqual(first.certificate);
      });
    }
  });

  it('marks an older success that completes after a newer stored success as superseded', async () => {
    await withSimClock(EPOCH, async (clock) => {
      const device = createFakeDnsCert({ txtPropagationDelayMs: 30 });
      const firstPending = device.issueCertificate();
      await Promise.resolve();
      device.configure({ txtPropagationDelayMs: 0 });
      const second = await settleAt(() => device.issueCertificate(), clock, 0);
      clock.tick(30);
      const first = await firstPending;
      expect(first).toMatchObject({ status: 'issued', superseded: true });
      expect(second).toMatchObject({ status: 'issued' });
      if (second.status !== 'issued') throw new Error('second issuance unexpectedly failed');
      expect(second.superseded).toBeUndefined();
      expect(device.certificate()).toEqual(second.certificate);
    });
  });

  it('accepts an injected reserved-word policy beyond the confirmed floor', () => {
    expect(isFakeDnsCertNameAllowed('blog--alice.elanous.app')).toBe(true);
    expect(isFakeDnsCertNameAllowed('blog--alice.elanous.app', [...FAKE_DNS_CERT_CONFIRMED_RESERVED_APP_WORDS, 'blog'])).toBe(false);
    expect(isFakeDnsCertNameAllowed('www--alice.elanous.app', [])).toBe(true);
  });

  it('pins delay and timeout per request when configure changes during successful propagation', async () => {
    await withSimClock(EPOCH, async (clock) => {
      const device = createFakeDnsCert({ txtPropagationDelayMs: 25, propagationTimeoutMs: 30 });
      const pending = device.issueCertificate();
      device.configure({ txtPropagationDelayMs: 100, propagationTimeoutMs: 0 });
      clock.tick(25);
      expect(await pending).toMatchObject({ status: 'issued' });
    });
  });

  it('pins delay and timeout per request when configure changes during timed-out propagation', async () => {
    await withSimClock(EPOCH, async (clock) => {
      const device = createFakeDnsCert({ txtPropagationDelayMs: 31, propagationTimeoutMs: 30 });
      const pending = device.issueCertificate();
      device.configure({ txtPropagationDelayMs: 0, propagationTimeoutMs: 100 });
      clock.tick(30);
      expect(await pending).toMatchObject({ status: 'failed', code: 'propagation-timeout' });
    });
  });

  it('returns a timeout failure card while preserving the existing certificate', async () => {
    await withSimClock(EPOCH, async (clock) => {
      const device = createFakeDnsCert({ propagationTimeoutMs: 30, issuanceLimit: 3 });
      const first = await settleAt(() => device.issueCertificate(), clock, 0);
      if (first.status !== 'issued') throw new Error('initial certificate issuance unexpectedly failed');
      device.configure({ txtPropagationDelayMs: 31 });
      const pending = device.renewCertificate();
      await Promise.resolve();
      clock.tick(30);
      expect(await pending).toMatchObject({ status: 'failed', code: 'propagation-timeout' });
      expect(device.certificate()).toEqual(first.certificate);
    });
  });

  it('rejects CAA and issuance limits without replacing a prior certificate', async () => {
    const caa = createFakeDnsCert({ caaAllowed: false });
    expect(await caa.issueCertificate()).toMatchObject({ status: 'failed', code: 'caa-rejected' });
    const limited = createFakeDnsCert({ issuanceLimit: 1 });
    const first = await limited.issueCertificate();
    if (first.status !== 'issued') throw new Error('initial certificate issuance unexpectedly failed');
    expect(await limited.renewCertificate()).toMatchObject({ status: 'failed', code: 'issuance-limit' });
    expect(limited.certificate()).toEqual(first.certificate);
  });

  it('renews exactly at the 30-day boundary and is not due immediately before it', async () => {
    await withSimClock(EPOCH, async (clock) => {
      const device = createFakeDnsCert({ certificateLifetimeMs: 90 * DAY });
      const first = await settleAt(() => device.issueCertificate(), clock, 0) as { status: string };
      if (first.status !== 'issued') throw new Error('initial certificate issuance unexpectedly failed');
      advanceClock(clock, 60 * DAY - 1);
      expect(await device.renewIfDue()).toMatchObject({ status: 'not-due' });
      clock.tick(1);
      const renewal = device.renewIfDue();
      await Promise.resolve();
      clock.tick(0);
      expect(await renewal).toMatchObject({ status: 'issued' });
    });
  });

  it('passes every literal name expectation through the name-validator port', () => {
    for (const row of fakeDnsCertNameRuleCases) {
      expect(isFakeDnsCertNameAllowed(row.hostname), row.name).toBe(row.expected);
    }
    expect(fakeDnsCertNameRuleCases.filter((row) => !row.allowed).every((row) => !row.expected)).toBe(true);
  });

  it('executes every named DNS, certificate, renewal, and name-rule contract case through a port', async () => {
    const actual = await runFakeDnsCertContractMatrix(createFakeDnsCertContractPort());
    expect(fakeDnsCertContractCases).toHaveLength(actual.length);
    expect(actual).toEqual(fakeDnsCertContractCases.map((row) => row.expected));
  });

  it('keeps reserved words out of the required matrix and runs them only through an injected policy', async () => {
    expect(fakeDnsCertContractCases.some((row) => row.name.includes('reserved app word'))).toBe(false);
    const permissive = await runFakeDnsCertContractMatrix(createFakeDnsCertContractPort({ reservedAppWords: [] }));
    expect(permissive).toEqual(fakeDnsCertContractCases.map((row) => row.expected));
    const policy = [...FAKE_DNS_CERT_CONFIRMED_RESERVED_APP_WORDS, 'blog'];
    const policyCases = fakeDnsCertReservedWordContractCases(policy);
    expect(policyCases).toHaveLength(policy.length);
    expect(await runFakeDnsCertContractMatrix(createFakeDnsCertContractPort({ reservedAppWords: policy }), policyCases))
      .toEqual(policyCases.map((row) => row.expected));
    expect(await runFakeDnsCertContractMatrix(createFakeDnsCertContractPort({ reservedAppWords: [] }), policyCases))
      .toEqual(policyCases.map(() => true));
  });

  it('registers exactly one catalog device in id order with real module and test paths', () => {
    const catalog = loadMockScenarioCatalog();
    const entries = catalog.devices.filter((entry) => entry.id === 'fake-dns-cert');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.implementation).toContain('src/ux-sim/fake-dns-cert.ts');
    expect(entries[0]?.tests).toContain('src/ux-sim/fake-dns-cert.test.ts');
    const ids = catalog.devices.map((entry) => entry.id);
    const index = ids.indexOf('fake-dns-cert');
    expect(ids[index - 1]).toBe('fake-clock');
    expect(ids[index + 1]).toBe('fake-ssh');
    const generatedRows = renderMockScenarioDeviceMarkdownTable(catalog);
    expect(generatedRows.join('\n')).toContain('fake-dns-cert');
    expect(generatedRows.join('\n')).toContain('src/ux-sim/fake-dns-cert.test.ts');
  });
});
