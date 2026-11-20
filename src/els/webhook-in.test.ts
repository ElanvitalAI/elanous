import { createHmac } from 'node:crypto';
import { afterEach, expect, test } from 'bun:test';
import { MinuteIpLimiter } from '../mcp-gateway/gateway.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AllowRule, ControlExecuteInput, HitlAnswer } from './control.js';
import { routeElsHttpV1, startElsHttpV1 } from './http-v1.js';
import { loadHook, renderTemplate, routeElsHook, signHook, type HookConfig, type HookDeps } from './webhook-in.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const NOW = 1_700_000_000_000;
const TS = String(NOW / 1000);
const SECRET = 'whsec-TEST-ONLY-9f2c';
const ALLOW_HOOK: AllowRule = { principal: 'hook:ci', workspace: 'HQ', pane: 'p1', actions: ['do'] };

function setup(opts: { rules?: readonly AllowRule[]; hook?: Partial<HookConfig>; hitl?: HitlAnswer } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'els-hook-'));
  dirs.push(stateDir);
  writeFileSync(join(stateDir, 'hook-ci.secret'), `${SECRET}\n`);
  writeFileSync(join(stateDir, 'control-allow.json'), JSON.stringify({ rules: opts.rules ?? [ALLOW_HOOK] }));
  const hook: HookConfig = { secretRef: 'hook-ci.secret', workspace: 'HQ', pane: 'p1', template: 'echo build {{status}} {{run}}', ...opts.hook };
  writeFileSync(join(stateDir, 'hooks.json'), JSON.stringify({ hooks: { ci: hook } }));
  const ran: ControlExecuteInput[] = [];
  const deps: HookDeps = {
    stateDir,
    execute: async (input) => { ran.push(input); return { exitCode: 0, message: 'delivered' }; },
    nonces: new Map(),
    now: () => NOW,
    ...(opts.hitl ? { hitl: async () => opts.hitl! } : {}),
  };
  return { deps, ran, stateDir };
}

const BODY = JSON.stringify({ status: 'green', run: 42 });
const signed = (overrides: Partial<{ body: string; timestamp: string; nonce: string; signature: string; source: string; name: string }> = {}) => {
  const body = overrides.body ?? BODY;
  const timestamp = overrides.timestamp ?? TS;
  const name = overrides.name ?? 'ci';
  return {
    name,
    body,
    timestamp,
    nonce: overrides.nonce ?? 'nonce-000001',
    signature: overrides.signature ?? signHook(SECRET, name, timestamp, overrides.nonce ?? 'nonce-000001', body),
    source: overrides.source ?? '127.0.0.1',
  };
};

const auditRows = (dir: string): Record<string, unknown>[] =>
  readFileSync(join(dir, 'control-audit.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);

// Judgment table (ELS-EXTERNAL-SURFACES §3.2 inbound webhook, §3.3 failures).
const TABLE: readonly { name: string; req: Parameters<typeof signed>[0]; status: number; executed: boolean; audit?: string }[] = [
  { name: 'valid signature, allowed hook', req: {}, status: 200, executed: true, audit: 'executed' },
  { name: 'signature mismatch', req: { signature: `sha256=${'0'.repeat(64)}` }, status: 401, executed: false, audit: 'unauthorized' },
  { name: 'body changed after signing', req: { signature: signHook(SECRET, 'ci', TS, 'nonce-000001', BODY), body: JSON.stringify({ status: 'red', run: 42 }) }, status: 401, executed: false, audit: 'unauthorized' },
  { name: 'timestamp 6 minutes old', req: { timestamp: String(NOW / 1000 - 360) }, status: 401, executed: false, audit: 'unauthorized' },
  { name: 'timestamp 6 minutes ahead', req: { timestamp: String(NOW / 1000 + 360) }, status: 401, executed: false, audit: 'unauthorized' },
  { name: 'timestamp 4 minutes old is inside the window', req: { timestamp: String(NOW / 1000 - 240) }, status: 200, executed: true, audit: 'executed' },
  { name: 'missing nonce', req: { nonce: '' }, status: 401, executed: false, audit: 'unauthorized' },
  { name: 'unknown hook', req: { name: 'nope' }, status: 404, executed: false },
  { name: 'hook name that is not a name', req: { name: '../x' }, status: 404, executed: false },
];

for (const row of TABLE) {
  test(`judgment: ${row.name} → ${row.status}${row.executed ? ' executed' : ' not executed'}`, async () => {
    const { deps, ran, stateDir } = setup();
    const res = await routeElsHook(deps, signed(row.req));
    expect(res.status).toBe(row.status);
    expect(ran.length).toBe(row.executed ? 1 : 0);
    if (row.audit) expect(auditRows(stateDir).map((r) => r.result)).toEqual(row.executed ? ['executing', row.audit] : [row.audit]);
  });
}

test('a reused nonce is refused the second time and nothing is typed twice', async () => {
  const { deps, ran } = setup();
  expect((await routeElsHook(deps, signed())).status).toBe(200);
  expect((await routeElsHook(deps, signed())).status).toBe(401);
  expect(ran.length).toBe(1);
});

// JUD-38609 must (c): the nonce belongs inside the signed material, so a
// signature captured under the old nonce-less convention (`${timestamp}.${body}`)
// must not verify under any fresh nonce. Before the fix each replay below
// returned 200 and executed the hook again.
test('a captured signature cannot be replayed under a fresh nonce', async () => {
  const { deps, ran } = setup();
  const captured = `sha256=${createHmac('sha256', SECRET).update(`${TS}.${BODY}`).digest('hex')}`;
  const attack = (nonce: string) => routeElsHook(deps, { name: 'ci', body: BODY, timestamp: TS, nonce, signature: captured, source: '127.0.0.1' });
  expect((await attack('nonce-aaaa1')).status).toBe(401);
  expect((await attack('nonce-bbbb2')).status).toBe(401);
  expect((await attack('nonce-cccc3')).status).toBe(401);
  expect(ran.length).toBe(0);
});

// JUD-38609 must ⓒ — the hook name is inside the signed material: `ci` and `ops` below share ONE
// secret file, and a signature made for `ci` must not open `ops` (another principal, another pane).
// Before the fix the same secret + timestamp + nonce + body verified on both hooks.
test('a signature for one hook does not open another hook that shares the secret file', async () => {
  const { deps, ran, stateDir } = setup({ rules: [ALLOW_HOOK, { principal: 'hook:ops', workspace: 'HQ', pane: 'p2', actions: ['do'] }] });
  writeFileSync(join(stateDir, 'hooks.json'), JSON.stringify({ hooks: {
    ci: { secretRef: 'hook-ci.secret', workspace: 'HQ', pane: 'p1', template: 'echo build {{status}} {{run}}' },
    ops: { secretRef: 'hook-ci.secret', workspace: 'HQ', pane: 'p2', template: 'echo ops {{status}} {{run}}' },
  } }));
  expect((await routeElsHook(deps, { ...signed(), name: 'ops' })).status).toBe(401);   // ci's signature replayed at ops
  expect(ran.length).toBe(0);
  expect((await routeElsHook(deps, signed({ name: 'ops', nonce: 'nonce-ops0001' }))).status).toBe(200);
  expect(ran.length).toBe(1);
  expect(ran[0]!.principal).toEqual({ id: 'hook:ops', kind: 'webhook' });
  expect(ran[0]!.target).toEqual({ workspace: 'HQ', pane: 'p2', shell: true });
});

// JUD-38609 must ⓑ — routeElsHttpV1 called directly (no socket) refuses a replayed nonce too: the
// nonce ledger is required on the deps, so the direct caller shares one for the life of its router.
test('routeElsHttpV1 without a socket still refuses the same signature and nonce a second time', async () => {
  const { deps, ran } = setup();
  const req = signed({ nonce: 'nonce-direct1' });
  const router = { stateDir: deps.stateDir, patRoot: deps.stateDir, execute: deps.execute, nonces: deps.nonces, now: () => NOW };
  const call = () => routeElsHttpV1(router, {
    method: 'POST', rawUrl: '/els/v1/hook/ci', body: req.body, source: '127.0.0.1',
    hookSignature: req.signature, hookTimestamp: req.timestamp, hookNonce: req.nonce,
  });
  expect((await call()).status).toBe(200);
  expect((await call()).status).toBe(401);
  expect(ran.length).toBe(1);
});

// JUD-38609 must ⓑ — a refusal after a valid signature leaves an audit line: an unparsable body,
// a JSON non-object and a template that renders empty all execute nothing and are all recorded.
test('a valid signature does not refuse silently: bad JSON, a non-object body and an empty render are audited', async () => {
  const one = setup();
  const first = await routeElsHook(one.deps, signed({ body: 'not json', nonce: 'nonce-a400001' }));
  const second = await routeElsHook(one.deps, signed({ body: '[1,2]', nonce: 'nonce-a400002' }));
  expect(first.status).toBe(400);
  expect(first.body).toBe(JSON.stringify({ error: 'body must be JSON' }));
  expect(second.status).toBe(400);
  expect(second.body).toBe(JSON.stringify({ error: 'body must be a JSON object' }));
  const two = setup({ hook: { template: '{{missing}}' } });
  const third = await routeElsHook(two.deps, signed({ nonce: 'nonce-a400003' }));
  expect(third.status).toBe(400);
  expect(third.body).toBe(JSON.stringify({ error: 'template rendered empty' }));
  expect(one.ran.length).toBe(0);
  expect(two.ran.length).toBe(0);
  expect(auditRows(one.stateDir).map((r) => r.result)).toEqual(['refused', 'refused']);
  expect(auditRows(one.stateDir).map((r) => r.reason)).toEqual(['body must be JSON', 'body must be a JSON object']);
  expect(auditRows(two.stateDir).map((r) => r.result)).toEqual(['refused']);
  expect(auditRows(two.stateDir).map((r) => r.reason)).toEqual(['template rendered empty']);
});

// JUD-38609 should — a hook name with a broken percent escape is an unknown hook, not a 500.
test('a hook name with broken percent-encoding is a 404, not an internal error', async () => {
  const { deps, ran } = setup();
  const res = await routeElsHttpV1(
    { stateDir: deps.stateDir, patRoot: deps.stateDir, execute: deps.execute, nonces: deps.nonces, now: () => NOW },
    { method: 'POST', rawUrl: '/els/v1/hook/%', source: '127.0.0.1' },
  );
  expect(res.status).toBe(404);
  expect(ran.length).toBe(0);
});

// JUD-38609 should (#38453 REVIEW must ⑤ on the hook route) — a wrong method is traffic too: the
// direct router answers 405 only after the source's minute is spent.
test('a wrong-method hook request still spends the minute before its 405', async () => {
  const { deps, ran } = setup();
  const router = { stateDir: deps.stateDir, patRoot: deps.stateDir, execute: deps.execute, nonces: deps.nonces, limiter: new MinuteIpLimiter(1), now: () => NOW };
  expect((await routeElsHttpV1(router, { method: 'GET', rawUrl: '/els/v1/hook/ci', source: '10.0.0.9' })).status).toBe(405);
  const req = signed({ nonce: 'nonce-lim0001' });
  const spent = await routeElsHttpV1(router, {
    method: 'POST', rawUrl: '/els/v1/hook/ci', body: req.body, source: '10.0.0.9',
    hookSignature: req.signature, hookTimestamp: req.timestamp, hookNonce: req.nonce,
  });
  expect(spent.status).toBe(429);
  expect(ran.length).toBe(0);
});

// JUD-38609 should (#38453 REVIEW must ③ on the hook path) — the executor's message never reaches
// the response: fixed words for refusals, numbers for successes.
test('the executor message never reaches the hook response - fixed words and numbers only', async () => {
  const base = setup();
  const chatty: HookDeps = { ...base.deps, execute: async () => ({ exitCode: 0, message: 'typed sk-live-HOOK-9' }) };
  const ok = await routeElsHook(chatty, signed({ nonce: 'nonce-fix0001' }));
  expect(ok.status).toBe(200);
  expect(JSON.parse(ok.body)).toEqual({ ok: true, exitCode: 0, danger: 'safe' });
  expect(ok.body.includes('delivered')).toBe(false);
  expect(ok.body.includes('HOOK-9')).toBe(false);
  const denied = setup({ rules: [] });
  const res = await routeElsHook(denied.deps, signed({ nonce: 'nonce-fix0002' }));
  expect(res.status).toBe(403);
  expect(JSON.parse(res.body)).toEqual({ error: 'forbidden', code: 'denied' });
  const held = setup({ hook: { template: 'rm -rf {{run}}' } });
  const h = await routeElsHook(held.deps, signed({ nonce: 'nonce-fix0003' }));
  expect(h.status).toBe(409);
  expect(JSON.parse(h.body)).toEqual({ error: 'held for a person', code: 'held' });
});

test('a verified hook still walks the door: not in the allow list is 403', async () => {
  const { deps, ran } = setup({ rules: [] });
  expect((await routeElsHook(deps, signed())).status).toBe(403);
  expect(ran).toEqual([]);
});

test('a verified hook that renders a dangerous shell line is held for a person', async () => {
  const held = setup({ hook: { template: 'rm -rf {{run}}' } });
  expect((await routeElsHook(held.deps, signed())).status).toBe(409);
  expect(held.ran).toEqual([]);
  const approved = setup({ hook: { template: 'rm -rf {{run}}' }, hitl: 'approve' });
  expect((await routeElsHook(approved.deps, signed())).status).toBe(200);
  expect(approved.ran.length).toBe(1);
});

test('the door gets the webhook principal, the hook target, and the rendered line', async () => {
  const { deps, ran } = setup();
  await routeElsHook(deps, signed());
  expect(ran[0]).toEqual({
    principal: { id: 'hook:ci', kind: 'webhook' },
    action: 'do',
    target: { workspace: 'HQ', pane: 'p1', shell: true },
    text: 'echo build green 42',
  });
});

test('a source outside the hook sources list is 401', async () => {
  const { deps, ran } = setup({ hook: { sources: ['100.64.0.9'] } });
  expect((await routeElsHook(deps, signed({ source: '127.0.0.1' }))).status).toBe(401);
  expect((await routeElsHook(deps, signed({ source: '100.64.0.9', nonce: 'nonce-000002' }))).status).toBe(200);
  expect(ran.length).toBe(1);
});

test('the secret and the signature never reach the response or the audit', async () => {
  const { deps, stateDir } = setup();
  const good = signed();
  const bad = signed({ signature: `sha256=${'a'.repeat(64)}`, nonce: 'nonce-000003' });
  const bodies = [(await routeElsHook(deps, good)).body, (await routeElsHook(deps, bad)).body];
  const audit = readFileSync(join(stateDir, 'control-audit.jsonl'), 'utf8');
  for (const text of [...bodies, audit]) {
    expect(text.includes(SECRET)).toBe(false);
    expect(text.includes(good.signature.slice(7))).toBe(false);
    expect(text.includes('a'.repeat(64))).toBe(false);
  }
});

test('loadHook rejects a broken file and a row that is not a hook; renderTemplate leaves only strings and numbers', () => {
  const { stateDir } = setup();
  expect(loadHook(stateDir, 'ci')?.pane).toBe('p1');
  expect(loadHook(stateDir, 'toString')).toBeUndefined();
  writeFileSync(join(stateDir, 'hooks.json'), JSON.stringify({ hooks: { ci: { secretRef: 's', workspace: 'HQ', pane: 'p1' } } }));
  expect(loadHook(stateDir, 'ci')).toBeUndefined();
  writeFileSync(join(stateDir, 'hooks.json'), '{ nope');
  expect(loadHook(stateDir, 'ci')).toBeUndefined();
  expect(renderTemplate('a {{x}} {{y}} {{z}} {{__proto__}}', { x: 'one', y: 2, z: { deep: 1 } })).toBe('a one 2  ');
});

test('the HTTP listener routes /els/v1/hook/<name> with the X-Els headers and no PAT', async () => {
  const { deps, ran } = setup();
  const server = await startElsHttpV1({ ...deps, patRoot: deps.stateDir }, { host: '127.0.0.1', port: 0 });
  try {
    const port = (server.address() as { port: number }).port;
    const req = signed();
    const post = () => fetch(`http://127.0.0.1:${port}/els/v1/hook/ci`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-els-signature': req.signature, 'x-els-timestamp': req.timestamp, 'x-els-nonce': req.nonce },
      body: req.body,
    });
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(401);
    expect(ran.length).toBe(1);
  } finally {
    server.close();
  }
});

// #38453 REVIEW must ② — failure-first: hooks.json `shell:false` must not skip the danger classifier.
test('hook config shell:false cannot disable the danger classifier - the server decides the pane kind', async () => {
  const fail = setup({ hook: { template: 'rm -rf {{run}}', shell: false } });
  const res = await routeElsHook(fail.deps, signed({ nonce: 'nonce-shl0001' }));
  expect(res.status).toBe(409);
  expect(fail.ran).toEqual([]);
  const viaLedger = setup({ hook: { template: 'rm -rf {{run}}', shell: false } });
  const seen: string[] = [];
  const ledger: HookDeps = { ...viaLedger.deps, paneIsShell: (w, p) => { seen.push(`${w}/${p}`); return true; } };
  expect((await routeElsHook(ledger, signed({ nonce: 'nonce-shl0002' }))).status).toBe(409);
  expect(seen).toEqual(['HQ/p1']);
  expect(viaLedger.ran).toEqual([]);
  // the ledger saying agent pane is the only way to skip it
  const agent: HookDeps = { ...viaLedger.deps, paneIsShell: () => false };
  expect((await routeElsHook(agent, signed({ nonce: 'nonce-shl0003' }))).status).toBe(200);
  expect(viaLedger.ran[0]!.target.shell).toBe(false);
});

// finding 8 — a newline smuggled in through a template value is held, not typed.
test('a newline in a template value is held for a person and nothing is typed', async () => {
  const { deps, ran } = setup();
  const body = JSON.stringify({ status: 'green\nrm -rf /', run: 1 });
  const res = await routeElsHook(deps, signed({ body, nonce: 'nonce-nl00001' }));
  expect(res.status).toBe(409);
  expect(JSON.parse(res.body)).toEqual({ error: 'held for a person', code: 'held' });
  expect(ran).toEqual([]);
});

// JUD #110140 — the door classifies the same cleaned text core.send types, on EVERY path (hook included):
// a \x01 smuggled in a template value must not make `git diff HEAD\x01--output=/tmp/pwn` read as one safe word.
test('a \\x01 in a template value cannot hide git --output from the classifier - held for a person', async () => {
  const { deps, ran } = setup({ hook: { template: 'git diff HEAD{{sep}}--output=/tmp/pwn' } });
  const body = JSON.stringify({ sep: '\u0001' });
  const res = await routeElsHook(deps, signed({ body, nonce: 'nonce-x010001' }));
  expect(res.status).toBe(409);
  expect(JSON.parse(res.body)).toEqual({ error: 'held for a person', code: 'held' });
  expect(ran).toEqual([]);
});
