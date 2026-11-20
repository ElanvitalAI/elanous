import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
// A Unix socket path holds at most 103 bytes (macOS): the land train's long TMPDIR puts the els server/holder socket
// under <state>/els/ over it, so a state dir under a long TMPDIR falls back to /tmp (each test removes its own dir).
const SOCKET_SAFE_TMP = tmpdir().length > 40 ? '/tmp' : tmpdir();
import { join } from 'node:path';
import { issueMcpPat } from '../mcp-gateway/pat-store.js';
import { MinuteIpLimiter } from '../mcp-gateway/gateway.js';
import { elsSocketPath, startElsServer } from './server.js';
import { requestEls } from './client.js';
import type { AllowRule, ControlExecuteInput, HitlAnswer } from './control.js';
import { routeElsHttpV1, startElsHttpV1, type HttpV1Deps } from './http-v1.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tmp = (): string => { const dir = mkdtempSync(join(SOCKET_SAFE_TMP, 'els-http-v1-')); dirs.push(dir); return dir; };

function setup(rules: readonly AllowRule[], hitl?: () => Promise<HitlAnswer>, paneIsShell?: (workspace: string, pane: string) => boolean) {
  const stateDir = tmp();
  const patRoot = tmp();
  writeFileSync(join(stateDir, 'control-allow.json'), JSON.stringify({ rules }));
  const { token } = issueMcpPat('ci-bot', {}, patRoot);
  const ran: ControlExecuteInput[] = [];
  const deps: HttpV1Deps = {
    stateDir,
    patRoot,
    execute: async (input) => { ran.push(input); return { exitCode: 0, message: 'delivered' }; },
    nonces: new Map(),
    ...(hitl ? { hitl: async () => hitl() } : {}),
    ...(paneIsShell ? { paneIsShell } : {}),
  };
  return { deps, token, ran, stateDir };
}

const auth = (token: string): string => `Bearer ${token}`;
const doBody = (text: string, extra: Record<string, unknown> = {}): string => JSON.stringify({ workspace: 'HQ', pane: 'p1', text, ...extra });

// Judgment table (ELS-EXTERNAL-SURFACES §3.2): request → status, executed?
// `paneIsShell` is the owner's ledger answer (#38453 REVIEW must ②): the request's own `shell` claim never decides.
const TABLE: readonly { name: string; method: string; url: string; authed: boolean; body?: string; rules: readonly AllowRule[]; hitl?: HitlAnswer; paneIsShell?: boolean; status: number; executed: boolean }[] = [
  { name: 'no PAT', method: 'POST', url: '/els/v1/do', authed: false, body: doBody('echo hi'), rules: [{ principal: '*', workspace: '*', pane: '*', actions: ['do'] }], status: 401, executed: false },
  { name: 'PAT, empty allow list', method: 'POST', url: '/els/v1/do', authed: true, body: doBody('echo hi'), rules: [], status: 403, executed: false },
  { name: 'PAT, allowed safe do', method: 'POST', url: '/els/v1/do', authed: true, body: doBody('echo hi'), rules: [{ principal: 'ci-bot', workspace: 'HQ', pane: '*', actions: ['do'] }], status: 200, executed: true },
  { name: 'PAT, allowed send alias', method: 'POST', url: '/els/v1/send', authed: true, body: doBody('echo hi'), rules: [{ principal: 'ci-bot', workspace: 'HQ', pane: '*', actions: ['do'] }], status: 200, executed: true },
  { name: 'dangerous shell do, nobody to ask', method: 'POST', url: '/els/v1/do', authed: true, body: doBody('rm -rf /tmp/x'), rules: [{ principal: 'ci-bot', workspace: '*', pane: '*', actions: ['do'] }], status: 409, executed: false },
  { name: 'dangerous shell do, person denies', method: 'POST', url: '/els/v1/do', authed: true, body: doBody('rm -rf /tmp/x'), rules: [{ principal: 'ci-bot', workspace: '*', pane: '*', actions: ['do'] }], hitl: 'deny', status: 409, executed: false },
  { name: 'dangerous shell do, person approves', method: 'POST', url: '/els/v1/do', authed: true, body: doBody('rm -rf /tmp/x'), rules: [{ principal: 'ci-bot', workspace: '*', pane: '*', actions: ['do'] }], hitl: 'approve', status: 200, executed: true },
  { name: 'agent pane is not danger-classified — the ledger vouches, not the request (#38453 must ②)', method: 'POST', url: '/els/v1/do', authed: true, body: doBody('rm -rf /tmp/x'), rules: [{ principal: 'ci-bot', workspace: '*', pane: '*', actions: ['do'] }], paneIsShell: false, status: 200, executed: true },
  { name: 'the request claims an agent pane, the ledger says shell → held (#38453 must ②)', method: 'POST', url: '/els/v1/do', authed: true, body: doBody('rm -rf /tmp/x', { shell: false }), rules: [{ principal: 'ci-bot', workspace: '*', pane: '*', actions: ['do'] }], paneIsShell: true, status: 409, executed: false },
  { name: 'an unresolvable pane counts as a shell — fail closed (#38453 must ②)', method: 'POST', url: '/els/v1/do', authed: true, body: doBody('rm -rf /tmp/x', { shell: false }), rules: [{ principal: 'ci-bot', workspace: '*', pane: '*', actions: ['do'] }], status: 409, executed: false },
  { name: 'read allowed', method: 'GET', url: '/els/v1/read?workspace=HQ&pane=p1', authed: true, rules: [{ principal: 'ci-bot', workspace: 'HQ', pane: 'p1', actions: ['read'] }], status: 200, executed: true },
  { name: 'read, rule only for do', method: 'GET', url: '/els/v1/read?workspace=HQ&pane=p1', authed: true, rules: [{ principal: 'ci-bot', workspace: 'HQ', pane: 'p1', actions: ['do'] }], status: 403, executed: false },
  { name: 'GET on do', method: 'GET', url: '/els/v1/do?workspace=HQ&pane=p1', authed: true, rules: [{ principal: '*', workspace: '*', pane: '*', actions: ['do'] }], status: 405, executed: false },
  { name: 'unknown path', method: 'GET', url: '/els/v1/nope', authed: true, rules: [], status: 404, executed: false },
  { name: 'ls is a status — allowed', method: 'GET', url: '/els/v1/ls?workspace=HQ&pane=p1', authed: true, rules: [{ principal: 'ci-bot', workspace: 'HQ', pane: 'p1', actions: ['status'] }], status: 200, executed: true },
  { name: 'new allowed', method: 'POST', url: '/els/v1/new', authed: true, body: doBody('echo hi'), rules: [{ principal: 'ci-bot', workspace: 'HQ', pane: '*', actions: ['new'] }], status: 200, executed: true },
  { name: 'new, rule only for do → 403', method: 'POST', url: '/els/v1/new', authed: true, body: doBody('echo hi'), rules: [{ principal: 'ci-bot', workspace: 'HQ', pane: '*', actions: ['do'] }], status: 403, executed: false },
  { name: 'missing pane', method: 'POST', url: '/els/v1/do', authed: true, body: JSON.stringify({ workspace: 'HQ', text: 'echo hi' }), rules: [{ principal: '*', workspace: '*', pane: '*', actions: ['do'] }], status: 400, executed: false },
  { name: 'body not JSON', method: 'POST', url: '/els/v1/do', authed: true, body: '{ nope', rules: [{ principal: '*', workspace: '*', pane: '*', actions: ['do'] }], status: 400, executed: false },
];

for (const row of TABLE) {
  test(`judgment: ${row.name} → ${row.status}${row.executed ? ' executed' : ' not executed'}`, async () => {
    const { deps, token, ran } = setup(row.rules, row.hitl ? async () => row.hitl! : undefined, row.paneIsShell !== undefined ? () => row.paneIsShell! : undefined);
    const res = await routeElsHttpV1(deps, { method: row.method, rawUrl: row.url, ...(row.body ? { body: row.body } : {}), ...(row.authed ? { authorization: auth(token) } : {}), source: '127.0.0.1' });
    expect(res.status).toBe(row.status);
    expect(ran.length).toBe(row.executed ? 1 : 0);
  });
}

test('a principal named in the body is ignored: the PAT name is the principal', async () => {
  const { deps, token, ran } = setup([{ principal: 'OP', workspace: '*', pane: '*', actions: ['do'] }]);
  const res = await routeElsHttpV1(deps, { method: 'POST', rawUrl: '/els/v1/do', body: doBody('echo hi', { principal: { id: 'OP', kind: 'cli', scopes: ['do'] } }), authorization: auth(token), source: '127.0.0.1' });
  expect(res.status).toBe(403);
  expect(ran).toEqual([]);
  const ok = setup([{ principal: 'ci-bot', workspace: '*', pane: '*', actions: ['do'] }]);
  await routeElsHttpV1(ok.deps, { method: 'POST', rawUrl: '/els/v1/do', body: doBody('echo hi'), authorization: auth(ok.token), source: '127.0.0.1' });
  expect(ok.ran[0]!.principal).toEqual({ id: 'ci-bot', kind: 'http-token' });
});

test('the token and the typed text never reach the response or the audit', async () => {
  const { deps, token, stateDir } = setup([{ principal: 'ci-bot', workspace: '*', pane: '*', actions: ['do'] }]);
  const secret = 'echo sk-live-SECRET-123';
  const res = await routeElsHttpV1(deps, { method: 'POST', rawUrl: '/els/v1/do', body: doBody(secret), authorization: auth(token), source: '127.0.0.1' });
  const audit = readFileSync(join(stateDir, 'control-audit.jsonl'), 'utf8');
  for (const text of [res.body, audit]) {
    expect(text.includes(token)).toBe(false);
    expect(text.includes('SECRET')).toBe(false);
  }
  expect(audit.trim().split('\n').map((line) => (JSON.parse(line) as { kind: string }).kind)).toEqual(['http-token', 'http-token']);
});

test('a wrong or malformed bearer is 401', async () => {
  const { deps, ran } = setup([{ principal: '*', workspace: '*', pane: '*', actions: ['do'] }]);
  for (const authorization of ['Bearer not-a-real-token', 'Basic abc', 'Bearer ']) {
    const res = await routeElsHttpV1(deps, { method: 'POST', rawUrl: '/els/v1/do', body: doBody('echo hi'), authorization, source: '127.0.0.1' });
    expect(res.status).toBe(401);
  }
  expect(ran).toEqual([]);
});

test('a shared limiter returns 429 after the per-minute limit, before the PAT is checked', async () => {
  const { deps, token } = setup([{ principal: 'ci-bot', workspace: '*', pane: '*', actions: ['status'] }]);
  const limited = { ...deps, limiter: new MinuteIpLimiter(2), now: () => 1_700_000_000_000 };
  const call = () => routeElsHttpV1(limited, { method: 'GET', rawUrl: '/els/v1/status?workspace=HQ&pane=p1', authorization: auth(token), source: '::ffff:10.0.0.5' });
  expect((await call()).status).toBe(200);
  expect((await call()).status).toBe(200);
  expect((await call()).status).toBe(429);
});

test('#38453 must ⑤: the router counts an unknown path and a wrong method before answering them', async () => {
  const { deps, token } = setup([]);
  const limited = { ...deps, limiter: new MinuteIpLimiter(2), now: () => 1_700_000_000_000 };
  const call = (rawUrl: string, method = 'GET') => routeElsHttpV1(limited, { method, rawUrl, ...(method === 'POST' ? { body: doBody('echo hi') } : {}), authorization: auth(token), source: '::ffff:10.0.0.9' });
  expect((await call('/els/v1/nope')).status).toBe(404);    // counted
  expect((await call('/els/v1/do')).status).toBe(405);      // counted
  expect((await call('/els/v1/nope')).status).toBe(429);    // the minute is spent
});

test('#38453 must ③: an executor that answers with the typed text cannot put it in the response', async () => {
  const { deps, token } = setup([{ principal: 'ci-bot', workspace: '*', pane: '*', actions: ['do'] }]);
  const echo = { ...deps, execute: async (input: ControlExecuteInput) => ({ exitCode: 0 as const, message: input.text ?? '' }) };
  const res = await routeElsHttpV1(echo, { method: 'POST', rawUrl: '/els/v1/do', body: doBody('echo sk-live-ECHO-42'), authorization: auth(token), source: '127.0.0.1' });
  expect(res.status).toBe(200);
  expect(res.body.includes('ECHO')).toBe(false);
  expect(JSON.parse(res.body)).toEqual({ ok: true, exitCode: 0, danger: 'safe' });
});

test('#38453 must ③: an executor that throws its message cannot put it in the response', async () => {
  const { deps, token } = setup([{ principal: 'ci-bot', workspace: '*', pane: '*', actions: ['do'] }]);
  const throwing = { ...deps, execute: async () => { throw new Error('exploded with sk-live-BOOM-7'); } };
  const res = await routeElsHttpV1(throwing, { method: 'POST', rawUrl: '/els/v1/do', body: doBody('echo hi'), authorization: auth(token), source: '127.0.0.1' });
  expect(res.status).toBe(500);
  expect(res.body.includes('BOOM')).toBe(false);
  expect(JSON.parse(res.body)).toEqual({ error: 'executor failed', code: 'executor-error' });
});

test('#38453 must ④: the executor sees the original path, not the collapsed action', async () => {
  const { deps, token, ran } = setup([{ principal: 'ci-bot', workspace: 'HQ', pane: '*', actions: ['do'] }]);
  await routeElsHttpV1(deps, { method: 'POST', rawUrl: '/els/v1/send', body: doBody('echo hi'), authorization: auth(token), source: '127.0.0.1' });
  await routeElsHttpV1(deps, { method: 'POST', rawUrl: '/els/v1/do', body: doBody('echo hi'), authorization: auth(token), source: '127.0.0.1' });
  expect(ran.map((input) => input.path)).toEqual(['/els/v1/send', '/els/v1/do']);
});

test('the listener refuses a public bind and serves the same router on loopback', async () => {
  const { deps, token, ran } = setup([{ principal: 'ci-bot', workspace: 'HQ', pane: '*', actions: ['do'] }]);
  await expect(startElsHttpV1(deps, { host: '0.0.0.0', port: 0 })).rejects.toThrow('is not a loopback or tailnet address');
  const server = await startElsHttpV1(deps, { host: '127.0.0.1', port: 0 });
  try {
    const port = (server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/els/v1/do`, { method: 'POST', headers: { authorization: auth(token), 'content-type': 'application/json' }, body: doBody('echo hi') });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, exitCode: 0, danger: 'safe' });
    expect(ran.length).toBe(1);
  } finally {
    server.close();
  }
});

test('#38453 must ⑤: the listener counts before the body — an oversized body still spends the minute', async () => {
  const { deps, token } = setup([{ principal: 'ci-bot', workspace: 'HQ', pane: '*', actions: ['do'] }]);
  const server = await startElsHttpV1({ ...deps, rateLimitPerMinute: 1, now: () => 1_700_000_000_000 }, { host: '127.0.0.1', port: 0 });
  try {
    const port = (server.address() as { port: number }).port;
    const big = await fetch(`http://127.0.0.1:${port}/els/v1/do`, { method: 'POST', headers: { authorization: auth(token) }, body: 'x'.repeat(65 * 1024 + 1) });
    expect(big.status).toBe(413);                          // counted before the body arrived
    const next = await fetch(`http://127.0.0.1:${port}/els/v1/do`, { method: 'POST', headers: { authorization: auth(token), 'content-type': 'application/json' }, body: doBody('echo hi') });
    expect(next.status).toBe(429);                         // the minute was spent by the oversized request
  } finally {
    server.close();
  }
});

test('#38453 must ③: an exception under the listener answers a fixed word, never the exception text', async () => {
  const { deps, token } = setup([{ principal: 'ci-bot', workspace: '*', pane: '*', actions: ['do'] }], async () => { throw new Error('hitl exploded with sk-live-HITL-9'); });
  const server = await startElsHttpV1(deps, { host: '127.0.0.1', port: 0 });
  try {
    const port = (server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/els/v1/do`, { method: 'POST', headers: { authorization: auth(token), 'content-type': 'application/json' }, body: doBody('rm -rf /tmp/x') });
    expect(res.status).toBe(500);
    const payload = JSON.stringify(await res.json());
    expect(payload).toBe(JSON.stringify({ error: 'internal error' }));
    expect(payload.includes('HITL-9')).toBe(false);
  } finally {
    server.close();
  }
});

test('#38453 must ①: the real server boot opens the v1 API wired to the core (production execute)', async () => {
  const stateRoot = tmp();
  const patRoot = tmp();
  const elsDir = join(stateRoot, 'els');
  mkdirSync(elsDir, { recursive: true });
  writeFileSync(join(elsDir, 'control-allow.json'), JSON.stringify({ rules: [
    { principal: 'ci-bot', workspace: 'w1', pane: '*', actions: ['do', 'status'] },
    // the wildcard rule lets a lying claim past the door; the executor's truth check is what refuses it (#38608 must ①)
    { principal: 'ci-bot', workspace: '*', pane: '*', actions: ['do'] },
  ] }));
  const { token } = issueMcpPat('ci-bot', {}, patRoot);
  const writes: string[] = [];
  const started = await startElsServer({
    stateRoot,
    spawn: (command) => ({ id: `pty-${command[0]}`, isAlive: () => true, write: (text: string) => { writes.push(text); }, renderScreen: async () => '', onExit: () => {}, kill: () => {} }),
    httpV1: { bind: { host: '127.0.0.1', port: 0 }, patRoot },
  });
  if ('exitCode' in started) throw new Error(started.message);
  try {
    const port = (started.httpV1!.address() as { port: number }).port;

    // status through the real core: an empty server still lists (exitCode 0), and only safe numbers come back.
    const ls = await fetch(`http://127.0.0.1:${port}/els/v1/ls?workspace=w1&pane=x`, { headers: { authorization: auth(token) } });
    expect(ls.status).toBe(200);
    expect(await ls.json()).toEqual({ ok: true, exitCode: 0, danger: 'safe' });

    // a real pane, then a safe do through the door: the line reaches the pane's PTY.
    const made = await requestEls(elsSocketPath(stateRoot), { op: 'new', ws: 'w1', cwd: '/tmp', command: ['zsh'] });
    expect(made.exitCode).toBe(0);
    const pane = (JSON.parse(made.message) as { pane: string }).pane;
    const done = await fetch(`http://127.0.0.1:${port}/els/v1/do`, { method: 'POST', headers: { authorization: auth(token), 'content-type': 'application/json' }, body: JSON.stringify({ workspace: 'w1', pane, text: 'echo hi' }) });
    expect(done.status).toBe(200);
    expect(writes.join('')).toContain('echo hi');

    // a dangerous do on the same shell pane: this server wires no approver, so it is held, not sent.
    const dangerous = await fetch(`http://127.0.0.1:${port}/els/v1/do`, { method: 'POST', headers: { authorization: auth(token), 'content-type': 'application/json' }, body: JSON.stringify({ workspace: 'w1', pane, text: 'rm -rf /tmp/x' }) });
    expect(dangerous.status).toBe(409);
    expect(writes.join('')).not.toContain('rm -rf');

    // #38608 REVIEW must ① — the workspace in the body is a claim; a wildcard rule lets the lie past the
    // door, and the executor still refuses: the pane lives in w1, whatever the caller said.
    const lie = await fetch(`http://127.0.0.1:${port}/els/v1/do`, { method: 'POST', headers: { authorization: auth(token), 'content-type': 'application/json' }, body: JSON.stringify({ workspace: 'not-w1', pane, text: 'echo lie' }) });
    expect(lie.status).toBe(400);
    expect(await lie.json()).toMatchObject({ exitCode: 2 });
    expect(writes.join('')).not.toContain('echo lie');

    // #38608 REVIEW must ② — /send is machine text through clean(): the \r cannot press Enter for the caller.
    const sent = await fetch(`http://127.0.0.1:${port}/els/v1/send`, { method: 'POST', headers: { authorization: auth(token), 'content-type': 'application/json' }, body: JSON.stringify({ workspace: 'w1', pane, text: 'echo via-send\r' }) });
    expect(sent.status).toBe(200);
    expect(writes.join('')).toContain('echo via-send');
    expect(writes.join('')).not.toContain('echo via-send\r');
  } finally {
    await started.close();
  }
});
