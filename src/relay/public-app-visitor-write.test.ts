import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { generateDaemonKeyPair, serverIdFromPublicKey } from './channel.js';
import { connectRelayHost } from './host-connector.js';
import { startRelayServer } from './relay-server.js';
import { registerRelayCommand } from './relay-cli.js';
import { createPublicAppVisitorWriteGate, createVisitorWriteLedger, loadPublicAppVisitorWriteConfig,
  validateVisitorWritePolicy, type PublicAppVisitorWritePolicy } from './public-app-visitor-write.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'relay-visitor-write-'));
  chmodSync(root, 0o700);
  const at = Date.now();
  // Source: simulation fixture, two admissions exercise the next-request rate
  // refusal; a 512-byte test body bound exercises stream cancellation, not a production default.
  const policy: PublicAppVisitorWritePolicy = { user: 'alice', app: 'tickets', serverId: 'a'.repeat(64),
    paths: ['/api/reserve'], method: 'POST', expiresAt: new Date(at + 600_000).toISOString(),
    // Source: #73003 simulation fixture limits for rate-overflow and streamed-body rejection cases below, not production defaults.
    requestsPerMinute: 2, maxBodyBytes: 512 };
  return { root, at, policy, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
function request(key: string, headers: Record<string, string> = {}, body = '{"seat":"A1"}', path = '/api/reserve') {
  return new Request('https://tickets--alice.elanous.app' + path, { method: 'POST', body,
    headers: { origin: 'https://tickets--alice.elanous.app', 'sec-fetch-site': 'same-origin',
      'content-type': 'application/json', 'idempotency-key': key, ...headers } });
}
const origin = 'https://tickets--alice.elanous.app';

test('private exact projection rejects broad paths, methods, duplicate apps, unsafe and expired config', () => {
  const f = fixture();
  try {
    const path = join(f.root, 'policy.json');
    writeFileSync(path, JSON.stringify({ apps: [f.policy] }), { mode: 0o600 });
    expect(loadPublicAppVisitorWriteConfig(path)).toEqual([f.policy]);
    for (const patch of [{ paths: ['/'] }, { paths: ['/v1/members'] }, { paths: ['/api/*'] },
      { paths: ['/api/../host'] }, { paths: ['/api/%2fhost'] }, { method: 'DELETE' },
      { expiresAt: new Date(f.at - 1).toISOString() }, { requestsPerMinute: 0 }, { maxBodyBytes: Infinity },
      { ownerId: 'forged' }]) expect(() => validateVisitorWritePolicy({ ...f.policy, ...patch }, f.at)).toThrow();
    writeFileSync(path, JSON.stringify({ apps: [f.policy, f.policy] }));
    expect(() => loadPublicAppVisitorWriteConfig(path)).toThrow();
    chmodSync(path, 0o644); expect(() => loadPublicAppVisitorWriteConfig(path)).toThrow();
    const link = join(f.root, 'link'); symlinkSync(path, link);
    expect(() => loadPublicAppVisitorWriteConfig(link)).toThrow();
  } finally { f.cleanup(); }
});

test('admission binds app/server/origin and never turns off default private controls', async () => {
  const f = fixture(); const ledger = createVisitorWriteLedger(join(f.root, 'ledger.sqlite'), f.root);
  try {
    const gate = createPublicAppVisitorWriteGate([f.policy], ledger, () => f.at);
    const call = (req: Request, user = 'alice', app = 'tickets', server = f.policy.serverId) => gate(req, user, app, server, origin);
    expect((await call(request('intent-000000000001'), 'bobby')).status).toBe('not-applicable');
    expect((await call(request('intent-000000000001'), 'alice', 'private')).status).toBe('not-applicable');
    for (const path of ['/host', '/client', '/v1/members', '/__auth/accept', '/api/admin']) {
      expect((await call(request('intent-000000000001', {}, '{}', path))).status).toBe('not-applicable');
    }
    for (const req of [request('intent-000000000001', { origin: 'https://tickets--bobby.elanous.app' }),
      request('intent-000000000001', { 'sec-fetch-site': 'cross-site' }),
      request('intent-000000000001', { 'content-type': 'text/plain' }),
      request('intent-000000000001', { upgrade: 'websocket' }),
      request('intent-000000000001', {}, '{}', '/api/reserve?admin=1')]) {
      const result = await call(req); expect(result.status).toBe('refused');
      if (result.status === 'refused') expect(result.response.status).toBe(403);
    }
    const wrong = await call(request('intent-000000000001'), 'alice', 'tickets', 'b'.repeat(64));
    expect(wrong.status).toBe('refused');
    expect((await call(request('intent-000000000001'))).status).toBe('allowed');
  } finally { ledger.close(); f.cleanup(); }
});

test('durable replay and aggregate app rate survive gate/ledger reopen; bounded window recovers', async () => {
  const f = fixture(); const path = join(f.root, 'ledger.sqlite'); let clock = f.at;
  let ledger = createVisitorWriteLedger(path, f.root);
  try {
    let gate = createPublicAppVisitorWriteGate([f.policy], ledger, () => clock);
    expect((await gate(request('intent-000000000001'), 'alice', 'tickets', f.policy.serverId, origin)).status).toBe('allowed');
    ledger.close(); ledger = createVisitorWriteLedger(path, f.root);
    gate = createPublicAppVisitorWriteGate([f.policy], ledger, () => clock);
    const repeat = await gate(request('intent-000000000001'), 'alice', 'tickets', f.policy.serverId, origin);
    expect(repeat.status).toBe('refused'); if (repeat.status === 'refused') expect(repeat.response.status).toBe(409);
    expect((await gate(request('intent-000000000002'), 'alice', 'tickets', f.policy.serverId, origin)).status).toBe('allowed');
    const limited = await gate(request('intent-000000000003'), 'alice', 'tickets', f.policy.serverId, origin);
    expect(limited.status).toBe('refused'); if (limited.status === 'refused') expect(limited.response.status).toBe(429);
    clock += 60_001;
    expect((await gate(request('intent-000000000003'), 'alice', 'tickets', f.policy.serverId, origin)).status).toBe('allowed');
    clock = Date.parse(f.policy.expiresAt);
    const expired = await gate(request('intent-000000000004'), 'alice', 'tickets', f.policy.serverId, origin);
    expect(expired.status).toBe('refused'); if (expired.status === 'refused') expect(expired.response.status).toBe(403);
  } finally { ledger.close(); f.cleanup(); }
});

test('renewal before policy expiry retains replay and recent rate admission across old expiry and restart', async () => {
  const f = fixture(); const path = join(f.root, 'ledger.sqlite'); let clock = f.at;
  let ledger = createVisitorWriteLedger(path, f.root);
  const original = { ...f.policy, expiresAt: new Date(f.at + 10_000).toISOString(), requestsPerMinute: 1 };
  try {
    let gate = createPublicAppVisitorWriteGate([original], ledger, () => clock);
    expect((await gate(request('intent-000000000001'), 'alice', 'tickets', original.serverId, origin)).status).toBe('allowed');
    clock += 5_000; // Renew while the original policy is still active.
    const renewed = { ...original, expiresAt: new Date(f.at + 600_000).toISOString() };
    ledger.close(); ledger = createVisitorWriteLedger(path, f.root);
    gate = createPublicAppVisitorWriteGate([renewed], ledger, () => clock);
    clock = f.at + 10_001;
    const replay = await gate(request('intent-000000000001'), 'alice', 'tickets', original.serverId, origin);
    expect(replay.status).toBe('refused'); if (replay.status === 'refused') expect(replay.response.status).toBe(409);
    const limited = await gate(request('intent-000000000002'), 'alice', 'tickets', original.serverId, origin);
    expect(limited.status).toBe('refused'); if (limited.status === 'refused') expect(limited.response.status).toBe(429);
    clock = f.at + 60_001;
    expect((await gate(request('intent-000000000002'), 'alice', 'tickets', original.serverId, origin)).status).toBe('allowed');
    const stillReplay = await gate(request('intent-000000000001'), 'alice', 'tickets', original.serverId, origin);
    expect(stillReplay.status).toBe('refused'); if (stillReplay.status === 'refused') expect(stillReplay.response.status).toBe(409);
  } finally { ledger.close(); f.cleanup(); }
});

test('per-app admission capacity recovers while renewed replay tombstones remain protected', () => {
  const f = fixture(); const path = join(f.root, 'ledger.sqlite');
  let ledger = createVisitorWriteLedger(path, f.root);
  // Source: OP74630 exercise the 10,000 app receipt ceiling and request 10,001,
  // then the existing 60-second rate window frees admission capacity independently of replay history.
  const policy = { ...f.policy, requestsPerMinute: 10_000 };
  try {
    for (let n = 0; n < 10_000; n++) expect(ledger.admit(policy, `capacity-intent-${n}`, f.at)).toBe('allowed');
    expect(ledger.admit(policy, 'capacity-overflow', f.at)).toBe('limited');
    expect(ledger.admit(policy, 'capacity-after-minute', f.at + 60_001)).toBe('allowed');
    expect(ledger.admit(policy, 'capacity-intent-0', f.at + 60_001)).toBe('replay');
    const other = { ...policy, app: 'other' };
    expect(ledger.admit(other, 'other-app-intent', f.at + 60_001)).toBe('allowed');
    ledger.close(); ledger = createVisitorWriteLedger(path, f.root);
    const later = Date.parse(policy.expiresAt) + 60_001;
    const next = { ...policy, expiresAt: new Date(later + 600_000).toISOString() };
    expect(ledger.admit(next, 'after-expiry-intent', later)).toBe('allowed');
    const verify = new Database(path, { readonly: true });
    try { expect(verify.query('SELECT COUNT(*) AS n FROM visitor_write_receipt').get()).toEqual({ n: 10_003 }); }
    finally { verify.close(); }
  } finally { ledger.close(); f.cleanup(); }
}, 30_000);

test('offline renewal before old expiry retains replay after a later restart', () => {
  const f = fixture(); const path = join(f.root, 'ledger.sqlite'); let ledger = createVisitorWriteLedger(path, f.root);
  // OP75220: the service cannot observe a private config renewal while offline.
  const original = { ...f.policy, expiresAt: new Date(f.at + 10_000).toISOString() };
  try {
    expect(ledger.admit(original, 'offline-renewal-intent', f.at)).toBe('allowed');
    ledger.close();
    const renewed = { ...original, expiresAt: new Date(f.at + 600_000).toISOString() };
    ledger = createVisitorWriteLedger(path, f.root);
    createPublicAppVisitorWriteGate([renewed], ledger, () => f.at + 60_001);
    expect(ledger.admit(renewed, 'offline-renewal-intent', f.at + 60_001)).toBe('replay');
    expect(ledger.admit(renewed, 'offline-renewal-fresh', f.at + 60_001)).toBe('allowed');
  } finally { ledger.close(); f.cleanup(); }
});

test('fixed acceptedAt replay retention survives renewal until exactly 24h then reclaims', () => {
  const f = fixture(); const path = join(f.root, 'ledger.sqlite'); let ledger = createVisitorWriteLedger(path, f.root);
  // OP75248 fixes the retention boundary to acceptedAt + the existing policy maximum 24h.
  const day = 24 * 60 * 60_000;
  try {
    expect(ledger.admit(f.policy, 'retention-boundary-intent', f.at)).toBe('allowed');
    ledger.close(); ledger = createVisitorWriteLedger(path, f.root);
    const renewed = { ...f.policy, expiresAt: new Date(f.at + 2 * day - 1).toISOString() };
    createPublicAppVisitorWriteGate([renewed], ledger, () => f.at + day - 1);
    expect(ledger.admit(renewed, 'retention-boundary-intent', f.at + day - 1)).toBe('replay');
    expect(ledger.admit(renewed, 'retention-boundary-fresh', f.at + day - 1)).toBe('allowed');
    expect(ledger.admit(renewed, 'retention-boundary-intent', f.at + day)).toBe('allowed');
    expect(ledger.admit(renewed, 'retention-boundary-fresh', f.at + day)).toBe('replay');
    const verify = new Database(path, { readonly: true });
    try { expect(verify.query('SELECT COUNT(*) AS n FROM visitor_write_receipt').get()).toEqual({ n: 2 }); }
    finally { verify.close(); }
  } finally { ledger.close(); f.cleanup(); }
});

test('renewal before expiry pins all existing replay history beyond original expiry and minute', () => {
  const f = fixture(); const path = join(f.root, 'ledger.sqlite'); let ledger = createVisitorWriteLedger(path, f.root);
  const original = { ...f.policy, expiresAt: new Date(f.at + 10_000).toISOString() };
  try {
    expect(ledger.admit(original, 'renewal-intent-original', f.at)).toBe('allowed');
    const renewed = { ...original, expiresAt: new Date(f.at + 600_000).toISOString() };
    // Loading renewed policy happens before old expiry, even if no request arrives then.
    createPublicAppVisitorWriteGate([renewed], ledger, () => f.at + 5_000);
    ledger.close(); ledger = createVisitorWriteLedger(path, f.root);
    expect(ledger.admit(renewed, 'new-intent-after-minute', f.at + 60_001)).toBe('allowed');
    expect(ledger.admit(renewed, 'renewal-intent-original', f.at + 60_001)).toBe('replay');
  } finally { ledger.close(); f.cleanup(); }
});

test('invalid/oversize JSON and absent intent do not spend admission; unavailable ledger fails honestly', async () => {
  const f = fixture(); const ledger = createVisitorWriteLedger(join(f.root, 'ledger.sqlite'), f.root);
  try {
    const gate = createPublicAppVisitorWriteGate([f.policy], ledger, () => f.at);
    for (const req of [request('short'), request('intent-000000000001', {}, 'null'),
      request('intent-000000000001', {}, 'invalid'), request('intent-000000000001', {}, 'x'.repeat(513))]) {
      expect((await gate(req, 'alice', 'tickets', f.policy.serverId, origin)).status).toBe('refused');
    }
    expect((await gate(request('intent-000000000001'), 'alice', 'tickets', f.policy.serverId, origin)).status).toBe('allowed');
    ledger.close();
    const refused = await gate(request('intent-000000000002'), 'alice', 'tickets', f.policy.serverId, origin);
    expect(refused.status).toBe('refused'); if (refused.status === 'refused') expect(refused.response.status).toBe(503);
  } finally { ledger.close(); f.cleanup(); }
});

test('streamed over-limit bodies cancel and concurrent identical intents admit at most once', async () => {
  const f = fixture(); const ledger = createVisitorWriteLedger(join(f.root, 'ledger.sqlite'), f.root);
  try {
    const gate = createPublicAppVisitorWriteGate([f.policy], ledger, () => f.at);
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(f.policy.maxBodyBytes + 1)); },
      cancel() { cancelled = true; },
    });
    const base = request('intent-000000000001');
    const oversized = new Request(base.url, { method: 'POST', headers: base.headers, body: stream });
    const result = await gate(oversized, 'alice', 'tickets', f.policy.serverId, origin);
    expect(result.status).toBe('refused'); if (result.status === 'refused') expect(result.response.status).toBe(413);
    expect(cancelled).toBe(true);
    const attempts = await Promise.all(Array.from({ length: 8 }, () =>
      gate(request('intent-000000000001'), 'alice', 'tickets', f.policy.serverId, origin)));
    expect(attempts.filter(item => item.status === 'allowed')).toHaveLength(1);
    expect(attempts.filter(item => item.status === 'refused')).toHaveLength(7);
  } finally { ledger.close(); f.cleanup(); }
});

test('stalled visitor body is cancelled at the bounded deadline and does not claim successful admission', async () => {
  const f = fixture(); const ledger = createVisitorWriteLedger(join(f.root, 'ledger.sqlite'), f.root);
  try {
    const gate = createPublicAppVisitorWriteGate([f.policy], ledger, () => f.at);
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const base = request('intent-000000000001');
    const req = new Request(base.url, { method: 'POST', headers: base.headers, body: stream });
    const result = await gate(req, 'alice', 'tickets', f.policy.serverId, origin);
    expect(result.status).toBe('refused'); if (result.status === 'refused') expect(result.response.status).toBe(408);
    expect(cancelled).toBe(true);
    expect((await gate(request('intent-000000000001'), 'alice', 'tickets', f.policy.serverId, origin)).status).toBe('allowed');
  } finally { ledger.close(); f.cleanup(); }
}, 10_000);

test('public URL → real encrypted relay/host → booking; explicit write opt-in, replay and private boundaries', async () => {
  const f = fixture(); const ledger = createVisitorWriteLedger(join(f.root, 'ledger.sqlite'), f.root);
  const signing = generateKeyPairSync('ed25519'); const daemonKeys = await generateDaemonKeyPair();
  const serverId = serverIdFromPublicKey(daemonKeys.publicKey);
  const policy = { ...f.policy, serverId, requestsPerMinute: 3 };
  const credentials: Array<Array<string | null>> = []; let stopped = false;
  const bookingDb = new Database(':memory:');
  bookingDb.exec('CREATE TABLE booking (seat TEXT PRIMARY KEY, intent TEXT NOT NULL UNIQUE, booking_id TEXT NOT NULL UNIQUE)');
  const bookingCount = () => (bookingDb.query('SELECT COUNT(*) AS n FROM booking').get() as { n: number }).n;
  const relay = startRelayServer({ trustedHostKeys: new Map([[serverId,
    signing.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url')]]),
    memberRequired: true, hostOwnerMemberIds: new Map([[serverId, 'synthetic-owner']]),
    validateMemberToken: async token => token === 'emt_synthetic' ? { memberId: 'synthetic-owner' } : null,
    publicDomain: 'elanous.app', publicServerId: serverId, publicUserId: 'alice',
    publicReadableApps: new Set(['alice/tickets']), publicVisitorWritePolicies: [policy], publicVisitorWriteLedger: ledger,
    appKillSwitch: { isDown: () => stopped, applyIncident: () => { throw new Error('unexpected incident'); } } });
  let connector: Awaited<ReturnType<typeof connectRelayHost>> | undefined;
  try {
    connector = await connectRelayHost({ relayUrl: `ws://127.0.0.1:${relay.port}`, daemonKeys,
      hostSigningKey: signing.privateKey, getMemberToken: () => 'emt_synthetic',
      handleRequest: async req => {
        credentials.push(['authorization', 'cookie', 'sec-websocket-protocol'].map(name => req.headers.get(name)));
        if (req.method === 'GET') return new Response('Ticket application');
        if (new URL(req.url).pathname === '/api/owner-check') return Response.json({ ownerRoute: true });
        const body = await req.json() as { seat?: unknown };
        if (new URL(req.url).pathname !== '/api/reserve' || body.seat !== 'A1') return new Response(null, { status: 404 });
        const intent = req.headers.get('idempotency-key') ?? 'synthetic-owner-intent';
        const bookingId = randomUUID();
        const inserted = bookingDb.query('INSERT INTO booking VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run('A1', intent, bookingId);
        if (!inserted.changes) return Response.json({ error: 'seat-already-reserved' }, { status: 409 });
        return Response.json({ bookingId, seat: 'A1', status: 'reserved' }, { status: 201 });
      } });
    const local = `http://127.0.0.1:${relay.port}`;
    const write = (key: string, app = 'tickets', extra: Record<string, string> = {}, path = '/api/reserve') =>
      fetch(local + path, { method: 'POST', body: '{"seat":"A1"}', headers: {
        host: `${app}--alice.elanous.app`, origin, 'sec-fetch-site': 'same-origin',
        'content-type': 'application/json', 'idempotency-key': key,
        authorization: 'Bearer audience-not-owner', cookie: 'audience=synthetic', ...extra } });
    expect((await fetch(local + '/', { headers: { host: 'tickets--alice.elanous.app' } })).status).toBe(200);
    const booked = await write('intent-000000000001'); expect(booked.status).toBe(201);
    const booking = await booked.json() as { status: string; bookingId: string };
    expect(booking.status).toBe('reserved'); expect(bookingCount()).toBe(1);
    expect(bookingDb.query('SELECT booking_id FROM booking WHERE seat = ?').get('A1')).toEqual({ booking_id: booking.bookingId });
    expect((await write('intent-000000000001')).status).toBe(409); expect(bookingCount()).toBe(1);
    expect((await write('intent-000000000002', 'private')).status).toBe(401);
    expect((await write('intent-000000000002', 'tickets', { origin: 'https://evil.example' })).status).toBe(403);
    for (const path of ['/host', '/client', '/v1/members', '/__auth/accept', '/api/admin']) {
      expect((await write('intent-000000000002', 'tickets', {}, path)).status).toBe(401);
    }
    stopped = true;
    expect((await write('intent-000000000002')).status).toBe(403); expect(bookingCount()).toBe(1);
    expect(credentials).toEqual([[null, null, null], [null, null, null]]);
    stopped = false;
    // An explicit member credential keeps the existing member gate, even for
    // a write-policy path; it does not inherit anonymous visitor authority.
    const owner = await fetch(local + '/api/reserve', { method: 'POST', body: '{"seat":"A1"}',
      headers: { host: 'tickets--alice.elanous.app', authorization: 'Bearer emt_synthetic' } });
    expect(owner.status).toBe(409); // Application seat conflict, not Origin/intent admission denial.
    const invalid = await write('intent-000000000002', 'tickets', { authorization: 'Bearer emt_invalid' });
    expect(invalid.status).toBe(401);
    const ownerControl = await fetch(local + '/api/owner-check', { method: 'POST', body: '{}',
      headers: { host: 'tickets--alice.elanous.app', authorization: 'Bearer emt_synthetic' } });
    expect(ownerControl.status).toBe(200);
    expect((await write('intent-000000000002')).status).toBe(409); // Distinct intent, same seat: app SQL constraint.
    expect(bookingCount()).toBe(1);
    expect((await write('intent-000000000003')).status).toBe(409);
    expect((await write('intent-000000000004')).status).toBe(429); expect(bookingCount()).toBe(1);
    expect((await fetch(local + '/api/reserve', { method: 'DELETE',
      headers: { host: 'tickets--alice.elanous.app', origin } })).status).toBe(401);
  } finally { connector?.close(); relay.stop(); ledger.close(); bookingDb.close(); f.cleanup(); }
});

test('relay refuses unpinned or non-public visitor policy at construction; CLI requires explicit private projection', async () => {
  const f = fixture(); const ledger = createVisitorWriteLedger(join(f.root, 'ledger.sqlite'), f.root);
  const signing = generateKeyPairSync('ed25519'); const keys = await generateDaemonKeyPair();
  const serverId = serverIdFromPublicKey(keys.publicKey);
  const options = { trustedHostKeys: new Map([[serverId,
    signing.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url')]]),
    memberRequired: true, hostOwnerMemberIds: new Map([[serverId, 'synthetic-owner']]),
    validateMemberToken: async () => null, publicDomain: 'elanous.app' as const,
    publicServerId: serverId, publicUserId: 'alice', publicReadableApps: new Set(['alice/tickets']),
    publicVisitorWritePolicies: [{ ...f.policy, serverId }], publicVisitorWriteLedger: ledger };
  try {
    expect(() => startRelayServer({ ...options, publicVisitorWriteLedger: undefined })).toThrow('ledger');
    expect(() => startRelayServer({ ...options, publicReadableApps: new Set() })).toThrow('binding');
    expect(() => startRelayServer({ ...options, publicVisitorWritePolicies: [f.policy] })).toThrow('binding');
    const program = new Command(); program.exitOverride(); registerRelayCommand(program);
    await expect(program.parseAsync(['relay', 'serve', '--trusted-host-keys', '/absent',
      '--visitor-write-config', '/absent'], { from: 'user' })).rejects.toThrow('--visitor-write-config requires');
  } finally { ledger.close(); f.cleanup(); }
});
