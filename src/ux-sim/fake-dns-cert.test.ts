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
// Source: local fake-ACME propagation scenarios model a delay longer than the configured simulated timeout.
const CUSTOM_ACME_DELAY_MS = 30;
const CUSTOM_ACME_TIMEOUT_MS = 20;

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
  it('requires app CNAME and owner TXT proof before ACME simulation can issue a custom-domain certificate', async () => {
    const device = createFakeDnsCert();
    device.registerApp('notes--alice.elanous.app');
    const rejected = device.connectCustomDomain({ hostname: 'notes.example.test', appHost: 'notes--alice.elanous.app',
      cnameTarget: 'other--alice.elanous.app', ownerTxt: { name: '_elanous-owner.notes.example.test', value: 'proof-a' }, expectedOwnerProof: 'proof-a' });
    expect(rejected).toMatchObject({ status: 'rejected', reason: 'cname-mismatch', certificateReady: false });
    expect(device.customDomain('notes.example.test')).toBeUndefined();
    const verified = device.connectCustomDomain({ hostname: 'notes.example.test', appHost: 'notes--alice.elanous.app',
      cnameTarget: 'notes--alice.elanous.app', ownerTxt: { name: '_elanous-owner.notes.example.test', value: 'proof-a' }, expectedOwnerProof: 'proof-a' });
    expect(verified).toMatchObject({ status: 'verified', appHost: 'notes--alice.elanous.app', certificateReady: false });
    expect(device.customDomain('notes.example.test')).toEqual({ appHost: 'notes--alice.elanous.app', certificateReady: false });
    expect(await device.issueCustomCertificate('notes.example.test')).toMatchObject({ status: 'issued' });
    expect(device.customDomain('notes.example.test')).toEqual({ appHost: 'notes--alice.elanous.app', certificateReady: true });
    expect(device.connectCustomDomain({ hostname: 'other.example.test', appHost: 'notes--alice.elanous.app',
      cnameTarget: 'notes--alice.elanous.app', ownerTxt: { name: '_elanous-owner.other.example.test', value: 'wrong' }, expectedOwnerProof: 'proof-a' }))
      .toMatchObject({ status: 'rejected', reason: 'owner-proof-mismatch', certificateReady: false });
    expect(device.connectCustomDomain({ hostname: 'voice.example.test', appHost: 'notes--alice.elanous.app',
      cnameTarget: 'notes--alice.elanous.app', ownerTxt: { name: '_elanous-owner.voice.example.test', value: 'proof-b' },
      expectedOwnerProof: 'proof-b', cloudflareTokenAvailable: true }))
      .toMatchObject({ status: 'verified', dnsSetup: 'cloudflare-simulated', certificateReady: false });
  });

  it('keeps custom-domain TLS unready when CAA rejects issuance or TXT propagation times out', async () => {
    const caaDenied = createFakeDnsCert({ caaAllowed: false });
    caaDenied.registerApp('notes--alice.elanous.app');
    caaDenied.connectCustomDomain({ hostname: 'notes.example.test', appHost: 'notes--alice.elanous.app',
      cnameTarget: 'notes--alice.elanous.app', ownerTxt: { name: '_elanous-owner.notes.example.test', value: 'proof-a' }, expectedOwnerProof: 'proof-a' });
    expect(await caaDenied.issueCustomCertificate('notes.example.test')).toMatchObject({ status: 'failed', reason: 'caa-rejected' });
    expect(caaDenied.customDomain('notes.example.test')?.certificateReady).toBe(false);

    await withSimClock(EPOCH, async (clock) => {
      const delayed = createFakeDnsCert({ txtPropagationDelayMs: CUSTOM_ACME_DELAY_MS, propagationTimeoutMs: CUSTOM_ACME_TIMEOUT_MS });
      delayed.registerApp('notes--alice.elanous.app');
      delayed.connectCustomDomain({ hostname: 'notes.example.test', appHost: 'notes--alice.elanous.app',
        cnameTarget: 'notes--alice.elanous.app', ownerTxt: { name: '_elanous-owner.notes.example.test', value: 'proof-a' }, expectedOwnerProof: 'proof-a' });
      const result = await settleAt(() => delayed.issueCustomCertificate('notes.example.test'), clock, CUSTOM_ACME_TIMEOUT_MS);
      expect(result).toMatchObject({ status: 'failed', reason: 'propagation-timeout' });
      expect(delayed.customDomain('notes.example.test')?.certificateReady).toBe(false);
    });
  });

  it('does not certify a custom domain after its verified app binding changes during ACME propagation', async () => {
    await withSimClock(EPOCH, async (clock) => {
      const device = createFakeDnsCert({ txtPropagationDelayMs: CUSTOM_ACME_DELAY_MS });
      device.registerApp('notes--alice.elanous.app');
      device.registerApp('voice--alice.elanous.app');
      device.connectCustomDomain({ hostname: 'app.example.test', appHost: 'notes--alice.elanous.app',
        cnameTarget: 'notes--alice.elanous.app', ownerTxt: { name: '_elanous-owner.app.example.test', value: 'proof-a' }, expectedOwnerProof: 'proof-a' });
      const pending = device.issueCustomCertificate('app.example.test');
      await Promise.resolve();
      device.connectCustomDomain({ hostname: 'app.example.test', appHost: 'voice--alice.elanous.app',
        cnameTarget: 'voice--alice.elanous.app', ownerTxt: { name: '_elanous-owner.app.example.test', value: 'proof-b' }, expectedOwnerProof: 'proof-b' });
      clock.tick(CUSTOM_ACME_DELAY_MS);
      expect(await pending).toMatchObject({ status: 'failed', reason: 'domain-changed' });
      expect(device.customDomain('app.example.test')).toEqual({ appHost: 'voice--alice.elanous.app', certificateReady: false });
    });
  });

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

  it('uses an injected clock for certificate expiry and renewal', async () => {
    let now = EPOCH;
    const device = createFakeDnsCert({ now: () => now, certificateLifetimeMs: 100 });
    const issued = await device.issueCertificate();
    expect(issued).toMatchObject({ status: 'issued', certificate: { issuedAt: EPOCH, expiresAt: EPOCH + 100 } });
    now = EPOCH + 100;
    const renewed = await device.renewIfDue();
    expect(renewed).toMatchObject({ status: 'issued', certificate: { issuedAt: EPOCH + 100, expiresAt: EPOCH + 200 } });
  });

  it('uses the simulation clock when the contract port wraps a device created beforehand', async () => {
    const device = createFakeDnsCertContractPort().create();
    const issued = await device.issueCertificate();
    if (issued.status !== 'issued') throw new Error('initial certificate issuance unexpectedly failed');
    const renewed = await device.renewIfDueAtForContract(issued.certificate.issuedAt + 61 * DAY);
    expect(renewed).toBe('issued');
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
  }, 30_000); // Release gate runs this full async matrix inside a multi-file shard.

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
