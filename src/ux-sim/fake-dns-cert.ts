import { withSimClock } from './fake-clock.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const CERTIFICATE_LIFETIME_MS = 90 * DAY_MS;
const RENEWAL_WINDOW_MS = 30 * DAY_MS;

export interface FakeDnsCertOptions {
  relayTarget?: string;
  txtPropagationDelayMs?: number;
  propagationTimeoutMs?: number;
  issuanceLimit?: number;
  caaAllowed?: boolean;
  certificateLifetimeMs?: number;
}
export interface FakeDnsZoneRecord { readonly name: '*.elanous.app'; readonly type: 'CNAME'; readonly value: string }
export interface FakeDnsZone {
  readonly domain: 'elanous.app';
  readonly nameservers: readonly string[];
  readonly soa: { readonly primary: string; readonly responsible: string; readonly serial: number };
  readonly records: readonly FakeDnsZoneRecord[];
}
export interface FakeDnsCertCertificate {
  readonly names: readonly ['*.elanous.app'];
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly serial: number;
}
export type FakeDnsCertResult =
  /** `superseded` = a newer request already stored its certificate, so this one was issued but not kept. */
  | { readonly status: 'issued'; readonly certificate: FakeDnsCertCertificate; readonly superseded?: true }
  | { readonly status: 'failed'; readonly code: 'propagation-timeout' | 'issuance-limit' | 'caa-rejected'; readonly message: string }
  | { readonly status: 'not-due'; readonly certificate: FakeDnsCertCertificate };
export interface FakeDnsCertEvent {
  readonly type: 'app-registered' | 'acme-txt-written' | 'certificate-issued' | 'issuance-failed';
  readonly at: number;
  readonly detail: string;
}
export interface FakeDnsCertDevice {
  readonly zone: FakeDnsZone;
  readonly counters: { readonly wildcardRecordWrites: number; readonly acmeTxtWrites: number };
  registerApp(hostname: string): void;
  apps(): string[];
  matchesWildcard(hostname: string): boolean;
  issueCertificate(): Promise<FakeDnsCertResult>;
  renewCertificate(): Promise<FakeDnsCertResult>;
  renewIfDue(): Promise<FakeDnsCertResult>;
  certificate(): FakeDnsCertCertificate | undefined;
  events(): FakeDnsCertEvent[];
  configure(options: Partial<Pick<FakeDnsCertOptions, 'txtPropagationDelayMs' | 'propagationTimeoutMs' | 'issuanceLimit' | 'caaAllowed'>>): void;
}

function copyCertificate(certificate: FakeDnsCertCertificate): FakeDnsCertCertificate {
  return { ...certificate, names: ['*.elanous.app'] };
}

function requireNonnegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`fake-dns-cert: ${name} must be a nonnegative finite number`);
}

export function createFakeDnsCert(options: FakeDnsCertOptions = {}): FakeDnsCertDevice {
  const relayTarget = options.relayTarget ?? 'relay-edge.elanous.net';
  const nameservers = ['ns-1.elanous.net', 'ns-2.elanous.net'] as const;
  let wildcardRecordWrites = 0;
  const records: FakeDnsZoneRecord[] = [];
  function writeWildcardRecord(): void {
    records.push({ name: '*.elanous.app', type: 'CNAME', value: relayTarget });
    wildcardRecordWrites += 1;
  }
  writeWildcardRecord();
  const zone: FakeDnsZone = {
    domain: 'elanous.app', nameservers,
    soa: { primary: nameservers[0], responsible: 'hostmaster.elanous.app', serial: 1 },
    records,
  };
  let propagationDelayMs = options.txtPropagationDelayMs ?? 0;
  let propagationTimeoutMs = options.propagationTimeoutMs;
  let issuanceLimit = options.issuanceLimit;
  let caaAllowed = options.caaAllowed ?? true;
  let certificateLifetimeMs = options.certificateLifetimeMs ?? CERTIFICATE_LIFETIME_MS;
  requireNonnegative(propagationDelayMs, 'txtPropagationDelayMs');
  if (propagationTimeoutMs !== undefined) requireNonnegative(propagationTimeoutMs, 'propagationTimeoutMs');
  if (issuanceLimit !== undefined) requireNonnegative(issuanceLimit, 'issuanceLimit');
  requireNonnegative(certificateLifetimeMs, 'certificateLifetimeMs');
  const registeredApps = new Set<string>();
  const events: FakeDnsCertEvent[] = [];
  let acmeTxtWrites = 0;
  let issuanceAttempts = 0;
  let nextSerial = 1;
  let currentCertificate: FakeDnsCertCertificate | undefined;
  let latestIssuanceRequest = 0;
  // Newest request id whose certificate is stored. A later request that fails never blocks an
  // earlier in-flight request from storing its successful certificate.
  let storedIssuanceRequest = 0;

  function failure(code: 'propagation-timeout' | 'issuance-limit' | 'caa-rejected', message: string): FakeDnsCertResult {
    events.push({ type: 'issuance-failed', at: Date.now(), detail: code });
    return { status: 'failed', code, message };
  }
  async function performIssue(request: { propagationDelayMs: number; propagationTimeoutMs: number | undefined; issuanceLimit: number | undefined; caaAllowed: boolean; certificateLifetimeMs: number }, requestId: number): Promise<FakeDnsCertResult> {
    if (!request.caaAllowed) return failure('caa-rejected', 'CAA policy rejects certificate issuance');
    if (request.issuanceLimit !== undefined && issuanceAttempts >= request.issuanceLimit) return failure('issuance-limit', 'configured simulated issuance limit reached');
    issuanceAttempts += 1;
    acmeTxtWrites += 1;
    const startedAt = Date.now();
    events.push({ type: 'acme-txt-written', at: startedAt, detail: '_acme-challenge.elanous.app' });
    const waitMs = request.propagationTimeoutMs === undefined ? request.propagationDelayMs : Math.min(request.propagationDelayMs, request.propagationTimeoutMs);
    await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    if (request.propagationTimeoutMs !== undefined && request.propagationDelayMs > request.propagationTimeoutMs) {
      return failure('propagation-timeout', `ACME TXT did not propagate within ${request.propagationTimeoutMs}ms`);
    }
    const issuedAt = Date.now();
    const certificate: FakeDnsCertCertificate = {
      names: ['*.elanous.app'], issuedAt, expiresAt: issuedAt + request.certificateLifetimeMs, serial: nextSerial++,
    };
    if (requestId > storedIssuanceRequest) {
      storedIssuanceRequest = requestId;
      currentCertificate = certificate;
      events.push({ type: 'certificate-issued', at: issuedAt, detail: String(certificate.serial) });
      return { status: 'issued', certificate: copyCertificate(certificate) };
    }
    return { status: 'issued', certificate: copyCertificate(certificate), superseded: true };
  }
  function issue(): Promise<FakeDnsCertResult> {
    const request = { propagationDelayMs, propagationTimeoutMs, issuanceLimit, caaAllowed, certificateLifetimeMs };
    const requestId = ++latestIssuanceRequest;
    return performIssue(request, requestId);
  }
  function matchesWildcard(hostname: string): boolean {
    const suffix = '.elanous.app';
    if (!hostname.endsWith(suffix)) return false;
    const label = hostname.slice(0, -suffix.length);
    return label.length > 0 && !label.includes('.');
  }
  return {
    zone,
    get counters() { return { wildcardRecordWrites, acmeTxtWrites }; },
    registerApp(hostname) {
      if (!matchesWildcard(hostname)) throw new Error(`fake-dns-cert: hostname is outside *.elanous.app: ${hostname}`);
      if (!registeredApps.has(hostname)) { registeredApps.add(hostname); events.push({ type: 'app-registered', at: Date.now(), detail: hostname }); }
    },
    apps() { return [...registeredApps].sort(); },
    matchesWildcard,
    issueCertificate: issue,
    renewCertificate: issue,
    async renewIfDue() {
      if (!currentCertificate) return issue();
      if (currentCertificate.expiresAt - Date.now() > RENEWAL_WINDOW_MS) return { status: 'not-due', certificate: copyCertificate(currentCertificate) };
      return issue();
    },
    certificate() { return currentCertificate && copyCertificate(currentCertificate); },
    events() { return events.map((event) => ({ ...event })); },
    configure(next) {
      if (next.txtPropagationDelayMs !== undefined) { requireNonnegative(next.txtPropagationDelayMs, 'txtPropagationDelayMs'); propagationDelayMs = next.txtPropagationDelayMs; }
      if (next.propagationTimeoutMs !== undefined) { requireNonnegative(next.propagationTimeoutMs, 'propagationTimeoutMs'); propagationTimeoutMs = next.propagationTimeoutMs; }
      if (next.issuanceLimit !== undefined) { requireNonnegative(next.issuanceLimit, 'issuanceLimit'); issuanceLimit = next.issuanceLimit; }
      if (next.caaAllowed !== undefined) caaAllowed = next.caaAllowed;
    },
  };
}

export interface FakeDnsCertNameRuleCase {
  readonly name: string;
  readonly hostname: string;
  readonly allowed: boolean;
  readonly expected: boolean;
  readonly source: string;
}
const nameFixtureSource = 'docs/conductor/nexus-backend-in-a-box.md name rule (👑 confirmed)';
/**
 * Reserved app words quoted from the canonical name rule — 내부 문서 `nexus-backend-in-a-box`
 * «이름 규칙(대표 확정): … 예약어(`www`·`docs`·`api`·`admin`·`relay`·`mail` 등) 거부».
 * The canonical list ends with «등» (and others), so the full reserved-word policy is NOT settled.
 * These words are therefore kept OUT of the required contract matrix (`fakeDnsCertContractCases`) and
 * only enter a matrix through an explicitly injected policy (`fakeDnsCertReservedWordContractCases`).
 */
export const FAKE_DNS_CERT_CONFIRMED_RESERVED_APP_WORDS: readonly string[] = ['www', 'docs', 'api', 'admin', 'relay', 'mail'];
export const fakeDnsCertNameRuleCases: readonly FakeDnsCertNameRuleCase[] = [
  { name: 'ordinary app and user', hostname: 'notes--alice.elanous.app', allowed: true, expected: true, source: nameFixtureSource },
  { name: 'shortest user', hostname: 'a--amy.elanous.app', allowed: true, expected: true, source: nameFixtureSource },
  { name: 'user too short', hostname: 'notes--ab.elanous.app', allowed: false, expected: false, source: nameFixtureSource },
  { name: 'user too long', hostname: `notes--${'a'.repeat(21)}.elanous.app`, allowed: false, expected: false, source: nameFixtureSource },
  { name: 'app too long', hostname: `${'a'.repeat(25)}--alice.elanous.app`, allowed: false, expected: false, source: nameFixtureSource },
  { name: 'uppercase', hostname: 'Notes--alice.elanous.app', allowed: false, expected: false, source: nameFixtureSource },
  { name: 'underscore', hostname: 'note_s--alice.elanous.app', allowed: false, expected: false, source: nameFixtureSource },
  { name: 'app begins with hyphen', hostname: '-notes--alice.elanous.app', allowed: false, expected: false, source: nameFixtureSource },
  { name: 'user ends with hyphen', hostname: 'notes--alice-.elanous.app', allowed: false, expected: false, source: nameFixtureSource },
  { name: 'multiple delimiter', hostname: 'notes--extra--alice.elanous.app', allowed: false, expected: false, source: nameFixtureSource },
  { name: 'reserved pull-request suffix', hostname: 'notes-pr12--alice.elanous.app', allowed: false, expected: false, source: nameFixtureSource },
  { name: 'nested hostname label', hostname: 'x.notes--alice.elanous.app', allowed: false, expected: false, source: nameFixtureSource },
];

/** Policy-dependent rows: build them from the reserved-word policy the implementation under test declares. */
export function fakeDnsCertReservedWordNameRuleCases(reservedAppWords: readonly string[]): readonly FakeDnsCertNameRuleCase[] {
  return reservedAppWords.map((word) => ({ name: `reserved app word ${word}`, hostname: `${word}--alice.elanous.app`, allowed: false, expected: false, source: 'injected reserved-word policy' }));
}

export function isFakeDnsCertNameAllowed(hostname: string, reservedAppWords: readonly string[] = FAKE_DNS_CERT_CONFIRMED_RESERVED_APP_WORDS): boolean {
  const suffix = '.elanous.app';
  if (!hostname.endsWith(suffix)) return false;
  const label = hostname.slice(0, -suffix.length);
  if (label.length > 63 || label.includes('.') || !/^[a-z0-9-]+$/.test(label)) return false;
  const split = label.split('--');
  if (split.length !== 2) return false;
  const [app, user] = split;
  if (!app || app.length > 24 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(app)) return false;
  if (user.length < 3 || user.length > 20 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(user)) return false;
  if (reservedAppWords.includes(app) || /-pr\d+$/.test(app)) return false;
  return true;
}

export type FakeDnsCertContractOptions = FakeDnsCertOptions;
export interface FakeDnsCertContractDevice extends FakeDnsCertDevice {
  validateName(hostname: string): boolean;
  renewIfDueAtForContract(now: number): Promise<'not-due' | 'issued' | 'failed'>;
}
export interface FakeDnsCertContractPort { create(options?: FakeDnsCertContractOptions): FakeDnsCertContractDevice }
export interface FakeDnsCertContractCase {
  readonly name: string;
  readonly input: { readonly operation: 'wildcard-match'; readonly hostname: string } | { readonly operation: 'register-many'; readonly hostnames: readonly string[] }
    | { readonly operation: 'issue'; readonly options: FakeDnsCertContractOptions; readonly configureBeforeIssue?: FakeDnsCertOptions; readonly configureDuringWait?: FakeDnsCertOptions }
    | { readonly operation: 'renew-boundary'; readonly options: FakeDnsCertContractOptions; readonly advanceMs: number }
    | { readonly operation: 'name-rule'; readonly hostname: string };
  readonly expected: unknown;
}
export const fakeDnsCertContractCases: readonly FakeDnsCertContractCase[] = [
  { name: 'single-label wildcard matches', input: { operation: 'wildcard-match', hostname: 'notes--alice.elanous.app' }, expected: true },
  { name: 'wildcard does not match nested hostname', input: { operation: 'wildcard-match', hostname: 'x.notes--alice.elanous.app' }, expected: false },
  { name: '100 app registrations retain one DNS record write', input: { operation: 'register-many', hostnames: Array.from({ length: 100 }, (_, index) => `app${index}--alice.elanous.app`) }, expected: 1 },
  { name: 'DNS-01 issuance succeeds despite later configuration tightening', input: { operation: 'issue', options: { txtPropagationDelayMs: 5, propagationTimeoutMs: 10, issuanceLimit: 2 }, configureDuringWait: { txtPropagationDelayMs: 100, propagationTimeoutMs: 0 } }, expected: { status: 'issued', certificateNames: ['*.elanous.app'], txtWrites: 1 } },
  { name: 'propagation timeout preserves current certificate', input: { operation: 'issue', options: { txtPropagationDelayMs: 0, propagationTimeoutMs: 10, issuanceLimit: 3 }, configureBeforeIssue: { txtPropagationDelayMs: 11 }, configureDuringWait: { txtPropagationDelayMs: 0, propagationTimeoutMs: 100 } }, expected: { status: 'failed', code: 'propagation-timeout', preserved: true, txtWrites: 2 } },
  { name: 'CAA rejection', input: { operation: 'issue', options: { caaAllowed: false } }, expected: { status: 'failed', code: 'caa-rejected', txtWrites: 0 } },
  { name: 'issuance limit preserves current certificate', input: { operation: 'issue', options: { issuanceLimit: 1 }, configureDuringWait: { issuanceLimit: 1 } }, expected: { status: 'failed', code: 'issuance-limit', preserved: true, txtWrites: 1 } },
  { name: 'renewal starts exactly 30 days before expiry with positive TXT propagation', input: { operation: 'renew-boundary', options: { certificateLifetimeMs: 90 * DAY_MS, txtPropagationDelayMs: 5, propagationTimeoutMs: 10 }, advanceMs: 60 * DAY_MS }, expected: 'issued' },
  ...fakeDnsCertNameRuleCases.map((row) => ({ name: `name rule: ${row.name}`, input: { operation: 'name-rule' as const, hostname: row.hostname }, expected: row.expected })),
];

/** Optional, policy-injected contract rows (not part of the required matrix). */
export function fakeDnsCertReservedWordContractCases(reservedAppWords: readonly string[]): readonly FakeDnsCertContractCase[] {
  return fakeDnsCertReservedWordNameRuleCases(reservedAppWords).map((row) => ({ name: `name rule: ${row.name}`, input: { operation: 'name-rule' as const, hostname: row.hostname }, expected: row.expected }));
}

export async function runFakeDnsCertContractMatrix(
  port: FakeDnsCertContractPort,
  cases: readonly FakeDnsCertContractCase[] = fakeDnsCertContractCases,
): Promise<unknown[]> {
  const results: unknown[] = [];
  for (const row of cases) {
    const input = row.input;
    if (input.operation === 'wildcard-match') results.push(port.create().matchesWildcard(input.hostname));
    else if (input.operation === 'register-many') {
      const device = port.create(); input.hostnames.forEach((host) => device.registerApp(host)); results.push(device.counters.wildcardRecordWrites);
    } else if (input.operation === 'name-rule') results.push(port.create().validateName(input.hostname));
    else if (input.operation === 'issue') {
      const device = port.create(input.options);
      let original: FakeDnsCertCertificate | undefined;
      if (row.expected && typeof row.expected === 'object' && 'preserved' in row.expected) {
        const initial = await device.issueCertificate();
        if (initial.status === 'issued') original = initial.certificate;
      }
      if (input.configureBeforeIssue) device.configure(input.configureBeforeIssue);
      const pending = device.issueCertificate();
      if (input.configureDuringWait) device.configure(input.configureDuringWait);
      const outcome = await pending;
      results.push({ status: outcome.status, ...(outcome.status === 'failed' ? { code: outcome.code } : { certificateNames: outcome.certificate.names }),
        ...(original ? { preserved: JSON.stringify(device.certificate()) === JSON.stringify(original) } : {}), txtWrites: device.counters.acmeTxtWrites });
    } else {
      const device = port.create(input.options);
      const issued = await device.issueCertificate();
      if (issued.status !== 'issued') { results.push(issued.status); continue; }
      const now = issued.certificate.issuedAt + input.advanceMs;
      results.push(await device.renewIfDueAtForContract(now));
    }
  }
  return results;
}

export function createFakeDnsCertContractPort(policy: { reservedAppWords?: readonly string[] } = {}): FakeDnsCertContractPort {
  const reservedAppWords = policy.reservedAppWords ?? FAKE_DNS_CERT_CONFIRMED_RESERVED_APP_WORDS;
  return {
    create(options = {}) {
      const device = createFakeDnsCert(options);
      return Object.assign(device, { validateName: (hostname: string) => isFakeDnsCertNameAllowed(hostname, reservedAppWords), renewIfDueAtForContract: async (now: number) => {
        return withSimClock(now, async (clock) => {
          const pending = device.renewIfDue();
          await Promise.resolve();
          const waitMs = options.propagationTimeoutMs === undefined
            ? options.txtPropagationDelayMs ?? 0
            : Math.min(options.txtPropagationDelayMs ?? 0, options.propagationTimeoutMs);
          clock.tick(waitMs);
          return (await pending).status;
        });
      } });
    },
  };
}
