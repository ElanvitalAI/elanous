import { afterEach, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
// A Unix socket path holds at most 103 bytes (macOS): the land train's long TMPDIR puts the els server/holder socket
// under <state>/els/ over it, so a state dir under a long TMPDIR falls back to /tmp (each test removes its own dir).
const SOCKET_SAFE_TMP = tmpdir().length > 40 ? '/tmp' : tmpdir();
import { join } from 'node:path';
import { elsSocketPath, startElsServer } from './server.js';
import {
  createOutboundWebhooks, hostAllowed, loadSubscriptions, outEventOf, outPayload, putSubscription, removeSubscription,
  subscriptionStatus, type EventFrame, type Subscription,
} from './webhook-out.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const SECRET = 'whsec-OUT-TEST-71ab';
const NOW = 1_700_000_000_000;

function setup(subs: readonly Subscription[], allowHosts: readonly string[] = ['hooks.example.test']) {
  const stateDir = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-hook-out-'));
  dirs.push(stateDir);
  writeFileSync(join(stateDir, 'out.secret'), `${SECRET}\n`);
  writeFileSync(join(stateDir, 'subscriptions.json'), JSON.stringify({ allowHosts, subscriptions: subs }));
  return stateDir;
}

const sub = (over: Partial<Subscription> = {}): Subscription => ({ id: 'ci', url: 'https://hooks.example.test/els', events: ['state', 'notice', 'child-end'], secretRef: 'out.secret', ...over });
const frame = (seq: number, event: EventFrame['event'], pane = 'p1'): EventFrame => ({ op: 'event', v: 1, pane, seq, at: NOW, event });

type Call = { url: string; headers: Record<string, string>; body: string };
function fakeFetch(statuses: readonly (number | 'throw')[]) {
  const calls: Call[] = [];
  let i = 0;
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init!.headers as Record<string, string>, body: String(init!.body) });
    const status = statuses[Math.min(i, statuses.length - 1)]!;
    i += 1;
    if (status === 'throw') throw new Error('connect ECONNREFUSED');
    return new Response('', { status });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

const deps = (stateDir: string, f: typeof fetch, sleeps: number[] = []) => ({
  stateDir, fetch: f, now: () => NOW, sleep: async (ms: number) => { sleeps.push(ms); },
  resolve: async () => ['93.184.216.34'],
});

// Judgment table: which frames leave the host.
const EVENT_TABLE: readonly { name: string; event: EventFrame['event']; out: string | undefined }[] = [
  { name: 'state', event: { kind: 'state', state: 'idle' }, out: 'state' },
  { name: 'notice', event: { kind: 'notice', level: 'alert', text: 'build red' }, out: 'notice' },
  { name: 'child end', event: { kind: 'child', action: 'end', id: 'c1', ok: true }, out: 'child-end' },
  { name: 'child progress', event: { kind: 'child', action: 'progress', id: 'c1' }, out: undefined },
  { name: 'turn', event: { kind: 'turn', phase: 'start', id: 't1' }, out: undefined },
  { name: 'meta', event: { kind: 'meta', model: 'x' }, out: undefined },
  { name: 'unknown kind', event: { kind: 'future-thing' }, out: undefined },
];
for (const row of EVENT_TABLE) {
  test(`judgment: ${row.name} → ${row.out ?? 'not delivered'}`, () => {
    expect(outEventOf(frame(1, row.event))).toBe(row.out as never);
  });
}

// Judgment: the receiver learns the state value, the child ok — and never an extra field.
test('judgment: payload state carries data.state', () => {
  expect(outPayload(frame(2, { kind: 'state', state: 'idle' }), 'state', 'ci').data).toEqual({ state: 'idle' });
});
test('judgment: payload child-end carries data.ok (true and false)', () => {
  expect(outPayload(frame(3, { kind: 'child', action: 'end', id: 'c1', ok: true }), 'child-end', 'ci').data).toEqual({ ok: true, id: 'c1' });
  expect(outPayload(frame(4, { kind: 'child', action: 'end', id: 'c2', ok: false }), 'child-end', 'ci').data).toEqual({ ok: false, id: 'c2' });
});
test('judgment: payload never carries an event field outside the per-kind allowlist', () => {
  const extras = { token: 'x', line: 'SCREEN', text: 'secret', summary: 's', ws: 'w', cwd: '/c', parent: 'p' };
  const state = outPayload(frame(5, { kind: 'state', state: 'idle', ...extras } as unknown as EventFrame['event']), 'state', 'ci');
  expect(state.data).toEqual({ state: 'idle' });
  const end = outPayload(frame(6, { kind: 'child', action: 'end', id: 'c1', ok: true, ...extras } as unknown as EventFrame['event']), 'child-end', 'ci');
  expect(end.data).toEqual({ ok: true, id: 'c1' });
  const notice = outPayload(frame(7, { kind: 'notice', level: 'alert', text: 'build red', token: 'x', line: 'SCREEN' } as unknown as EventFrame['event']), 'notice', 'ci');
  expect(notice.data).toEqual({ level: 'alert' });
  for (const payload of [state, end, notice]) {
    expect(JSON.stringify(payload).includes('secret')).toBe(false);
    expect(JSON.stringify(payload).includes('SCREEN')).toBe(false);
    expect(JSON.stringify(payload).includes('token')).toBe(false);
  }
});

// Judgment table: host allow list is default deny.
const HOST_TABLE: readonly { url: string; allow: readonly string[]; ok: boolean }[] = [
  { url: 'https://hooks.example.test/els', allow: ['hooks.example.test'], ok: true },
  { url: 'https://HOOKS.example.test/els', allow: ['hooks.example.test'], ok: true },
  { url: 'https://evil.example.test/els', allow: ['hooks.example.test'], ok: false },
  { url: 'https://hooks.example.test.evil.test/els', allow: ['hooks.example.test'], ok: false },
  { url: 'https://user:pw@hooks.example.test/els', allow: ['hooks.example.test'], ok: false },
  { url: 'file:///etc/passwd', allow: ['hooks.example.test'], ok: false },
  { url: 'https://hooks.example.test/els', allow: [], ok: false },
  // #38610 REVIEW must ① — the remote wire is HTTPS: an allow-listed host over plain http is denied,
  // and the http exception is loopback only (127.0.0.1, [::1], localhost).
  { url: 'http://hooks.example.test/els', allow: ['hooks.example.test'], ok: false },
  { url: 'http://127.0.0.1:9/hook', allow: ['127.0.0.1'], ok: true },
  { url: 'http://localhost:9/hook', allow: ['localhost'], ok: true },
  { url: 'http://[::1]:9/hook', allow: ['[::1]'], ok: true },
  { url: 'http://192.168.0.9/hook', allow: ['192.168.0.9'], ok: false },
];
for (const row of HOST_TABLE) {
  test(`judgment: host ${row.url} allow=[${row.allow.join(',')}] → ${row.ok}`, () => {
    expect(hostAllowed(row.allow, row.url)).toBe(row.ok);
  });
}

test('a matching frame is sent once, signed over timestamp.body, without screen text or the secret', async () => {
  const stateDir = setup([sub()]);
  const { calls, impl } = fakeFetch([200]);
  const out = createOutboundWebhooks(deps(stateDir, impl));
  const results = await out.deliver(frame(5, { kind: 'child', action: 'end', id: 'c1', ok: true, summary: 'done', line: 'SCREEN-TEXT-xyz' }));
  expect(results).toEqual([{ subscription: 'ci', ok: true, tries: 1, status: 200 }]);
  expect(calls.length).toBe(1);
  const call = calls[0]!;
  expect(call.url).toBe('https://hooks.example.test/els');
  const ts = call.headers['x-els-timestamp']!;
  expect(ts).toBe(String(NOW / 1000));
  expect(call.headers['x-els-signature']).toBe(`sha256=${createHmac('sha256', SECRET).update(`${ts}.${call.body}`).digest('hex')}`);
  expect(JSON.parse(call.body)).toEqual({ v: 1, subscription: 'ci', event: 'child-end', pane: 'p1', seq: 5, at: NOW, data: { ok: true, id: 'c1' } });
  expect(call.body.includes('SCREEN-TEXT')).toBe(false);
  expect(call.body.includes(SECRET)).toBe(false);
  expect(subscriptionStatus(stateDir).ci).toEqual({ connected: true, at: NOW, lastStatus: 200 });
});

test('a host outside allowHosts is never called and the refusal is audited', async () => {
  const stateDir = setup([sub({ url: 'https://evil.example.test/x' })]);
  const { calls, impl } = fakeFetch([200]);
  const results = await createOutboundWebhooks(deps(stateDir, impl)).deliver(frame(1, { kind: 'state', state: 'idle' }));
  expect(calls).toEqual([]);
  expect(results).toEqual([{ subscription: 'ci', ok: false, tries: 0 }]);
  const audit = JSON.parse(readFileSync(join(stateDir, 'control-audit.jsonl'), 'utf8').trim()) as Record<string, unknown>;
  expect(audit.result).toBe('denied');
  expect(audit.reason).toBe('host not in allowHosts');
});

// #38610 REVIEW must ① — a signed body never crosses a remote wire in the clear: an allow-listed
// host over plain http is refused and audited, and the receiver is never called.
test('an allow-listed host over plain http is never called - remote delivery is HTTPS only', async () => {
  const stateDir = setup([sub({ url: 'http://hooks.example.test/els' })]);
  const { calls, impl } = fakeFetch([200]);
  const results = await createOutboundWebhooks(deps(stateDir, impl)).deliver(frame(1, { kind: 'state', state: 'idle' }));
  expect(calls).toEqual([]);
  expect(results).toEqual([{ subscription: 'ci', ok: false, tries: 0 }]);
  const refusal = JSON.parse(readFileSync(join(stateDir, 'control-audit.jsonl'), 'utf8').trim()) as Record<string, unknown>;
  expect(refusal.result).toBe('denied');
  expect(refusal.reason).toBe('remote delivery is HTTPS only');
});

test('a target that keeps failing is retried with backoff, dead-lettered, and marked disconnected but stays subscribed', async () => {
  const stateDir = setup([sub()]);
  const { calls, impl } = fakeFetch([500, 'throw', 503, 502]);
  const sleeps: number[] = [];
  const results = await createOutboundWebhooks(deps(stateDir, impl, sleeps)).deliver(frame(1, { kind: 'notice', level: 'warn', text: 'slow' }));
  expect(results).toEqual([{ subscription: 'ci', ok: false, tries: 4, status: 502 }]);
  expect(calls.length).toBe(4);
  expect(sleeps).toEqual([1_000, 4_000, 16_000]);
  const dead = readFileSync(join(stateDir, 'webhook-deadletter.jsonl'), 'utf8').trim().split('\n');
  expect(dead.length).toBe(1);
  const row = JSON.parse(dead[0]!) as { subscription: string; tries: number; status: number };
  expect([row.subscription, row.tries, row.status]).toEqual(['ci', 4, 502]);
  expect(dead[0]!.includes(SECRET)).toBe(false);
  expect(subscriptionStatus(stateDir).ci!.connected).toBe(false);
  expect(loadSubscriptions(stateDir).subscriptions.map((s) => s.id)).toEqual(['ci']);
});

test('a retry that succeeds is not dead-lettered', async () => {
  const stateDir = setup([sub()]);
  const { calls, impl } = fakeFetch([500, 204]);
  const results = await createOutboundWebhooks(deps(stateDir, impl)).deliver(frame(1, { kind: 'state', state: 'done' }));
  expect(results).toEqual([{ subscription: 'ci', ok: true, tries: 2, status: 204 }]);
  expect(calls.length).toBe(2);
  expect(existsSync(join(stateDir, 'webhook-deadletter.jsonl'))).toBe(false);
});

test('seq at or below the last seen for a pane is dropped; other panes are independent', async () => {
  const stateDir = setup([sub()]);
  const { calls, impl } = fakeFetch([200]);
  const out = createOutboundWebhooks(deps(stateDir, impl));
  await out.deliver(frame(3, { kind: 'state', state: 'working' }));
  await out.deliver(frame(3, { kind: 'state', state: 'idle' }));
  await out.deliver(frame(2, { kind: 'state', state: 'idle' }));
  await out.deliver(frame(1, { kind: 'state', state: 'idle' }, 'p2'));
  expect(calls.length).toBe(2);
});

test('event and pane filters pick subscriptions; a malformed frame is ignored', async () => {
  const stateDir = setup([sub({ id: 'only-notice', events: ['notice'] }), sub({ id: 'only-p9', panes: ['p9'] })]);
  const { calls, impl } = fakeFetch([200]);
  const out = createOutboundWebhooks(deps(stateDir, impl));
  expect((await out.deliver(frame(1, { kind: 'state', state: 'idle' }))).map((r) => r.subscription)).toEqual([]);
  expect((await out.deliver(frame(2, { kind: 'notice', level: 'info', text: 'hi' }))).map((r) => r.subscription)).toEqual(['only-notice']);
  expect((await out.deliver(frame(1, { kind: 'state', state: 'idle' }, 'p9'))).map((r) => r.subscription)).toEqual(['only-p9']);
  expect(await out.deliver({ op: 'event', v: 2, pane: 'p1', seq: 9, at: NOW, event: { kind: 'state' } } as unknown as EventFrame)).toEqual([]);
  expect(calls.length).toBe(2);
});

test('subscription changes are audited without the secret; a broken file subscribes nobody', () => {
  const stateDir = setup([]);
  putSubscription(stateDir, sub({ id: 'new-one' }), 'OP');
  expect(loadSubscriptions(stateDir).subscriptions.map((s) => s.id)).toEqual(['new-one']);
  expect(loadSubscriptions(stateDir).allowHosts).toEqual(['hooks.example.test']);
  expect(removeSubscription(stateDir, 'new-one', 'OP')).toBe(true);
  expect(removeSubscription(stateDir, 'new-one', 'OP')).toBe(false);
  const audit = readFileSync(join(stateDir, 'control-audit.jsonl'), 'utf8');
  expect(audit.trim().split('\n').map((l) => (JSON.parse(l) as { action: string }).action)).toEqual(['subscribe', 'unsubscribe']);
  expect(audit.includes(SECRET)).toBe(false);
  expect(() => putSubscription(stateDir, sub({ events: ['everything' as never] }), 'OP')).toThrow('not a subscription');
  writeFileSync(join(stateDir, 'subscriptions.json'), '{ nope');
  expect(loadSubscriptions(stateDir)).toEqual({ allowHosts: [], subscriptions: [] });
});

test('real HTTP: a loopback receiver gets the signed body', async () => {
  const received: { sig: string; ts: string; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString('utf8'); });
    req.on('end', () => { received.push({ sig: String(req.headers['x-els-signature']), ts: String(req.headers['x-els-timestamp']), body }); res.writeHead(200); res.end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const stateDir = setup([sub({ url: `http://127.0.0.1:${port}/hook` })], ['127.0.0.1']);
    const results = await createOutboundWebhooks({ stateDir, sleep: async () => {} }).deliver(frame(1, { kind: 'state', state: 'blocked' }));
    expect(results.map((r) => r.ok)).toEqual([true]);
    expect(received.length).toBe(1);
    const got = received[0]!;
    expect(got.sig).toBe(`sha256=${createHmac('sha256', SECRET).update(`${got.ts}.${got.body}`).digest('hex')}`);
  } finally {
    server.close();
  }
});

test('judgment: put on a broken subscriptions.json is refused - the original is preserved and the refusal audited', () => {
  const stateDir = setup([]);
  const broken = '{ "allowHosts": ["hooks.example.test"], "subscriptions": [{ "id": "ol';
  writeFileSync(join(stateDir, 'subscriptions.json'), broken);
  expect(() => putSubscription(stateDir, sub({ id: 'ci' }), 'OP')).toThrow('subscriptions.json is broken');
  expect(readFileSync(join(stateDir, 'subscriptions.json'), 'utf8')).toBe(broken);
  const refusal = JSON.parse(readFileSync(join(stateDir, 'control-audit.jsonl'), 'utf8').trim()) as Record<string, unknown>;
  expect(refusal.result).toBe('refused');
  expect(refusal.reason).toBe('subscriptions.json is broken');
  expect(refusal.subscription).toBe('ci');
  rmSync(join(stateDir, 'subscriptions.json'));
  putSubscription(stateDir, sub({ id: 'fresh' }), 'OP');
  expect(loadSubscriptions(stateDir).subscriptions.map((s) => s.id)).toEqual(['fresh']);
});

// #38610 REVIEW must ② — NUMGUARD: bad numbers are refused before the pane cursor moves, so an
// Infinity seq can never wedge the pane's later deliveries.
test('NUMGUARD: NaN/Infinity/negative/fractional seq and a bad at are refused, audited, and never wedge the pane', async () => {
  const stateDir = setup([sub()]);
  const { calls, impl } = fakeFetch([200]);
  const out = createOutboundWebhooks(deps(stateDir, impl));
  const ev: EventFrame['event'] = { kind: 'state', state: 'idle' };
  expect((await out.deliver(frame(Number.NaN, ev))).length).toBe(0);
  expect((await out.deliver(frame(Number.POSITIVE_INFINITY, ev))).length).toBe(0);
  expect((await out.deliver(frame(-1, ev))).length).toBe(0);
  expect((await out.deliver(frame(1.5, ev))).length).toBe(0);
  expect((await out.deliver({ ...frame(1, ev), at: Number.NaN })).length).toBe(0);
  expect(calls.length).toBe(0);
  // the pane cursor never moved: the next valid frame still leaves the host
  const ok = await out.deliver(frame(1, ev));
  expect(ok.map((r) => r.ok)).toEqual([true]);
  expect(calls.length).toBe(1);
  const refusals = readFileSync(join(stateDir, 'control-audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { result: string; reason: string });
  expect(refusals.map((r) => r.result)).toEqual(['refused', 'refused', 'refused', 'refused', 'refused']);
  expect(refusals.every((r) => r.reason.startsWith('bad seq') || r.reason.startsWith('bad at'))).toBe(true);
});

// #38610 REVIEW must ③ — the leaving body is an allowlist: tokens and nested screen text reach
// neither a subscription nor the dead letter.
test('allowlist: token and nested screen text never reach a subscription or the dead letter', async () => {
  const stateDir = setup([sub()]);
  const { calls, impl } = fakeFetch([500, 500, 500, 500]);
  const ev: EventFrame['event'] = { kind: 'child', action: 'end', id: 'c1', ok: true, token: 'LEAK-TOKEN-xyz', screen: { text: 'SCREEN-TEXT-xyz' }, line: 'SCREEN-TEXT-xyz' };
  const results = await createOutboundWebhooks(deps(stateDir, impl)).deliver(frame(1, ev));
  expect(results.map((r) => r.ok)).toEqual([false]);
  const body = JSON.parse(calls[0]!.body) as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(['at', 'data', 'event', 'pane', 'seq', 'subscription', 'v']);
  expect(body.data).toEqual({ ok: true, id: 'c1' });
  expect(calls[0]!.body.includes('LEAK-TOKEN')).toBe(false);
  expect(calls[0]!.body.includes('SCREEN-TEXT')).toBe(false);
  const dead = readFileSync(join(stateDir, 'webhook-deadletter.jsonl'), 'utf8');
  expect(dead.includes('LEAK-TOKEN')).toBe(false);
  expect(dead.includes('SCREEN-TEXT')).toBe(false);
});

// #38610 REVIEW must ④ — a subscriptions.json that parses as JSON but has a schema-invalid row
// refuses a put: the original is preserved (loadSubscriptions would drop the row on save — a loss).
test('judgment: put on subscriptions.json with a malformed row is refused - the original is preserved and the refusal audited', () => {
  const stateDir = setup([sub({ id: 'ok-one' })]);
  const withBadRow = JSON.stringify({ allowHosts: ['hooks.example.test'], subscriptions: [sub({ id: 'ok-one' }), { id: 'bad', url: 123, secretRef: 'out.secret', events: ['state'] }] });
  writeFileSync(join(stateDir, 'subscriptions.json'), withBadRow);
  expect(() => putSubscription(stateDir, sub({ id: 'fresh' }), 'OP')).toThrow('put refused');
  expect(readFileSync(join(stateDir, 'subscriptions.json'), 'utf8')).toBe(withBadRow);
  const refusal = JSON.parse(readFileSync(join(stateDir, 'control-audit.jsonl'), 'utf8').trim().split('\n').at(-1)!) as Record<string, unknown>;
  expect(refusal.result).toBe('refused');
  expect(String(refusal.reason)).toContain('malformed subscription');
});

// #38610 REVIEW must ② — an omitted field is corruption, not an empty list: a put on a file missing
// allowHosts or subscriptions refuses, keeps the original byte-for-byte, and audits the refusal.
test('put on a subscriptions.json missing allowHosts or subscriptions is refused - the original is preserved', () => {
  const stateDir = setup([]);
  const noAllowHosts = JSON.stringify({ subscriptions: [sub()] });
  writeFileSync(join(stateDir, 'subscriptions.json'), noAllowHosts);
  expect(() => putSubscription(stateDir, sub({ id: 'new-one' }), 'OP')).toThrow('missing allowHosts');
  expect(readFileSync(join(stateDir, 'subscriptions.json'), 'utf8')).toBe(noAllowHosts);
  const noSubscriptions = JSON.stringify({ allowHosts: ['hooks.example.test'] });
  writeFileSync(join(stateDir, 'subscriptions.json'), noSubscriptions);
  expect(() => putSubscription(stateDir, sub({ id: 'new-one' }), 'OP')).toThrow('missing subscriptions');
  expect(readFileSync(join(stateDir, 'subscriptions.json'), 'utf8')).toBe(noSubscriptions);
  const refusals = readFileSync(join(stateDir, 'control-audit.jsonl'), 'utf8').trim().split('\n')
    .map((l) => JSON.parse(l) as { result: string; reason: string; subscription: string });
  expect(refusals.map((r) => r.result)).toEqual(['refused', 'refused']);
  expect(refusals.map((r) => r.reason)).toEqual(['subscriptions.json is missing allowHosts', 'subscriptions.json is missing subscriptions']);
  expect(refusals.every((r) => r.subscription === 'new-one')).toBe(true);
});

// #38610 REVIEW must ③ — loadSubscriptions drops a malformed row silently; a remove on such a file
// would re-save the filtered list and delete that row for good. The remove refuses, the original
// stays byte-for-byte, and the refusal is audited.
test('remove on a subscriptions.json with a malformed row is refused - the original is preserved and the row survives', () => {
  const stateDir = setup([]);
  const withBadRow = JSON.stringify({ allowHosts: ['hooks.example.test'], subscriptions: [sub({ id: 'target' }), { id: 'bad', url: 123, secretRef: 'out.secret', events: ['state'] }] });
  writeFileSync(join(stateDir, 'subscriptions.json'), withBadRow);
  expect(() => removeSubscription(stateDir, 'target', 'OP')).toThrow('remove refused');
  expect(readFileSync(join(stateDir, 'subscriptions.json'), 'utf8')).toBe(withBadRow);
  const refusal = JSON.parse(readFileSync(join(stateDir, 'control-audit.jsonl'), 'utf8').trim()) as Record<string, unknown>;
  expect(refusal.result).toBe('refused');
  expect(String(refusal.reason)).toContain('malformed subscription');
  expect(refusal.subscription).toBe('target');
  const broken = '{ "allowHosts": ["hooks.example.test"], "subscriptions": [{ "id": "ol';
  writeFileSync(join(stateDir, 'subscriptions.json'), broken);
  expect(() => removeSubscription(stateDir, 'ci', 'OP')).toThrow('subscriptions.json is broken');
  expect(readFileSync(join(stateDir, 'subscriptions.json'), 'utf8')).toBe(broken);
});

// #38610 REVIEW must ① — e2e: a child end on the real server boot path reaches a subscribed webhook.
const ask = (socketPath: string, request: object): Promise<{ exitCode: number; message: string }> => new Promise((resolve, reject) => {
  const socket = createConnection(socketPath);
  socket.on('error', reject);
  socket.on('connect', () => {
    // main's door (JUD #39053): a mutating request carries the owner pane credential from this process's env.
    const token = process.env.ELANOUS_ELS_OWNER_TOKEN;
    if (token) socket.write(`${JSON.stringify({ op: 'auth', token })}\n`);
    socket.write(`${JSON.stringify(request)}\n`);
  });
  socket.on('data', (chunk: Buffer) => {
    socket.destroy();
    try { resolve(JSON.parse(chunk.toString('utf8').split('\n')[0]!) as { exitCode: number; message: string }); }
    catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
  });
});
/** The owner's one explicit `seat-set OP` registration per server (JUD #39057 ⓒ1③), as server.test.ts does it. */
const registerOwnerSeat = (socketPath: string): Promise<void> => new Promise((resolve, reject) => {
  const token = process.env.ELANOUS_ELS_OWNER_TOKEN;
  if (!token) { resolve(); return; }
  const socket = createConnection(socketPath);
  let registered = false;
  socket.on('connect', () => { socket.write(`${JSON.stringify({ op: 'auth', token })}\n`); socket.write(`${JSON.stringify({ op: 'seat-set', seat: 'OP' })}\n`); });
  socket.on('data', (chunk: Buffer) => { if (chunk.toString('utf8').includes('OP registered')) registered = true; });
  socket.on('close', () => { registered ? resolve() : reject(new Error('seat-set registration failed')); });
  socket.on('error', reject);
});
test('e2e: a child end on the real server boot path reaches a subscribed webhook receiver', async () => {
  const received: string[] = [];
  const hooks = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString('utf8'); });
    req.on('end', () => { received.push(body); res.writeHead(200); res.end(); });
  });
  await new Promise<void>((resolve) => hooks.listen(0, '127.0.0.1', resolve));
  try {
    const port = (hooks.address() as { port: number }).port;
    const root = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-hook-e2e-'));
    dirs.push(root);
    mkdirSync(join(root, 'els'), { recursive: true });
    writeFileSync(join(root, 'els', 'out.secret'), `${SECRET}\n`);
    writeFileSync(join(root, 'els', 'subscriptions.json'), JSON.stringify({ allowHosts: ['127.0.0.1'], subscriptions: [{ id: 'e2e', url: `http://127.0.0.1:${port}/hook`, events: ['child-end'], secretRef: 'out.secret' }] }));
    const started = await startElsServer({ stateRoot: root, spawn: () => { throw new Error('no PTY in this test'); } });
    if ('exitCode' in started) throw new Error(started.message);
    try {
      await registerOwnerSeat(elsSocketPath(root));
      expect((await ask(elsSocketPath(root), { op: 'child', action: 'start', id: 'k1', ws: 'w1', source: 'subagent', label: 'e2e' })).exitCode).toBe(0);
      expect((await ask(elsSocketPath(root), { op: 'child', action: 'end', id: 'k1', ok: true, summary: 'done' })).exitCode).toBe(0);
      // non-blocking: the answers above already came back without waiting for any webhook IO
      const until = Date.now() + 5_000;
      while (received.length === 0 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 25));
      expect(received.length).toBe(1);
      const body = JSON.parse(received[0]!) as Record<string, unknown>;
      expect([body.event, body.pane, body.subscription]).toEqual(['child-end', 'child:k1', 'e2e']);
    } finally { await started.close(); }
  } finally { await new Promise<void>((resolve) => hooks.close(() => resolve())); }
});

// #39129 review finding 1 - the allowlist is a hostname string; the RESOLVED address must be public too.
const PRIVATE_ADDRESSES = ['127.0.0.1', '10.0.0.5', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fc00::1', '::ffff:10.0.0.1'];
for (const address of PRIVATE_ADDRESSES) {
  test(`resolved-IP: an allow-listed https host resolving to ${address} is never called and the refusal is audited`, async () => {
    const stateDir = setup([sub()]);
    const { calls, impl } = fakeFetch([200]);
    const results = await createOutboundWebhooks({ ...deps(stateDir, impl), resolve: async () => [address] }).deliver(frame(1, { kind: 'state', state: 'idle' }));
    expect(calls).toEqual([]);
    expect(results).toEqual([{ subscription: 'ci', ok: false, tries: 0 }]);
    const refusal = JSON.parse(readFileSync(join(stateDir, 'control-audit.jsonl'), 'utf8').trim()) as Record<string, unknown>;
    expect([refusal.result, refusal.reason]).toEqual(['denied', 'host resolves to a non-public address']);
  });
}
test('resolved-IP: one private address among public ones denies, and an unresolvable host is denied (fail closed)', async () => {
  const stateDir = setup([sub()]);
  const { calls, impl } = fakeFetch([200]);
  const mixed = await createOutboundWebhooks({ ...deps(stateDir, impl), resolve: async () => ['93.184.216.34', '10.0.0.1'] }).deliver(frame(1, { kind: 'state', state: 'idle' }));
  const gone = await createOutboundWebhooks({ ...deps(stateDir, impl), resolve: async () => { throw new Error('ENOTFOUND'); } }).deliver(frame(1, { kind: 'state', state: 'idle' }));
  expect(calls).toEqual([]);
  expect([mixed[0]!.ok, gone[0]!.ok]).toEqual([false, false]);
  const reasons = readFileSync(join(stateDir, 'control-audit.jsonl'), 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { reason: string }).reason);
  expect(reasons).toEqual(['host resolves to a non-public address', 'host did not resolve']);
});
test('resolved-IP: a literal private IP https host is denied without consulting DNS; a public resolution is delivered', async () => {
  const stateDir = setup([sub({ url: 'https://10.0.0.5/x' })], ['10.0.0.5']);
  const { calls, impl } = fakeFetch([200]);
  let asked = 0;
  const out = createOutboundWebhooks({ ...deps(stateDir, impl), resolve: async () => { asked += 1; return ['93.184.216.34']; } });
  expect((await out.deliver(frame(1, { kind: 'state', state: 'idle' })))[0]!.ok).toBe(false);
  expect([calls.length, asked]).toEqual([0, 0]);
  const okDir = setup([sub()]);
  expect((await createOutboundWebhooks(deps(okDir, impl)).deliver(frame(1, { kind: 'state', state: 'idle' })))[0]!.ok).toBe(true);
});
test('resolved-IP: the loopback http test path never touches DNS', async () => {
  const stateDir = setup([sub({ url: 'http://127.0.0.1:9/hook' })], ['127.0.0.1']);
  const { calls, impl } = fakeFetch([200]);
  const out = createOutboundWebhooks({ ...deps(stateDir, impl), resolve: async () => { throw new Error('DNS must not be asked'); } });
  expect((await out.deliver(frame(1, { kind: 'state', state: 'idle' })))[0]!.ok).toBe(true);
  expect(calls.length).toBe(1);
});

// #39129 review finding 3 - a per-subscription in-flight cap: an event flood cannot grow without bound.
test('in-flight cap: a flood against a hanging receiver sends at most maxInFlight, drops and audits the rest, and recovers', async () => {
  const stateDir = setup([sub()]);
  const releases: (() => void)[] = [];
  let sent = 0;
  const impl = (async () => { sent += 1; await new Promise<void>((resolve) => releases.push(resolve)); return new Response('', { status: 200 }); }) as unknown as typeof fetch;
  const out = createOutboundWebhooks({ ...deps(stateDir, impl), maxInFlight: 2 });
  const pending = [1, 2, 3, 4, 5].map((seq) => out.deliver(frame(seq, { kind: 'state', state: 'idle' })));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(sent).toBe(2);
  const dropped = (await Promise.all(pending.slice(2))).map((r) => r[0]);
  expect(dropped).toEqual([{ subscription: 'ci', ok: false, tries: 0 }, { subscription: 'ci', ok: false, tries: 0 }, { subscription: 'ci', ok: false, tries: 0 }]);
  const audited = readFileSync(join(stateDir, 'control-audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { result: string; reason: string });
  expect(audited.map((a) => [a.result, a.reason])).toEqual([['dropped', 'in-flight cap reached'], ['dropped', 'in-flight cap reached'], ['dropped', 'in-flight cap reached']]);
  for (const release of releases.splice(0)) release();
  await Promise.all(pending.slice(0, 2));
  const again = out.deliver(frame(6, { kind: 'state', state: 'idle' }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(sent).toBe(3);
  for (const release of releases.splice(0)) release();
  expect((await again)[0]!.ok).toBe(true);
});
test('in-flight cap: the default cap is finite and per subscription', async () => {
  const stateDir = setup([sub({ id: 'a' }), sub({ id: 'b' })]);
  const perSub: Record<string, number> = {};
  const impl = (async (_url: string, init?: RequestInit) => { const id = (JSON.parse(String(init!.body)) as { subscription: string }).subscription; perSub[id] = (perSub[id] ?? 0) + 1; await new Promise(() => {}); }) as unknown as typeof fetch;
  const out = createOutboundWebhooks(deps(stateDir, impl));
  for (let seq = 1; seq <= 200; seq += 1) void out.deliver(frame(seq, { kind: 'state', state: 'idle' }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(perSub.a).toBeGreaterThan(0);
  expect(perSub.a).toBeLessThanOrEqual(16);
  expect(perSub.b).toBe(perSub.a!);
});

// #39129 review - cheap hardening.
function bodyProbe(status: number) {
  const state = { cancelled: false };
  const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(8)); }, cancel() { state.cancelled = true; } });
  return { state, response: () => new Response(body, { status }) };
}
for (const status of [204, 500, 404]) {
  test(`response body is cancelled, not left open, for status ${status}`, async () => {
    const stateDir = setup([sub()]);
    const probe = bodyProbe(status);
    const impl = (async () => probe.response()) as unknown as typeof fetch;
    await createOutboundWebhooks(deps(stateDir, impl)).deliver(frame(1, { kind: 'state', state: 'idle' }));
    expect(probe.state.cancelled).toBe(true);
  });
}
const RETRY_TABLE: readonly { statuses: readonly number[]; calls: number; ok: boolean }[] = [
  { statuses: [400], calls: 1, ok: false },
  { statuses: [404], calls: 1, ok: false },
  { statuses: [410], calls: 1, ok: false },
  { statuses: [408, 204], calls: 2, ok: true },
  { statuses: [429, 204], calls: 2, ok: true },
  { statuses: [500, 204], calls: 2, ok: true },
];
for (const row of RETRY_TABLE) {
  test(`retry: statuses ${row.statuses.join(',')} -> ${row.calls} call(s), ok=${row.ok}`, async () => {
    const stateDir = setup([sub()]);
    const { calls, impl } = fakeFetch(row.statuses);
    const sleeps: number[] = [];
    const results = await createOutboundWebhooks(deps(stateDir, impl, sleeps)).deliver(frame(1, { kind: 'state', state: 'idle' }));
    expect(calls.length).toBe(row.calls);
    expect(results[0]!.ok).toBe(row.ok);
    if (!row.ok) expect(readFileSync(join(stateDir, 'webhook-deadletter.jsonl'), 'utf8').trim().split('\n').length).toBe(1);
  });
}
test('a 302 is never followed: redirect is manual, the Location is not fetched, and the delivery fails', async () => {
  const stateDir = setup([sub()]);
  const seen: { url: string; redirect: RequestRedirect | undefined }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), redirect: init?.redirect });
    return new Response('', { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } });
  }) as unknown as typeof fetch;
  const results = await createOutboundWebhooks(deps(stateDir, impl)).deliver(frame(1, { kind: 'state', state: 'idle' }));
  expect(results[0]!.ok).toBe(false);
  expect(results[0]!.status).toBe(302);
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((s) => s.redirect === 'manual' && s.url === 'https://hooks.example.test/els')).toBe(true);
});
